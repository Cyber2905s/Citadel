// Citadel admin UI: plain ES modules, no build step. Talks to the API same-origin via nginx.

const $ = (sel) => document.querySelector(sel);

/** Tiny DOM builder; always uses textContent so API data can never inject HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'className') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}

function toast(message, isError = false) {
  const el = h('div', { className: isError ? 'err' : '' }, message);
  $('#log').append(el);
  setTimeout(() => el.remove(), 5000);
}

// --- sessions: several logged-in identities, so two orgs can be compared side by side ---

const store = {
  get sessions() {
    try {
      return JSON.parse(localStorage.getItem('citadel.sessions')) ?? [];
    } catch {
      return [];
    }
  },
  set sessions(v) {
    try {
      localStorage.setItem('citadel.sessions', JSON.stringify(v));
    } catch {
      /* private mode: sessions live only in memory for this page */
    }
    memory = v;
  },
  get active() {
    try {
      return Number(localStorage.getItem('citadel.active') ?? 0);
    } catch {
      return 0;
    }
  },
  set active(i) {
    try {
      localStorage.setItem('citadel.active', String(i));
    } catch {
      /* ignore */
    }
  },
};
let memory = store.sessions;
const sessions = () => memory;
const current = () => sessions()[store.active];

function saveSession(s) {
  const tenant = s.tenants.find((t) => t.tenant_id === s.tenantId);
  const entry = {
    label: `${s.email} @ ${tenant?.name ?? '?'} (${tenant?.role ?? '?'})`,
    email: s.email,
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    tenantId: s.tenantId,
    tenants: s.tenants,
  };
  const list = sessions().filter(
    (x) => !(x.email === entry.email && x.tenantId === entry.tenantId),
  );
  list.push(entry);
  store.sessions = list;
  store.active = list.length - 1;
}

// --- API client with transparent refresh-token rotation ---

async function api(method, path, body, { quiet = false, session = current() } = {}) {
  const send = () =>
    fetch(`/v1${path}`, {
      method,
      headers: {
        ...(body && { 'content-type': 'application/json' }),
        ...(session && { authorization: `Bearer ${session.accessToken}` }),
      },
      body: body && JSON.stringify(body),
    });
  let res = await send();
  if (res.status === 401 && session?.refreshToken && !path.startsWith('/auth/')) {
    const r = await fetch('/v1/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (r.ok) {
      Object.assign(session, await r.json());
      store.sessions = sessions();
      res = await send();
    }
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok && !quiet) toast(`${res.status}: ${data?.message ?? res.statusText}`, true);
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

// --- header / session switching ---

function renderHeader() {
  const sel = $('#session-select');
  sel.replaceChildren(...sessions().map((s, i) => h('option', { value: i }, s.label)));
  sel.value = String(store.active);
  const s = current();
  const orgSel = $('#org-select');
  $('#org-switch-wrap').hidden = !s || s.tenants.length < 2;
  if (s) {
    orgSel.replaceChildren(
      ...s.tenants.map((t) => h('option', { value: t.tenant_id }, `${t.name} (${t.role})`)),
    );
    orgSel.value = s.tenantId;
  }
  $('#auth').hidden = !!s;
  $('#app').hidden = !s;
  $('#logout').hidden = !s;
}

$('#session-select').addEventListener('change', (e) => {
  store.active = Number(e.target.value);
  boot();
});

$('#org-select').addEventListener('change', async (e) => {
  const s = current();
  const r = await api('POST', '/auth/switch', { tenantId: e.target.value });
  if (r.ok) {
    saveSession({ ...r.data, email: s.email });
    boot();
  }
});

$('#new-session').addEventListener('click', () => {
  $('#auth').hidden = false;
  $('#app').hidden = true;
});

$('#logout').addEventListener('click', async () => {
  const s = current();
  if (s) await api('POST', '/auth/logout', { refreshToken: s.refreshToken }, { quiet: true });
  store.sessions = sessions().filter((x) => x !== s);
  store.active = 0;
  boot();
});

const formData = (form) => Object.fromEntries(new FormData(form));

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  const r = await api('POST', '/auth/signup', body, { session: null });
  if (r.ok) {
    saveSession({ ...r.data, email: body.email });
    e.target.reset();
    toast(`Created org ${body.orgName}`);
    boot();
  }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  const r = await api('POST', '/auth/login', body, { session: null });
  if (r.ok) {
    saveSession({ ...r.data, email: body.email });
    e.target.reset();
    boot();
  }
});

$('#accept-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = formData(e.target);
  if (!body.name) delete body.name;
  const r = await api('POST', '/invitations/accept', body, { session: null });
  if (r.ok) {
    const me = await api('GET', '/auth/me', null, { session: r.data });
    saveSession({ ...r.data, email: me.data.user.email });
    history.replaceState(null, '', '/');
    toast('Invitation accepted');
    boot();
  }
});

// --- tabs ---

let activeTab = 'projects';
document.querySelectorAll('nav [data-tab]').forEach((btn) =>
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    document
      .querySelectorAll('nav [data-tab]')
      .forEach((b) => b.classList.toggle('active', b === btn));
    document
      .querySelectorAll('[data-panel]')
      .forEach((p) => (p.hidden = p.dataset.panel !== activeTab));
    loaders[activeTab]();
  }),
);

// --- projects & tasks ---

let selectedProject = null;

async function loadProjects() {
  const r = await api('GET', '/projects?limit=100');
  if (!r.ok) return;
  $('#project-list').replaceChildren(
    ...r.data.data.map((p) =>
      h(
        'li',
        { className: p.id === selectedProject ? 'selected' : '' },
        h('a', { href: '#', onclick: (e) => (e.preventDefault(), openProject(p.id)) }, p.name),
        h(
          'span',
          {},
          h(
            'button',
            {
              className: 'small',
              type: 'button',
              onclick: () =>
                navigator.clipboard.writeText(p.id).then(() => toast(`Copied ${p.id}`)),
            },
            'copy id',
          ),
          ' ',
          h(
            'button',
            {
              className: 'small danger',
              type: 'button',
              onclick: async () => {
                if ((await api('DELETE', `/projects/${p.id}`)).ok) {
                  toast('Project soft-deleted (see audit log)');
                  if (selectedProject === p.id) selectedProject = null;
                  loadProjects();
                }
              },
            },
            'delete',
          ),
        ),
      ),
    ),
  );
  if (selectedProject) openProject(selectedProject);
  else $('#project-detail').replaceChildren(h('p', { className: 'muted' }, 'Select a project.'));
}

async function openProject(id) {
  selectedProject = id;
  document.querySelectorAll('#project-list li').forEach((li) => li.classList.remove('selected'));
  const [p, tasks] = await Promise.all([
    api('GET', `/projects/${id}`),
    api('GET', `/projects/${id}/tasks?limit=100`),
  ]);
  if (!p.ok) return;
  const form = h(
    'form',
    { className: 'inline' },
    h('input', { name: 'title', placeholder: 'New task', required: '' }),
    h('button', {}, 'Add task'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if ((await api('POST', `/projects/${id}/tasks`, formData(form))).ok) openProject(id);
  });
  const statusSelect = (t) => {
    const sel = h('select', {}, ...['todo', 'doing', 'done'].map((s) => h('option', {}, s)));
    sel.value = t.status;
    sel.addEventListener('change', () => api('PATCH', `/tasks/${t.id}`, { status: sel.value }));
    return sel;
  };
  $('#project-detail').replaceChildren(
    h('h3', {}, p.data.name),
    h('p', { className: 'muted' }, p.data.description || 'No description'),
    form,
    h(
      'ul',
      { className: 'list' },
      ...tasks.data.data.map((t) =>
        h(
          'li',
          {},
          t.title,
          h(
            'span',
            {},
            statusSelect(t),
            ' ',
            h(
              'button',
              {
                className: 'small danger',
                type: 'button',
                onclick: async () => (await api('DELETE', `/tasks/${t.id}`)).ok && openProject(id),
              },
              'delete',
            ),
          ),
        ),
      ),
    ),
  );
}

$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/projects', formData(e.target));
  if (r.ok) {
    e.target.reset();
    selectedProject = r.data.id;
    loadProjects();
  }
});

// --- members & invitations ---

async function loadMembers() {
  const [members, invites] = await Promise.all([
    api('GET', '/org/members'),
    api('GET', '/org/invitations', null, { quiet: true }),
  ]);
  if (!members.ok) return;
  $('#member-rows').replaceChildren(
    ...members.data.map((m) => {
      const role = h('select', {}, ...['owner', 'admin', 'member'].map((r) => h('option', {}, r)));
      role.value = m.role;
      role.addEventListener('change', async () => {
        const r = await api('PATCH', `/org/members/${m.user_id}`, { role: role.value });
        if (r.ok) toast(`${m.email} is now ${role.value}`);
        loadMembers();
      });
      return h(
        'tr',
        {},
        h('td', {}, m.name),
        h('td', {}, m.email),
        h('td', {}, role),
        h(
          'td',
          {},
          h(
            'button',
            {
              className: 'small danger',
              type: 'button',
              onclick: async () =>
                (await api('DELETE', `/org/members/${m.user_id}`)).ok && loadMembers(),
            },
            'remove',
          ),
        ),
      );
    }),
  );
  $('#invite-list').replaceChildren(
    ...(invites.ok
      ? invites.data.map((i) =>
          h(
            'li',
            {},
            `${i.email} as ${i.role}`,
            h(
              'span',
              { className: 'muted' },
              `expires ${new Date(i.expires_at).toLocaleDateString()}`,
            ),
          ),
        )
      : [
          h(
            'li',
            { className: 'muted' },
            `Hidden: your role cannot manage invitations (${invites.status})`,
          ),
        ]),
  );
}

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/org/invitations', formData(e.target));
  if (!r.ok) return;
  e.target.reset();
  const token = r.data.acceptUrl && new URL(r.data.acceptUrl).searchParams.get('invite');
  $('#invite-result').replaceChildren(
    h(
      'p',
      {},
      'Invitation email queued (the worker logs it). Demo shortcut: open ',
      h('a', { href: r.data.acceptUrl ?? '#' }, 'the accept link'),
      ` or paste token ${token ?? '(hidden in production)'} into "Accept invitation".`,
    ),
  );
  loadMembers();
});

// --- API keys ---

async function loadKeys() {
  const r = await api('GET', '/api-keys');
  if (!r.ok)
    return $('#key-list').replaceChildren(
      h('li', { className: 'muted' }, `Forbidden for your role (${r.status})`),
    );
  $('#key-list').replaceChildren(
    ...r.data.map((k) =>
      h(
        'li',
        {},
        `${k.name} · ${k.prefix}… · ${k.role}`,
        h(
          'span',
          {},
          h(
            'span',
            { className: 'muted' },
            k.last_used_at
              ? `used ${new Date(k.last_used_at).toLocaleTimeString()} `
              : 'never used ',
          ),
          h(
            'button',
            {
              className: 'small danger',
              type: 'button',
              onclick: async () => (await api('DELETE', `/api-keys/${k.id}`)).ok && loadKeys(),
            },
            'revoke',
          ),
        ),
      ),
    ),
  );
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api-keys', formData(e.target));
  if (!r.ok) return;
  e.target.reset();
  $('#key-result').replaceChildren(
    h('p', {}, 'Copy it now; only a hash is stored:'),
    h('pre', {}, r.data.key),
    h('pre', {}, `curl -H "x-api-key: ${r.data.key}" ${location.origin}/v1/projects`),
  );
  loadKeys();
});

// --- audit log ---

let auditCursor = null;
async function loadAudit(more = false) {
  if (!more) auditCursor = null;
  const r = await api('GET', `/audit-logs?limit=25${auditCursor ? `&cursor=${auditCursor}` : ''}`);
  if (!r.ok) {
    $('#audit-rows').replaceChildren(
      h(
        'tr',
        {},
        h('td', { colspan: '4', className: 'muted' }, `Forbidden for your role (${r.status})`),
      ),
    );
    $('#audit-more').hidden = true;
    return;
  }
  const rows = r.data.data.map((a) =>
    h(
      'tr',
      {},
      h('td', {}, new Date(a.created_at).toLocaleString()),
      h('td', {}, a.actor_email ?? `${a.actor_type} ${a.actor_id?.slice(0, 8) ?? ''}`),
      h('td', {}, h('span', { className: 'pill' }, a.action)),
      h('td', {}, h('code', {}, JSON.stringify(a.metadata))),
    ),
  );
  if (more) $('#audit-rows').append(...rows);
  else $('#audit-rows').replaceChildren(...rows);
  auditCursor = r.data.nextCursor;
  $('#audit-more').hidden = !auditCursor;
}
$('#audit-more').addEventListener('click', () => loadAudit(true));

// --- plan, usage and rate-limit burst ---

async function loadUsage() {
  const r = await api('GET', '/usage');
  if (!r.ok) return;
  $('#plan-select').value = r.data.plan;
  $('#limits').textContent = JSON.stringify(r.data.limits, null, 2);
  $('#usage').textContent = JSON.stringify(
    { current: r.data.current, daily: r.data.daily },
    null,
    2,
  );
}

$('#plan-save').addEventListener('click', async () => {
  const r = await api('PATCH', '/org', { plan: $('#plan-select').value });
  if (r.ok) toast(`Plan changed to ${r.data.plan}`);
  loadUsage();
});

$('#burst').addEventListener('click', async () => {
  const n = Number($('#burst-n').value);
  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: n }, () => api('GET', '/projects?limit=1', null, { quiet: true })),
  );
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const last = results.at(-1).headers;
  $('#burst-result').textContent = JSON.stringify(
    {
      sent: n,
      statuses: counts,
      'x-ratelimit-limit': last.get('x-ratelimit-limit'),
      'x-ratelimit-remaining': last.get('x-ratelimit-remaining'),
      'retry-after': last.get('retry-after'),
      ms: Math.round(performance.now() - started),
    },
    null,
    2,
  );
  loadUsage();
});

// --- isolation probe ---

$('#probe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { id } = formData(e.target);
  const r = await api('GET', `/projects/${id}`, null, { quiet: true });
  $('#probe-result').textContent =
    `GET /v1/projects/${id}\n-> ${r.status}\n${JSON.stringify(r.data, null, 2)}`;
});

// --- boot ---

const loaders = {
  projects: loadProjects,
  members: loadMembers,
  keys: loadKeys,
  audit: loadAudit,
  usage: loadUsage,
  isolation: () => {},
};

async function boot() {
  renderHeader();
  const s = current();
  if (!s) return;
  const me = await api('GET', '/auth/me', null, { quiet: true });
  if (!me.ok) {
    toast('Session expired; please log in again', true);
    store.sessions = sessions().filter((x) => x !== s);
    store.active = 0;
    return boot();
  }
  $('#whoami').textContent = `${me.data.role} · ${me.data.plan} plan`;
  loaders[activeTab]();
}

const invite = new URLSearchParams(location.search).get('invite');
if (invite) {
  $('#accept-form').token.value = invite;
  renderHeader();
  $('#auth').hidden = false;
  $('#app').hidden = true;
} else {
  boot();
}
