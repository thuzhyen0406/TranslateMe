import { Ctx, AppError, keys, Lang } from '../../../libs/common/types.js';
import { db } from '../../../libs/common/db.js';
import {
  defaultResolver,
  isBlockedIp,
  safeFetch,
  validateUrl,
  type Resolver,
} from '../../../libs/common/safeFetch.js';

const TABLE_NAME = process.env.TABLE_NAME || 'translate-data';

export interface CreateSiteInput {
  homeUrl: string;
  displayName: string;
  sourceLang: Lang;
  targetLangs: Lang[];
  noTranslateSelectors?: string[];
  cacheTtlSec?: number;
}

export interface SiteManagerDependencies {
  db: Pick<typeof db, 'transact' | 'get' | 'put'>;
  resolver: Resolver;
  safeFetch: typeof safeFetch;
}

const defaultDependencies: SiteManagerDependencies = { db, resolver: defaultResolver, safeFetch };

async function validatePublicUrl(urlStr: string, resolver: Resolver): Promise<URL> {
  const result = validateUrl(urlStr);
  if (!result.ok) {
    const code = result.reason === 'PRIVATE_IP' ? 'FORBIDDEN' : 'SITE_UNREACHABLE';
    throw new AppError(code, `URL không hợp lệ hoặc không được phép: ${result.detail}`);
  }

  if (result.ipLiteral) {
    if (isBlockedIp(result.ipLiteral)) {
      throw new AppError('FORBIDDEN', 'Không chấp nhận địa chỉ IP nội bộ hoặc không công khai');
    }
    return result.url;
  }

  const hostname = result.url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new AppError('FORBIDDEN', 'Không chấp nhận tên máy chủ nội bộ');
  }

  let addresses;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new AppError('SITE_UNREACHABLE', 'Không thể phân giải tên miền');
  }

  if (addresses.length === 0) {
    throw new AppError('SITE_UNREACHABLE', 'Tên miền không có địa chỉ IP');
  }
  if (addresses.some(({ address }) => isBlockedIp(address))) {
    throw new AppError('FORBIDDEN', 'Tên miền phân giải tới địa chỉ IP nội bộ hoặc không công khai');
  }

  return result.url;
}

export async function createSite(
  ctx: Ctx,
  input: CreateSiteInput,
  deps: SiteManagerDependencies = defaultDependencies,
) {
  const url = await validatePublicUrl(input.homeUrl, deps.resolver);
  
  // Sinh slug chuẩn hóa từ hostname
  const slug = url.hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const verificationCode = `translateme-verify-${Math.random().toString(36).substring(2, 10)}`;

  // Tạo TransactWriteItems nguyên tử cho SLUG hệ thống và HOST tenant
  const transactOps = [
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#PLATFORM#SLUG#${slug}`,
          SK: 'META',
          tenantId: ctx.tenantId,
          createdAt: new Date().toISOString()
        },
        ConditionExpression: 'attribute_not_exists(PK)' // Đảm bảo slug duy nhất toàn hệ thống
      }
    },
    {
      Put: {
        TableName: TABLE_NAME,
        Item: {
          PK: `TENANT#${ctx.tenantId}`,
          SK: `HOST#${slug}`,
          slug,
          homeUrl: input.homeUrl,
          displayName: input.displayName,
          sourceLang: input.sourceLang,
          targetLangs: input.targetLangs,
          noTranslateSelectors: input.noTranslateSelectors || [],
          verificationCode,
          status: 'PENDING',
          createdAt: new Date().toISOString()
        },
        ConditionExpression: 'attribute_not_exists(SK)'
      }
    }
  ];

  try {
    await deps.db.transact(ctx, transactOps);
  } catch (err: any) {
    if (err.name === 'TransactionCanceledException') {
      throw new AppError('DUPLICATE_SLUG', 'Slug đã tồn tại trên hệ thống');
    }
    throw err;
  }

  return { slug, status: 'PENDING' as const, verificationCode };
}

export async function verifySite(
  ctx: Ctx,
  slug: string,
  method: 'META' | 'FILE',
  deps: SiteManagerDependencies = defaultDependencies,
) {
  const hostKey = keys.host(ctx, slug);
  const host = await deps.db.get(ctx, hostKey);

  if (!host) {
    throw new AppError('SITE_UNREACHABLE', 'Không tìm thấy thông tin website');
  }

  const verificationCode = host.verificationCode;
  const homeUrl = host.homeUrl;

  try {
    if (method === 'META') {
      // Tải trang chủ thông qua safeFetch chống SSRF
      const res = await deps.safeFetch(homeUrl, { maxSizeBytes: 3000000, timeoutMs: 5000, maxRedirects: 3 });
      if (res.kind !== 'OK') {
        throw new AppError('SITE_UNREACHABLE', `Không thể tải trang xác minh: ${res.kind}`, {
          reason: res.kind
        });
      } 
      const expectedMeta = `<meta name="translateme-site-verification" content="${verificationCode}"`;
      
      if (!res.html.includes(expectedMeta)) {
        throw new AppError('VERIFICATION_CODE_MISMATCH', 'Không tìm thấy thẻ meta xác minh hoặc mã không khớp', {
          reason: 'VERIFICATION_CODE_MISMATCH'
        });
      }
    } else if (method === 'FILE') {
      const fileUrl = new URL('/translateme-verification.txt', homeUrl).toString();
      const res = await deps.safeFetch(fileUrl, { maxSizeBytes: 10000, timeoutMs: 5000, maxRedirects: 3 });
      if (res.kind !== 'OK') {
        throw new AppError('SITE_UNREACHABLE', `Không thể tải file xác minh: ${res.kind}`, {
          reason: res.kind
        });
      }

      if (res.html.trim() !== verificationCode) {
        throw new AppError('VERIFICATION_CODE_MISMATCH', 'Nội dung file xác minh không chính xác', {
          reason: 'VERIFICATION_CODE_MISMATCH'
        });
      }
    }
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError('SITE_UNREACHABLE', `Lỗi truy cập website: ${err.message}`, {
      reason: 'SITE_UNREACHABLE'
    });
  }

  // Cập nhật trạng thái PENDING -> ACTIVE
  await deps.db.put(ctx, {
    ...host,
    status: 'ACTIVE',
    updatedAt: new Date().toISOString()
  });

  return { status: 'ACTIVE' as const };
}