import { config } from '../../config.js';
import { query, withTenant } from '../../db/index.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { PLANS } from '../../lib/plans.js';
import { requirePermission } from '../../lib/rbac.js';
import { emailQueue } from '../../lib/queues.js';
import { ipRateLimit } from '../../middleware/rate-limit.js';
import { audit } from '../audit/service.js';
import { session } from '../auth/routes.js';
import { issueTokens } from '../auth/tokens.js';

const uuidParam = (name) => ({
  type: 'object',
  required: [name],
  properties: { [name]: { type: 'string', format: 'uuid' } },
});

const member = {
  type: 'object',
  properties: {
    user_id: { type: 'string' },
    email: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
};

const invitation = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    email: { type: 'string' },
    role: { type: 'string' },
    expires_at: { type: 'string', format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
    acceptUrl: { type: 'string' },
  },
};

/** Throws 402 when `used` has reached the plan's `limitName` cap. */
export function enforceLimit(plan, limitName, used) {
  const max = PLANS[plan][limitName];
  if (max !== null && used >= max) {
    throw new HttpError(
      402,
      `The ${plan} plan allows at most ${max} (${limitName}); upgrade to add more`,
    );
  }
}

/** Refuses changes that would leave the org without an owner. */
async function assertNotLastOwner(c, userId) {
  const { rows } = await c.query(
    "SELECT user_id FROM memberships WHERE role = 'owner' AND deleted_at IS NULL",
  );
  if (rows.length === 1 && rows[0].user_id === userId) {
    throw new HttpError(409, 'An organization must keep at least one owner');
  }
}

/** @param {import('fastify').FastifyInstance} app */
export async function orgRoutes(app) {
  app.get(
    '/',
    {
      preHandler: requirePermission('org:read'),
      schema: {
        tags: ['org'],
        summary: 'Current organization and plan limits',
        response: {
          200: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              plan: { type: 'string' },
              created_at: { type: 'string', format: 'date-time' },
              limits: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (req) => {
      const org = await req.tx(async (c) => (await c.query('SELECT * FROM tenants')).rows[0]);
      return { ...org, limits: PLANS[org.plan] };
    },
  );

  app.patch(
    '/',
    {
      preHandler: requirePermission('org:update'),
      schema: {
        tags: ['org'],
        summary: 'Rename the org or change plan (owner only; no billing in this demo)',
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            plan: { type: 'string', enum: Object.keys(PLANS) },
          },
        },
      },
    },
    async (req) => {
      const { name, plan } = req.body;
      return req.tx(async (c) => {
        const {
          rows: [before],
        } = await c.query('SELECT name, plan FROM tenants');
        const {
          rows: [org],
        } = await c.query(
          'UPDATE tenants SET name = COALESCE($1, name), plan = COALESCE($2, plan) RETURNING *',
          [name ?? null, plan ?? null],
        );
        await audit(c, req, 'org.updated', {
          targetType: 'tenant',
          targetId: org.id,
          metadata: { before, after: { name: org.name, plan: org.plan } },
        });
        return { ...org, limits: PLANS[org.plan] };
      });
    },
  );

  app.get(
    '/members',
    {
      preHandler: requirePermission('members:read'),
      schema: {
        tags: ['members'],
        summary: 'List members',
        response: { 200: { type: 'array', items: member } },
      },
    },
    async (req) =>
      req.tx(
        async (c) =>
          (
            await c.query(
              `SELECT m.user_id, u.email, u.name, m.role, m.created_at
               FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.deleted_at IS NULL ORDER BY m.id`,
            )
          ).rows,
      ),
  );

  app.patch(
    '/members/:userId',
    {
      preHandler: requirePermission('members:update'),
      schema: {
        tags: ['members'],
        summary: "Change a member's role (owner only)",
        params: uuidParam('userId'),
        body: {
          type: 'object',
          required: ['role'],
          properties: { role: { type: 'string', enum: ['owner', 'admin', 'member'] } },
        },
      },
    },
    async (req) =>
      req.tx(async (c) => {
        const { userId } = req.params;
        if (req.body.role !== 'owner') await assertNotLastOwner(c, userId);
        const {
          rows: [row],
        } = await c.query(
          `UPDATE memberships m SET role = $2
           FROM memberships old
           WHERE old.id = m.id AND m.user_id = $1 AND m.deleted_at IS NULL
           RETURNING m.user_id, m.role, old.role AS previous_role`,
          [userId, req.body.role],
        );
        if (!row) throw notFound('Member');
        await audit(c, req, 'member.role_changed', {
          targetType: 'user',
          targetId: userId,
          metadata: { from: row.previous_role, to: row.role },
        });
        return { user_id: row.user_id, role: row.role };
      }),
  );

  app.delete(
    '/members/:userId',
    {
      preHandler: requirePermission('members:remove'),
      schema: {
        tags: ['members'],
        summary: 'Remove a member (soft delete)',
        params: uuidParam('userId'),
      },
    },
    async (req, reply) => {
      await req.tx(async (c) => {
        const { userId } = req.params;
        const {
          rows: [target],
        } = await c.query(
          'SELECT role FROM memberships WHERE user_id = $1 AND deleted_at IS NULL',
          [userId],
        );
        if (!target) throw notFound('Member');
        if (target.role === 'owner' && req.auth.role !== 'owner') {
          throw new HttpError(403, 'Only owners can remove owners');
        }
        await assertNotLastOwner(c, userId);
        await c.query(
          'UPDATE memberships SET deleted_at = now() WHERE user_id = $1 AND deleted_at IS NULL',
          [userId],
        );
        await audit(c, req, 'member.removed', {
          targetType: 'user',
          targetId: userId,
          metadata: { role: target.role },
        });
      });
      reply.code(204);
    },
  );

  app.get(
    '/invitations',
    {
      preHandler: requirePermission('members:invite'),
      schema: {
        tags: ['members'],
        summary: 'List pending invitations',
        response: { 200: { type: 'array', items: invitation } },
      },
    },
    async (req) =>
      req.tx(
        async (c) =>
          (
            await c.query(
              `SELECT id, email, role, expires_at, created_at FROM invitations
               WHERE accepted_at IS NULL AND expires_at > now() ORDER BY id DESC`,
            )
          ).rows,
      ),
  );

  app.post(
    '/invitations',
    {
      preHandler: requirePermission('members:invite'),
      schema: {
        tags: ['members'],
        summary: 'Invite someone by email; an email job is queued',
        body: {
          type: 'object',
          required: ['email', 'role'],
          properties: {
            email: { type: 'string', format: 'email' },
            role: { type: 'string', enum: ['admin', 'member'] },
          },
        },
        response: { 201: invitation },
      },
    },
    async (req, reply) => {
      if (!req.auth.userId) throw new HttpError(403, 'Invitations must be sent by a user');
      const token = randomToken();
      const inv = await req.tx(async (c) => {
        const {
          rows: [{ count }],
        } = await c.query(
          `SELECT (SELECT count(*) FROM memberships WHERE deleted_at IS NULL)
                + (SELECT count(*) FROM invitations WHERE accepted_at IS NULL AND expires_at > now()) AS count`,
        );
        enforceLimit(req.auth.plan, 'maxMembers', Number(count));
        const {
          rows: [row],
        } = await c.query(
          `INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES (current_tenant_id(), lower($1), $2, $3, $4, now() + interval '7 days')
           RETURNING id, email, role, expires_at, created_at`,
          [req.body.email, req.body.role, sha256(token), req.auth.userId],
        );
        await audit(c, req, 'member.invited', {
          targetType: 'invitation',
          targetId: row.id,
          metadata: { email: row.email, role: row.role },
        });
        return row;
      });
      const acceptUrl = `${config.appUrl}/?invite=${token}`;
      await emailQueue.add('invitation', {
        to: inv.email,
        subject: 'You have been invited to Citadel',
        text: `Accept your invitation: ${acceptUrl}`,
      });
      reply.code(201);
      // The link normally only travels by email; echoing it outside production keeps the demo self-contained.
      return config.env === 'production' ? inv : { ...inv, acceptUrl };
    },
  );
}

/** Public: accept an invitation (creates the user or verifies their password). */
export async function acceptInvitationRoute(app) {
  app.post(
    '/accept',
    {
      preHandler: ipRateLimit(),
      schema: {
        tags: ['members'],
        summary: 'Accept an invitation',
        security: [],
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token: { type: 'string' },
            password: { type: 'string', minLength: 8, maxLength: 200 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        response: { 200: session },
      },
    },
    async (req) => {
      const {
        rows: [inv],
      } = await query('SELECT * FROM invitation_by_token($1)', [sha256(req.body.token)]);
      if (!inv || inv.accepted_at || inv.expires_at < new Date()) {
        throw new HttpError(400, 'Invitation is invalid or expired');
      }

      let {
        rows: [user],
      } = await query('SELECT id, password_hash FROM users WHERE email = $1', [inv.email]);
      if (user) {
        if (!(await verifyPassword(req.body.password, user.password_hash))) {
          throw new HttpError(401, 'Wrong password for existing account');
        }
      } else {
        if (!req.body.name) throw new HttpError(400, 'name is required for new accounts');
        ({
          rows: [user],
        } = await query(
          'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
          [inv.email, req.body.name, await hashPassword(req.body.password)],
        ));
      }

      await withTenant(inv.tenant_id, async (c) => {
        const { rowCount } = await c.query(
          'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL',
          [inv.id],
        );
        if (!rowCount) throw new HttpError(400, 'Invitation already used');
        await c.query(
          `INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, user_id) WHERE deleted_at IS NULL DO NOTHING`,
          [inv.tenant_id, user.id, inv.role],
        );
        req.auth = { actorType: 'user', actorId: user.id };
        await audit(c, req, 'invitation.accepted', {
          targetType: 'invitation',
          targetId: inv.id,
          metadata: { role: inv.role },
        });
      });

      const tenants = (await query('SELECT * FROM user_tenants($1)', [user.id])).rows;
      return { ...(await issueTokens(user.id, inv.tenant_id)), tenantId: inv.tenant_id, tenants };
    },
  );
}
