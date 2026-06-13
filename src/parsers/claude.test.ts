import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseClaudeConversations } from './claude';

const MAX_RAW_BYTES = 800 * 1024;

test('parseClaudeConversations: human/assistant turns produce ordered user/assistant lines', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'Trip',
      created_at: '2025-01-15T10:00:00.000Z',
      chat_messages: [
        { sender: 'human', text: 'Plan a trip to Tokyo' },
        { sender: 'assistant', text: 'Sure — when?' },
        { sender: 'human', text: 'In October' },
        { sender: 'assistant', text: 'Great choice.' },
      ],
    },
  ]);

  assert.equal(out.length, 1);
  const rec = out[0];
  assert.equal(rec.provider, 'claude');
  assert.equal(rec.providerId, 'c-1');
  assert.equal(rec.title, 'Trip');
  assert.equal(rec.messageCount, 4);
  assert.equal(rec.truncated, false);
  assert.equal(
    rec.rawText,
    'user: Plan a trip to Tokyo\nassistant: Sure — when?\nuser: In October\nassistant: Great choice.\n',
  );
});

test('parseClaudeConversations: sender "human" maps to role "user" in rawText', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'T',
      created_at: '2025-01-01T00:00:00.000Z',
      chat_messages: [
        { sender: 'human', text: 'hi' },
        { sender: 'assistant', text: 'hello' },
      ],
    },
  ]);
  assert.equal(out[0].rawText, 'user: hi\nassistant: hello\n');
});

test('parseClaudeConversations: empty top-level text falls back to first content[] type:text block', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'T',
      created_at: '2025-01-01T00:00:00.000Z',
      chat_messages: [
        {
          sender: 'human',
          text: '',
          content: [
            { type: 'tool_use', text: 'ignored' },
            { type: 'text', text: 'real content' },
          ],
        },
        {
          sender: 'assistant',
          text: undefined,
          content: [{ type: 'text', text: 'reply' }],
        },
      ],
    },
  ]);
  assert.equal(out[0].rawText, 'user: real content\nassistant: reply\n');
  assert.equal(out[0].messageCount, 2);
});

test('parseClaudeConversations: messages with only tool_use/tool_result/thinking are omitted', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'T',
      created_at: '2025-01-01T00:00:00.000Z',
      chat_messages: [
        { sender: 'human', text: 'real question' },
        { sender: 'assistant', content: [{ type: 'tool_use', text: 'noop' }] },
        { sender: 'assistant', content: [{ type: 'tool_result', text: 'result' }] },
        { sender: 'assistant', content: [{ type: 'thinking', text: 'thoughts' }] },
        { sender: 'assistant', text: 'real answer' },
      ],
    },
  ]);
  assert.equal(out[0].messageCount, 2);
  assert.equal(out[0].rawText, 'user: real question\nassistant: real answer\n');
});

test('parseClaudeConversations: created_at ISO-8601 with timezone parses to correct Date', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'T',
      created_at: '2025-03-21T14:01:39.875645Z',
      chat_messages: [],
    },
  ]);
  assert.equal(out[0].date.toISOString(), '2025-03-21T14:01:39.875Z');
});

test('parseClaudeConversations: created_at without timezone still parses', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'T',
      created_at: '2025-06-01T12:00:00',
      chat_messages: [],
    },
  ]);
  // JS parses space-less ISO without tz as local — we only check the
  // year/month/day to avoid TZ brittleness.
  const d = out[0].date;
  assert.equal(d.getFullYear(), 2025);
  assert.equal(d.getMonth(), 5);
  assert.equal(d.getDate(), 1);
});

test('parseClaudeConversations: empty chat_messages → messageCount 0, rawText ""', () => {
  const out = parseClaudeConversations([
    { uuid: 'c-1', name: 'Empty', created_at: '2025-01-01T00:00:00.000Z', chat_messages: [] },
  ]);
  assert.equal(out[0].messageCount, 0);
  assert.equal(out[0].rawText, '');
  assert.equal(out[0].truncated, false);
});

test('parseClaudeConversations: empty input array returns []', () => {
  assert.deepEqual(parseClaudeConversations([]), []);
});

test('parseClaudeConversations: 900KB input truncates to ≤800KB with truncated:true', () => {
  // 9 messages × ~100KB each → ~900KB total. The cap should kick in
  // around the 8th message and drop the 9th.
  const lineText = 'x'.repeat(100 * 1024);
  const messages = Array.from({ length: 9 }, (_, i) => ({
    sender: i % 2 === 0 ? 'human' : 'assistant',
    text: lineText,
  }));
  const out = parseClaudeConversations([
    {
      uuid: 'big',
      name: 'Big',
      created_at: '2025-01-01T00:00:00.000Z',
      chat_messages: messages,
    },
  ]);

  const rec = out[0];
  assert.equal(rec.truncated, true);
  assert.ok(
    Buffer.byteLength(rec.rawText, 'utf8') <= MAX_RAW_BYTES,
    `rawText byte length ${Buffer.byteLength(rec.rawText, 'utf8')} must be <= ${MAX_RAW_BYTES}`,
  );
  // We got some, but not all, messages in.
  assert.ok(rec.messageCount < 9, `expected messageCount < 9, got ${rec.messageCount}`);
  assert.ok(rec.messageCount > 0, 'expected at least one message stored');
});

test('parseClaudeConversations: skips non-object conversation entries', () => {
  const out = parseClaudeConversations([
    null,
    'not an object',
    { uuid: 'a', name: 'real', created_at: '2025-01-01T00:00:00.000Z', chat_messages: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].providerId, 'a');
});

test('parseClaudeConversations: missing uuid falls back to synthetic providerId', () => {
  const out = parseClaudeConversations([
    { name: 'no-uuid', created_at: '2025-01-01T00:00:00.000Z', chat_messages: [] },
  ]);
  assert.equal(out[0].providerId, 'unknown-0');
});

test('parseClaudeConversations: skips messages with unknown sender', () => {
  const out = parseClaudeConversations([
    {
      uuid: 'c-1',
      name: 'T',
      created_at: '2025-01-01T00:00:00.000Z',
      chat_messages: [
        { sender: 'system', text: 'sys prompt' },
        { sender: 'human', text: 'real' },
      ],
    },
  ]);
  assert.equal(out[0].messageCount, 1);
  assert.equal(out[0].rawText, 'user: real\n');
});

test('parseClaudeConversations: real Claude export (208 conversations) parses to 208 records', () => {
  const zipPath = findRealExport();
  if (!zipPath) {
    // No real export present — the unit test still passes by skipping
    // the assertion, but logs a hint. Most CI runs won't have the file.
    return;
  }
  const parsed = unzipConversations(zipPath);
  assert.ok(Array.isArray(parsed), 'conversations.json should be a top-level array');
  const records = parseClaudeConversations(parsed);
  assert.equal(records.length, 208);
  assert.ok(records.every((r) => r.provider === 'claude'));
  assert.ok(records.every((r) => typeof r.providerId === 'string' && r.providerId.length > 0));

  // Spot-check a known conversation.
  const tripFix = records.find((r) => r.title === 'Fixing DynamoDB Time Unmarshalling Errors');
  assert.ok(tripFix, 'expected known conversation to be present');
  assert.ok(tripFix!.messageCount > 0);
  assert.ok(tripFix!.rawText.includes('user:') || tripFix!.rawText.includes('assistant:'));
  assert.equal(tripFix!.truncated, false);
});

// --- helpers ---

function findRealExport(): string | null {
  const root = join(__dirname, '..', '..');
  const files = readdirSync(root).filter((f) => f.startsWith('data-') && f.endsWith('.zip'));
  return files.length > 0 ? join(root, files[0]) : null;
}

function unzipConversations(zipPath: string): unknown {
  const dir = join(tmpdir(), `cgl-peek-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', dir], { encoding: 'utf-8' });
  if (res.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`unzip failed: ${res.stderr}`);
  }
  const json = readFileSync(join(dir, 'conversations.json'), 'utf-8');
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(json);
}
