import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import conversationsRoute from './conversations';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * In-memory Firestore fake with read-side query support. Captures
 * every doc write by path and supports the operations the listing
 * endpoint uses: collection().where().orderBy().limit().get().
 *
 * Path-aware chaining so users/{uid}/conversations/{id} resolves to
 * a single key. The query's get() filters the in-memory docs by the
 * registered predicates, sorts, and limits.
 */
function makeFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();

  const makeQuery = (basePath: string) => {
    const filters: Array<(d: Record<string, unknown>) => boolean> = [];
    let sort: { field: string; dir: 'asc' | 'desc' } | null = null;
    let limitN: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        filters.push((d) => {
          const v = d[field];
          if (op === '==') return v === value;
          if (op === '>=') {
            if (v instanceof Date && value instanceof Date) return v.getTime() >= value.getTime();
            return (v as number) >= (value as number);
          }
          if (op === '<=') {
            if (v instanceof Date && value instanceof Date) return v.getTime() <= value.getTime();
            return (v as number) <= (value as number);
          }
          return false;
        });
        return q;
      },
      orderBy(field: string, dir: 'asc' | 'desc' = 'asc') {
        sort = { field, dir };
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      async get() {
        const out: Array<{ id: string; data: () => Record<string, unknown> }> = [];
        for (const [key, doc] of docs.entries()) {
          if (!key.startsWith(basePath + '/')) continue;
          const id = key.slice(basePath.length + 1);
          if (filters.every((f) => f(doc))) {
            out.push({ id, data: () => doc });
          }
        }
        if (sort) {
          const { field, dir } = sort;
          out.sort((a, b) => {
            const av = a.data()[field] as number | Date;
            const bv = b.data()[field] as number | Date;
            const an = av instanceof Date ? av.getTime() : (av as number);
            const bn = bv instanceof Date ? bv.getTime() : (bv as number);
            const cmp = an < bn ? -1 : an > bn ? 1 : 0;
            return dir === 'desc' ? -cmp : cmp;
          });
        }
        const limited = limitN !== null ? out.slice(0, limitN) : out;
        return {
          docs: limited,
          size: limited.length,
        };
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
  });

  return {
    docs,
    collection: (p: string) => ({
      doc: (id: string) => makeDoc(`${p}/${id}`),
      ...makeQuery(p),
    }),
    doc: (p: string) => makeDoc(p),
  };
}

function seed(uid: string, records: Array<Record<string, unknown>>) {
  const fake = makeFakeFirestore();
  for (const r of records) {
    fake.docs.set(`users/${uid}/conversations/${r.providerId}`, r as Record<string, unknown>);
  }
  return fake;
}

async function buildApp(fakeDb: ReturnType<typeof makeFakeFirestore>, uid = 'tester'): Promise<FastifyInstance> {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  app.decorate('firebaseAdmin', {
    auth: () => ({ verifyIdToken: async () => ({ uid }) }),
    firestore: () => fakeDb,
  } as unknown as never);
  await app.register(conversationsRoute);
  return app;
}

const auth = (uid = 'tester') => `Bearer dev:${uid}:${uid}@x.com`;

test('GET /conversations returns all of the user conversations, no filters', async () => {
  const fake = seed('tester', [
    { provider: 'claude', providerId: 'a', title: 'A', date: new Date('2026-01-01'), messageCount: 2 },
    { provider: 'chatgpt', providerId: 'b', title: 'B', date: new Date('2026-02-01'), messageCount: 4 },
  ]);
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.conversations.length, 2);
  // newest first
  assert.equal(body.conversations[0].providerId, 'b');
  assert.equal(body.conversations[1].providerId, 'a');
  await app.close();
});

test('GET /conversations?provider=claude returns only Claude conversations', async () => {
  const fake = seed('tester', [
    { provider: 'claude', providerId: 'a', title: 'A', date: new Date('2026-01-01'), messageCount: 2 },
    { provider: 'chatgpt', providerId: 'b', title: 'B', date: new Date('2026-02-01'), messageCount: 4 },
  ]);
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations?provider=claude',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].provider, 'claude');
  await app.close();
});

test('GET /conversations?from=...&to=... returns conversations in the date range', async () => {
  const fake = seed('tester', [
    { provider: 'claude', providerId: 'a', title: 'A', date: new Date('2025-12-01'), messageCount: 1 },
    { provider: 'claude', providerId: 'b', title: 'B', date: new Date('2026-02-15'), messageCount: 2 },
    { provider: 'claude', providerId: 'c', title: 'C', date: new Date('2026-04-20'), messageCount: 3 },
  ]);
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations?from=2026-01-01&to=2026-03-31',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].providerId, 'b');
  await app.close();
});

test('GET /conversations?provider=claude&from=2026-02-01 combines both filters', async () => {
  const fake = seed('tester', [
    { provider: 'claude', providerId: 'a', title: 'A', date: new Date('2026-01-15'), messageCount: 1 },
    { provider: 'claude', providerId: 'b', title: 'B', date: new Date('2026-02-20'), messageCount: 2 },
    { provider: 'chatgpt', providerId: 'c', title: 'C', date: new Date('2026-02-25'), messageCount: 3 },
  ]);
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations?provider=claude&from=2026-02-01',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.conversations.length, 1);
  assert.equal(body.conversations[0].providerId, 'b');
  await app.close();
});

test('GET /conversations returns empty + cursor null when user has no conversations', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.conversations, []);
  assert.equal(body.cursor, null);
  await app.close();
});

test('GET /conversations does not leak another user conversations (path scoped by uid)', async () => {
  // Seed only for `other`, query as `tester`. Tester should see nothing.
  const fake = seed('other', [
    { provider: 'claude', providerId: 'x', title: 'X', date: new Date('2026-01-01'), messageCount: 1 },
  ]);
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations',
    headers: { authorization: auth('tester') },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().conversations.length, 0);
  await app.close();
});

test('GET /conversations does not return rawText in the response', async () => {
  const fake = seed('tester', [
    { provider: 'claude', providerId: 'a', title: 'A', date: new Date('2026-01-01'), messageCount: 2, rawText: 'SECRET_USER_DATA' },
  ]);
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations',
    headers: { authorization: auth() },
  });
  const body = res.json();
  const json = JSON.stringify(body);
  assert.equal(json.includes('SECRET_USER_DATA'), false, 'rawText must not appear in the response');
  await app.close();
});

test('GET /conversations returns 401 without auth', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/user/conversations',
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
