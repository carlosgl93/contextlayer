import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { authenticate } from './auth';

// Minimal stand-in for firebase-admin.auth().verifyIdToken. The bypass
// branch in the middleware is what we exercise in U1/U2, so the real
// Firebase path is covered by the "garbage token" case below.
const fakeAdmin = {
  auth: () => ({
    verifyIdToken: async (_token: string) => {
      throw new Error('verification should not run for dev tokens');
    },
  }),
};

const fakeAdminReal = {
  auth: () => ({
    verifyIdToken: async (token: string) => {
      if (token === 'good') return { uid: 'real-uid', email: 'real@x.com' };
      throw new Error('invalid');
    },
  }),
};

const appWithBypass = async (): Promise<FastifyInstance> => {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  app.decorate('firebaseAdmin', fakeAdmin as unknown as never);
  app.get('/protected', { preHandler: authenticate }, async (req) => ({
    uid: req.user?.uid,
    email: req.user?.email,
  }));
  return app;
};

const appWithoutBypass = async (): Promise<FastifyInstance> => {
  delete process.env.CGL_DEV_AUTH_BYPASS;
  const app = Fastify();
  app.decorate('firebaseAdmin', fakeAdminReal as unknown as never);
  app.get('/protected', { preHandler: authenticate }, async (req) => ({
    uid: req.user?.uid,
    email: req.user?.email,
  }));
  return app;
};

test('401 when Authorization header is missing', async () => {
  const app = await appWithBypass();
  const res = await app.inject({ method: 'GET', url: '/protected' });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('401 when Authorization is not Bearer', async () => {
  const app = await appWithBypass();
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: 'Basic abc123' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('401 on empty Bearer token', async () => {
  const app = await appWithBypass();
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: 'Bearer ' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('dev bypass: Bearer dev:<uid>:<email> attaches user', async () => {
  const app = await appWithBypass();
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: 'Bearer dev:carlos:carlos@x.com' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.uid, 'carlos');
  assert.equal(body.email, 'carlos@x.com');
  await app.close();
});

test('dev bypass ignored when env flag is unset', async () => {
  const app = await appWithoutBypass();
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: 'Bearer dev:carlos:carlos@x.com' },
  });
  // Falls through to Firebase verification, which rejects the dev: token.
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('valid Firebase token attaches decoded uid/email', async () => {
  const app = await appWithoutBypass();
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: 'Bearer good' },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { uid: 'real-uid', email: 'real@x.com' });
  await app.close();
});

test('401 on Firebase verification failure', async () => {
  const app = await appWithoutBypass();
  const res = await app.inject({
    method: 'GET',
    url: '/protected',
    headers: { authorization: 'Bearer junk' },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});
