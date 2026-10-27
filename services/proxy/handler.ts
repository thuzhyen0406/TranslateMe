/**
 * Lambda proxy F2 (Nhiệm vụ 1.6 + 2.4, TV2): bước 1, 2, 3–4 (TM), 5 (rút gọn), 6, 8.
 * Gọi qua Lambda function URL (AWS_IAM) phía sau CloudFront + OAC. Đường dẫn nhận được luôn có dạng
 * /{slug}/{lang}/{path} (BASE_MODE=path: Visitor gõ sẵn; BASE_MODE=host: CloudFront Function viết lại).
 *
 *  1. Kiểm tra phương thức (GET/HEAD), tách slug/lang/path, tra website (SiteResolver, lưu đệm 60 s).
 *     Website không ACTIVE hoặc tenant LOCKED -> 302 về trang gốc; lang không bật -> 404.
 *     Tải trang gốc bằng safe_fetch (chặn SSRF, không chuyển cookie) và xử lý `outcome.kind`.
 *  2. extract(): tách câu {n}, bỏ qua vùng không dịch của website.
 *  3–4. Băm câu, tra TM (getTM): HUMAN dùng ngay, MACHINE dùng nếu chưa lỗi thời theo thuật ngữ.
 *  5. (bản rút gọn) translateSentences() cho câu trượt TM, rồi putMachineTM (không đè HUMAN).
 *     Lỗi TM không làm hỏng trang: tra lỗi -> coi như trượt hết; ghi lỗi -> chỉ ghi log.
 *  6. rebuildDetailed(): ráp HTML, canonical/hreflang theo BASE_MODE + PUBLIC_BASE_URL, viết lại URL.
 *  8. Trả 200 + Cache-Control: public, s-maxage=<cacheSeconds>; trang dịch dở dùng s-maxage=60 và
 *     X-TranslateMe-Partial: 1. Mọi lỗi không lường trước -> 302 về trang gốc (Visitor không thấy trang lỗi).
 * Chưa làm: đặt trước hạn mức + USAGE (2.7 của TV3), chữ ký B.9 + worker (2.5), SEG (3.4).
 * Bản tạm (B.14): hash câu chờ thư viện 1.8, getGlossaryState chờ 2.8, db chờ batchGet/update của 2.2.
 *
 * Biến môi trường: PUBLIC_BASE_URL, BASE_MODE (path|host), PROXY_SITES_JSON, TABLE_NAME (bật TM), TRANSLATE_BUDGET_MS (20000),
 * TRANSLATE_CONCURRENCY (4), USE_FETCH_STUB=1 (dùng safeFetch.stub, không gọi mạng).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { TranslateClient } from '@aws-sdk/client-translate';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { extract } from '../../libs/common/extract.js';
import { DEFAULT_PUBLIC_BASE_URL, rebuildDetailed, type BaseMode } from '../../libs/common/rebuild.js';
import { safe_fetch as realSafeFetch, type SafeFetchCompatResult } from '../../libs/common/safeFetch.js';
import { safe_fetch as stubSafeFetch } from '../../libs/common/safeFetch.stub.js';
import { createDynamoTmDb, createTM, type GlossaryState, type SentenceWithHash, type TmHit } from '../../libs/common/tm.js';
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
import { getGlossaryStateStub, hashSentenceStub } from './stubs.js';
import { DEFAULT_CONCURRENCY, translateSentences, type TranslateClientLike } from './translator.js';

export const DEFAULT_BUDGET_MS = 20_000;
export const PARTIAL_CACHE_SECONDS = 60;
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
      const glossary = deps.tm ? await (deps.getGlossaryState ?? getGlossaryStateStub)(ctx) : undefined;

      // Bước 3–4: băm câu và tra TM
      const hashOf = deps.hashSentence ?? hashSentenceStub;
      const items: SentenceWithHash[] = ex.sentences.map((text, id) => ({ id, text, hash: hashOf(text) }));
      let hits = new Map<Sha256Hex, TmHit>();
      const tmLog: Record<string, unknown> = {};
      if (deps.tm && glossary) {
        try {
          hits = (await deps.tm.getTM(ctx, site.sourceLang, parsed.lang, items, glossary)).hits;
        } catch (err) {
          tmLog.tmReadError = err instanceof Error ? err.name : 'Unknown';
        }
      }
      const translations: Array<string | undefined> = items.map((it) => hits.get(it.hash)?.tgt);
      const missIdx = items.filter((it) => translations[it.id] === undefined).map((it) => it.id);

      // Bước 5 (rút gọn): dịch máy câu trượt TM trong ngân sách thời gian
      const tr = await translateSentences(
        deps.translateClient,
        missIdx.map((i) => ex.sentences[i]),
        {
          sourceLang: site.sourceLang,
          targetLang: parsed.lang,
          terminologyNames: glossary?.terminologyName ? [glossary.terminologyName] : undefined,
          deadline: started + budgetMs,
          concurrency: deps.concurrency ?? DEFAULT_CONCURRENCY,
          now,
        },
      );
      missIdx.forEach((i, k) => (translations[i] = tr.translations[k]));

      // Ghi bản MACHINE mới vào TM (không đè HUMAN)
      if (deps.tm && glossary) {
        const entries = missIdx
          .map((i, k) => ({ i, k }))
          .filter(({ k }) => tr.translations[k] !== undefined)
          .map(({ i, k }) => ({
            hash: items[i].hash,
            sourceText: items[i].text,
            tgt: tr.translations[k] as string,
            glossaryVersion: glossary.version,
            needsReview: tr.needsReview[k],
          }));
        try {
          const rep = await deps.tm.putMachineTM(ctx, site.sourceLang, parsed.lang, entries);
          Object.assign(tmLog, { tmWritten: rep.written, tmSkippedHuman: rep.skippedHuman, tmWriteFailed: rep.failed.length });
        } catch (err) {
          tmLog.tmWriteError = err instanceof Error ? err.name : 'Unknown';
        }
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

      if (Buffer.byteLength(rb.html, 'utf8') > MAX_RESPONSE_BYTES) {
        return finish(redirect(originUrl), { outcome: 'RESPONSE_TOO_LARGE' });
      }

      // Bước 8: trả về CloudFront
      const partial = rb.stats.keptSource > 0;
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        'content-language': parsed.lang,
        'x-content-type-options': 'nosniff',
        'cache-control': `public, max-age=0, s-maxage=${partial ? PARTIAL_CACHE_SECONDS : site.cacheSeconds ?? DEFAULT_CACHE_SECONDS}`,
      };
      if (partial) headers['x-translateme-partial'] = '1';
      return finish(
        { statusCode: 200, headers, body: rb.html },
        {
          outcome: partial ? 'PARTIAL' : 'OK',
          sentences: ex.sentences.length,
          tmEnabled: Boolean(deps.tm),
          tmHitSentences: ex.sentences.length - missIdx.length,
          tmMissSentences: missIdx.length,
          ...tmLog,
          uniqueSentences: tr.uniqueSentences,
          charsSent: tr.charsSent,
          translateCalls: tr.calls,
          plainFallbacks: tr.plainFallbacks,
          untranslated: tr.untranslated,
          tagFallback: rb.stats.tagFallback,
          timedOut: tr.timedOut,
          translateErrors: tr.errors.slice(0, 5),
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

export function depsFromEnv(env: NodeJS.ProcessEnv = process.env, logger: ProxyLogger = defaultLogger): ProxyDeps {
  let sites: ReturnType<typeof parseSitesJson> = [];
  try {
    sites = parseSitesJson(env.PROXY_SITES_JSON);
  } catch (err) {
    logger.error({ action: 'INVALID_PROXY_SITES_JSON', message: String(err).slice(0, 200) });
  }
  const baseMode: BaseMode = env.BASE_MODE === 'host' ? 'host' : 'path';
  if (!env.PUBLIC_BASE_URL) logger.error({ action: 'MISSING_PUBLIC_BASE_URL', fallback: DEFAULT_PUBLIC_BASE_URL });
  const positive = (v: string | undefined, d: number) => (Number(v) > 0 ? Number(v) : d);
  const tableName = env.TABLE_NAME?.trim();
  const tm = tableName
    ? createTM({ db: createDynamoTmDb(DynamoDBDocumentClient.from(new DynamoDBClient({})), tableName), writer: 'proxy' })
    : undefined;
  if (!tm) logger.error({ action: 'TM_DISABLED', reason: 'MISSING_TABLE_NAME' });
  return {
    resolveSite: cachedSiteResolver(staticSiteResolver(sites)),
    fetchPage: env.USE_FETCH_STUB === '1' ? stubSafeFetch : (url) => realSafeFetch(url),
    translateClient: new TranslateClient({ maxAttempts: 3 }),
    baseMode,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    budgetMs: positive(env.TRANSLATE_BUDGET_MS, DEFAULT_BUDGET_MS),
    concurrency: positive(env.TRANSLATE_CONCURRENCY, DEFAULT_CONCURRENCY),
    logger,
    tm,
  };
}

let defaultHandler: ReturnType<typeof createProxyHandler> | undefined;

/** Điểm vào Lambda: services/proxy/dist/services/proxy/handler.handler */
export const handler = (event: FunctionUrlEvent): Promise<ProxyResponse> => {
  defaultHandler ??= createProxyHandler(depsFromEnv());
  return defaultHandler(event);
};
