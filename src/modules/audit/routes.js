import { requirePermission } from '../../lib/rbac.js';
import { pageOf, pageQuery, toPage } from '../../lib/pagination.js';

const auditEntry = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    actor_type: { type: 'string' },
    actor_id: { type: ['string', 'null'] },
    actor_email: { type: ['string', 'null'] },
    action: { type: 'string' },
    target_type: { type: ['string', 'null'] },
    target_id: { type: ['string', 'null'] },
    metadata: { type: 'object', additionalProperties: true },
    ip: { type: ['string', 'null'] },
    request_id: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function auditRoutes(app) {
  app.get(
    '/',
    {
      preHandler: requirePermission('audit:read'),
      schema: {
        tags: ['audit'],
        summary: 'List audit log entries, newest first',
        querystring: {
          type: 'object',
          properties: { ...pageQuery, action: { type: 'string' } },
        },
        response: { 200: pageOf(auditEntry) },
      },
    },
    async (req) => {
      const { limit, cursor, action } = req.query;
      const rows = await req.tx(async (c) => {
        const { rows } = await c.query(
          `SELECT a.*, u.email AS actor_email FROM audit_logs a
           LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id
           WHERE ($1::uuid IS NULL OR a.id < $1) AND ($2::text IS NULL OR a.action = $2)
           ORDER BY a.id DESC LIMIT $3`,
          [cursor ?? null, action ?? null, limit + 1],
        );
        return rows;
      });
      return toPage(rows, limit);
    },
  );
}
