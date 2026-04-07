import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../config.js';
import { query } from '../../db/index.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';

const secret = new TextEncoder().encode(config.jwtSecret);

/** @param {string} userId @param {string} tenantId */
export const signAccessToken = (userId, tenantId) =>
  new SignJWT({ tid: tenantId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(config.accessTokenTtl)
    .sign(secret);

/** @returns {Promise<{ userId: string, tenantId: string }>} */
export async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    return { userId: /** @type {string} */ (payload.sub), tenantId: /** @type {string} */ (payload.tid) };
  } catch {
    throw new HttpError(401, 'Invalid or expired access token');
  }
}

/**
 * Issues an access token plus a new refresh token in `familyId`'s rotation chain.
 * @param {string} userId @param {string} tenantId @param {string} [familyId]
 */
export async function issueTokens(userId, tenantId, familyId = randomUUID()) {
  const refreshToken = randomToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, tenant_id, family_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [userId, tenantId, familyId, sha256(refreshToken), config.refreshTokenTtlDays],
  );
  return { accessToken: await signAccessToken(userId, tenantId), refreshToken };
}

/**
 * Rotation: each refresh token works once. Presenting an already-rotated token
 * means it was stolen (or replayed), so the whole family is revoked.
 * @param {string} refreshToken
 */
export async function rotateRefreshToken(refreshToken) {
  const {
    rows: [row],
  } = await query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)]);
  if (!row || row.expires_at < new Date()) throw new HttpError(401, 'Invalid refresh token');

  const { rowCount } = await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [row.id],
  );
  if (rowCount === 0) {
    await revokeFamily(row.family_id);
    throw new HttpError(401, 'Refresh token reuse detected; session revoked');
  }
  return { userId: row.user_id, tenantId: row.tenant_id, familyId: row.family_id };
}

export const revokeFamily = (familyId) =>
  query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId],
  );

export async function revokeByToken(refreshToken) {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
     WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [sha256(refreshToken)],
  );
}
