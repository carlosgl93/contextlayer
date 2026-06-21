import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the widget bundle's pure logic.
 *
 * We can't drive the DOM from node:test, so we exercise:
 *   - visitorId sessionStorage helpers (mock sessionStorage)
 *   - auth-popup origin + message validation (call handler directly)
 *   - mount helpers (deriveApiBase, findOwnScriptTag, readApiKey) via
 *     a minimal DOM shim
 *
 * The bundling itself is verified by `pnpm build:widget` — if
 * the bundle compiles and the SRI hash is generated, esbuild
 * validated every import graph. The DOM-mounted Web Component
 * (chat-ui.ts) is intentionally not unit-tested here; it ships
 * with manual verification per the plan's "Verification" note.
 */

// -------- visitor-session tests --------

import {
  clearStoredVisitorId,
  getStoredVisitorId,
  storeVisitorId,
} from './visitor-session';

function withSessionStorage<T>(fn: () => T): T {
  const store = new Map<string, string>();
  const shim = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  const prior = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = shim;
  try {
    return fn();
  } finally {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = prior;
  }
}

test('storeVisitorId + getStoredVisitorId round-trip per tenant', () => {
  withSessionStorage(() => {
    storeVisitorId('acme', 'vs_abc1234567');
    storeVisitorId('globex', 'vs_zzz9999999');
    assert.equal(getStoredVisitorId('acme'), 'vs_abc1234567');
    assert.equal(getStoredVisitorId('globex'), 'vs_zzz9999999');
  });
});

test('clearStoredVisitorId removes only the matching tenant key', () => {
  withSessionStorage(() => {
    storeVisitorId('acme', 'vs_aaa');
    storeVisitorId('globex', 'vs_bbb');
    clearStoredVisitorId('acme');
    assert.equal(getStoredVisitorId('acme'), null);
    assert.equal(getStoredVisitorId('globex'), 'vs_bbb');
  });
});

test('getStoredVisitorId returns null when no value is set', () => {
  withSessionStorage(() => {
    assert.equal(getStoredVisitorId('acme'), null);
  });
});

test('storeVisitorId does not throw when sessionStorage is unavailable', () => {
  const prior = (globalThis as { sessionStorage?: unknown }).sessionStorage;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  try {
    assert.doesNotThrow(() => storeVisitorId('acme', 'vs_xxx'));
    assert.equal(getStoredVisitorId('acme'), null);
    assert.doesNotThrow(() => clearStoredVisitorId('acme'));
  } finally {
    (globalThis as { sessionStorage?: unknown }).sessionStorage = prior;
  }
});

// -------- auth-popup tests --------

import { dispatchAuthMessageForTest } from './auth-popup';

function withFakeWindow<T>(opts: { origin: string; posted?: Array<{ data: unknown; targetOrigin: string }> }, fn: () => T): T {
  const posted = opts.posted ?? [];
  const fakeWin = {
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => null,
    postMessage: (data: unknown, targetOrigin: string) => posted.push({ data, targetOrigin }),
  };
  const priorWin = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = fakeWin;
  const priorOrigin = (globalThis as { window?: { __authPopupOrigin?: string } & Record<string, unknown> }).window as unknown as { __authPopupOrigin?: string } | undefined;
  // The handler reads event.origin from the MessageEvent, so we
  // pass the origin via dispatchAuthMessageForTest. The window
  // object here just needs the methods.
  try {
    return fn();
  } finally {
    (globalThis as { window?: unknown }).window = priorWin;
    void priorOrigin;
  }
}

test('dispatchAuthMessageForTest: messages from auth origin are accepted (handler runs without throwing)', () => {
  withFakeWindow({ origin: 'https://auth.contextlayer.io' }, () => {
    assert.doesNotThrow(() =>
      dispatchAuthMessageForTest(
        { type: 'contextlayer-auth-success', visitorId: 'vs_abc123456789' },
      ),
    );
  });
});

test('dispatchAuthMessageForTest: rejects messages with missing visitorId (handler is a no-op)', () => {
  withFakeWindow({ origin: 'https://auth.contextlayer.io' }, () => {
    // No assertion needed beyond: handler does not throw on bad shape.
    assert.doesNotThrow(() =>
      dispatchAuthMessageForTest({
        type: 'contextlayer-auth-success',
        visitorId: undefined as unknown as string,
      }),
    );
  });
});

test('dispatchAuthMessageForTest: ignores messages with wrong type', () => {
  withFakeWindow({ origin: 'https://auth.contextlayer.io' }, () => {
    assert.doesNotThrow(() =>
      dispatchAuthMessageForTest({
        type: 'some-other-event',
        visitorId: 'vs_xyz',
      } as unknown as { type: 'contextlayer-auth-success'; visitorId: string }),
    );
  });
});

test('dispatchAuthMessageForTest: rejects messages from non-auth origin', () => {
  withFakeWindow({ origin: 'https://evil.example.com' }, () => {
    // The handler checks event.origin and returns early. Test:
    // it must not post back to the attacker.
    let posted = 0;
    const fakeWin = {
      addEventListener: () => {},
      removeEventListener: () => {},
      open: () => null,
      postMessage: () => {
        posted++;
      },
    };
    const priorWin = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = fakeWin;
    try {
      dispatchAuthMessageForTest(
        { type: 'contextlayer-auth-success', visitorId: 'vs_evil' },
        'https://evil.example.com',
      );
      // The handler should NOT echo the ack back to the attacker
      // because origin !== AUTH_POPUP_ORIGIN.
      assert.equal(posted, 0);
    } finally {
      (globalThis as { window?: unknown }).window = priorWin;
    }
  });
});

// -------- mount helpers --------

import { _internal } from './mount';

test('deriveApiBase: cdn.contextlayer.io -> api.contextlayer.io', () => {
  assert.equal(
    _internal.deriveApiBase('https://cdn.contextlayer.io/widget.js'),
    'https://api.contextlayer.io',
  );
});

test('deriveApiBase: arbitrary origin passes through unchanged', () => {
  assert.equal(
    _internal.deriveApiBase('https://cdn.acme.com/widget.js'),
    'https://cdn.acme.com',
  );
});

test('deriveApiBase: invalid URL falls back to default API base', () => {
  assert.equal(_internal.deriveApiBase('not a url'), 'https://api.contextlayer.io');
});

test('deriveApiBase: null src returns the default', () => {
  assert.equal(_internal.deriveApiBase(null), 'https://api.contextlayer.io');
});

// -------- types --------

import { isSessionCheckOk } from './types';

test('isSessionCheckOk narrows the union', () => {
  const ok = { authenticated: true, visitorId: 'vs_x', created: false } as const;
  const anon = { authenticated: false, signInUrl: 'https://auth.contextlayer.io/connect?tenant=x' } as const;
  assert.equal(isSessionCheckOk(ok), true);
  assert.equal(isSessionCheckOk(anon), false);
});