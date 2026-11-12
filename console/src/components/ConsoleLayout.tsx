import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConsoleAuthError,
  fetchConsoleTenantProfile,
  getVisibleMenuItems,
  IS_DEMO_AUTH_MODE,
  mapCognitoErrorToVietnamese,
  ROLE_DISPLAY_LABEL,
} from '../services/cognitoAuth.js';
import type { AuthenticatedSession, ConsoleMenuKey, TenantStatus } from '../types/auth.js';
import { EmptyState, ErrorAlert } from './ConsoleFeedback.js';
import { GlossaryPage } from './GlossaryPage.js';
import { MembersPage } from './MembersPage.js';
import { ReviewPage } from './ReviewPage.js';
import { WebsitePage } from './WebsitePage.js';

const PLAN_DISPLAY_LABEL: Readonly<Record<AuthenticatedSession['plan'], string>> = {
  FREE: 'Free',
  PRO: 'Pro',
  BUSINESS: 'Business',
};

interface ConsoleLayoutProps {
  session: AuthenticatedSession;
  onUpdateSession?: (nextSession: AuthenticatedSession) => void;
}

export const ConsoleLayout: React.FC<ConsoleLayoutProps> = ({ session, onUpdateSession }) => {
  const [fallbackTenantStatus, setFallbackTenantStatus] = useState<TenantStatus>(session.tenantStatus);
  const [checkingTenantStatus, setCheckingTenantStatus] = useState<boolean>(!IS_DEMO_AUTH_MODE);
  const [tenantStatusError, setTenantStatusError] = useState<unknown | null>(null);
  const [statusRefreshSeq, setStatusRefreshSeq] = useState<number>(0);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const onUpdateSessionRef = useRef(onUpdateSession);
  onUpdateSessionRef.current = onUpdateSession;

  useEffect(() => {
    setFallbackTenantStatus(session.tenantStatus);
  }, [session.tenantId, session.idToken, session.tenantStatus]);

  // Ở chế độ API thật, luôn truy vấn GET /console/me khi vào Console (hoặc khi người dùng yêu cầu kiểm tra lại)
  // để đồng bộ trạng thái ACTIVE / LOCKED; nếu không xác minh được thì giữ UNKNOWN (fail-closed khóa thao tác ghi).
  useEffect(() => {
    if (IS_DEMO_AUTH_MODE) {
      setCheckingTenantStatus(false);
      setTenantStatusError(null);
      return;
    }

    let cancelled = false;
    setCheckingTenantStatus(true);
    setTenantStatusError(null);

    fetchConsoleTenantProfile(sessionRef.current, { demoMode: false })
      .then((profile) => {
        if (cancelled) return;
        setFallbackTenantStatus(profile.tenantStatus);
        setTenantStatusError(null);
        const cur = sessionRef.current;
        const nextOrg = profile.organizationName ?? cur.organizationName;
        const nextPlan = profile.plan ?? cur.plan;
        const nextTenantId = profile.tenantId || cur.tenantId;
        if (
          cur.tenantStatus !== profile.tenantStatus ||
          cur.role !== profile.role ||
          cur.organizationName !== nextOrg ||
          cur.plan !== nextPlan ||
          cur.tenantId !== nextTenantId
        ) {
          onUpdateSessionRef.current?.({
            ...cur,
            tenantId: nextTenantId,
            role: profile.role,
            tenantStatus: profile.tenantStatus,
            organizationName: nextOrg,
            plan: nextPlan,
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const detectedStatus: TenantStatus =
          err instanceof ConsoleAuthError && err.code === 'TENANT_SUSPENDED' ? 'LOCKED' : 'UNKNOWN';
        setFallbackTenantStatus(detectedStatus);
        setTenantStatusError(detectedStatus === 'LOCKED' ? null : err);
        const cur = sessionRef.current;
        if (cur.tenantStatus !== detectedStatus) {
          onUpdateSessionRef.current?.({
            ...cur,
            tenantStatus: detectedStatus,
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCheckingTenantStatus(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [session.tenantId, session.idToken, statusRefreshSeq]);

  const effectiveTenantStatus: TenantStatus = IS_DEMO_AUTH_MODE
    ? session.tenantStatus
    : fallbackTenantStatus;

  const effectiveSession: AuthenticatedSession = useMemo(
    () =>
      session.tenantStatus === effectiveTenantStatus
        ? session
        : { ...session, tenantStatus: effectiveTenantStatus },
    [session, effectiveTenantStatus],
  );

  const handleTenantStatusDetected = useCallback((nextStatus: TenantStatus) => {
    setFallbackTenantStatus(nextStatus);
    if (nextStatus !== 'UNKNOWN') {
      setTenantStatusError(null);
    }
    const cur = sessionRef.current;
    if (cur.tenantStatus !== nextStatus) {
      onUpdateSessionRef.current?.({
        ...cur,
        tenantStatus: nextStatus,
      });
    }
  }, []);

  const visibleMenus = useMemo(
    () => getVisibleMenuItems(effectiveSession.role),
    [effectiveSession.role],
  );
  // Reviewer mở mặc định màn Duyệt bản dịch (Q4); các vai trò khác mở mục đầu tiên được phép (Tenant Admin: Website)
  const [activeMenu, setActiveMenu] = useState<ConsoleMenuKey>(() =>
    effectiveSession.role === 'REVIEWER' ? 'review' : (visibleMenus[0]?.key ?? 'glossary'),
  );

  useEffect(() => {
    if (!visibleMenus.some((m) => m.key === activeMenu)) {
      setActiveMenu(
        effectiveSession.role === 'REVIEWER' ? 'review' : (visibleMenus[0]?.key ?? 'glossary'),
      );
    }
  }, [visibleMenus, activeMenu, effectiveSession.role]);

  return (
    <div className="min-h-[calc(100vh-4rem)] flex bg-[#f4f7f6]">
      {/* Thanh điều hướng bên trái (ẩn/hiện tự động theo custom:role) */}
      <aside className="w-56 bg-[#f4f7f6] border-r border-gray-200 py-5 px-3 flex flex-col justify-between shrink-0">
        <nav aria-label="Menu điều hướng theo vai trò" className="space-y-1">
          {visibleMenus.map((item) => {
            const isActive = activeMenu === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveMenu(item.key)}
                className={`w-full text-left px-3.5 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-[#d7eae3] text-[#146c54] font-semibold'
                    : 'text-gray-600 hover:bg-gray-200/60 font-medium'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Thông tin tổ chức & phiên làm việc hiện tại */}
        <div className="mt-6 rounded-lg bg-white border border-gray-200 p-3 text-[11px] text-gray-500 space-y-1.5">
          <div className="font-semibold text-gray-700 truncate" title={effectiveSession.organizationName}>
            {effectiveSession.organizationName}
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-gray-400">Vai trò:</span>
            <span className="text-[#146c54] font-semibold">{ROLE_DISPLAY_LABEL[effectiveSession.role]}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-gray-400">Gói dịch vụ:</span>
            <span className="font-medium text-gray-700">{PLAN_DISPLAY_LABEL[effectiveSession.plan] ?? effectiveSession.plan}</span>
          </div>
          <div className="truncate text-[10px] text-gray-400" title={effectiveSession.tenantId}>
            Mã tổ chức: <code className="text-gray-600">{effectiveSession.tenantId}</code>
          </div>
          {effectiveSession.tenantStatus === 'LOCKED' && (
            <div className="pt-1">
              <span className="inline-flex w-full justify-center items-center px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 font-semibold">
                Tổ chức tạm khóa (chỉ xem)
              </span>
            </div>
          )}
          {effectiveSession.tenantStatus === 'UNKNOWN' && (
            <div className="pt-1 space-y-1">
              <span className="inline-flex w-full justify-center items-center px-2 py-0.5 rounded bg-slate-100 border border-slate-300 text-slate-700 font-semibold text-center">
                {checkingTenantStatus ? 'Đang kiểm tra trạng thái...' : 'Chưa rõ trạng thái (khóa ghi)'}
              </span>
              {!IS_DEMO_AUTH_MODE && !checkingTenantStatus && (
                <button
                  type="button"
                  onClick={() => setStatusRefreshSeq((n) => n + 1)}
                  className="w-full px-2 py-0.5 rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 font-medium"
                >
                  Kiểm tra lại
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Vùng nội dung chính */}
      <main className="flex-1 min-w-0">
        {!IS_DEMO_AUTH_MODE && tenantStatusError ? (
          <div className="px-8 pt-6 max-w-6xl">
            <ErrorAlert
              error={tenantStatusError}
              title="Chưa xác minh được trạng thái tổ chức"
              scope="auth"
              operation="read"
              formatMessage={mapCognitoErrorToVietnamese}
              onRetry={() => setStatusRefreshSeq((n) => n + 1)}
              retryLabel="Kiểm tra lại"
              compact
            />
          </div>
        ) : !IS_DEMO_AUTH_MODE && checkingTenantStatus && effectiveSession.tenantStatus === 'UNKNOWN' ? (
          <div className="px-8 pt-6 max-w-6xl">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
              Đang kiểm tra trạng thái hoạt động của tổ chức trước khi bật các thao tác chỉnh sửa...
            </div>
          </div>
        ) : null}

        {activeMenu === 'members' ? (
          <MembersPage
            session={effectiveSession}
            onTenantStatusDetected={handleTenantStatusDetected}
          />
        ) : activeMenu === 'website' ? (
          <WebsitePage
            session={effectiveSession}
            onTenantStatusDetected={handleTenantStatusDetected}
          />
        ) : activeMenu === 'glossary' ? (
          <GlossaryPage
            session={effectiveSession}
            onTenantStatusDetected={handleTenantStatusDetected}
          />
        ) : activeMenu === 'review' ? (
          <ReviewPage
            session={effectiveSession}
            onTenantStatusDetected={handleTenantStatusDetected}
          />
        ) : (
          <div className="p-8 max-w-4xl">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <EmptyState
                title={`Mục "${visibleMenus.find((m) => m.key === activeMenu)?.label ?? 'Chức năng'}" đang chờ tích hợp`}
                description={`Bạn đang đăng nhập với vai trò ${ROLE_DISPLAY_LABEL[effectiveSession.role]} của tổ chức ${effectiveSession.organizationName}. Giao diện chi tiết của chức năng này sẽ được tích hợp ở bước tiếp theo.`}
                actionLabel={
                  effectiveSession.role === 'TENANT_ADMIN'
                    ? 'Quản lý thành viên'
                    : effectiveSession.role === 'DEVELOPER'
                      ? 'Mở Bảng thuật ngữ'
                      : undefined
                }
                onAction={
                  effectiveSession.role === 'TENANT_ADMIN'
                    ? () => setActiveMenu('members')
                    : effectiveSession.role === 'DEVELOPER'
                      ? () => setActiveMenu('glossary')
                      : undefined
                }
                secondaryActionLabel={effectiveSession.role === 'TENANT_ADMIN' ? 'Quay lại Website' : undefined}
                onSecondaryAction={effectiveSession.role === 'TENANT_ADMIN' ? () => setActiveMenu('website') : undefined}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
