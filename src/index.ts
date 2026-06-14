import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import firebasePlugin from './plugins/firebase';
import importRoute from './routes/import';
import conversationsRoute from './routes/conversations';
import privacyRoute from './routes/privacy';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

async function main() {
  // Validate required environment variables up front. Fail fast and loud
  // rather than discovering the missing key on the first import request.
  if (!process.env.MINIMAX_API_KEY) {
    console.error(
      '[startup] MINIMAX_API_KEY is required. Set it in .env before starting the server.',
    );
    process.exit(1);
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await app.register(cors, {
    origin: true, // dev-friendly; tighten for production
  });

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB hard cap on import uploads (U2)
    },
  });

  await app.register(firebasePlugin);

  // Liveness probe — no auth, no Firestore access. Used by deployment
  // platforms and for manual smoke testing.
  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(importRoute);
  await app.register(conversationsRoute);
  await app.register(privacyRoute);

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`ContextLayer API listening on http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
