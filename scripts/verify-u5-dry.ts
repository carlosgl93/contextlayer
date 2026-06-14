/**
 * U5 end-to-end verification — DRY RUN.
 *
 * Same flow as verify-u5.ts but uses a stub OpenAI client so no real
 * API call is made. Confirms:
 *   - founder data parses cleanly with U3
 *   - extraction pipeline processes the full set
 *   - dedup short-circuits the second invocation (0 LLM calls)
 *   - cost telemetry emits per batch with the right shape
 *   - calibration estimate (rawText / 4) lands in the same order of
 *     magnitude as the reported input token count
 *
 * Run with:
 *   pnpm tsx scripts/verify-u5-dry.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeConversations } from '../src/parsers/claude';
import { extractContextSignals, type OpenAIClient } from '../src/extraction/minimax';
import { setCostSink, type CostSink } from '../src/extraction/cost-telemetry';

const captured: Array<Record<string, unknown>> = [];
setCostSink({
  write(event) {
    captured.push({ ...event });
  },
} as CostSink);

const stubClient: OpenAIClient = {
  chat: {
    completions: {
      create: (async (params: unknown) => {
        const userMsg = (params as { messages: Array<{ role: string; content: string }> })
          .messages[1].content;
        // Fake input token count = 1 token per 4 chars of the user prompt.
        const inTok = Math.round(userMsg.length / 4);
        // Fake output tokens proportional to the batch size.
        const convCount = (userMsg.match(/===/g) ?? []).length;
        const outTok = 200 + convCount * 50;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  preferences: [
                    { value: 'prefers concise replies', source: 'first convo' },
                    { value: 'interested in cooking', source: 'second convo' },
                  ],
                  personalFacts: [{ value: 'lives in Santiago', source: 'third convo' }],
                  activeIntentions: [],
                  domainsOfInterest: [
                    { value: 'software engineering', source: 'first convo' },
                    { value: 'cooking', source: 'second convo' },
                  ],
                }),
              },
            },
          ],
          usage: { prompt_tokens: inTok, completion_tokens: outTok },
        };
      }) as unknown as OpenAIClient['chat']['completions']['create'],
    },
  },
};

const convPath = join(
  process.cwd(),
  'data-1ce0e1e5-88a7-40f9-9c82-e36ebac60a13-1781361730-7eca1830-batch-0000',
  'conversations.json',
);

async function main() {
  console.log(`[dry-run] reading founder data from ${convPath}`);
  const raw = JSON.parse(readFileSync(convPath, 'utf-8')) as unknown[];
  const records = parseClaudeConversations(raw);
  console.log(`[dry-run] parsed ${records.length} Claude conversations`);
  const totalRawBytes = records.reduce(
    (acc, r) => acc + Buffer.byteLength(r.rawText, 'utf8'),
    0,
  );
  const estTokens = Math.round(totalRawBytes / 4);
  console.log(
    `[dry-run] rawText=${totalRawBytes} bytes; estimated tokens=${estTokens}`,
  );

  // First pass — full extraction.
  const start1 = Date.now();
  const result1 = await extractContextSignals({
    uid: 'verify-founder',
    provider: 'claude',
    conversations: records,
    openaiClient: stubClient,
  });
  const wall1 = Date.now() - start1;
  const batches1 = captured.length;
  const in1 = captured.reduce((a, e) => a + (e.inputTokens as number), 0);
  const out1 = captured.reduce((a, e) => a + (e.outputTokens as number), 0);

  console.log(`\n=== Pass 1: full import ===`);
  console.log(`  batches: ${batches1}`);
  console.log(`  input tokens (stub): ${in1}`);
  console.log(`  output tokens (stub): ${out1}`);
  console.log(`  wall time: ${wall1}ms`);
  console.log(`  signals:`);
  console.log(`    preferences: ${result1.preferences.length}`);
  console.log(`    personalFacts: ${result1.personalFacts.length}`);
  console.log(`    activeIntentions: ${result1.activeIntentions.length}`);
  console.log(`    domainsOfInterest: ${result1.domainsOfInterest.length}`);

  const totalSignals =
    result1.preferences.length +
    result1.personalFacts.length +
    result1.activeIntentions.length +
    result1.domainsOfInterest.length;
  if (totalSignals < 3) {
    console.warn(`  ⚠️  Less than 3 signals — extraction may be under-extracting`);
  }

  // Second pass — dedup. All providerIds are already in the set, so
  // expect 0 LLM calls and an empty result.
  const noOpDedup = {
    getExistingProviderIds: async () => new Set(records.map((r) => r.providerId)),
  };
  const before = captured.length;
  const result2 = await extractContextSignals({
    uid: 'verify-founder',
    provider: 'claude',
    conversations: records,
    openaiClient: stubClient,
    dedup: noOpDedup,
  });
  const after = captured.length;
  const dedupBatches = after - before;

  console.log(`\n=== Pass 2: re-import (dedup) ===`);
  console.log(`  batches fired: ${dedupBatches} (expected 0)`);
  console.log(
    `  result is empty: ${
      result2.preferences.length === 0 &&
      result2.personalFacts.length === 0 &&
      result2.activeIntentions.length === 0 &&
      result2.domainsOfInterest.length === 0
    }`,
  );

  // Third pass — partial dedup. 50% of records already in the set;
  // expect only the new ones to fire.
  const partialExisting = new Set(
    records.slice(0, Math.floor(records.length / 2)).map((r) => r.providerId),
  );
  const partialDedup = {
    getExistingProviderIds: async () => partialExisting,
  };
  const beforePartial = captured.length;
  await extractContextSignals({
    uid: 'verify-founder',
    provider: 'claude',
    conversations: records,
    openaiClient: stubClient,
    dedup: partialDedup,
  });
  const afterPartial = captured.length;
  const partialBatches = afterPartial - beforePartial;
  console.log(`\n=== Pass 3: partial dedup (50% pre-imported) ===`);
  console.log(`  batches fired: ${partialBatches}`);
  console.log(`  expected: ~${Math.ceil((records.length - partialExisting.size) / 20)} (${records.length - partialExisting.size} new convos / batch size 20)`);

  // Calibration check on the stub. Compare rawText-bytes/4 against
  // the stub's reported input_tokens.
  const deviation = Math.abs(in1 - estTokens) / estTokens;
  console.log(`\n=== Calibration (stub) ===`);
  console.log(`  estimated tokens: ${estTokens}`);
  console.log(`  reported input tokens: ${in1}`);
  console.log(`  deviation: ${(deviation * 100).toFixed(1)}%`);
  if (deviation > 0.05) {
    console.warn(`  ⚠️  Stub deviates >5% from rawText/4 — stub realism may be off.`);
  }

  if (dedupBatches !== 0) {
    console.error(`\n❌ Dedup failed: re-import fired ${dedupBatches} LLM calls when it should not have.`);
    process.exit(1);
  }
  console.log(`\n✅ Dry-run complete.`);
}

main().catch((err) => {
  console.error('verify-u5-dry failed:', err);
  process.exit(1);
});
