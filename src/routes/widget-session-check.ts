import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { sessionAuth } from '../middleware/session-auth';
import { sessionCheck } from '../b2b/siteaccess';

/**
 * GET /api/v1/widget/session-check?tenant=acme
 *
 * Implicit-auth detection: the widget calls this on mount with
 * `credentials: 'include'` so the Firebase session cookie set by
 * `app.contextlayer.io` travels cross-origin. If the cookie is
 * valid, the server derives `visitorId = hash(uid + tenantId)`
 * and lazy-creates a `siteAccess` record.
 *
 * Responses:
 *   200 { authenticated: true, visitorId: "vs_xxx", created: true }
 *     — visitor is recognized; widget can start chatting
 *   200 { authenticated: false, signInUrl: "..." }
 *     — no session cookie or revoked; widget shows the sign-in CTA
 *   401 { error: "no_session" }
 *     — cookie present but invalid/expired; widget re-prompts sign-in
 *
 * The tenant id is read from the `tenant` query param. There is
 * no API-key check on this route — the visitor is unauthenticated
 * at this point. The tenant id is used only as a salt for the
 * visitorId hash and to namespace the siteAccess record; an
 * attacker who guesses a tenantId gets their own cookie's
 * visitorId, which is useless without a real session cookie.
 */

interface SessionCheckOk {
  authenticated: true;
  visitorId: string;
  created: boolean;
}
interface SessionCheckAnon {
  authenticated: false;
  signInUrl: string;
}

const widgetSessionCheckRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{
    Querystring: { tenant?: string };
    Reply: SessionCheckOk | SessionCheckAnon | { error: string; message?: string };
  }>(
    '/api/v1/widget/session-check',
    { preHandler: sessionAuth },
    async (request, reply) => {
      const tenantId = request.query.tenant;
      if (!tenantId) {
        return reply.code(400).send({ error: 'missing_tenant', message: 'tenant query param required' });
      }
      if (!/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(tenantId)) {
        return reply.code(400).send({ error: 'invalid_tenant' });
      }

      const uid = request.sessionUser!.uid;
      const result = await sessionCheck(app.firebaseAdmin.firestore(), uid, tenantId);
      return result;
    },
  );
};

export default fp(widgetSessionCheckRoute) as FastifyPluginAsync;