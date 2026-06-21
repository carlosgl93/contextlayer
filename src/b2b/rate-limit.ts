import { type Firestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

/**
 * Per-visitor daily rate limit.
 *
 * Counter lives at
 *   b2bTenants/{tenantId}/rateLimits/{visitorId}
 * with one field `messagesToday` and an `expiresAt` timestamp
 * set to the start of the next UTC day. On every increment we
 * also check `expiresAt` — if it's in the past, we reset the
 * counter to 1 and reset `expiresAt` to the next UTC midnight.
 *
 * The check is atomic: a Firestore transaction reads the doc,
 * decides whether to reset, and increments. Two concurrent
 * messages from the same visitor can both pass the read but the
 * transaction serializes the write, so the counter never
 * overshoots the limit by more than one.
 *
 * Returns a `RateLimitDecision` so the route can act on it:
 *   - allowed=false → 429 with `Retry-After` seconds until reset
 *   - allowed=true  → continue
 */

export interface RateLimitDecision {
  allowed: boolean;
  used: number;
  limit: number;
  resetsAt: Date | null;
}

function nextUtcMidnight(now: Date): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

export async function checkAndIncrementRateLimit(
  db: Firestore,
  tenantId: string,
  visitorId: string,
  limit: number,
): Promise<RateLimitDecision> {
  const ref = db.collection(`b2bTenants/${tenantId}/rateLimits`).doc(visitorId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = new Date();
    const resetsAt = nextUtcMidnight(now);

    if (!snap.exists) {
      // First message of the (UTC) day.
      if (limit <= 0) {
        return { allowed: false, used: 0, limit, resetsAt };
      }
      tx.set(ref, {
        messagesToday: 1,
        expiresAt: Timestamp.fromDate(resetsAt),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { allowed: true, used: 1, limit, resetsAt };
    }

    const data = snap.data() as { messagesToday?: number; expiresAt?: Timestamp };
    const storedExpires = data.expiresAt?.toDate?.() ?? null;
    const expired = storedExpires ? storedExpires.getTime() <= now.getTime() : true;
    const usedBase = expired ? 0 : data.messagesToday ?? 0;

    if (usedBase + 1 > limit) {
      return {
        allowed: false,
        used: usedBase,
        limit,
        resetsAt: storedExpires ?? resetsAt,
      };
    }

    tx.update(ref, {
      messagesToday: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
      // Refresh expiresAt only on the roll-over — otherwise
      // every increment would push the deadline forward, which
      // is not what we want.
      ...(expired ? { expiresAt: Timestamp.fromDate(resetsAt) } : {}),
    });
    return { allowed: true, used: usedBase + 1, limit, resetsAt: storedExpires ?? resetsAt };
  });
}
