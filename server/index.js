const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { createStore } = require('./store');
const { setupConn, setPersistDir } = require('./relay');
const { createNoteStore } = require('./notestore');

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const p = auth.verifyToken(token, req.app.locals.secret);
  if (!p) return res.status(401).json({ error: 'unauthorized' });
  req.user = p;
  next();
}

async function startServer(opts = {}) {
  const port = opts.port != null ? opts.port : (Number(process.env.PORT) || 4321);
  const secret = opts.secret || process.env.AUTH_SECRET || 'dev-insecure-secret-change-me';
  if (secret === 'dev-insecure-secret-change-me') {
    console.warn('[server] WARNING: using insecure default AUTH_SECRET — set AUTH_SECRET for anything but local dev.');
  }
  const dataDir = opts.dataDir || path.join(__dirname, '..', '.server-data');
  setPersistDir(path.join(dataDir, 'rooms'));
  const store = createStore(path.join(dataDir, 'users.json'));

  const app = express();
  app.locals.secret = secret;
  app.locals.notes = createNoteStore(path.join(dataDir, 'vaults'));
  app.use(express.json());

  // Static serving for the web entry (Phase 7d-3a). Only the dirs the page needs.
  const ROOT = path.join(__dirname, '..');
  app.use('/core', express.static(path.join(ROOT, 'core')));
  app.use('/renderer', express.static(path.join(ROOT, 'renderer')));
  app.use('/web', express.static(path.join(ROOT, 'web')));
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'web', 'index.html')));

  // POST /auth/signup {email,password}
  app.post('/auth/signup', (req, res) => {
    const { email, password } = req.body || {};
    const v = auth.validateCredentials(email, password);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const em = auth.normalizeEmail(email);
    if (store.findByEmail(em)) return res.status(409).json({ error: 'email exists' });
    const user = store.create({ email: em, passwordHash: auth.hashPassword(password) });
    const token = auth.signToken({ sub: user.id, email: em }, secret);
    return res.json({ token, email: em });
  });

  // POST /auth/login {email,password}
  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const em = auth.normalizeEmail(email);
    const user = store.findByEmail(em);
    if (!user || !auth.verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    const token = auth.signToken({ sub: user.id, email: em }, secret);
    return res.json({ token, email: em });
  });

  // GET /auth/me  (Authorization: Bearer <token>)
  app.get('/auth/me', (req, res) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = auth.verifyToken(token, secret);
    if (!payload) return res.status(401).json({ error: 'unauthorized' });
    return res.json({ email: payload.email, sub: payload.sub });
  });

  const notes = app.locals.notes;

  // GET /notes -> { notes: [...] }  (authed)
  app.get('/notes', requireAuth, (req, res) => {
    res.json({ notes: notes.list(req.user.sub) });
  });

  // GET /notes/content?name=<n> -> { name, content }
  app.get('/notes/content', requireAuth, (req, res) => {
    const name = req.query.name;
    res.json({ name, content: notes.read(req.user.sub, name) });
  });

  // PUT /notes { name, content } -> { ok }
  app.put('/notes', requireAuth, (req, res) => {
    const { name, content } = req.body || {};
    const ok = notes.write(req.user.sub, name, String(content || ''));
    return res.status(ok ? 200 : 400).json({ ok });
  });

  // DELETE /notes?name=<n> -> { ok }
  app.delete('/notes', requireAuth, (req, res) => {
    const name = req.query.name;
    const ok = notes.remove(req.user.sub, name);
    res.json({ ok });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // JWT-gated WS upgrade: a valid token in ?token= is required to join any room.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const payload = auth.verifyToken(token, secret);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (conn) => setupConn(conn, req));
  });

  await new Promise((res) => server.listen(port, res));
  const realPort = server.address().port;

  const close = () => new Promise((res) => {
    for (const c of wss.clients) { try { c.terminate(); } catch (_) {} }
    wss.close(() => server.close(res));
  });

  return { server, wss, port: realPort, secret, close };
}

module.exports = { startServer };

if (require.main === module) {
  startServer()
    .then((s) => console.log('[server] http+ws on http://127.0.0.1:' + s.port))
    .catch((e) => { console.error(e); process.exit(1); });
}
