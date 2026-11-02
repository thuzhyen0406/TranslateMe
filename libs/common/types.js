export class AppError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'AppError';
    }
}
export const keys = {
    config: (ctx) => ({ PK: `TENANT#${ctx.tenantId}`, SK: 'CONFIG' }),
    member: (ctx, sub) => ({ PK: `TENANT#${ctx.tenantId}`, SK: `MEMBER#${sub}` }),
    host: (ctx, slug) => ({ PK: `TENANT#${ctx.tenantId}`, SK: `HOST#${slug}` }),
    gloss: (ctx, normalized) => ({ PK: `TENANT#${ctx.tenantId}#GLOSS`, SK: `TERM#${normalized}` }),
    // Các khóa nền tảng chỉ sử dụng bởi module quản lý website và resolver
    slug: (slug) => ({ PK: `TENANT#PLATFORM#SLUG#${slug}`, SK: 'META' }),
    keymap: (keyId) => ({ PK: `TENANT#PLATFORM#KEY#${keyId}`, SK: 'META' }),
};
