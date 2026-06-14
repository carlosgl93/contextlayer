import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { deleteConversationsForProvider, deleteAllConversations } from './conversations';
import { removeProviderFromProfile, deleteProfile } from './profile';
import { listActiveAccess, deactivateAccess } from './access';
import type { ConversationRecord, ExtractionSignal } from '../types';

/**
 * Comprehensive in-memory Firestore fake. Mirrors the surface the
 * U8 firestore operations need: collection().where().get(), doc.get(),
 * doc.set/update/delete, batch().set/update/delete().commit().
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
        const out: Array<{ id: string; ref: { path: string }; data: () => Record<string, unknown> }> = [];
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
      const ops: Array<{ kind: 'set' | 'update' | 'delete'; ref: { path: string }; data?: Record<string, unknown> }> = [];
      const b = {
        set(ref: { path: string }, data: Record<string, unknown>) {
          ops.push({ kind: 'set', ref, data });
          return b;
        },
        update(ref: { path: string }, data: Record<string, unknown>) {
          ops.push({ kind: 'update', ref, data });
          return b;
        },
        delete(ref: { path: string }) {
          ops.push({ kind: 'delete', ref });
          return b;
        },
        async commit() {
          for (const op of ops) {
            if (op.kind === 'set') docs.set(op.ref.path, { ...(docs.get(op.ref.path) ?? {}), ...op.data! });
            else if (op.kind === 'update') docs.set(op.ref.path, { ...(docs.get(op.ref.path) ?? {}), ...op.data! });
            else docs.delete(op.ref.path);
          }
        },
      };
      return b;
    },
  };
}

function rec(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    provider: 'claude',
    providerId: 'conv-1',
    title: 'T',
    date: new Date('2026-01-01T00:00:00Z'),
    messageCount: 1,
    rawText: 'u: hi',
    truncated: false,
    ...over,
  };
}

function sig(value: string, provider: string): ExtractionSignal {
  return { value, provider, source: 'Test conv' };
}

test('deleteConversationsForProvider: removes only the matching provider', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/conversations/claude_a', { ...rec({ provider: 'claude', providerId: 'a' }) });
  fake.docs.set('users/u/conversations/claude_b', { ...rec({ provider: 'claude', providerId: 'b' }) });
  fake.docs.set('users/u/conversations/chatgpt_c', { ...rec({ provider: 'chatgpt', providerId: 'c' }) });
  const result = await deleteConversationsForProvider(fake as unknown as Firestore, 'u', 'claude');
  assert.equal(result.deleted, 2);
  assert.equal(fake.docs.has('users/u/conversations/claude_a'), false);
  assert.equal(fake.docs.has('users/u/conversations/claude_b'), false);
  assert.equal(fake.docs.has('users/u/conversations/chatgpt_c'), true);
});

test('deleteConversationsForProvider: returns 0 when nothing matches (idempotent)', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/conversations/chatgpt_c', { ...rec({ provider: 'chatgpt' }) });
  const result = await deleteConversationsForProvider(fake as unknown as Firestore, 'u', 'claude');
  assert.equal(result.deleted, 0);
  assert.equal(fake.docs.has('users/u/conversations/chatgpt_c'), true);
});

test('deleteAllConversations: removes every conversation for the user', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/conversations/claude_a', { ...rec({ provider: 'claude', providerId: 'a' }) });
  fake.docs.set('users/u/conversations/chatgpt_b', { ...rec({ provider: 'chatgpt', providerId: 'b' }) });
  fake.docs.set('users/other/conversations/claude_x', { ...rec({ provider: 'claude', providerId: 'x' }) });
  const result = await deleteAllConversations(fake as unknown as Firestore, 'u');
  assert.equal(result.deleted, 2);
  assert.equal(fake.docs.has('users/u/conversations/claude_a'), false);
  assert.equal(fake.docs.has('users/u/conversations/chatgpt_b'), false);
  // other user untouched
  assert.equal(fake.docs.has('users/other/conversations/claude_x'), true);
});

test('removeProviderFromProfile: filters signals for the given provider', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/profile/main', {
    preferences: [sig('electric cars', 'claude'), sig('dark mode', 'chatgpt')],
    personalFacts: [sig('lives in Chile', 'claude')],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const result = await removeProviderFromProfile(fake as unknown as Firestore, 'u', 'claude');
  assert.equal(result.removed, 2);
  const written = fake.docs.get('users/u/profile/main') as {
    preferences: ExtractionSignal[];
    personalFacts: ExtractionSignal[];
  };
  assert.equal(written.preferences.length, 1);
  assert.equal(written.preferences[0]!.provider, 'chatgpt');
  assert.equal(written.personalFacts.length, 0);
  assert.ok(written.preferences, 'profile still present');
});

test('removeProviderFromProfile: returns 0 + updatedAt when no signals match', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/profile/main', {
    preferences: [sig('electric cars', 'chatgpt')],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const result = await removeProviderFromProfile(fake as unknown as Firestore, 'u', 'claude');
  assert.equal(result.removed, 0);
  const written = fake.docs.get('users/u/profile/main') as {
    preferences: ExtractionSignal[];
    updatedAt: unknown;
  };
  assert.equal(written.preferences.length, 1);
  assert.ok(written.updatedAt instanceof FieldValue);
});

test('deleteProfile: removes the profile doc', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/profile/main', { preferences: [sig('x', 'claude')] });
  await deleteProfile(fake as unknown as Firestore, 'u');
  assert.equal(fake.docs.has('users/u/profile/main'), false);
});

test('deleteProfile: is idempotent (no error when profile is missing)', async () => {
  const fake = makeFakeFirestore();
  await deleteProfile(fake as unknown as Firestore, 'u');
  assert.equal(fake.docs.has('users/u/profile/main'), false);
});

test('listActiveAccess: returns only docs with active: true', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/siteAccess/site-a', { active: true, grantedAt: '2026-01-01' });
  fake.docs.set('users/u/siteAccess/site-b', { active: false, grantedAt: '2025-12-01' });
  fake.docs.set('users/u/siteAccess/site-c', { active: true, grantedAt: '2026-02-01' });
  const result = await listActiveAccess(fake as unknown as Firestore, 'u');
  assert.equal(result.length, 2);
  const ids = result.map((r) => r.siteId).sort();
  assert.deepEqual(ids, ['site-a', 'site-c']);
});

test('deactivateAccess: sets active: false on the named site', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('users/u/siteAccess/site-a', { active: true });
  await deactivateAccess(fake as unknown as Firestore, 'u', 'site-a');
  const written = fake.docs.get('users/u/siteAccess/site-a') as { active: boolean };
  assert.equal(written.active, false);
  // doc still exists (audit trail)
  assert.equal(fake.docs.has('users/u/siteAccess/site-a'), true);
});

test('deactivateAccess: is idempotent (no error when siteId is missing)', async () => {
  const fake = makeFakeFirestore();
  await deactivateAccess(fake as unknown as Firestore, 'u', 'never-existed');
  // No new doc created
  assert.equal(fake.docs.has('users/u/siteAccess/never-existed'), false);
});
