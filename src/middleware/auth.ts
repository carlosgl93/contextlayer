import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Firebase ID token authentication.
 *
 * Extracts the Bearer token from the `Authorization` header, verifies it
 * via `admin.auth().verifyIdToken`, and attaches `{ uid, email }` to
 * `request.user` on success. Returns 401 for any failure (missing header,
 * malformed token, expired/invalid token).
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
