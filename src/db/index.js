import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

/** @typedef {import('pg').PoolClient} Client */

/**
 * Runs fn inside a transaction with app.tenant_id set, so every query in it is
 * scoped by RLS. set_config(..., true) is transaction-local: it cannot leak to
 * the next request that reuses this pooled connection.
 * @template T
 * @param {string | null} tenantId
 * @param {(client: Client) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Queries not tied to a tenant (users, refresh tokens, definer lookups). */
export const query = (text, params) => pool.query(text, params);
