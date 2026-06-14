import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import privacyRoute from './privacy';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * Comprehensive in-memory Firestore fake. Mirrors the surface the
 * U8 firestore operations need: collection().where().get(),
 * doc.get/set/update/delete, and batch().delete().commit().
 * Path-aware chaining so users/{uid}/conversations/{id} is one key.
 */
function makeFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();

  const makeQuery = (basePath: string) => {
    const filters: Array<(d: Record<string, unknown>) => boolean> = [];
    const q = {
      where(field: string, op: string, value: unknown) {
        filters.push((d) => {
          const v = d[field];
          if (op === '==') return v === value;
          return false;
        });
        return q;
      },
      async get() {
        const out: Array<{
          id: string;
          ref: { path: string };
          data: () => Record<string, unknown>;
        }> = [];
        for (const [key, doc] of docs.entries()) {
          if (!key.startsWith(basePath + '/')) continue;
          const id = key.slice(basePath.length + 1);
          if (filters.every((f) => f(doc))) {
            out.push({ id, ref: { path: key }, data: () => doc });
          }
        }
        return { docs: out, size: out.length, empty: out.length === 0 };
      },
    };
    return q;
  };

  const makeDoc = (path: string) => ({
    path,
    collection: (colPath: string) => ({
      doc: (id: string) => makeDoc(`${path}/${colPath}/${id}`),
      ...makeQuery(`${path}/${colPath}`),
    }),
    async get() {
      const data = docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    async update(data: Record<string, unknown>) {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
    async delete() {
      docs.delete(path);
    },
  });

  return {
    docs,
    collection: (p: string) => ({
      doc: (id: string) => makeDoc(`${p}/${id}`),
      ...makeQuery(p),
    }),
    doc: (p: string) => makeDoc(p),
    batch: () => {
      const ops: Array<{ kind: 'set' | 'delete'; ref: { path: string }; data?: Record<string, unknown> }> = [];
      const b = {
        set(ref: { path: string }, data: Record<string, unknown>) {
          ops.push({ kind: 'set', ref, data });
          return b;
        },
        delete(ref: { path: string }) {
          ops.push({ kind: 'delete', ref });
          return b;
        },
        async commit() {
          for (const op of ops) {
            if (op.kind === 'set') docs.set(op.ref.path, { ...(docs.get(op.ref.path) ?? {}), ...op.data! });
            else docs.delete(op.ref.path);
          }
        },
      };
      return b;
    },
  };
}

async function buildApp(fakeDb: ReturnType<typeof makeFakeFirestore>): Promise<FastifyInstance> {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  app.decorate('firebaseAdmin', {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'tester' }) }),
    firestore: () => fakeDb,
  } as unknown as never);
  await app.register(privacyRoute);
  return app;
}

const auth = () => ({ authorization: 'Bearer dev:tester:tester@x.com' });

// ---------------------------------------------------------------------------
// DELETE /user/data
// ---------------------------------------------------------------------------

test('DELETE /user/data removes all conversations, profile, and siteAccess', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/tester/conversations/claude_a', { provider: 'claude' });
  fake.docs.set('users/tester/conversations/chatgpt_b', { provider: 'chatgpt' });
  fake.docs.set('users/tester/profile/main', { preferences: [] });
  fake.docs.set('users/tester/siteAccess/site-a', { active: true });
  const app = await buildApp(fake);
  const res = await app.inject({ method: 'DELETE', url: '/api/v1/user/data', headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
  assert.equal(fake.docs.has('users/tester/conversations/claude_a'), false);
  assert.equal(fake.docs.has('users/tester/conversations/chatgpt_b'), false);
  assert.equal(fake.docs.has('users/tester/profile/main'), false);
  assert.equal(fake.docs.has('users/tester/siteAccess/site-a'), false);
  await app.close();
});

test('DELETE /user/data is idempotent (second call still 200)', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const r1 = await app.inject({ method: 'DELETE', url: '/api/v1/user/data', headers: auth() });
  const r2 = await app.inject({ method: 'DELETE', url: '/api/v1/user/data', headers: auth() });
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.deepEqual(r2.json(), { deleted: true });
  await app.close();
});

// ---------------------------------------------------------------------------
// DELETE /user/data/provider/:provider
// ---------------------------------------------------------------------------

test('DELETE /user/data/provider/claude removes only Claude conversations and filters profile', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/tester/conversations/claude_a', { provider: 'claude', providerId: 'a' });
  fake.docs.set('users/tester/conversations/claude_b', { provider: 'claude', providerId: 'b' });
  fake.docs.set('users/tester/conversations/chatgpt_c', { provider: 'chatgpt', providerId: 'c' });
  fake.docs.set('users/tester/profile/main', {
    preferences: [
      { value: 'electric cars', provider: 'claude', source: 'A' },
      { value: 'dark mode', provider: 'chatgpt', source: 'C' },
    ],
    personalFacts: [
      { value: 'lives in Chile', provider: 'claude', source: 'A' },
    ],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/user/data/provider/claude',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
  assert.equal(fake.docs.has('users/tester/conversations/claude_a'), false);
  assert.equal(fake.docs.has('users/tester/conversations/claude_b'), false);
  assert.equal(fake.docs.has('users/tester/conversations/chatgpt_c'), true);
  const profile = fake.docs.get('users/tester/profile/main') as {
    preferences: Array<{ provider: string }>;
    personalFacts: unknown[];
  };
  assert.equal(profile.preferences.length, 1);
  assert.equal(profile.preferences[0]!.provider, 'chatgpt');
  assert.equal(profile.personalFacts.length, 0);
  await app.close();
});

test('DELETE /user/data/provider/claude is idempotent for non-existent provider', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/tester/conversations/chatgpt_c', { provider: 'chatgpt' });
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/user/data/provider/claude',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
  assert.equal(fake.docs.has('users/tester/conversations/chatgpt_c'), true);
  await app.close();
});

test('DELETE /user/data/provider/invalid returns 400', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/user/data/provider/gemini',
    headers: auth(),
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ---------------------------------------------------------------------------
// DELETE /user/profile
// ---------------------------------------------------------------------------

test('DELETE /user/profile removes the profile but keeps conversations', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/tester/conversations/claude_a', { provider: 'claude' });
  fake.docs.set('users/tester/profile/main', { preferences: [] });
  const app = await buildApp(fake);
  const res = await app.inject({ method: 'DELETE', url: '/api/v1/user/profile', headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
  assert.equal(fake.docs.has('users/tester/profile/main'), false);
  assert.equal(fake.docs.has('users/tester/conversations/claude_a'), true);
  await app.close();
});

test('DELETE /user/profile is idempotent', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({ method: 'DELETE', url: '/api/v1/user/profile', headers: auth() });
  assert.equal(res.statusCode, 200);
  await app.close();
});

// ---------------------------------------------------------------------------
// GET /user/access + DELETE /user/access/:siteId
// ---------------------------------------------------------------------------

test('GET /user/access returns only active siteAccess entries', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/tester/siteAccess/site-a', { active: true, grantedAt: '2026-01-01' });
  fake.docs.set('users/tester/siteAccess/site-b', { active: false, grantedAt: '2025-12-01' });
  fake.docs.set('users/tester/siteAccess/site-c', { active: true, grantedAt: '2026-02-01' });
  const app = await buildApp(fake);
  const res = await app.inject({ method: 'GET', url: '/api/v1/user/access', headers: auth() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const ids = body.access.map((a: { siteId: string }) => a.siteId).sort();
  assert.deepEqual(ids, ['site-a', 'site-c']);
  await app.close();
});

test('DELETE /user/access/:siteId soft-deletes (active: false), keeps the doc', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/tester/siteAccess/site-a', { active: true });
  const app = await buildApp(fake);
  const res = await app.inject({ method: 'DELETE', url: '/api/v1/user/access/site-a', headers: auth() });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });
  assert.equal(fake.docs.has('users/tester/siteAccess/site-a'), true);
  const written = fake.docs.get('users/tester/siteAccess/site-a') as { active: boolean };
  assert.equal(written.active, false);
  await app.close();
});

test('DELETE /user/access/:siteId is idempotent (no error for missing siteId)', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'DELETE',
    url: '/api/v1/user/access/never-existed',
    headers: auth(),
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('all DELETE/GET privacy endpoints return 401 without auth', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const endpoints = [
    { method: 'DELETE' as const, url: '/api/v1/user/data' },
    { method: 'DELETE' as const, url: '/api/v1/user/data/provider/claude' },
    { method: 'DELETE' as const, url: '/api/v1/user/profile' },
    { method: 'GET' as const, url: '/api/v1/user/access' },
    { method: 'DELETE' as const, url: '/api/v1/user/access/site-a' },
  ];
  for (const e of endpoints) {
    const res = await app.inject({ method: e.method, url: e.url });
    assert.equal(res.statusCode, 401, `${e.method} ${e.url} should be 401 unauthenticated`);
  }
  await app.close();
});
