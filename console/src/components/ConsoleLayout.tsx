import React, { useEffect, useMemo, useState } from 'react';
import { getVisibleMenuItems, ROLE_DISPLAY_LABEL } from '../services/cognitoAuth.js';
import type { AuthenticatedSession, ConsoleMenuKey } from '../types/auth.js';
import { MembersPage } from './MembersPage.js';

interface ConsoleLayoutProps {
  session: AuthenticatedSession;
}

export const ConsoleLayout: React.FC<ConsoleLayoutProps> = ({ session }) => {
  const visibleMenus = useMemo(() => getVisibleMenuItems(session.role), [session.role]);
  const [activeMenu, setActiveMenu] = useState<ConsoleMenuKey>('members');

  useEffect(() => {
    if (!visibleMenus.some((m) => m.key === activeMenu)) {
      setActiveMenu(visibleMenus[0]?.key ?? 'glossary');
    }
  }, [visibleMenus, activeMenu]);

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

        {/* Hộp thông tin JWT Claims (custom:tenant_id & custom:role sau khi Refresh Token) */}
        <div className="mt-6 rounded-lg bg-white border border-gray-200 p-3 text-[11px] text-gray-500 space-y-1">
          <div className="font-semibold text-gray-700">Phiên Cognito JWT</div>
          <div className="truncate">
            <span className="text-gray-400">tenant_id:</span>{' '}
            <code className="text-gray-700">{session.tenantId}</code>
          </div>
          <div>
            <span className="text-gray-400">role:</span>{' '}
            <code className="text-[#146c54] font-semibold">{session.role}</code>
          </div>
          <div>
            <span className="text-gray-400">gói:</span>{' '}
            <span className="font-medium text-gray-700">{session.plan}</span>
          </div>
        </div>
      </aside>

      {/* Vùng nội dung chính */}
      <main className="flex-1 min-w-0">
        {activeMenu === 'members' ? (
          <MembersPage session={session} />
        ) : (
          <div className="p-8 max-w-4xl">
            <div className="bg-white rounded-xl border border-gray-200 p-8 shadow-sm">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#e6f2ee] text-[#146c54] mb-3">
                Vai trò hiện tại: {ROLE_DISPLAY_LABEL[session.role]}
              </span>
              <h1 className="text-2xl font-bold text-gray-800">
                {visibleMenus.find((m) => m.key === activeMenu)?.label}
              </h1>
              <p className="mt-2 text-sm text-gray-500 leading-relaxed">
                Khung điều hướng của mục này đã được phân quyền theo claim{' '}
                <code className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                  custom:role = {session.role}
                </code>{' '}
                và{' '}
                <code className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                  custom:tenant_id = {session.tenantId}
                </code>
                .
              </p>
              {session.role === 'TENANT_ADMIN' && (
                <button
                  type="button"
                  onClick={() => setActiveMenu('members')}
                  className="mt-5 px-4 py-2 rounded-lg bg-[#146c54] hover:bg-[#0f5945] text-white text-xs font-semibold transition-colors"
                >
                  Chuyển tới màn Thành viên (Q1)
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
};
