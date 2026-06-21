import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import widgetConfigRoute from './widget-config';

/**
 * Tests for GET /api/v1/widget/config — the route that returns
 * the B2B tenant's widget configuration (system prompt, branding,
 * providers, rate limit) after authenticating the tenant's API key.
 *
 * Auth flow under test:
 *   1. missing/invalid Authorization header -> 401
 *   2. API key not in any tenant's apiKeys collection -> 401
 *   3. API key marked active=false -> 401
 *   4. API key's scopes do not include the route's requiredScope
 *      (default `widget:read`) -> 403 scope_insufficient
 *   5. valid key, query tenant differs from the key's tenant ->
 *      403 tenant_mismatch
 *   6. valid key + matching tenant, but Origin is not in
 *      allowedOrigins -> 403 origin_not_allowed
 *   7. valid key + matching tenant + no Origin (server-side fetch)
 *      -> 200 with stripped config (no internal fields)
 *   8. valid key + matching tenant + allowed Origin -> 200
 */

type DocData = Record<string, unknown>;

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function makeFakeFirestore() {
  const docs = new Map<string, DocData>();

  const makeDoc = (path: string, id: string) => ({
    path,
    id,
    async get() {
      const data = docs.get(path);
      return { exists: data !== undefined, id, data: () => data };
    },
    async set(data: DocData) {
      docs.set(path, { ...data });
    },
    async update(data: DocData) {
      const existing = docs.get(path) ?? {};
      docs.set(path, { ...existing, ...data });
    },
    collection(childName: string) {
      return makeCollection(`${path}/${childName}`);
    },
  });

  const makeQuery = (basePath: string) => {
    const filters: Array<(d: DocData) => boolean> = [];
    let limitN: number | null = null;
    const q = {
      where(field: string, op: string, value: unknown) {
        filters.push((d) => (op === '==' ? d[field] === value : false));
        return q;
      },
      limit(n: number) {
        limitN = n;
        return q;
      },
      async get() {
        const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
        for (const [path, data] of docs.entries()) {
          if (!path.startsWith(`${basePath}/`)) continue;
          if (filters.every((f) => f(data))) {
            out.push({ id: path.slice(basePath.length + 1), ref: { path }, data: () => data });
            if (limitN !== null && out.length >= limitN) break;
          }
        }
        return { docs: out, size: out.length, empty: out.length === 0 };
      },
    };
    return q;
  };

  const makeCollection = (basePath: string) => ({
    doc(id: string) {
      return makeDoc(`${basePath}/${id}`, id);
    },
    where(field: string, op: string, value: unknown) {
      return makeQuery(basePath).where(field, op, value);
    },
    limit(n: number) {
      return makeQuery(basePath).limit(n);
    },
    listDocuments() {
      // List all "top-level" documents in this collection — paths
      // that have exactly one more segment after basePath (i.e.
      // not deeper paths). For `b2bTenants` that returns just the
      // tenant ids; for an apiKeys subcollection it returns the
      // key ids.
      const out: Array<{ id: string; path: string; collection: (name: string) => ReturnType<typeof makeCollection> }> = [];
      const seen = new Set<string>();
      for (const path of docs.keys()) {
        if (!path.startsWith(`${basePath}/`)) continue;
        const rest = path.slice(basePath.length + 1);
        const id = rest.split('/')[0];
        if (id && !seen.has(id)) {
          seen.add(id);
          out.push({
            id,
            path: `${basePath}/${id}`,
            collection: (child: string) => makeCollection(`${basePath}/${id}/${child}`),
          });
        }
      }
      return out;
    },
  });

  return {
    collection(path: string) {
      return makeCollection(path);
    },
    _docs: docs,
  };
}

async function seedTenant(
  db: ReturnType<typeof makeFakeFirestore>,
  tenantId: string,
  opts: {
    apiKeyPlain: string;
    apiKeyId: string;
    active?: boolean;
    scopes?: string[];
    systemPrompt?: string;
    primaryColor?: string;
    logoUrl?: string | null;
    displayName?: string;
    allowedOrigins?: string[];
    allowedProviders?: string[];
    defaultProvider?: string;
    rateLimit?: number;
  },
): Promise<void> {
  await db.collection(`b2bTenants/${tenantId}/apiKeys`).doc(opts.apiKeyId).set({
    keyHash: hashKey(opts.apiKeyPlain),
    active: opts.active ?? true,
    scopes: opts.scopes ?? ['widget:read', 'chat:write'],
    createdAt: new Date(),
  });
  await db.collection(`b2bTenants/${tenantId}/config`).doc('main').set({
    systemPrompt: opts.systemPrompt ?? 'You are a helpful assistant.',
    branding: {
      primaryColor: opts.primaryColor ?? '#0066cc',
      logoUrl: opts.logoUrl ?? null,
      displayName: opts.displayName ?? tenantId,
    },
    allowedProviders: opts.allowedProviders ?? ['openai', 'anthropic'],
    defaultProvider: opts.defaultProvider ?? 'openai',
    rateLimit: { messagesPerVisitorPerDay: opts.rateLimit ?? 100 },
    allowedOrigins: opts.allowedOrigins ?? [],
  });
  // tenant parent doc (so listDocuments returns it)
  await db.collection('b2bTenants').doc(tenantId).set({ tenantId });
}

async function buildApp(
  db: ReturnType<typeof makeFakeFirestore>,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('firebaseAdmin', {
    auth: () => ({ verifySessionCookie: async () => ({ uid: 'fake' }) }),
    firestore: () => db,
  } as unknown as never);
  await app.register(widgetConfigRoute);
  return app;
}

test('widget-config: 401 when Authorization header is missing', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', { apiKeyPlain: 'cl_abc', apiKeyId: 'k1' });
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/v1/widget/config?tenant=acme' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'missing_api_key');
  await app.close();
});

test('widget-config: 401 when Bearer token is empty', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', { apiKeyPlain: 'cl_abc', apiKeyId: 'k1' });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: { authorization: 'Bearer ' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'missing_api_key');
  await app.close();
});

test('widget-config: 401 when API key is unknown to any tenant', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', { apiKeyPlain: 'cl_real', apiKeyId: 'k1' });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: { authorization: 'Bearer cl_ghost' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_api_key');
  await app.close();
});

test('widget-config: 401 when API key is marked inactive', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', { apiKeyPlain: 'cl_abc', apiKeyId: 'k1', active: false });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: { authorization: 'Bearer cl_abc' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_api_key');
  assert.match(res.json().message, /inactive/);
  await app.close();
});

test('widget-config: 403 when API key lacks the required scope', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', {
    apiKeyPlain: 'cl_abc',
    apiKeyId: 'k1',
    scopes: ['chat:write'], // missing widget:read
  });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: { authorization: 'Bearer cl_abc' },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'scope_insufficient');
  assert.match(res.json().message, /widget:read/);
  await app.close();
});

test('widget-config: 403 when query tenant does not match the API key tenant', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', { apiKeyPlain: 'cl_abc', apiKeyId: 'k1' });
  await seedTenant(db, 'globex', { apiKeyPlain: 'cl_xyz', apiKeyId: 'k2' });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=globex',
    headers: { authorization: 'Bearer cl_abc' }, // acme's key, globex's tenant
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'tenant_mismatch');
  await app.close();
});

test('widget-config: 200 with no Origin header (server-side fetch is allowed)', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', {
    apiKeyPlain: 'cl_abc',
    apiKeyId: 'k1',
    systemPrompt: 'You are ACME bot.',
    primaryColor: '#ff0000',
    displayName: 'Acme',
    allowedOrigins: ['https://www.acme.com'],
  });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: { authorization: 'Bearer cl_abc' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.tenantId, 'acme');
  assert.equal(body.systemPrompt, 'You are ACME bot.');
  assert.equal(body.branding.primaryColor, '#ff0000');
  assert.equal(body.branding.displayName, 'Acme');
  assert.deepEqual(body.allowedProviders, ['openai', 'anthropic']);
  assert.equal(body.defaultProvider, 'openai');
  assert.equal(body.rateLimit.messagesPerVisitorPerDay, 100);
  // Stripped fields: no internal `keyHash` or `lastUsedAt` should leak
  assert.equal(body.keyHash, undefined);
  assert.equal(body.lastUsedAt, undefined);
  await app.close();
});

test('widget-config: 200 when Origin is in allowedOrigins', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', {
    apiKeyPlain: 'cl_abc',
    apiKeyId: 'k1',
    allowedOrigins: ['https://www.acme.com'],
  });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: {
      authorization: 'Bearer cl_abc',
      origin: 'https://www.acme.com',
    },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('widget-config: 200 when Origin matches a prefix (Origin === allowed + /)', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', {
    apiKeyPlain: 'cl_abc',
    apiKeyId: 'k1',
    allowedOrigins: ['https://www.acme.com'],
  });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: {
      authorization: 'Bearer cl_abc',
      origin: 'https://www.acme.com/some/path',
    },
  });
  assert.equal(res.statusCode, 200);
  await app.close();
});

test('widget-config: 403 origin_not_allowed when Origin is not on the allowlist', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', {
    apiKeyPlain: 'cl_abc',
    apiKeyId: 'k1',
    allowedOrigins: ['https://www.acme.com'],
  });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: {
      authorization: 'Bearer cl_abc',
      origin: 'https://evil.example.com',
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'origin_not_allowed');
  await app.close();
});

test('widget-config: 403 origin_not_allowed when Referer is not on the allowlist', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', {
    apiKeyPlain: 'cl_abc',
    apiKeyId: 'k1',
    allowedOrigins: ['https://www.acme.com'],
  });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: {
      authorization: 'Bearer cl_abc',
      referer: 'https://evil.example.com/page',
    },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'origin_not_allowed');
  await app.close();
});

test('widget-config: 404 when tenant config is missing', async () => {
  const db = makeFakeFirestore();
  // API key exists for `acme`, but config doc is missing
  await db.collection('b2bTenants/acme/apiKeys').doc('k1').set({
    keyHash: hashKey('cl_abc'),
    active: true,
    scopes: ['widget:read'],
  });
  await db.collection('b2bTenants').doc('acme').set({ tenantId: 'acme' });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config?tenant=acme',
    headers: { authorization: 'Bearer cl_abc' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'tenant_not_found');
  await app.close();
});

test('widget-config: defaults tenantId from the API key when query param is omitted', async () => {
  const db = makeFakeFirestore();
  await seedTenant(db, 'acme', { apiKeyPlain: 'cl_abc', apiKeyId: 'k1' });
  const app = await buildApp(db);
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/widget/config',
    headers: { authorization: 'Bearer cl_abc' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().tenantId, 'acme');
  await app.close();
});
