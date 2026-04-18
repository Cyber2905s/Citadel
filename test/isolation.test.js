import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupOrg } from './helpers.js';
import { pool, withTenant } from '../src/db/index.js';

let a, b, projectA, projectB;

before(async () => {
  a = await signupOrg('Alpha');
  b = await signupOrg('Bravo');
  projectA = (await api('POST', '/v1/projects', { token: a.token, body: { name: 'A secret' } })).body;
  projectB = (await api('POST', '/v1/projects', { token: b.token, body: { name: 'B secret' } })).body;
  await api('POST', `/v1/projects/${projectB.id}/tasks`, { token: b.token, body: { title: 'B task' } });
});

// These run the kind of queries a buggy handler would: no tenant filter at all,
// or an explicit filter on the *other* tenant. RLS must still return nothing of B's.
test('buggy queries as tenant A never see tenant B rows', async () => {
  await withTenant(a.tenantId, async (c) => {
    for (const table of ['projects', 'tasks', 'memberships', 'audit_logs', 'api_keys', 'invitations']) {
      const { rows } = await c.query(`SELECT tenant_id FROM ${table}`);
      assert.ok(
        rows.every((r) => r.tenant_id === a.tenantId),
        `${table} leaked another tenant's rows`,
      );
    }
    const { rows: tenants } = await c.query('SELECT id FROM tenants');
    assert.deepEqual(
      tenants.map((t) => t.id),
      [a.tenantId],
    );

    const explicit = await c.query('SELECT * FROM projects WHERE tenant_id = $1', [b.tenantId]);
    assert.equal(explicit.rowCount, 0);
    const byId = await c.query('SELECT * FROM projects WHERE id = $1', [projectB.id]);
    assert.equal(byId.rowCount, 0);
    const joined = await c.query(
      'SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.id = $1',
      [projectB.id],
    );
    assert.equal(joined.rowCount, 0);
  });
});

test('tenant A cannot modify or delete tenant B rows', async () => {
  await withTenant(a.tenantId, async (c) => {
    const upd = await c.query("UPDATE projects SET name = 'pwned' WHERE id = $1", [projectB.id]);
    assert.equal(upd.rowCount, 0);
    const updAll = await c.query("UPDATE projects SET description = 'touched'");
    assert.equal(updAll.rowCount, 1, 'only A’s own project is updatable');
  });
  // The app role has no DELETE privilege at all (soft deletes only).
  await assert.rejects(
    withTenant(a.tenantId, (c) => c.query('DELETE FROM projects')),
    /permission denied/,
  );
  const { rows } = await withTenant(b.tenantId, (c) => c.query('SELECT name FROM projects'));
  assert.deepEqual(rows, [{ name: 'B secret' }]);
});

test('tenant A cannot write rows into tenant B', async () => {
  await assert.rejects(
    withTenant(a.tenantId, (c) =>
      c.query("INSERT INTO projects (tenant_id, name) VALUES ($1, 'planted')", [b.tenantId]),
    ),
    /row-level security/,
  );
  // Composite FK stops a task in A pointing at B's project (FK checks bypass RLS).
  await assert.rejects(
    withTenant(a.tenantId, (c) =>
      c.query("INSERT INTO tasks (tenant_id, project_id, title) VALUES ($1, $2, 'x')", [
        a.tenantId,
        projectB.id,
      ]),
    ),
    /foreign key/,
  );
});

test('no tenant set means no rows, and the setting never leaks across pooled connections', async () => {
  // Burn through every pooled connection with tenant A set...
  await Promise.all(
    Array.from({ length: 25 }, () => withTenant(a.tenantId, (c) => c.query('SELECT 1'))),
  );
  // ...then plain pool queries must see nothing.
  for (let i = 0; i < 25; i++) {
    const { rowCount } = await pool.query('SELECT * FROM projects');
    assert.equal(rowCount, 0);
  }
});

test('the app role cannot switch RLS off', async () => {
  await assert.rejects(
    pool.query('ALTER TABLE projects DISABLE ROW LEVEL SECURITY'),
    /must be owner/,
  );
  await assert.rejects(
    withTenant(a.tenantId, async (c) => {
      await c.query('SET LOCAL row_security = off');
      await c.query('SELECT * FROM projects');
    }),
    /row-level security/,
  );
});

test('HTTP: tenant A gets 404 for every route touching tenant B resources', async () => {
  const t = { token: a.token };
  assert.equal((await api('GET', `/v1/projects/${projectB.id}`, t)).status, 404);
  assert.equal(
    (await api('PATCH', `/v1/projects/${projectB.id}`, { ...t, body: { name: 'x' } })).status,
    404,
  );
  assert.equal((await api('DELETE', `/v1/projects/${projectB.id}`, t)).status, 404);
  assert.equal(
    (await api('POST', `/v1/projects/${projectB.id}/tasks`, { ...t, body: { title: 'x' } })).status,
    404,
  );
  const tasks = await api('GET', `/v1/projects/${projectB.id}/tasks`, t);
  assert.deepEqual(tasks.body.data, []);

  const list = await api('GET', '/v1/projects', t);
  assert.deepEqual(
    list.body.data.map((p) => p.id),
    [projectA.id],
  );
});

test('HTTP: a token for org A cannot be replayed against org B', async () => {
  // Access token claims tenant B, but the user is not a member there.
  const { signAccessToken } = await import('../src/modules/auth/tokens.js');
  const me = await api('GET', '/v1/auth/me', { token: a.token });
  const forged = await signAccessToken(me.body.user.id, b.tenantId);
  assert.equal((await api('GET', '/v1/projects', { token: forged })).status, 401);
});
