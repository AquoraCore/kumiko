const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const { createStore } = require('./store');
const { setupConn } = require('./relay');

async function startServer(opts = {}) {
  const port = opts.port != null ? opts.port : (Number(process.env.PORT) || 4321);
  const secret = opts.secret || process.env.AUTH_SECRET || 'dev-insecure-secret-change-me';
  if (secret === 'dev-insecure-secret-change-me') {
    console.warn('[server] WARNING: using insecure default AUTH_SECRET — set AUTH_SECRET for anything but local dev.');
  }
  const dataDir = opts.dataDir || path.join(__dirname, '..', '.server-data');
  const store = createStore(path.join(dataDir, 'users.json'));

  const app = express();
  app.use(express.json());

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
