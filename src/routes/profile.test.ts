import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import profileRoute from './profile';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * In-memory Firestore fake for the profile route. Mirrors the surface
 * the read path needs: collection().doc().get() returning
 * `{ exists, data() }`, and set() storing a doc at the path. Mirrors
 * the conventions in conversations.test.ts so the shape stays
 * consistent across the suite.
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
        const out: Array<{ id: string; data: () => Record<string, unknown> }> = [];
        for (const [key, doc] of docs.entries()) {
          if (!key.startsWith(basePath + '/')) continue;
          const id = key.slice(basePath.length + 1);
          if (filters.every((f) => f(doc))) {
            out.push({ id, data: () => doc });
          }
        }
        return { docs: out, size: out.length };
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

async function buildApp(
  fakeDb: ReturnType<typeof makeFakeFirestore>,
  uid = 'tester',
): Promise<FastifyInstance> {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  app.decorate('firebaseAdmin', {
    auth: () => ({ verifyIdToken: async () => ({ uid }) }),
    firestore: () => fakeDb,
  } as unknown as never);
  await app.register(profileRoute);
  return app;
}

const auth = (uid = 'tester') => `Bearer dev:${uid}:${uid}@x.com`;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

test('GET /profile returns 401 without auth', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({ method: 'GET', url: '/api/v1/profile' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

// ---------------------------------------------------------------------------
// Missing profile
// ---------------------------------------------------------------------------

test('GET /profile returns 404 when no profile doc exists for the user', async () => {
  const fake = makeFakeFirestore();
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/profile',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------------------------------------------------------------------------
// Populated profile
// ---------------------------------------------------------------------------

test('GET /profile returns the 4 signal arrays + ISO updatedAt when populated', async () => {
  const fake = makeFakeFirestore();
  const updatedAt = new Date('2026-06-01T12:00:00Z');
  fake.docs.set('users/tester/profile/main', {
    preferences: [
      { value: 'electric cars', provider: 'claude', source: 'Car convo' },
      { value: 'dark mode', provider: 'chatgpt', source: 'Theme chat' },
    ],
    personalFacts: [
      { value: 'lives in Chile', provider: 'claude', source: 'Location' },
    ],
    activeIntentions: [
      { value: 'launch PoC', provider: 'claude', source: 'Roadmap' },
    ],
    domainsOfInterest: [
      { value: 'agent architectures', provider: 'claude', source: 'Agents' },
      { value: 'API design', provider: 'chatgpt', source: 'REST chat' },
    ],
    updatedAt,
  });
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/profile',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.preferences.length, 2);
  assert.equal(body.preferences[0].value, 'electric cars');
  assert.equal(body.personalFacts[0].value, 'lives in Chile');
  assert.equal(body.activeIntentions[0].value, 'launch PoC');
  assert.equal(body.domainsOfInterest[1].value, 'API design');
  assert.equal(body.updatedAt, '2026-06-01T12:00:00.000Z');
  await app.close();
});

// ---------------------------------------------------------------------------
// Shape robustness
// ---------------------------------------------------------------------------

test('GET /profile handles a Firestore Timestamp-like updatedAt (production write path)', async () => {
  const fake = makeFakeFirestore();
  // firebase-admin's FieldValue.serverTimestamp() resolves to a Timestamp
  // with { seconds, nanoseconds, toDate() } on read. Simulate that shape
  // so we exercise the production code path even in unit tests.
  const tsLike = {
    seconds: Math.floor(new Date('2026-05-15T08:30:00Z').getTime() / 1000),
    nanoseconds: 0,
    toDate: () => new Date('2026-05-15T08:30:00Z'),
  };
  fake.docs.set('users/tester/profile/main', {
    preferences: [],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
    updatedAt: tsLike as unknown as Date,
  });
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/profile',
    headers: { authorization: auth() },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // All four arrays present and empty
  assert.deepEqual(body.preferences, []);
  assert.deepEqual(body.personalFacts, []);
  assert.deepEqual(body.activeIntentions, []);
  assert.deepEqual(body.domainsOfInterest, []);
  // Timestamp -> ISO
  assert.equal(body.updatedAt, '2026-05-15T08:30:00.000Z');
  await app.close();
});

test('GET /profile does not leak another user profile (path scoped by uid)', async () => {
  // Seed only for `other`. tester queries own profile and gets 404.
  const fake = makeFakeFirestore();
  fake.docs.set('users/other/profile/main', {
    preferences: [{ value: 'secret', provider: 'claude', source: 'X' }],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  });
  const app = await buildApp(fake);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/profile',
    headers: { authorization: auth('tester') },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});
