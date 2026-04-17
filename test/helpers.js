import { randomUUID } from 'node:crypto';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/index.js';
import { redis } from '../src/lib/redis.js';
import { emailQueue, usageQueue } from '../src/lib/queues.js';

await migrate({ log: () => {} });
export const app = await buildApp({ logger: false });

after(async () => {
  await app.close();
  await Promise.all([emailQueue.close(), usageQueue.close()]);
  await Promise.all([pool.end(), redis.quit()]);
});

// Each call looks like a different client so the per-IP auth limiter never trips tests.
const randomIp = () => `10.${[0, 0, 0].map(() => Math.floor(Math.random() * 255)).join('.')}`;

/**
 * @param {string} method @param {string} url
 * @param {{ token?: string, apiKey?: string, body?: object }} [opts]
 */
export async function api(method, url, { token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  const res = await app.inject({ method, url, headers, payload: body, remoteAddress: randomIp() });
  return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
}

export const uniqueEmail = (tag) => `${tag}-${randomUUID().slice(0, 8)}@test.dev`;

/** Signs up a fresh org; returns its owner's session. */
export async function signupOrg(name = 'Org') {
  const email = uniqueEmail(name.toLowerCase());
  const res = await api('POST', '/v1/auth/signup', {
    body: { email, password: 'password123', name: `${name} Owner`, orgName: name },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { email, token: res.body.accessToken, refreshToken: res.body.refreshToken, tenantId: res.body.tenantId };
}

/** Invites `role` into the owner's org and accepts it; returns the new member's session. */
export async function addMember(owner, role) {
  const email = uniqueEmail(role);
  const inv = await api('POST', '/v1/org/invitations', { token: owner.token, body: { email, role } });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = new URL(inv.body.acceptUrl).searchParams.get('invite');
  const res = await api('POST', '/v1/invitations/accept', {
    body: { token, password: 'password123', name: role },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const me = await api('GET', '/v1/auth/me', { token: res.body.accessToken });
  return { email, token: res.body.accessToken, userId: me.body.user.id, tenantId: res.body.tenantId };
}
