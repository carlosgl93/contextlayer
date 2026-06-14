import { type Firestore } from 'firebase-admin/firestore';

/**
 * `users/{uid}/siteAccess/{siteId}` records which third-party sites
 * the user has authorized to read their context profile. This module
 * is intentionally minimal in V1: there is no grant endpoint, only
 * list and revoke. The collection may be empty for most users; queries
 * return `[]` in that case.
 */

export interface SiteAccessRecord {
  siteId: string;
  grantedAt: string | null;
  active: boolean;
}

/**
 * Return every `siteAccess` document under the user that is currently
 * `active: true`. Revoked (`active: false`) docs are excluded — they
 * remain in storage for audit but are not surfaced to clients.
 */
export async function listActiveAccess(
  db: Firestore,
  uid: string,
): Promise<SiteAccessRecord[]> {
  const col = db.collection('users').doc(uid).collection('siteAccess');
  const snap = await col.where('active', '==', true).get();
  return snap.docs.map((d) => {
    const data = d.data() as { grantedAt?: unknown; active?: unknown };
    return {
      siteId: d.id,
      grantedAt: data.grantedAt instanceof Date ? data.grantedAt.toISOString() : null,
      active: data.active === true,
    };
  });
}

/**
 * Set `active: false` on `users/{uid}/siteAccess/{siteId}` — a soft
 * delete that preserves the document for audit. Idempotent: a no-op
 * when the doc is missing (we do not create it).
 */
export async function deactivateAccess(
  db: Firestore,
  uid: string,
  siteId: string,
): Promise<void> {
  const ref = db.collection('users').doc(uid).collection('siteAccess').doc(siteId);
  const snap = await ref.get();
  if (!snap.exists) return;
  await ref.update({ active: false });
}

/**
 * Hard-delete every `siteAccess` document under the user. Used by
 * the full data wipe. Idempotent.
 */
export async function deleteAllAccess(db: Firestore, uid: string): Promise<{ deleted: number }> {
  const col = db.collection('users').doc(uid).collection('siteAccess');
  const snap = await col.get();
  if (snap.size === 0) return { deleted: 0 };
  const batch = db.batch();
  for (const d of snap.docs) {
    batch.delete(d.ref);
  }
  await batch.commit();
  return { deleted: snap.size };
}
