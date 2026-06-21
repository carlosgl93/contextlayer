import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Session-cookie authentication middleware.
 *
 * Verifies the `__Host-context-layer-session` cookie set by
 * `app.contextlayer.io` when a B2C user signs in. The cookie is
 * a Firebase session cookie (long-lived, ~14 days) created via
 * `admin.auth().createSessionCookie(idToken, { expiresIn })`.
 *
 * On success, attaches `{ uid }` to `request.sessionUser`. On
 * failure, returns 401 with `no_session`. Routes that need the
 * uid should check `request.sessionUser?.uid`.
 *
 * Dev bypass: when `CGL_DEV_AUTH_BYPASS=1`, a query param
 * `?dev_uid=xxx` is accepted in place of a real cookie. This
 * mirrors the existing `CGL_DEV_AUTH_BYPASS` pattern used by
 * the B2C auth middleware. NEVER enabled in production.
 *
 * The cookie name is `__Host-context-layer-session` per the
 * Firebase Hosting + cross-site pattern. Browser-set only (the
 * `__Host-` prefix requires `Secure`, `Path=/`, no `Domain`).
 */

declare module 'fastify' {
  interface FastifyRequest {
    sessionUser?: {
      uid: string;
      email?: string;
    };
  }
}

export const SESSION_COOKIE_NAME = '__Host-context-layer-session';

export const sessionAuth: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  // Dev bypass for local testing.
  if (process.env.CGL_DEV_AUTH_BYPASS === '1') {
    const devUid =
      typeof (request.query as Record<string, unknown>).dev_uid === 'string'
        ? ((request.query as Record<string, unknown>).dev_uid as string)
        : null;
    if (devUid) {
      request.log.warn({ devUid }, 'CGL_DEV_AUTH_BYPASS active — accepting dev_uid query param');
      request.sessionUser = { uid: devUid };
      return;
    }
  }

  // Extract the session cookie from the raw Cookie header.
  // (We could register @fastify/cookie for richer parsing, but a
  // single named cookie doesn't justify the dep for now.)
  let cookie: string | undefined;
  const raw = request.headers.cookie;
  if (raw) {
    for (const part of raw.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === SESSION_COOKIE_NAME) {
        cookie = rest.join('=');
        break;
      }
    }
  }
  if (!cookie) {
    return reply.code(401).send({ error: 'no_session', message: 'session cookie missing' });
  }

  try {
    const decoded = await request.server.firebaseAdmin.auth().verifySessionCookie(cookie, true);
    request.sessionUser = { uid: decoded.uid, email: decoded.email };
  } catch (err) {
    request.log.warn({ err }, 'session cookie verification failed');
    return reply.code(401).send({ error: 'no_session', message: 'session cookie invalid or expired' });
  }
};