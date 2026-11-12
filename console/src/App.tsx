import React, { useState } from 'react';
import { AuthScreens } from './components/AuthScreens.js';
import { ConsoleLayout } from './components/ConsoleLayout.js';
import { Header } from './components/Header.js';
import { setDemoTenantStatus } from './services/cognitoAuth.js';
import type { AuthenticatedSession, AuthScreenMode, ConsoleRole } from './types/auth.js';

export const App: React.FC = () => {
  const [authMode, setAuthMode] = useState<AuthScreenMode>('SIGN_UP');
  const [session, setSession] = useState<AuthenticatedSession | null>(null);

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
          setSession(null);
          setAuthMode(m);
        }}
        onSignOut={() => {
          setSession(null);
          setAuthMode('SIGN_IN');
        }}
        onSwitchRoleDemo={handleSwitchRoleDemo}
        onSwitchTenantStatusDemo={handleSwitchTenantStatusDemo}
      />

      {!session ? (
        <AuthScreens
          mode={authMode}
          onChangeMode={setAuthMode}
          onAuthenticated={(newSession) => setSession(newSession)}
        />
      ) : (
        <ConsoleLayout session={session} onUpdateSession={setSession} />
      )}
    </div>
  );
};

export default App;
