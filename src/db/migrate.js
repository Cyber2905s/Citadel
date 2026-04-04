// Applies migrations/*.sql in order as the owner role, then (re)creates the
// least-privileged app role. The app role gets no DELETE: soft deletes only.
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from '../config.js';

const dir = new URL('../../migrations/', import.meta.url);

export async function migrate({ log = console.log } = {}) {
  const client = new pg.Client({ connectionString: config.migrationDatabaseUrl });
  await client.connect();
  try {
    // Serialize concurrent migrators (api + worker starting together).
    await client.query('SELECT pg_advisory_lock(7263)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      const sql = await readFile(new URL(file, dir), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err.message}`, { cause: err });
      }
    }

    const role = client.escapeIdentifier(config.appDbUser);
    const password = client.escapeLiteral(config.appDbPassword);
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      config.appDbUser,
    ]);
    await client.query(
      `${rowCount ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${password}`,
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(7263)').catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
