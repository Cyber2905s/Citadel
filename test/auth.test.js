import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, signupOrg } from './helpers.js';
import { query, withTenant } from '../src/db/index.js';

test('login rejects bad passwords and unknown emails identically', async () => {
  const org = await signupOrg('Login');
  const bad = await api('POST', '/v1/auth/login', { body: { email: org.email, password: 'nope-nope' } });
  const unknown = await api('POST', '/v1/auth/login', {
    body: { email: 'ghost@test.dev', password: 'nope-nope' },
  });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.body, unknown.body);
  const ok = await api('POST', '/v1/auth/login', { body: { email: org.email, password: 'password123' } });
  assert.equal(ok.status, 200);
});

test('refresh tokens rotate, and reuse revokes the whole family', async () => {
  const org = await signupOrg('Rotate');
  const first = await api('POST', '/v1/auth/refresh', { body: { refreshToken: org.refreshToken } });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.refreshToken, org.refreshToken);

  // Attacker replays the old token -> rejected, and the legitimate new one dies too.
  const replay = await api('POST', '/v1/auth/refresh', { body: { refreshToken: org.refreshToken } });
  assert.equal(replay.status, 401);
  const next = await api('POST', '/v1/auth/refresh', { body: { refreshToken: first.body.refreshToken } });
  assert.equal(next.status, 401);
});

test('passwords and API keys are only stored hashed', async () => {
  const org = await signupOrg('Hash');
  const created = await api('POST', '/v1/api-keys', { token: org.token, body: { name: 'k' } });
  assert.equal(created.status, 201);
  const { key } = created.body;
  assert.match(key, /^ctd_/);

  const { rows } = await withTenant(org.tenantId, (c) => c.query('SELECT key_hash FROM api_keys'));
  assert.notEqual(rows[0].key_hash, key);
  const { rows: users } = await query('SELECT password_hash FROM users WHERE email = $1', [org.email]);
  assert.match(users[0].password_hash, /^scrypt\$/);

  assert.equal((await api('GET', '/v1/projects', { apiKey: key })).status, 200);
  assert.equal((await api('GET', '/v1/api-keys', { token: org.token })).body[0].key, undefined);

  await api('DELETE', `/v1/api-keys/${created.body.id}`, { token: org.token });
  assert.equal((await api('GET', '/v1/projects', { apiKey: key })).status, 401);
});

test('a user in two orgs can switch between them', async () => {
  const home = await signupOrg('Home');
  const away = await signupOrg('Away');
  const inv = await api('POST', '/v1/org/invitations', {
    token: away.token,
    body: { email: home.email, role: 'member' },
  });
  const token = new URL(inv.body.acceptUrl).searchParams.get('invite');
  // Existing account: must prove it owns the email by giving its password.
  const wrong = await api('POST', '/v1/invitations/accept', { body: { token, password: 'wrongpass' } });
  assert.equal(wrong.status, 401);
  const accepted = await api('POST', '/v1/invitations/accept', { body: { token, password: 'password123' } });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.tenants.length, 2);

  const switched = await api('POST', '/v1/auth/switch', {
    token: home.token,
    body: { tenantId: away.tenantId },
  });
  assert.equal(switched.status, 200);
  const me = await api('GET', '/v1/auth/me', { token: switched.body.accessToken });
  assert.equal(me.body.tenantId, away.tenantId);
  assert.equal(me.body.role, 'member');

  const reuse = await api('POST', '/v1/invitations/accept', { body: { token, password: 'password123' } });
  assert.equal(reuse.status, 400);
});

test('health, readiness, metrics and docs are served', async () => {
  assert.equal((await api('GET', '/healthz')).status, 200);
  const ready = await api('GET', '/readyz');
  assert.deepEqual(ready.body, { status: 'ok', postgres: 'ok', redis: 'ok' });
  const { app } = await import('./helpers.js');
  const metrics = await app.inject('/metrics');
  assert.match(metrics.body, /http_request_duration_seconds_bucket/);
  const spec = await app.inject('/docs/json');
  assert.equal(spec.json().openapi.startsWith('3.'), true);
  assert.ok(spec.json().paths['/v1/projects/']);
});

test('pagination walks every row exactly once', async () => {
  const org = await signupOrg('Pages');
  const p = (await api('POST', '/v1/projects', { token: org.token, body: { name: 'P' } })).body;
  for (let i = 0; i < 7; i++) {
    await api('POST', `/v1/projects/${p.id}/tasks`, { token: org.token, body: { title: `t${i}` } });
  }
  const seen = [];
  let cursor = null;
  do {
    const qs = `limit=3${cursor ? `&cursor=${cursor}` : ''}`;
    const page = await api('GET', `/v1/projects/${p.id}/tasks?${qs}`, { token: org.token });
    seen.push(...page.body.data.map((t) => t.title));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, ['t6', 't5', 't4', 't3', 't2', 't1', 't0']);
});

test('soft-deleted projects disappear from the API but stay in the database', async () => {
  const org = await signupOrg('Soft');
  const p = (await api('POST', '/v1/projects', { token: org.token, body: { name: 'gone' } })).body;
  assert.equal((await api('DELETE', `/v1/projects/${p.id}`, { token: org.token })).status, 204);
  assert.equal((await api('GET', `/v1/projects/${p.id}`, { token: org.token })).status, 404);
  const { rows } = await withTenant(org.tenantId, (c) =>
    c.query('SELECT deleted_at FROM projects WHERE id = $1', [p.id]),
  );
  assert.ok(rows[0].deleted_at);
});
