import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IS_DEMO_AUTH_MODE } from '../services/cognitoAuth.js';
import {
  LANGUAGE_OPTIONS,
  PREWARM_REASON_LABEL,
  PREWARM_WARNING_LABEL,
  VERIFICATION_FILE_NAME,
  WEBSITE_STATUS_LABEL,
  createHttpWebsiteApi,
  createMockWebsiteApi,
  isPrewarmActive,
  languageLabel,
  parseSelectors,
  translationUrl,
  validateCreateWebsite,
  verificationFileUrl,
  verificationMetaTag,
  websiteErrorMessage,
  type WebsiteApi,
} from '../services/websiteApi.js';
import type { AuthenticatedSession } from '../types/auth.js';
import type { CreateWebsiteInput, PrewarmJob, VerifyMethod, Website, WebsiteStatus } from '../types/website.js';

/**
 * Màn Website (Q2, Nhiệm vụ 4.6 – TV2): danh sách website, thêm website (bước 1), xác minh quyền sở hữu (bước 2),
 * đường dẫn bản dịch và dịch trước theo sitemap. Theo Hình 1.7 và 1.8 của báo cáo.
 */

const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
const PUBLIC_BASE_URL = env.VITE_PUBLIC_BASE_URL || 'https://<id>.cloudfront.net';
const PREWARM_POLL_MS = 3000;

/** Kho demo dùng chung trong phiên trình duyệt (giữ dữ liệu khi chuyển menu) */
let demoApi: ReturnType<typeof createMockWebsiteApi> | undefined;
function getDemoApi() {
  if (!demoApi) {
    demoApi = createMockWebsiteApi({ codeFor: () => 'ts-7f3a9c2e41' });
    demoApi.sites.set('homestay-abc', {
      slug: 'homestay-abc',
      displayName: 'Homestay ABC Hội An',
      homeUrl: 'https://homestay-abc.example/',
      sourceLang: 'vi',
      targetLangs: ['en', 'ko'],
      status: 'ACTIVE',
      verificationCode: 'ts-7f3a9c2e41',
      noTranslateSelectors: ['#booking-widget'],
      createdAt: '2026-10-20T08:00:00.000Z',
    });
  }
  return demoApi;
}

export function websiteApiFor(session: AuthenticatedSession): WebsiteApi {
  if (IS_DEMO_AUTH_MODE) return getDemoApi();
  return createHttpWebsiteApi({ baseUrl: env.VITE_API_BASE_URL ?? '', getToken: () => session.idToken });
}

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'detail'; slug: string };

const card = 'bg-white rounded-xl border border-gray-200 shadow-sm';
const btnPrimary =
  'px-4 py-2 rounded-lg bg-[#146c54] hover:bg-[#0f5945] text-white text-sm font-semibold transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed';
const btnSecondary = 'px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-semibold transition-colors';
const input =
  'w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20';

const STATUS_STYLE: Record<WebsiteStatus, string> = {
  PENDING: 'bg-gray-100 text-gray-600',
  ACTIVE: 'bg-[#e6f2ee] text-[#146c54]',
  PAUSED: 'bg-amber-50 text-amber-700',
};

const StatusBadge: React.FC<{ status: WebsiteStatus }> = ({ status }) => (
  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[status]}`}>{WEBSITE_STATUS_LABEL[status]}</span>
);

const StepChips: React.FC<{ step: 1 | 2 }> = ({ step }) => (
  <div className="flex flex-wrap gap-2 mb-5">
    {(['Bước 1/2: Thông tin website', 'Bước 2/2: Xác minh quyền sở hữu'] as const).map((label, i) => (
      <span
        key={label}
        className={`px-2.5 py-1 rounded-md text-xs font-semibold ${i + 1 === step ? 'bg-[#e6f2ee] text-[#146c54]' : 'bg-gray-100 text-gray-500'}`}
      >
        {label}
      </span>
    ))}
  </div>
);

const ErrorBox: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  ) : null;

// ----------------------------------------------------------------------------
// Danh sách
// ----------------------------------------------------------------------------

const WebsiteList: React.FC<{ api: WebsiteApi; onCreate: () => void; onOpen: (slug: string) => void }> = ({ api, onCreate, onOpen }) => {
  const [sites, setSites] = useState<Website[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listWebsites()
      .then((s) => alive && setSites(s))
      .catch((e) => alive && setError(websiteErrorMessage(e)));
    return () => {
      alive = false;
    };
  }, [api]);

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">Website</h1>
          <p className="mt-1 text-xs text-gray-500">Đưa website có sẵn vào TranslateMe và nhận đường dẫn bản dịch cho từng ngôn ngữ.</p>
        </div>
        <button type="button" className={btnPrimary} onClick={onCreate}>
          + Thêm website
        </button>
      </div>
      <ErrorBox message={error} />
      <div className={`${card} overflow-hidden`}>
        {sites === null && !error ? (
          <p className="px-6 py-8 text-sm text-gray-500">Đang tải…</p>
        ) : sites && sites.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-gray-600">Chưa có website nào.</p>
            <button type="button" className={`${btnPrimary} mt-4`} onClick={onCreate}>
              Thêm website đầu tiên
            </button>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-100 text-xs font-medium text-gray-400">
                <th className="py-3.5 px-6">Tên hiển thị</th>
                <th className="py-3.5 px-6">Trang chủ</th>
                <th className="py-3.5 px-6">Ngôn ngữ đích</th>
                <th className="py-3.5 px-6">Trạng thái</th>
                <th className="py-3.5 px-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-sm">
              {(sites ?? []).map((s) => (
                <tr key={s.slug} className="hover:bg-gray-50/70 transition-colors">
                  <td className="py-4 px-6 font-medium text-gray-800">{s.displayName}</td>
                  <td className="py-4 px-6 text-gray-600 break-all">{s.homeUrl}</td>
                  <td className="py-4 px-6 text-gray-600">{s.targetLangs.map(languageLabel).join(', ')}</td>
                  <td className="py-4 px-6">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="py-4 px-6 text-right">
                    <button type="button" className="text-sm font-semibold text-[#146c54] hover:underline" onClick={() => onOpen(s.slug)}>
                      {s.status === 'PENDING' ? 'Xác minh' : 'Xem'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Bước 1: Thêm website (Hình 1.7)
// ----------------------------------------------------------------------------

const CreateWebsite: React.FC<{ api: WebsiteApi; onCancel: () => void; onCreated: (slug: string) => void }> = ({ api, onCancel, onCreated }) => {
  const [homeUrl, setHomeUrl] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [sourceLang, setSourceLang] = useState('vi');
  const [targetLangs, setTargetLangs] = useState<string[]>(['en']);
  const [selectors, setSelectors] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form: CreateWebsiteInput = useMemo(
    () => ({ homeUrl, displayName, sourceLang, targetLangs: targetLangs.filter((l) => l !== sourceLang), noTranslateSelectors: parseSelectors(selectors) }),
    [homeUrl, displayName, sourceLang, targetLangs, selectors],
  );
  const errors = validateCreateWebsite(form);
  const show = (k: keyof CreateWebsiteInput) => (touched ? errors[k] : undefined);

  const toggleLang = (code: string) => setTargetLangs((cur) => (cur.includes(code) ? cur.filter((l) => l !== code) : [...cur, code]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setError(null);
    if (Object.keys(errors).length) return;
    setSubmitting(true);
    try {
      const site = await api.createWebsite(form);
      onCreated(site.slug);
    } catch (err) {
      setError(websiteErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const fieldError = (k: keyof CreateWebsiteInput) => (show(k) ? <p className="mt-1.5 text-xs text-red-600">{show(k)}</p> : null);

  return (
    <div className="p-8 max-w-5xl">
      <h1 className="text-2xl font-bold text-gray-800">Thêm website</h1>
      <p className="mt-1 mb-4 text-xs text-gray-500">
        <button type="button" className="hover:underline" onClick={onCancel}>
          Website
        </button>{' '}
        › Thêm website
      </p>
      <StepChips step={1} />
      <form onSubmit={submit} noValidate className={`${card} p-6 space-y-4`}>
        <ErrorBox message={error} />
        <div>
          <label htmlFor="ws-home" className="block text-xs font-semibold text-gray-700 mb-1.5">
            Địa chỉ trang chủ
          </label>
          <input id="ws-home" type="url" className={input} value={homeUrl} onChange={(e) => setHomeUrl(e.target.value)} placeholder="https://homestay-abc.example" />
          {show('homeUrl') ? fieldError('homeUrl') : <p className="mt-1.5 text-[11px] text-gray-400">Chỉ nhận http:// hoặc https:// với tên miền công khai</p>}
        </div>
        <div>
          <label htmlFor="ws-name" className="block text-xs font-semibold text-gray-700 mb-1.5">
            Tên hiển thị
          </label>
          <input id="ws-name" className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Homestay ABC Hội An" />
          {fieldError('displayName')}
        </div>
        <div>
          <label htmlFor="ws-src" className="block text-xs font-semibold text-gray-700 mb-1.5">
            Ngôn ngữ gốc
          </label>
          <select id="ws-src" className={`${input} bg-white`} value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
            {LANGUAGE_OPTIONS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label} ({l.code})
              </option>
            ))}
          </select>
        </div>
        <fieldset>
          <legend className="block text-xs font-semibold text-gray-700 mb-1.5">Ngôn ngữ đích</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-gray-300 px-3.5 py-2.5">
            {LANGUAGE_OPTIONS.filter((l) => l.code !== sourceLang).map((l) => (
              <label key={l.code} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                <input type="checkbox" className="h-4 w-4 accent-[#146c54]" checked={targetLangs.includes(l.code)} onChange={() => toggleLang(l.code)} />
                {l.label} ({l.code})
              </label>
            ))}
          </div>
          {fieldError('targetLangs')}
        </fieldset>
        <div>
          <label htmlFor="ws-sel" className="block text-xs font-semibold text-gray-700 mb-1.5">
            Vùng không dịch (tùy chọn)
          </label>
          <input id="ws-sel" className={input} value={selectors} onChange={(e) => setSelectors(e.target.value)} placeholder=".no-translate, #booking-widget" />
          {show('noTranslateSelectors') ? (
            fieldError('noTranslateSelectors')
          ) : (
            <p className="mt-1.5 text-[11px] text-gray-400">Bộ chọn CSS của các phần giữ nguyên ngôn ngữ gốc, ví dụ khung đặt phòng của bên thứ ba</p>
          )}
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className={btnSecondary} onClick={onCancel}>
            Hủy
          </button>
          <button type="submit" className={btnPrimary} disabled={submitting}>
            {submitting ? 'Đang tạo…' : 'Tiếp tục: Xác minh'}
          </button>
        </div>
      </form>
    </div>
  );
};

// ----------------------------------------------------------------------------
// Bước 2: Xác minh, đường dẫn bản dịch, dịch trước (Hình 1.8)
// ----------------------------------------------------------------------------

const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label = 'Sao chép' }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-xs font-semibold text-gray-700" onClick={copy}>
      {copied ? 'Đã chép' : label}
    </button>
  );
};

const VerificationCard: React.FC<{ api: WebsiteApi; site: Website; onVerified: (s: Website) => void }> = ({ api, site, onVerified }) => {
  const [method, setMethod] = useState<VerifyMethod>('META');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verified = site.status !== 'PENDING';

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      onVerified(await api.verifyWebsite(site.slug, method));
    } catch (err) {
      setError(websiteErrorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  const stage = verified ? 2 : checking ? 1 : 0;
  const chips = [
    ['CHỜ XÁC MINH', 'bg-gray-100 text-gray-600'],
    ['ĐANG KIỂM TRA', 'bg-amber-100 text-amber-700'],
    ['ĐÃ XÁC MINH', 'bg-[#e6f2ee] text-[#146c54]'],
  ] as const;

  return (
    <section className={`${card} p-6 mb-5`} aria-labelledby="verify-title">
      <h2 id="verify-title" className="text-base font-bold text-gray-800 mb-3">
        {verified ? 'Đã xác minh quyền sở hữu' : 'Chọn một trong hai cách, sau đó bấm Kiểm tra'}
      </h2>
      <ErrorBox message={error} />
      {!verified && (
        <div className="space-y-3">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="radio" name="verify-method" className="mt-1 accent-[#146c54]" checked={method === 'META'} onChange={() => setMethod('META')} />
            <span className="text-sm text-gray-700">Cách 1 – Thẻ meta: chèn vào phần &lt;head&gt; của trang chủ</span>
          </label>
          <div className="ml-6 flex items-center gap-2">
            <code className="flex-1 block rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-800 break-all">{verificationMetaTag(site.verificationCode)}</code>
            <CopyButton text={verificationMetaTag(site.verificationCode)} />
          </div>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input type="radio" name="verify-method" className="mt-1 accent-[#146c54]" checked={method === 'FILE'} onChange={() => setMethod('FILE')} />
            <span className="text-sm text-gray-700">
              Cách 2 – Tệp văn bản: tải lên thư mục gốc của website
              <span className="block text-[11px] text-gray-500 mt-0.5 break-all">
                Tên tệp: {VERIFICATION_FILE_NAME} · Nội dung: {site.verificationCode} · Địa chỉ phải mở được: {verificationFileUrl(site.homeUrl)}
              </span>
            </span>
          </label>
          <p className="ml-6 text-[11px] text-gray-500">Giữ nguyên thẻ meta hoặc tệp trong suốt thời gian sử dụng để có thể xác minh lại khi cần.</p>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-bold">
          {chips.map(([label, style], i) => (
            <React.Fragment key={label}>
              {i > 0 && <span className="text-gray-400">→</span>}
              <span className={`px-2 py-1 rounded-md ${i === stage ? style : 'bg-gray-50 text-gray-400'}`}>{label}</span>
            </React.Fragment>
          ))}
        </div>
        {!verified && (
          <button type="button" className={btnPrimary} onClick={check} disabled={checking}>
            {checking ? 'Đang kiểm tra…' : 'Kiểm tra'}
          </button>
        )}
      </div>
    </section>
  );
};

const PrewarmPanel: React.FC<{ api: WebsiteApi; site: Website }> = ({ api, site }) => {
  const [job, setJob] = useState<PrewarmJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = isPrewarmActive(job);

  useEffect(() => {
    let alive = true;
    api
      .getPrewarm(site.slug)
      .then((j) => alive && setJob(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, site.slug]);

  // Hỏi lại tiến độ khi đang chạy
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => {
      api
        .getPrewarm(site.slug)
        .then(setJob)
        .catch(() => {});
    }, PREWARM_POLL_MS);
    return () => window.clearInterval(t);
  }, [api, site.slug, active]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setJob((await api.startPrewarm(site.slug)).job);
    } catch (err) {
      setError(websiteErrorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const progress = job?.progress ?? 0;
  return (
    <div className="mt-5">
      <ErrorBox message={error} />
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" className={btnSecondary} onClick={start} disabled={starting || active || site.status !== 'ACTIVE'}>
          {active ? 'Đang dịch trước…' : 'Dịch trước toàn bộ website theo sitemap'}
        </button>
        <div
          className="flex-1 min-w-[160px] h-2 rounded-full bg-gray-200 overflow-hidden"
          role="progressbar"
          aria-label="Tiến độ dịch trước"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <div className="h-full bg-[#146c54] transition-all" style={{ width: `${progress}%` }} />
        </div>
        <span className="text-sm font-semibold text-gray-700 w-28 text-right">{job ? `${progress}% số trang` : 'Chưa chạy'}</span>
      </div>
      {job?.status === 'SUCCEEDED' && (
        <div className="mt-3 text-xs text-gray-600">
          <p className="text-[#146c54] font-semibold">
            Đã dịch trước {job.done}/{job.total} trang.
          </p>
          {job.warnings.length > 0 && (
            <ul className="mt-1 list-disc pl-5 space-y-0.5">
              {job.warnings.map((w) => (
                <li key={w.code}>
                  {PREWARM_WARNING_LABEL[w.code] ?? w.message} ({w.count})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {job?.status === 'FAILED' && (
        <p className="mt-3 text-xs text-red-600">Dịch trước thất bại: {(job.reason && PREWARM_REASON_LABEL[job.reason]) || 'lỗi tạm thời, vui lòng thử lại.'}</p>
      )}
    </div>
  );
};

const WebsiteDetail: React.FC<{ api: WebsiteApi; slug: string; onBack: () => void }> = ({ api, slug, onBack }) => {
  const [site, setSite] = useState<Website | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getWebsite(slug)
      .then(setSite)
      .catch((e) => setError(websiteErrorMessage(e)));
  }, [api, slug]);
  useEffect(load, [load]);

  if (!site) {
    return (
      <div className="p-8 max-w-6xl">
        <ErrorBox message={error} />
        {!error && <p className="text-sm text-gray-500">Đang tải…</p>}
        <button type="button" className={btnSecondary} onClick={onBack}>
          Quay lại danh sách
        </button>
      </div>
    );
  }

  const verified = site.status !== 'PENDING';
  const firstLang = site.targetLangs[0];
  return (
    <div className="p-8 max-w-6xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">{site.displayName}</h1>
          <p className="mt-1 mb-4 text-xs text-gray-500">
            <button type="button" className="hover:underline" onClick={onBack}>
              Website
            </button>{' '}
            › {site.displayName}
          </p>
        </div>
        <StatusBadge status={site.status} />
      </div>
      <StepChips step={2} />
      <VerificationCard api={api} site={site} onVerified={setSite} />

      <section className={`${card} p-6`} aria-labelledby="urls-title">
        <h2 id="urls-title" className="text-base font-bold text-gray-800 mb-3">
          Đường dẫn bản dịch <span className="text-xs font-normal text-gray-500">(hiển thị sau khi xác minh thành công)</span>
        </h2>
        {!verified ? (
          <p className="text-sm text-gray-500">Xác minh quyền sở hữu ở trên để nhận đường dẫn bản dịch cho từng ngôn ngữ.</p>
        ) : (
          <>
            {site.status === 'PAUSED' && (
              <p className="mb-3 text-xs text-amber-700">Website đang tạm dừng: khách truy cập đường dẫn bản dịch được chuyển về website gốc.</p>
            )}
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 text-xs font-medium text-gray-500">
                  <th className="py-2.5 px-3">Ngôn ngữ</th>
                  <th className="py-2.5 px-3">Đường dẫn</th>
                  <th className="py-2.5 px-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 text-sm">
                {site.targetLangs.map((lang) => {
                  const url = translationUrl(PUBLIC_BASE_URL, site.slug, lang);
                  return (
                    <tr key={lang}>
                      <td className="py-3 px-3 text-gray-700">{languageLabel(lang)}</td>
                      <td className="py-3 px-3">
                        <code className="text-xs text-gray-800 break-all">{url}</code>
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap space-x-2">
                        <CopyButton text={url} />
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-xs font-semibold text-gray-700"
                        >
                          Mở
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <PrewarmPanel api={api} site={site} />
            {firstLang && (
              <p className="mt-4 text-[11px] text-gray-500">
                Gợi ý: thêm liên kết "{languageLabel(firstLang)}" vào menu website gốc, trỏ tới /{firstLang}/.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
};

// ----------------------------------------------------------------------------

export const WebsitePage: React.FC<{ session: AuthenticatedSession; api?: WebsiteApi }> = ({ session, api: injected }) => {
  const api = useMemo(() => injected ?? websiteApiFor(session), [injected, session]);
  const [view, setView] = useState<View>({ kind: 'list' });

  if (view.kind === 'create') {
    return <CreateWebsite api={api} onCancel={() => setView({ kind: 'list' })} onCreated={(slug) => setView({ kind: 'detail', slug })} />;
  }
  if (view.kind === 'detail') {
    return <WebsiteDetail key={view.slug} api={api} slug={view.slug} onBack={() => setView({ kind: 'list' })} />;
  }
  return <WebsiteList api={api} onCreate={() => setView({ kind: 'create' })} onOpen={(slug) => setView({ kind: 'detail', slug })} />;
};
