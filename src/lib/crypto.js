import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/** @param {string} password */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = /** @type {Buffer} */ (await scryptAsync(password, salt, 64));
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** @param {string} password @param {string} stored */
export async function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const key = /** @type {Buffer} */ (await scryptAsync(password, Buffer.from(salt, 'base64'), 64));
  return timingSafeEqual(key, expected);
}

/** High-entropy random secret (refresh tokens, invites, API keys). */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** SHA-256 is enough for high-entropy secrets; slow hashes are for passwords. */
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
