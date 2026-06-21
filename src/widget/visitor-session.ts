import type { SessionCheckResult, WidgetConfig } from './types';

/**
 * Visitor session helpers.
 *
 * The widget calls two endpoints on mount:
 *   1. `GET /api/v1/widget/config?tenant=X` with the tenant's
 *      API key in `Authorization: Bearer`. This returns branding,
 *      system prompt, allowed providers, and rate limit.
 *   2. `GET /api/v1/widget/session-check?tenant=X` with
 *      `credentials: 'include'` so the `__Host-context-layer-session`
 *      cookie travels cross-origin. Returns either a visitorId
 *      (and creates a siteAccess row) or a signInUrl for the
 *      implicit-auth popup.
 *
 * The visitorId is also cached in `sessionStorage` under
 * `contextlayer.${tenantId}.visitorId` so the widget does not
 * re-call session-check on every page navigation within the SPA.
 * sessionStorage clears when the tab closes — that matches the
 * lifetime of the user session in the same tab and is consistent
 * with the Firebase session cookie's own expiry.
 */

const VISITOR_ID_PREFIX = 'contextlayer';

function visitorStorageKey(tenantId: string): string {
  return `${VISITOR_ID_PREFIX}.${tenantId}.visitorId`;
}

export function storeVisitorId(tenantId: string, visitorId: string): void {
  try {
    sessionStorage.setItem(visitorStorageKey(tenantId), visitorId);
  } catch {
    // sessionStorage can throw in private mode or when disabled.
    // Failing to cache is non-fatal — the next call to session-check
    // will re-derive the same visitorId from the cookie.
  }
}

export function getStoredVisitorId(tenantId: string): string | null {
  try {
    return sessionStorage.getItem(visitorStorageKey(tenantId));
  } catch {
    return null;
  }
}

export function clearStoredVisitorId(tenantId: string): void {
  try {
    sessionStorage.removeItem(visitorStorageKey(tenantId));
  } catch {
    // ignore
  }
}

export interface LoadConfigOptions {
  apiBase: string;
  tenantId: string;
  apiKey: string;
  signal?: AbortSignal;
}

export async function loadConfig(opts: LoadConfigOptions): Promise<WidgetConfig> {
  const url = `${opts.apiBase}/api/v1/widget/config?tenant=${encodeURIComponent(opts.tenantId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${opts.apiKey}` },
    credentials: 'omit',
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`config fetch failed: ${res.status} ${text}`);
  }
  return (await res.json()) as WidgetConfig;
}

export interface SessionCheckOptions {
  apiBase: string;
  tenantId: string;
  signal?: AbortSignal;
}

export async function checkSession(opts: SessionCheckOptions): Promise<SessionCheckResult> {
  const url = `${opts.apiBase}/api/v1/widget/session-check?tenant=${encodeURIComponent(opts.tenantId)}`;
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    mode: 'cors',
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`session-check failed: ${res.status} ${text}`);
  }
  return (await res.json()) as SessionCheckResult;
}
