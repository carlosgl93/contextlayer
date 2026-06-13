import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import admin from 'firebase-admin';

/**
 * Firebase Admin SDK initialization.
 *
 * The Firebase project `sg-cloud-cefee` is shared with other apps. This
 * plugin only initializes Admin credentials so we can verify ID tokens and
 * write under `users/{uid}/` — it does not touch existing Cloud Functions
 * or shared collections.
 *
 * Credentials come from `FIREBASE_SERVICE_ACCOUNT`, a single-line base64
 * encoding of the service account JSON file. Generate via Firebase Console
 * > Project Settings > Service Accounts > Generate new private key, then:
 *   cat serviceAccount.json | base64 | tr -d '\n'
 */
const firebasePlugin: FastifyPluginAsync = fp(async (app: FastifyInstance) => {
  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!encoded) {
    app.log.error(
      'FIREBASE_SERVICE_ACCOUNT env var is missing. ' +
        'See .env.example for the expected base64 service account format.',
    );
    process.exit(1);
  }

  let serviceAccount: admin.ServiceAccount;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    serviceAccount = JSON.parse(decoded) as admin.ServiceAccount;
  } catch (err) {
    app.log.error(
      { err },
      'FIREBASE_SERVICE_ACCOUNT is not valid base64-encoded JSON.',
    );
    process.exit(1);
  }

  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  app.decorate('firebaseAdmin', admin);
});

declare module 'fastify' {
  interface FastifyInstance {
    firebaseAdmin: typeof admin;
  }
}

export default firebasePlugin;
