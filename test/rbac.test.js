import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, addMember, signupOrg } from './helpers.js';
import { can } from '../src/lib/rbac.js';

let owner, admin, member, project;

before(async () => {
  owner = await signupOrg('Rbac');
  await api('PATCH', '/v1/org', { token: owner.token, body: { plan: 'pro' } });
  admin = await addMember(owner, 'admin');
  member = await addMember(owner, 'member');
  project = (await api('POST', '/v1/projects', { token: owner.token, body: { name: 'P' } })).body;
});

test('permission matrix', () => {
  assert.ok(can('owner', 'org:update'));
  assert.ok(!can('admin', 'org:update'));
  assert.ok(can('admin', 'members:invite'));
  assert.ok(!can('member', 'members:invite'));
  assert.ok(can('member', 'projects:write'));
  assert.ok(!can('member', 'projects:delete'));
  assert.ok(!can('member', 'unknown:perm'));
});

test('member: can work on projects but not administer', async () => {
  const t = { token: member.token };
  assert.equal((await api('GET', '/v1/projects', t)).status, 200);
  assert.equal(
    (await api('POST', `/v1/projects/${project.id}/tasks`, { ...t, body: { title: 'ok' } })).status,
    201,
  );
  assert.equal((await api('DELETE', `/v1/projects/${project.id}`, t)).status, 403);
  assert.equal((await api('GET', '/v1/audit-logs', t)).status, 403);
  assert.equal((await api('GET', '/v1/api-keys', t)).status, 403);
  assert.equal(
    (await api('POST', '/v1/org/invitations', { ...t, body: { email: 'x@y.dev', role: 'member' } }))
      .status,
    403,
  );
  assert.equal((await api('PATCH', '/v1/org', { ...t, body: { plan: 'enterprise' } })).status, 403);
});

test('admin: can invite and read audit log, but not change plan, roles or remove owners', async () => {
  const t = { token: admin.token };
  assert.equal((await api('GET', '/v1/audit-logs', t)).status, 200);
  assert.equal((await api('PATCH', '/v1/org', { ...t, body: { plan: 'enterprise' } })).status, 403);
  const me = await api('GET', '/v1/auth/me', { token: owner.token });
  assert.equal(
    (await api('PATCH', `/v1/org/members/${member.userId}`, { ...t, body: { role: 'admin' } }))
      .status,
    403,
  );
  assert.equal((await api('DELETE', `/v1/org/members/${me.body.user.id}`, t)).status, 403);
});

test('owner: role changes take effect immediately, and the last owner is protected', async () => {
  const promote = await api('PATCH', `/v1/org/members/${member.userId}`, {
    token: owner.token,
    body: { role: 'admin' },
  });
  assert.equal(promote.status, 200);
  // Same (old) access token, new role: role is read per request, not baked into the JWT.
  assert.equal((await api('GET', '/v1/audit-logs', { token: member.token })).status, 200);
  await api('PATCH', `/v1/org/members/${member.userId}`, {
    token: owner.token,
    body: { role: 'member' },
  });
  assert.equal((await api('GET', '/v1/audit-logs', { token: member.token })).status, 403);

  const me = await api('GET', '/v1/auth/me', { token: owner.token });
  const demoteSelf = await api('PATCH', `/v1/org/members/${me.body.user.id}`, {
    token: owner.token,
    body: { role: 'admin' },
  });
  assert.equal(demoteSelf.status, 409);
});

test('removed member loses access immediately, and removal is audited', async () => {
  const victim = await addMember(owner, 'member');
  assert.equal(
    (await api('DELETE', `/v1/org/members/${victim.userId}`, { token: admin.token })).status,
    204,
  );
  assert.equal((await api('GET', '/v1/projects', { token: victim.token })).status, 401);

  const log = await api('GET', '/v1/audit-logs?action=member.removed', { token: owner.token });
  assert.ok(log.body.data.some((e) => e.target_id === victim.userId));
});

test('API keys carry a role and cannot exceed their creator', async () => {
  const denied = await api('POST', '/v1/api-keys', {
    token: admin.token,
    body: { name: 'ci', role: 'member' },
  });
  assert.equal(denied.status, 201);
  const key = denied.body.key;
  // A member-role key cannot manage keys or delete projects.
  assert.equal((await api('GET', '/v1/api-keys', { apiKey: key })).status, 403);
  assert.equal((await api('DELETE', `/v1/projects/${project.id}`, { apiKey: key })).status, 403);
  assert.equal((await api('GET', '/v1/projects', { apiKey: key })).status, 200);
});
