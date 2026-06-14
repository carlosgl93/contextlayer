import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { mergeProfile } from './profile';
import type { ExtractionResult, ExtractionSignal } from '../types';

/**
 * Minimal in-memory Firestore fake. Extends the conversation fake with
 * .get() on doc refs and .set() that overwrites — the surface mergeProfile
 * actually uses when reading and writing the profile document.
 */
interface FakeDocRef {
  docId: string;
  collection(_path: string): { doc(docId: string): FakeDocRef };
  get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>;
  set(data: Record<string, unknown>): Promise<void>;
}
function makeFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const writes: Array<{ docId: string; data: Record<string, unknown> }> = [];
  const makeDoc = (docId: string): FakeDocRef => ({
    docId,
    collection: (_path: string) => ({ doc: (id: string) => makeDoc(id) }),
    async get() {
      const data = docs.get(docId);
      return {
        exists: data !== undefined,
        data: () => data,
      };
    },
    async set(data) {
      docs.set(docId, { ...(docs.get(docId) ?? {}), ...data });
      writes.push({ docId, data });
    },
  });
  const collection = (_path: string) => ({ doc: (docId: string) => makeDoc(docId) });
  const doc = (docId: string) => makeDoc(docId);
  return { docs, writes, collection, doc };
}

function sig(value: string, provider = 'claude'): ExtractionSignal {
  return { value, provider, source: 'Test conv' };
}

function extraction(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    preferences: [],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
    ...over,
  };
}

test('mergeProfile: no existing profile + new signals creates the doc', async () => {
  const fake = makeFakeFirestore();
  const result = await mergeProfile(fake as unknown as Firestore, 'user-1', extraction({
    preferences: [sig('electric cars', 'claude')],
    personalFacts: [sig('lives in Chile')],
  }));
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 0);
  const written = fake.docs.get('main') as {
    preferences: ExtractionSignal[];
    personalFacts: ExtractionSignal[];
    updatedAt: unknown;
  };
  assert.equal(written.preferences.length, 1);
  assert.equal(written.personalFacts.length, 1);
  assert.ok(written.updatedAt instanceof FieldValue, 'updatedAt should be a FieldValue sentinel');
});

test('mergeProfile: appends unique signals to an existing profile', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('main', {
    preferences: [sig('electric cars', 'claude')],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const result = await mergeProfile(fake as unknown as Firestore, 'user-1', extraction({
    preferences: [sig('electric cars', 'claude'), sig('dark mode')],
  }));
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  const written = fake.docs.get('main') as {
    preferences: ExtractionSignal[];
    personalFacts: ExtractionSignal[];
    activeIntentions: ExtractionSignal[];
    domainsOfInterest: ExtractionSignal[];
  };
  const prefs = written.preferences;
  assert.equal(prefs.length, 2);
  assert.deepEqual(prefs.map((p) => p.value).sort(), ['dark mode', 'electric cars']);
});

test('mergeProfile: dedupes by (value, provider) across fields', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('main', {
    preferences: [sig('electric cars', 'claude')],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const result = await mergeProfile(fake as unknown as Firestore, 'user-1', extraction({
    personalFacts: [sig('electric cars', 'claude'), sig('lives in Chile')],
  }));
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  const written = fake.docs.get('main') as {
    preferences: ExtractionSignal[];
    personalFacts: ExtractionSignal[];
  };
  assert.equal(written.preferences.length, 1);
  assert.equal(written.personalFacts.length, 1);
});

test('mergeProfile: empty extraction still updates the timestamp on an existing profile', async () => {
  const fake = makeFakeFirestore();
  fake.docs.set('main', {
    preferences: [sig('electric cars')],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const result = await mergeProfile(fake as unknown as Firestore, 'user-1', extraction());
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 0);
  const written = fake.docs.get('main') as {
    preferences: ExtractionSignal[];
    updatedAt: unknown;
  };
  assert.ok(written.updatedAt instanceof FieldValue);
  assert.equal(written.preferences.length, 1);
});
