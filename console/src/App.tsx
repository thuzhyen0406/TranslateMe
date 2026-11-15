import React, { useEffect, useRef, useState } from 'react';
import { AuthScreens } from './components/AuthScreens.js';
import { ConsoleLayout } from './components/ConsoleLayout.js';
import { Header } from './components/Header.js';
import {
  applySessionRefresh,
  decodeJwtClaims,
  IS_DEMO_AUTH_MODE,
  refreshTokenForTenantClaims,
  setDemoTenantStatus,
  signOutSession,
} from './services/cognitoAuth.js';
import type { AuthenticatedSession, AuthScreenMode, ConsoleRole } from './types/auth.js';

export const App: React.FC = () => {
  const [authMode, setAuthMode] = useState<AuthScreenMode>('SIGN_UP');
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const generation = useRef(0);

  function replaceSession(next: AuthenticatedSession | null) {
    generation.current++;
    setSession(next);
  }

  // Chế độ Cognito thật: làm mới ID token 5 phút trước khi hết hạn (token sống 60 phút);
  // làm mới thất bại (refresh token hết hạn/bị thu hồi) thì đưa về màn Đăng nhập.
  useEffect(() => {
    if (IS_DEMO_AUTH_MODE || !session?.refreshToken) return;
    const exp = Number(decodeJwtClaims(session.idToken)?.exp ?? 0) * 1000;
    if (!exp) return;
    const current = session;
    const startedIn = generation.current;
    let disposed = false;
    const isCurrent = () => !disposed && generation.current === startedIn;
    const timer = window.setTimeout(() => {
      void applySessionRefresh(
        refreshTokenForTenantClaims(current),
        isCurrent,
        (next) => {
          setSession((latest) => latest?.idToken === current.idToken && latest.refreshToken === current.refreshToken ? next : latest);
        },
        () => {
          replaceSession(null);
          setAuthMode('SIGN_IN');
        },
      );
    }, Math.max(exp - Date.now() - 5 * 60_000, 30_000));
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
    // Chỉ đặt lại hẹn giờ khi bộ token đổi.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.idToken, session?.refreshToken]);

  const handleSwitchRoleDemo = (role: ConsoleRole) => {
    if (!session) return;
    setSession({
      ...session,
      role,
    });
  };

  const handleSwitchTenantStatusDemo = (tenantStatus: 'ACTIVE' | 'LOCKED') => {
    if (!session) return;
    setDemoTenantStatus(session.tenantId, tenantStatus);
    setSession({
      ...session,
      tenantStatus,
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#f4f7f6]">
      <Header
        session={session}
        authMode={authMode}
        onSelectAuthMode={(m) => {
          replaceSession(null);
          setAuthMode(m);
        }}
        onSignOut={() => {
          replaceSession(null);
          setAuthMode('SIGN_IN');
          void signOutSession(session);
        }}
        onSwitchRoleDemo={handleSwitchRoleDemo}
        onSwitchTenantStatusDemo={handleSwitchTenantStatusDemo}
      />

      {!session ? (
        <AuthScreens
          mode={authMode}
          onChangeMode={setAuthMode}
          onAuthenticated={replaceSession}
        />
      ) : (
        <ConsoleLayout session={session} onUpdateSession={(next) => {
          setSession((latest) => latest?.idToken === next.idToken && latest.refreshToken === next.refreshToken ? next : latest);
        }} />
      )}
    </div>
  );
};

export default App;
