import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { sessionAuth } from './session-auth';
import { tenantApiKeyAuth } from './tenant-api-key';
import { deriveVisitorId } from '../b2b/visitor-id';

/**
 * Combined auth for the chat route.
 *
 * Two acceptable shapes:
 *
 *  1. Browser cross-origin: API key in `Authorization: Bearer …`
 *     + `__Host-context-layer-session` cookie. The tenant API key
 *     middleware authenticates the tenant, then the sessionAuth
 *     middleware verifies the cookie and derives `request.sessionUser`.
 *
 *  2. Server-to-server / tests: API key + `?visitor_id=vs_xxx`
 *     query param. Skips sessionAuth entirely and binds the
 *     visitorId directly to the request.
 *
 * On success, attaches `request.visitorSession`:
 *   { tenantId, visitorId, mode: 'cookie' | 'visitor_id' }
 *
 * The chat route reads this single attachment to know which
 * visitor it's serving, regardless of which auth path was used.
 */

const VISITOR_ID_RE = /^vs_[0-9A-Za-z]{12}$/;
export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

declare module 'fastify' {
  interface FastifyRequest {
    visitorSession?: {
      tenantId: string;
      visitorId: string;
      mode: 'cookie' | 'visitor_id';
    };
  }
}

export const tenantPreHandler: preHandlerAsyncHookHandler = async function (this: FastifyInstance, request, reply) {
  // sessionAuth and tenantApiKeyAuth are declared as
  // preHandlerHookHandler (the 3-arg form with a done callback)
  // but their bodies are async, so calling them with 2 args and
  // awaiting the returned Promise is the correct composition.
  await (tenantApiKeyAuth as unknown as preHandlerAsyncHookHandler).call(this, request, reply);
};

export const cookiePreHandler: preHandlerAsyncHookHandler = async function (this: FastifyInstance, request, reply) {
  if (!request.tenant) {
    return reply.code(401).send({ error: 'no_tenant' });
  }
  if (request.visitorSession) return;
  await (sessionAuth as unknown as preHandlerAsyncHookHandler).call(this, request, reply);
  if (reply.sent) return;
  if (!request.sessionUser) {
    return reply
      .code(401)
      .send({ error: 'no_session', message: 'cookie or visitor_id required' });
  }
  request.visitorSession = {
    tenantId: request.tenant.tenantId,
    visitorId: deriveVisitorId(request.sessionUser.uid, request.tenant.tenantId),
    mode: 'cookie',
  };
};

export const visitorIdPreHandler: preHandlerAsyncHookHandler = async function (this: FastifyInstance, request, reply) {
  if (!request.tenant) {
    return reply.code(401).send({ error: 'no_tenant' });
  }
  if (request.visitorSession) return;
  const visitorId = (request.query as { visitor_id?: string }).visitor_id;
  if (!visitorId) {
    return reply.code(400).send({ error: 'missing_visitor_id' });
  }
  if (!VISITOR_ID_RE.test(visitorId)) {
    return reply.code(400).send({ error: 'invalid_visitor_id' });
  }
  request.visitorSession = {
    tenantId: request.tenant.tenantId,
    visitorId,
    mode: 'visitor_id',
  };
};
