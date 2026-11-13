export type SiteVerificationMethod = 'META' | 'FILE';

export function verificationMethod(raw: string | undefined): SiteVerificationMethod {
  const method = (raw ?? 'META').trim().toUpperCase();
  if (method !== 'META' && method !== 'FILE') {
    throw new Error(`TM_DEMO_VERIFY_METHOD phải là META hoặc FILE (nhận được: ${raw})`);
  }
  return method;
}

export function verificationInstructions(
  method: SiteVerificationMethod,
  token: string,
  origin: string,
): string {
  if (method === 'FILE') {
    const fileUrl = new URL('/translateme-verification.txt', origin).toString();
    return `Đặt nguyên văn token sau vào ${fileUrl} (text/plain, không JSON/HTML): ${token}`;
  }
  return `Chèn thẻ sau vào <head> của trang chủ ${origin}: <meta name="translateme-site-verification" content="${token}">`;
}
