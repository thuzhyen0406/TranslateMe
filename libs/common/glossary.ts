/**
 * Hạng mục 2.8 & 3.9 – Phần đọc Thuật ngữ / Glossary, Kiểm tra lỗi thời (`isStale`)
 * và Hậu kiểm (`postCheckGlossary`) dùng chung (`libs/common/glossary.ts`).
 *
 * Đặt tại `libs/common/` để cả Lambda Proxy (`services/proxy`), REST API (`services/api`) và Worker
 * import trực tiếp mà không phải import chéo giữa các service và không phụ thuộc `experiments/`.
 */

import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { db } from './db.js';
import { stripMarkers } from './markers.js';
import { AppError, keys, type Ctx, type Lang } from './types.js';

/** Các mã ngôn ngữ ISO 639-1 được hệ thống hỗ trợ trong MVP. */
export const SUPPORTED_GLOSSARY_LANGUAGES = Object.freeze([
  'vi',
  'en',
  'ko',
  'ja',
  'zh',
  'fr',
  'de',
  'es',
] as const);

/** Danh sách ngôn ngữ đích mặc định khi tenant chưa cấu hình website. */
export const DEFAULT_TARGET_LANGUAGES: readonly Lang[] = Object.freeze(['en', 'ko', 'ja', 'zh']);

/** Thời gian lưu đệm tối đa của GlossaryState trong bộ nhớ Lambda (60 giây theo B.7). */
export const GLOSSARY_CACHE_TTL_MS = 60_000;

export type GlossaryTermType = 'KEEP' | 'FIXED';

export interface GlossaryTermEntry {
  normalized: string;
  sourceTerm: string;
  sourceLang: Lang;
  type: GlossaryTermType;
  translations: Record<Lang, string>;
  sinceVersion: number;
  deleted?: boolean;
  updatedAt?: string;
}

export interface GlossaryState {
  /** glossaryVersion hiện hành ở bản ghi CONFIG của tenant */
  version: number;
  /** Tên Custom Terminology trên Amazon Translate đã đồng bộ thành công; null khi chưa có hoặc chưa đồng bộ */
  terminologyName: string | null;
  pendingTerminology?: boolean;
  /** Danh sách thuật ngữ (gồm cả mục đã đánh dấu xóa để `isStale` phát hiện bản dịch MACHINE cũ) */
  terms: {
    normalized: string;
    sourceTerm?: string;
    sourceLang?: Lang;
    type: GlossaryTermType;
    translations?: Record<Lang, string>;
    sinceVersion: number;
    deleted?: boolean;
  }[];
}

export interface GlossaryReadDependencies {
  db: Pick<typeof db, 'get' | 'query'>;
  now: () => number;
}

const defaultReadDeps: GlossaryReadDependencies = {
  db,
  now: () => Date.now(),
};

/**
 * Tạo hàm `getGlossaryState` gắn với một `DynamoDBDocumentClient` và `tableName` cụ thể
 * (dùng trong Lambda Proxy, Worker C13 và Realtime API khi khởi tạo từ biến môi trường hoặc mock test).
 */
export function createDynamoGlossaryReader(
  doc: Pick<DynamoDBDocumentClient, 'send'>,
  tableName: string,
  opts: { now?: () => number } = {},
): (ctx: Ctx) => Promise<GlossaryState> {
  const assertTenant = (ctx: Ctx, pk: string) => {
    const allowedPrefix = `TENANT#${ctx.tenantId}`;
    if (!ctx.tenantId || ctx.tenantId === 'PLATFORM' || (pk !== allowedPrefix && !pk.startsWith(`${allowedPrefix}#`))) {
      throw new AppError('FORBIDDEN', `Bị từ chối: Ctx Tenant (${ctx.tenantId}) không có quyền truy cập PK (${pk})`);
    }
  };
  const customDeps: GlossaryReadDependencies = {
    now: opts.now ?? (() => Date.now()),
    db: {
      async get(ctx, key) {
        assertTenant(ctx, key.PK);
        const res = await doc.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
        return (res.Item as Record<string, any> | undefined) ?? null;
      },
      async query(ctx, pk, skPrefix) {
        assertTenant(ctx, pk);
        const allItems: Record<string, any>[] = [];
        let exclusiveStartKey: Record<string, any> | undefined;
        do {
          const res = await doc.send(
            new QueryCommand({
              TableName: tableName,
              ConsistentRead: true,
              KeyConditionExpression: skPrefix ? 'PK = :pk AND begins_with(SK, :skPrefix)' : 'PK = :pk',
              ExpressionAttributeValues: skPrefix ? { ':pk': pk, ':skPrefix': skPrefix } : { ':pk': pk },
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            }),
          );
          if (res.Items) allItems.push(...(res.Items as Record<string, any>[]));
          exclusiveStartKey = res.LastEvaluatedKey as Record<string, any> | undefined;
        } while (exclusiveStartKey);
        return allItems;
      },
    },
  };
  return (ctx: Ctx) => getGlossaryState(ctx, customDeps);
}

// ============================================================================
// Bộ nhớ đệm GlossaryState theo (tenantId, version, terminologyName) trong Lambda (60s)
// ============================================================================

interface CachedGlossaryState {
  version: number;
  terminologyName: string | null;
  state: GlossaryState;
  expiresAt: number;
}

const glossaryCache = new Map<string, CachedGlossaryState>();

/** Xóa bộ nhớ đệm của một tenant hoặc toàn bộ (dùng sau khi ghi hoặc trong unit test). */
export function clearGlossaryCache(tenantId?: string): void {
  if (tenantId) {
    glossaryCache.delete(tenantId);
  } else {
    glossaryCache.clear();
  }
}

// ============================================================================
// Hàm chuẩn hóa chuỗi & Công thức tên Terminology (B.7 & Mục 2.6.5)
// ============================================================================

/** Loại bỏ thẻ HTML và ký hiệu nội tuyến {n} / {/n} hoặc {n/} mà không phụ thuộc experiments/. */
export function stripTagsAndMarkers(text: string): string {
  if (typeof text !== 'string') return '';
  return stripMarkers(text.replace(/<[^>]*>/g, ' '));
}

/** Chuẩn hóa Unicode NFC, gộp khoảng trắng liên tiếp và cắt 2 đầu (giữ nguyên chữ hoa/thường). */
export function cleanTermText(text: string): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Chuẩn hóa từ nguồn làm khóa định danh (NFC + gộp khoảng trắng + cắt 2 đầu + chữ thường). */
export function normalizeTerm(text: string): string {
  return cleanTermText(text).toLowerCase();
}

/**
 * Công thức duy nhất tạo tên Custom Terminology trên Amazon Translate cho mỗi tenant (B.7 & Mục 2.6.5).
 * Chỉ chứa các ký tự hợp lệ của AWS Translate `^([A-Za-z0-9-]_?)+$`.
 */
export function terminologyNameOf(ctx: Ctx, version?: number): string {
  const safeId = ctx.tenantId.replace(/[^A-Za-z0-9-_]/g, '-');
  return version === undefined ? `tm-${safeId}` : `tm-${safeId}-v${version}`;
}

export function syncedTerminologyName(config: Record<string, unknown> | null, version: number): string | null {
  const name = config?.terminologyName;
  const synced = config?.terminologySyncedVersion;
  return typeof name === 'string' && (synced === undefined || synced === version) ? name.trim() || null : null;
}

/** A fallback without the latest terminology must be eligible for translation again after sync. */
export function machineGlossaryVersion(glossary: GlossaryState): number {
  return glossary.pendingTerminology ? 0 : glossary.version;
}

// ============================================================================
// Đọc trạng thái Thuật ngữ (getGlossaryState - B.7)
// ============================================================================

/**
 * Lấy trạng thái bảng thuật ngữ của tenant (B.7).
 *  - Đọc `glossaryVersion` và `terminologyName` đã đồng bộ từ `CONFIG`.
 *  - Chỉ trả `terminologyName` khi `ImportTerminology` đã thành công và còn ít nhất 1 thuật ngữ hiệu lực.
 *  - Lưu đệm trong bộ nhớ Lambda theo `(version, terminologyName)` tối đa 60 giây.
 */
export async function getGlossaryState(
  ctx: Ctx,
  deps: GlossaryReadDependencies = defaultReadDeps,
): Promise<GlossaryState> {
  const config = await deps.db.get(ctx, keys.config(ctx), { consistent: true });
  const currentVersion = Number(config?.glossaryVersion ?? 0);
  const terminologyName = syncedTerminologyName(config, currentVersion);

  const now = deps.now();
  const cached = glossaryCache.get(ctx.tenantId);

  if (
    cached &&
    cached.version === currentVersion &&
    cached.terminologyName === terminologyName &&
    now < cached.expiresAt
  ) {
    return cached.state;
  }

  if (currentVersion <= 0) {
    const emptyState: GlossaryState = {
      version: 0,
      terminologyName: null,
      terms: [],
    };
    glossaryCache.set(ctx.tenantId, {
      version: 0,
      terminologyName: null,
      state: emptyState,
      expiresAt: now + GLOSSARY_CACHE_TTL_MS,
    });
    return emptyState;
  }

  const glossPk = `TENANT#${ctx.tenantId}#GLOSS`;
  const rawItems = await deps.db.query(ctx, glossPk, 'TERM#', { consistent: true });

  const terms: GlossaryState['terms'] = rawItems.map((item: Record<string, any>) => ({
    normalized: String(item.normalized ?? String(item.SK ?? '').replace(/^TERM#/, '')),
    sourceTerm: typeof item.sourceTerm === 'string' ? item.sourceTerm : String(item.normalized ?? ''),
    sourceLang: typeof item.sourceLang === 'string' ? item.sourceLang : 'vi',
    type: item.type === 'KEEP' ? 'KEEP' : 'FIXED',
    translations:
      item.translations && typeof item.translations === 'object'
        ? { ...item.translations }
        : {},
    sinceVersion: Number(item.sinceVersion ?? 1),
    deleted: Boolean(item.deleted),
  }));

  if (terms.some((term) => term.sinceVersion > currentVersion)) {
    throw new Error('Glossary changed while reading its terms.');
  }
  const hasActiveTerms = terms.some((t) => !t.deleted);
  const effectiveTerminologyName = hasActiveTerms ? terminologyName : null;

  const state: GlossaryState = {
    version: currentVersion,
    terminologyName: effectiveTerminologyName,
    ...(hasActiveTerms && !effectiveTerminologyName && config?.terminologySyncedVersion !== currentVersion
      ? { pendingTerminology: true }
      : {}),
    terms,
  };

  glossaryCache.set(ctx.tenantId, {
    version: currentVersion,
    terminologyName: effectiveTerminologyName,
    state,
    expiresAt: now + GLOSSARY_CACHE_TTL_MS,
  });

  return state;
}

// ============================================================================
// Biên dịch sẵn mẫu dò thuật ngữ theo GlossaryState (WeakMap) & isStale / postCheckGlossary
// ============================================================================

const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildLatinBoundaryRegex(normalizedNeedle: string): RegExp {
  return new RegExp(
    `(?<![\\p{Script=Latin}\\p{M}\\p{N}])${escapeRegex(normalizedNeedle)}(?![\\p{Script=Latin}\\p{M}\\p{N}])`,
    'u',
  );
}

/**
 * Kiểm tra một thuật ngữ (đã chuẩn hóa NFC + chữ thường) có xuất hiện trong văn bản (đã chuẩn hóa NFC + chữ thường) hay không.
 *  - Dùng `includes` làm bộ lọc nhanh O(n) trước khi kiểm tra regex ranh giới từ.
 *  - Với chữ Latin / Quốc ngữ: so khớp theo ranh giới từ chữ Latin/chữ số, cho phép thuật ngữ KEEP
 *    đứng liền trước trợ từ tiếng Nhật/Hàn (như "Homestay ABCは", "Homestay ABC는").
 *  - Với chữ Hán, Nhật, Hàn (CJK): so khớp theo chuỗi con (`includes`).
 */
export function containsTermInText(
  normalizedHaystack: string,
  normalizedNeedle: string,
  precompiledRegex?: RegExp | null,
): boolean {
  if (!normalizedHaystack || !normalizedNeedle) return false;
  if (!normalizedHaystack.includes(normalizedNeedle)) return false;
  if (precompiledRegex === null || CJK_REGEX.test(normalizedNeedle)) {
    return true;
  }
  const regex = precompiledRegex ?? buildLatinBoundaryRegex(normalizedNeedle);
  return regex.test(normalizedHaystack);
}

interface TargetMatcherEntry {
  needle: string;
  isCjk: boolean;
  regex?: RegExp;
}

interface CompiledGlossaryTerm {
  raw: GlossaryState['terms'][number];
  needle: string;
  sinceVersion: number;
  deleted: boolean;
  isCjk: boolean;
  boundaryRegex?: RegExp;
  targetMatchers: Map<Lang, TargetMatcherEntry>;
}

const compiledTermsCache = new WeakMap<GlossaryState, CompiledGlossaryTerm[]>();

function getCompiledTerms(g: GlossaryState): CompiledGlossaryTerm[] {
  let compiled = compiledTermsCache.get(g);
  if (compiled) return compiled;

  compiled = [];
  for (const term of g.terms) {
    const needle = normalizeTerm(term.normalized || term.sourceTerm || '');
    if (!needle) continue;
    const isCjk = CJK_REGEX.test(needle);
    const targetMatchers = new Map<Lang, TargetMatcherEntry>();

    if (!term.deleted) {
      if (term.type === 'KEEP') {
        const keepNeedle = normalizeTerm(term.sourceTerm ?? term.normalized);
        targetMatchers.set('*', { needle: keepNeedle, isCjk: CJK_REGEX.test(keepNeedle) });
      } else if (term.translations) {
        for (const [lang, val] of Object.entries(term.translations)) {
          const tgtNeedle = normalizeTerm(val);
          if (!tgtNeedle) continue;
          targetMatchers.set(lang, { needle: tgtNeedle, isCjk: CJK_REGEX.test(tgtNeedle) });
        }
      }
    }

    compiled.push({
      raw: term,
      needle,
      sinceVersion: term.sinceVersion,
      deleted: Boolean(term.deleted),
      isCjk,
      targetMatchers,
    });
  }

  compiledTermsCache.set(g, compiled);
  return compiled;
}

function matchesCompiledTerm(normalizedHaystack: string, item: CompiledGlossaryTerm): boolean {
  if (!normalizedHaystack.includes(item.needle)) return false;
  if (item.isCjk) return true;
  if (!item.boundaryRegex) {
    item.boundaryRegex = buildLatinBoundaryRegex(item.needle);
  }
  return item.boundaryRegex.test(normalizedHaystack);
}

function matchesTargetEntry(normalizedHaystack: string, entry: TargetMatcherEntry): boolean {
  if (!normalizedHaystack.includes(entry.needle)) return false;
  if (entry.isCjk) return true;
  if (!entry.regex) {
    entry.regex = buildLatinBoundaryRegex(entry.needle);
  }
  return entry.regex.test(normalizedHaystack);
}

/**
 * Kiểm tra một bản ghi trong Translation Memory (TM) có bị lỗi thời theo bảng thuật ngữ hiện tại hay không (B.7 & Mục 2.6.5).
 *  - Sử dụng danh sách thuật ngữ đã chuẩn hóa một lần cho mỗi `GlossaryState` (WeakMap),
 *    lọc nhanh bằng `includes` và biên dịch/lưu đệm regex ranh giới từ khi cần.
 */
export function isStale(
  sourceText: string,
  entryGlossaryVersion: number,
  g: GlossaryState,
): boolean {
  if (!g || g.version <= entryGlossaryVersion || !Array.isArray(g.terms) || g.terms.length === 0) {
    return false;
  }

  const normalizedSource = normalizeTerm(stripTagsAndMarkers(sourceText));
  if (!normalizedSource) return false;

  const compiledTerms = getCompiledTerms(g);
  for (let i = 0; i < compiledTerms.length; i++) {
    const item = compiledTerms[i];
    if (item.sinceVersion <= entryGlossaryVersion) continue;
    if (matchesCompiledTerm(normalizedSource, item)) {
      return true;
    }
  }

  return false;
}

/**
 * Hậu kiểm thuật ngữ sau khi dịch máy (Mục 2.6.5).
 * Kiểm tra mọi thuật ngữ hiệu lực xuất hiện trong `sourceText` có xuất hiện bản dịch tương ứng
 * trong `translatedText` ở ngôn ngữ `targetLang` hay không.
 */
export function postCheckGlossary(
  sourceText: string,
  translatedText: string,
  targetLang: Lang,
  g: GlossaryState,
): {
  passed: boolean;
  needsReview: boolean;
  missingTerms: string[];
} {
  if (!g || !Array.isArray(g.terms) || g.terms.length === 0) {
    return { passed: true, needsReview: false, missingTerms: [] };
  }

  const normalizedSource = normalizeTerm(stripTagsAndMarkers(sourceText));
  const normalizedTranslated = normalizeTerm(stripTagsAndMarkers(translatedText));
  const missingTerms: string[] = [];

  const compiledTerms = getCompiledTerms(g);
  for (let i = 0; i < compiledTerms.length; i++) {
    const item = compiledTerms[i];
    if (item.deleted) continue;
    if (!matchesCompiledTerm(normalizedSource, item)) continue;

    const targetMatcher =
      item.raw.type === 'KEEP'
        ? item.targetMatchers.get('*')
        : item.targetMatchers.get(targetLang);

    if (!targetMatcher) continue;
    if (!matchesTargetEntry(normalizedTranslated, targetMatcher)) {
      missingTerms.push(item.raw.sourceTerm ?? item.raw.normalized);
    }
  }

  const passed = missingTerms.length === 0;
  return {
    passed,
    needsReview: !passed,
    missingTerms,
  };
}
