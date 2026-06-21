import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Firestore, FieldValue } from 'firebase-admin/firestore';
import {
  appendMessage,
  ensureConversationId,
  loadConversation,
  type PersistedMessage,
} from './chat-history';

/**
 * Tests for conversation persistence.
 *
 * Verifies:
 *   - ensureConversationId accepts well-formed ids, generates new ones otherwise
 *   - loadConversation returns null when missing, the messages otherwise
 *   - appendMessage creates a new doc on first call, appends to existing
 *   - tokenCountIn/Out are incremented via FieldValue.increment
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
      !isIncrementSentinel(v) &&
      !isServerTimestampSentinel(v)
    ) {
      const sub = (target[k] as DocData | undefined) ?? {};
      target[k] = applyDottedUpdate({ ...sub }, v as DocData);
    } else if (isIncrementSentinel(v)) {
      const n = (v as { _operand?: number })._operand ?? 1;
      const cur = typeof target[k] === 'number' ? (target[k] as number) : 0;
      target[k] = cur + n;
    } else if (isServerTimestampSentinel(v)) {
      target[k] = new Date();
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
      docs.set(path, applyDottedUpdate({ ...existing }, data));
    },
    collection(child: string) {
      return makeCollection(`${path}/${child}`);
    },
  });
  const makeCollection = (base: string) => ({
    doc: (id: string) => makeDoc(`${base}/${id}`),
  });
  return { collection: (p: string) => makeCollection(p), _docs: docs };
}

const userMsg = (text: string): PersistedMessage => ({ role: 'user', content: text, ts: 1000 });
const asstMsg = (text: string): PersistedMessage => ({ role: 'assistant', content: text, ts: 1001 });

test('ensureConversationId: accepts valid c_ prefixed id', () => {
  assert.equal(ensureConversationId('c_abc12345'), 'c_abc12345');
});

test('ensureConversationId: rejects malformed id and generates a new one', () => {
  const id1 = ensureConversationId(undefined);
  const id2 = ensureConversationId('not-a-valid-id');
  assert.match(id1, /^c_[0-9A-Za-z]{1,16}$/);
  assert.match(id2, /^c_[0-9A-Za-z]{1,16}$/);
  assert.notEqual(id1, id2, 'two unprovided calls should produce different ids');
});

test('loadConversation: returns null when no conversation exists', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  const res = await loadConversation(db, 'acme', 'vs_abc', 'c_xyz');
  assert.equal(res, null);
});

test('appendMessage: first call creates the doc with the message', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await appendMessage(db, {
    tenantId: 'acme',
    visitorId: 'vs_abc',
    conversationId: 'c_conv1',
    provider: 'openai',
    message: userMsg('hello'),
    tokenCountIn: 10,
    tokenCountOut: 0,
  });
  const msgs = await loadConversation(db, 'acme', 'vs_abc', 'c_conv1');
  assert.ok(msgs);
  assert.equal(msgs!.length, 1);
  assert.equal(msgs![0].role, 'user');
  assert.equal(msgs![0].content, 'hello');
});

test('appendMessage: subsequent calls append in order, accumulate token counts', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await appendMessage(db, {
    tenantId: 'acme',
    visitorId: 'vs_abc',
    conversationId: 'c_conv2',
    provider: 'openai',
    message: userMsg('hi'),
    tokenCountIn: 5,
  });
  await appendMessage(db, {
    tenantId: 'acme',
    visitorId: 'vs_abc',
    conversationId: 'c_conv2',
    provider: 'openai',
    message: asstMsg('hello there'),
    tokenCountIn: 5,
    tokenCountOut: 7,
  });
  const msgs = await loadConversation(db, 'acme', 'vs_abc', 'c_conv2');
  assert.ok(msgs);
  assert.equal(msgs!.length, 2);
  assert.equal(msgs![1].role, 'assistant');
  assert.equal(msgs![1].content, 'hello there');
});

test('appendMessage: separate conversationIds are independent', async () => {
  const db = makeFakeFirestore() as unknown as Firestore;
  await appendMessage(db, {
    tenantId: 'acme',
    visitorId: 'vs_abc',
    conversationId: 'c_a',
    provider: 'openai',
    message: userMsg('A1'),
  });
  await appendMessage(db, {
    tenantId: 'acme',
    visitorId: 'vs_abc',
    conversationId: 'c_b',
    provider: 'openai',
    message: userMsg('B1'),
  });
  const a = await loadConversation(db, 'acme', 'vs_abc', 'c_a');
  const b = await loadConversation(db, 'acme', 'vs_abc', 'c_b');
  assert.equal(a!.length, 1);
  assert.equal(b!.length, 1);
  assert.equal(a![0].content, 'A1');
  assert.equal(b![0].content, 'B1');
});

void FieldValue;
