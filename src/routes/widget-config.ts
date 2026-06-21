import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { tenantApiKeyAuth } from '../middleware/tenant-api-key';
import { getTenantConfig } from '../b2b/tenants';

/**
 * GET /api/v1/widget/config?tenant=acme
 *
 * Returns the tenant's widget config: system prompt, branding,
 * allowed providers, rate limit, and allowed origins. Called by
 * the widget bundle on mount to render the chat bubble correctly
 * for this B2B customer's brand.
 *
 * Auth: tenant API key in `Authorization: Bearer`. The key is
 * scoped to `widget:read` (enforced by the middleware). Origin
 * is checked against `allowedOrigins` so the same key cannot be
 * used from a different B2B site (defense in depth — the key is
 * supposed to stay server-side, but the widget bundle ships it
 * to the browser via a `<meta>` tag).
 *
 * Response shape: a stripped-down version of the config (no
 * internal fields) so the widget never sees e.g. the API key
 * record's lastUsedAt.
 */

interface WidgetConfigResponse {
  tenantId: string;
  systemPrompt: string;
  branding: { primaryColor: string; logoUrl: string | null; displayName: string };
  allowedProviders: string[];
  defaultProvider: string;
  rateLimit: { messagesPerVisitorPerDay: number };
}

const widgetConfigRoute: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{
    Querystring: { tenant?: string };
    Reply: WidgetConfigResponse | { error: string; message?: string };
  }>(
    '/api/v1/widget/config',
    {
      preHandler: tenantApiKeyAuth,
      config: { requiredScope: 'widget:read' },
    },
    async (request, reply) => {
      const tenantId = request.query.tenant ?? request.tenant!.tenantId;
      if (tenantId !== request.tenant!.tenantId) {
        return reply.code(403).send({
          error: 'tenant_mismatch',
          message: 'the API key does not match the requested tenant',
        });
      }

      const cfg = await getTenantConfig(app.firebaseAdmin.firestore(), tenantId);
      if (!cfg) {
        return reply.code(404).send({ error: 'tenant_not_found' });
      }

      return {
        tenantId,
        systemPrompt: cfg.systemPrompt,
        branding: cfg.branding,
        allowedProviders: cfg.allowedProviders,
        defaultProvider: cfg.defaultProvider,
        rateLimit: cfg.rateLimit,
      };
    },
  );
};

export default fp(widgetConfigRoute) as FastifyPluginAsync;