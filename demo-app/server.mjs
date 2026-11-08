// A tiny demo app so HumanTest has something real to test:
// a signup page, a welcome page, an admin users page and a JSON API.
// It keeps everything in memory. /api/test/* endpoints exist only so tests can reset/seed data.
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';

const PORT = Number(process.env.PORT || 4321);
const ADMIN = { email: 'admin@site.com', password: 'admin123', name: 'Admin', role: 'admin' };

let users = [];
let nextId = 1;
const sessions = new Map(); // sid -> { email, role }

const nameFromEmail = (email) => {
  const local = email.split('@')[0].split(/[^a-zA-Z]+/)[0] || 'friend';
  return local[0].toUpperCase() + local.slice(1).toLowerCase();
};

function createUser(email, password) {
  const user = {
    id: nextId++, email, name: nameFromEmail(email), password, role: 'customer', createdAt: new Date().toISOString(),
    verified: false, code: String(crypto.randomInt(100000, 1000000)),
  };
  users.push(user);
  return user;
}

const publicUser = ({ password, code, ...rest }) => rest;

// ---------- email ----------
// With SMTP_PORT set, signing up sends a "Verify your email" message (a code and a link) to an
// SMTP server on localhost, like the HumanTest mailbox. Without it, nothing is sent.
const SMTP_PORT = Number(process.env.SMTP_PORT || 0);

function sendMail(to, subject, html) {
  if (!SMTP_PORT) return Promise.resolve();
  const body = [
    'From: "Demo Shop" <hello@demo-shop.test>', `To: <${to}>`, `Subject: ${subject}`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    // Quoted-printable, the way mail libraries send HTML: "=" is written =3D and long lines are cut.
    html.replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\r\n'),
  ].join('\r\n');
  const script = ['EHLO demo-shop', 'MAIL FROM:<hello@demo-shop.test>', `RCPT TO:<${to}>`, 'DATA', `${body}\r\n.`, 'QUIT'];
  return new Promise((resolve) => {
    const sock = net.connect(SMTP_PORT, '127.0.0.1');
    let step = 0;
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      // One line per reply, except EHLO's "250-…" lines: wait for its last one ("250 …").
      while (/\r\n/.test(buf)) {
        const line = buf.slice(0, buf.indexOf('\r\n'));
        buf = buf.slice(buf.indexOf('\r\n') + 2);
        if (/^\d{3}-/.test(line)) continue;
        if (step < script.length) sock.write(`${script[step++]}\r\n`);
      }
    });
    sock.on('close', resolve);
    sock.on('error', (e) => { console.error('Sending email failed:', e.message); resolve(); });
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(layout(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function session(req) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  return sid ? sessions.get(sid) : undefined;
}

function startSession(res, email, role) {
  const sid = crypto.randomUUID();
  sessions.set(sid, { email, role });
  return { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    // ---------- pages ----------
    case 'GET /':
      res.writeHead(302, { location: '/signup' });
      return res.end();
    case 'GET /signup':
      return html(res, signupPage);
    case 'GET /welcome':
      return html(res, welcomePage);
    case 'GET /admin/users':
      return html(res, adminUsersPage);

    // ---------- API ----------
    case 'POST /api/users': {
      const { email = '', password = '' } = await readJson(req);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Please enter a valid email' });
      if (password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters' });
      if (users.some((u) => u.email === email)) return json(res, 409, { error: 'Email already registered' });
      const user = createUser(email, password);
      const link = `http://${req.headers.host}/verify?email=${encodeURIComponent(email)}&code=${user.code}`;
      // Sent after the reply, like a mail queue would.
      setTimeout(() => sendMail(email, 'Verify your email', `<h2>Welcome to Demo Shop, ${user.name}!</h2>
<p>Your code is <b>${user.code}</b>. It works for 15 minutes.</p>
<p><a href="${link}" style="color: #7c3aed">Verify my email</a></p>
<p style="font-size: 12px">Didn't sign up? Ignore this email.</p>`), 50);
      return json(res, 201, publicUser(user), startSession(res, user.email, user.role));
    }
    case 'GET /verify':
      return html(res, verifyPage);
    case 'POST /api/verify': {
      const { email = '', code = '' } = await readJson(req);
      const user = users.find((u) => u.email === email);
      if (!user || user.code !== String(code).trim()) return json(res, 400, { error: 'That code is wrong' });
      user.verified = true;
      return json(res, 200, publicUser(user));
    }
    case 'POST /api/login': {
      const { email, password } = await readJson(req);
      const found = email === ADMIN.email && password === ADMIN.password
        ? ADMIN
        : users.find((u) => u.email === email && u.password === password);
      if (!found) return json(res, 401, { error: 'Wrong email or password' });
      return json(res, 200, { email: found.email, role: found.role }, startSession(res, found.email, found.role));
    }
    case 'GET /api/me': {
      const s = session(req);
      const user = s && (s.role === 'admin' ? ADMIN : users.find((u) => u.email === s.email));
      return user ? json(res, 200, publicUser(user)) : json(res, 401, { error: 'Not logged in' });
    }
    case 'GET /api/notifications':
      // Intentional bug for the demo: this endpoint is broken, but the UI silently ignores it.
      // A normal E2E test would never notice. HumanTest's watchdog will.
      return json(res, 500, { error: 'notifications service crashed' });
    case 'GET /api/admin/users': {
      const s = session(req);
      if (!s) return json(res, 401, { error: 'Not logged in' });
      if (s.role !== 'admin') return json(res, 403, { error: 'Admins only' });
      return json(res, 200, { total: users.length, users: users.map(publicUser) });
    }

    // ---------- test helpers ----------
    case 'POST /api/test/reset':
      users = [];
      nextId = 1;
      sessions.clear();
      return json(res, 204);
    case 'POST /api/test/seed': {
      const { users: list = [] } = await readJson(req);
      for (const u of list) createUser(u.email, u.password ?? 'Secret123');
      return json(res, 201, { created: list.length });
    }
  }

  // DELETE /api/admin/users/:id (admins only)
  const del = /^DELETE \/api\/admin\/users\/(\d+)$/.exec(route);
  if (del) {
    const s = session(req);
    if (!s) return json(res, 401, { error: 'Not logged in' });
    if (s.role !== 'admin') return json(res, 403, { error: 'Admins only' });
    const before = users.length;
    users = users.filter((u) => u.id !== Number(del[1]));
    return users.length < before ? json(res, 200, { deleted: Number(del[1]) }) : json(res, 404, { error: 'No such user' });
  }

  json(res, 404, { error: `Nothing at ${route}` });
});

server.listen(PORT, () => console.log(`Demo app running at http://localhost:${PORT}`));

// ---------------- HTML ----------------

function layout(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Demo Shop</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; background: #f4f5f7; margin: 0; color: #1f2937; }
  header { background: #111827; color: #fff; padding: 12px 24px; font-weight: 700; }
  main { max-width: 560px; margin: 40px auto; background: #fff; padding: 28px 32px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.06); }
  label { display: block; margin-top: 14px; font-weight: 600; }
  input { width: 100%; box-sizing: border-box; padding: 10px; margin-top: 4px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 16px; }
  button { margin-top: 20px; padding: 10px 20px; border: 0; border-radius: 8px; background: #2563eb; color: #fff; font-size: 16px; cursor: pointer; }
  button:disabled { background: #94a3b8; cursor: wait; }
  #msg { color: #b91c1c; min-height: 1.5em; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  td, th { text-align: left; padding: 8px; border-bottom: 1px solid #e5e7eb; }
  .stat { font-size: 22px; font-weight: 700; }
</style></head><body><header>Demo Shop</header><main>${body}</main></body></html>`;
}

const signupPage = `
<h1>Create your account</h1>
<form id="form" novalidate>
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="off">
  <label for="password">Password</label>
  <input id="password" type="password">
  <button id="submit" type="submit">Sign up</button>
  <p id="msg" role="alert"></p>
</form>
<script>
  const $ = (id) => document.getElementById(id);
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('msg').textContent = '';
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) { $('msg').textContent = 'Please enter a valid email'; return; }
    $('submit').disabled = true;
    try {
      const r = await fetch('/api/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (r.status === 201) { location.href = '/welcome'; return; }
      if (r.status === 409) $('msg').textContent = 'This email is already registered';
      else if (r.status === 400) $('msg').textContent = (await r.json()).error;
      else $('msg').textContent = 'Something went wrong, please try again';
    } catch {
      $('msg').textContent = 'Something went wrong, please try again';
    }
    $('submit').disabled = false;
  });
</script>`;

const verifyPage = `
<h1>Verify your email</h1>
<form id="form" novalidate>
  <label for="code">Code</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code">
  <button type="submit">Verify</button>
  <p id="msg" role="alert"></p>
</form>
<script>
  const q = new URLSearchParams(location.search);
  const send = async (code) => {
    const r = await fetch('/api/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: q.get('email'), code }) });
    document.getElementById('msg').textContent = r.ok ? 'Your email is verified' : (await r.json()).error;
  };
  document.getElementById('form').addEventListener('submit', (e) => { e.preventDefault(); send(document.getElementById('code').value); });
  // The link in the email carries the code, so opening it is enough.
  if (q.get('code')) send(q.get('code'));
</script>`;

const welcomePage = `
<h1 id="hello">Loading…</h1>
<p id="orders"></p>
<script>
  (async () => {
    const r = await fetch('/api/me');
    if (r.status === 401) { location.href = '/signup'; return; }
    const me = await r.json();
    document.getElementById('hello').textContent = 'Welcome, ' + me.name;
    document.getElementById('orders').textContent = 'You have no orders yet';
    // Silently ignores failures, which hides the backend bug from the user.
    fetch('/api/notifications').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  })();
</script>`;

const adminUsersPage = `
<h1>Users</h1>
<div id="content">Loading…</div>
<script>
  (async () => {
    const r = await fetch('/api/admin/users');
    const box = document.getElementById('content');
    if (r.status === 401 || r.status === 403) { box.textContent = 'Access denied'; return; }
    const data = await r.json();
    box.innerHTML = '<p class="stat">Total users: ' + data.total + '</p>' +
      (data.users.length === 0
        ? '<p>No users yet</p>'
        : '<table><tr><th>Email</th><th>Name</th><th>Role</th></tr>' +
          data.users.map((u) => '<tr><td>' + u.email + '</td><td>' + u.name + '</td><td>' + u.role + '</td></tr>').join('') +
          '</table>');
  })();
</script>`;
