import { createHash } from 'node:crypto';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function slugFromHostname(hostname: string): string {
  const canonical = hostname.toLowerCase().replace(/\.$/, '');
  const base = canonical.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (/^[a-z0-9]+(?:\.[a-z0-9]+)*$/.test(canonical) && SLUG_RE.test(base)) return base;
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  const prefix = base.slice(0, 45).replace(/-$/, '') || 'site';
  return `${prefix}--${suffix}`;
}
