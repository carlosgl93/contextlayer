import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Firestore } from 'firebase-admin/firestore';
import { fetchB2BProfile } from './profile-client';
import { ensureSiteAccess } from './siteaccess';

/**
 * Tests for the profile fetch helper.
 *
 * Until Plan 004's B2B profile endpoint is merged, the only
 * working path is the Admin SDK fallback that reads
 * `users/{uid}/profile/main`. The endpoint shim returns null
 * (which triggers the fallback). These tests exercise the
 * fallback path end-to-end.
 */

type DocData = Record<string, unknown>;

function isIncrementSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.getPrototypeOf(v)?.constructor?.name === 'NumericIncrementTransform';
}
function isServerTimestampSentinel(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  return Object.getPrototypeOf(v)?.constructor?.name === 'ServerTimestampTransform';
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
    collection(child: string) {
      return makeCollection(`${path}/${child}`);
    },
  });
  const makeCollection = (base: string) => ({
    doc: (id: string) => makeDoc(`${base}/${id}`, id),
    where(field: string, op: string, value: unknown) {
      const filters: Array<(d: DocData) => boolean> = [];
      filters.push((d) => (op === '==' ? d[field] === value : false));
      return {
        async get() {
          const out: Array<{ id: string; ref: { path: string }; data: () => DocData }> = [];
          for (const [path, data] of docs.entries()) {
            if (!path.startsWith(`${base}/`)) continue;
            if (filters.every((f) => f(data))) {
              out.push({ id: path.slice(base.length + 1), ref: { path }, data: () => data });
            }
          }
          return { docs: out, size: out.length, empty: out.length === 0 };
        },
      };
    },
  });
  return {
    collection: (p: string) => makeCollection(p),
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
      const pending: Array<() => void> = [];
      return {
        update(ref: { path: string }, data: DocData) {
          pending.push(() => {
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

test('fetchB2BProfile: returns null when no siteAccess exists', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  const profile = await fetchB2BProfile(db, { tenantId: 'acme', visitorId: 'vs_unknown' });
  assert.equal(profile, null);
});

test('fetchB2BProfile: returns null when siteAccess exists but no profile doc', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(db, 'acme', 'vs_alice', 'uid_alice');
  const profile = await fetchB2BProfile(db, { tenantId: 'acme', visitorId: 'vs_alice' });
  assert.equal(profile, null);
});

test('fetchB2BProfile: returns normalized profile when users/{uid}/profile/main exists', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(db, 'acme', 'vs_alice', 'uid_alice');
  await db
    .collection('users/uid_alice/profile')
    .doc('main')
    .set({
      updatedAt: new Date('2026-01-15T00:00:00Z'),
      preferences: [
        { value: 'vegetarian', source: 'chatgpt' },
        { value: 'concise answers', source: 'claude' },
      ],
      personalFacts: [{ value: 'lives in Berlin', source: 'gemini' }],
      activeIntentions: [{ value: 'planning Q2 launch', source: 'chatgpt' }],
      domainsOfInterest: [{ value: 'distributed systems', source: 'chatgpt' }],
    });

  const profile = await fetchB2BProfile(db, { tenantId: 'acme', visitorId: 'vs_alice' });
  assert.ok(profile);
  assert.equal(profile!.uid, 'uid_alice');
  assert.equal(profile!.updatedAt, '2026-01-15T00:00:00.000Z');
  assert.equal(profile!.preferences.length, 2);
  assert.equal(profile!.preferences[0].value, 'vegetarian');
  assert.equal(profile!.personalFacts[0].source, 'gemini');
  assert.equal(profile!.activeIntentions[0].value, 'planning Q2 launch');
  assert.equal(profile!.domainsOfInterest[0].value, 'distributed systems');
});

test('fetchB2BProfile: tolerates missing/empty arrays', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(db, 'acme', 'vs_bob', 'uid_bob');
  await db
    .collection('users/uid_bob/profile')
    .doc('main')
    .set({ updatedAt: new Date().toISOString() });
  const profile = await fetchB2BProfile(db, { tenantId: 'acme', visitorId: 'vs_bob' });
  assert.ok(profile);
  assert.deepEqual(profile!.preferences, []);
  assert.deepEqual(profile!.personalFacts, []);
  assert.deepEqual(profile!.activeIntentions, []);
  assert.deepEqual(profile!.domainsOfInterest, []);
});

test('fetchB2BProfile: falls back to Admin SDK when fetcher throws', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(db, 'acme', 'vs_alice', 'uid_alice');
  await db
    .collection('users/uid_alice/profile')
    .doc('main')
    .set({
      updatedAt: new Date('2026-01-15T00:00:00Z'),
      preferences: [{ value: 'vegetarian', source: 'chatgpt' }],
      personalFacts: [],
      activeIntentions: [],
      domainsOfInterest: [],
    });
  const profile = await fetchB2BProfile(db, {
    tenantId: 'acme',
    visitorId: 'vs_alice',
    fetcher: async () => {
      throw new Error('Plan 004 endpoint not deployed yet');
    },
  });
  assert.ok(profile);
  assert.equal(profile!.uid, 'uid_alice');
  assert.equal(profile!.preferences[0].value, 'vegetarian');
});

test('fetchB2BProfile: fetcher returning a profile wins over Admin SDK', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await ensureSiteAccess(db, 'acme', 'vs_alice', 'uid_alice');
  await db
    .collection('users/uid_alice/profile')
    .doc('main')
    .set({
      updatedAt: new Date(),
      preferences: [{ value: 'admin-sdk-result', source: 'track-1' }],
      personalFacts: [],
      activeIntentions: [],
      domainsOfInterest: [],
    });
  const profile = await fetchB2BProfile(db, {
    tenantId: 'acme',
    visitorId: 'vs_alice',
    fetcher: async () => ({
      uid: 'uid_alice',
      updatedAt: '2026-06-01T00:00:00.000Z',
      preferences: [{ value: 'plan-004-result', source: 'plan-004' }],
      personalFacts: [],
      activeIntentions: [],
      domainsOfInterest: [],
    }),
  });
  assert.ok(profile);
  assert.equal(profile!.preferences[0].value, 'plan-004-result');
});
