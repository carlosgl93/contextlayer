import { type Firestore, FieldValue } from 'firebase-admin/firestore';

/**
 * Conversation persistence.
 *
 * Path:
 *   b2bTenants/{tenantId}/visitors/{visitorId}/conversations/{conversationId}
 *
 * A conversation is a flat list of `{ role, content, ts }` plus
 * token counts and provider info. We store the full message
 * history rather than a separate messages subcollection so the
 * whole conversation round-trips in a single doc read (max ~1MB
 * at Firestore's per-doc limit — fine for chat-length exchanges).
 *
 * conversationId is generated server-side as `c_<12 chars base62>`
 * if the request doesn't provide one. The client should send a
 * stable id from localStorage so refreshing the page keeps the
 * same thread.
 */

import { createHash } from 'node:crypto';

export interface PersistedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  ts: number;
}

export interface PersistedConversation {
  conversationId: string;
  tenantId: string;
  visitorId: string;
  provider: string;
  messages: PersistedMessage[];
  tokenCountIn: number;
  tokenCountOut: number;
  createdAt: Date;
  updatedAt: Date;
}

function generateConversationId(): string {
  const hex = createHash('sha256')
    .update(`${Date.now()}:${Math.random()}`)
    .digest('hex');
  const slice = hex.slice(0, 10);
  let n = BigInt(`0x${slice}`);
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8 && n > 0n; i++) {
    out = alphabet[Number(n % 62n)] + out;
    n = n / 62n;
  }
  return `c_${out.padStart(8, '0')}`;
}

export function ensureConversationId(provided: string | undefined): string {
  if (provided && /^c_[0-9A-Za-z]{1,16}$/.test(provided)) return provided;
  return generateConversationId();
}

export async function loadConversation(
  db: Firestore,
  tenantId: string,
  visitorId: string,
  conversationId: string,
): Promise<PersistedMessage[] | null> {
  const ref = db
    .collection(`b2bTenants/${tenantId}/visitors/${visitorId}/conversations`)
    .doc(conversationId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as { messages?: PersistedMessage[] };
  return data.messages ?? null;
}

export interface AppendMessageOptions {
  tenantId: string;
  visitorId: string;
  conversationId: string;
  provider: string;
  message: PersistedMessage;
  tokenCountIn?: number;
  tokenCountOut?: number;
}

export async function appendMessage(
  db: Firestore,
  opts: AppendMessageOptions,
): Promise<void> {
  const ref = db
    .collection(`b2bTenants/${opts.tenantId}/visitors/${opts.visitorId}/conversations`)
    .doc(opts.conversationId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      conversationId: opts.conversationId,
      tenantId: opts.tenantId,
      visitorId: opts.visitorId,
      provider: opts.provider,
      messages: [opts.message],
      tokenCountIn: opts.tokenCountIn ?? 0,
      tokenCountOut: opts.tokenCountOut ?? 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return;
  }
  const existing = (snap.data() as { messages?: PersistedMessage[] }).messages ?? [];
  await ref.update({
    messages: [...existing, opts.message],
    tokenCountIn: FieldValue.increment(opts.tokenCountIn ?? 0),
    tokenCountOut: FieldValue.increment(opts.tokenCountOut ?? 0),
    updatedAt: FieldValue.serverTimestamp(),
  });
}
