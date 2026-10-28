/**
 * Lambda proxy F2 (Nhiệm vụ 1.6, 2.4, 2.5 – TV2). Thứ tự theo B.10:
 *   resolve website -> safe_fetch -> extract (tách câu {n}) -> hash -> getTM -> reserveChars
 *   -> translateSentences (B.9) -> putMachineTM -> rebuild -> settleUsage -> (worker) -> trả về.
 * Gọi qua Lambda function URL (AWS_IAM) phía sau CloudFront + OAC; đường dẫn luôn có dạng /{slug}/{lang}/{path}.
 *
 * Phản hồi (B.10):
 *  - dịch đủ:                     200, Cache-Control: public, max-age=0, s-maxage=<cacheSeconds>
 *  - hết 20 giây còn câu chưa dịch: 200, s-maxage=60  + X-TranslateMe-Partial: 1; gửi phần còn lại cho worker C13
 *  - tenant hết hạn mức ký tự:     200, s-maxage=300 + X-TranslateMe-Partial: quota (câu có trong TM vẫn dịch)
 *  - website không ACTIVE / tenant LOCKED: 302 về trang gốc; ngôn ngữ không bật: 404
 *  - lỗi không lường trước: 302 về trang gốc (Visitor không bao giờ thấy trang lỗi)
 * Lỗi TM, đếm lượng dùng, gọi worker không làm hỏng trang: chỉ ghi log.
 * Đọc thuật ngữ (getGlossaryState) lỗi -> xử lý như lỗi tra TM: bỏ qua TM (không tra, không ghi, không gọi worker),
 * dịch không kèm terminology và cache ngắn (s-maxage=60) để sớm dịch lại khi thuật ngữ đọc được.
 * Bản HUMAN lỗi thời theo thuật ngữ vẫn dùng, và được ghi cờ "Cần xem lại" (markHumanNeedsReview).
 *
 * Bản tạm (B.14): hash câu và countChars chờ thư viện 1.8; getGlossaryState chờ 2.8; db chờ batchGet/update của 2.2;
 * reserveChars/settleUsage chờ 2.7 (quotaStub). Chưa làm: ghi SEG (3.4).
 *
 * Biến môi trường: PUBLIC_BASE_URL, BASE_MODE (path|host), PROXY_SITES_JSON, TABLE_NAME (bật TM),
 * TRANSLATE_BUDGET_MS (20000), TRANSLATE_CONCURRENCY (4), WORKER_FUNCTION_NAME (bật hoàn tất nền),
 * WORKER_PAYLOAD_BUCKET (S3 cho danh sách câu lớn), WORKER_BUDGET_MS (240000), USE_FETCH_STUB=1.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { TranslateClient } from '@aws-sdk/client-translate';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { extract } from '../../libs/common/extract.js';
import { DEFAULT_PUBLIC_BASE_URL, rebuildDetailed, type BaseMode } from '../../libs/common/rebuild.js';
import { safe_fetch as realSafeFetch, type SafeFetchCompatResult } from '../../libs/common/safeFetch.js';
import { safe_fetch as stubSafeFetch } from '../../libs/common/safeFetch.stub.js';
import { createDynamoTmDb, createTM, type GlossaryState, type SentenceWithHash, type TmHit } from '../../libs/common/tm.js';
import {
  DEFAULT_TRANSLATE_CONCURRENCY,
  createTranslator,
  type TranslateClientLike,
  type TranslateRequest,
  type TranslateResult,
} from '../../libs/common/translator.js';
import type { Ctx, Sha256Hex } from '../../libs/common/types.js';
import {
  DEFAULT_CACHE_SECONDS,
  LANG_RE,
  SLUG_RE,
  cachedSiteResolver,
  parseSitesJson,
  staticSiteResolver,
  type SiteResolver,
} from './sites.js';
import { countCharsStub, getGlossaryStateStub, hashSentenceStub } from './stubs.js';
import { emptyReservation, isCharQuotaExceeded, quotaStub, type QuotaApi, type Reservation } from './usage.js';
import { DEFAULT_WORKER_BUDGET_MS, type WorkerDeps } from './worker.js';
import { buildWorkerEvents, type PayloadStore, type WorkerEvent } from './workerEvents.js';

export const DEFAULT_BUDGET_MS = 20_000;
export const PARTIAL_CACHE_SECONDS = 60;
export const QUOTA_PARTIAL_CACHE_SECONDS = 300;
export const DEFAULT_CONCURRENCY = DEFAULT_TRANSLATE_CONCURRENCY;
/** Giới hạn phản hồi đồng bộ của Lambda là 6 MB; chừa chỗ cho header. */
export const MAX_RESPONSE_BYTES = 5_500_000;

/** Phần của sự kiện Lambda function URL (payload 2.0) mà proxy dùng. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  requestContext?: { requestId?: string; http?: { method?: string } };
}

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface ProxyLogger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export interface ProxyDeps {
  resolveSite: SiteResolver;
  fetchPage: (url: string) => Promise<SafeFetchCompatResult>;
  translateClient: TranslateClientLike;
  /** B.9; mặc định createTranslator(translateClient) */
  translate?: (req: TranslateRequest) => Promise<TranslateResult>;
  baseMode?: BaseMode;
  publicBaseUrl?: string;
  budgetMs?: number;
  concurrency?: number;
  now?: () => number;
  logger?: ProxyLogger;
  /** Translation Memory (2.4). Không truyền = không dùng TM (như bản tuần 1). */
  tm?: ReturnType<typeof createTM>;
  getGlossaryState?: (ctx: Ctx) => Promise<GlossaryState>;
  hashSentence?: (text: string) => Sha256Hex;
  countChars?: (text: string) => number;
  /** B.11 (2.7). Mặc định quotaStub. */
  quota?: QuotaApi;
  /** Gửi sự kiện cho worker C13 (InvocationType = Event). Không truyền = không hoàn tất nền. */
  invokeWorker?: (event: WorkerEvent) => Promise<void>;
  workerStore?: PayloadStore;
}

export const defaultLogger: ProxyLogger = {
  info: (e) => console.log(JSON.stringify({ level: 'INFO', service: 'translate-proxy', ...e })),
  error: (e) => console.error(JSON.stringify({ level: 'ERROR', service: 'translate-proxy', ...e })),
};

// ============================================================================
// Đường dẫn
// ============================================================================

export interface ProxyPath {
  slug: string;
  lang: string;
  /** Phần đường dẫn sau /{slug}/{lang}/, giữ nguyên dạng mã hoá %, không có '/' đầu */
  rest: string;
}

/** /{slug}/{lang}/{path} -> các phần; null nếu sai định dạng. */
export function parseProxyPath(rawPath: string): ProxyPath | null {
  const m = /^\/([^/]+)\/([^/]+)(?:\/(.*))?$/s.exec(rawPath);
  if (!m) return null;
  const [, slug, lang, rest = ''] = m;
  if (!SLUG_RE.test(slug) || !LANG_RE.test(lang)) return null;
  return { slug, lang, rest: rest.replace(/^\/+/, '') };
}

/**
 * URL trang gốc = trang chủ + phần đường dẫn sau mã ngôn ngữ (+ query).
 * Trả null nếu kết quả thoát ra ngoài website (khác origin hoặc ra khỏi thư mục trang chủ).
 */
export function buildOriginUrl(homeUrl: string, rest: string, rawQuery = ''): string | null {
  const home = new URL(homeUrl);
  let u: URL;
  try {
    // Ghép chuỗi rồi phân tích (KHÔNG dùng new URL(rest, home): "//evil.com" sẽ thành host khác)
    u = new URL(`${home.origin}${home.pathname}${rest}`);
  } catch {
    return null;
  }
  if (u.origin !== home.origin || !(u.pathname === home.pathname.slice(0, -1) || u.pathname.startsWith(home.pathname))) {
    return null;
  }
  u.search = rawQuery ? `?${rawQuery}` : '';
  u.hash = '';
  return u.href;
}

// ============================================================================
// Phản hồi
// ============================================================================

const NO_STORE = 'no-store';

function textResponse(statusCode: number, message: string, cacheControl = NO_STORE): ProxyResponse {
  return {
    statusCode,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': cacheControl },
    body: message,
  };
}

function redirect(location: string, cacheControl = NO_STORE): ProxyResponse {
  return { statusCode: 302, headers: { location, 'cache-control': cacheControl }, body: '' };
}

/** Ánh xạ outcome của safe_fetch (khác OK) sang phản hồi – theo Quy ước mục 3.1 và Bảng 2.6. */
function fetchFailureResponse(res: SafeFetchCompatResult, originUrl: string): ProxyResponse {
  const o = res.outcome;
  switch (o.kind) {
    case 'NOT_HTML':
      return redirect(o.finalUrl, 'public, max-age=0, s-maxage=300');
    case 'BLOCKED':
      return textResponse(403, 'Forbidden');
    case 'TOO_LARGE':
      return redirect(originUrl); // Bảng 2.6: HTML gốc quá 3 MB -> chuyển Visitor về trang gốc
    case 'TIMEOUT':
      return textResponse(504, 'Gateway Timeout');
    case 'TOO_MANY_REDIRECTS':
    case 'NETWORK_ERROR':
    default:
      return textResponse(502, 'Bad Gateway');
  }
}

// ============================================================================
// Handler
// ============================================================================

export function createProxyHandler(deps: ProxyDeps) {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? defaultLogger;
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const translate = deps.translate ?? createTranslator(deps.translateClient, { now });
  const quota = deps.quota ?? quotaStub();
  const countChars = deps.countChars ?? countCharsStub;

  return async function proxyHandler(event: FunctionUrlEvent): Promise<ProxyResponse> {
    const started = now();
    const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
    const log: Record<string, unknown> = { requestId: event.requestContext?.requestId, method, path: event.rawPath };
    const finish = (res: ProxyResponse, extra: Record<string, unknown> = {}): ProxyResponse => {
      logger.info({ ...log, ...extra, status: res.statusCode, durationMs: now() - started });
      return method === 'HEAD' ? { ...res, body: '' } : res;
    };

    if (method !== 'GET' && method !== 'HEAD') {
      const res = textResponse(405, 'Method Not Allowed');
      res.headers.allow = 'GET, HEAD';
      return finish(res, { outcome: 'METHOD_NOT_ALLOWED' });
    }

    const parsed = parseProxyPath(event.rawPath ?? '');
    if (!parsed) return finish(textResponse(404, 'Not Found'), { outcome: 'BAD_PATH' });
    Object.assign(log, { slug: parsed.slug, lang: parsed.lang });

    // Bước 1: tra website
    const site = await deps.resolveSite(parsed.slug);
    if (!site) return finish(textResponse(404, 'Not Found', 'public, max-age=0, s-maxage=60'), { outcome: 'UNKNOWN_SLUG' });
    const originUrl = buildOriginUrl(site.homeUrl, parsed.rest, event.rawQueryString ?? '');
    if (!originUrl) return finish(textResponse(404, 'Not Found'), { outcome: 'OUTSIDE_SITE' });
    if (site.status !== 'ACTIVE' || site.tenantStatus !== 'ACTIVE') {
      return finish(redirect(originUrl, 'public, max-age=0, s-maxage=60'), { outcome: 'SITE_INACTIVE' });
    }
    if (!site.targetLangs.includes(parsed.lang)) {
      return finish(textResponse(404, 'Not Found', 'public, max-age=0, s-maxage=60'), { outcome: 'LANG_NOT_ENABLED' });
    }

    // Bước 1 (tiếp): tải trang gốc an toàn
    const fetched = await deps.fetchPage(originUrl);
    if (fetched.outcome.kind !== 'OK') {
      return finish(fetchFailureResponse(fetched, originUrl), { outcome: `FETCH_${fetched.outcome.kind}` });
    }
    if (fetched.status < 200 || fetched.status > 299) {
      return finish(redirect(originUrl), { outcome: 'ORIGIN_STATUS', originStatus: fetched.status });
    }
    const pageUrl = fetched.finalUrl || originUrl;
    if (new URL(pageUrl).origin !== new URL(site.homeUrl).origin) {
      // Origin chuyển hướng sang tên miền khác (đăng nhập, CDN…): không dịch trang của bên khác
      return finish(redirect(pageUrl), { outcome: 'REDIRECTED_OFF_SITE' });
    }

    try {
      // Bước 2: tách câu
      const ex = extract(fetched.body, { customExclusionSelectors: site.exclusionSelectors ?? [] });
      const ctx: Ctx = { tenantId: site.tenantId, via: 'SLUG', requestId: String(event.requestContext?.requestId ?? ''), slug: site.slug };
      const src = site.sourceLang;
      const tgt = parsed.lang;
      const extra: Record<string, unknown> = {};

      // Thuật ngữ lỗi thì xử lý như lỗi tra TM: không làm hỏng trang, bỏ qua TM, dịch không kèm terminology.
      // Không ghi TM và không gọi worker vì bản dịch không kèm terminology và không biết glossaryVersion đúng.
      let glossary: GlossaryState | undefined;
      if (deps.tm) {
        try {
          glossary = await (deps.getGlossaryState ?? getGlossaryStateStub)(ctx);
        } catch (err) {
          extra.glossaryError = err instanceof Error ? err.name : 'Unknown';
        }
      }

      // Bước 3–4: băm câu và tra TM
      const hashOf = deps.hashSentence ?? hashSentenceStub;
      const items: SentenceWithHash[] = ex.sentences.map((text, id) => ({ id, text, hash: hashOf(text) }));
      let hits = new Map<Sha256Hex, TmHit>();
      let reviewFlags: Sha256Hex[] = [];
      if (deps.tm && glossary) {
        try {
          ({ hits, reviewFlags } = await deps.tm.getTM(ctx, src, tgt, items, glossary));
        } catch (err) {
          extra.tmReadError = err instanceof Error ? err.name : 'Unknown';
        }
      }
      const translations: Array<string | undefined> = items.map((it) => hits.get(it.hash)?.tgt);
      const misses = items.filter((it) => translations[it.id] === undefined);
      const memoryChars = items.filter((it) => translations[it.id] !== undefined).reduce((n, it) => n + countChars(it.text), 0);

      // Đặt trước hạn mức cho câu trượt (B.11: không có câu trượt thì không gọi reserveChars)
      let reservation: Reservation = emptyReservation(now());
      let quotaExceeded = false;
      if (misses.length) {
        try {
          reservation = await quota.reserveChars(ctx, misses.reduce((n, it) => n + countChars(it.text), 0));
        } catch (err) {
          if (!isCharQuotaExceeded(err)) throw err;
          quotaExceeded = true;
        }
      }

      // Bước 5: dịch câu trượt trong ngân sách thời gian (B.9)
      let tr: TranslateResult = { translated: [], pending: [], failed: [], stats: { uniqueSentences: 0, calls: 0, charsSent: 0, splits: 0, plainFallbacks: 0 } };
      if (misses.length && !quotaExceeded) {
        try {
          tr = await translate({
            src,
            tgt,
            sentences: misses.map(({ id, text }) => ({ id, text })),
            terminologyName: glossary?.terminologyName ?? null,
            deadlineAt: started + budgetMs,
            concurrency: deps.concurrency ?? DEFAULT_CONCURRENCY,
          });
        } catch (err) {
          await quota.releaseChars(ctx, reservation).catch(() => {});
          throw err;
        }
        for (const t of tr.translated) translations[t.id] = t.tgt;
      }

      // Ghi bản MACHINE mới vào TM (không đè HUMAN) và ghi cờ "Cần xem lại" cho HUMAN lỗi thời, song song
      if (deps.tm && glossary) {
        const tm = deps.tm;
        const glossaryVersion = glossary.version;
        const writeMachine = async () => {
          if (!tr.translated.length) return;
          try {
            const rep = await tm.putMachineTM(
              ctx,
              src,
              tgt,
              tr.translated.map((t) => ({
                hash: items[t.id].hash,
                sourceText: items[t.id].text,
                tgt: t.tgt,
                glossaryVersion,
                needsReview: t.needsReview,
              })),
            );
            Object.assign(extra, { tmWritten: rep.written, tmSkippedHuman: rep.skippedHuman, tmWriteFailed: rep.failed.length });
          } catch (err) {
            extra.tmWriteError = err instanceof Error ? err.name : 'Unknown';
          }
        };
        // Bản HUMAN lỗi thời theo thuật ngữ: ghi cờ để vào hàng đợi duyệt (F5)
        const flagHuman = async () => {
          if (!reviewFlags.length) return;
          try {
            const rep = await tm.markHumanNeedsReview(
              ctx,
              src,
              tgt,
              reviewFlags.map((hash) => ({ hash, tgt: hits.get(hash)!.tgt })),
            );
            Object.assign(extra, { tmReviewFlagged: rep.marked, tmReviewFlagSkipped: rep.skipped, tmReviewFlagFailed: rep.failed.length });
          } catch (err) {
            extra.tmReviewFlagError = err instanceof Error ? err.name : 'Unknown';
          }
        };
        await Promise.all([writeMachine(), flagHuman()]);
      }

      // Bước 6: ráp HTML
      const rb = rebuildDetailed(ex.skeletonHtml, translations, ex.placeholders, {
        targetLang: parsed.lang,
        originalUrl: pageUrl,
        slug: site.slug,
        sourceLang: site.sourceLang,
        languages: site.targetLangs,
        siteHomeUrl: site.homeUrl,
        baseMode: deps.baseMode,
        publicBaseUrl: deps.publicBaseUrl,
      });

      // Bước 7: đếm lượng dùng (B.11). Lỗi đếm không làm hỏng trang.
      const machineChars = tr.translated.reduce((n, t) => n + countChars(items[t.id].text), 0);
      try {
        await quota.settleUsage(ctx, reservation, { kind: 'WEB', slug: site.slug }, {
          machineChars,
          memoryChars,
          sentTotal: items.length,
          sentFromTM: items.length - misses.length,
          requests: 1,
          pagesServed: 1,
        });
      } catch (err) {
        extra.usageError = err instanceof Error ? err.name : 'Unknown';
      }

      // Hết 20 giây (hoặc Translate lỗi tạm thời): gửi phần còn lại cho worker C13 dịch nốt vào TM
      const leftover = [...tr.pending, ...tr.failed.filter((f) => f.reason !== 'SENTENCE_TOO_LARGE').map((f) => f.id)]
        .sort((x, y) => x - y)
        .map((id) => items[id]);
      let workerEvents = 0;
      if (leftover.length && deps.invokeWorker && deps.tm && glossary) {
        try {
          const events = await buildWorkerEvents(
            {
              type: 'FINISH_PAGE',
              tenantId: site.tenantId,
              slug: site.slug,
              src,
              tgt,
              path: parsed.rest,
              glossaryVersion: glossary.version,
              terminologyName: glossary.terminologyName,
              requestId: ctx.requestId,
            },
            leftover,
            { store: deps.workerStore },
          );
          for (const e of events) {
            await deps.invokeWorker(e);
            workerEvents++;
          }
        } catch (err) {
          extra.workerError = err instanceof Error ? err.name : 'Unknown';
        }
      }

      if (Buffer.byteLength(rb.html, 'utf8') > MAX_RESPONSE_BYTES) {
        return finish(redirect(originUrl), { outcome: 'RESPONSE_TOO_LARGE' });
      }

      // Bước 8: trả về CloudFront
      const partial = quotaExceeded ? 'quota' : rb.stats.keptSource > 0 ? '1' : null;
      // Dịch không kèm thuật ngữ (đọc thuật ngữ lỗi): cache ngắn như trang dịch dở
      const sMaxAge = quotaExceeded
        ? QUOTA_PARTIAL_CACHE_SECONDS
        : partial || extra.glossaryError !== undefined
          ? PARTIAL_CACHE_SECONDS
          : site.cacheSeconds ?? DEFAULT_CACHE_SECONDS;
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        'content-language': parsed.lang,
        'x-content-type-options': 'nosniff',
        'cache-control': `public, max-age=0, s-maxage=${sMaxAge}`,
      };
      if (partial) headers['x-translateme-partial'] = partial;
      return finish(
        { statusCode: 200, headers, body: rb.html },
        {
          outcome: quotaExceeded ? 'PARTIAL_QUOTA' : partial ? 'PARTIAL' : 'OK',
          sentences: items.length,
          tmEnabled: Boolean(deps.tm),
          tmHitSentences: items.length - misses.length,
          tmHumanNeedsReview: [...hits.values()].filter((h) => h.label === 'HUMAN' && h.needsReview).length,
          tmMissSentences: misses.length,
          ...extra,
          quotaExceeded,
          reserved: reservation.reserved,
          machineChars,
          memoryChars,
          translated: tr.translated.length,
          pending: tr.pending.length,
          failed: tr.failed.length,
          failedReasons: [...new Set(tr.failed.map((f) => f.reason))].slice(0, 5),
          uniqueSentences: tr.stats.uniqueSentences,
          charsSent: tr.stats.charsSent,
          translateCalls: tr.stats.calls,
          splits: tr.stats.splits,
          plainFallbacks: tr.stats.plainFallbacks,
          keptSource: rb.stats.keptSource,
          tagFallback: rb.stats.tagFallback,
          workerEvents,
        },
      );
    } catch (err) {
      // Ví dụ: HTML lồng quá sâu làm parse5 tràn stack. Visitor được chuyển về trang gốc.
      logger.error({ ...log, action: 'PROXY_UNEXPECTED_ERROR', error: err instanceof Error ? err.name : 'Unknown', message: String(err).slice(0, 200) });
      return finish(redirect(originUrl), { outcome: 'UNEXPECTED_ERROR' });
    }
  };
}

// ============================================================================
// Cấu hình mặc định từ biến môi trường
// ============================================================================

const positive = (v: string | undefined, d: number): number => (Number(v) > 0 ? Number(v) : d);

/** Phần cấu hình proxy và worker dùng chung. */
function sharedFromEnv(env: NodeJS.ProcessEnv, logger: ProxyLogger) {
  let sites: ReturnType<typeof parseSitesJson> = [];
  try {
    sites = parseSitesJson(env.PROXY_SITES_JSON);
  } catch (err) {
    logger.error({ action: 'INVALID_PROXY_SITES_JSON', message: String(err).slice(0, 200) });
  }
  const tableName = env.TABLE_NAME?.trim();
  const tm = tableName
    ? createTM({ db: createDynamoTmDb(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName), writer: 'proxy' })
    : undefined;
  if (!tm) logger.error({ action: 'TM_DISABLED', reason: 'MISSING_TABLE_NAME' });
  const bucket = env.WORKER_PAYLOAD_BUCKET?.trim();
  return {
    resolveSite: cachedSiteResolver(staticSiteResolver(sites)),
    tm,
    store: bucket ? s3PayloadStore(new S3Client({}), bucket) : undefined,
    quota: quotaStub((e) => logger.info(e)),
    concurrency: positive(env.TRANSLATE_CONCURRENCY, DEFAULT_CONCURRENCY),
  };
}

/** Kho S3 cho danh sách câu lớn gửi worker. Nên đặt Lifecycle xoá worker/ sau 1 ngày. */
export function s3PayloadStore(s3: Pick<S3Client, 'send'>, bucket: string): PayloadStore {
  return {
    async put(key, body) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/json' }));
    },
    async get(key) {
      const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return (await out.Body?.transformToString('utf-8')) ?? '[]';
    },
  };
}

/** Gọi worker bất đồng bộ (InvocationType = Event): proxy không chờ worker dịch xong. */
export function lambdaWorkerInvoker(lambda: Pick<LambdaClient, 'send'>, functionName: string) {
  return async (event: WorkerEvent): Promise<void> => {
    const out = await lambda.send(
      new InvokeCommand({ FunctionName: functionName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(event), 'utf8') }),
    );
    if (out.StatusCode !== undefined && out.StatusCode !== 202) {
      throw Object.assign(new Error(`Worker invoke status ${out.StatusCode}`), { name: 'WorkerInvokeError' });
    }
  };
}

export function depsFromEnv(env: NodeJS.ProcessEnv = process.env, logger: ProxyLogger = defaultLogger): ProxyDeps {
  const shared = sharedFromEnv(env, logger);
  const baseMode: BaseMode = env.BASE_MODE === 'host' ? 'host' : 'path';
  if (!env.PUBLIC_BASE_URL) logger.error({ action: 'MISSING_PUBLIC_BASE_URL', fallback: DEFAULT_PUBLIC_BASE_URL });
  const workerName = env.WORKER_FUNCTION_NAME?.trim();
  if (!workerName) logger.error({ action: 'WORKER_DISABLED', reason: 'MISSING_WORKER_FUNCTION_NAME' });
  return {
    resolveSite: shared.resolveSite,
    fetchPage: env.USE_FETCH_STUB === '1' ? stubSafeFetch : (url) => realSafeFetch(url),
    translateClient: new TranslateClient({ maxAttempts: 3 }),
    baseMode,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    budgetMs: positive(env.TRANSLATE_BUDGET_MS, DEFAULT_BUDGET_MS),
    concurrency: shared.concurrency,
    logger,
    tm: shared.tm,
    quota: shared.quota,
    invokeWorker: workerName ? lambdaWorkerInvoker(new LambdaClient({}), workerName) : undefined,
    workerStore: shared.store,
  };
}

/** Cấu hình worker C13 (worker.ts gọi khi khởi động). Worker bắt buộc có TM. */
export function workerDepsFromEnv(env: NodeJS.ProcessEnv = process.env, logger: ProxyLogger = defaultLogger): WorkerDeps {
  const shared = sharedFromEnv(env, logger);
  if (!shared.tm) throw new Error('Worker cần TABLE_NAME (Translation Memory)');
  return {
    resolveSite: shared.resolveSite,
    tm: shared.tm,
    translate: createTranslator(new TranslateClient({ maxAttempts: 3 })),
    quota: shared.quota,
    store: shared.store,
    budgetMs: positive(env.WORKER_BUDGET_MS, DEFAULT_WORKER_BUDGET_MS),
    concurrency: shared.concurrency,
    logger,
  };
}

let defaultHandler: ReturnType<typeof createProxyHandler> | undefined;

/** Điểm vào Lambda: services/proxy/dist/services/proxy/handler.handler */
export const handler = (event: FunctionUrlEvent): Promise<ProxyResponse> => {
  defaultHandler ??= createProxyHandler(depsFromEnv());
  return defaultHandler(event);
};
