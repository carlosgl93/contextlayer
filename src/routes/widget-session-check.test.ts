import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Firestore } from 'firebase-admin/firestore';
import widgetSessionCheckRoute from './widget-session-check';

/**
 * Tests for GET /api/v1/widget/session-check?tenant=X — the route
 * the widget calls on mount with `credentials: 'include'` to
 * detect whether the user has a valid session cookie set by
 * app.contextlayer.io.
 *
 * Behavior under test:
 *   - missing tenant query param -> 400 missing_tenant
 *   - malformed tenant id -> 400 invalid_tenant
 *   - no session cookie -> 401 no_session
 *   - invalid/expired session cookie -> 401 no_session
 *   - valid session, first call -> 200 authenticated, visitorId
 *     derived deterministically, created=true, siteAccess row
 *     materialized at b2bTenants/{tenantId}/siteAccess/{visitorId}
 *   - valid session, second call -> 200, same visitorId, created=false
 *   - cross-tenant calls -> different visitorIds (tenant is part of the hash)
 *   - revoked visitor -> 200 authenticated=false with signInUrl
 *
 * Uses the same in-memory Firestore fake as siteaccess.test.ts so
 * the production code paths are exercised end-to-end (FieldValue
 * sentinels, dotted updates, collectionGroup scans).
 */

type DocData = Record<string, unknown>;

function isServerTimestampSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.getPrototypeOf(v)?.constructor?.name === 'ServerTimestampTransform';
}
function isIncrementSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.getPrototypeOf(v)?.constructor?.name === 'NumericIncrementTransform';
}
function resolveFieldValues(data: DocData): DocData {
  const out: DocData = {};
  for (const [k, v] of Object.entries(data)) {
    if (isServerTimestampSentinel(v)) out[k] = new Date();
    else if (isIncrementSentinel(v)) out[k] = (v as { _operand?: number })._operand ?? 1;
    else out[k] = v;
  }
  return out;
}
function applyDottedUpdate(target: DocData, update: DocData): DocData {
  for (const [k, v] of Object.entries(update)) {
    if (k.includes('.')) {
      const [head, ...rest] = k.split('.');
      const tail = rest.join('.');
      const sub = (target[head] as DocData | undefined) ?? {};
      target[head] = applyDottedUpdate({ ...sub }, { [tail]: v });
    } else if (
      v !== null &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !(v instanceof Date) &&
      !isIncrementSentinel(v)
    ) {
      const sub = (target[k] as DocData | undefined) ?? {};
      target[k] = applyDottedUpdate({ ...sub }, v as DocData);
    } else if (isIncrementSentinel(v)) {
      const n = (v as { _operand?: number })._operand ?? 1;
      const cur = typeof target[k] === 'number' ? (target[k] as number) : 0;
      target[k] = cur + n;
    } else {
      target[k] = v;
    }
  }
  return target;
}

function makeFakeFirestore() {
  const docs = new Map<string, DocData>();

  const makeDoc = (path: string, id: string) => ({
    path,
    id,
    async get() {
      let data = docs.get(path);
      let exists = data !== undefined;
      if (!exists) {
        for (const k of docs.keys()) {
          if (k.startsWith(`${path}/`)) {
            exists = true;
            break;
          }
        }
      }
      return { exists, id, data: () => (data ?? ({} as DocData)) };
    },
    async set(data: DocData) {
      docs.set(path, { ...data });
    },
    async update(data: DocData) {
      const existing = docs.get(path) ?? {};
      const resolved = resolveFieldValues(data);
      docs.set(path, applyDottedUpdate({ ...existing }, resolved));
    },
    async delete() {
      docs.delete(path);
    },
    collection(childName: string) {
      return makeCollection(`${path}/${childName}`);
    },
  });

  const makeCollection = (basePath: string) => ({
    doc(id: string) {
      return makeDoc(`${basePath}/${id}`, id);
    },
    where(field: string, op: string, value: unknown) {
      const filters: Array<(d: DocData) => boolean> = [];
      filters.push((d) => (op === '==' ? d[field] === value : false));
      const build = () => ({
        where(field2: string, op2: string, value2: unknown) {
          filters.push((d) => (op2 === '==' ? d[field2] === value2 : false));
          return build();
        },
        async get() {
          const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
          for (const [path, data] of docs.entries()) {
            if (!path.startsWith(`${basePath}/`)) continue;
            if (filters.every((f) => f(data))) {
              out.push({ id: path.slice(basePath.length + 1), ref: { path }, data: () => data });
            }
          }
          return { docs: out, size: out.length, empty: out.length === 0 };
        },
      });
      return build();
    },
  });

  return {
    collection(path: string) {
      return makeCollection(path);
    },
    collectionGroup(name: string) {
      return {
        where(field: string, op: string, value: unknown) {
          return {
            async get() {
              const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
              for (const [path, data] of docs.entries()) {
                if (!path.includes(`/${name}/`)) continue;
                if (op === '==' && data[field] === value) {
                  out.push({ id: path, ref: { path }, data: () => data });
                }
              }
              return { docs: out, size: out.length, empty: out.length === 0 };
            },
          };
        },
      };
    },
    batch() {
      const pending: Array<() => Promise<void>> = [];
      return {
        update(ref: { path: string }, data: DocData) {
          pending.push(async () => {
            const existing = docs.get(ref.path) ?? {};
            const resolved = resolveFieldValues(data);
            docs.set(ref.path, applyDottedUpdate({ ...existing }, resolved));
          });
          return this;
        },
        async commit() {
          for (const op of pending) await op();
        },
      };
    },
    _docs: docs,
  };
}

const SESSION_COOKIE = '__Host-context-layer-session';

interface FakeAppOptions {
  verifyOk: boolean;
}

async function buildApp(
  db: ReturnType<typeof makeFakeFirestore>,
  opts: FakeAppOptions,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('firebaseAdmin', {
    auth: () => ({
      verifySessionCookie: async (_cookie: string, _checkRevoked: boolean) => {
        if (!opts.verifyOk) throw new Error('invalid cookie');
        return { uid: 'uid_alice', email: 'alice@example.com' };
      },
    }),
    firestore: () => db,
  } as unknown as never);
  await app.register(widgetSessionCheckRoute);
  return app;
}

test('session-check: 400 when tenant query param is missing', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check',
    headers: { cookie: `${SESSION_COOKIE}=fake-cookie` },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'missing_tenant');
  await app.close();
});

test('session-check: 400 when tenant id is malformed', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=BAD_ID!',
    headers: { cookie: `${SESSION_COOKIE}=fake-cookie` },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_tenant');
  await app.close();
});

test('session-check: 401 when no session cookie is present', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });
  const res = await app.inject({ method: 'GET', url: '/api/v1/widget/session-check?tenant=acme' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'no_session');
  await app.close();
});

test('session-check: 401 when session cookie verification fails', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: false });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=bad-cookie` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'no_session');
  await app.close();
});

test('session-check: 200 with visitorId on first call, created=true', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.authenticated, true);
  assert.match(body.visitorId, /^vs_[0-9A-Za-z]{12}$/);
  assert.equal(body.created, true);
  // side-effect: siteAccess row materialized
  const saDoc = await db
    .collection('b2bTenants/acme/siteAccess')
    .doc(body.visitorId)
    .get();
  assert.equal(saDoc.exists, true);
  await app.close();
});

test('session-check: same uid+tenant -> same visitorId, created=false on repeat', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });
  const r1 = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  const r2 = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  const b1 = r1.json();
  const b2 = r2.json();
  assert.equal(b1.visitorId, b2.visitorId);
  assert.equal(b1.created, true);
  assert.equal(b2.created, false);
  await app.close();
});

test('session-check: same uid across tenants -> different visitorIds', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });
  const rAcme = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  const rGlobex = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=globex',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  assert.equal(rAcme.statusCode, 200);
  assert.equal(rGlobex.statusCode, 200);
  assert.notEqual(rAcme.json().visitorId, rGlobex.json().visitorId);
  await app.close();
});

test('session-check: revoked visitor returns signInUrl instead of re-granting', async () => {
  const db = makeFakeFirestore();
  const app = await buildApp(db, { verifyOk: true });

  // First, grant + capture visitorId.
  const r1 = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  const visitorId = r1.json().visitorId;

  // Revoke by writing the revokedAt field on the siteAccess doc.
  await db
    .collection('b2bTenants/acme/siteAccess')
    .doc(visitorId)
    .update({ revokedAt: new Date() });

  // Second call should NOT re-grant.
  const r2 = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/session-check?tenant=acme',
    headers: { cookie: `${SESSION_COOKIE}=good-cookie` },
  });
  assert.equal(r2.statusCode, 200);
  const body = r2.json();
  assert.equal(body.authenticated, false);
  assert.match(body.signInUrl, /auth\.contextlayer\.io\/connect\?tenant=acme/);
  await app.close();
});
