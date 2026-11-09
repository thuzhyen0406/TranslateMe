import React, { useEffect, useRef, useState } from 'react';
import {
  completeInvitedMemberPassword,
  confirmEmailAndRefreshSession,
  confirmForgotPasswordReset,
  IS_DEMO_AUTH_MODE,
  mapCognitoErrorToVietnamese,
  registerAccount,
  requestPasswordResetCode,
  resendConfirmationCode,
  ROLE_DISPLAY_LABEL,
  signInWithEmail,
  validatePasswordPolicy,
} from '../services/cognitoAuth.js';
import { ErrorAlert } from './ConsoleFeedback.js';
import type {
  AuthenticatedSession,
  AuthScreenMode,
  InvitableConsoleRole,
} from '../types/auth.js';

interface AuthScreensProps {
  mode: AuthScreenMode;
  onChangeMode: (mode: AuthScreenMode) => void;
  onAuthenticated: (session: AuthenticatedSession) => void;
}

export const AuthScreens: React.FC<AuthScreensProps> = ({
  mode,
  onChangeMode,
  onAuthenticated,
}) => {
  // State cho Đăng ký (`intro.jpg`) — để trống mặc định, chỉ hiện placeholder chữ mờ gợi ý
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  // State cho Xác nhận email 6 chữ số (`Xác nhận email.jpg`)
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [resendCooldown, setResendCooldown] = useState(60);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);

  // State cho Đặt mật khẩu mới khi được mời (`Đặt lại mk.jpg`)
  const [invitedEmail, setInvitedEmail] = useState('');
  const [invitedRole, setInvitedRole] = useState<InvitableConsoleRole>('REVIEWER');
  const [tempPassword, setTempPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // State cho Quên mật khẩu (2 bước: 1. Nhập email gửi mã -> 2. Nhập mã 6 số + mật khẩu mới)
  const [resetStep, setResetStep] = useState<'REQUEST_CODE' | 'CONFIRM_RESET'>('REQUEST_CODE');
  const [resetCode, setResetCode] = useState('');
  const [resetNewPassword, setResetNewPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');

  // Trạng thái xử lý & thông báo lỗi/thành công
  const [loading, setLoading] = useState(false);
  const [rawError, setRawError] = useState<unknown | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const errorCode =
    rawError && typeof rawError === 'object' && 'code' in rawError
      ? String((rawError as { code?: unknown }).code ?? '')
      : null;

  /**
   * Chuyển màn hình có kiểm soát thông báo (Mục 3 Review):
   * - Khi người dùng tự bấm nút chuyển màn hình (`keepInfo = false`), xóa cả lỗi lẫn thông báo cũ.
   * - Khi tự động chuyển từ Đăng ký sang Xác nhận email (`keepInfo = true`), giữ nguyên `infoMessage` hiển thị mã demo.
   */
  const switchScreenMode = (nextMode: AuthScreenMode, keepInfo = false) => {
    setRawError(null);
    if (!keepInfo) {
      setInfoMessage(null);
    }
    onChangeMode(nextMode);
  };

  const applyError = (err: unknown) => {
    setRawError(err);
  };

  useEffect(() => {
    if (mode !== 'CONFIRM_EMAIL' || resendCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [mode, resendCooldown]);

  // Xử lý nhập từng ô mã xác nhận 6 chữ số
  const handleOtpChange = (index: number, rawVal: string) => {
    setRawError(null);
    const digitsOnly = rawVal.replace(/\D/g, '');
    if (digitsOnly.length > 1) {
      const next = [...otpDigits];
      for (let i = 0; i < 6; i++) {
        next[i] = digitsOnly[i] ?? next[i] ?? '';
      }
      setOtpDigits(next);
      const focusIdx = Math.min(digitsOnly.length, 5);
      otpRefs.current[focusIdx]?.focus();
      return;
    }

    const next = [...otpDigits];
    next[index] = digitsOnly;
    setOtpDigits(next);

    if (digitsOnly && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      otpRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      otpRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  // Submit: Đăng ký (`intro.jpg`)
  const handleSignUpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRawError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await registerAccount({
        fullName,
        email,
        password,
        organizationName,
        acceptedTerms,
      });
      setOtpDigits(['', '', '', '', '', '']);
      setResendCooldown(60);
      const demoCodeSuffix = IS_DEMO_AUTH_MODE
        ? ` (Mã demo: ${res.demoConfirmationCode})`
        : '';
      setInfoMessage(
        `Mã xác nhận 6 chữ số đã được gửi tới ${res.email}${demoCodeSuffix}.`,
      );
      switchScreenMode('CONFIRM_EMAIL', true);
    } catch (err) {
      applyError(err);
    } finally {
      setLoading(false);
    }
  };

  // Submit: Xác nhận email + Refresh Token (`Xác nhận email.jpg`)
  const handleConfirmEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRawError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const code = otpDigits.join('');
      const session = await confirmEmailAndRefreshSession({
        email: email || (IS_DEMO_AUTH_MODE ? 'lan@homestay-abc.example' : ''),
        code,
        password: password || (IS_DEMO_AUTH_MODE ? 'Password123' : ''),
        organizationName: organizationName || (IS_DEMO_AUTH_MODE ? 'Homestay ABC Hội An' : ''),
        fullName: fullName || (IS_DEMO_AUTH_MODE ? 'Nguyễn Thị Lan' : ''),
      });
      onAuthenticated(session);
    } catch (err) {
      applyError(err);
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (resendCooldown > 0) return;
    setRawError(null);
    const targetEmail = email || (IS_DEMO_AUTH_MODE ? 'lan@homestay-abc.example' : '');
    const res = await resendConfirmationCode(targetEmail);
    setResendCooldown(res.expiresInSeconds);
    setOtpDigits(['', '', '', '', '', '']);
    const demoHint = IS_DEMO_AUTH_MODE ? ' (Mã demo: 481926)' : '';
    setInfoMessage(`Đã gửi lại mã xác nhận mới tới ${targetEmail}${demoHint}.`);
  };

  // Submit: Đăng nhập (`log-in.jpg`)
  const handleSignInSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRawError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const outcome = await signInWithEmail({ email, password });
      if (outcome.status === 'CONFIRMATION_REQUIRED') {
        setOrganizationName(outcome.organizationName);
        setInfoMessage('Tài khoản chưa xác nhận email. Vui lòng nhập mã 6 chữ số đã gửi.');
        switchScreenMode('CONFIRM_EMAIL', true);
        return;
      }
      if (outcome.status === 'NEW_PASSWORD_REQUIRED') {
        setInvitedEmail(outcome.email);
        setInvitedRole(outcome.invitedRole);
        setOrganizationName(outcome.organizationName);
        setTempPassword('');
        setNewPassword('');
        setConfirmNewPassword('');
        switchScreenMode('FORCE_CHANGE_PASSWORD');
        return;
      }
      onAuthenticated(outcome.session);
    } catch (err) {
      applyError(err);
    } finally {
      setLoading(false);
    }
  };

  // Submit: Đặt mật khẩu mới khi vào bằng lời mời (`Đặt lại mk.jpg`)
  const handleForceChangePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRawError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const session = await completeInvitedMemberPassword({
        email: invitedEmail || email || (IS_DEMO_AUTH_MODE ? 'minh@homestay-abc.example' : ''),
        temporaryPassword: tempPassword,
        newPassword,
        confirmNewPassword,
        organizationName: organizationName || 'Homestay ABC Hội An',
        invitedRole,
      });
      onAuthenticated(session);
    } catch (err) {
      applyError(err);
    } finally {
      setLoading(false);
    }
  };

  // Submit Bước 1 Quên mật khẩu: Gửi mã khôi phục
  const handleRequestPasswordResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRawError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await requestPasswordResetCode(email);
      setResetStep('CONFIRM_RESET');
      setResetCode('');
      setResetNewPassword('');
      setResetConfirmPassword('');
      const demoHint = IS_DEMO_AUTH_MODE ? ` (Mã demo: ${res.demoResetCode})` : '';
      setInfoMessage(
        `Nếu tài khoản tồn tại, mã đặt lại mật khẩu 6 chữ số đã được gửi tới ${res.email}${demoHint}.`,
      );
    } catch (err) {
      applyError(err);
    } finally {
      setLoading(false);
    }
  };

  // Submit Bước 2 Quên mật khẩu: Xác nhận mã 6 số & mật khẩu mới
  const handleConfirmPasswordResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRawError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      await confirmForgotPasswordReset({
        email,
        code: resetCode,
        newPassword: resetNewPassword,
        confirmNewPassword: resetConfirmPassword,
      });
      setPassword('');
      setResetStep('REQUEST_CODE');
      setInfoMessage('Đặt lại mật khẩu thành công. Vui lòng đăng nhập bằng mật khẩu mới.');
      switchScreenMode('SIGN_IN', true);
    } catch (err) {
      applyError(err);
    } finally {
      setLoading(false);
    }
  };

  const renderLeftHero = () => {
    if (mode === 'SIGN_UP') {
      return (
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-800 leading-tight">
            Tạo tài khoản cho tổ chức của bạn
          </h1>
          <p className="mt-4 text-sm text-gray-500">
            Cổng dịch thuật thông minh cho website và ứng dụng
          </p>
        </div>
      );
    }

    if (mode === 'CONFIRM_EMAIL') {
      return (
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-800 leading-tight">
            Xác nhận địa chỉ email của bạn
          </h1>
          <p className="mt-4 text-sm text-gray-500">
            Cổng dịch thuật thông minh cho website và ứng dụng
          </p>
        </div>
      );
    }

    if (mode === 'FORCE_CHANGE_PASSWORD') {
      return (
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-800 leading-tight">
            Chào mừng đến với {organizationName || 'Homestay ABC Hội An'}
          </h1>
          <p className="mt-4 text-sm text-gray-500">
            Bạn được mời với vai trò {ROLE_DISPLAY_LABEL[invitedRole]}
          </p>
        </div>
      );
    }

    if (mode === 'FORGOT_PASSWORD') {
      return (
        <div>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-800 leading-tight">
            Đặt lại mật khẩu của bạn
          </h1>
          <p className="mt-4 text-sm text-gray-500">
            Cổng dịch thuật thông minh cho website và ứng dụng
          </p>
        </div>
      );
    }

    return (
      <div>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-800 leading-tight">
          Chào mừng quay lại
        </h1>
        <p className="mt-4 text-sm text-gray-500">
          Cổng dịch thuật thông minh cho website và ứng dụng
        </p>
      </div>
    );
  };

  const activeTypedPassword =
    mode === 'FORCE_CHANGE_PASSWORD'
      ? newPassword
      : mode === 'FORGOT_PASSWORD'
        ? resetNewPassword
        : password;
  const pwdCheck = validatePasswordPolicy(activeTypedPassword);

  const renderPasswordPolicyHint = (typedValue: string) => {
    if (!typedValue) {
      return (
        <p className="mt-1.5 text-[11px] text-gray-400">
          Tối thiểu 8 ký tự, có chữ hoa, chữ thường và chữ số
        </p>
      );
    }
    if (pwdCheck.valid) {
      return (
        <p className="mt-1.5 text-[11px] text-[#146c54] font-medium">
          Mật khẩu hợp lệ (đủ 8+ ký tự, chữ hoa, chữ thường và chữ số)
        </p>
      );
    }
    return (
      <p className="mt-1.5 text-[11px] text-amber-600">
        Còn thiếu: {pwdCheck.missingConditions.join(', ')}
      </p>
    );
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col justify-between bg-[#f4f7f6]">
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 lg:px-12 py-12 flex flex-col lg:flex-row items-center justify-between gap-12">
        {/* Cột tiêu đề bên trái */}
        <div className="w-full lg:w-5/12">{renderLeftHero()}</div>

        {/* Thẻ Form bên phải */}
        <div className="w-full max-w-[440px] bg-white rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] border border-gray-100 p-8">
          <ErrorAlert
            error={rawError}
            scope="auth"
            formatMessage={mapCognitoErrorToVietnamese}
            compact
            className="mb-5"
          >
            {errorCode === 'UsernameExistsException' && mode === 'SIGN_UP' && (
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => switchScreenMode('SIGN_IN')}
                  className="font-semibold text-[#146c54] underline hover:text-[#0f5945]"
                >
                  Đăng nhập ngay
                </button>
                <span className="text-gray-300">•</span>
                <button
                  type="button"
                  onClick={() => {
                    setResetStep('REQUEST_CODE');
                    switchScreenMode('FORGOT_PASSWORD');
                  }}
                  className="font-semibold text-[#146c54] underline hover:text-[#0f5945]"
                >
                  Quên mật khẩu?
                </button>
              </div>
            )}
          </ErrorAlert>

          {infoMessage && (
            <div className="mb-5 rounded-lg bg-[#e6f2ee] border border-[#b8dcd0] px-4 py-3 text-xs text-[#146c54] leading-relaxed">
              {infoMessage}
            </div>
          )}

          {/* 1. MÀN ĐĂNG KÝ (`intro.jpg`) */}
          {mode === 'SIGN_UP' && (
            <form onSubmit={handleSignUpSubmit} className="space-y-4" noValidate>
              <h2 className="text-xl font-bold text-gray-800 mb-2">Đăng ký</h2>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Họ và tên
                </label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Tên của bạn"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Email công việc
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email công việc của bạn"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Mật khẩu
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Nhập mật khẩu"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
                {renderPasswordPolicyHint(password)}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Tên tổ chức
                </label>
                <input
                  type="text"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Tên tổ chức hoặc doanh nghiệp của bạn"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <label className="flex items-center gap-2.5 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-[#146c54] focus:ring-[#146c54] accent-[#146c54]"
                />
                <span className="text-xs text-gray-600">
                  Tôi đồng ý với{' '}
                  <span className="text-[#146c54] font-medium underline">
                    Điều khoản sử dụng
                  </span>
                </span>
              </label>

              <button
                type="submit"
                disabled={loading}
                className="w-full mt-2 py-2.5 px-4 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white font-semibold text-sm transition-colors shadow-sm"
              >
                {loading ? 'Đang xử lý...' : 'Tạo tài khoản'}
              </button>

              <p className="text-center text-xs text-gray-400 pt-1">
                Đã có tài khoản?{' '}
                <button
                  type="button"
                  onClick={() => switchScreenMode('SIGN_IN')}
                  className="text-[#146c54] font-semibold underline hover:text-[#0f5945]"
                >
                  Đăng nhập
                </button>
              </p>
            </form>
          )}

          {/* 2. MÀN XÁC NHẬN EMAIL 6 CHỮ SỐ (`Xác nhận email.jpg`) */}
          {mode === 'CONFIRM_EMAIL' && (
            <form onSubmit={handleConfirmEmailSubmit} className="space-y-4" noValidate>
              <div>
                <h2 className="text-xl font-bold text-gray-800">Xác nhận email</h2>
                <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
                  Mã gồm 6 chữ số đã được gửi tới{' '}
                  <span className="font-semibold text-gray-700">
                    {email || 'email của bạn'}
                  </span>
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-2">
                  Mã xác nhận
                </label>
                <div className="flex items-center justify-between gap-2">
                  {otpDigits.map((digit, idx) => (
                    <input
                      key={idx}
                      ref={(el) => {
                        otpRefs.current[idx] = el;
                      }}
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={digit}
                      placeholder="•"
                      onChange={(e) => handleOtpChange(idx, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                      aria-label={`Chữ số thứ ${idx + 1}`}
                      className="w-12 h-12 rounded-lg border border-gray-300 text-center text-base font-bold text-gray-800 placeholder:text-gray-300 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                    />
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white font-semibold text-sm transition-colors shadow-sm"
              >
                {loading ? 'Đang xác nhận & tạo tổ chức...' : 'Xác nhận'}
              </button>

              <div className="flex items-center gap-2 text-xs text-gray-500 pt-1">
                <span>Chưa nhận được mã?</span>
                <button
                  type="button"
                  onClick={handleResendCode}
                  disabled={resendCooldown > 0}
                  className="px-2.5 py-1 rounded border border-gray-300 font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-60"
                >
                  Gửi lại mã
                </button>
                {resendCooldown > 0 && (
                  <span className="text-gray-400">(sau {resendCooldown} giây)</span>
                )}
              </div>

              <p className="text-[11px] text-gray-400 leading-relaxed pt-2 border-t border-gray-100">
                Sau khi xác nhận, hệ thống tạo tổ chức{' '}
                <span className="font-semibold text-gray-600">
                  {organizationName || 'của bạn'}
                </span>{' '}
                với gói dịch vụ Free và gán bạn vai trò Tenant Admin.
              </p>
            </form>
          )}

          {/* 3. MÀN ĐĂNG NHẬP (`log-in.jpg`) */}
          {mode === 'SIGN_IN' && (
            <form onSubmit={handleSignInSubmit} className="space-y-4" noValidate>
              <h2 className="text-xl font-bold text-gray-800 mb-2">Đăng nhập</h2>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email của bạn"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Mật khẩu
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mật khẩu của bạn"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white font-semibold text-sm transition-colors shadow-sm"
              >
                {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
              </button>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setResetStep('REQUEST_CODE');
                    switchScreenMode('FORGOT_PASSWORD');
                  }}
                  className="text-xs font-medium text-[#146c54] underline hover:text-[#0f5945]"
                >
                  Quên mật khẩu?
                </button>
              </div>
            </form>
          )}

          {/* 4. MÀN ĐẶT MẬT KHẨU MỚI KHI ĐƯỢC MỜI (`Đặt lại mk.jpg`) */}
          {mode === 'FORCE_CHANGE_PASSWORD' && (
            <form onSubmit={handleForceChangePasswordSubmit} className="space-y-4" noValidate>
              <h2 className="text-xl font-bold text-gray-800 mb-2">Đặt mật khẩu mới</h2>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Mật khẩu tạm thời
                </label>
                <input
                  type="password"
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                  placeholder="Nhập mật khẩu tạm thời trong email mời"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Mật khẩu mới
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Nhập mật khẩu mới"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
                {renderPasswordPolicyHint(newPassword)}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Nhập lại mật khẩu mới
                </label>
                <input
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  placeholder="Nhập lại mật khẩu mới"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white font-semibold text-sm transition-colors shadow-sm"
              >
                {loading ? 'Đang cập nhật...' : 'Đặt mật khẩu và vào web console'}
              </button>
            </form>
          )}

          {/* 5. MÀN QUÊN MẬT KHẨU (Đủ 2 bước: Nhập email nhận mã -> Nhập mã 6 số & đặt mật khẩu mới) */}
          {mode === 'FORGOT_PASSWORD' && resetStep === 'REQUEST_CODE' && (
            <form onSubmit={handleRequestPasswordResetSubmit} className="space-y-4" noValidate>
              <h2 className="text-xl font-bold text-gray-800 mb-1">Quên mật khẩu</h2>
              <p className="text-xs text-gray-500">
                Nhập email công việc của bạn để nhận mã khôi phục mật khẩu gồm 6 chữ số.
              </p>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Email công việc của bạn"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white font-semibold text-sm transition-colors"
              >
                {loading ? 'Đang gửi mã...' : 'Gửi mã khôi phục'}
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => switchScreenMode('SIGN_IN')}
                  className="text-xs font-medium text-[#146c54] underline"
                >
                  Quay lại đăng nhập
                </button>
              </div>
            </form>
          )}

          {mode === 'FORGOT_PASSWORD' && resetStep === 'CONFIRM_RESET' && (
            <form onSubmit={handleConfirmPasswordResetSubmit} className="space-y-4" noValidate>
              <h2 className="text-xl font-bold text-gray-800 mb-1">Đặt lại mật khẩu mới</h2>
              <p className="text-xs text-gray-500">
                Nhập mã khôi phục 6 chữ số đã gửi tới{' '}
                <span className="font-semibold text-gray-700">{email}</span> và mật khẩu mới.
              </p>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Mã khôi phục (6 chữ số)
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="Nhập mã 6 chữ số"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Mật khẩu mới
                </label>
                <input
                  type="password"
                  value={resetNewPassword}
                  onChange={(e) => setResetNewPassword(e.target.value)}
                  placeholder="Nhập mật khẩu mới"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
                {renderPasswordPolicyHint(resetNewPassword)}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Nhập lại mật khẩu mới
                </label>
                <input
                  type="password"
                  value={resetConfirmPassword}
                  onChange={(e) => setResetConfirmPassword(e.target.value)}
                  placeholder="Nhập lại mật khẩu mới"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 px-4 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white font-semibold text-sm transition-colors"
              >
                {loading ? 'Đang cập nhật...' : 'Xác nhận đặt lại mật khẩu'}
              </button>

              <div className="flex items-center justify-between text-xs pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setRawError(null);
                    setResetStep('REQUEST_CODE');
                  }}
                  className="text-gray-500 underline hover:text-gray-700"
                >
                  Đổi địa chỉ email
                </button>
                <button
                  type="button"
                  onClick={() => switchScreenMode('SIGN_IN')}
                  className="font-medium text-[#146c54] underline"
                >
                  Quay lại đăng nhập
                </button>
              </div>
            </form>
          )}
        </div>
      </main>

      {/* Thanh chuyển nhanh màn hình phục vụ kiểm thử / demo các trạng thái Q1 (Chỉ hiển thị khi VITE_AUTH_MODE=mock) */}
      {IS_DEMO_AUTH_MODE && (
        <footer className="border-t border-gray-200/80 bg-white/70 px-6 py-3">
          <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-gray-600">Chuyển nhanh màn hình Q1:</span>
              {(
                [
                  ['SIGN_UP', '1. Đăng ký'],
                  ['CONFIRM_EMAIL', '2. Xác nhận email 6 số'],
                  ['SIGN_IN', '3. Đăng nhập'],
                  ['FORCE_CHANGE_PASSWORD', '4. Đặt mật khẩu mới (Lời mời)'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchScreenMode(m)}
                  className={`px-2.5 py-1 rounded-md border transition-colors ${
                    mode === m
                      ? 'bg-[#e6f2ee] border-[#146c54] text-[#146c54] font-semibold'
                      : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-gray-400">
              Tài khoản mẫu để thử đăng nhập: lan@homestay-abc.example / Password123 (Mã OTP: 481926)
            </span>
          </div>
        </footer>
      )}
    </div>
  );
};
