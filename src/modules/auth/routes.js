import { randomUUID } from 'node:crypto';
import { query, withTenant } from '../../db/index.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';
import { ipRateLimit } from '../../middleware/rate-limit.js';
import { requireUser } from '../../middleware/authenticate.js';
import { audit } from '../audit/service.js';
import { issueTokens, revokeByToken, rotateRefreshToken } from './tokens.js';

const email = { type: 'string', format: 'email', maxLength: 254 };
const password = { type: 'string', minLength: 8, maxLength: 200 };

const tenantSummary = {
  type: 'object',
  properties: {
    tenant_id: { type: 'string' },
    name: { type: 'string' },
    plan: { type: 'string' },
    role: { type: 'string' },
  },
};

export const session = {
  type: 'object',
  properties: {
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
    tenantId: { type: 'string' },
    tenants: { type: 'array', items: tenantSummary },
  },
};

const userTenants = async (userId) =>
  (await query('SELECT * FROM user_tenants($1)', [userId])).rows;

// A precomputed hash so unknown emails cost the same scrypt time as known ones.
const DUMMY_HASH = await hashPassword('timing-equalizer');

/** Public auth endpoints: signup, login, refresh, logout. */
export async function publicAuthRoutes(app) {
  const limited = { preHandler: ipRateLimit() };

  app.post(
    '/signup',
    {
      ...limited,
      schema: {
        tags: ['auth'],
        summary: 'Create a user and a new organization (caller becomes owner)',
        security: [],
        body: {
          type: 'object',
          required: ['email', 'password', 'name', 'orgName'],
          properties: {
            email,
            password,
            name: { type: 'string', minLength: 1, maxLength: 100 },
            orgName: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
        response: { 201: session },
      },
    },
    async (req, reply) => {
      const { email, password, name, orgName } = req.body;
      const tenantId = randomUUID();
      const passwordHash = await hashPassword(password);
      const userId = await withTenant(tenantId, async (c) => {
        const {
          rows: [user],
        } = await c.query(
          'INSERT INTO users (email, name, password_hash) VALUES (lower($1), $2, $3) RETURNING id',
          [email, name, passwordHash],
        );
        await c.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, orgName]);
        await c.query(
          "INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')",
          [tenantId, user.id],
        );
        req.auth = { actorType: 'user', actorId: user.id };
        await audit(c, req, 'org.created', { targetType: 'tenant', targetId: tenantId });
        return user.id;
      });
      reply.code(201);
      return {
        ...(await issueTokens(userId, tenantId)),
        tenantId,
        tenants: await userTenants(userId),
      };
    },
  );

  app.post(
    '/login',
    {
      ...limited,
      schema: {
        tags: ['auth'],
        summary: 'Log in; optionally choose which organization to enter',
        security: [],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email,
            password: { type: 'string' },
            tenantId: { type: 'string', format: 'uuid' },
          },
        },
        response: { 200: session },
      },
    },
    async (req) => {
      const {
        rows: [user],
      } = await query('SELECT id, password_hash FROM users WHERE email = lower($1)', [
        req.body.email,
      ]);
      const ok = await verifyPassword(req.body.password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'Invalid email or password');

      const tenants = await userTenants(user.id);
      const tenant = req.body.tenantId
        ? tenants.find((t) => t.tenant_id === req.body.tenantId)
        : tenants[0];
      if (!tenant) throw new HttpError(403, 'No access to that organization');

      await withTenant(tenant.tenant_id, (c) => {
        req.auth = { actorType: 'user', actorId: user.id };
        return audit(c, req, 'auth.login');
      });
      return {
        ...(await issueTokens(user.id, tenant.tenant_id)),
        tenantId: tenant.tenant_id,
        tenants,
      };
    },
  );

  app.post(
    '/refresh',
    {
      ...limited,
      schema: {
        tags: ['auth'],
        summary: 'Exchange a refresh token for a new pair (the old one is revoked)',
        security: [],
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string' } },
        },
        response: { 200: session },
      },
    },
    async (req) => {
      const { userId, tenantId, familyId } = await rotateRefreshToken(req.body.refreshToken);
      const tenants = await userTenants(userId);
      if (!tenants.some((t) => t.tenant_id === tenantId)) {
        throw new HttpError(401, 'Membership no longer active');
      }
      return { ...(await issueTokens(userId, tenantId, familyId)), tenantId, tenants };
    },
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Revoke the refresh token chain',
        security: [],
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      await revokeByToken(req.body.refreshToken);
      reply.code(204);
    },
  );
}

/** Auth endpoints that need a valid session (registered inside the authenticated scope). */
export async function sessionAuthRoutes(app) {
  app.get(
    '/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Current principal, organization and role',
        response: {
          200: {
            type: 'object',
            properties: {
              user: {
                type: ['object', 'null'],
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                },
              },
              tenantId: { type: 'string' },
              role: { type: 'string' },
              plan: { type: 'string' },
              actorType: { type: 'string' },
              tenants: { type: 'array', items: tenantSummary },
            },
          },
        },
      },
    },
    async (req) => {
      const { userId, tenantId, role, plan, actorType } = req.auth;
      const user = userId
        ? (await query('SELECT id, email, name FROM users WHERE id = $1', [userId])).rows[0]
        : null;
      return {
        user,
        tenantId,
        role,
        plan,
        actorType,
        tenants: userId ? await userTenants(userId) : [],
      };
    },
  );

  app.post(
    '/switch',
    {
      preHandler: requireUser,
      schema: {
        tags: ['auth'],
        summary: 'Switch the active organization (issues tokens scoped to it)',
        body: {
          type: 'object',
          required: ['tenantId'],
          properties: { tenantId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: session },
      },
    },
    async (req) => {
      const tenants = await userTenants(req.auth.userId);
      if (!tenants.some((t) => t.tenant_id === req.body.tenantId)) {
        throw new HttpError(403, 'Not a member of that organization');
      }
      return {
        ...(await issueTokens(req.auth.userId, req.body.tenantId)),
        tenantId: req.body.tenantId,
        tenants,
      };
    },
  );
}
