import React, { useEffect, useState } from 'react';
import {
  inviteTenantMember,
  listTenantMembers,
  mapCognitoErrorToVietnamese,
  ROLE_DISPLAY_LABEL,
} from '../services/cognitoAuth.js';
import type {
  AuthenticatedSession,
  InvitableConsoleRole,
  TenantMember,
} from '../types/auth.js';

interface MembersPageProps {
  session: AuthenticatedSession;
}

export const MembersPage: React.FC<MembersPageProps> = ({ session }) => {
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InvitableConsoleRole>('REVIEWER');
  const [modalError, setModalError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listTenantMembers().then(setMembers);
  }, []);

  const handleInviteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError(null);
    setSuccessBanner(null);
    setSubmitting(true);
    try {
      const res = await inviteTenantMember(
        session.role,
        inviteEmail,
        inviteRole,
        session.organizationName,
      );
      const updated = await listTenantMembers();
      setMembers(updated);
      setIsModalOpen(false);
      setInviteEmail('');
      setSuccessBanner(
        `Đã gửi email mời tới ${res.member.email} với vai trò ${ROLE_DISPLAY_LABEL[res.member.role]} (Mật khẩu tạm thời: ${res.temporaryPassword}).`,
      );
    } catch (err) {
      setModalError(mapCognitoErrorToVietnamese(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-6xl">
      {/* Tiêu đề trang Thành viên */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Thành viên</h1>
        <p className="mt-1 text-xs text-gray-500">
          Mời Developer hoặc Reviewer tham gia tổ chức {session.organizationName}
        </p>
      </div>

      {successBanner && (
        <div className="mb-5 rounded-lg bg-[#e6f2ee] border border-[#b8dcd0] px-4 py-3 text-xs text-[#146c54] flex items-center justify-between">
          <span>{successBanner}</span>
          <button
            type="button"
            onClick={() => setSuccessBanner(null)}
            className="font-semibold underline ml-4"
          >
            Đóng
          </button>
        </div>
      )}

      {/* Bảng danh sách thành viên */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <span className="text-sm font-bold text-gray-800">
            {members.length} thành viên
          </span>
          {session.role === 'TENANT_ADMIN' && (
            <button
              type="button"
              onClick={() => {
                setModalError(null);
                setInviteEmail('');
                setIsModalOpen(true);
              }}
              className="px-4 py-2 rounded-lg bg-[#146c54] hover:bg-[#0f5945] text-white text-xs font-semibold transition-colors shadow-sm"
            >
              + Mời thành viên
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-100 text-xs font-medium text-gray-400">
                <th className="py-3.5 px-6">Email</th>
                <th className="py-3.5 px-6">Vai trò</th>
                <th className="py-3.5 px-6">Trạng thái</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-sm">
              {members.map((m) => (
                <tr key={m.id} className="hover:bg-gray-50/70 transition-colors">
                  <td className="py-4 px-6 font-medium text-gray-800">{m.email}</td>
                  <td className="py-4 px-6">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[#e6f2ee] text-[#146c54]">
                      {ROLE_DISPLAY_LABEL[m.role]}
                    </span>
                  </td>
                  <td className="py-4 px-6 text-gray-600 text-xs font-medium">
                    {m.status === 'ACTIVE' ? 'Hoạt động' : 'Chờ đăng nhập lần đầu'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal "Mời thành viên" */}
      {isModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-modal-title"
        >
          <div className="w-full max-w-[520px] bg-white rounded-xl shadow-2xl border border-gray-100 p-7">
            <h2
              id="invite-modal-title"
              className="text-lg font-bold text-gray-800 mb-4"
            >
              Mời thành viên
            </h2>

            {modalError && (
              <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-3.5 py-2.5 text-xs text-red-700">
                {modalError}
              </div>
            )}

            <form onSubmit={handleInviteSubmit} className="space-y-4" noValidate>
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="Email của thành viên cần mời"
                  className="w-full rounded-lg border border-gray-300 px-3.5 py-2.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-[#146c54] focus:outline-none focus:ring-2 focus:ring-[#146c54]/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                  Vai trò
                </label>
                <div className="w-full rounded-lg border border-gray-300 px-4 py-2.5 flex items-center gap-6">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                    <input
                      type="radio"
                      name="inviteRole"
                      checked={inviteRole === 'DEVELOPER'}
                      onChange={() => setInviteRole('DEVELOPER')}
                      className="h-4 w-4 text-[#146c54] focus:ring-[#146c54] accent-[#146c54]"
                    />
                    <span>Developer</span>
                  </label>

                  <label className="inline-flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                    <input
                      type="radio"
                      name="inviteRole"
                      checked={inviteRole === 'REVIEWER'}
                      onChange={() => setInviteRole('REVIEWER')}
                      className="h-4 w-4 text-[#146c54] focus:ring-[#146c54] accent-[#146c54]"
                    />
                    <span>Reviewer</span>
                  </label>
                </div>
                <p className="mt-2 text-[11px] text-gray-400">
                  Hệ thống gửi email chứa liên kết vào web console và mật khẩu tạm thời.
                </p>
              </div>

              <div className="pt-3 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 text-xs font-semibold transition-colors"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg bg-[#146c54] hover:bg-[#0f5945] disabled:opacity-60 text-white text-xs font-semibold transition-colors shadow-sm"
                >
                  {submitting ? 'Đang gửi...' : 'Gửi lời mời'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
