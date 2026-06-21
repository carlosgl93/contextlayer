import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import {
  cookiePreHandler,
  tenantPreHandler,
  visitorIdPreHandler,
  TENANT_ID_RE,
} from '../middleware/visitor-auth';
import { getSiteAccess } from '../b2b/siteaccess';
import { getTenantConfig } from '../b2b/tenants';
import { fetchB2BProfile } from '../b2b/profile-client';
import {
  appendMessage,
  ensureConversationId,
  loadConversation,
  type PersistedMessage,
} from '../b2b/chat-history';
import { checkAndIncrementRateLimit } from '../b2b/rate-limit';
import { streamChat, defaultChatClient, type ChatMessage } from '../llm/llm-client';

/**
 * POST /api/v1/widget/chat
 *
 * Two auth paths wired in the route:
 *   - `?visitor_id=vs_xxx` in the query → server-to-server / test
 *     mode. The visitorId is taken from the URL, the cookie is
 *     not consulted. Used by widget tests and by the B2B
 *     customer's backend if they want to call this endpoint
 *     directly.
 *   - cookie path: visitor is in a browser with the
 *     `__Host-context-layer-session` cookie set. We verify the
 *     cookie, derive `visitorId = hash(uid + tenantId)`, and
 *     route through the same handler.
 *
 * Either way, the request must carry `Authorization: Bearer <apiKey>`
 * (tenant API key). The same auth shape /api/v1/widget/config
 * uses.
 *
 * Request body:
 *   { message: string, conversationId?: string }
 *
 * Response: SSE stream with `data: {"token":"..."}` chunks,
 * closing with `data: [DONE]`. On error: `data: {"error":"..."}`
 * followed by close.
 *
 * Side effects:
 *   - reads siteAccess (must not be revoked)
 *   - reads tenant config (system prompt, provider, rate limit)
 *   - reads B2B profile (fallback: Admin SDK direct read)
 *   - increments daily rate limit counter (transactional)
 *   - persists user + assistant messages on completion
 *   - increments siteAccess.accessCount
 */

interface ChatBody {
  message?: unknown;
  conversationId?: unknown;
}

async function streamSseError(reply: import('fastify').FastifyReply, err: string): Promise<void> {
  reply.raw.write(`data: ${JSON.stringify({ error: err })}\n\n`);
  reply.raw.write('data: [DONE]\n\n');
  reply.raw.end();
}

const widgetChatRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{
    Querystring: { tenant?: string; visitor_id?: string };
    Body: ChatBody;
  }>(
    '/api/v1/widget/chat',
    {
      preHandler: [
        tenantPreHandler,
        async function preHandlerBranch(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
          // Branch: visitor_id query takes precedence over cookie.
          // This is intentional: if the B2B customer's server is
          // calling on behalf of a visitor, they supply the id
          // explicitly and we trust the API key as the auth.
          const q = request.query as { visitor_id?: string };
          if (q.visitor_id) {
            await visitorIdPreHandler.call(this, request, reply);
            return;
          }
          await cookiePreHandler.call(this, request, reply);
        },
      ],
    },
    async (request, reply) => {
      const db = app.firebaseAdmin.firestore();
      const session = request.visitorSession;
      if (!session) {
        return reply.code(401).send({ error: 'no_session' });
      }

      // Body validation.
      const message = typeof request.body?.message === 'string' ? request.body.message.trim() : '';
      if (!message) {
        return reply.code(400).send({ error: 'missing_message' });
      }
      if (message.length > 4000) {
        return reply.code(400).send({ error: 'message_too_long', limit: 4000 });
      }
      const providedConvId =
        typeof request.body?.conversationId === 'string' ? request.body.conversationId : undefined;
      const conversationId = ensureConversationId(providedConvId);

      // Revocation check.
      const siteAccess = await getSiteAccess(db, session.tenantId, session.visitorId);
      if (!siteAccess) {
        return reply.code(403).send({ error: 'access_revoked' });
      }
      if (siteAccess.revokedAt) {
        return reply.code(403).send({ error: 'access_revoked' });
      }

      // Tenant config.
      const tenantConfig = await getTenantConfig(db, session.tenantId);
      if (!tenantConfig) {
        return reply.code(404).send({ error: 'tenant_not_found' });
      }
      if (!TENANT_ID_RE.test(session.tenantId)) {
        return reply.code(400).send({ error: 'invalid_tenant' });
      }

      // Rate limit.
      const decision = await checkAndIncrementRateLimit(
        db,
        session.tenantId,
        session.visitorId,
        tenantConfig.rateLimit.messagesPerVisitorPerDay,
      );
      if (!decision.allowed) {
        const retryAfter = decision.resetsAt
          ? Math.max(1, Math.ceil((decision.resetsAt.getTime() - Date.now()) / 1000))
          : 60;
        return reply
          .code(429)
          .header('retry-after', String(retryAfter))
          .send({
            error: 'rate_limited',
            used: decision.used,
            limit: decision.limit,
            resetsAt: decision.resetsAt?.toISOString() ?? null,
          });
      }

      // Profile (best-effort; null is fine).
      const profile = await fetchB2BProfile(db, {
        tenantId: session.tenantId,
        visitorId: session.visitorId,
      });

      // Build messages.
      const systemPrompt = buildSystemPrompt(tenantConfig.systemPrompt, profile);
      const history = (await loadConversation(db, session.tenantId, session.visitorId, conversationId)) ?? [];
      const trimmedHistory = trimHistory(history, 20);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: message },
      ];

      // Persist the user message up front (so a mid-stream crash
      // doesn't lose the visitor's turn).
      const userMsg: PersistedMessage = {
        role: 'user',
        content: message,
        ts: Date.now(),
      };
      await appendMessage(db, {
        tenantId: session.tenantId,
        visitorId: session.visitorId,
        conversationId,
        provider: tenantConfig.defaultProvider,
        message: userMsg,
      });

      // Switch to SSE.
      reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8');
      reply.raw.setHeader('cache-control', 'no-cache, no-transform');
      reply.raw.setHeader('connection', 'keep-alive');
      reply.raw.setHeader('x-accel-buffering', 'no');
      reply.hijack();

      const reply$ = reply;
      const ac = new AbortController();
      request.raw.once('close', () => ac.abort());

      let assembled = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason: string | null = null;
      try {
        const result = await streamChat({
          provider: tenantConfig.defaultProvider,
          messages,
          signal: ac.signal,
          openaiClient: (app as unknown as { llmClient?: typeof defaultChatClient extends () => infer T ? T : never }).llmClient,
          onToken: (tok) => {
            assembled += tok;
            reply$.raw.write(`data: ${JSON.stringify({ token: tok })}\n\n`);
          },
        });
        inputTokens = result.inputTokens;
        outputTokens = result.outputTokens;
        finishReason = result.finishReason;
        reply$.raw.write('data: [DONE]\n\n');
      } catch (err) {
        await streamSseError(reply$, err instanceof Error ? err.message : 'stream_failed');
        request.log.warn(
          { err, tenantId: session.tenantId, visitorId: session.visitorId, conversationId },
          'chat stream failed',
        );
        return;
      }

      // Persist assistant message + increment accessCount.
      const assistantMsg: PersistedMessage = {
        role: 'assistant',
        content: assembled,
        ts: Date.now(),
      };
      await appendMessage(db, {
        tenantId: session.tenantId,
        visitorId: session.visitorId,
        conversationId,
        provider: tenantConfig.defaultProvider,
        message: assistantMsg,
        tokenCountIn: inputTokens,
        tokenCountOut: outputTokens,
      });
      await db
        .collection(`b2bTenants/${session.tenantId}/siteAccess`)
        .doc(session.visitorId)
        .update({ accessCount: (await import('firebase-admin/firestore')).FieldValue.increment(1) });

      request.log.info(
        {
          tenantId: session.tenantId,
          visitorId: session.visitorId,
          conversationId,
          provider: tenantConfig.defaultProvider,
          inputTokens,
          outputTokens,
          finishReason,
        },
        'chat completed',
      );

      reply$.raw.end();
    },
  );
};

function buildSystemPrompt(base: string, profile: import('../b2b/profile-client').B2BProfile | null): string {
  if (!profile) return base;
  const lines: string[] = [base, '', 'User profile (from their imported data; use it to personalize responses):'];
  for (const p of profile.preferences) lines.push(`- Prefers: ${p.value}`);
  for (const p of profile.personalFacts) lines.push(`- Fact: ${p.value}`);
  for (const p of profile.activeIntentions) lines.push(`- Working on: ${p.value}`);
  for (const p of profile.domainsOfInterest) lines.push(`- Interested in: ${p.value}`);
  return lines.join('\n');
}

function trimHistory(history: PersistedMessage[], maxMessages: number): PersistedMessage[] {
  if (history.length <= maxMessages) return history;
  return history.slice(history.length - maxMessages);
}

export default fp(widgetChatRoute) as FastifyPluginAsync;
