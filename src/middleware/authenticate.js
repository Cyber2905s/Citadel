import { query, withTenant } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';

/**
 * @typedef {object} AuthContext
 * @property {string} tenantId
 * @property {'owner'|'admin'|'member'} role
 * @property {'free'|'pro'|'enterprise'} plan
 * @property {'user'|'api_key'} actorType
 * @property {string} actorId   user id or api key id
 * @property {string | null} userId
 */

/**
 * preHandler: resolves a Bearer JWT or `x-api-key` into req.auth.
 * Role is read from the membership on every request (not trusted from the JWT),
 * so a removed or demoted member loses access immediately.
 */
export async function authenticate(req, reply) {
  const apiKey = req.headers['x-api-key'];
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];

  /** @type {AuthContext} */
  let auth;
  if (typeof apiKey === 'string') {
    const {
      rows: [key],
    } = await query('SELECT * FROM auth_api_key($1)', [sha256(apiKey)]);
    if (!key) throw new HttpError(401, 'Invalid API key');
    const plan = await withTenant(key.tenant_id, async (c) => {
      const { rows } = await c.query('SELECT plan FROM tenants');
      return rows[0].plan;
    });
    auth = {
      tenantId: key.tenant_id,
      role: key.role,
      plan,
      actorType: 'api_key',
      actorId: key.id,
      userId: null,
    };
  } else if (bearer) {
    const { userId, tenantId } = await verifyAccessToken(bearer);
    const row = await withTenant(tenantId, async (c) => {
      const { rows } = await c.query(
        `SELECT m.role, t.plan FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.deleted_at IS NULL AND t.deleted_at IS NULL`,
        [userId],
      );
      return rows[0];
    });
    if (!row) throw new HttpError(401, 'Not a member of this organization');
    auth = { tenantId, role: row.role, plan: row.plan, actorType: 'user', actorId: userId, userId };
  } else {
    throw new HttpError(401, 'Missing credentials');
  }

  req.auth = auth;
  req.log = reply.log = req.log.child({ tenant_id: auth.tenantId });
}

/** preHandler for routes that only make sense for a logged-in human. */
export async function requireUser(req) {
  if (!req.auth.userId) throw new HttpError(403, 'This endpoint requires a user session');
}
