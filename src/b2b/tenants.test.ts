import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { type Firestore } from 'firebase-admin/firestore';
import {
  createTenant,
  findApiKey,
  generateApiKey,
  getTenantConfig,
  isValidTenantId,
  listTenants,
  setTenantField,
  touchApiKey,
} from './tenants';

/**
 * Tests for the B2B tenant lifecycle helpers.
 *
 * Uses the same in-memory Firestore fake pattern as the rest of the
 * suite. Tests the path discipline, idempotency-of-failure, and
 * API key rotation contract that `scripts/tenant-bootstrap.ts` and
 * `scripts/tenant-config.ts` rely on.
 */

type DocData = Record<string, unknown>;
type DocEntry = { id: string; ref: { path: string }; data: () => DocData };

function applyDottedUpdate(target: DocData, update: DocData): DocData {
  for (const [k, v] of Object.entries(update)) {
    if (k.includes('.')) {
      const [head, ...rest] = k.split('.');
      const tail = rest.join('.');
      const sub = (target[head] as DocData | undefined) ?? {};
      target[head] = applyDottedUpdate({ ...sub }, { [tail]: v });
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      // Recurse into nested objects so a top-level field plus a
      // dotted path merge into the same subtree.
      const sub = (target[k] as DocData | undefined) ?? {};
      target[k] = applyDottedUpdate({ ...sub }, v as DocData);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function makeFakeFirestore() {
  const docs = new Map<string, DocData>();

  const makeCollection = (basePath: string) => ({
    doc(id: string) {
      const path = `${basePath}/${id}`;
      // Real Firestore DocumentReference shape: `path` AND `id` are
      // direct properties, with a `ref` getter and method chain. We
      // mirror that here so production code (which passes `doc()` to
      // `batch.set`) works against the fake without translation.
      const docRef: {
        path: string;
        id: string;
        get: () => Promise<{ exists: boolean; id: string; ref: { path: string }; data: () => DocData }>;
        set: (data: DocData) => Promise<void>;
        update: (data: DocData) => Promise<void>;
        delete: () => Promise<void>;
        collection: (childName: string) => ReturnType<typeof makeCollection>;
      } = {
        path,
        id,
        async get() {
          // In real Firestore, a document "exists" if it has any data
          // OR if it has any subcollections. Our flat key/value fake
          // doesn't track parent docs explicitly, so we scan for any
          // descendant path to mirror that behavior.
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
          return {
            exists,
            id,
            ref: { path },
            data: () => (data ?? ({} as DocData)),
          };
        },
        async set(data: DocData) {
          // Real Firestore set() without `{ merge: true }` overwrites
          // the document. The tenant-bootstrap path uses plain set
          // because the config doc is new.
          docs.set(path, { ...data });
        },
        async update(data: DocData) {
          // Real Firestore update() understands dotted paths:
          // `{ 'a.b': 1 }` updates `data.a.b`. Mirror that so
          // setTenantField with dotted paths works in the fake.
          const existing = docs.get(path) ?? {};
          docs.set(path, applyDottedUpdate({ ...existing }, data));
        },
        async delete() {
          docs.delete(path);
        },
        collection(childName: string) {
          return makeCollection(`${path}/${childName}`);
        },
      };
      return docRef;
    },
    where(field: string, op: string, value: unknown) {
      const filters: Array<(d: DocData) => boolean> = [];
      filters.push((d) => (op === '==' ? d[field] === value : false));
      const build = () => ({
        where(field2: string, op2: string, value2: unknown) {
          filters.push((d) => (op2 === '==' ? d[field2] === value2 : false));
          return build();
        },
        limit(n: number) {
          const sliced = (all: Array<{ id: string; ref: { path: string }; data: () => DocData }>) => all.slice(0, n);
          return {
            async get() {
              const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
              for (const [path, data] of docs.entries()) {
                if (!path.startsWith(`${basePath}/`)) continue;
                if (filters.every((f) => f(data))) {
                  out.push({
                    id: path.slice(basePath.length + 1),
                    ref: { path },
                    data: () => data,
                  });
                }
              }
              const trimmed = sliced(out);
              return { docs: trimmed, size: trimmed.length, empty: trimmed.length === 0 };
            },
          };
        },
        async get() {
          const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
          for (const [path, data] of docs.entries()) {
            if (!path.startsWith(`${basePath}/`)) continue;
            if (filters.every((f) => f(data))) {
              out.push({
                id: path.slice(basePath.length + 1),
                ref: { path },
                data: () => data,
              });
            }
          }
          return { docs: out, size: out.length, empty: out.length === 0 };
        },
      });
      return build();
    },
    async listDocuments() {
      // Return the immediate child doc refs that exist under basePath.
      // Production code calls `tenantRef.collection('apiKeys').where(...)`
      // on the returned refs, so the shape must include `.collection`.
      const collectionObj = this as ReturnType<typeof makeCollection>;
      const seen = new Set<string>();
      const out: Array<ReturnType<typeof collectionObj.doc>> = [];
      for (const path of docs.keys()) {
        if (!path.startsWith(`${basePath}/`)) continue;
        const rest = path.slice(basePath.length + 1);
        const id = rest.split('/')[0]!;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(collectionObj.doc(id));
      }
      return out;
    },
  });

  return {
    collection(path: string) {
      return makeCollection(path);
    },
    batch() {
      const pending: Array<() => Promise<void>> = [];
      return {
        set(ref: { path: string }, data: DocData) {
          pending.push(async () => {
            docs.set(ref.path, { ...data });
          });
          return this;
        },
        update(ref: { path: string }, data: DocData) {
          pending.push(async () => {
            const existing = docs.get(ref.path) ?? {};
            docs.set(ref.path, { ...existing, ...data });
          });
          return this;
        },
        delete(ref: { path: string }) {
          pending.push(async () => {
            docs.delete(ref.path);
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

function baselineInput(overrides: Partial<Parameters<typeof createTenant>[1]> = {}) {
  return {
    tenantId: 'acme',
    systemPrompt: 'You are AcmeBot.',
    branding: { primaryColor: '#0066cc', logoUrl: null, displayName: 'Acme' },
    allowedProviders: ['openai'],
    defaultProvider: 'openai',
    rateLimit: { messagesPerVisitorPerDay: 100 },
    allowedOrigins: ['https://acme.com'],
    ...overrides,
  };
}

test('isValidTenantId: accepts valid slugs', () => {
  assert.ok(isValidTenantId('acme'));
  assert.ok(isValidTenantId('globex-corp'));
  assert.ok(isValidTenantId('a1b2'));
});

test('isValidTenantId: rejects bad shapes', () => {
  assert.ok(!isValidTenantId('Acme')); // uppercase
  assert.ok(!isValidTenantId('-acme')); // leading dash
  assert.ok(!isValidTenantId('acme-')); // trailing dash
  assert.ok(!isValidTenantId('ac')); // too short
  assert.ok(!isValidTenantId('acme/../etc')); // path traversal
  assert.ok(!isValidTenantId('')); // empty
  assert.ok(!isValidTenantId('a'.repeat(33))); // too long
});

test('generateApiKey: produces cl_<43 chars> with matching SHA-256 hash', () => {
  const { key, hash } = generateApiKey();
  assert.match(key, /^cl_[0-9A-Za-z_-]{43}$/);
  const expected = createHash('sha256').update(key).digest('hex');
  assert.equal(hash, expected);
});

test('generateApiKey: produces unique keys across calls', () => {
  const a = generateApiKey().key;
  const b = generateApiKey().key;
  assert.notEqual(a, b);
});

test('createTenant: writes config + apiKeys under b2bTenants/{tenantId}', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const result = await createTenant(fake, baselineInput());

  assert.equal(result.tenantId, 'acme');
  assert.match(result.apiKey, /^cl_[0-9A-Za-z_-]{43}$/);
  assert.match(result.apiKeyId, /^key_[0-9a-f]{16}$/);

  const docs = (fake as unknown as { _docs: Map<string, DocData> })._docs;
  const cfg = docs.get('b2bTenants/acme/config/main');
  assert.ok(cfg);
  assert.equal(cfg.systemPrompt, 'You are AcmeBot.');
  assert.deepEqual(cfg.allowedProviders, ['openai']);
  assert.equal((cfg.rateLimit as { messagesPerVisitorPerDay: number }).messagesPerVisitorPerDay, 100);

  const keyDoc = docs.get(`b2bTenants/acme/apiKeys/${result.apiKeyId}`);
  assert.ok(keyDoc);
  assert.equal(keyDoc.active, true);
  assert.equal(keyDoc.keyHash, createHash('sha256').update(result.apiKey).digest('hex'));
  assert.deepEqual(keyDoc.scopes, ['widget:read', 'chat:write']);
});

test('createTenant: re-creating with same tenantId fails clearly without overwriting', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await createTenant(fake, baselineInput());

  await assert.rejects(
    () => createTenant(fake, baselineInput({ systemPrompt: 'OVERWRITE' })),
    /already exists/,
  );

  const cfg = await getTenantConfig(fake, 'acme');
  assert.equal(cfg?.systemPrompt, 'You are AcmeBot.');
});

test('createTenant: rejects invalid tenantId without writing', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await assert.rejects(
    () => createTenant(fake, baselineInput({ tenantId: 'Bad/ID' })),
    /invalid tenantId/,
  );
  const docs = (fake as unknown as { _docs: Map<string, DocData> })._docs;
  assert.equal(docs.size, 0);
});

test('getTenantConfig: returns null for unknown tenants', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const cfg = await getTenantConfig(fake, 'ghost');
  assert.equal(cfg, null);
});

test('listTenants: enumerates tenant ids without touching subcollections', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await createTenant(fake, baselineInput({ tenantId: 'acme' }));
  await createTenant(fake, baselineInput({ tenantId: 'globex' }));

  const ids = await listTenants(fake);
  assert.deepEqual(ids.sort(), ['acme', 'globex']);
});

test('setTenantField: updates one dotted path on the config doc', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await createTenant(fake, baselineInput());

  await setTenantField(fake, 'acme', 'rateLimit.messagesPerVisitorPerDay', 500);
  const cfg = await getTenantConfig(fake, 'acme');
  assert.equal(cfg?.rateLimit.messagesPerVisitorPerDay, 500);
  assert.ok(cfg?.updatedAt instanceof Date);
});

test('setTenantField: rejects unknown tenant', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await assert.rejects(
    () => setTenantField(fake, 'ghost', 'rateLimit.messagesPerVisitorPerDay', 10),
    /does not exist/,
  );
});

test('findApiKey: locates the tenant for a presented key and returns active record', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const created = await createTenant(fake, baselineInput());

  const found = await findApiKey(fake, created.apiKey);
  assert.ok(found);
  assert.equal(found.tenantId, 'acme');
  assert.equal(found.keyId, created.apiKeyId);
  assert.equal(found.record.active, true);
  assert.equal(found.record.keyHash, createHash('sha256').update(created.apiKey).digest('hex'));
});

test('findApiKey: returns null for unknown key', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await createTenant(fake, baselineInput());

  const found = await findApiKey(fake, 'cl_definitely-not-real-key-xxxxxxxxxxxxxxxxxxxxxx');
  assert.equal(found, null);
});

test('findApiKey: rejects keys without the cl_ prefix', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const found = await findApiKey(fake, 'sk_live_someotherformat');
  assert.equal(found, null);
});

test('touchApiKey: writes lastUsedAt on the matching apiKey record', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const created = await createTenant(fake, baselineInput());

  const before = await findApiKey(fake, created.apiKey);
  assert.equal(before?.record.lastUsedAt, null);

  await touchApiKey(fake, 'acme', created.apiKeyId);

  const after = await findApiKey(fake, created.apiKey);
  assert.ok(after?.record.lastUsedAt instanceof Date);
});
