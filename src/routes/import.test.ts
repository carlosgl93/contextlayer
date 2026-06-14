import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import importRoute from './import';

// Build a minimal Fastify app wired with multipart, the import route, and
// a mocked firebase admin that always accepts (the route relies on the
// preHandler, not the firebase plugin directly, for the verification step).
async function buildTestApp(): Promise<FastifyInstance> {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  const fakeAdmin = {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'x' }) }),
  };
  app.decorate('firebaseAdmin', fakeAdmin as unknown as never);
  await app.register(importRoute);
  return app;
}

// Build a ZIP at <path> containing conversations.json with the given body.
function makeZip(path: string, body: object | unknown[]): void {
  const dir = join(tmpdir(), `cgl-zip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const convPath = join(dir, 'conversations.json');
  writeFileSync(convPath, JSON.stringify(body));
  const result = spawnSync('zip', ['-q', path, 'conversations.json'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

const buildMultipart = (filePath: string, fields: Record<string, string> = {}) => {
  const boundary = '----test-boundary-' + Date.now();
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  const filename = filePath.split('/').pop()!;
  // We can't use the file path in raw multipart easily; for these tests we
  // inline a small file content instead of reading from disk.
  const fs = require('node:fs') as typeof import('node:fs');
  const fileContent = fs.readFileSync(filePath);
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
  );
  parts.push(fileContent);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat(parts),
  };
};

test('POST /api/v1/import/upload returns 202 + provider=claude for Claude ZIP', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-claude-${Date.now()}.zip`);
  makeZip(zipPath, [
    { uuid: 'a', chat_messages: [{ sender: 'human', text: 'hi' }] },
    { uuid: 'b', chat_messages: [] },
  ]);
  const mp = buildMultipart(zipPath);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: {
      ...mp.headers,
      authorization: 'Bearer dev:tester:tester@x.com',
    },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.confirmed, false);
  assert.equal(body.providers.length, 1);
  assert.equal(body.providers[0].provider, 'claude');
  assert.equal(body.providers[0].conversationCount, 2);
  assert.equal(body.total.conversationCount, 2);
  assert.equal(body.total.providers, 1);
  rmSync(zipPath, { force: true });
  await app.close();
});

test('POST /api/v1/import/upload returns 202 + provider=chatgpt for ChatGPT ZIP', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-gpt-${Date.now()}.zip`);
  makeZip(zipPath, [
    { id: 'a', title: 'Cooking', mapping: { 'n-1': { id: 'n-1' } } },
  ]);
  const mp = buildMultipart(zipPath);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: {
      ...mp.headers,
      authorization: 'Bearer dev:tester:tester@x.com',
    },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.confirmed, false);
  assert.equal(body.providers.length, 1);
  assert.equal(body.providers[0].provider, 'chatgpt');
  assert.equal(body.providers[0].conversationCount, 1);
  rmSync(zipPath, { force: true });
  await app.close();
});

test('POST /api/v1/import/upload returns 400 + unknown_provider for unrecognized shape', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-unk-${Date.now()}.zip`);
  makeZip(zipPath, [{ id: 'x', title: 'mystery' }]);
  const mp = buildMultipart(zipPath);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: {
      ...mp.headers,
      authorization: 'Bearer dev:tester:tester@x.com',
    },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'unknown_provider');
  rmSync(zipPath, { force: true });
  await app.close();
});

test('POST /api/v1/import/upload returns 401 without auth', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-noauth-${Date.now()}.zip`);
  makeZip(zipPath, [{ uuid: 'a', chat_messages: [] }]);
  const mp = buildMultipart(zipPath);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: mp.headers,
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 401);
  rmSync(zipPath, { force: true });
  await app.close();
});

test('POST /api/v1/import/upload with confirmed=true returns per-provider importId', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-confirmed-${Date.now()}.zip`);
  makeZip(zipPath, [
    { uuid: 'a', chat_messages: [{ sender: 'human', text: 'hi' }] },
  ]);
  const mp = buildMultipart(zipPath, { confirmed: 'true' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: {
      ...mp.headers,
      authorization: 'Bearer dev:tester:tester@x.com',
    },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.confirmed, true);
  assert.equal(body.providers.length, 1);
  assert.equal(body.providers[0].provider, 'claude');
  assert.match(body.providers[0].importId, /^imp_/);
  rmSync(zipPath, { force: true });
  await app.close();
});
