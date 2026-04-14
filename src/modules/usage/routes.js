import { PLANS } from '../../lib/plans.js';
import { requirePermission } from '../../lib/rbac.js';
import { redis } from '../../lib/redis.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function usageRoutes(app) {
  app.get(
    '/',
    {
      preHandler: requirePermission('usage:read'),
      schema: {
        tags: ['usage'],
        summary: 'Plan limits, live counters and daily usage history',
        response: {
          200: {
            type: 'object',
            properties: {
              plan: { type: 'string' },
              limits: { type: 'object', additionalProperties: true },
              current: { type: 'object', additionalProperties: true },
              daily: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    day: { type: 'string' },
                    metric: { type: 'string' },
                    count: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const { tenantId, plan } = req.auth;
      const day = new Date().toISOString().slice(0, 10);
      const [minuteCount, today] = await Promise.all([
        redis.get(`rl:tenant:${tenantId}:${Math.floor(Date.now() / 60_000)}`),
        redis.hgetall(`usage:${day}:${tenantId}`),
      ]);
      const { counts, daily } = await req.tx(async (c) => {
        const {
          rows: [counts],
        } = await c.query(
          `SELECT (SELECT count(*) FROM projects WHERE deleted_at IS NULL)::int AS projects,
                  (SELECT count(*) FROM memberships WHERE deleted_at IS NULL)::int AS members,
                  (SELECT count(*) FROM api_keys WHERE revoked_at IS NULL)::int AS api_keys`,
        );
        const { rows: daily } = await c.query(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, metric, count::int FROM usage_daily
           WHERE day > current_date - 30 ORDER BY day DESC, metric`,
        );
        return { counts, daily };
      });
      return {
        plan,
        limits: PLANS[plan],
        current: {
          requestsThisMinute: Number(minuteCount ?? 0),
          apiCallsToday: Number(today.api_calls ?? 0),
          rateLimitedToday: Number(today.rate_limited ?? 0),
          ...counts,
        },
        daily,
      };
    },
  );
}
