import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Firestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { checkAndIncrementRateLimit } from './rate-limit';

/**
 * Tests for the per-visitor daily rate limit. Uses the same
 * in-memory Firestore fake pattern as the rest of the suite,
 * extended with `runTransaction` (sequential — sufficient for
 * single-threaded tests, production runs in real Firestore).
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
  const makeDoc = (path: string) => ({
    path,
    id: path.split('/').pop()!,
    async get() {
      const data = docs.get(path);
      return { exists: data !== undefined, id: this.id, data: () => data };
    },
    async set(data: DocData) {
      docs.set(path, { ...data });
    },
    async update(data: DocData) {
      const existing = docs.get(path) ?? {};
      const resolved = resolveFieldValues(data);
      docs.set(path, applyDottedUpdate({ ...existing }, resolved));
    },
    collection(child: string) {
      return makeCollection(`${path}/${child}`);
    },
  });
  const makeCollection = (base: string) => ({
    doc: (id: string) => makeDoc(`${base}/${id}`),
  });
  return {
    collection: (p: string) => makeCollection(p),
    _docs: docs,
    async runTransaction<T>(fn: (tx: { get: (ref: { path: string }) => Promise<{ exists: boolean; data: () => DocData | undefined }>; set: (ref: { path: string }, d: DocData) => void; update: (ref: { path: string }, d: DocData) => void }) => Promise<T>): Promise<T> {
      const staged: Array<() => void> = [];
      const tx = {
        async get(ref: { path: string }) {
          const data = docs.get(ref.path);
          return { exists: data !== undefined, data: () => data };
        },
        set(ref: { path: string }, d: DocData) {
          const path = ref.path;
          staged.push(() => docs.set(path, { ...d }));
        },
        update(ref: { path: string }, d: DocData) {
          const path = ref.path;
          const existing = docs.get(path) ?? {};
          // Pass the raw update through applyDottedUpdate — it
          // knows how to handle FieldValue sentinels (increment,
          // serverTimestamp) directly, so we don't pre-resolve.
          staged.push(() => docs.set(path, applyDottedUpdate({ ...existing }, d)));
        },
      };
      const result = await fn(tx);
      for (const op of staged) op();
      return result;
    },
  };
}

test('rate-limit: first message initializes the counter at 1, allowed', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  const decision = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 10);
  assert.equal(decision.allowed, true);
  assert.equal(decision.used, 1);
  assert.equal(decision.limit, 10);
  assert.ok(decision.resetsAt instanceof Date);
});

test('rate-limit: counter increments up to the limit', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  for (let i = 0; i < 5; i++) {
    const d = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 5);
    assert.equal(d.allowed, true);
    assert.equal(d.used, i + 1);
  }
  // 6th call should be rejected.
  const rejected = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 5);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.used, 5);
  assert.equal(rejected.limit, 5);
});

test('rate-limit: limit=0 rejects the first message', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  const decision = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 0);
  assert.equal(decision.allowed, false);
});

test('rate-limit: counter resets when the stored expiresAt is in the past', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  // Manually create a stale counter with expiresAt yesterday.
  const path = 'b2bTenants/acme/rateLimits/vs_abc';
  await db
    .collection('b2bTenants/acme/rateLimits')
    .doc('vs_abc')
    .set({
      messagesToday: 999,
      expiresAt: Timestamp.fromDate(new Date(Date.now() - 60_000)),
    });
  const decision = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 5);
  assert.equal(decision.allowed, true);
  assert.equal(decision.used, 1, 'counter should reset to 1, not 1000');
});

test('rate-limit: per-visitor counters do not interfere with each other', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await checkAndIncrementRateLimit(db, 'acme', 'vs_alice', 2);
  await checkAndIncrementRateLimit(db, 'acme', 'vs_alice', 2);
  const aliceBlocked = await checkAndIncrementRateLimit(db, 'acme', 'vs_alice', 2);
  assert.equal(aliceBlocked.allowed, false);
  // Bob's counter is independent.
  const bob = await checkAndIncrementRateLimit(db, 'acme', 'vs_bob', 2);
  assert.equal(bob.allowed, true);
  assert.equal(bob.used, 1);
});

test('rate-limit: per-tenant counters do not interfere with each other', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 1);
  const acmeBlocked = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 1);
  assert.equal(acmeBlocked.allowed, false);
  const globex = await checkAndIncrementRateLimit(db, 'globex', 'vs_abc', 1);
  assert.equal(globex.allowed, true);
});

test('rate-limit: rejected call does NOT increment the counter', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 1);
  const a = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 1);
  assert.equal(a.allowed, false);
  // After counter expires (simulate by setting expiresAt in past),
  // counter resets to 1, not 2.
  await db
    .collection('b2bTenants/acme/rateLimits')
    .doc('vs_abc')
    .update({ expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)) });
  const b = await checkAndIncrementRateLimit(db, 'acme', 'vs_abc', 1);
  assert.equal(b.allowed, true);
  assert.equal(b.used, 1);
});

// Suppress unused import warnings (FieldValue is used through
// sentinels in the fake; this import is for clarity).
void FieldValue;
