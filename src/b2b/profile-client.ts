import { type Firestore } from 'firebase-admin/firestore';

/**
 * Visitor profile fetch.
 *
 * Plan 002 originally routed profile reads through the Plan 004
 * B2B profile endpoint (`GET /api/v1/b2b/profile?visitor_id=...`).
 * Track 2's U6 will call that endpoint once Plan 004 is merged.
 *
 * Until then, we read directly from the Track 1 profile store
 * (`users/{uid}/profile/main`) using the Admin SDK. The uid is
 * recovered from the siteAccess row that `widget-session-check`
 * wrote, which is the same source of truth Plan 004 will use.
 *
 * Returns `null` when the user has no profile yet (they haven't
 * imported any data) — the chat route should still function, just
 * with a leaner system prompt.
 */

import { getSiteAccess } from './siteaccess';

export interface B2BProfile {
  uid: string;
  updatedAt: string;
  preferences: Array<{ value: string; source: string }>;
  personalFacts: Array<{ value: string; source: string }>;
  activeIntentions: Array<{ value: string; source: string }>;
  domainsOfInterest: Array<{ value: string; source: string }>;
}

export interface FetchProfileOptions {
  tenantId: string;
  visitorId: string;
  fetcher?: typeof fetchProfileViaApi;
}

export async function fetchB2BProfile(
  db: Firestore,
  opts: FetchProfileOptions,
): Promise<B2BProfile | null> {
  if (opts.fetcher) {
    try {
      return await opts.fetcher(opts.tenantId, opts.visitorId);
    } catch {
      // fall through to Admin SDK fallback
    }
  }
  return fetchProfileViaAdmin(db, opts.tenantId, opts.visitorId);
}

/**
 * Plan 004 endpoint shim. v1: not implemented. Returns `null`
 * so the caller falls through to the Admin SDK path. The real
 * implementation lives in the Plan 004 branch and will replace
 * this stub when the cross-track merge lands.
 */
export async function fetchProfileViaApi(
  _tenantId: string,
  _visitorId: string,
): Promise<B2BProfile | null> {
  return null;
}

async function fetchProfileViaAdmin(
  db: Firestore,
  tenantId: string,
  visitorId: string,
): Promise<B2BProfile | null> {
  const siteAccess = await getSiteAccess(db, tenantId, visitorId);
  if (!siteAccess) return null;
  const uid = siteAccess.contextLayerUid;
  const profileRef = db.collection('users').doc(uid).collection('profile').doc('main');
  const snap = await profileRef.get();
  if (!snap.exists) return null;
  const data = snap.data() as Record<string, unknown>;
  return normalizeProfile(uid, data);
}

function normalizeProfile(uid: string, raw: Record<string, unknown>): B2BProfile {
  const updatedAtRaw = raw.updatedAt;
  let updatedAt: string;
  if (updatedAtRaw && typeof (updatedAtRaw as { toDate?: () => Date }).toDate === 'function') {
    updatedAt = (updatedAtRaw as { toDate: () => Date }).toDate().toISOString();
  } else if (updatedAtRaw instanceof Date) {
    updatedAt = updatedAtRaw.toISOString();
  } else if (typeof updatedAtRaw === 'string') {
    updatedAt = updatedAtRaw;
  } else {
    updatedAt = new Date(0).toISOString();
  }
  return {
    uid,
    updatedAt,
    preferences: arrayOf(raw.preferences),
    personalFacts: arrayOf(raw.personalFacts),
    activeIntentions: arrayOf(raw.activeIntentions),
    domainsOfInterest: arrayOf(raw.domainsOfInterest),
  };
}

function arrayOf(v: unknown): Array<{ value: string; source: string }> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => x && typeof x === 'object' && 'value' in (x as Record<string, unknown>))
    .map((x) => {
      const r = x as { value: unknown; source?: unknown };
      return {
        value: typeof r.value === 'string' ? r.value : String(r.value ?? ''),
        source: typeof r.source === 'string' ? r.source : 'unknown',
      };
    });
}
