import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import unzipper from 'unzipper';
import { detectProvider } from '../parsers/detect';
import { parseClaudeConversations } from '../parsers/claude';
import { parseChatGPTConversations } from '../parsers/chatgpt';
import { authenticate } from '../middleware/auth';
import {
  extractContextSignals,
  defaultClient,
  type DedupProvider,
  type OpenAIClient,
} from '../extraction/minimax';
import { writeConversations } from '../firestore/conversations';
import { mergeProfile } from '../firestore/profile';
import type { ConversationRecord, ExtractionResult, Provider } from '../types';

/**
 * POST /api/v1/import/upload
 *
 * Two-phase import flow supporting one or more ZIPs in a single request:
 *
 *   Phase 1 — caller uploads the ZIP(s) with no `confirmed` field (or
 *             `confirmed: "false"`). Server unzips each, finds
 *             `conversations.json`, parses, detects the provider, and
 *             returns an aggregated cost preview so the client can
 *             display the MiniMax disclaimer and ask the user to
 *             confirm. The `providers[]` array reports one entry per
 *             valid file; the `total` row sums them.
 *
 *   Phase 2 — caller re-uploads the same ZIP(s) with `confirmed: "true"`.
 *             Server validates, dispatches to the parser (U3 or U4) for
 *             each file, and (once U5 lands) the LLM extraction pipeline
 *             runs per provider. Returns per-provider importIds.
 *
 * Single-file uploads via the legacy `file` field name continue to work
 * (back-compat with U2). Multi-file uploads use the `files` field name,
 * which may be repeated once per file.
 *
 * Limits:
 *   - per-file: 50MB (set in index.ts via @fastify/multipart)
 *   - aggregate: 50MB (overridable via CGL_MAX_AGGREGATE_UPLOAD_BYTES)
 */
const CONVERSATIONS_FILE = 'conversations.json';
const DEFAULT_MAX_AGGREGATE_BYTES = 50 * 1024 * 1024;

/**
 * Resolved per request so tests can flip the cap without re-importing
 * the module. The default is 50MB; override with
 * `CGL_MAX_AGGREGATE_UPLOAD_BYTES` for tests or production tuning.
 */
function getMaxAggregateBytes(): number {
  return (
    Number(process.env.CGL_MAX_AGGREGATE_UPLOAD_BYTES) || DEFAULT_MAX_AGGREGATE_BYTES
  );
}

// Average rawText per conversation in the founder's Claude export: 9KB.
// Used as the cost-preview proxy when we don't yet have the parsed rawText.
const AVG_RAWTEXT_CHARS_PER_CONVERSATION = 9000;
// Heuristic: 4 chars/token (English text, Claude export style).
const CHARS_PER_TOKEN = 4;
// Cost band per 1M input tokens (Appendix: U5 cost model).
const COST_PER_M_TOKENS_LOW = 0.30;
const COST_PER_M_TOKENS_HIGH = 0.70;

export interface ProviderRow {
  provider: Provider;
  conversationCount: number;
  estimatedTokens: number;
  estimatedCostUsd: string;
  importId?: string;
  /** Populated on phase 2 with the merged extraction result per provider. */
  extraction?: ExtractionResult;
}

export interface ImportTotal {
  providers: number;
  conversationCount: number;
  estimatedTokens: number;
  estimatedCostUsd: string;
}

export interface FailedFile {
  name: string;
  code: string;
}

export interface ImportUploadResponse {
  confirmed: boolean;
  providers?: ProviderRow[];
  total?: ImportTotal;
  error?: string;
  failedFiles?: FailedFile[];
}

/**
 * Estimate token count and cost band from a character count using the
 * Appendix heuristics (4 chars/token, $0.30-0.70 per 1M input tokens).
 *
 * Pure function — exported for unit testing and for any other module that
 * wants a consistent cost preview (e.g., CLI tooling).
 */
export function estimateCostFromCharCount(charCount: number): {
  estimatedTokens: number;
  estimatedCostUsd: string;
} {
  const tokens = Math.max(0, Math.round(charCount / CHARS_PER_TOKEN));
  const low = (tokens / 1_000_000) * COST_PER_M_TOKENS_LOW;
  const high = (tokens / 1_000_000) * COST_PER_M_TOKENS_HIGH;
  return {
    estimatedTokens: tokens,
    estimatedCostUsd: `${low.toFixed(2)}-${high.toFixed(2)}`,
  };
}

/**
 * Sum a list of per-provider cost rows into an aggregate row. Cost strings
 * are summed at both ends of the band so the aggregate remains a range.
 */
export function aggregateProviders(rows: ProviderRow[]): ImportTotal {
  let lowTotal = 0;
  let highTotal = 0;
  let tokenTotal = 0;
  let convoTotal = 0;
  for (const r of rows) {
    const [low, high] = r.estimatedCostUsd.split('-').map(Number);
    if (Number.isFinite(low)) lowTotal += low;
    if (Number.isFinite(high)) highTotal += high;
    tokenTotal += r.estimatedTokens;
    convoTotal += r.conversationCount;
  }
  return {
    providers: rows.length,
    conversationCount: convoTotal,
    estimatedTokens: tokenTotal,
    estimatedCostUsd: `${lowTotal.toFixed(2)}-${highTotal.toFixed(2)}`,
  };
}

async function readConversationsJson(
  buffer: Buffer,
): Promise<{ parsed: unknown; conversationCount: number }> {
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    const e = new Error('not_a_valid_zip') as Error & { code: string };
    throw e;
  }

  const entry = directory.files.find(
    (f) => f.path === CONVERSATIONS_FILE || f.path.endsWith(`/${CONVERSATIONS_FILE}`),
  );

  if (!entry) {
    const e = new Error('missing_conversations_file') as Error & { code: string };
    throw e;
  }

  const content = await entry.buffer();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString('utf-8'));
  } catch {
    const e = new Error('invalid_conversations_json') as Error & { code: string };
    throw e;
  }

  const conversationCount = Array.isArray(parsed) ? parsed.length : 0;
  return { parsed, conversationCount };
}

/**
 * Per-file phase 1 inspection: unzip, parse, detect, estimate. Returns
 * either a ProviderRow (success) or a FailedFile descriptor. Never throws
 * — each file is processed independently so partial success is reportable.
 */
async function inspectFile(
  name: string,
  mimetype: string | undefined,
  buffer: Buffer,
): Promise<{ kind: 'ok'; row: ProviderRow } | { kind: 'failed'; failure: FailedFile }> {
  if (mimetype && !/(zip|octet-stream|x-zip)/i.test(mimetype)) {
    return { kind: 'failed', failure: { name, code: 'invalid_mime_type' } };
  }
  let parsed: unknown;
  let conversationCount: number;
  try {
    const result = await readConversationsJson(buffer);
    parsed = result.parsed;
    conversationCount = result.conversationCount;
  } catch (err) {
    const e = err as Error & { code?: string };
    return {
      kind: 'failed',
      failure: { name, code: e.code ?? e.message ?? 'invalid_upload' },
    };
  }
  const provider = detectProvider(parsed);
  if (!provider) {
    return { kind: 'failed', failure: { name, code: 'unknown_provider' } };
  }
  // Cost preview uses conversation count × 9KB average rawText (Appendix).
  // Once U5 lands, the real rawText sizes can be substituted for tighter
  // estimates; this heuristic is within the plan's ±20% tolerance.
  const charEstimate = conversationCount * AVG_RAWTEXT_CHARS_PER_CONVERSATION;
  const { estimatedTokens, estimatedCostUsd } = estimateCostFromCharCount(charEstimate);
  return {
    kind: 'ok',
    row: {
      provider,
      conversationCount,
      estimatedTokens,
      estimatedCostUsd,
    },
  };
}

const importRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Reply: ImportUploadResponse }>(
    '/api/v1/import/upload',
    { preHandler: authenticate },
    async (request, reply) => {
      const uid = request.user?.uid ?? 'unknown';

      // Walk all multipart parts. Collect every file whose fieldname is
      // `file` (legacy single) or `files` (multi). Track aggregate size
      // as we go so we can short-circuit with 413 before buffering huge
      // payloads. Drain any other file fields so the stream can finish.
      const files: Array<{ name: string; buffer: Buffer; mimetype: string | undefined }> = [];
      let confirmed = false;
      let aggregateSize = 0;
      let sizeExceeded = false;
      const maxAggregateBytes = getMaxAggregateBytes();

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file' && part.fieldname !== 'files') {
              await part.toBuffer();
              continue;
            }
            const buf = await part.toBuffer();
            aggregateSize += buf.length;
            if (aggregateSize > maxAggregateBytes) {
              sizeExceeded = true;
              // Drain remaining parts to keep the stream healthy.
              continue;
            }
            files.push({
              name: part.filename ?? 'unknown',
              buffer: buf,
              mimetype: part.mimetype,
            });
          } else if (part.fieldname === 'confirmed') {
            const v = (part as { value?: unknown }).value;
            if (typeof v === 'string') {
              confirmed = v === 'true';
            } else if (part.value && typeof (part.value as { value?: unknown }).value === 'string') {
              confirmed = ((part.value as { value: string }).value) === 'true';
            }
          }
        }
      } catch (err) {
        const anyErr = err as { statusCode?: number };
        if (anyErr.statusCode === 413) {
          throw err;
        }
        request.log.warn({ uid, err }, 'multipart parse failed');
        return reply.code(400).send({ confirmed: false } as ImportUploadResponse);
      }

      if (sizeExceeded) {
        return reply.code(413).send({
          error: 'payload_too_large',
          confirmed: false,
        } as ImportUploadResponse);
      }

      if (files.length === 0) {
        return reply.code(400).send({ confirmed: false } as ImportUploadResponse);
      }

      // Inspect each file independently. One bad file in a multi-file
      // request does not poison the rest.
      const inspections = await Promise.all(
        files.map((f) => inspectFile(f.name, f.mimetype, f.buffer)),
      );
      const okRows: ProviderRow[] = [];
      const failedFiles: FailedFile[] = [];
      for (const i of inspections) {
        if (i.kind === 'ok') okRows.push(i.row);
        else failedFiles.push(i.failure);
      }

      // Single-file unknown_provider back-compat: keep the original
      // error code on the response so U2-era clients that check
      // `body.error === 'unknown_provider'` still work.
      const isSingleFile = files.length === 1;
      if (okRows.length === 0) {
        const errorCode =
          isSingleFile && failedFiles[0]?.code === 'unknown_provider'
            ? 'unknown_provider'
            : isSingleFile
              ? (failedFiles[0]?.code ?? 'invalid_upload')
              : 'all_files_failed';
        return reply.code(400).send({
          error: errorCode,
          failedFiles,
          providers: [],
          total: aggregateProviders([]),
          confirmed: false,
        } as ImportUploadResponse);
      }

      const total = aggregateProviders(okRows);

      if (!confirmed) {
        // Partial-failure or full-success, awaiting confirmation.
        if (failedFiles.length > 0) {
          return reply.code(400).send({
            error: 'partial_upload',
            failedFiles,
            providers: okRows,
            total,
            confirmed: false,
          } as ImportUploadResponse);
        }
        return reply.code(202).send({
          providers: okRows,
          total,
          confirmed: false,
        } as ImportUploadResponse);
      }

      // Phase 2 — confirmed. For each valid file: re-parse with U3/U4,
      // run U5 extraction (dedup + per-provider batching), and emit a
      // per-provider importId. Firestore persistence (U6) is wired in
      // here too once that lands; for now extraction is the
      // server-visible work product.
      // In production, an injected `minimaxClient` is preferred. When
      // neither injection nor `MINIMAX_API_KEY` is available, fall back
      // to a no-op client so the route still returns a stable shape
      // (signals come back empty). Real LLM calls require a real
      // client; the no-op is the safe local-dev / test default.
      const injectedClient = (app as unknown as { minimaxClient?: OpenAIClient }).minimaxClient;
      const client =
        injectedClient ??
        (process.env.MINIMAX_API_KEY ? defaultClient() : noOpOpenAIClient());
      const dedup = app.minimaxDedupProvider ?? firestoreDedupProvider(app, uid);
      const db = app.firebaseAdmin.firestore();
      const importRows: ProviderRow[] = [];

      for (let i = 0; i < inspections.length; i++) {
        const inspection = inspections[i];
        if (inspection.kind !== 'ok') continue;
        const f = files[i];
        const provider = inspection.row.provider;
        let records: ConversationRecord[];
        try {
          const { parsed } = await readConversationsJson(f.buffer);
          records =
            provider === 'claude'
              ? parseClaudeConversations(parsed as unknown[])
              : parseChatGPTConversations(parsed as unknown[]);
        } catch (err) {
          request.log.warn({ uid, provider, err }, 'phase 2 parse failed');
          return reply.code(500).send({
            error: 'parse_failed',
            provider,
            confirmed: true,
          } as ImportUploadResponse);
        }

        let extraction: ExtractionResult;
        try {
          extraction = await extractContextSignals({
            uid,
            provider,
            conversations: records,
            openaiClient: client,
            dedup,
          });
        } catch (err) {
          request.log.error(
            { uid, provider, err },
            'extraction failed',
          );
          return reply.code(500).send({
            error: 'extraction_failed',
            provider,
            confirmed: true,
          } as ImportUploadResponse);
        }

        // U6 — persist raw conversations and merge the extracted signals
        // into the user profile. Any persistence failure aborts this
        // provider with a 500; previously imported providers in this
        // request are still in the database (each provider commits
        // independently) but the response only reflects the failure.
        try {
          await writeConversations(db, uid, records);
          await mergeProfile(db, uid, extraction);
        } catch (err) {
          request.log.error(
            { uid, provider, err },
            'persistence failed',
          );
          return reply.code(500).send({
            error: 'persistence_failed',
            provider,
            confirmed: true,
          } as ImportUploadResponse);
        }

        importRows.push({
          ...inspection.row,
          importId: `imp_${Date.now()}_${uid.slice(0, 6)}_${provider}`,
          extraction,
        });
      }

      return reply.code(202).send({
        providers: importRows,
        total: aggregateProviders(importRows),
        confirmed: true,
      } as ImportUploadResponse);
    },
  );
};

function noOpOpenAIClient(): OpenAIClient {
  return {
    chat: {
      completions: {
        create: (async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  preferences: [],
                  personalFacts: [],
                  activeIntentions: [],
                  domainsOfInterest: [],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0 },
        })) as unknown as OpenAIClient['chat']['completions']['create'],
      },
    },
  };
}

function firestoreDedupProvider(app: FastifyInstance, uid: string): DedupProvider {
  return {
    async getExistingProviderIds(provider) {
      const admin = app.firebaseAdmin;
      if (!admin) {
        throw new Error('firebaseAdmin not available on Fastify instance');
      }
      const db = admin.firestore();
      const snap = await db
        .collection('users')
        .doc(uid)
        .collection('conversations')
        .where('provider', '==', provider)
        .select('providerId')
        .get();
      const ids = new Set<string>();
      for (const doc of snap.docs) {
        const d = doc.data() as { providerId?: unknown };
        if (typeof d.providerId === 'string') ids.add(d.providerId);
      }
      return ids;
    },
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Optional injected OpenAI-compatible client. Defaults to a fresh
     *  client built from `MINIMAX_API_KEY` + `MINIMAX_BASE_URL`. */
    minimaxClient?: OpenAIClient;
    /** Optional injected dedup provider. Defaults to a Firestore-backed
     *  implementation that queries `users/{uid}/conversations`. */
    minimaxDedupProvider?: DedupProvider;
  }
}

// `fp()` lifts the route out of Fastify's default plugin encapsulation
// so decorations like `firebaseAdmin`, `minimaxClient`, and
// `minimaxDedupProvider` are visible to the route regardless of where
// they are decorated. Same pattern as the firebase plugin.
export default fp(importRoute) as FastifyPluginAsync;
