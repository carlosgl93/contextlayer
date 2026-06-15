import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractContextSignals,
  parseExtractionResponse,
  type DedupProvider,
  type OpenAIClient,
} from './minimax';
import { setCostSink, type CostSink } from './cost-telemetry';
import type { ConversationRecord, ExtractionResult, Provider } from '../types';

// --- Test helpers ----------------------------------------------------------

function makeConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    provider: 'claude',
    providerId: overrides.providerId ?? 'p-1',
    title: overrides.title ?? 'A title',
    date: overrides.date ?? new Date('2026-01-01T00:00:00Z'),
    messageCount: overrides.messageCount ?? 2,
    rawText: overrides.rawText ?? 'user: hi\nassistant: hello',
    truncated: overrides.truncated ?? false,
    ...overrides,
  };
}

interface FakeOpenAIOptions {
  /** If set, return this string as the assistant content. */
  content?: string;
  /** If set, throw this error on create(). */
  throwOn?: Error;
  /** Records every call's params for assertion. */
  calls?: Array<{ model: string; messages: Array<{ role: string; content: string }> }>;
}

function makeFakeOpenAI(
  opts: FakeOpenAIOptions = {},
): OpenAIClient & { calls: NonNullable<FakeOpenAIOptions['calls']> } {
  const calls = opts.calls ?? [];
  const client: OpenAIClient & { calls: typeof calls } = {
    calls,
    chat: {
      completions: {
        // Cast the return value to ChatCompletion shape — production code
        // only reads `choices[0].message.content` and `usage.prompt_tokens`
        // / `usage.completion_tokens`, all of which we provide here.
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
                      preferences: [{ value: 'likes X', source: 'A title' }],
                      personalFacts: [],
                      activeIntentions: [],
                      domainsOfInterest: [],
                    }),
                },
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 200,
            },
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

function makeCaptureSink(): {
  sink: CostSink;
  events: Array<{ timestamp: string; [k: string]: unknown }>;
} {
  const events: Array<{ timestamp: string; [k: string]: unknown }> = [];
  return {
    events,
    sink: { write: (e) => events.push({ ...e }) },
  };
}

// --- Tests -----------------------------------------------------------------

test('extract: empty conversations returns empty result with zero LLM calls', async () => {
  const client = makeFakeOpenAI();
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [],
    openaiClient: client,
    dedup: makeDedup(),
  });
  assert.deepEqual(r, emptyResult());
  assert.equal(client.calls.length, 0);
});

test('extract: 2 conversations → 1 LLM call with both titles + rawText in prompt', async () => {
  const { sink, events } = makeCaptureSink();
  setCostSink(sink);
  const client = makeFakeOpenAI();
  const convos = [
    makeConversation({ providerId: 'p-1', title: 'Trip to Japan', rawText: 'user: I want to visit Tokyo' }),
    makeConversation({ providerId: 'p-2', title: 'Cooking ramen', rawText: 'user: how to make shoyu ramen' }),
  ];
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: convos,
    openaiClient: client,
    dedup: makeDedup(),
  });
  assert.equal(client.calls.length, 1);
  const userMsg = client.calls[0].messages.find((m) => m.role === 'user');
  assert.ok(userMsg, 'user message present');
  assert.match(userMsg.content, /Trip to Japan/);
  assert.match(userMsg.content, /I want to visit Tokyo/);
  assert.match(userMsg.content, /Cooking ramen/);
  assert.match(userMsg.content, /how to make shoyu ramen/);
  // Result carries the signal from the mock.
  assert.equal(r.preferences.length, 1);
  assert.equal(r.preferences[0].value, 'likes X');
  assert.equal(r.preferences[0].source, 'A title');
  // Provider override — every signal carries the actual provider.
  assert.equal(r.preferences[0].provider, 'claude');
  // Telemetry emitted.
  assert.equal(events.length, 1);
  assert.equal(events[0].provider, 'claude');
  assert.equal(events[0].batchSize, 2);
  assert.equal(events[0].inputTokens, 1000);
  assert.equal(events[0].outputTokens, 200);
  assert.equal(typeof events[0].latencyMs, 'number');
});

test('extract: dedup — all conversations already imported → 0 LLM calls', async () => {
  const client = makeFakeOpenAI();
  const dedup = makeDedup({ claude: ['p-1', 'p-2'] });
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [
      makeConversation({ providerId: 'p-1' }),
      makeConversation({ providerId: 'p-2' }),
    ],
    openaiClient: client,
    dedup,
  });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(r, emptyResult());
});

test('extract: dedup — 1 of 2 already imported → 1 LLM call with only the new one', async () => {
  const client = makeFakeOpenAI();
  const dedup = makeDedup({ claude: ['p-1'] });
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [
      makeConversation({ providerId: 'p-1', title: 'Old one' }),
      makeConversation({ providerId: 'p-2', title: 'New one', rawText: 'fresh content' }),
    ],
    openaiClient: client,
    dedup,
  });
  assert.equal(client.calls.length, 1);
  const userMsg = client.calls[0].messages[1];
  assert.match(userMsg.content, /New one/);
  assert.match(userMsg.content, /fresh content/);
  assert.doesNotMatch(userMsg.content, /Old one/);
  // The mock returns one preference; the result is non-empty.
  assert.equal(r.preferences.length, 1);
});

test('extract: bad JSON response from LLM → empty arrays for that batch, no throw', async () => {
  const client = makeFakeOpenAI({ content: 'this is not valid JSON { broken' });
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [makeConversation()],
    openaiClient: client,
    dedup: makeDedup(),
  });
  // The whole batch contributes nothing, so the result is empty.
  assert.equal(r.preferences.length, 0);
  assert.equal(r.personalFacts.length, 0);
  assert.equal(r.activeIntentions.length, 0);
  assert.equal(r.domainsOfInterest.length, 0);
});

test('extract: M3 response wrapped in a think block is parsed and signals returned', async () => {
  // M3 emits a think block before the JSON payload. The 11-batch live
  // calibration returned this wrapper on every batch and silently parse-failed.
  const OPEN = '<' + 'think' + '>';
  const CLOSE = '<' + '/' + 'think' + '>';
  const inner = JSON.stringify({
    preferences: [{ value: 'likes X', source: 'A title' }],
    personalFacts: [],
    activeIntentions: [],
    domainsOfInterest: [],
  });
  const content = `\n\n${OPEN}\n\n  Thought for 1s\n\n${CLOSE}\n${inner}`;
  const client = makeFakeOpenAI({ content });
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [makeConversation()],
    openaiClient: client,
    dedup: makeDedup(),
  });
  assert.equal(r.preferences.length, 1);
  assert.equal(r.preferences[0].value, 'likes X');
  assert.equal(r.preferences[0].source, 'A title');
  assert.equal(r.preferences[0].provider, 'claude');
});

test('extract: batch of 25 with MINIMAX_BATCH_SIZE_CHATGPT=10 → 3 calls (10+10+5)', async () => {
  const prevBatch = process.env.MINIMAX_BATCH_SIZE_CHATGPT;
  process.env.MINIMAX_BATCH_SIZE_CHATGPT = '10';
  try {
    const client = makeFakeOpenAI();
    const convos = Array.from({ length: 25 }, (_, i) =>
      makeConversation({ providerId: `p-${i}`, title: `Conv ${i}` }),
    );
    await extractContextSignals({
      uid: 'u1',
      provider: 'chatgpt',
      conversations: convos,
      openaiClient: client,
      dedup: makeDedup(),
    });
    assert.equal(client.calls.length, 3);
    assert.match(client.calls[0].messages[1].content, /Conv 0[\s\S]*Conv 9/);
    assert.match(client.calls[1].messages[1].content, /Conv 10[\s\S]*Conv 19/);
    assert.match(client.calls[2].messages[1].content, /Conv 20[\s\S]*Conv 24/);
  } finally {
    if (prevBatch === undefined) delete process.env.MINIMAX_BATCH_SIZE_CHATGPT;
    else process.env.MINIMAX_BATCH_SIZE_CHATGPT = prevBatch;
  }
});

test('extract: provider on every signal is the input provider, not the LLM-returned one', async () => {
  const client = makeFakeOpenAI({
    content: JSON.stringify({
      preferences: [
        { value: 'p1', source: 's1', provider: 'chatgpt' },  // LLM echoes wrong provider
      ],
      personalFacts: [],
      activeIntentions: [],
      domainsOfInterest: [],
    }),
  });
  const r = await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [makeConversation()],
    openaiClient: client,
    dedup: makeDedup(),
  });
  assert.equal(r.preferences[0].provider, 'claude');
});

test('extract: signals from multiple batches are merged into one ExtractionResult', async () => {
  // Force 2 batches by lowering the default.
  const prev = process.env.MINIMAX_BATCH_SIZE;
  process.env.MINIMAX_BATCH_SIZE = '1';
  try {
    const client = makeFakeOpenAI({
      content: JSON.stringify({
        preferences: [{ value: 'p', source: 's' }],
        personalFacts: [],
        activeIntentions: [],
        domainsOfInterest: [],
      }),
    });
    const r = await extractContextSignals({
      uid: 'u1',
      provider: 'claude',
      conversations: [makeConversation(), makeConversation({ providerId: 'p-2' })],
      openaiClient: client,
      dedup: makeDedup(),
    });
    assert.equal(client.calls.length, 2);
    // 2 batches × 1 signal each = 2 preferences merged.
    assert.equal(r.preferences.length, 2);
  } finally {
    if (prev === undefined) delete process.env.MINIMAX_BATCH_SIZE;
    else process.env.MINIMAX_BATCH_SIZE = prev;
  }
});

test('extract: multi-provider run emits a separate telemetry event per provider', async () => {
  const { sink, events } = makeCaptureSink();
  setCostSink(sink);
  const client = makeFakeOpenAI();
  await extractContextSignals({
    uid: 'u1',
    provider: 'claude',
    conversations: [makeConversation()],
    openaiClient: client,
    dedup: makeDedup(),
  });
  await extractContextSignals({
    uid: 'u1',
    provider: 'chatgpt',
    conversations: [makeConversation({ provider: 'chatgpt', providerId: 'g-1' })],
    openaiClient: client,
    dedup: makeDedup(),
  });
  assert.equal(events.length, 2);
  assert.equal(events[0].provider, 'claude');
  assert.equal(events[1].provider, 'chatgpt');
  // Signals from the two providers are not mixed.
  // (Each call returns a signal; they have the right provider attribution.)
  // (Direct assertion: events[0] provider !== events[1] provider.)
  assert.notEqual(events[0].provider, events[1].provider);
});

test('extract: LLM network failure propagates as an error', async () => {
  const client = makeFakeOpenAI({ throwOn: new Error('network down') });
  await assert.rejects(
    () =>
      extractContextSignals({
        uid: 'u1',
        provider: 'claude',
        conversations: [makeConversation()],
        openaiClient: client,
        dedup: makeDedup(),
      }),
    /network down/,
  );
});

function emptyResult(): ExtractionResult {
  return { preferences: [], personalFacts: [], activeIntentions: [], domainsOfInterest: [] };
}

// --- parseExtractionResponse unit tests ------------------------------------
//
// The M3 API returns its JSON payload wrapped in one or more <think>…</think>
// blocks. parseExtractionResponse strips those blocks and parses the rest as
// JSON. These tests pin the contract at the helper level so a future regression
// fails here, not deep inside the per-batch loop.

function thinkOpen(): string {
  return '<' + 'think' + '>';
}
function thinkClose(): string {
  return '<' + '/' + 'think' + '>';
}

test('parseExtractionResponse: strips a single think block before the JSON', () => {
  const inner = JSON.stringify({ preferences: [{ value: 'v', source: 's' }] });
  const content = `\n\n${thinkOpen()}\n\n  Thought for 1s\n\n${thinkClose()}\n${inner}`;
  const parsed = parseExtractionResponse(content) as Record<string, unknown>;
  assert.ok(parsed);
  assert.deepEqual(parsed.preferences, [{ value: 'v', source: 's' }]);
});

test('parseExtractionResponse: strips multiple think blocks', () => {
  const inner = JSON.stringify({ preferences: [], personalFacts: [], activeIntentions: [], domainsOfInterest: [] });
  const content =
    `${thinkOpen()}first reasoning${thinkClose()}\n` +
    `${thinkOpen()}second reasoning${thinkClose()}\n` +
    inner;
  const parsed = parseExtractionResponse(content) as Record<string, unknown>;
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed).sort(), ['activeIntentions', 'domainsOfInterest', 'personalFacts', 'preferences']);
});

test('parseExtractionResponse: raw JSON without a think block still parses', () => {
  const inner = JSON.stringify({ preferences: [{ value: 'v', source: 's' }] });
  const parsed = parseExtractionResponse(inner) as Record<string, unknown>;
  assert.ok(parsed);
  assert.deepEqual(parsed.preferences, [{ value: 'v', source: 's' }]);
});

test('parseExtractionResponse: trims surrounding whitespace', () => {
  const inner = JSON.stringify({ preferences: [] });
  const content = `   \n\n  ${inner}  \n\n  `;
  const parsed = parseExtractionResponse(content) as Record<string, unknown>;
  assert.ok(parsed);
  assert.deepEqual(parsed.preferences, []);
});

test('parseExtractionResponse: throws on malformed JSON after stripping', () => {
  const content = `${thinkOpen()}\nrandom thought\n${thinkClose()}\nthis is not json`;
  assert.throws(() => parseExtractionResponse(content), /JSON/);
});

test('parseExtractionResponse: throws on malformed JSON with no think block', () => {
  assert.throws(() => parseExtractionResponse('not json at all'), /JSON/);
});
