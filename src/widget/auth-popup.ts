import { AUTH_MESSAGE_TYPE, AUTH_POPUP_ORIGIN, type AuthMessage } from './types';

/**
 * Implicit-auth popup orchestration.
 *
 * Flow:
 *   1. The widget calls `/api/v1/widget/session-check` and gets
 *      `{ authenticated: false, signInUrl: 'https://auth.contextlayer.io/connect?tenant=acme&redirect_uri=...' }`.
 *   2. On user click, the widget opens that URL in a popup with
 *      `window.open(url, 'contextlayer-auth', 'width=480,height=640')`.
 *   3. The auth host (auth.contextlayer.io) shows Firebase Auth UI.
 *      On success, the popup redirects to a callback URL, the
 *      callback page issues `window.opener.postMessage(...)` with
 *      `{ type: 'contextlayer-auth-success', visitorId, signature? }`,
 *      and closes itself.
 *   4. The widget receives the postMessage, validates `event.origin`
 *      against `https://auth.contextlayer.io`, and uses the
 *      visitorId to switch the bubble from "Sign in" CTA to
 *      chat input.
 *
 * v1 ships without signature verification — we trust origin + the
 * fact that the visitor must have a valid Firebase session cookie
 * for session-check to return authenticated on the next call. A
 * v1.1 follow-up can add HMAC verification using a per-tenant
 * shared secret.
 */

export interface OpenAuthPopupOptions {
  signInUrl: string;
  onMessage: (msg: AuthMessage) => void;
}

const POPUP_FEATURES = 'width=480,height=640,resizable=yes,scrollbars=yes';

let listenerInstalled = false;
let popupWindow: Window | null = null;

function handleAuthMessage(event: MessageEvent): void {
  if (event.origin !== AUTH_POPUP_ORIGIN) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type !== AUTH_MESSAGE_TYPE) return;
  if (typeof data.visitorId !== 'string') return;
  // v1.1: verify HMAC signature using a per-tenant secret. For now
  // origin + the postMessage structure are the only checks.
  (event.source as Window | null)?.postMessage({ type: 'contextlayer-ack' }, event.origin);
}

function ensureListener(): void {
  if (listenerInstalled) return;
  window.addEventListener('message', handleAuthMessage);
  listenerInstalled = true;
}

export function openAuthPopup(opts: OpenAuthPopupOptions): void {
  ensureListener();
  popupWindow = window.open(opts.signInUrl, 'contextlayer-auth', POPUP_FEATURES);
  if (!popupWindow) {
    // Popup blocked — fall back to same-tab navigation. The
    // auth callback can detect `opener === null` and postMessage
    // to the local window instead.
    window.location.assign(opts.signInUrl);
    return;
  }
  // Some browsers (Safari) reset opener on redirect. Once the
  // popup navigates to the callback URL it can no longer call
  // back via window.opener, so the callback falls back to
  // sessionStorage handoff (see auth-popup.test.ts).
}

/**
 * For test/dev: allow the host page to simulate a postMessage
 * from the auth origin. Exported so widget tests can drive the
 * flow without an actual popup.
 */
export function dispatchAuthMessageForTest(msg: AuthMessage, origin = AUTH_POPUP_ORIGIN): void {
  handleAuthMessage({ data: msg, origin, source: null } as unknown as MessageEvent);
}
