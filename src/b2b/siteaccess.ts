import { type Firestore, FieldValue } from 'firebase-admin/firestore';
import { deriveVisitorId } from './visitor-id';

/**
 * `siteAccess/{visitorId}` records, scoped per tenant, are the
 * source of truth for "which B2C visitors have entered this B2B
 * customer's site". The widget's session-check endpoint creates
 * the record lazily on first detection — no explicit grant flow
 * required. Revocation is a soft-delete: the document stays for
 * audit but `revokedAt` is set, and the chat / profile endpoints
 * check for null before responding.
 *
 * Cascade revoke (Track 4 U2): when a user deletes their data in
 * Track 1, a Cloud Function trigger scans every tenant namespace
 * and sets `revokedAt` for any siteAccess with `contextLayerUid ==
 * uid`. The query uses a composite index on
 * `(contextLayerUid, revokedAt)` for fast enumeration.
 *
 * Schema (per tenant):
 *   b2bTenants/{tenantId}/siteAccess/{visitorId}
 *     contextLayerUid: string     // for cascade revoke lookup
 *     tenantId: string             // denormalized for index clarity
 *     grantedAt: Timestamp
 *     revokedAt: Timestamp | null
 *     lastSeenAt: Timestamp
 *     accessCount: number
 *     accessLog/{timestamp}        // subcollection for per-fetch audit
 *       endpoint: string
 *       durationMs: number
 */

export interface SiteAccessRecord {
  contextLayerUid: string;
  tenantId: string;
  grantedAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date;
  accessCount: number;
}

/**
 * Look up an existing siteAccess record. Returns null when the
 * visitor has never been seen on this tenant.
 */
export async function getSiteAccess(
  db: Firestore,
  tenantId: string,
  visitorId: string,
): Promise<SiteAccessRecord | null> {
  const ref = db.collection('b2bTenants').doc(tenantId).collection('siteAccess').doc(visitorId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as {
    contextLayerUid?: unknown;
    tenantId?: unknown;
    grantedAt?: unknown;
    revokedAt?: unknown;
    lastSeenAt?: unknown;
    accessCount?: unknown;
  };
  return {
    contextLayerUid: typeof data.contextLayerUid === 'string' ? data.contextLayerUid : '',
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : tenantId,
    grantedAt: toDate(data.grantedAt) ?? new Date(0),
    revokedAt: toDate(data.revokedAt),
    lastSeenAt: toDate(data.lastSeenAt) ?? new Date(0),
    accessCount: typeof data.accessCount === 'number' ? data.accessCount : 0,
  };
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (v && typeof v === 'object' && 'toDate' in v && typeof (v as { toDate: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate();
  }
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Ensure a siteAccess record exists for `(tenantId, visitorId)`.
 * Creates with `grantedAt = now` if missing; if it already exists
 * but was revoked (`revokedAt != null`), leave it as-is — the
 * session-check endpoint should treat a revoked visitor as
 * "not connected" and not silently re-create the grant.
 *
 * Returns the resulting record.
 */
export async function ensureSiteAccess(
  db: Firestore,
  tenantId: string,
  visitorId: string,
  contextLayerUid: string,
): Promise<{ record: SiteAccessRecord; created: boolean; revoked: boolean }> {
  const existing = await getSiteAccess(db, tenantId, visitorId);
  if (existing) {
    if (existing.revokedAt) {
      return { record: existing, created: false, revoked: true };
    }
    // Already granted; touch lastSeenAt and bump accessCount.
    const ref = db.collection('b2bTenants').doc(tenantId).collection('siteAccess').doc(visitorId);
    await ref.update({
      lastSeenAt: FieldValue.serverTimestamp(),
      accessCount: FieldValue.increment(1),
    });
    return {
      record: {
        ...existing,
        lastSeenAt: new Date(),
        accessCount: existing.accessCount + 1,
      },
      created: false,
      revoked: false,
    };
  }

  const now = new Date();
  const record: SiteAccessRecord = {
    contextLayerUid,
    tenantId,
    grantedAt: now,
    revokedAt: null,
    lastSeenAt: now,
    accessCount: 1,
  };
  await db.collection('b2bTenants').doc(tenantId).collection('siteAccess').doc(visitorId).set(record);
  return { record, created: true, revoked: false };
}

/**
 * Soft-revoke a siteAccess record. Idempotent — a no-op when the
 * document is missing or already revoked.
 */
export async function revokeSiteAccess(
  db: Firestore,
  tenantId: string,
  visitorId: string,
): Promise<void> {
  const ref = db.collection('b2bTenants').doc(tenantId).collection('siteAccess').doc(visitorId);
  const snap = await ref.get();
  if (!snap.exists) return;
  await ref.update({ revokedAt: FieldValue.serverTimestamp() });
}

/**
 * Cascade revoke every siteAccess record for a given contextLayerUid
 * across all tenants. Used by the Track 4 Cloud Function trigger when
 * a user deletes their data.
 *
 * Cost: one `collectionGroup('siteAccess').where('contextLayerUid', '==', uid).get()`
 * which requires a composite index. For V1 this is acceptable; if
 * the user base grows past ~10k active visitors with multi-tenant
 * access, switch to per-tenant enumeration.
 */
export async function revokeAllForUser(
  db: Firestore,
  uid: string,
): Promise<{ revoked: number }> {
  // Firestore collectionGroup queries require the index to be
  // deployed. If the index is missing, this throws — V1 callers
  // wrap in try/catch and fall back to per-tenant enumeration.
  const snap = await db.collectionGroup('siteAccess').where('contextLayerUid', '==', uid).get();
  if (snap.size === 0) return { revoked: 0 };
  const batch = db.batch();
  for (const d of snap.docs) {
    batch.update(d.ref, { revokedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  return { revoked: snap.size };
}

/**
 * High-level helper for the widget's session-check endpoint.
 * Given a verified uid (from Firebase session cookie) and a
 * tenantId (from the query param), derive the visitorId and
 * ensure the siteAccess record exists. Returns the canonical
 * response shape for the route.
 */
export interface SessionCheckResult {
  authenticated: true;
  visitorId: string;
  created: boolean;
}

export async function sessionCheck(
  db: Firestore,
  uid: string,
  tenantId: string,
): Promise<SessionCheckResult | { authenticated: false; signInUrl: string }> {
  const visitorId = deriveVisitorId(uid, tenantId);
  const { record, created } = await ensureSiteAccess(db, tenantId, visitorId, uid);
  if (record.revokedAt) {
    // User revoked this tenant's access. Do not re-grant.
    return {
      authenticated: false,
      signInUrl: `https://auth.contextlayer.io/connect?tenant=${encodeURIComponent(tenantId)}`,
    };
  }
  return { authenticated: true, visitorId, created };
}