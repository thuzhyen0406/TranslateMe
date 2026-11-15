/**
 * Lambda worker C13 – chế độ hoàn tất nền cho proxy (FINISH_PAGE, 2.5 – TV2; nối Thuật ngữ 3.9 – TV4). Theo B.10.
 *
 * Proxy hết ngân sách 20 giây thì gửi các câu chưa dịch kịp sang đây (InvocationType = Event).
 * Worker:
 *  1. Kiểm tra lại sự kiện và tenant (B.1.1): slug tồn tại, thuộc đúng tenantId, website ACTIVE, tenant không LOCKED.
 *     Câu đọc từ S3 chỉ được nằm dưới tenant/<tenantId>/worker/.
 *  2. Tra lại TM (lượt truy cập khác có thể đã dịch), gắn cờ "Cần xem lại" cho bản HUMAN lỗi thời nếu có, chỉ dịch câu còn trượt.
 *  3. Tự đặt trước hạn mức cho phần mình dịch (proxy đã hoàn lại phần chưa dịch ở bước 8). Hết hạn mức thì dừng,
 *     câu còn lại giữ ngôn ngữ gốc.
 *  4. Dịch, hậu kiểm thuật ngữ (postCheckGlossary, 3.9), ghi TM bản MACHINE, settleUsage với Source = { kind: 'WEB', slug }.
 * Không throw khi lỗi (tránh Lambda tự gọi lại 2 lần làm dịch và tính phí trùng); kết quả nằm trong log.
 */
import { postCheckGlossary, machineGlossaryVersion } from '../../libs/common/glossary.js';
import { createTM, type GlossaryState, type SentenceWithHash } from '../../libs/common/tm.js';
import type { TranslateRequest, TranslateResult } from '../../libs/common/translator.js';
import type { Ctx } from '../../libs/common/types.js';
import { LANG_RE, SLUG_RE, type SiteResolver } from './sites.js';
import { countCharsStub } from './stubs.js';
import { isCharQuotaExceeded, type QuotaApi, type Reservation } from './usage.js';
import { workerKeyPrefix, type PayloadStore, type WorkerEvent } from './workerEvents.js';

export const DEFAULT_WORKER_BUDGET_MS = 240_000;

export interface WorkerLogger {
  info(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

export interface WorkerDeps {
  resolveSite: SiteResolver;
  tm: ReturnType<typeof createTM>;
  translate: (req: TranslateRequest) => Promise<TranslateResult>;
  quota: QuotaApi;
  getGlossaryState?: (ctx: Ctx) => Promise<GlossaryState>;
  store?: PayloadStore;
  countChars?: (text: string) => number;
  budgetMs?: number;
  concurrency?: number;
  now?: () => number;
  logger?: WorkerLogger;
}

export type WorkerStatus = 'DONE' | 'NOTHING_TO_DO' | 'QUOTA_EXCEEDED' | 'REJECTED' | 'ERROR';

export interface WorkerResult {
  status: WorkerStatus;
  reason?: string;
  received: number;
  translated: number;
  pending: number;
  failed: number;
}

export const defaultWorkerLogger: WorkerLogger = {
  info: (e) => console.log(JSON.stringify({ level: 'INFO', service: 'translate-worker', ...e })),
  error: (e) => console.error(JSON.stringify({ level: 'ERROR', service: 'translate-worker', ...e })),
};

function validEvent(e: unknown): e is WorkerEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  return (
    o.type === 'FINISH_PAGE' &&
    typeof o.tenantId === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(o.tenantId) &&
    o.tenantId !== 'PLATFORM' &&
    typeof o.slug === 'string' &&
    SLUG_RE.test(o.slug) &&
    typeof o.src === 'string' &&
    LANG_RE.test(o.src) &&
    typeof o.tgt === 'string' &&
    LANG_RE.test(o.tgt) &&
    typeof o.path === 'string' &&
    (Array.isArray(o.sentences) || typeof o.sentencesS3Key === 'string')
  );
}

function validSentences(v: unknown): v is SentenceWithHash[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        s && typeof s === 'object' && typeof s.id === 'number' && typeof s.text === 'string' && typeof s.hash === 'string' && /^[0-9a-f]{64}$/.test(s.hash),
    )
  );
}

export function createWorkerHandler(deps: WorkerDeps) {
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? defaultWorkerLogger;
  const countChars = deps.countChars ?? countCharsStub;

  return async function workerHandler(event: unknown): Promise<WorkerResult> {
    const started = now();
    const res: WorkerResult = { status: 'DONE', received: 0, translated: 0, pending: 0, failed: 0 };
    const log: Record<string, unknown> = {};
    const finish = (r: WorkerResult): WorkerResult => {
      logger.info({ ...log, ...r, durationMs: now() - started });
      return r;
    };
    const reject = (reason: string): WorkerResult => finish({ ...res, status: 'REJECTED', reason });

    if (!validEvent(event)) return reject('INVALID_EVENT');
    Object.assign(log, { tenantId: event.tenantId, slug: event.slug, tgt: event.tgt, path: event.path, requestId: event.requestId });

    try {
      // 1. Kiểm tra lại tenant
      const site = await deps.resolveSite(event.slug);
      if (!site || site.tenantId !== event.tenantId) return reject('TENANT_MISMATCH');
      if (site.tenantStatus !== 'ACTIVE') return reject('TENANT_LOCKED');
      if (site.status !== 'ACTIVE') return reject('SITE_NOT_ACTIVE');
      if (site.sourceLang !== event.src || !site.targetLangs.includes(event.tgt)) return reject('LANG_NOT_ENABLED');
      const ctx: Ctx = { tenantId: site.tenantId, via: 'SLUG', requestId: event.requestId ?? 'worker', slug: site.slug };

      // Câu: kèm trong sự kiện hoặc đọc từ S3 dưới tiền tố của tenant
      let sentences: unknown = event.sentences;
      if (event.sentencesS3Key !== undefined) {
        if (!event.sentencesS3Key.startsWith(workerKeyPrefix(site.tenantId)) || event.sentencesS3Key.includes('..')) {
          return reject('S3_KEY_OUTSIDE_TENANT');
        }
        if (!deps.store) return reject('NO_PAYLOAD_STORE');
        sentences = JSON.parse(await deps.store.get(event.sentencesS3Key, site.tenantId));
      }
      if (!validSentences(sentences)) return reject('INVALID_SENTENCES');
      res.received = sentences.length;

      // Thuật ngữ hiện hành (có thể đã đổi từ lúc proxy gửi).
      // Nếu đọc Glossary lỗi thì dừng xử lý (status = ERROR) trước khi tra/ghi TM hay đặt hạn mức,
      // tránh bỏ sót việc gắn cờ HUMAN lỗi thời hoặc ghi bản MACHINE vào TM mà chưa qua hậu kiểm thuật ngữ.
      let glossary: GlossaryState = { version: event.glossaryVersion, terminologyName: event.terminologyName, terms: [] };
      if (deps.getGlossaryState) {
        try {
          glossary = await deps.getGlossaryState(ctx);
        } catch (err) {
          const errName = err instanceof Error ? err.name : 'Unknown';
          log.glossaryError = errName;
          logger.error({
            ...log,
            action: 'WORKER_GLOSSARY_ERROR',
            error: errName,
            message: String(err).slice(0, 200),
          });
          return finish({ ...res, status: 'ERROR', reason: 'GLOSSARY_READ_ERROR', pending: sentences.length });
        }
      }

      // 2. Tra lại TM (kèm gắn cờ "Cần xem lại" cho bản HUMAN lỗi thời nếu phát hiện lúc tra)
      const { hits, misses, reviewFlags } = await deps.tm.getTM(ctx, event.src, event.tgt, sentences, glossary);
      if (reviewFlags.length) {
        try {
          const flagRep = await deps.tm.markHumanNeedsReview(
            ctx,
            event.src,
            event.tgt,
            reviewFlags.map((hash) => ({ hash, tgt: hits.get(hash)!.tgt })),
          );
          Object.assign(log, { tmReviewFlagged: flagRep.marked, tmReviewFlagSkipped: flagRep.skipped, tmReviewFlagFailed: flagRep.failed.length });
        } catch (err) {
          log.tmReviewFlagError = err instanceof Error ? err.name : 'Unknown';
        }
      }
      if (!misses.length) return finish({ ...res, status: 'NOTHING_TO_DO' });

      // 3. Đặt trước hạn mức cho phần worker dịch
      const n = misses.reduce((sum, s) => sum + countChars(s.text), 0);
      let reservation: Reservation;
      try {
        reservation = await deps.quota.reserveChars(ctx, n);
      } catch (err) {
        if (isCharQuotaExceeded(err)) return finish({ ...res, status: 'QUOTA_EXCEEDED', pending: misses.length });
        throw err;
      }

      // 4. Dịch, hậu kiểm thuật ngữ (3.9), ghi TM, đếm
      let tr: TranslateResult;
      try {
        tr = await deps.translate({
          src: event.src,
          tgt: event.tgt,
          sentences: misses.map(({ id, text }) => ({ id, text })),
          terminologyName: glossary.terminologyName,
          deadlineAt: started + (deps.budgetMs ?? DEFAULT_WORKER_BUDGET_MS),
          concurrency: deps.concurrency ?? 4,
        });
      } catch (err) {
        await deps.quota.releaseChars(ctx, reservation);
        throw err;
      }
      const byId = new Map(misses.map((s) => [s.id, s]));
      let postCheckFlagged = 0;
      // Ghi TM lỗi thì vẫn quyết toán phần đã dịch (Translate đã tính phí) rồi mới báo ERROR,
      // để phiếu đặt trước không treo ở RESERVED.
      let rep: Awaited<ReturnType<typeof deps.tm.putMachineTM>> | undefined;
      let tmWriteError: unknown;
      try {
        rep = await deps.tm.putMachineTM(
          ctx,
          event.src,
          event.tgt,
          tr.translated.map((t) => {
            const item = byId.get(t.id)!;
            const postCheck = postCheckGlossary(item.text, t.tgt, event.tgt, glossary);
            if (postCheck.needsReview) postCheckFlagged++;
            return {
              hash: item.hash,
              sourceText: item.text,
              tgt: t.tgt,
              glossaryVersion: machineGlossaryVersion(glossary),
              needsReview: t.needsReview || postCheck.needsReview,
            };
          }),
        );
      } catch (err) {
        tmWriteError = err;
      }
      const machineChars = tr.translated.reduce((sum, t) => sum + countChars(byId.get(t.id)!.text), 0);
      // Phần dịch nền không phải lượt truy cập: requests = pagesServed = 0; câu trượt đã được proxy đếm.
      await deps.quota.settleUsage(ctx, reservation, { kind: 'WEB', slug: site.slug }, {
        machineChars,
        memoryChars: 0,
        sentTotal: 0,
        sentFromTM: 0,
        requests: 0,
        pagesServed: 0,
      });
      if (!rep) throw tmWriteError ?? new Error('TM_WRITE_FAILED');
      Object.assign(log, {
        charsSent: tr.stats.charsSent,
        tmWritten: rep.written,
        tmSkippedHuman: rep.skippedHuman,
        tmWriteFailed: rep.failed.length,
        ...(postCheckFlagged > 0 ? { glossaryPostCheckFlagged: postCheckFlagged } : {}),
      });
      return finish({ ...res, translated: tr.translated.length, pending: tr.pending.length, failed: tr.failed.length });
    } catch (err) {
      logger.error({ ...log, action: 'WORKER_ERROR', error: err instanceof Error ? err.name : 'Unknown', message: String(err).slice(0, 200) });
      return finish({ ...res, status: 'ERROR', reason: err instanceof Error ? err.name : 'Unknown' });
    }
  };
}

// ============================================================================
// Điểm vào Lambda: services/proxy/dist/services/proxy/worker.handler
// Cấu hình dựng sẵn trong handler.ts (depsFromEnv) để proxy và worker dùng chung.
// ============================================================================

let defaultWorker: ReturnType<typeof createWorkerHandler> | undefined;

export const handler = async (event: unknown): Promise<WorkerResult> => {
  if (!defaultWorker) {
    const { workerDepsFromEnv } = await import('./handler.js');
    defaultWorker = createWorkerHandler(workerDepsFromEnv());
  }
  return defaultWorker(event);
};
