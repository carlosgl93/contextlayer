import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import importRoute, { estimateCostFromCharCount } from './import';

// --- Pure cost-estimation unit tests ---------------------------------------

test('estimateCostFromCharCount: 1.9MB rawText → 475K tokens, $0.14-0.33', () => {
  // founder's Claude export: 1.9MB / 4 = 475,000 tokens
  const r = estimateCostFromCharCount(1_900_000);
  assert.equal(r.estimatedTokens, 475000);
  assert.equal(r.estimatedCostUsd, '0.14-0.33');
});

test('estimateCostFromCharCount: empty input → 0 tokens, $0.00-0.00', () => {
  const r = estimateCostFromCharCount(0);
  assert.equal(r.estimatedTokens, 0);
  assert.equal(r.estimatedCostUsd, '0.00-0.00');
});

test('estimateCostFromCharCount: 200 chars → 50 tokens, $0.00-0.00', () => {
  // tiny input rounds to <$0.005 on both ends
  const r = estimateCostFromCharCount(200);
  assert.equal(r.estimatedTokens, 50);
  assert.equal(r.estimatedCostUsd, '0.00-0.00');
});

// --- Multi-file integration test harness -----------------------------------

async function buildTestApp(): Promise<FastifyInstance> {
  process.env.CGL_DEV_AUTH_BYPASS = '1';
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  const fakeAdmin = {
    auth: () => ({ verifyIdToken: async () => ({ uid: 'x' }) }),
    // U6 stub: an in-memory firestore. These tests don't assert writes
    // directly, but the route's phase 2 now calls it.
    firestore: () => makeFakeFirestore(),
  };
  app.decorate('firebaseAdmin', fakeAdmin as unknown as never);
  // U5 phase-2 stub: a no-op LLM client that returns an empty result.
  // Tests that exercise the extractor further override this decorator.
  const emptyExtraction = JSON.stringify({
    preferences: [],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const stubClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: emptyExtraction } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        }),
      },
    },
  };
  app.decorate('minimaxClient', stubClient as unknown as never);
  // U5 dedup stub: no-op provider that reports zero already-imported
  // records. Tests that exercise dedup override this decoration.
  app.decorate('minimaxDedupProvider', {
    getExistingProviderIds: async () => new Set<string>(),
  } as unknown as never);
  await app.register(importRoute);
  return app;
}

function makeZip(path: string, body: object | unknown[]): void {
  const dir = join(tmpdir(), `cgl-mf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

function makeCorruptZip(path: string): void {
  // Not a valid zip — just write arbitrary bytes
  writeFileSync(path, Buffer.from('this is not a zip file', 'utf-8'));
}

// Build a valid zip whose only entry is NOT `conversations.json`. Used to
// exercise the `missing_conversations_file` 400 path (U2 test scenario).
function makeZipWithoutConversations(path: string): void {
  const dir = join(
    tmpdir(),
    `cgl-mf-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'not the conversations file');
  const result = spawnSync('zip', ['-q', path, 'README.md'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

// Build a multipart payload with the legacy single-file `file` field.
const buildSingleFileMultipart = (filePath: string, fields: Record<string, string> = {}) => {
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
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  };
};

// Build a multipart payload with the `files` array field (multi-file).
// Each entry is the path to a file on disk. The filename is derived from
// the path. Field name is always `files` so the server can group them.
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

// --- Multi-file integration tests ------------------------------------------

test('U2.1: single file via files:[file] returns aggregated shape (back-compat)', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-mf-single-${Date.now()}.zip`);
  makeZip(zipPath, [
    { uuid: 'a', chat_messages: [{ sender: 'human', text: 'hi' }] },
    { uuid: 'b', chat_messages: [] },
  ]);
  const mp = buildMultiFileMultipart([zipPath]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.confirmed, false);
  assert.equal(body.providers.length, 1);
  assert.equal(body.providers[0].provider, 'claude');
  assert.equal(body.providers[0].conversationCount, 2);
  assert.equal(typeof body.providers[0].estimatedTokens, 'number');
  assert.match(body.providers[0].estimatedCostUsd, /^\d+\.\d{2}-\d+\.\d{2}$/);
  assert.equal(body.total.providers, 1);
  assert.equal(body.total.conversationCount, 2);
  assert.equal(body.total.estimatedTokens, body.providers[0].estimatedTokens);
  assert.equal(body.total.estimatedCostUsd, body.providers[0].estimatedCostUsd);
  // Legacy `file` field must continue to work.
  const legacyMp = buildSingleFileMultipart(zipPath);
  const legacyRes = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...legacyMp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: legacyMp.payload,
  });
  assert.equal(legacyRes.statusCode, 202);
  const legacyBody = legacyRes.json();
  assert.equal(legacyBody.confirmed, false);
  assert.equal(legacyBody.providers.length, 1);
  assert.equal(legacyBody.providers[0].provider, 'claude');
  rmSync(zipPath, { force: true });
  await app.close();
});

test('U2.1: 2 files (claude + chatgpt) returns aggregated providers[] and total', async () => {
  const app = await buildTestApp();
  const claudePath = join(tmpdir(), `cgl-mf-cl-${Date.now()}.zip`);
  const chatgptPath = join(tmpdir(), `cgl-mf-cg-${Date.now()}.zip`);
  makeZip(claudePath, [
    { uuid: 'c1', chat_messages: [{ sender: 'human', text: 'hi' }] },
    { uuid: 'c2', chat_messages: [] },
    { uuid: 'c3', chat_messages: [] },
  ]);
  makeZip(chatgptPath, [
    { id: 'g1', title: 'Cooking', mapping: { 'n-1': { id: 'n-1' } } },
    { id: 'g2', title: 'Travel', mapping: { 'n-1': { id: 'n-1' } } },
  ]);
  const mp = buildMultiFileMultipart([claudePath, chatgptPath]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.providers.length, 2);
  assert.equal(body.total.providers, 2);
  assert.equal(body.total.conversationCount, 5);
  const claudeRow = body.providers.find((p: { provider: string }) => p.provider === 'claude');
  const chatgptRow = body.providers.find((p: { provider: string }) => p.provider === 'chatgpt');
  assert.equal(claudeRow.conversationCount, 3);
  assert.equal(chatgptRow.conversationCount, 2);
  // total.estimatedTokens == sum of providers.estimatedTokens
  assert.equal(
    body.total.estimatedTokens,
    claudeRow.estimatedTokens + chatgptRow.estimatedTokens,
  );
  rmSync(claudePath, { force: true });
  rmSync(chatgptPath, { force: true });
  await app.close();
});

test('U2.1: 3 files with 1 corrupt returns 400 + detail + partial providers', async () => {
  const app = await buildTestApp();
  const goodA = join(tmpdir(), `cgl-mf-good-a-${Date.now()}.zip`);
  const bad = join(tmpdir(), `cgl-mf-bad-${Date.now()}.zip`);
  const goodB = join(tmpdir(), `cgl-mf-good-b-${Date.now()}.zip`);
  makeZip(goodA, [{ uuid: 'a', chat_messages: [] }]);
  makeCorruptZip(bad);
  makeZip(goodB, [
    { id: 'g1', title: 'Cooking', mapping: { 'n-1': { id: 'n-1' } } },
  ]);
  const mp = buildMultiFileMultipart([goodA, bad, goodB]);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, 'partial_upload');
  assert.ok(Array.isArray(body.failedFiles));
  assert.equal(body.failedFiles.length, 1);
  assert.equal(body.failedFiles[0].name, bad.split('/').pop());
  assert.ok(['not_a_valid_zip', 'invalid_conversations_json', 'missing_conversations_file'].includes(body.failedFiles[0].code));
  // Valid files should still be reported.
  assert.ok(Array.isArray(body.providers));
  assert.equal(body.providers.length, 2);
  const claudeRow = body.providers.find((p: { provider: string }) => p.provider === 'claude');
  const chatgptRow = body.providers.find((p: { provider: string }) => p.provider === 'chatgpt');
  assert.ok(claudeRow);
  assert.ok(chatgptRow);
  rmSync(goodA, { force: true });
  rmSync(bad, { force: true });
  rmSync(goodB, { force: true });
  await app.close();
});

test('U2.1: aggregated size cap rejects oversize total with 413', async () => {
  // We lower the cap to 1KB for this test via env override.
  const prev = process.env.CGL_MAX_AGGREGATE_UPLOAD_BYTES;
  process.env.CGL_MAX_AGGREGATE_UPLOAD_BYTES = '1024';
  try {
    const app = await buildTestApp();
    // Build synthetic conversation lists that produce zips comfortably
    // larger than 1KB so two of them definitely exceed the cap.
    const big = Array.from({ length: 1000 }, (_, i) => ({
      uuid: `c-${i}`,
      chat_messages: [{ sender: 'human', text: 'a'.repeat(500) }],
    }));
    const zipA = join(tmpdir(), `cgl-mf-big-a-${Date.now()}.zip`);
    const zipB = join(tmpdir(), `cgl-mf-big-b-${Date.now()}.zip`);
    makeZip(zipA, big);
    makeZip(zipB, big);
    // Sanity: each zip should be well over the cap on its own.
    const sizeA = require('node:fs').statSync(zipA).size;
    assert.ok(sizeA > 1024, `zipA should exceed 1KB cap (got ${sizeA})`);
    const mp = buildMultiFileMultipart([zipA, zipB]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/import/upload',
      headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
      payload: mp.payload,
    });
    assert.equal(res.statusCode, 413);
    rmSync(zipA, { force: true });
    rmSync(zipB, { force: true });
    await app.close();
  } finally {
    if (prev === undefined) delete process.env.CGL_MAX_AGGREGATE_UPLOAD_BYTES;
    else process.env.CGL_MAX_AGGREGATE_UPLOAD_BYTES = prev;
  }
});

test('U2.1: phase 2 with 2 files dispatches parsers and reports per-provider importId', async () => {
  const app = await buildTestApp();
  const claudePath = join(tmpdir(), `cgl-mf-p2-cl-${Date.now()}.zip`);
  const chatgptPath = join(tmpdir(), `cgl-mf-p2-cg-${Date.now()}.zip`);
  makeZip(claudePath, [
    { uuid: 'c1', chat_messages: [{ sender: 'human', text: 'hi' }] },
  ]);
  makeZip(chatgptPath, [
    { id: 'g1', title: 'Cooking', mapping: { 'n-1': { id: 'n-1' } } },
  ]);
  const mp = buildMultiFileMultipart([claudePath, chatgptPath], { confirmed: 'true' });
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  const body = res.json();
  assert.equal(res.statusCode, 202, `expected 202 got ${res.statusCode}; body=${JSON.stringify(body)}`);
  assert.equal(body.confirmed, true);
  assert.ok(Array.isArray(body.providers));
  assert.equal(body.providers.length, 2);
  for (const row of body.providers) {
    assert.ok(['claude', 'chatgpt'].includes(row.provider));
    assert.match(row.importId, /^imp_/);
  }
  rmSync(claudePath, { force: true });
  rmSync(chatgptPath, { force: true });
  await app.close();
});

test('U2: valid zip without conversations.json returns 400 missing_conversations_file', async () => {
  const app = await buildTestApp();
  const zipPath = join(tmpdir(), `cgl-mf-noconv-${Date.now()}.zip`);
  makeZipWithoutConversations(zipPath);
  const mp = buildSingleFileMultipart(zipPath);
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/import/upload',
    headers: { ...mp.headers, authorization: 'Bearer dev:tester:tester@x.com' },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  // Single-file missing_conversations_file surfaces directly as body.error
  // for U2-era clients checking that exact string.
  assert.equal(body.error, 'missing_conversations_file');
  assert.equal(body.confirmed, false);
  rmSync(zipPath, { force: true });
  await app.close();
});

/**
 * Minimal in-memory Firestore fake. Mirrors only the surface the import
 * route touches: collection().doc(), doc.set(), and batch().set().commit().
 * Path-aware chaining so users/{uid}/conversations/{id} resolves to a
 * single key.
 */
function makeFakeFirestore() {
  const docs = new Map<string, Record<string, unknown>>();
  const makeDoc = (path: string) => ({
    path,
    collection: (colPath: string) => ({
      doc: (id: string) => makeDoc(`${path}/${colPath}/${id}`),
    }),
    async get() {
      const data = docs.get(path);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      docs.set(path, { ...(docs.get(path) ?? {}), ...data });
    },
  });
  return {
    docs,
    collection: (p: string) => ({ doc: (id: string) => makeDoc(`${p}/${id}`) }),
    doc: (p: string) => makeDoc(p),
    batch: () => {
      const sets: Array<{ ref: ReturnType<typeof makeDoc>; data: Record<string, unknown> }> = [];
      const b = {
        set(ref: ReturnType<typeof makeDoc>, data: Record<string, unknown>) {
          sets.push({ ref, data });
          return b;
        },
        async commit() {
          for (const { ref, data } of sets) {
            docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data });
          }
        },
      };
      return b;
    },
  };
}
