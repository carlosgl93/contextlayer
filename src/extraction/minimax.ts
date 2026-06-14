import OpenAI from 'openai';
import type { ConversationRecord, ExtractionResult, ExtractionSignal, Provider } from '../types';
import { logCostEvent } from './cost-telemetry';

/**
 * U5 — MiniMax M3 extraction pipeline.
 *
 * Given a batch of already-parsed `ConversationRecord`s, dedupes against
 * the user's existing Firestore records, dispatches the unsent ones in
 * fixed-size batches to MiniMax, merges the returned `ExtractionResult`s,
 * and emits a structured cost-telemetry event per LLM call.
 *
 * Dependencies are injectable so unit tests can mock the LLM client and
 * the dedup source without touching env vars or the network. In
 * production, callers should pass a real `OpenAI` instance and a
 * `DedupProvider` backed by Firestore.
 */

export interface DedupProvider {
  /** Returns the set of `providerId`s already imported for this provider. */
  getExistingProviderIds(provider: Provider): Promise<Set<string>>;
}

/** Minimal shape we use from the OpenAI client. Lets tests pass a stub. */
export interface OpenAIClient {
  chat: {
    completions: {
      create(
        params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenAI.Chat.ChatCompletion>;
    };
  };
}

export interface ExtractOptions {
  uid: string;
  provider: Provider;
  conversations: ConversationRecord[];
  /** Defaults to a no-op dedup (empty set) if omitted. */
  dedup?: DedupProvider;
  /** Defaults to a fresh `new OpenAI({...})` built from env. */
  openaiClient?: OpenAIClient;
  model?: string;
  systemPrompt?: string;
}

const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_BATCH_SIZE = 20;

const DEFAULT_SYSTEM_PROMPT = `You are a context extraction engine. Read the following AI conversations and extract structured user context signals.

For each conversation, the title is the line that starts with "===" and the messages follow. Use the title verbatim as the \`source\` field for any signal you attribute to that conversation.

Return ONLY valid JSON matching the schema. No explanations, no markdown, no trailing text.`;

/** Resolve the per-provider batch size. Provider-specific env wins. */
function getBatchSize(provider: Provider): number {
  const providerOverride = process.env[`MINIMAX_BATCH_SIZE_${provider.toUpperCase()}`];
  if (providerOverride && Number.isFinite(Number(providerOverride))) {
    return Number(providerOverride);
  }
  const defaultBatch = process.env.MINIMAX_BATCH_SIZE;
  if (defaultBatch && Number.isFinite(Number(defaultBatch))) {
    return Number(defaultBatch);
  }
  return DEFAULT_BATCH_SIZE;
}

function buildUserPrompt(
  provider: Provider,
  batch: ConversationRecord[],
  schemaReminder: string,
): string {
  const blocks = batch
    .map((c) => `=== ${c.title} ===\n${c.rawText.trim()}`)
    .join('\n\n');
  return `Provider: ${provider}\n\n${blocks}\n\n${schemaReminder}`;
}

const SCHEMA_REMINDER = `Schema:
{
  "preferences":       [{ "value": string, "source": string }],
  "personalFacts":     [{ "value": string, "source": string }],
  "activeIntentions":  [{ "value": string, "source": string }],
  "domainsOfInterest": [{ "value": string, "source": string }]
}

\`source\` must be the exact title of the conversation the signal came from (the text between the "===" markers). Return ONLY the JSON object, no other text.`;

function isSignalArray(v: unknown): v is ExtractionSignal[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as ExtractionSignal).value === 'string' &&
        typeof (s as ExtractionSignal).source === 'string',
    )
  );
}

function normalizeSignals(
  raw: unknown,
  provider: Provider,
): {
  preferences: ExtractionSignal[];
  personalFacts: ExtractionSignal[];
  activeIntentions: ExtractionSignal[];
  domainsOfInterest: ExtractionSignal[];
} {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    preferences: isSignalArray(obj.preferences)
      ? obj.preferences.map((s) => ({ value: s.value, source: s.source, provider }))
      : [],
    personalFacts: isSignalArray(obj.personalFacts)
      ? obj.personalFacts.map((s) => ({ value: s.value, source: s.source, provider }))
      : [],
    activeIntentions: isSignalArray(obj.activeIntentions)
      ? obj.activeIntentions.map((s) => ({ value: s.value, source: s.source, provider }))
      : [],
    domainsOfInterest: isSignalArray(obj.domainsOfInterest)
      ? obj.domainsOfInterest.map((s) => ({ value: s.value, source: s.source, provider }))
      : [],
  };
}

function emptyResult(): ExtractionResult {
  return { preferences: [], personalFacts: [], activeIntentions: [], domainsOfInterest: [] };
}

function mergeResult(into: ExtractionResult, from: ExtractionResult): void {
  into.preferences.push(...from.preferences);
  into.personalFacts.push(...from.personalFacts);
  into.activeIntentions.push(...from.activeIntentions);
  into.domainsOfInterest.push(...from.domainsOfInterest);
}

function defaultClient(): OpenAIClient {
  return new OpenAI({
    apiKey: process.env.MINIMAX_API_KEY,
    baseURL: process.env.MINIMAX_BASE_URL ?? 'https://api.minimax.io/v1',
  });
}

/**
 * Run extraction on a list of conversations. Returns an `ExtractionResult`
 * with the merged signals from every batch that fired. Never throws on
 * bad JSON — bad batches contribute empty arrays and are logged.
 * Network errors and rate-limit errors do propagate.
 */
export async function extractContextSignals(opts: ExtractOptions): Promise<ExtractionResult> {
  if (opts.conversations.length === 0) {
    return emptyResult();
  }

  const dedup = opts.dedup ?? { getExistingProviderIds: async () => new Set<string>() };
  const existing = await dedup.getExistingProviderIds(opts.provider);
  const newConvos = opts.conversations.filter((c) => !existing.has(c.providerId));
  if (newConvos.length === 0) {
    return emptyResult();
  }

  const client = opts.openaiClient ?? defaultClient();
  const model = opts.model ?? DEFAULT_MODEL;
  const systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const batchSize = getBatchSize(opts.provider);
  const merged: ExtractionResult = emptyResult();

  for (let i = 0; i < newConvos.length; i += batchSize) {
    const batch = newConvos.slice(i, i + batchSize);
    const userPrompt = buildUserPrompt(opts.provider, batch, SCHEMA_REMINDER);
    const start = Date.now();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });
    const latencyMs = Date.now() - start;

    logCostEvent({
      provider: opts.provider,
      batchSize: batch.length,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs,
      model,
    });

    const content = response.choices[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      // Bad/empty response — log and continue with empty arrays for this batch.
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Malformed JSON — log and continue.
      continue;
    }
    mergeResult(merged, normalizeSignals(parsed, opts.provider));
  }

  return merged;
}
