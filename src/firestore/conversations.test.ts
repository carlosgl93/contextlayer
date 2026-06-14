import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { writeConversations } from './conversations';
import type { ConversationRecord } from '../types';

/**
 * Minimal in-memory Firestore fake. Mirrors only the surface that
 * writeConversations touches: collection().doc(), batch().set().commit().
 * Each set() is recorded by its docId so tests can assert what was
 * written and which batch boundary it landed in.
 */
interface FakeDocRef {
  docId: string;
  collection(_path: string): { doc(docId: string): FakeDocRef };
}
interface FakeBatch {
  sets: Array<{ ref: FakeDocRef; data: Record<string, unknown> }>;
  set(ref: FakeDocRef, data: Record<string, unknown>): FakeBatch;
  commit(): Promise<void>;
}
function makeFakeFirestore(opts: { commitThrows?: Error } = {}) {
  const docs = new Map<string, Record<string, unknown>>();
  const batches: FakeBatch[] = [];
  const makeDoc = (docId: string): FakeDocRef => ({
    docId,
    collection: (_path: string) => ({ doc: (id: string) => makeDoc(id) }),
  });
  const collection = (_path: string) => ({ doc: (docId: string) => makeDoc(docId) });
  const doc = (docId: string) => makeDoc(docId);
  const batch = (): FakeBatch => {
    const b: FakeBatch = {
      sets: [],
      set(ref, data) {
        this.sets.push({ ref, data });
        return this;
      },
      async commit() {
        if (opts.commitThrows) throw opts.commitThrows;
        for (const { ref, data } of b.sets) {
          const prev = docs.get(ref.docId) ?? {};
          docs.set(ref.docId, { ...prev, ...data });
        }
      },
    };
    batches.push(b);
    return b;
  };
  return { docs, batches, collection, doc, batch };
}

function rec(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    provider: 'claude',
    providerId: 'conv-1',
    title: 'Test conv',
    date: new Date('2026-01-01T00:00:00Z'),
    messageCount: 2,
    rawText: 'user: hi\nassistant: hello',
    truncated: false,
    ...over,
  };
}

test('writeConversations writes one doc per record keyed by provider_providerId', async () => {
  const fake = makeFakeFirestore();
  const records = [rec({ providerId: 'a' }), rec({ providerId: 'b' })];
  const result = await writeConversations(
    fake as unknown as Firestore,
    'user-1',
    records,
  );
  assert.equal(result.written, 2);
  assert.equal(fake.docs.size, 2);
  assert.deepEqual(fake.docs.get('claude_a')?.providerId, 'a');
  assert.deepEqual(fake.docs.get('claude_b')?.providerId, 'b');
});

test('writeConversations tags every doc with a server timestamp', async () => {
  const fake = makeFakeFirestore();
  await writeConversations(fake as unknown as Firestore, 'user-1', [
    rec({ providerId: 'x' }),
  ]);
  const stored = fake.docs.get('claude_x');
  assert.ok(stored?.importedAt instanceof FieldValue, 'importedAt should be a FieldValue sentinel');
});

test('writeConversations paginates into 500-doc batches', async () => {
  const fake = makeFakeFirestore();
  const records = Array.from({ length: 600 }, (_, i) =>
    rec({ providerId: `c-${i}` }),
  );
  const result = await writeConversations(
    fake as unknown as Firestore,
    'user-1',
    records,
  );
  assert.equal(result.written, 600);
  assert.equal(fake.batches.length, 2);
  assert.equal(fake.batches[0]!.sets.length, 500);
  assert.equal(fake.batches[1]!.sets.length, 100);
  assert.equal(fake.docs.size, 600);
});

test('writeConversations propagates Firestore commit errors', async () => {
  const fake = makeFakeFirestore({ commitThrows: new Error('firestore down') });
  await assert.rejects(
    writeConversations(fake as unknown as Firestore, 'user-1', [rec()]),
    /firestore down/,
  );
});
