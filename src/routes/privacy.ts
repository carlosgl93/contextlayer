import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { authenticate } from '../middleware/auth';
import {
  deleteAllConversations,
  deleteConversationsForProvider,
} from '../firestore/conversations';
import { deleteProfile, removeProviderFromProfile } from '../firestore/profile';
import {
  deactivateAccess,
  deleteAllAccess,
  listActiveAccess,
  type SiteAccessRecord,
} from '../firestore/access';
import type { Provider } from '../types';

interface DeleteResponse {
  deleted: boolean;
  error?: string;
}

const VALID_PROVIDERS: ReadonlyArray<Provider> = ['claude', 'chatgpt'];

const privacyRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  /**
   * Hard-delete the user's full data set: every conversation across
   * providers, the synthesized profile, and every siteAccess record
   * (active or revoked — wipe means wipe). Idempotent.
   */
  app.delete<{ Reply: DeleteResponse }>(
    '/api/v1/user/data',
    { preHandler: authenticate },
    async (request) => {
      const uid = request.user!.uid;
      const db = app.firebaseAdmin.firestore();
      // Order doesn't matter functionally; conversations first so a
      // partial-failure leaves the profile intact for re-reconciliation.
      await deleteAllConversations(db, uid);
      await deleteProfile(db, uid);
      await deleteAllAccess(db, uid);
      return { deleted: true };
    },
  );

  /**
   * Delete a single provider's slice: its conversations plus the
   * provider's contributions to the synthesized profile. The other
   * provider's conversations stay. Idempotent.
   */
  app.delete<{ Params: { provider: string }; Reply: DeleteResponse }>(
    '/api/v1/user/data/provider/:provider',
    { preHandler: authenticate },
    async (request, reply) => {
      const provider = request.params.provider;
      if (!VALID_PROVIDERS.includes(provider as Provider)) {
        return reply
          .code(400)
          .send({ deleted: false, error: 'invalid_provider' });
      }
      const uid = request.user!.uid;
      const db = app.firebaseAdmin.firestore();
      await deleteConversationsForProvider(db, uid, provider);
      await removeProviderFromProfile(db, uid, provider);
      return { deleted: true };
    },
  );

  /**
   * Delete the synthesized profile only. Conversations remain so the
   * user can re-extract a fresh profile from the existing history
   * later. Idempotent.
   */
  app.delete<{ Reply: DeleteResponse }>(
    '/api/v1/user/profile',
    { preHandler: authenticate },
    async (request) => {
      const uid = request.user!.uid;
      const db = app.firebaseAdmin.firestore();
      await deleteProfile(db, uid);
      return { deleted: true };
    },
  );

  /**
   * List the third-party sites the user has currently authorized to
   * read their profile. Revoked (`active: false`) entries are not
   * surfaced but are retained for audit.
   */
  app.get<{ Reply: { access: SiteAccessRecord[] } }>(
    '/api/v1/user/access',
    { preHandler: authenticate },
    async (request) => {
      const uid = request.user!.uid;
      const db = app.firebaseAdmin.firestore();
      const access = await listActiveAccess(db, uid);
      return { access };
    },
  );

  /**
   * Soft-revoke a site's access (`active: false`). The document is
   * kept for audit; `GET /access` stops returning it. Idempotent.
   */
  app.delete<{ Params: { siteId: string }; Reply: DeleteResponse }>(
    '/api/v1/user/access/:siteId',
    { preHandler: authenticate },
    async (request) => {
      const uid = request.user!.uid;
      const db = app.firebaseAdmin.firestore();
      await deactivateAccess(db, uid, request.params.siteId);
      return { deleted: true };
    },
  );
};

export default fp(privacyRoute) as FastifyPluginAsync;
