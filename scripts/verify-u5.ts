/**
 * U5 end-to-end verification with the founder's actual Claude export.
 *
 * Reads `data-1ce0e1e5-.../conversations.json`, parses with the Claude
 * parser, runs the real MiniMax M3 extraction pipeline, and reports the
 * real input/output token counts plus the per-batch cost telemetry.
 *
 * This is a one-off verification script, not a unit test — it requires
 * a real `MINIMAX_API_KEY` and a real founder export. Run with:
 *
 *   pnpm tsx scripts/verify-u5.ts
 *
 * Cost: ~$0.15-0.40 per run (208 conversations × ~9KB rawText = ~475K
 * input tokens at $0.30-0.70/M + output tokens).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseClaudeConversations } from '../src/parsers/claude';
import { extractContextSignals } from '../src/extraction/minimax';
import { setCostSink, type CostSink } from '../src/extraction/cost-telemetry';

interface CapturedEvent {
  provider: string;
  batchSize: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model?: string;
  timestamp: string;
}

const captureSink: CostSink = {
  write(event) {
    captured.push(event);
  },
};
const captured: CapturedEvent[] = [];

setCostSink(captureSink);

const convPath = join(
  process.cwd(),
  'data-1ce0e1e5-88a7-40f9-9c82-e36ebac60a13-1781361730-7eca1830-batch-0000',
  'conversations.json',
);

async function main() {
  console.log(`[verify-u5] reading founder data from ${convPath}`);

  const raw = JSON.parse(readFileSync(convPath, 'utf-8')) as unknown[];
  const records = parseClaudeConversations(raw);
  console.log(`[verify-u5] parsed ${records.length} Claude conversations`);
  const totalRawTextBytes = records.reduce(
    (acc, r) => acc + Buffer.byteLength(r.rawText, 'utf8'),
    0,
  );
  const estTokens = Math.round(totalRawTextBytes / 4);
  const estCostLow = (estTokens / 1_000_000) * 0.3;
  const estCostHigh = (estTokens / 1_000_000) * 0.7;
  console.log(
    `[verify-u5] rawText=${totalRawTextBytes} bytes; estimated tokens=${estTokens}; estimated cost=$${estCostLow.toFixed(2)}-$${estCostHigh.toFixed(2)}`,
  );

  const start = Date.now();
  const result = await extractContextSignals({
    uid: 'verify-founder',
    provider: 'claude',
    conversations: records,
  });
  const wallMs = Date.now() - start;

  const totalIn = captured.reduce((a, e) => a + e.inputTokens, 0);
  const totalOut = captured.reduce((a, e) => a + e.outputTokens, 0);
  const totalLatency = captured.reduce((a, e) => a + e.latencyMs, 0);
  const batchCount = captured.length;

  console.log('\n=== Cost telemetry ===');
  for (const e of captured) {
    console.log(
      `  batch: provider=${e.provider} size=${e.batchSize} in=${e.inputTokens} out=${e.outputTokens} latency=${e.latencyMs}ms model=${e.model}`,
    );
  }
  console.log(
    `\nTotals: ${batchCount} batches, ${totalIn} input + ${totalOut} output tokens, ${totalLatency}ms batch latency, ${wallMs}ms wall`,
  );

  const realCostLow = (totalIn / 1_000_000) * 0.3;
  const realCostHigh = (totalIn / 1_000_000) * 0.7;
  console.log(
    `Real input-token cost band: $${realCostLow.toFixed(2)}-$${realCostHigh.toFixed(2)} (plus output at ~3-5x input)`,
  );

  const deviation = Math.abs(totalIn - estTokens) / estTokens;
  console.log(
    `Calibration check: estimated=${estTokens} tokens, real=${totalIn} tokens, deviation=${(deviation * 100).toFixed(1)}%`,
  );
  if (deviation > 0.3) {
    console.warn(
      `⚠️  >30% deviation from 4 chars/token heuristic — recalibrate the U2.1 estimator.`,
    );
  }

  console.log('\n=== Extraction result ===');
  console.log(`preferences: ${result.preferences.length}`);
  console.log(`personalFacts: ${result.personalFacts.length}`);
  console.log(`activeIntentions: ${result.activeIntentions.length}`);
  console.log(`domainsOfInterest: ${result.domainsOfInterest.length}`);

  const totalSignals =
    result.preferences.length +
    result.personalFacts.length +
    result.activeIntentions.length +
    result.domainsOfInterest.length;
  if (totalSignals < 3) {
    console.warn(`⚠️  Less than 3 signals extracted — extraction may be under-extracting.`);
  }

  // Dedup verification: re-run with all providerIds already in the dedup
  // set. Should produce 0 batches and 0 tokens consumed.
  const noOpDedup = {
    getExistingProviderIds: async () => new Set(records.map((r) => r.providerId)),
  };
  const capturedBefore = captured.length;
  const dedupResult = await extractContextSignals({
    uid: 'verify-founder',
    provider: 'claude',
    conversations: records,
    dedup: noOpDedup,
  });
  const capturedAfter = captured.length;
  const dedupBatches = capturedAfter - capturedBefore;
  console.log(
    `\n=== Dedup re-import ===\n  batches fired on re-import: ${dedupBatches} (expected 0)`,
  );
  console.log(
    `  result is empty: ${
      dedupResult.preferences.length === 0 &&
      dedupResult.personalFacts.length === 0 &&
      dedupResult.activeIntentions.length === 0 &&
      dedupResult.domainsOfInterest.length === 0
    }`,
  );
  if (dedupBatches !== 0) {
    console.error('❌ Dedup failed: re-import fired LLM calls when it should not have.');
    process.exit(1);
  }
  console.log('\n✅ Verification complete.');
}

main().catch((err) => {
  console.error('verify-u5 failed:', err);
  process.exit(1);
});

// Suppress unused-import warnings for tmpdir if any future refactor
// reintroduces it.
void tmpdir;
