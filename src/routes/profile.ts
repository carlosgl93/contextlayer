import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { authenticate } from '../middleware/auth';
import { readUserProfile, type ProfileReadResult } from '../firestore/profile';

/**
 * GET /api/v1/profile
 *
 * Read-only view of the user's synthesized profile. Pure Firestore read
 * of `users/{uid}/profile/main` — no LLM, no aggregation. Returns the
 * same shape that `mergeProfile` writes, plus the server-set
 * `updatedAt` as an ISO-8601 string.
 *
 * 404 when the user has never run an import (no profile doc yet). This
 * is a deliberate contract: it distinguishes "you imported but got
 * nothing" (empty arrays, 200) from "you have not imported" (404).
 *
 * No pagination: typical profile = 50-200 signals total, well bounded.
 * V2 may add filtering by provider/source if the founder wants it.
 */
const profileRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Reply: ProfileReadResult | { error: string } }>(
    '/api/v1/profile',
    { preHandler: authenticate },
    async (request, reply) => {
      const uid = request.user!.uid;
      const db = app.firebaseAdmin.firestore();
      const profile = await readUserProfile(db, uid);
      if (!profile) {
        return reply.code(404).send({ error: 'profile_not_found' });
      }
      return profile;
    },
  );
};

export default fp(profileRoute) as FastifyPluginAsync;
