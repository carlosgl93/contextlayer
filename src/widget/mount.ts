import {
  checkSession,
  clearStoredVisitorId,
  getStoredVisitorId,
  loadConfig,
  storeVisitorId,
} from './visitor-session';
import { openAuthPopup } from './auth-popup';
import {
  defineChatElement,
  injectWidgetStyles,
  type SessionState,
} from './chat-ui';
import { streamChat } from './stream';
import {
  AUTH_MESSAGE_TYPE,
  AUTH_POPUP_ORIGIN,
  isSessionCheckOk,
  type AuthMessage,
  type SessionCheckResult,
  type WidgetConfig,
} from './types';

/**
 * Entry point for the widget bundle.
 *
 * Loaded as `<script src="https://cdn.contextlayer.io/widget.js" data-tenant="acme"></script>`
 * plus `<meta name="contextlayer-api-key" content="cl_xxx">` in
 * the host page's <head>. The script reads its own <script> tag,
 * locates the meta tag, fetches config + session-check, and
 * mounts `<contextlayer-chat>` into the page.
 *
 * The apiBase defaults to the API origin derived from the
 * script's own `src`. This lets B2B customers embed the bundle
 * from a CDN without configuring an API origin separately.
 */

const DEFAULT_API_BASE = 'https://api.contextlayer.io';

function findOwnScriptTag(): HTMLScriptElement | null {
  if (typeof document === 'undefined') return null;
  // The script tag with the `data-tenant` attribute IS our loader.
  // Browsers execute scripts after they're parsed, so document.currentScript
  // is reliable inside the bundle's IIFE.
  const current = document.currentScript as HTMLScriptElement | null;
  if (current?.dataset?.tenant) return current;
  // Fallback: scan all scripts for the data-tenant attribute.
  const candidates = document.querySelectorAll<HTMLScriptElement>('script[data-tenant]');
  return candidates[0] ?? null;
}

function readApiKey(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="contextlayer-api-key"]');
  return meta?.content ?? null;
}

function deriveApiBase(scriptSrc: string | null): string {
  if (!scriptSrc) return DEFAULT_API_BASE;
  try {
    const url = new URL(scriptSrc);
    // If the script is served from `cdn.contextlayer.io`, the API
    // lives at the apex domain. Otherwise we trust the configured
    // origin and assume it's already pointing at the API.
    if (url.hostname === 'cdn.contextlayer.io') return `${url.protocol}//api.contextlayer.io`;
    return url.origin;
  } catch {
    return DEFAULT_API_BASE;
  }
}

export interface MountOptions {
  apiBase?: string;
  logger?: { warn: (msg: string, extra?: Record<string, unknown>) => void };
}

interface MountState {
  apiBase: string;
  tenantId: string;
  apiKey: string;
  config: WidgetConfig | null;
  session: SessionState | null;
  element: HTMLElement | null;
}

export async function mount(opts: MountOptions = {}): Promise<void> {
  const logger = opts.logger ?? console;
  const script = findOwnScriptTag();
  const tenantId = script?.dataset?.tenant;
  if (!tenantId) {
    logger.warn('contextlayer: <script data-tenant="..."> attribute missing — widget will not mount');
    return;
  }
  const apiKey = readApiKey();
  if (!apiKey) {
    logger.warn(
      'contextlayer: <meta name="contextlayer-api-key"> missing — widget will not mount. Add it to the host page <head>.',
    );
    return;
  }
  const apiBase = opts.apiBase ?? deriveApiBase(script?.getAttribute('src'));

  const state: MountState = { apiBase, tenantId, apiKey, config: null, session: null, element: null };

  // Install styles + element once.
  injectWidgetStyles();
  defineChatElement();

  // Fetch config + session in parallel.
  let config: WidgetConfig | null = null;
  let sessionResult: SessionCheckResult | null = null;
  let configError: Error | null = null;
  let sessionError: Error | null = null;
  try {
    config = await loadConfig({ apiBase, tenantId, apiKey });
  } catch (err) {
    configError = err instanceof Error ? err : new Error(String(err));
  }
  try {
    sessionResult = await checkSession({ apiBase, tenantId });
  } catch (err) {
    sessionError = err instanceof Error ? err : new Error(String(err));
  }

  if (configError || !config) {
    logger.warn('contextlayer: config fetch failed — widget will not mount', {
      tenantId,
      error: configError?.message,
    });
    return;
  }

  state.config = config;

  // Use the stored visitorId if present; otherwise trust the
  // session-check result (which is the source of truth).
  let session: SessionState;
  if (sessionError || !sessionResult) {
    logger.warn('contextlayer: session-check failed — mounting in anonymous state', {
      tenantId,
      error: sessionError?.message,
    });
    session = {
      kind: 'anon',
      signInUrl: `${apiBase}/api/v1/widget/session-check?tenant=${encodeURIComponent(tenantId)}`,
    };
  } else if (isSessionCheckOk(sessionResult)) {
    storeVisitorId(tenantId, sessionResult.visitorId);
    session = { kind: 'auth', session: sessionResult };
  } else {
    session = { kind: 'anon', signInUrl: sessionResult.signInUrl };
  }

  state.session = session;
  state.element = mountElement(state, logger);

  // Install postMessage listener for the auth popup callback.
  installAuthListener(apiBase, tenantId, state);
}

function mountElement(state: MountState, logger: { warn: (msg: string, extra?: Record<string, unknown>) => void; debug?: (msg: string, extra?: Record<string, unknown>) => void }): HTMLElement {
  const el = document.createElement('contextlayer-chat');
  document.body.appendChild(el);
  (el as unknown as {
    configure: (opts: {
      tenantId: string;
      config: WidgetConfig;
      session: SessionState;
      onSignInClick: () => void;
      onSend?: (text: string) => Promise<void> | void;
    }) => void;
  }).configure({
    tenantId: state.tenantId,
    config: state.config!,
    session: state.session!,
    onSignInClick: () => {
      if (state.session?.kind !== 'anon') return;
      openAuthPopup({
        signInUrl: state.session.signInUrl,
        onMessage: (msg) => applyAuthMessage(state, msg),
      });
    },
    onSend: async (text) => {
      if (state.session?.kind !== 'auth') return;
      await streamChat({
        apiBase: state.apiBase,
        tenantId: state.tenantId,
        visitorId: state.session.session.visitorId,
        message: text,
        onToken: (tok) => logger.debug?.('token', { token: tok }),
        onDone: () => logger.debug?.('stream done'),
        onError: (err) => logger.warn?.('stream error', { error: err.message }),
      });
    },
  });
  return el;
}

function applyAuthMessage(state: MountState, msg: AuthMessage): void {
  if (msg.type !== AUTH_MESSAGE_TYPE) return;
  storeVisitorId(state.tenantId, msg.visitorId);
  const stored = getStoredVisitorId(state.tenantId) ?? msg.visitorId;
  state.session = {
    kind: 'auth',
    session: { authenticated: true, visitorId: stored, created: false },
  };
  if (state.element) {
    (state.element as unknown as { setSession: (s: SessionState) => void }).setSession(state.session);
  }
}

function installAuthListener(
  _apiBase: string,
  _tenantId: string,
  _state: MountState,
): void {
  // auth-popup.ts already installs the listener. This function
  // is a no-op kept for symmetry and to give mount.ts a clear
  // seam if we want to bundle-validate signatures in the future.
}

// Expose a tiny test/dev surface.
declare global {
  interface Window {
    __contextlayer?: {
      applyAuthMessage: (msg: AuthMessage) => void;
      clearVisitorId: (tenantId: string) => void;
    };
  }
}

if (typeof window !== 'undefined') {
  window.__contextlayer = {
    applyAuthMessage: () => {},
    clearVisitorId: (tenantId: string) => clearStoredVisitorId(tenantId),
  };
}

// Auto-mount if the bundle is loaded as a plain <script>.
if (typeof document !== 'undefined') {
  // Defer to next tick so the script tag finishes parsing
  // and document.currentScript is still set in some browsers.
  queueMicrotask(() => {
    void mount();
  });
}

// Surface useful constants for tests.
export const _internal = {
  AUTH_POPUP_ORIGIN,
  AUTH_MESSAGE_TYPE,
  deriveApiBase,
  findOwnScriptTag,
  readApiKey,
};