import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IS_DEMO_AUTH_MODE } from '../services/cognitoAuth.js';
import {
  SUPPORTED_GLOSSARY_LANGS,
  TERM_TYPE_LABELS,
  buildSampleGlossaryCsv,
  buildUpsertGlossaryInput,
  createHttpGlossaryApi,
  createMockGlossaryApi,
  decodeCsvUtf8Bytes,
  getEditableGlossaryTargetLangs,
  getGlossaryTableLangs,
  glossaryErrorMessage,
  glossaryLangLabel,
  initGlossaryFormTranslations,
  validateUpsertTermInput,
  type GlossaryApi,
} from '../services/glossaryApi.js';
import { canConsoleRequest } from '../services/tenantPolicy.js';
import type { AuthenticatedSession } from '../types/auth.js';
import type {
  CsvImportPreviewOrCommitResult,
  DuplicateHandlingMode,
  GlossaryCacheInvalidation,
  GlossaryCacheInvalidationProgress,
  GlossaryTermEntry,
  GlossaryTermType,
} from '../types/glossary.js';

interface GlossaryPageProps {
  session: AuthenticatedSession;
}

const sharedMockGlossaryApi = createMockGlossaryApi();

function glossaryApiFor(session: AuthenticatedSession): GlossaryApi {
  if (IS_DEMO_AUTH_MODE) {
    return sharedMockGlossaryApi;
  }
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const baseUrl = viteEnv?.VITE_API_BASE_URL || 'http://localhost:3000';
  return createHttpGlossaryApi({
    baseUrl,
    getToken: () => session.idToken,
  });
}

const DEMO_FAULTY_CSV = [
  'vi,en,ko',
  'Homestay ABC,Homestay ABC,Homestay ABC',
  'mì Quảng,Quang noodles,꽝남 쌀국수',
  'đèn lồng Hội An,Hoi An lantern,',
  'mì Quảng,Quang style noodles,꽝 국수',
  ',Empty source,빈 원본',
].join('\n');

export const GlossaryPage: React.FC<GlossaryPageProps> = ({ session }) => {
  const api = useMemo(() => glossaryApiFor(session), [session]);
  const isTenantAdmin = session.role === 'TENANT_ADMIN';
  // Tenant LOCKED: chặn thao tác ghi ngay trên giao diện (cùng chính sách với tenantPolicy phía máy chủ)
  const tenantLocked = !canConsoleRequest({
    method: 'PUT',
    path: '/console/glossary/terms',
    tenantStatus: session.tenantStatus ?? 'ACTIVE',
  });
  const canWrite = isTenantAdmin && !tenantLocked;

  const [version, setVersion] = useState<number>(0);
  const [terminologyName, setTerminologyName] = useState<string | undefined>(undefined);
  const [terms, setTerms] = useState<GlossaryTermEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const [typeFilter, setTypeFilter] = useState<'ALL' | GlossaryTermType>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [cacheInvalidation, setCacheInvalidation] = useState<GlossaryCacheInvalidation | null>(null);
  const [retryingCacheInvalidation, setRetryingCacheInvalidation] = useState(false);
  const [invalidationProgress, setInvalidationProgress] = useState<Record<string, GlossaryCacheInvalidationProgress['status']>>({});
  const invalidationIdKey = cacheInvalidation?.invalidationIds.join(',') ?? '';

  useEffect(() => {
    const ids = invalidationIdKey ? invalidationIdKey.split(',').filter(Boolean) : [];
    if (ids.length === 0) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setInvalidationProgress({});
    const poll = async () => {
      const results = await Promise.all(ids.map(async (id) => {
        try {
          return await api.getCacheInvalidationStatus(id);
        } catch {
          return null;
        }
      }));
      if (!active) return;
      const next: Record<string, GlossaryCacheInvalidationProgress['status']> = {};
      for (const result of results) if (result) next[result.id] = result.status;
      setInvalidationProgress(next);
      if (ids.some((id) => next[id] !== 'COMPLETED')) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, invalidationIdKey]);

  // Trạng thái khung Thêm / Sửa thuật ngữ
  const [showTermForm, setShowTermForm] = useState<boolean>(false);
  const [editingNormalizedTerm, setEditingNormalizedTerm] = useState<string | null>(null);
  const [editingBaseTranslations, setEditingBaseTranslations] = useState<Record<string, string>>({});
  const [extraFormLangs, setExtraFormLangs] = useState<string[]>([]);
  const [formSourceTerm, setFormSourceTerm] = useState<string>('');
  const [formSourceLang, setFormSourceLang] = useState<string>('vi');
  const [formType, setFormType] = useState<GlossaryTermType>('FIXED');
  const [formTranslations, setFormTranslations] = useState<Record<string, string>>(() =>
    initGlossaryFormTranslations(null, 'vi'),
  );
  const [savingTerm, setSavingTerm] = useState<boolean>(false);

  const editableTargetLangs = useMemo(
    () => getEditableGlossaryTargetLangs(formSourceLang, editingBaseTranslations, extraFormLangs),
    [formSourceLang, editingBaseTranslations, extraFormLangs],
  );

  const remainingAddableLangs = useMemo(
    () =>
      SUPPORTED_GLOSSARY_LANGS.filter(
        (l) => l.code !== formSourceLang && !editableTargetLangs.includes(l.code),
      ),
    [formSourceLang, editableTargetLangs],
  );

  const tableTargetLangs = useMemo(() => getGlossaryTableLangs(terms), [terms]);

  // Trạng thái khung Nhập CSV (Bước 3 & 4 của Q3)
  const [showCsvModal, setShowCsvModal] = useState<boolean>(false);
  const [csvText, setCsvText] = useState<string>(() => buildSampleGlossaryCsv());
  const [csvFileName, setCsvFileName] = useState<string>('mau-thuat-ngu.csv');
  const [onDuplicate, setOnDuplicate] = useState<DuplicateHandlingMode>('OVERWRITE');
  const [csvPreview, setCsvPreview] = useState<CsvImportPreviewOrCommitResult | null>(null);
  const [csvBusy, setCsvBusy] = useState<boolean>(false);

  const loadGlossary = useCallback(async () => {
    setLoading(true);
    try {
      const state = await api.listGlossary();
      setVersion(state.version);
      setTerminologyName(state.terminologyName);
      setTerms(state.terms);
    } catch (err) {
      setErrorMessage(glossaryErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadGlossary();
  }, [loadGlossary]);

  const filteredTerms = useMemo(() => {
    return terms.filter((t) => {
      if (typeFilter !== 'ALL' && t.type !== typeFilter) return false;
      if (searchQuery.trim()) {
        const kw = searchQuery.trim().normalize('NFC').toLowerCase();
        const inSource = t.sourceTerm.normalize('NFC').toLowerCase().includes(kw);
        const inTargets = Object.values(t.translations).some((v) =>
          v.normalize('NFC').toLowerCase().includes(kw),
        );
        if (!inSource && !inTargets) return false;
      }
      return true;
    });
  }, [terms, typeFilter, searchQuery]);

  const handleOpenAddForm = () => {
    setEditingNormalizedTerm(null);
    setEditingBaseTranslations({});
    setExtraFormLangs([]);
    setFormSourceTerm('');
    setFormSourceLang('vi');
    setFormType('FIXED');
    setFormTranslations(initGlossaryFormTranslations(null, 'vi'));
    setErrorMessage(null);
    setSuccessMessage(null);
    setShowTermForm(true);
  };

  const handleOpenEditForm = (entry: GlossaryTermEntry) => {
    setEditingNormalizedTerm(entry.normalizedTerm);
    setEditingBaseTranslations({ ...entry.translations });
    setExtraFormLangs([]);
    setFormSourceTerm(entry.sourceTerm);
    setFormSourceLang(entry.sourceLang);
    setFormType(entry.type);
    setFormTranslations(initGlossaryFormTranslations(entry));
    setErrorMessage(null);
    setSuccessMessage(null);
    setShowTermForm(true);
  };

  const handleSaveTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setErrorMessage(null);
    setSuccessMessage(null);

    const payload = buildUpsertGlossaryInput({
      sourceTerm: formSourceTerm,
      sourceLang: formSourceLang,
      type: formType,
      formTranslations,
      targetLangs: editableTargetLangs,
    });

    const clientErr = validateUpsertTermInput(payload);
    if (clientErr) {
      setErrorMessage(clientErr);
      return;
    }

    setSavingTerm(true);
    try {
      const res = await api.upsertTerm(payload);
      setCacheInvalidation(res.cacheInvalidation ?? null);
      await loadGlossary();
      setShowTermForm(false);
      setSuccessMessage(
        `Đã lưu thuật ngữ "${res.term.sourceTerm}" (${TERM_TYPE_LABELS[res.term.type]}). Phiên bản bảng thuật ngữ hiện tại: v${res.version}.`,
      );
    } catch (err) {
      setErrorMessage(glossaryErrorMessage(err));
    } finally {
      setSavingTerm(false);
    }
  };

  const handleDeleteTerm = async (entry: GlossaryTermEntry) => {
    if (!canWrite) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await api.deleteTerm(entry.sourceTerm);
      setCacheInvalidation(res.cacheInvalidation ?? null);
      await loadGlossary();
      setSuccessMessage(
        `Đã xóa thuật ngữ "${entry.sourceTerm}". Phiên bản bảng thuật ngữ hiện tại: v${res.version}.`,
      );
    } catch (err) {
      setErrorMessage(glossaryErrorMessage(err));
    }
  };

  const handleDownloadSampleCsv = () => {
    const content = '\uFEFF' + buildSampleGlossaryCsv();
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'thuat-ngu-mau-translateme.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCsvFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage(null);
    setCsvPreview(null);
    setCsvFileName(file.name);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const decoded = decodeCsvUtf8Bytes(buf);
      setCsvText(decoded);
    } catch (err) {
      setErrorMessage(glossaryErrorMessage(err));
    }
  };

  const handlePreviewCsv = async () => {
    if (!canWrite) return;
    setCsvBusy(true);
    setErrorMessage(null);
    try {
      const preview = await api.previewImportCsv(csvText, onDuplicate);
      setCsvPreview(preview);
    } catch (err) {
      setCsvPreview(null);
      setErrorMessage(glossaryErrorMessage(err));
    } finally {
      setCsvBusy(false);
    }
  };

  const handleCommitCsv = async () => {
    if (!canWrite) return;
    setCsvBusy(true);
    setErrorMessage(null);
    try {
      const res = await api.commitImportCsv(csvText, onDuplicate);
      setCacheInvalidation(res.cacheInvalidation ?? null);
      await loadGlossary();
      setShowCsvModal(false);
      setCsvPreview(null);
      setSuccessMessage(
        `Đã nhập CSV thành công (${res.addedCount} thêm mới, ${res.overwrittenCount} ghi đè, ${res.skippedCount} giữ nguyên). Phiên bản hiện tại: v${res.version}.`,
      );
    } catch (err) {
      setErrorMessage(glossaryErrorMessage(err));
    } finally {
      setCsvBusy(false);
    }
  };

  const handleRetryCacheInvalidation = async () => {
    setRetryingCacheInvalidation(true);
    try {
      setCacheInvalidation(await api.retryCacheInvalidation(cacheInvalidation?.failedPaths ?? []));
    } catch (err) {
      setCacheInvalidation({
        status: 'FAILED', mode: 'WILDCARD', paths: [], invalidationIds: [],
        failedPaths: [], error: glossaryErrorMessage(err),
      });
    } finally {
      setRetryingCacheInvalidation(false);
    }
  };

  const allInvalidationsCompleted = Boolean(cacheInvalidation?.invalidationIds.length) &&
    cacheInvalidation!.invalidationIds.every((id) => invalidationProgress[id] === 'COMPLETED');
  const cacheInvalidationMessage = cacheInvalidation?.status === 'SUBMITTED'
    ? (allInvalidationsCompleted ? 'Đã làm mới cache.' : 'Đang làm mới cache.')
    : cacheInvalidation?.status === 'NOT_CONFIGURED'
      ? 'Chưa cấu hình làm mới cache.'
      : cacheInvalidation?.status === 'PARTIAL'
        ? 'Chỉ một phần cache được gửi làm mới.'
        : 'Làm mới cache thất bại.';

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Đầu trang & Số phiên bản bảng thuật ngữ (Mục 1.3.3 bước 5) */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold text-gray-900">Bảng thuật ngữ (Q3)</h2>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#d7eae3] text-[#146c54]">
              Phiên bản v{version}
            </span>
            {terminologyName && (
              <span className="hidden md:inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-gray-100 text-gray-600">
                AWS Terminology: {terminologyName}
              </span>
            )}
          </div>
          <p className="text-sm text-gray-600 mt-1">
            Bảo đảm tên thương hiệu (Giữ nguyên) và thuật ngữ chuyên ngành (Dịch cố định) được dịch nhất quán trên mọi website và API của tổ chức.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleDownloadSampleCsv}
            className="px-3.5 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-xs font-semibold hover:bg-gray-50"
          >
            Tải tệp mẫu (.csv)
          </button>

          {canWrite ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setErrorMessage(null);
                  setSuccessMessage(null);
                  setCsvPreview(null);
                  setShowCsvModal(true);
                }}
                className="px-3.5 py-2 rounded-lg bg-white border border-[#146c54] text-[#146c54] text-xs font-semibold hover:bg-[#e6f2ee]"
              >
                Nhập CSV UTF-8
              </button>
              <button
                type="button"
                onClick={handleOpenAddForm}
                className="px-4 py-2 rounded-lg bg-[#146c54] text-white text-xs font-semibold hover:bg-[#0f5945]"
              >
                + Thêm thuật ngữ
              </button>
            </>
          ) : (
            <span className="px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs font-medium">
              {tenantLocked ? 'Tài khoản đang bị tạm khóa – chỉ xem' : `Chế độ chỉ xem (${session.role})`}
            </span>
          )}
        </div>
      </div>

      {/* Thông báo lỗi / thành công */}
      {errorMessage && (
        <div
          role="alert"
          className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800"
        >
          <strong className="font-semibold">Lỗi: </strong>
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
          {successMessage}
        </div>
      )}

      {cacheInvalidation && cacheInvalidation.status !== 'NOTHING_TO_DO' && (
        <div
          role={cacheInvalidation.status === 'FAILED' || cacheInvalidation.status === 'PARTIAL' ? 'alert' : 'status'}
          className={`p-3.5 rounded-xl border text-xs ${
            cacheInvalidation.status === 'FAILED' || cacheInvalidation.status === 'PARTIAL'
              ? 'bg-red-50 border-red-200 text-red-800'
              : cacheInvalidation.status === 'NOT_CONFIGURED'
                ? 'bg-amber-50 border-amber-200 text-amber-800'
                : 'bg-blue-50 border-blue-200 text-blue-800'
          }`}
        >
          <strong>{cacheInvalidationMessage}</strong>
          {cacheInvalidation.invalidationIds.length > 0 && (
            <span> Mã theo dõi: {cacheInvalidation.invalidationIds.join(', ')}.</span>
          )}
          {cacheInvalidation.error && <span> {cacheInvalidation.error}</span>}
          {(cacheInvalidation.status === 'FAILED' || cacheInvalidation.status === 'PARTIAL') && canWrite && (
            <button
              type="button"
              disabled={retryingCacheInvalidation}
              onClick={() => void handleRetryCacheInvalidation()}
              className="ml-2 underline font-semibold disabled:opacity-50"
            >
              {retryingCacheInvalidation ? 'Đang thử lại...' : 'Thử làm mới lại'}
            </button>
          )}
        </div>
      )}

      {/* Khung Thêm / Sửa thuật ngữ đơn lẻ (Bước 2 của Q3) */}
      {showTermForm && canWrite && (
        <form
          onSubmit={handleSaveTerm}
          className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4"
        >
          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <h3 className="text-base font-semibold text-gray-900">
              {editingNormalizedTerm ? 'Chỉnh sửa mục thuật ngữ' : 'Thêm mục thuật ngữ mới'}
            </h3>
            <button
              type="button"
              onClick={() => setShowTermForm(false)}
              className="text-xs text-gray-500 hover:text-gray-800"
            >
              Đóng
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Ngôn ngữ nguồn
              </label>
              <select
                value={formSourceLang}
                onChange={(e) => setFormSourceLang(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                {SUPPORTED_GLOSSARY_LANGS.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Từ nguồn <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formSourceTerm}
                onChange={(e) => setFormSourceTerm(e.target.value)}
                placeholder="Ví dụ: Homestay ABC hoặc phố cổ Hội An"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Loại thuật ngữ
              </label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value as GlossaryTermType)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="FIXED">Dịch cố định (nhập bản dịch từng ngôn ngữ)</option>
                <option value="KEEP">Giữ nguyên (tự điền bằng chính từ nguồn)</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-gray-700">
                Bản dịch theo ngôn ngữ đích{' '}
                {formType === 'KEEP' && (
                  <span className="font-normal text-[#146c54]">
                    (Loại "Giữ nguyên" tự động lấy nguyên vẹn từ nguồn cho mọi ngôn ngữ đích)
                  </span>
                )}
              </div>
              {remainingAddableLangs.length > 0 && (
                <select
                  aria-label="Thêm ngôn ngữ đích"
                  value=""
                  onChange={(e) => {
                    const code = e.target.value;
                    if (!code) return;
                    setExtraFormLangs((prev) => (prev.includes(code) ? prev : [...prev, code]));
                    setFormTranslations((prev) => ({ ...prev, [code]: prev[code] ?? '' }));
                  }}
                  className="rounded-lg border border-gray-300 px-2.5 py-1 text-xs text-gray-700 bg-white"
                >
                  <option value="">+ Thêm ngôn ngữ khác...</option>
                  {remainingAddableLangs.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {editableTargetLangs.map((lang) => (
                <div key={lang}>
                  <label className="block text-xs text-gray-600 mb-1">
                    Đích: <strong>{glossaryLangLabel(lang)}</strong>
                  </label>
                  <input
                    type="text"
                    disabled={formType === 'KEEP'}
                    value={
                      formType === 'KEEP'
                        ? formSourceTerm
                        : (formTranslations[lang] ?? '')
                    }
                    onChange={(e) =>
                      setFormTranslations((prev) => ({
                        ...prev,
                        [lang]: e.target.value,
                      }))
                    }
                    placeholder={`Bản dịch (${lang})...`}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100 disabled:text-gray-600"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowTermForm(false)}
              className="px-3.5 py-2 rounded-lg border border-gray-300 text-gray-700 text-xs font-semibold hover:bg-gray-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={savingTerm}
              className="px-4 py-2 rounded-lg bg-[#146c54] text-white text-xs font-semibold hover:bg-[#0f5945] disabled:opacity-50"
            >
              {savingTerm ? 'Đang lưu...' : 'Lưu thuật ngữ'}
            </button>
          </div>
        </form>
      )}

      {/* Khung Nhập CSV UTF-8 & Xem trước (Bước 3 & 4 của Q3 — Hình 1.9) */}
      {showCsvModal && canWrite && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900">
                Nhập bảng thuật ngữ hàng loạt từ tệp CSV (UTF-8)
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                Dòng đầu tiên là các mã ngôn ngữ (ví dụ: <code>vi,en,ko</code>), cột đầu tiên là ngôn ngữ nguồn. Mục có bản dịch trùng từ nguồn sẽ tự nhận diện là "Giữ nguyên".
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowCsvModal(false)}
              className="text-xs text-gray-500 hover:text-gray-800"
            >
              Đóng
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Chọn tệp CSV từ máy tính (mã hóa UTF-8)
              </label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void handleCsvFileChange(e)}
                className="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-[#e6f2ee] file:text-[#146c54] hover:file:bg-[#d7eae3]"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Đang chọn: <code>{csvFileName}</code>
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Cách xử lý khi trùng với thuật ngữ đã có
              </label>
              <select
                value={onDuplicate}
                onChange={(e) => {
                  setOnDuplicate(e.target.value as DuplicateHandlingMode);
                  setCsvPreview(null);
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="OVERWRITE">Ghi đè mục hiện có (OVERWRITE)</option>
                <option value="KEEP_EXISTING">Giữ mục hiện có, bỏ qua dòng trùng (KEEP_EXISTING)</option>
              </select>
            </div>
          </div>

          {/* Nội dung CSV & nút nạp mẫu nhanh cho chế độ Demo */}
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="block text-xs font-semibold text-gray-700">
                Nội dung CSV (UTF-8)
              </label>
              {IS_DEMO_AUTH_MODE && (
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setCsvText(buildSampleGlossaryCsv());
                      setCsvFileName('mau-hop-le.csv');
                      setCsvPreview(null);
                    }}
                    className="px-2.5 py-1 rounded border border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700"
                  >
                    Nạp CSV mẫu chuẩn (Mục 1.3.3)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCsvText(DEMO_FAULTY_CSV);
                      setCsvFileName('mau-co-loi-va-trung.csv');
                      setCsvPreview(null);
                    }}
                    className="px-2.5 py-1 rounded border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-800"
                  >
                    Nạp CSV mẫu có lỗi & trùng lặp
                  </button>
                </div>
              )}
            </div>
            <textarea
              rows={5}
              value={csvText}
              onChange={(e) => {
                setCsvText(e.target.value);
                setCsvPreview(null);
              }}
              className="w-full rounded-lg border border-gray-300 p-3 font-mono text-xs leading-relaxed focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Kết quả bản xem trước (Bước 4 của Q3) */}
          {csvPreview && (
            <div className="p-4 rounded-xl bg-gray-50 border border-gray-200 space-y-3 text-xs">
              <div className="font-semibold text-gray-900">
                Kết quả xem trước trước khi nhập:
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-white p-2.5 rounded-lg border border-gray-200">
                  <div className="text-gray-500">Dòng hợp lệ</div>
                  <div className="text-base font-bold text-emerald-700">{csvPreview.validRows}</div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-gray-200">
                  <div className="text-gray-500">Thêm mới</div>
                  <div className="text-base font-bold text-blue-700">{csvPreview.addedCount}</div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-gray-200">
                  <div className="text-gray-500">
                    Trùng lặp ({onDuplicate === 'OVERWRITE' ? 'Ghi đè' : 'Giữ nguyên'})
                  </div>
                  <div className="text-base font-bold text-amber-700">
                    {onDuplicate === 'OVERWRITE' ? csvPreview.overwrittenCount : csvPreview.skippedCount}
                  </div>
                </div>
                <div className="bg-white p-2.5 rounded-lg border border-gray-200">
                  <div className="text-gray-500">Dòng lỗi</div>
                  <div className="text-base font-bold text-red-700">{csvPreview.errors.length}</div>
                </div>
              </div>

              {csvPreview.duplicates.length > 0 && (
                <div className="text-amber-800 bg-amber-50 border border-amber-200 p-2.5 rounded-lg">
                  <strong>Từ nguồn trùng với bảng hiện có:</strong>{' '}
                  {csvPreview.duplicates.map((d) => `"${d.term}"`).join(', ')}.
                </div>
              )}

              {csvPreview.errors.length > 0 && (
                <div className="space-y-1 bg-red-50 border border-red-200 p-2.5 rounded-lg text-red-800">
                  <div className="font-semibold">Danh sách dòng lỗi (bị bỏ qua khi nhập):</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {csvPreview.errors.map((err, idx) => (
                      <li key={idx}>
                        <strong>Dòng {err.row}:</strong> {err.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={csvBusy}
              onClick={() => void handlePreviewCsv()}
              className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-800 text-xs font-semibold hover:bg-gray-50"
            >
              Xem trước kết quả
            </button>
            <button
              type="button"
              disabled={csvBusy || (csvPreview !== null && csvPreview.validRows === 0)}
              onClick={() => void handleCommitCsv()}
              className="px-4 py-2 rounded-lg bg-[#146c54] text-white text-xs font-semibold hover:bg-[#0f5945] disabled:opacity-50"
            >
              Nhập vào bảng thuật ngữ
            </button>
          </div>
        </div>
      )}

      {/* Thanh tìm kiếm & lọc danh sách thuật ngữ */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-700">Loại mục:</span>
          {(['ALL', 'KEEP', 'FIXED'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTypeFilter(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                typeFilter === k
                  ? 'bg-[#146c54] text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {k === 'ALL' ? `Tất cả (${terms.length})` : TERM_TYPE_LABELS[k]}
            </button>
          ))}
        </div>

        <div className="sm:w-72">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm từ nguồn hoặc bản dịch..."
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Bảng danh sách thuật ngữ */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Đang tải bảng thuật ngữ...</div>
        ) : filteredTerms.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            Chưa có mục thuật ngữ nào khớp với bộ lọc hiện tại.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wider">
                  <th className="py-3 px-4">Từ nguồn</th>
                  <th className="py-3 px-4">Loại</th>
                  {tableTargetLangs.map((lang) => (
                    <th key={lang} className="py-3 px-4">
                      {glossaryLangLabel(lang)}
                    </th>
                  ))}
                  <th className="py-3 px-4">Phiên bản</th>
                  {canWrite && <th className="py-3 px-4 text-right">Thao tác</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 text-sm">
                {filteredTerms.map((entry) => (
                  <tr key={entry.normalizedTerm} className="hover:bg-gray-50">
                    <td className="py-3 px-4 font-semibold text-gray-900">
                      {entry.sourceTerm}
                      <span className="ml-1.5 text-xs font-normal text-gray-400">
                        ({entry.sourceLang})
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {entry.type === 'KEEP' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
                          Giữ nguyên
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                          Dịch cố định
                        </span>
                      )}
                    </td>
                    {tableTargetLangs.map((lang) => (
                      <td key={lang} className="py-3 px-4 text-gray-700">
                        {entry.translations[lang] ?? '—'}
                      </td>
                    ))}
                    <td className="py-3 px-4 text-xs font-mono text-gray-500">
                      v{entry.updatedInVersion}
                    </td>
                    {canWrite && (
                      <td className="py-3 px-4 text-right space-x-2">
                        <button
                          type="button"
                          onClick={() => handleOpenEditForm(entry)}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-800"
                        >
                          Sửa
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteTerm(entry)}
                          className="text-xs font-semibold text-red-600 hover:text-red-800"
                        >
                          Xóa
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
