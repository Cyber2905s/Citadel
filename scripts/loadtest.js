// Load test against a running API: authenticated, RLS-scoped, rate-limited reads
// spread across many tenants (one tenant alone would just measure the limiter).
// Usage: API_URL=http://localhost:3000 TENANTS=50 DURATION=20 node scripts/loadtest.js
import autocannon from 'autocannon';

const API = process.env.API_URL ?? 'http://localhost:3000';
const TENANTS = Number(process.env.TENANTS ?? 50);
const DURATION = Number(process.env.DURATION ?? 20);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 50);

async function post(path, body, token) {
  const res = await fetch(`${API}/v1${path}`, {
    method: path === '/org' ? 'PATCH' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

console.log(`creating ${TENANTS} enterprise tenants with 5 projects each...`);
const tokens = [];
const run = Date.now();
for (let i = 0; i < TENANTS; i++) {
  const s = await post('/auth/signup', {
    email: `load-${run}-${i}@load.test`,
    password: 'password123',
    name: 'Load',
    orgName: `Load ${i}`,
  });
  await post('/org', { plan: 'enterprise' }, s.accessToken);
  for (let p = 0; p < 5; p++) await post('/projects', { name: `p${p}` }, s.accessToken);
  tokens.push(s.accessToken);
}

function bench(title, opts) {
  return new Promise((resolve, reject) => {
    const inst = autocannon(
      { url: API, connections: CONNECTIONS, duration: DURATION, ...opts },
      (err, r) => (err ? reject(err) : resolve(r)),
    );
    autocannon.track(inst, { renderProgressBar: false, renderResultsTable: false });
  }).then((r) => {
    console.log(
      `${title}: ${r.requests.average.toFixed(0)} req/s | latency p50 ${r.latency.p50}ms p97.5 ${r.latency.p97_5}ms p99 ${r.latency.p99}ms | ${r['2xx']} 2xx, ${r.non2xx} non-2xx, ${r.errors} errors`,
    );
    return r;
  });
}

let n = 0;
await bench('GET /healthz (baseline)', { requests: [{ method: 'GET', path: '/healthz' }] });
await bench(`GET /v1/projects (${TENANTS} tenants, JWT + RLS + rate limit)`, {
  requests: [
    {
      method: 'GET',
      path: '/v1/projects',
      setupRequest: (req) => ({
        ...req,
        headers: { authorization: `Bearer ${tokens[n++ % tokens.length]}` },
      }),
    },
  ],
});
