import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { config } from './config.js';
import { pool, withTenant } from './db/index.js';
import { redis } from './lib/redis.js';
import { httpDuration, registry } from './lib/metrics.js';
import { authenticate } from './middleware/authenticate.js';
import { tenantRateLimit } from './middleware/rate-limit.js';
import { publicAuthRoutes, sessionAuthRoutes } from './modules/auth/routes.js';
import { acceptInvitationRoute, orgRoutes } from './modules/orgs/routes.js';
import apiKeyRoutes from './modules/api-keys/routes.js';
import { projectRoutes, taskRoutes } from './modules/projects/routes.js';
import auditRoutes from './modules/audit/routes.js';
import usageRoutes from './modules/usage/routes.js';

// Postgres error codes that are the client's fault, not ours.
const PG_ERRORS = {
  23505: [409, 'Already exists'],
  23503: [400, 'Referenced resource does not exist'],
  '22P02': [400, 'Invalid input'],
  42501: [403, 'Forbidden by tenant isolation policy'],
};

/** @param {{ logger?: boolean | object }} [opts] */
export async function buildApp({ logger = { level: config.logLevel } } = {}) {
  const app = Fastify({
    logger,
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'request_id',
    genReqId: () => randomUUID(),
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: 'all' } },
  });

  app.decorateRequest('auth', null);
  /** Run fn in a transaction scoped (via RLS) to the caller's tenant. */
  app.decorateRequest('tx', function (fn) {
    return withTenant(this.auth.tenantId, fn);
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe(
      { method: req.method, route: req.routeOptions.url ?? 'unmatched', status_code: reply.statusCode },
      reply.elapsedTime / 1000,
    );
  });

  app.setErrorHandler((err, req, reply) => {
    const mapped = PG_ERRORS[err.code];
    if (mapped) {
      req.log.info({ pg_code: err.code, detail: err.detail }, 'database constraint rejected request');
      return reply.code(mapped[0]).send({ statusCode: mapped[0], error: mapped[1], message: mapped[1] });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    reply.code(status).send({
      statusCode: status,
      error: status >= 500 ? 'Internal Server Error' : err.name,
      message: status >= 500 ? 'Something went wrong' : err.message,
    });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Citadel API',
        version: '0.1.0',
        description:
          'Multi-tenant B2B SaaS API. Authenticate with `Authorization: Bearer <accessToken>` or `x-api-key`.',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
      security: [{ bearer: [] }, { apiKey: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (req, reply) => {
    const checks = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
    const [db, cache] = checks.map((c) => (c.status === 'fulfilled' ? 'ok' : 'down'));
    const ready = db === 'ok' && cache === 'ok';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'degraded', postgres: db, redis: cache };
  });
  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  await app.register(
    async (v1) => {
      await v1.register(publicAuthRoutes, { prefix: '/auth' });
      await v1.register(acceptInvitationRoute, { prefix: '/invitations' });

      // Everything registered in here is authenticated, tenant-scoped and rate limited.
      await v1.register(async (tenant) => {
        tenant.addHook('preHandler', authenticate);
        tenant.addHook('preHandler', tenantRateLimit);
        await tenant.register(sessionAuthRoutes, { prefix: '/auth' });
        await tenant.register(orgRoutes, { prefix: '/org' });
        await tenant.register(apiKeyRoutes, { prefix: '/api-keys' });
        await tenant.register(projectRoutes, { prefix: '/projects' });
        await tenant.register(taskRoutes, { prefix: '/tasks' });
        await tenant.register(auditRoutes, { prefix: '/audit-logs' });
        await tenant.register(usageRoutes, { prefix: '/usage' });
      });
    },
    { prefix: '/v1' },
  );

  return app;
}
