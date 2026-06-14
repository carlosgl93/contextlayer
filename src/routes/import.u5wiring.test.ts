import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import importRoute from './import';
import type { OpenAIClient, DedupProvider } from '../extraction/minimax';
import type { Provider } from '../types';

// --- helpers (re-declared locally so the test file is self-contained) -----

interface FakeOpenAIOptions {
  content?: string;
  throwOn?: Error;
  calls?: Array<{ model: string; messages: Array<{ role: string; content: string }> }>;
}

function makeFakeOpenAI(opts: FakeOpenAIOptions = {}): OpenAIClient & {
  calls: NonNullable<FakeOpenAIOptions['calls']>;
} {
  const calls = opts.calls ?? [];
  const client: OpenAIClient & { calls: typeof calls } = {
    calls,
    chat: {
      completions: {
        create: (async (params: unknown) => {
          calls.push(params as { model: string; messages: Array<{ role: string; content: string }> });
          if (opts.throwOn) throw opts.throwOn;
          return {
            choices: [
              {
                message: {
                  content:
                    opts.content ??
                    JSON.stringify({
                      preferences: [{ value: 'prefers concise replies', source: 'dummy' }],
                      personalFacts: [],
                      activeIntentions: [],
                      domainsOfInterest: [{ value: 'cooking', source: 'dummy' }],
                    }),
                },
              },
            ],
            usage: { prompt_tokens: 800, completion_tokens: 150 },
          };
        }) as unknown as OpenAIClient['chat']['completions']['create'],
      },
    },
  };
  return client;
}

function makeDedup(existing: Partial<Record<Provider, string[]>> = {}): DedupProvider {
  return {
    async getExistingProviderIds(provider) {
      return new Set(existing[provider] ?? []);
    },
  };
}

async function buildTestAppWithDeps(deps: {
  client?: OpenAIClient;
  dedup?: DedupProvider;
} = {}): Promise<FastifyInstance> {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  const fakeAdmin = {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'test-uid' }) }),
  };
  app.decorate('firebaseAdmin', fakeAdmin as unknown as never);
  if (deps.client) app.decorate('minimaxClient', deps.client);
  if (deps.dedup) app.decorate('minimaxDedupProvider', deps.dedup);
  await app.register(importRoute);
  return app;
}

function makeZip(path: string, body: object | unknown[]): void {
  const dir = join(tmpdir(), `cgl-w-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  const convPath = join(dir, 'conversations.json');
  writeFileSync(convPath, JSON.stringify(body));
  const result = spawnSync('zip', ['-q', path, 'conversations.json'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(`zip failed: ${result.stderr}`);
  rmSync(dir, { recursive: true, force: true });
}

const buildMultiFileMultipart = (
  filePaths: string[],
  fields: Record<string, string> = {},
) => {
  const boundary = '----test-boundary-' + Date.now();
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  const fs = require('node:fs') as typeof import('node:fs');
  for (const filePath of filePaths) {
    const filename = filePath.split('/').pop()!;
    const fileContent = fs.readFileSync(filePath);
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
    );
    parts.push(fileContent);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
};

// --- tests -----------------------------------------------------------------

test('U5 wiring: phase 2 with 2 files invokes extractor once per provider', async () => {
  const client = makeFakeOpenAI();
  const app = await buildTestAppWithDeps({ client, dedup: makeDedup() });
  const claudePath = join(tmpdir(), `cgl-w-cl-${Date.now()}.zip`);
  const chatgptPath = join(tmpdir(), `cgl-w-cg-${Date.now()}.zip`);
  makeZip(claudePath, [
    { uuid: 'c1', chat_messages: [{ sender: 'human', text: 'I like pasta' }] },
    { uuid: 'c2', chat_messages: [{ sender: 'human', text: 'recipe ideas' }] },
  ]);
  makeZip(chatgptPath, [
    { id: 'g1', title: 'Travel plans', mapping: { 'n-1': { id: 'n-1', message: null } } },
  ]);
  const mp = buildMultiFileMultipart([claudePath, chatgptPath], { confirmed: 'true' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.confirmed, true);
  assert.equal(body.providers.length, 2);
  // Extractor fired once per provider.
  assert.equal(client.calls.length, 2);
  for (const row of body.providers) {
    assert.match(row.importId, /^imp_/);
    assert.ok(row.extraction);
    assert.ok(Array.isArray(row.extraction.preferences));
    assert.ok(Array.isArray(row.extraction.personalFacts));
    assert.ok(Array.isArray(row.extraction.activeIntentions));
    assert.ok(Array.isArray(row.extraction.domainsOfInterest));
  }
  rmSync(claudePath, { force: true });
  rmSync(chatgptPath, { force: true });
  await app.close();
});

test('U5 wiring: dedup hit → 0 LLM calls, importId still returned', async () => {
  const client = makeFakeOpenAI();
  // Both Claude providerIds already imported.
  const app = await buildTestAppWithDeps({
    client,
    dedup: makeDedup({ claude: ['c1', 'c2'] }),
  });
  const claudePath = join(tmpdir(), `cgl-w-dup-cl-${Date.now()}.zip`);
  const chatgptPath = join(tmpdir(), `cgl-w-dup-cg-${Date.now()}.zip`);
  makeZip(claudePath, [
    { uuid: 'c1', chat_messages: [{ sender: 'human', text: 'I like pasta' }] },
    { uuid: 'c2', chat_messages: [] },
  ]);
  makeZip(chatgptPath, [
    { id: 'g1', title: 'Travel plans', mapping: { 'n-1': { id: 'n-1', message: null } } },
  ]);
  const mp = buildMultiFileMultipart([claudePath, chatgptPath], { confirmed: 'true' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.confirmed, true);
  assert.equal(body.providers.length, 2);
  // Dedup should skip Claude entirely → 1 LLM call (chatgpt only).
  assert.equal(client.calls.length, 1);
  for (const row of body.providers) {
    assert.match(row.importId, /^imp_/);
  }
  rmSync(claudePath, { force: true });
  rmSync(chatgptPath, { force: true });
  await app.close();
});

test('U5 wiring: extractor network failure propagates as 500', async () => {
  const client = makeFakeOpenAI({ throwOn: new Error('upstream blew up') });
  const app = await buildTestAppWithDeps({ client, dedup: makeDedup() });
  const zipPath = join(tmpdir(), `cgl-w-fail-${Date.now()}.zip`);
  makeZip(zipPath, [
    { uuid: 'c1', chat_messages: [{ sender: 'human', text: 'hi' }] },
  ]);
  const mp = buildMultiFileMultipart([zipPath], { confirmed: 'true' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 500);
  rmSync(zipPath, { force: true });
  await app.close();
});

test('U5 wiring: phase 1 with no `confirmed` field never invokes the extractor', async () => {
  const client = makeFakeOpenAI();
  const app = await buildTestAppWithDeps({ client, dedup: makeDedup() });
  const zipPath = join(tmpdir(), `cgl-w-p1-${Date.now()}.zip`);
  makeZip(zipPath, [
    { uuid: 'c1', chat_messages: [{ sender: 'human', text: 'hi' }] },
  ]);
  const mp = buildMultiFileMultipart([zipPath]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().confirmed, false);
  assert.equal(client.calls.length, 0);
  rmSync(zipPath, { force: true });
  await app.close();
});
