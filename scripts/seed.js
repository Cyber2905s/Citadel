// Seeds demo tenants through the public API (so it exercises the real code paths).
// Usage: API_URL=http://localhost:3000 node scripts/seed.js
const API = process.env.API_URL ?? 'http://localhost:3000';
const PASSWORD = 'password123';

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function org(orgName, owner, plan) {
  const login = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: owner.email, password: PASSWORD }),
  });
  if (login.ok) {
    console.log(`${orgName}: already seeded, skipping`);
    return null;
  }
  const s = await call('POST', '/auth/signup', {
    body: { email: owner.email, name: owner.name, password: PASSWORD, orgName },
  });
  await call('PATCH', '/org', { token: s.accessToken, body: { plan } });
  return s;
}

async function invite(owner, email, name, role) {
  const inv = await call('POST', '/org/invitations', { token: owner.accessToken, body: { email, role } });
  const token = new URL(inv.acceptUrl).searchParams.get('invite');
  return call('POST', '/invitations/accept', { body: { token, name, password: PASSWORD } });
}

async function projects(session, list) {
  for (const [name, tasks] of list) {
    const p = await call('POST', '/projects', {
      token: session.accessToken,
      body: { name, description: `${name} (seeded)` },
    });
    for (const [title, status] of tasks) {
      await call('POST', `/projects/${p.id}/tasks`, { token: session.accessToken, body: { title, status } });
    }
  }
}

const acme = await org('Acme Corp', { email: 'alice@acme.test', name: 'Alice (Acme owner)' }, 'pro');
if (acme) {
  await invite(acme, 'bob@acme.test', 'Bob (Acme admin)', 'admin');
  await invite(acme, 'carol@acme.test', 'Carol (Acme member)', 'member');
  await projects(acme, [
    ['Website relaunch', [['Design mockups', 'done'], ['Build landing page', 'doing'], ['SEO audit', 'todo']]],
    ['Q4 planning', [['Draft OKRs', 'todo'], ['Budget review', 'todo']]],
  ]);
}

const globex = await org('Globex', { email: 'dan@globex.test', name: 'Dan (Globex owner)' }, 'free');
if (globex) {
  await projects(globex, [['Secret doomsday device', [['Acquire volcano', 'doing']]]]);
  // Alice belongs to both orgs, to demo org switching.
  const inv = await call('POST', '/org/invitations', {
    token: globex.accessToken,
    body: { email: 'alice@acme.test', role: 'member' },
  });
  const token = new URL(inv.acceptUrl).searchParams.get('invite');
  await call('POST', '/invitations/accept', { body: { token, password: PASSWORD } });
}

console.log(`Seeded. Log in with any of these (password: ${PASSWORD}):
  alice@acme.test  owner of Acme (pro), member of Globex (free)
  bob@acme.test    admin of Acme
  carol@acme.test  member of Acme
  dan@globex.test  owner of Globex (free)`);
