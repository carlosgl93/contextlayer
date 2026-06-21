import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { findApiKey, type ApiKeyRecord } from '../b2b/tenants';

/**
 * Tenant API key authentication middleware.
 *
 * Extracts the Bearer token from the `Authorization` header,
 * looks up the matching API key in the tenant's apiKeys subcollection,
 * and verifies:
 *   1. The key is active: true
 *   2. The key has one of the required scopes for this endpoint
 *   3. The request origin is in the tenant's allowedOrigins
 *
 * On success, attaches { tenantId, keyId, record } to
 * request.tenant. On failure, returns 401 / 403 with structured
 * error codes (invalid_api_key, origin_not_allowed,
 * scope_insufficient).
 *
 * Scope check: the route declares the scope it needs via
 * request.routeOptions.config.requiredScope and the middleware
 * reads it. Default scope is 'widget:read'; chat endpoints should
 * set 'chat:write'.
 */

declare module 'fastify' {
  interface FastifyRequest {
    tenant?: {
      tenantId: string;
      keyId: string;
      record: ApiKeyRecord;
    };
  }
  interface FastifyContextConfig {
    requiredScope?: string;
  }
}

export const tenantApiKeyAuth: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const header = request.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return reply.code(401).send({ error: 'missing_api_key', message: 'Authorization header required' });
  }
  const presented = header.slice(7).trim();
  if (!presented) {
    return reply.code(401).send({ error: 'missing_api_key', message: 'empty Bearer token' });
  }

  const db = request.server.firebaseAdmin.firestore();
  const found = await findApiKey(db, presented);
  if (!found) {
    return reply.code(401).send({ error: 'invalid_api_key' });
  }
  if (!found.record.active) {
    return reply.code(401).send({ error: 'invalid_api_key', message: 'key is inactive' });
  }

  const requiredScope =
    (request.routeOptions.config?.requiredScope as string | undefined) ?? 'widget:read';
  if (!found.record.scopes.includes(requiredScope)) {
    return reply.code(403).send({ error: 'scope_insufficient', message: `requires ${requiredScope}` });
  }

  // Origin check: the browser sets Origin or Referer on CORS /
  // same-origin requests. Server-side fetches (from the B2B
  // customer's backend) won't set Origin, so we allow those too
  // — the API key itself proves the caller is trusted. The
  // widget bundle uses Origin in the browser context.
  const origin = request.headers.origin ?? request.headers.referer;
  if (origin) {
    const cfgSnap = await db.collection('b2bTenants').doc(found.tenantId).collection('config').doc('main').get();
    if (cfgSnap.exists) {
      const allowed = (cfgSnap.data() as { allowedOrigins?: string[] }).allowedOrigins ?? [];
      const matches = allowed.some((o) => origin === o || origin.startsWith(o + '/'));
      if (!matches) {
        return reply.code(403).send({ error: 'origin_not_allowed', origin });
      }
    }
  }

  request.tenant = { tenantId: found.tenantId, keyId: found.keyId, record: found.record };
};
