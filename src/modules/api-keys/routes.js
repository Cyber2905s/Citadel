import { randomToken, sha256 } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { requirePermission } from '../../lib/rbac.js';
import { audit } from '../audit/service.js';
import { enforceLimit } from '../orgs/routes.js';

const apiKey = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    prefix: { type: 'string' },
    role: { type: 'string' },
    last_used_at: { type: ['string', 'null'], format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
    key: { type: 'string', description: 'Only returned once, at creation' },
  },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function apiKeyRoutes(app) {
  app.addHook('preHandler', requirePermission('apikeys:manage'));

  app.get(
    '/',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'List active API keys',
        response: { 200: { type: 'array', items: apiKey } },
      },
    },
    async (req) =>
      req.tx(
        async (c) =>
          (
            await c.query(
              `SELECT id, name, prefix, role, last_used_at, created_at FROM api_keys
               WHERE revoked_at IS NULL ORDER BY id DESC`,
            )
          ).rows,
      ),
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Create an API key. The secret is shown once and stored only as a hash.',
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            role: { type: 'string', enum: ['admin', 'member'], default: 'member' },
          },
        },
        response: { 201: apiKey },
      },
    },
    async (req, reply) => {
      if (!req.auth.userId) throw new HttpError(403, 'API keys must be created by a user');
      // A key can never outrank its creator.
      if (req.body.role === 'admin' && req.auth.role === 'member') {
        throw new HttpError(403, 'Cannot create a key with more privileges than yourself');
      }
      const prefix = `ctd_${randomToken(6)}`;
      const key = `${prefix}_${randomToken(32)}`;
      const row = await req.tx(async (c) => {
        const {
          rows: [{ count }],
        } = await c.query('SELECT count(*) FROM api_keys WHERE revoked_at IS NULL');
        enforceLimit(req.auth.plan, 'maxApiKeys', Number(count));
        const {
          rows: [row],
        } = await c.query(
          `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, role, created_by)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
           RETURNING id, name, prefix, role, last_used_at, created_at`,
          [req.body.name, prefix, sha256(key), req.body.role, req.auth.userId],
        );
        await audit(c, req, 'api_key.created', {
          targetType: 'api_key',
          targetId: row.id,
          metadata: { name: row.name, role: row.role, prefix },
        });
        return row;
      });
      reply.code(201);
      return { ...row, key };
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags: ['api-keys'],
        summary: 'Revoke an API key',
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (req, reply) => {
      await req.tx(async (c) => {
        const { rows } = await c.query(
          'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING name',
          [req.params.id],
        );
        if (!rows.length) throw notFound('API key');
        await audit(c, req, 'api_key.revoked', {
          targetType: 'api_key',
          targetId: req.params.id,
          metadata: { name: rows[0].name },
        });
      });
      reply.code(204);
    },
  );
}
