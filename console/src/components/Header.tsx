import React from 'react';
import { IS_DEMO_AUTH_MODE, ROLE_DISPLAY_LABEL } from '../services/cognitoAuth.js';
import type { AuthenticatedSession, AuthScreenMode, ConsoleRole } from '../types/auth.js';

interface HeaderProps {
  session: AuthenticatedSession | null;
  authMode: AuthScreenMode;
  onSelectAuthMode: (mode: AuthScreenMode) => void;
  onSignOut: () => void;
  onSwitchRoleDemo?: (role: ConsoleRole) => void;
}

export const Header: React.FC<HeaderProps> = ({
  session,
  authMode,
  onSelectAuthMode,
  onSignOut,
  onSwitchRoleDemo,
}) => {
  return (
    <header className="h-16 bg-white border-b border-gray-200 px-6 lg:px-10 flex items-center justify-between sticky top-0 z-30">
      <button
        type="button"
        onClick={() => {
          if (!session) onSelectAuthMode('SIGN_IN');
        }}
        className="text-sm font-bold tracking-[0.22em] text-gray-800 uppercase hover:text-[#146c54] transition-colors"
      >
        TRANSLATEME
      </button>

      {!session ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => onSelectAuthMode('SIGN_IN')}
            className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
              authMode === 'SIGN_IN'
                ? 'border-[#146c54] text-[#146c54] bg-[#e6f2ee]/50'
                : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
            }`}
          >
            Đăng nhập
          </button>
          <button
            type="button"
            onClick={() => onSelectAuthMode('SIGN_UP')}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-[#146c54] text-white hover:bg-[#0f5945] transition-colors shadow-sm"
          >
            Đăng ký
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-4 text-sm">
          {IS_DEMO_AUTH_MODE && onSwitchRoleDemo && (
            <div className="hidden md:flex items-center gap-1.5 text-xs text-gray-500 bg-gray-100 px-2.5 py-1 rounded-md">
              <span>Xem thử vai trò:</span>
              {(['TENANT_ADMIN', 'DEVELOPER', 'REVIEWER'] as ConsoleRole[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onSwitchRoleDemo(r)}
                  className={`px-2 py-0.5 rounded font-medium transition-colors ${
                    session.role === r
                      ? 'bg-[#146c54] text-white'
                      : 'text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {ROLE_DISPLAY_LABEL[r]}
                </button>
              ))}
            </div>
          )}

          <span className="hidden sm:inline text-gray-600 font-normal truncate max-w-[220px]" title={session.email}>
            {session.email}
          </span>
          <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-[#e6f2ee] text-[#146c54]">
            {ROLE_DISPLAY_LABEL[session.role]}
          </span>
          {session.tenantStatus === 'LOCKED' && (
            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
              Tổ chức tạm khóa
            </span>
          )}
          <button
            type="button"
            onClick={onSignOut}
            className="text-gray-600 hover:text-gray-900 font-medium transition-colors"
          >
            Đăng xuất
          </button>
        </div>
      )}
    </header>
  );
};
