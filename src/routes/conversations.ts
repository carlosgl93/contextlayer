import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { authenticate } from '../middleware/auth';
import type { Provider } from '../types';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface ConversationListItem {
  provider: Provider;
  providerId: string;
  title: string;
  date: string; // ISO-8601
  messageCount: number;
}

export interface ConversationListResponse {
  conversations: ConversationListItem[];
  /**
   * Opaque cursor for the next page. `null` when no more results.
   * Cursor pagination is intentionally not implemented in V1 — the
   * page size is bounded (50 by default, 200 max) and clients can
   * narrow with `from`/`to` instead. Wiring a real cursor requires
   * DocumentSnapshot-based startAfter() and was deferred to keep U7
   * small. The field is reserved in the response so clients can plan
   * for it.
   */
  cursor: string | null;
}

const conversationsRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Reply: ConversationListResponse }>(
    '/api/v1/user/conversations',
    { preHandler: authenticate },
    async (request, reply) => {
      const uid = request.user?.uid;
      if (!uid) {
        return reply.code(401).send({ conversations: [], cursor: null });
      }

      const q = request.query as {
        provider?: string;
        from?: string;
        to?: string;
        pageSize?: string;
      };

      const size = Math.min(
        parsePositiveInt(q.pageSize) ?? DEFAULT_PAGE_SIZE,
        MAX_PAGE_SIZE,
      );

      const db = app.firebaseAdmin.firestore();
      // The base query is scoped to the authenticated user — a request
      // cannot reach another user's conversations even by accident.
      let query = db
        .collection('users')
        .doc(uid)
        .collection('conversations') as FirebaseFirestore.Query;

      if (q.provider === 'claude' || q.provider === 'chatgpt') {
        query = query.where('provider', '==', q.provider);
      }
      const fromDate = parseDate(q.from);
      if (fromDate) query = query.where('date', '>=', fromDate);
      const toDate = parseDate(q.to);
      if (toDate) query = query.where('date', '<=', toDate);

      query = query.orderBy('date', 'desc').limit(size);

      const snap = await query.get();
      const conversations: ConversationListItem[] = snap.docs.map((d) => {
        const data = d.data() as {
          provider: Provider;
          providerId: string;
          title: string;
          date: { toISOString(): string } | Date;
          messageCount: number;
        };
        return {
          provider: data.provider,
          providerId: data.providerId,
          title: data.title,
          date:
            data.date instanceof Date
              ? data.date.toISOString()
              : data.date.toISOString(),
          messageCount: data.messageCount,
        };
      });

      return { conversations, cursor: null };
    },
  );
};

function parsePositiveInt(s: string | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default fp(conversationsRoute) as FastifyPluginAsync;
