// MỌI giả định về giao diện nằm ở đây. Chỉ /translate/* có tên trường được báo cáo cố định
// (Bảng 2.8). Body của /console/* và /platform/* là [GIẢ ĐỊNH]: đối chiếu với code thật
// của nhóm rồi sửa tại file này, không sửa rải rác trong test.
import { createHash } from 'node:crypto';

export const R = {
  me: '/console/me',
  hosts: '/console/hosts',
  host: (slug: string) => `/console/hosts/${slug}`,
  hostVerify: (slug: string) => `/console/hosts/${slug}/verify`,
  jobs: '/console/jobs',
  job: (id: string) => `/console/jobs/${id}`,
  glossary: '/console/glossary/terms',
  tm: '/console/translations?tab=MACHINE&src=vi&tgt=en',
  translationSearch: (text: string) => `/console/translations?tab=MACHINE&src=vi&tgt=en&search=${encodeURIComponent(text)}`,
  tmPages: (hash: string) => `/console/tm/${hash}/pages?src=vi&tgt=en`, // endpoint chưa được tích hợp
  usage: (month: string) => `/console/usage?month=${month}`,
  apiKeys: '/console/api-keys',
  batchSessionJob: (id: string) => `/translate/batch/session/${encodeURIComponent(id)}`,
  translate: '/translate/realtime',
  uploadUrl: '/translate/batch/upload-url',
  batch: '/translate/batch',
  batchJob: (id: string) => `/translate/batch/${id}`,
  platformTenants: '/platform/tenants',
  platformTenant: (id: string) => `/platform/tenants/${id}`,
  platformTenantLimits: (id: string) => `/platform/tenants/${id}/limits`,
  tenantStatus: (id: string) => `/platform/tenants/${id}/status`,
  platformConfig: '/platform/config',
  /** Trang của Visitor qua CloudFront */
  site: (publicBase: string, slug: string, lang: string) => `${publicBase}/${slug}/${lang}/`,
};

export const B = {
  // Khớp CreateSiteInput của services/api/sites/siteManager.ts. Server tự sinh slug
  // từ hostname của home_url; slug truyền vào chỉ dùng làm display_name trong fixture.
  addHost: (slug: string, origin: string) => ({
    home_url: origin,
    display_name: slug,
    source_lang: 'vi',
    target_langs: ['en'],
  }),
  // PATCH không đổi gì thật, để phép thử chéo không làm hỏng website của tenant B nếu có lỗ hổng
  noopHostPatch: () => ({ target_langs: ['en'] }),
  // [GIẢ ĐỊNH]
  createKey: (name: string) => ({ name, plan: 'Basic' }),
  glossaryTerm: (src: string, tgt: string) => ({ source_term: src, target_term: tgt, mode: 'TRANSLATE_AS' }),
  // Bảng 2.8 (cố định trong báo cáo)
  translate: (text: string, extra: Record<string, unknown> = {}) =>
    ({ text, source_lang: 'vi', target_lang: 'en', ...extra }),
  uploadUrl: (fileName: string, size: number) => ({ file_name: fileName, size_bytes: size }),
  batch: (fileKey: string) => ({ file_key: fileKey, target_langs: ['en'], source_lang: 'vi' }),
};

/** Hash câu: SHA-256 của câu đã chuẩn hóa NFC, hex chữ thường 64 ký tự (QC-4) */
export const hashSentence = (s: string): string =>
  createHash('sha256').update(s.normalize('NFC').replace(/\s+/gu, ' ').trim(), 'utf8').digest('hex');

// ---- Trích xuất tolerant từ phản hồi (đổi ở đây nếu tên trường khác)
export function listOf(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.items)) return body.items;
  if (body && typeof body === 'object') {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v as any[];
  }
  return [];
}
export const keyIdOf = (b: any): string => b?.api_key?.key_id ?? b?.key?.key_id ?? b?.key_id ?? b?.keyId ?? b?.id ?? '';
export const keyValueOf = (b: any): string => b?.api_key?.value ?? b?.key?.value ?? b?.api_key ?? b?.value ?? b?.key ?? '';
export const tenantIdOf = (b: any): string => b?.tenant_id ?? b?.tenantId ?? '';
export const jobIdOf = (b: any): string => b?.job_id ?? b?.jobId ?? '';

export const planOf = (b: any): string => b?.plan ?? b?.service_plan ?? b?.tenant_plan ?? 'free';
