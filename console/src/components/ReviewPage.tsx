import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { IS_DEMO_AUTH_MODE } from '../services/cognitoAuth.js';
import {
  DEMO_REVIEW_SITES,
  LANGUAGE_LABELS,
  REVIEW_FILTER_LABELS,
  ReviewApiError,
  createHttpReviewApi,
  createMockReviewApi,
  reviewErrorMessage,
  MAX_INVALIDATION_POLL_ATTEMPTS,
  checkMultipleInvalidationsStatus,
  extractInvalidationIds,
  getInvalidationPollIntervalMs,
  validatePlaceholders,
  type MockReviewApi,
  type ReviewApi,
  type ReviewSiteOption,
} from '../services/reviewApi.js';
import type { AuthenticatedSession } from '../types/auth.js';
import type {
  CacheRefreshState,
  InvalidationOutcome,
  ReviewLabelFilter,
  ReviewSentenceItem,
} from '../types/review.js';

interface ReviewPageProps {
  session: AuthenticatedSession;
  api?: ReviewApi;
  isDemoMode?: boolean;
}

const DEFAULT_TARGET_LANGS = ['en', 'ko', 'ja', 'zh', 'fr'] as const;

const sharedMockApi = createMockReviewApi({ reviewerEmail: 'minh@homestay-abc.vn' });

function reviewApiFor(
  session: AuthenticatedSession,
  demoMode: boolean,
  injectedApi?: ReviewApi,
): { api: ReviewApi; mock?: MockReviewApi } {
  if (injectedApi) {
    return { api: injectedApi };
  }
  if (demoMode) {
    return { api: sharedMockApi, mock: sharedMockApi };
  }
  const viteEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const baseUrl = viteEnv?.VITE_API_BASE_URL || 'http://localhost:3000';
  return {
    api: createHttpReviewApi({
      baseUrl,
      getToken: () => session.idToken,
    }),
  };
}

/** Hiển thị văn bản có tô nổi bật các ký hiệu {1}, {/1}, {1/} thành huy hiệu trực quan */
const HighlightedMarkersText: React.FC<{ text: string }> = ({ text }) => {
  const parts = text.split(/(\{\/?\d+\/?\})/g);
  return (
    <span>
      {parts.map((part, idx) =>
        /^\{\/?\d+\/?\}$/.test(part) ? (
          <code
            key={idx}
            className="mx-0.5 px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono text-xs font-semibold border border-indigo-200"
          >
            {part}
          </code>
        ) : (
          <React.Fragment key={idx}>{part}</React.Fragment>
        ),
      )}
    </span>
  );
};

interface ItemCacheRefreshStatus {
  state: CacheRefreshState;
  outcome?: InvalidationOutcome;
}

export const ReviewPage: React.FC<ReviewPageProps> = ({
  session,
  api: injectedApi,
  isDemoMode,
}) => {
  const demoMode = isDemoMode ?? IS_DEMO_AUTH_MODE;
  const { api, mock } = useMemo(
    () => reviewApiFor(session, demoMode, injectedApi),
    [session, demoMode, injectedApi],
  );
  const canEdit = session.role === 'TENANT_ADMIN' || session.role === 'REVIEWER';

  const [sites, setSites] = useState<ReviewSiteOption[]>(() =>
    demoMode ? [...DEMO_REVIEW_SITES] : [],
  );
  const [selectedSiteSlug, setSelectedSiteSlug] = useState<string>(() =>
    demoMode ? DEMO_REVIEW_SITES[0].slug : '',
  );

  useEffect(() => {
    if (demoMode) {
      setSites([...DEMO_REVIEW_SITES]);
      setSelectedSiteSlug((prev) => prev || DEMO_REVIEW_SITES[0].slug);
      return;
    }
    // Ở chế độ API thật (Cognito), backend F5 duyệt trực tiếp Translation Memory của tenant theo cặp ngôn ngữ.
    // Bộ lọc website và trang được giới hạn ở chế độ demo cho đến khi dịch vụ C6/SEG sẵn sàng.
    setSites([]);
    setSelectedSiteSlug('');
  }, [demoMode]);

  const currentSite = useMemo<ReviewSiteOption | null>(
    () => (demoMode ? sites.find((s) => s.slug === selectedSiteSlug) ?? sites[0] ?? null : null),
    [demoMode, sites, selectedSiteSlug],
  );

  const sourceLang = currentSite?.sourceLang ?? 'vi';
  const targetLangOptions = useMemo<readonly string[]>(
    () =>
      demoMode && currentSite && currentSite.targetLangs.length > 0
        ? currentSite.targetLangs
        : DEFAULT_TARGET_LANGS,
    [demoMode, currentSite],
  );

  const [targetLang, setTargetLang] = useState<string>(() => targetLangOptions[0] ?? 'en');
  useEffect(() => {
    if (!targetLangOptions.includes(targetLang)) {
      setTargetLang(targetLangOptions[0] ?? 'en');
    }
  }, [targetLangOptions, targetLang]);

  const [pageFilter, setPageFilter] = useState<string>('');
  const [labelFilter, setLabelFilter] = useState<ReviewLabelFilter>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [items, setItems] = useState<ReviewSentenceItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [conflictLatest, setConflictLatest] = useState<ReviewSentenceItem | null>(null);
  const [cacheStatusByHash, setCacheStatusByHash] = useState<Record<string, ItemCacheRefreshStatus>>({});
  const [simulateCdnFail, setSimulateCdnFail] = useState<boolean>(
    () => mock?.getSimulateCdnFailure() ?? false,
  );

  const hasAnyPageMetadata = useMemo(
    () =>
      demoMode &&
      (Boolean(currentSite && currentSite.pages.length > 0) ||
        items.some((it) => it.hasPageMetadata === true)),
    [demoMode, currentSite, items],
  );

  const availablePages = useMemo(() => {
    if (!demoMode) return [];
    const pageSet = new Set<string>();
    if (currentSite && currentSite.pages.length > 0) {
      const prefix = `/${currentSite.slug}/${targetLang}/`;
      for (const p of currentSite.pages) {
        if (p.startsWith(prefix)) pageSet.add(p);
      }
    }
    for (const it of items) {
      for (const p of it.pages) {
        pageSet.add(p);
      }
    }
    return [...pageSet];
  }, [demoMode, currentSite, targetLang, items]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listTranslations({
        slug: demoMode ? currentSite?.slug || undefined : undefined,
        srcLang: sourceLang,
        tgtLang: targetLang,
        pagePath: demoMode && pageFilter ? pageFilter : undefined,
        labelFilter,
        search: searchQuery,
      });
      setItems(res.items);
      if (res.items.length > 0) {
        setSelectedHash((prev) => {
          const found = prev ? res.items.find((i) => i.hash === prev) : undefined;
          const chosen = found ?? res.items[0];
          if (!found) {
            setDraftText(chosen.tgtText);
            setConflictLatest(null);
            setErrorMessage(null);
          }
          return chosen.hash;
        });
      } else {
        setSelectedHash(null);
        setDraftText('');
      }
    } catch (err) {
      setErrorMessage(reviewErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, currentSite?.slug, sourceLang, targetLang, pageFilter, labelFilter, searchQuery]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  const selectedItem = useMemo(
    () => items.find((i) => i.hash === selectedHash) ?? null,
    [items, selectedHash],
  );

  const handleSelectRow = (item: ReviewSentenceItem) => {
    setSelectedHash(item.hash);
    setDraftText(item.tgtText);
    setErrorMessage(null);
    setSuccessMessage(null);
    setConflictLatest(null);
  };

  // Kiểm tra tức thời ký hiệu {n} ở phía trình duyệt
  const placeholderCheck = useMemo(() => {
    if (!selectedItem) return { ok: true, missing: [], extra: [], requiredTokens: [] };
    return validatePlaceholders(selectedItem.srcText, draftText);
  }, [selectedItem, draftText]);

  const activePollersRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Dọn dẹp tất cả timer polling khi component unmount
  useEffect(() => {
    return () => {
      for (const timer of activePollersRef.current.values()) {
        clearTimeout(timer);
      }
      activePollersRef.current.clear();
    };
  }, []);

  const startPolling = useCallback(
    (hash: string, invalidation: InvalidationOutcome, initialPendingIds?: string[]) => {
      const allIds = extractInvalidationIds(invalidation);
      if (allIds.length === 0) return;

      const existingTimer = activePollersRef.current.get(hash);
      if (existingTimer) {
        clearTimeout(existingTimer);
        activePollersRef.current.delete(hash);
      }

      setCacheStatusByHash((prev) => ({
        ...prev,
        [hash]: { state: 'IN_PROGRESS', outcome: invalidation },
      }));

      let attempts = 0;
      let pendingIds = initialPendingIds && initialPendingIds.length > 0 ? [...initialPendingIds] : [...allIds];

      const runPoll = () => {
        attempts++;
        void checkMultipleInvalidationsStatus(api, pendingIds)
          .then((batch) => {
            pendingIds = batch.inProgressIds;

            if (batch.status === 'Failed') {
              activePollersRef.current.delete(hash);
              setCacheStatusByHash((prev) => ({
                ...prev,
                [hash]: {
                  state: 'FAILED',
                  outcome: {
                    ...invalidation,
                    status: 'FAILED',
                    error: 'Làm mới bộ nhớ đệm CloudFront thất bại ở một hoặc nhiều phân vùng.',
                  },
                },
              }));
            } else if (batch.status === 'Completed' || pendingIds.length === 0) {
              activePollersRef.current.delete(hash);
              setCacheStatusByHash((prev) => ({
                ...prev,
                [hash]: { state: 'COMPLETED', outcome: invalidation },
              }));
            } else if (attempts >= MAX_INVALIDATION_POLL_ATTEMPTS) {
              activePollersRef.current.delete(hash);
              setCacheStatusByHash((prev) => ({
                ...prev,
                [hash]: { state: 'TIMED_OUT', outcome: invalidation },
              }));
            } else {
              const nextDelay = getInvalidationPollIntervalMs(attempts + 1);
              const nextTimer = setTimeout(runPoll, nextDelay);
              activePollersRef.current.set(hash, nextTimer);
            }
          })
          .catch(() => {
            if (attempts >= MAX_INVALIDATION_POLL_ATTEMPTS) {
              activePollersRef.current.delete(hash);
              setCacheStatusByHash((prev) => ({
                ...prev,
                [hash]: { state: 'TIMED_OUT', outcome: invalidation },
              }));
            } else {
              const nextDelay = getInvalidationPollIntervalMs(attempts + 1);
              const nextTimer = setTimeout(runPoll, nextDelay);
              activePollersRef.current.set(hash, nextTimer);
            }
          });
      };

      const firstTimer = setTimeout(runPoll, getInvalidationPollIntervalMs(1));
      activePollersRef.current.set(hash, firstTimer);
    },
    [api],
  );

  const applyInvalidationResult = useCallback(
    (hash: string, invalidation: InvalidationOutcome) => {
      const existingTimer = activePollersRef.current.get(hash);
      if (existingTimer) {
        clearTimeout(existingTimer);
        activePollersRef.current.delete(hash);
      }

      if (invalidation.status === 'SKIPPED_NO_PAGES') {
        setCacheStatusByHash((prev) => ({
          ...prev,
          [hash]: { state: 'NOT_USED', outcome: invalidation },
        }));
        return;
      }
      if (invalidation.status === 'FAILED') {
        setCacheStatusByHash((prev) => ({
          ...prev,
          [hash]: { state: 'FAILED', outcome: invalidation },
        }));
        return;
      }
      if (invalidation.status === 'PARTIAL') {
        setCacheStatusByHash((prev) => ({
          ...prev,
          [hash]: { state: 'PARTIAL', outcome: invalidation },
        }));
        return;
      }

      startPolling(hash, invalidation);
    },
    [startPolling],
  );

  const handleCheckInvalidationAgain = async (item: ReviewSentenceItem, outcome?: InvalidationOutcome) => {
    if (!outcome) return;
    const invIds = extractInvalidationIds(outcome);
    if (invIds.length === 0) return;

    setErrorMessage(null);
    setCacheStatusByHash((prev) => ({
      ...prev,
      [item.hash]: { state: 'IN_PROGRESS', outcome },
    }));

    try {
      const batch = await checkMultipleInvalidationsStatus(api, invIds);
      if (batch.status === 'Completed') {
        setCacheStatusByHash((prev) => ({
          ...prev,
          [item.hash]: { state: 'COMPLETED', outcome },
        }));
        setSuccessMessage('Làm mới bộ nhớ đệm CloudFront đã hoàn tất.');
      } else if (batch.status === 'Failed') {
        setCacheStatusByHash((prev) => ({
          ...prev,
          [item.hash]: {
            state: 'FAILED',
            outcome: {
              ...outcome,
              status: 'FAILED',
              error: 'Làm mới bộ nhớ đệm CloudFront thất bại ở một hoặc nhiều phân vùng.',
            },
          },
        }));
      } else {
        startPolling(item.hash, outcome, batch.inProgressIds);
      }
    } catch {
      startPolling(item.hash, outcome);
    }
  };

  const updateItemInState = (updated: ReviewSentenceItem, invalidation?: InvalidationOutcome) => {
    const enriched: ReviewSentenceItem = invalidation
      ? {
          ...updated,
          pages: invalidation.paths.length > 0 ? invalidation.paths : updated.pages,
          hasPageMetadata: true,
          unused:
            invalidation.status === 'SKIPPED_NO_PAGES' &&
            invalidation.paths.length === 0 &&
            updated.pages.length === 0,
        }
      : updated;
    setItems((prev) => prev.map((it) => (it.hash === enriched.hash ? enriched : it)));
    setDraftText(enriched.tgtText);
    setConflictLatest(null);
  };

  const handleAcceptOriginal = async () => {
    if (!selectedItem || !canEdit) return;
    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await api.acceptTranslation({
        srcLang: selectedItem.srcLang,
        tgtLang: selectedItem.tgtLang,
        hash: selectedItem.hash,
        expectedVersion: selectedItem.version,
      });
      updateItemInState(res.item);
      setSuccessMessage('Đã chấp nhận nguyên bản và chuyển nhãn sang "Đã duyệt" (v' + res.item.version + ').');
    } catch (err) {
      if (err instanceof ReviewApiError && err.code === 'VERSION_CONFLICT' && err.latest) {
        setConflictLatest(err.latest);
      }
      setErrorMessage(reviewErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveAndPublish = async (overrideVersion?: number) => {
    if (!selectedItem || !canEdit) return;
    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await api.saveAndPublishTranslation({
        srcLang: selectedItem.srcLang,
        tgtLang: selectedItem.tgtLang,
        hash: selectedItem.hash,
        editedText: draftText,
        expectedVersion: overrideVersion ?? selectedItem.version,
      });
      updateItemInState(res.item, res.invalidation);
      applyInvalidationResult(res.item.hash, res.invalidation);
      if (res.invalidation.status === 'FAILED') {
        setSuccessMessage(
          `Bản dịch đã được lưu thành "Đã duyệt" (v${res.item.version}), nhưng làm mới bộ nhớ đệm gặp lỗi. Bạn có thể bấm "Thử lại".`,
        );
      } else if (res.invalidation.status === 'PARTIAL') {
        setSuccessMessage(
          `Bản dịch đã được lưu thành "Đã duyệt" (v${res.item.version}), nhưng làm mới bộ nhớ đệm chỉ thành công một phần (${res.invalidation.failedPaths?.length ?? 0} đường dẫn lỗi). Bạn có thể bấm "Thử lại".`,
        );
      } else if (res.invalidation.status === 'SKIPPED_NO_PAGES') {
        setSuccessMessage(
          `Đã lưu bản dịch (v${res.item.version}). Câu này hiện không còn sử dụng trên trang nào nên không cần xóa cache.`,
        );
      } else {
        setSuccessMessage(
          `Đã lưu và xuất bản (v${res.item.version}). Đang làm mới ${res.invalidation.paths.length} trang trên CloudFront.`,
        );
      }
    } catch (err) {
      if (err instanceof ReviewApiError && err.code === 'VERSION_CONFLICT' && err.latest) {
        setConflictLatest(err.latest);
      }
      setErrorMessage(reviewErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRestoreMachine = async () => {
    if (!selectedItem || !canEdit) return;
    setSubmitting(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await api.restoreMachineTranslation({
        srcLang: selectedItem.srcLang,
        tgtLang: selectedItem.tgtLang,
        hash: selectedItem.hash,
        expectedVersion: selectedItem.version,
      });
      updateItemInState(res.item, res.invalidation);
      applyInvalidationResult(res.item.hash, res.invalidation);
      setSuccessMessage(`Đã khôi phục về bản máy dịch gốc (v${res.item.version}).`);
    } catch (err) {
      if (err instanceof ReviewApiError && err.code === 'VERSION_CONFLICT' && err.latest) {
        setConflictLatest(err.latest);
      }
      setErrorMessage(reviewErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryInvalidation = async (item: ReviewSentenceItem) => {
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const outcome = await api.retryInvalidation({
        srcLang: item.srcLang,
        tgtLang: item.tgtLang,
        hash: item.hash,
      });
      applyInvalidationResult(item.hash, outcome);
      if (outcome.status === 'SUBMITTED') {
        setSuccessMessage(`Đã gửi lại yêu cầu làm mới bộ nhớ đệm cho ${outcome.paths.length} trang.`);
      } else if (outcome.status === 'PARTIAL') {
        setErrorMessage(
          `Làm mới bộ nhớ đệm chỉ thành công một phần (${outcome.failedPaths?.length ?? 0} đường dẫn lỗi): ` +
            (outcome.error ?? 'Lỗi CloudFront'),
        );
      } else if (outcome.status === 'FAILED') {
        setErrorMessage('Làm mới bộ nhớ đệm vẫn thất bại: ' + (outcome.error ?? 'Lỗi CloudFront'));
      }
    } catch (err) {
      setErrorMessage(reviewErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleInsertMissingToken = (tok: string) => {
    setDraftText((prev) => `${prev}${prev.endsWith(' ') || prev.length === 0 ? '' : ' '}${tok}`);
  };

  const renderCacheBadge = (item: ReviewSentenceItem) => {
    const st = cacheStatusByHash[item.hash];
    const knownUnused =
      st?.state === 'NOT_USED' ||
      (item.hasPageMetadata !== false && (item.pages.length === 0 || item.unused));

    if (knownUnused) {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 border border-gray-200">
          Không còn sử dụng
        </span>
      );
    }
    if (!st || st.state === 'IDLE') return null;

    if (st.state === 'IN_PROGRESS') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-600 animate-ping" />
          Đang làm mới ({st.outcome?.paths.length ?? item.pages.length} trang)
        </span>
      );
    }
    if (st.state === 'COMPLETED') {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
          Đã làm mới ({st.outcome?.paths.length ?? item.pages.length} trang)
        </span>
      );
    }
    if (st.state === 'PARTIAL') {
      const failCount = st.outcome?.failedPaths?.length ?? 0;
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-800 border border-amber-300">
          Lỗi làm mới một phần{failCount > 0 ? ` (${failCount} đường dẫn)` : ''}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleRetryInvalidation(item);
            }}
            className="underline font-semibold hover:text-amber-950"
          >
            Thử lại
          </button>
        </span>
      );
    }
    if (st.state === 'TIMED_OUT') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-800 border border-amber-300">
          <span>Vẫn đang làm mới</span>
          <span className="text-amber-400">•</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleCheckInvalidationAgain(item, st.outcome);
            }}
            className="underline font-semibold hover:text-amber-950"
          >
            Kiểm tra lại
          </button>
        </span>
      );
    }
    if (st.state === 'FAILED') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-red-50 text-red-700 border border-red-200">
          Lỗi làm mới
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleRetryInvalidation(item);
            }}
            className="underline font-semibold hover:text-red-900"
          >
            Thử lại
          </button>
        </span>
      );
    }
    return null;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Tiêu đề trang */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Duyệt và chỉnh sửa bản dịch (Q4)</h2>
          <p className="text-sm text-gray-600 mt-0.5">
            Giao diện hai cột song ngữ: chấp nhận nguyên bản, chỉnh sửa xuất bản hoặc khôi phục bản máy dịch. Mỗi lần sửa chỉ xóa cache các trang chứa câu đó.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-600 bg-white px-3 py-2 rounded-lg border border-gray-200">
          <span>
            Tổng câu khớp lọc: <strong className="text-gray-900">{items.length}</strong>
          </span>
          <span>•</span>
          <span>
            Cần xem lại:{' '}
            <strong className="text-amber-700">{items.filter((i) => i.needsReview).length}</strong>
          </span>
        </div>
      </div>

      {/* Thông báo phân định chế độ Demo và chế độ API thật */}
      {!demoMode && (
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 p-3 bg-blue-50/80 border border-blue-200 rounded-xl text-xs text-blue-900">
          <div className="flex items-center gap-2">
            <span className="font-semibold px-2 py-0.5 rounded bg-blue-200 text-blue-950">Chế độ API thật (F5)</span>
            <span>Duyệt và chỉnh sửa trực tiếp bộ nhớ dịch (TM) theo cặp ngôn ngữ.</span>
          </div>
          <span className="text-blue-700 italic">Bộ lọc website &amp; trang được giới hạn ở chế độ demo cho đến khi dịch vụ C6/SEG sẵn sàng.</span>
        </div>
      )}

      {/* Thanh bộ lọc (Bước 1 & Bước 2 của Q4) */}
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Website</label>
            {demoMode && sites.length > 0 ? (
              <select
                value={currentSite?.slug ?? ''}
                onChange={(e) => {
                  setSelectedSiteSlug(e.target.value);
                  setPageFilter('');
                }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                {sites.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.displayName} ({s.slug})
                  </option>
                ))}
              </select>
            ) : (
              <select
                value=""
                disabled
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 cursor-not-allowed"
                title="Ở chế độ API thật, bản dịch được duyệt từ bộ nhớ dịch (TM) của tenant. Bộ lọc website khả dụng ở chế độ demo."
              >
                <option value="">Toàn bộ website (Bộ nhớ dịch TM)</option>
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Cặp ngôn ngữ</label>
            <select
              value={targetLang}
              onChange={(e) => {
                setTargetLang(e.target.value);
                setPageFilter('');
              }}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              {targetLangOptions.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGE_LABELS[sourceLang] ?? sourceLang} →{' '}
                  {LANGUAGE_LABELS[lang] ?? lang}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Lọc theo trang</label>
            {demoMode && hasAnyPageMetadata ? (
              <select
                value={pageFilter}
                onChange={(e) => setPageFilter(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              >
                <option value="">Tất cả các trang</option>
                {availablePages.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option value="__UNUSED__">Không còn sử dụng (0 trang)</option>
              </select>
            ) : (
              <select
                value=""
                disabled
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500 cursor-not-allowed"
                title="Bộ lọc trang khả dụng ở chế độ demo. Dữ liệu thật sẽ kích hoạt khi tích hợp dịch vụ chỉ mục câu–trang SEG."
              >
                <option value="">Chỉ khả dụng ở chế độ demo (Chờ SEG)</option>
              </select>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Lọc theo nhãn</label>
            <select
              value={labelFilter}
              onChange={(e) => setLabelFilter(e.target.value as ReviewLabelFilter)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              {(Object.keys(REVIEW_FILTER_LABELS) as ReviewLabelFilter[]).map((k) => (
                <option key={k} value={k}>
                  {REVIEW_FILTER_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Tìm theo từ khóa</label>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Nhập từ trong câu gốc hoặc dịch..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {/* Công cụ mô phỏng tình huống lỗi dành cho chế độ Demo */}
        {demoMode && mock && selectedItem && (
          <div className="pt-2 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
            <span className="font-medium text-gray-700">
              Công cụ kiểm thử nhanh (chế độ demo):
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const updatedOnServer = mock.simulateConcurrentEdit(
                    selectedItem.srcLang,
                    selectedItem.tgtLang,
                    selectedItem.hash,
                  );
                  setSuccessMessage(
                    `Đã giả lập người dùng khác vừa lưu v${updatedOnServer.version} trên máy chủ. Hãy bấm "Lưu và xuất bản" để kiểm tra cảnh báo 409 VERSION_CONFLICT.`,
                  );
                }}
                className="px-2.5 py-1 rounded border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 font-medium"
              >
                Giả lập người khác vừa sửa câu đang chọn (409)
              </button>
              <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-gray-200 bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={simulateCdnFail}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setSimulateCdnFail(next);
                    mock.setSimulateCdnFailure(next);
                  }}
                />
                <span>Giả lập lỗi làm mới CloudFront</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Khung chính: Bảng 2 cột song ngữ bên trái + Khung chỉnh sửa chi tiết bên phải */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Bảng hai cột song ngữ (7/12 cột) */}
        <div className="lg:col-span-7 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="grid grid-cols-2 bg-gray-50 border-b border-gray-200 px-4 py-3 text-xs font-semibold text-gray-700 uppercase tracking-wider">
            <div>Bản gốc ({LANGUAGE_LABELS[sourceLang] ?? sourceLang})</div>
            <div>Bản dịch ({LANGUAGE_LABELS[targetLang] ?? targetLang})</div>
          </div>

          {loading ? (
            <div className="p-8 text-center text-sm text-gray-500">Đang tải danh sách câu dịch...</div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              Không có câu dịch nào khớp với bộ lọc hiện tại.
            </div>
          ) : (
            <div className="divide-y divide-gray-200 max-h-[600px] overflow-y-auto">
              {items.map((item) => {
                const isSelected = item.hash === selectedHash;
                return (
                  <div
                    key={item.hash}
                    onClick={() => handleSelectRow(item)}
                    className={`grid grid-cols-2 gap-4 p-4 cursor-pointer transition-colors ${
                      isSelected ? 'bg-blue-50/70 ring-1 ring-inset ring-blue-300' : 'hover:bg-gray-50'
                    }`}
                  >
                    {/* Cột 1: Câu gốc + trang xuất hiện */}
                    <div className="space-y-2 pr-2 border-r border-gray-100">
                      <p className="text-sm text-gray-900 leading-relaxed">
                        <HighlightedMarkersText text={item.srcText} />
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {item.pages.length > 0 ? (
                          item.pages.map((p) => (
                            <span
                              key={p}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-mono bg-gray-100 text-gray-600"
                            >
                              {p}
                            </span>
                          ))
                        ) : item.hasPageMetadata === false ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600">
                            TM ({item.srcLang} → {item.tgtLang})
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                            Không còn sử dụng
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Cột 2: Bản dịch + nhãn trạng thái + trạng thái xóa cache */}
                    <div className="space-y-2 pl-1">
                      <p className="text-sm text-gray-900 leading-relaxed">
                        <HighlightedMarkersText text={item.tgtText} />
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {item.status === 'HUMAN' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-800">
                            Đã duyệt
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
                            Máy dịch
                          </span>
                        )}

                        {item.needsReview && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                            Cần xem lại
                          </span>
                        )}

                        <span className="text-[11px] font-mono text-gray-400">v{item.version}</span>

                        {renderCacheBadge(item)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Khung sửa chi tiết bên phải (5/12 cột) */}
        <div className="lg:col-span-5 bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4">
          {!selectedItem ? (
            <div className="py-12 text-center text-sm text-gray-500">
              Chọn một câu trong danh sách bên trái để xem chi tiết và hiệu đính.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between border-b border-gray-100 pb-3">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Khung hiệu đính câu dịch</h3>
                  <p className="text-xs text-gray-500 font-mono mt-0.5">
                    SHA-256: {selectedItem.hash.slice(0, 16)}… • Phiên bản v{selectedItem.version}
                  </p>
                </div>
                <div className="flex items-center gap-1.5">
                  {selectedItem.status === 'HUMAN' ? (
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                      Đã duyệt
                    </span>
                  ) : (
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                      Máy dịch
                    </span>
                  )}
                  {selectedItem.needsReview && (
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                      Cần xem lại
                    </span>
                  )}
                </div>
              </div>

              {/* Thông báo lỗi hoặc thành công */}
              {errorMessage && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 space-y-1"
                >
                  <div className="font-semibold">Không thể lưu bản dịch:</div>
                  <div>{errorMessage}</div>
                </div>
              )}

              {successMessage && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                  {successMessage}
                </div>
              )}

              {/* Khung so sánh khi xảy ra xung đột 409 VERSION_CONFLICT (Mục 1.3.4) */}
              {conflictLatest && (
                <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-300 text-xs space-y-2.5">
                  <div className="font-semibold text-amber-900">
                    Cảnh báo xung đột phiên bản (409 VERSION_CONFLICT)
                  </div>
                  <p className="text-amber-800">
                    Người dùng <strong>{conflictLatest.reviewerId ?? 'khác'}</strong> vừa cập nhật câu này lên phiên bản{' '}
                    <strong>v{conflictLatest.version}</strong>. Hãy so sánh trước khi quyết định:
                  </p>
                  <div className="bg-white p-2.5 rounded border border-amber-200 space-y-1">
                    <div className="text-[11px] font-semibold text-gray-500">
                      Bản mới nhất trên máy chủ (v{conflictLatest.version}):
                    </div>
                    <div className="text-sm text-gray-900">
                      <HighlightedMarkersText text={conflictLatest.tgtText} />
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        updateItemInState(conflictLatest);
                        setErrorMessage(null);
                        setSuccessMessage(`Đã nạp bản mới nhất (v${conflictLatest.version}).`);
                      }}
                      className="px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-800 font-medium hover:bg-gray-50"
                    >
                      Dùng bản mới nhất (v{conflictLatest.version})
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveAndPublish(conflictLatest.version)}
                      className="px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700"
                    >
                      Lưu đè bằng bản của tôi (lên v{conflictLatest.version + 1})
                    </button>
                  </div>
                </div>
              )}

              {/* Cảnh báo thuật ngữ nếu câu có gắn nhãn Cần xem lại */}
              {selectedItem.glossaryWarnings.length > 0 && (
                <div className="p-3 rounded-lg bg-amber-50/80 border border-amber-200 text-xs text-amber-900 space-y-1">
                  <div className="font-semibold">Thuật ngữ cần kiểm tra trong câu:</div>
                  <ul className="list-disc list-inside space-y-0.5">
                    {selectedItem.glossaryWarnings.map((w, i) => (
                      <li key={i}>
                        Từ nguồn <strong>"{w.sourceTerm}"</strong> ({w.mode === 'KEEP' ? 'Giữ nguyên' : 'Dịch cố định'}) → yêu cầu có{' '}
                        <strong>"{w.expectedTarget}"</strong> trong bản dịch.
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Văn bản gốc */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-gray-700">
                  Câu gốc ({LANGUAGE_LABELS[selectedItem.srcLang] ?? selectedItem.srcLang})
                </label>
                <div className="p-3 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-900 leading-relaxed">
                  <HighlightedMarkersText text={selectedItem.srcText} />
                </div>
              </div>

              {/* Các trang chứa câu này (Mục 1.3.4 bước 3) */}
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-gray-700">
                  Xuất hiện trên các trang
                  {selectedItem.hasPageMetadata !== false ? ` (${selectedItem.pages.length})` : ''}
                </label>
                {selectedItem.pages.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5 p-2.5 rounded-lg bg-gray-50 border border-gray-200">
                    {selectedItem.pages.map((p) => (
                      <span
                        key={p}
                        className="px-2 py-0.5 rounded bg-white border border-gray-200 text-xs font-mono text-gray-700"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                ) : selectedItem.hasPageMetadata === false ? (
                  <div className="p-2.5 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-600">
                    Dịch vụ F5 tra cứu danh sách trang (bảng SEG) khi lưu và xuất bản hoặc khôi phục để xóa cache chọn lọc trên CloudFront.
                  </div>
                ) : (
                  <div className="p-2.5 rounded-lg bg-gray-50 border border-gray-200 text-xs text-gray-600">
                    <strong>Không còn sử dụng:</strong> Câu này không còn xuất hiện trên trang nào của website gốc (đã xóa hoặc thay đổi nội dung).
                  </div>
                )}
              </div>

              {/* Ô chỉnh sửa bản dịch đích */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label htmlFor="review-draft-textarea" className="block text-xs font-semibold text-gray-700">
                    Bản dịch ({LANGUAGE_LABELS[selectedItem.tgtLang] ?? selectedItem.tgtLang})
                  </label>
                  {placeholderCheck.requiredTokens.length > 0 && (
                    <span className="text-[11px] text-gray-500">
                      Ký hiệu bắt buộc: {placeholderCheck.requiredTokens.join(' ')}
                    </span>
                  )}
                </div>
                <textarea
                  id="review-draft-textarea"
                  rows={4}
                  value={draftText}
                  disabled={!canEdit || submitting}
                  onChange={(e) => {
                    setDraftText(e.target.value);
                    setErrorMessage(null);
                  }}
                  className={`w-full rounded-lg border p-3 text-sm leading-relaxed focus:outline-none ${
                    !placeholderCheck.ok
                      ? 'border-red-400 bg-red-50/20 focus:border-red-500'
                      : 'border-gray-300 focus:border-blue-500'
                  }`}
                />

                {/* Cảnh báo tức thời nếu thiếu/thừa ký hiệu {n} */}
                {!placeholderCheck.ok && (
                  <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 space-y-1.5">
                    <div>
                      <strong>Lệch ký hiệu định dạng {'{n}'}:</strong>{' '}
                      {placeholderCheck.missing.length > 0 && (
                        <span>Thiếu: {placeholderCheck.missing.join(', ')}. </span>
                      )}
                      {placeholderCheck.extra.length > 0 && (
                        <span>Thừa: {placeholderCheck.extra.join(', ')}.</span>
                      )}
                    </div>
                    {placeholderCheck.missing.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span>Chèn nhanh ký hiệu thiếu:</span>
                        {placeholderCheck.missing.map((tok, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleInsertMissingToken(tok)}
                            className="px-2 py-0.5 rounded bg-white border border-red-300 font-mono text-xs text-red-700 hover:bg-red-100"
                          >
                            + {tok}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Bản dịch máy gốc để tham chiếu */}
              <div className="text-xs text-gray-500 bg-gray-50 p-2.5 rounded-lg border border-gray-100">
                <span className="font-medium text-gray-700">Bản máy dịch gốc: </span>
                <HighlightedMarkersText text={selectedItem.machineText} />
              </div>

              {/* Ba nút thao tác chuẩn của Q4 (Bước 4) */}
              <div className="pt-2 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={!canEdit || submitting}
                  onClick={() => void handleSaveAndPublish()}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Lưu và xuất bản
                </button>

                <button
                  type="button"
                  disabled={
                    !canEdit ||
                    submitting ||
                    (selectedItem.status === 'HUMAN' && !selectedItem.needsReview)
                  }
                  onClick={() => void handleAcceptOriginal()}
                  className="px-3.5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  Chấp nhận nguyên bản
                </button>

                <button
                  type="button"
                  disabled={!canEdit || submitting || selectedItem.status === 'MACHINE'}
                  onClick={() => void handleRestoreMachine()}
                  className="px-3.5 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
                >
                  Khôi phục bản máy dịch
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
