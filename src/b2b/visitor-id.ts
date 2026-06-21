import { createHash } from 'node:crypto';

/**
 * Visitor ID derivation for the Track 2 widget + Track 4 context
 * injection surface.
 *
 * Format: `vs_<12 chars base62>`.
 * Derivation: SHA-256(uid:tenantId) → first 12 hex chars → re-encode
 * to base62 to avoid the ambiguity of hex (0-9a-f vs 0-9A-F vs
 * O vs 0). Deterministic and cross-tenant unique: the same uid
 * yields `vs_aaa` for tenant X and `vs_bbb` for tenant Y. The B2B
 * customer never sees the underlying uid.
 *
 * Why base62 instead of hex: the visitor ID is part of a URL
 * path/query that may appear in browser logs and analytics. Hex is
 * case-insensitive in practice, so `vs_abc` and `vs_ABC` look the
 * same to humans but are different strings. Base62 is unambiguous.
 */

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function hexToBase62(hex: string): string {
  // BigInt to avoid JS number precision loss for large values.
  let n = BigInt('0x' + hex);
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = BASE62_ALPHABET[Number(n % 62n)] + out;
    n = n / 62n;
  }
  return out;
}

export function deriveVisitorId(uid: string, tenantId: string): string {
  const hex = createHash('sha256').update(`${uid}:${tenantId}`).digest('hex');
  // Take 10 hex chars = 40 bits of entropy. base62 of that gives us
  // ~7-8 chars; pad to 12 for the canonical `vs_<12 chars>` shape.
  const slice = hex.slice(0, 10);
  const base62 = hexToBase62(slice).padStart(8, '0');
  // Append 4 deterministic chars derived from a second hash of the
  // full hex so the visitor ID can't be predicted by a partial
  // collision on the first 10 hex chars.
  const salt = createHash('sha256').update(hex).digest('hex').slice(0, 6);
  const suffix = hexToBase62(salt).padStart(4, '0');
  return `vs_${base62}${suffix}`;
}

/**
 * Reverse-lookup helper used by the dev-only `/api/v1/b2b/profile`
 * fallback in U6. Given a visitor ID and a known uid, returns the
 * tenantId that maps to that pair (or null if no match). Only
 * useful for tests + the Admin SDK fallback path; production code
 * resolves tenantId from the tenant API key and uid from the
 * siteAccess record directly.
 */
export function tenantIdForVisitor(visitorId: string, uid: string, knownTenantIds: string[]): string | null {
  for (const t of knownTenantIds) {
    if (deriveVisitorId(uid, t) === visitorId) return t;
  }
  return null;
}