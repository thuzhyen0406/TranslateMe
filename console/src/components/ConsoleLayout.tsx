import React, { useEffect, useMemo, useState } from 'react';
import { getVisibleMenuItems, ROLE_DISPLAY_LABEL } from '../services/cognitoAuth.js';
import type { AuthenticatedSession, ConsoleMenuKey } from '../types/auth.js';
import { EmptyState } from './ConsoleFeedback.js';
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
}

export const ConsoleLayout: React.FC<ConsoleLayoutProps> = ({ session }) => {
  const visibleMenus = useMemo(() => getVisibleMenuItems(session.role), [session.role]);
  // Reviewer mở mặc định màn Duyệt bản dịch (Q4); các vai trò khác mở mục đầu tiên được phép (Tenant Admin: Website)
  const [activeMenu, setActiveMenu] = useState<ConsoleMenuKey>(() =>
    session.role === 'REVIEWER' ? 'review' : (visibleMenus[0]?.key ?? 'glossary'),
  );

  useEffect(() => {
    if (!visibleMenus.some((m) => m.key === activeMenu)) {
      setActiveMenu(session.role === 'REVIEWER' ? 'review' : (visibleMenus[0]?.key ?? 'glossary'));
    }
  }, [visibleMenus, activeMenu, session.role]);

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
          <div className="font-semibold text-gray-700 truncate" title={session.organizationName}>
            {session.organizationName}
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-gray-400">Vai trò:</span>
            <span className="text-[#146c54] font-semibold">{ROLE_DISPLAY_LABEL[session.role]}</span>
          </div>
          <div className="flex items-center justify-between gap-1">
            <span className="text-gray-400">Gói dịch vụ:</span>
            <span className="font-medium text-gray-700">{PLAN_DISPLAY_LABEL[session.plan] ?? session.plan}</span>
          </div>
          <div className="truncate text-[10px] text-gray-400" title={session.tenantId}>
            Mã tổ chức: <code className="text-gray-600">{session.tenantId}</code>
          </div>
          {session.tenantStatus === 'LOCKED' && (
            <div className="pt-1">
              <span className="inline-flex w-full justify-center items-center px-2 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-800 font-semibold">
                Tổ chức tạm khóa (chỉ xem)
              </span>
            </div>
          )}
        </div>
      </aside>

      {/* Vùng nội dung chính */}
      <main className="flex-1 min-w-0">
        {activeMenu === 'members' ? (
          <MembersPage session={session} />
        ) : activeMenu === 'website' ? (
          <WebsitePage session={session} />
        ) : activeMenu === 'glossary' ? (
          <GlossaryPage session={session} />
        ) : activeMenu === 'review' ? (
          <ReviewPage session={session} />
        ) : (
          <div className="p-8 max-w-4xl">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
              <EmptyState
                title={`Mục "${visibleMenus.find((m) => m.key === activeMenu)?.label ?? 'Chức năng'}" đang chờ tích hợp`}
                description={`Bạn đang đăng nhập với vai trò ${ROLE_DISPLAY_LABEL[session.role]} của tổ chức ${session.organizationName}. Giao diện chi tiết của chức năng này sẽ được tích hợp ở bước tiếp theo.`}
                actionLabel={
                  session.role === 'TENANT_ADMIN'
                    ? 'Quản lý thành viên'
                    : session.role === 'DEVELOPER'
                      ? 'Mở Bảng thuật ngữ'
                      : undefined
                }
                onAction={
                  session.role === 'TENANT_ADMIN'
                    ? () => setActiveMenu('members')
                    : session.role === 'DEVELOPER'
                      ? () => setActiveMenu('glossary')
                      : undefined
                }
                secondaryActionLabel={session.role === 'TENANT_ADMIN' ? 'Quay lại Website' : undefined}
                onSecondaryAction={session.role === 'TENANT_ADMIN' ? () => setActiveMenu('website') : undefined}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
