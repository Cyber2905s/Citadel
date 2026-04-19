import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, signupOrg } from './helpers.js';
import { PLANS } from '../src/lib/plans.js';
import { rollupUsage } from '../src/modules/usage/service.js';
import { withTenant } from '../src/db/index.js';

let noisy, quiet;

before(async () => {
  // Fixed one-minute windows: don't start a burst right before a window flips.
  const secondsLeft = 60 - (Date.now() / 1000) % 60;
  if (secondsLeft < 15) await sleep(secondsLeft * 1000 + 100);
  noisy = await signupOrg('Noisy');
  quiet = await signupOrg('Quiet');
});

test('free plan tenant is limited per minute; other tenants are unaffected', async () => {
  const limit = PLANS.free.requestsPerMinute;
  const statuses = [];
  for (let i = 0; i < limit + 5; i++) {
    statuses.push((await api('GET', '/v1/projects', { token: noisy.token })).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, limit);
  assert.equal(statuses.filter((s) => s === 429).length, 5);

  const blocked = await api('GET', '/v1/projects', { token: noisy.token });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['x-ratelimit-remaining'], '0');
  assert.ok(Number(blocked.headers['retry-after']) > 0);

  const other = await api('GET', '/v1/projects', { token: quiet.token });
  assert.equal(other.status, 200);
  assert.equal(other.headers['x-ratelimit-limit'], String(limit));
});

test('plan limits cap resources: free plan allows 3 projects', async () => {
  for (let i = 0; i < PLANS.free.maxProjects; i++) {
    const r = await api('POST', '/v1/projects', { token: quiet.token, body: { name: `p${i}` } });
    assert.equal(r.status, 201);
  }
  const over = await api('POST', '/v1/projects', { token: quiet.token, body: { name: 'one too many' } });
  assert.equal(over.status, 402);

  await api('PATCH', '/v1/org', { token: quiet.token, body: { plan: 'pro' } });
  const after = await api('POST', '/v1/projects', { token: quiet.token, body: { name: 'fits now' } });
  assert.equal(after.status, 201);
});

test('usage is metered in redis and rolled up to postgres', async () => {
  await rollupUsage();
  const { rows } = await withTenant(noisy.tenantId, (c) =>
    c.query('SELECT metric, count::int FROM usage_daily ORDER BY metric'),
  );
  const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r.count]));
  assert.ok(byMetric.api_calls >= PLANS.free.requestsPerMinute + 6);
  assert.ok(byMetric.rate_limited >= 6);
});
