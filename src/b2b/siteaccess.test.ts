import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Firestore } from 'firebase-admin/firestore';
import {
  ensureSiteAccess,
  getSiteAccess,
  revokeAllForUser,
  revokeSiteAccess,
  sessionCheck,
} from './siteaccess';

/**
 * Tests for the siteAccess helpers that back the widget session-check
 * endpoint. Uses the same in-memory Firestore fake pattern as the
 * rest of the suite.
 *
 * The fake's `collectionGroup` is implemented as a flat scan over
 * all docs whose path contains the group name — close enough for
 * unit tests; production uses a real collectionGroup query with the
 * composite index on (contextLayerUid, revokedAt).
 */

type DocData = Record<string, unknown>;

function resolveFieldValues(data: DocData): DocData {
  // FieldValue.serverTimestamp() is a ServerTimestampTransform
  // sentinel in the real SDK. The fake resolves it to `new Date()`.
  // FieldValue.increment(N) is a NumericIncrementTransform — the
  // fake resolves it to a numeric add applied at write time.
  const out: DocData = {};
  for (const [k, v] of Object.entries(data)) {
    if (isServerTimestampSentinel(v)) out[k] = new Date();
    else if (isIncrementSentinel(v)) out[k] = (v as { _operand?: number })._operand ?? 1;
    else out[k] = v;
  }
  return out;
}

function isServerTimestampSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.getPrototypeOf(v)?.constructor?.name === 'ServerTimestampTransform';
}

function isIncrementSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.getPrototypeOf(v)?.constructor?.name === 'NumericIncrementTransform';
}

function applyDottedUpdate(target: DocData, update: DocData): DocData {
  for (const [k, v] of Object.entries(update)) {
    if (k.includes('.')) {
      const [head, ...rest] = k.split('.');
      const tail = rest.join('.');
      const sub = (target[head] as DocData | undefined) ?? {};
      target[head] = applyDottedUpdate({ ...sub }, { [tail]: v });
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !isIncrementSentinel(v)) {
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

  const makeCollection = (basePath: string) => ({
    doc(id: string) {
      const path = `${basePath}/${id}`;
      const docRef: {
        path: string;
        id: string;
        get: () => Promise<{ exists: boolean; id: string; data: () => DocData }>;
        set: (data: DocData) => Promise<void>;
        update: (data: DocData) => Promise<void>;
        delete: () => Promise<void>;
        collection: (childName: string) => ReturnType<typeof makeCollection>;
      } = {
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
    collectionGroup(_name: string) {
      // Flat scan: any doc whose path contains '/<name>/' is part of
      // the group. Real Firestore requires a composite index; the
      // fake skips that detail.
      return {
        where(field: string, op: string, value: unknown) {
          return {
            async get() {
              const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
              for (const [path, data] of docs.entries()) {
                if (!path.includes(`/${_name}/`)) continue;
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

test('getSiteAccess: returns null for unknown visitor', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const rec = await getSiteAccess(fake, 'acme', 'vs_unknown');
  assert.equal(rec, null);
});

test('ensureSiteAccess: creates a new record with accessCount=1', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const { record, created } = await ensureSiteAccess(fake, 'acme', 'vs_aaa', 'uid_alice');
  assert.equal(created, true);
  assert.equal(record.contextLayerUid, 'uid_alice');
  assert.equal(record.tenantId, 'acme');
  assert.equal(record.accessCount, 1);
  assert.equal(record.revokedAt, null);
});

test('ensureSiteAccess: second call returns same record, increments accessCount', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(fake, 'acme', 'vs_aaa', 'uid_alice');
  const second = await ensureSiteAccess(fake, 'acme', 'vs_aaa', 'uid_alice');
  assert.equal(second.created, false);
  assert.equal(second.record.accessCount, 2);
});

test('ensureSiteAccess: revoked visitor stays revoked, does not re-grant', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(fake, 'acme', 'vs_aaa', 'uid_alice');
  await revokeSiteAccess(fake, 'acme', 'vs_aaa');
  const after = await ensureSiteAccess(fake, 'acme', 'vs_aaa', 'uid_alice');
  assert.equal(after.revoked, true);
  assert.ok(after.record.revokedAt instanceof Date);
});

test('revokeSiteAccess: idempotent on missing record', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await revokeSiteAccess(fake, 'acme', 'vs_ghost');
  // No throw, no doc created.
  const rec = await getSiteAccess(fake, 'acme', 'vs_ghost');
  assert.equal(rec, null);
});

test('revokeAllForUser: revokes every tenant siteAccess with matching contextLayerUid', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(fake, 'acme', 'vs_alice_acme', 'uid_alice');
  await ensureSiteAccess(fake, 'globex', 'vs_alice_globex', 'uid_alice');
  await ensureSiteAccess(fake, 'initech', 'vs_bob_initech', 'uid_bob');

  const result = await revokeAllForUser(fake, 'uid_alice');
  assert.equal(result.revoked, 2);

  const acmeRec = await getSiteAccess(fake, 'acme', 'vs_alice_acme');
  const globexRec = await getSiteAccess(fake, 'globex', 'vs_alice_globex');
  const initechRec = await getSiteAccess(fake, 'initech', 'vs_bob_initech');
  assert.ok(acmeRec?.revokedAt instanceof Date);
  assert.ok(globexRec?.revokedAt instanceof Date);
  assert.equal(initechRec?.revokedAt, null);
});

test('sessionCheck: derives visitorId deterministically and creates siteAccess', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const r1 = await sessionCheck(fake, 'uid_alice', 'acme');
  assert.equal(r1.authenticated, true);
  if (r1.authenticated) {
    assert.match(r1.visitorId, /^vs_[0-9A-Za-z]{12}$/);
    assert.equal(r1.created, true);
  }
  // Second call: same uid+tenantId -> same visitorId, created=false
  const r2 = await sessionCheck(fake, 'uid_alice', 'acme');
  assert.equal(r2.authenticated, true);
  if (r1.authenticated && r2.authenticated) {
    assert.equal(r1.visitorId, r2.visitorId);
    assert.equal(r2.created, false);
  }
});

test('sessionCheck: cross-tenant visitorId uniqueness', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const r1 = await sessionCheck(fake, 'uid_alice', 'acme');
  const r2 = await sessionCheck(fake, 'uid_alice', 'globex');
  assert.equal(r1.authenticated, true);
  assert.equal(r2.authenticated, true);
  if (r1.authenticated && r2.authenticated) {
    assert.notEqual(r1.visitorId, r2.visitorId);
  }
});

test('sessionCheck: revoked visitor returns signInUrl instead of re-granting', async () => {
  const fake = makeFakeFirestore() as unknown as Firestore;
  const initial = await sessionCheck(fake, 'uid_alice', 'acme');
  if (!initial.authenticated) assert.fail('expected initial auth success');
  await revokeSiteAccess(fake, 'acme', initial.visitorId);
  const after = await sessionCheck(fake, 'uid_alice', 'acme');
  assert.equal(after.authenticated, false);
  if (!after.authenticated) {
    assert.match(after.signInUrl, /auth\.contextlayer\.io\/connect\?tenant=acme/);
  }
});