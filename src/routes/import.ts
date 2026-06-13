import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import unzipper from 'unzipper';
import { detectProvider } from '../parsers/detect';
import { authenticate } from '../middleware/auth';
import type { Provider } from '../types';

/**
 * POST /api/v1/import/upload
 *
 * Two-phase import flow:
 *
 *   Phase 1 — caller uploads the ZIP with no `confirmed` field (or
 *             `confirmed: "false"`). Server unzips, finds
 *             `conversations.json`, parses, and detects the provider.
 *             Returns `{ provider, conversationCount, confirmed: false }`
 *             so the client can display the MiniMax disclaimer and ask
 *             the user to confirm.
 *
 *   Phase 2 — caller re-uploads the same ZIP with `confirmed: "true"`.
 *             Server validates the provider, then dispatches to the
 *             parser, extraction, and persistence pipeline (U3–U6).
 *             Returns `{ importId, conversationCount, provider }`.
 *
 * The 50MB hard cap is enforced by `@fastify/multipart` limits set in
 * the index.ts registration; oversized uploads are rejected with 413
 * before this handler runs.
 */
const CONVERSATIONS_FILE = 'conversations.json';

interface ImportUploadResponse {
  provider?: Provider;
  conversationCount?: number;
  confirmed: boolean;
  importId?: string;
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

const importRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Reply: ImportUploadResponse }>(
    '/api/v1/import/upload',
    { preHandler: authenticate },
    async (request, reply) => {
      const uid = request.user?.uid ?? 'unknown';

      // Walk all multipart parts. Track the file buffer and the
      // optional `confirmed` field by name.
      let fileBuffer: Buffer | null = null;
      let fileMimetype: string | undefined;
      let confirmed: boolean = false;
      let foundFile = false;

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file') {
              // Drain unexpected file fields so the stream can finish.
              await part.toBuffer();
              continue;
            }
            foundFile = true;
            fileMimetype = part.mimetype;
            fileBuffer = await part.toBuffer();
          } else {
            // Field
            if (part.fieldname === 'confirmed') {
              const v = (part as { value?: unknown }).value;
              if (typeof v === 'string') {
                confirmed = v === 'true';
              } else if (part.value && typeof (part.value as { value?: unknown }).value === 'string') {
                // Some multipart adapters wrap the value
                confirmed = ((part.value as { value: string }).value) === 'true';
              }
            }
          }
        }
      } catch (err) {
        // @fastify/multipart surfaces fileSize overflow as a 413.
        const anyErr = err as { statusCode?: number };
        if (anyErr.statusCode === 413) {
          throw err;
        }
        request.log.warn({ uid, err }, 'multipart parse failed');
        return reply.code(400).send({ confirmed: false } as ImportUploadResponse);
      }

      if (!foundFile || !fileBuffer || fileBuffer.length === 0) {
        return reply.code(400).send({ confirmed: false } as ImportUploadResponse);
      }

      // Early MIME guard — real exports are application/zip or
      // application/octet-stream. Anything else is almost certainly
      // not an export.
      if (fileMimetype && !/(zip|octet-stream|x-zip)/i.test(fileMimetype)) {
        return reply.code(400).send({ confirmed: false } as ImportUploadResponse);
      }

      let parsed: unknown;
      let conversationCount: number;
      try {
        const result = await readConversationsJson(fileBuffer);
        parsed = result.parsed;
        conversationCount = result.conversationCount;
      } catch (err) {
        const e = err as Error & { code?: string };
        const code = e.code ?? e.message ?? 'invalid_upload';
        request.log.warn({ uid, code }, 'import upload rejected');
        return reply
          .code(400)
          .send({ error: code, confirmed: false } as unknown as ImportUploadResponse);
      }

      const provider = detectProvider(parsed);
      if (!provider) {
        return reply.code(400).send({
          error: 'unknown_provider',
          confirmed: false,
        } as unknown as ImportUploadResponse);
      }

      if (!confirmed) {
        return reply.code(202).send({
          provider,
          conversationCount,
          confirmed: false,
        });
      }

      // Phase 2 — defer to U3–U6. Until those land, return a stub
      // importId so the client contract stays stable.
      const importId = `imp_${Date.now()}_${uid.slice(0, 6)}`;
      request.log.info(
        { uid, provider, conversationCount, importId },
        'confirmed import received (pipeline not yet wired)',
      );

      return reply.code(202).send({
        provider,
        conversationCount,
        importId,
        confirmed: true,
      });
    },
  );
};

export default importRoute;
