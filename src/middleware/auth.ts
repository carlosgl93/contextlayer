import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Firebase ID token authentication.
 *
 * Extracts the Bearer token from the `Authorization` header, verifies it
 * via `admin.auth().verifyIdToken`, and attaches `{ uid, email }` to
 * `request.user` on success. Returns 401 for any failure (missing header,
 * malformed token, expired/invalid token).
 *
 * Dev-only bypass: when `CGL_DEV_AUTH_BYPASS=1` is set in the environment,
 * a token shaped like `dev:<uid>:<email>` is accepted and the parsed
 * uid/email are attached. This is for local end-to-end testing only and
 * must never be enabled in production.
 */
export const authenticate: preHandlerHookHandler = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const header = request.headers.authorization;

  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Missing Bearer token' });
  }

  const token = header.slice(7).trim();
  if (!token) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Empty Bearer token' });
  }

  if (process.env.CGL_DEV_AUTH_BYPASS === '1') {
    if (token.startsWith('dev:')) {
      const [, uid = 'dev-user', email = 'dev@local'] = token.split(':');
      request.log.warn(
        { uid },
        'CGL_DEV_AUTH_BYPASS active — accepting dev token. Disable in production.',
      );
      request.user = { uid, email };
      return;
    }
  }

  try {
    const decoded = await request.server.firebaseAdmin.auth().verifyIdToken(token);
    request.user = {
      uid: decoded.uid,
      email: decoded.email,
    };
  } catch (err) {
    request.log.warn({ err }, 'Firebase token verification failed');
    return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
};
