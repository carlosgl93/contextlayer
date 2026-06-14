import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { ConversationRecord } from '../types';

/** Firestore enforces a 500-operation ceiling per WriteBatch. */
const BATCH_LIMIT = 500;

export interface WriteConversationsResult {
  written: number;
}

export interface DeleteConversationsResult {
  deleted: number;
}

/**
 * Batch-write `ConversationRecord[]` to `users/{uid}/conversations`,
 * one document per record keyed by `${provider}_${providerId}`. Paginates
 * commits at 500 docs/batch per Firestore's WriteBatch limit.
 *
 * Each doc carries the full `ConversationRecord` plus a server-set
 * `importedAt` timestamp. Returns the count of documents written. Throws
 * if any batch commit fails — callers translate that into a 500.
 */
export async function writeConversations(
  db: Firestore,
  uid: string,
  records: ConversationRecord[],
): Promise<WriteConversationsResult> {
  if (records.length === 0) {
    return { written: 0 };
  }

  const conversationsCol = db.collection('users').doc(uid).collection('conversations');

  let written = 0;
  for (let start = 0; start < records.length; start += BATCH_LIMIT) {
    const chunk = records.slice(start, start + BATCH_LIMIT);
    const batch = db.batch();
    for (const record of chunk) {
      const ref = conversationsCol.doc(`${record.provider}_${record.providerId}`);
      batch.set(ref, { ...record, importedAt: FieldValue.serverTimestamp() });
    }
    await batch.commit();
    written += chunk.length;
  }

  return { written };
}

/**
 * Delete every conversation for `uid` whose `provider` matches `provider`.
 * Returns the number of documents removed. Idempotent: returns `{deleted: 0}`
 * when no docs match. Paginates at 500 deletes per batch.
 */
export async function deleteConversationsForProvider(
  db: Firestore,
  uid: string,
  provider: string,
): Promise<DeleteConversationsResult> {
  const conversationsCol = db
    .collection('users')
    .doc(uid)
    .collection('conversations');
  const snap = await conversationsCol.where('provider', '==', provider).get();
  return batchDelete(db, snap.docs.map((d) => d.ref));
}

/**
 * Delete every conversation for `uid` across all providers. Used by the
 * "delete my data" wipe. Idempotent.
 */
export async function deleteAllConversations(
  db: Firestore,
  uid: string,
): Promise<DeleteConversationsResult> {
  const conversationsCol = db
    .collection('users')
    .doc(uid)
    .collection('conversations');
  const snap = await conversationsCol.get();
  return batchDelete(db, snap.docs.map((d) => d.ref));
}

async function batchDelete(
  db: Firestore,
  refs: Array<{ path: string }>,
): Promise<DeleteConversationsResult> {
  if (refs.length === 0) return { deleted: 0 };
  let deleted = 0;
  for (let start = 0; start < refs.length; start += BATCH_LIMIT) {
    const chunk = refs.slice(start, start + BATCH_LIMIT);
    const batch = db.batch();
    for (const ref of chunk) {
      batch.delete(ref as FirebaseFirestore.DocumentReference);
    }
    await batch.commit();
    deleted += chunk.length;
  }
  return { deleted };
}

