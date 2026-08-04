const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { OAuth2Client } = require('google-auth-library');
const auth = require('./auth');
const { createStore } = require('./store');
const { setupConn, setPersistDir } = require('./relay');
const { createNoteStore } = require('./notestore');
const { createDbStore } = require('./dbstore');
const { createPdfStore } = require('./pdfstore');
const { createVaultFs } = require('./vaultfs');
const aiCore = require('../core/ai');

// Real verifier: validates a Google ID token against this app's client id.
// Returns { sub, email, name } on success, null on failure. Never throws.
function makeGoogleVerifier(clientId) {
  if (!clientId) return null;
  const client = new OAuth2Client(clientId);
  return async (idToken) => {
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: clientId });
      const p = ticket.getPayload();
      return (p && p.sub && p.email) ? { sub: p.sub, email: p.email, name: p.name } : null;
    } catch (_) {
      return null;
    }
  };
}

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
  const googleClientId = opts.googleClientId || process.env.GOOGLE_CLIENT_ID || '';
  const verifyGoogleToken = opts.verifyGoogleToken || makeGoogleVerifier(googleClientId);

  // Email allowlist (lock a deployment to specific accounts). Empty/unset ->
  // allow everyone so existing tests + local dev stay open. Matching is
  // case-insensitive via auth.normalizeEmail on both sides.
  const allowRaw = opts.allowedEmails || process.env.ALLOWED_EMAILS || '';
  const allowedEmails = allowRaw.split(',').map((s) => auth.normalizeEmail(s.trim())).filter(Boolean);
  const emailAllowed = (email) => allowedEmails.length === 0 || allowedEmails.includes(auth.normalizeEmail(email || ''));

  // Managed AI config (Phase 7e): the server holds the LLM key, the browser never
  // sees it. Empty provider/key = "not configured" -> /ai/chat returns 501.
  const aiProvider = opts.aiProvider || process.env.MANAGED_AI_PROVIDER || '';
  const aiKey = opts.aiKey || process.env.MANAGED_AI_KEY || '';
  const aiModel = opts.aiModel || process.env.MANAGED_AI_MODEL || (aiProvider === 'anthropic' ? 'claude-opus-4-8' : 'glm-5.2');

  // Streaming chat over the configured provider. INJECTABLE via opts.streamChat so
  // tests run without a real LLM/key. Yields text deltas; returns early if unset.
  // creds = { provider, key, model } (client-provided wins over managed defaults).
  const streamChat = opts.streamChat || (async function* (prompt, creds) {
    const { provider, key, model } = creds || {};
    if (!provider || !key) return;
    const req = aiCore.buildApiRequest(provider, model, prompt, key);
    if (!req) return;
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/^data:\s?(.*)$/); if (!m) continue;
        const delta = aiCore.parseSseDelta(provider, m[1]);
        if (delta) yield delta;
      }
    }
  });

  const app = express();
  app.locals.secret = secret;
  app.locals.notes = createNoteStore(path.join(dataDir, 'vaults'));
  app.locals.dbs = createDbStore(path.join(dataDir, 'vaults'));
  app.use(express.json());

  // Static serving for the web entry (Phase 7d-3a). Only the dirs the page needs.
  const ROOT = path.join(__dirname, '..');
  // Per-boot asset version: changes every server restart (every deploy) so the
  // ?v= query on each local asset URL flips and browsers fetch fresh; stable
  // between restarts so unchanged assets stay cached at the edge.
  const assetVersion = Date.now().toString(36);
  // ponytail: single-user app — prefer correctness over caching. Cloudflare
  // honors origin Cache-Control, so set no-cache on every static + the HTML
  // so deploys always serve fresh. Drop these headers to re-enable edge caching.
  const noCache = (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); };
  app.use('/core', express.static(path.join(ROOT, 'core'), { setHeaders: noCache }));
  app.use('/renderer', express.static(path.join(ROOT, 'renderer'), { setHeaders: noCache }));
  app.use('/web', express.static(path.join(ROOT, 'web'), { setHeaders: noCache }));
  // /vendor -> renderer/vendor : the shared renderer/pdf.js sets pdf.js workerSrc to the RELATIVE
  // 'vendor/pdfjs/pdf.worker.min.js', which on the web (root page) resolves to /vendor/... — serve it here so
  // the PDF viewer's worker loads. (Desktop is unaffected; it resolves the same relative path off file://.)
  app.use('/vendor', express.static(path.join(ROOT, 'renderer', 'vendor'), { setHeaders: noCache }));
  app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    let html;
    try { html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8'); }
    catch (_) { return res.status(500).end(); }
    res.type('html').send(html.replace(/__ASSET_VERSION__/g, assetVersion));
  });

  // POST /auth/signup {email,password}
  app.post('/auth/signup', (req, res) => {
    const { email, password } = req.body || {};
    const v = auth.validateCredentials(email, password);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (!emailAllowed(email)) return res.status(403).json({ error: 'not_allowed' });
    const em = auth.normalizeEmail(email);
    if (store.findByEmail(em)) return res.status(409).json({ error: 'email exists' });
    const user = store.create({ email: em, passwordHash: auth.hashPassword(password) });
    const token = auth.signToken({ sub: user.id, email: em }, secret);
    return res.json({ token, email: em });
  });

  // POST /auth/login {email,password}
  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (!emailAllowed(email)) return res.status(403).json({ error: 'not_allowed' });
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

  // POST /auth/google { idToken } -> verifies a Google ID token via the configured
  // (or injected) verifier, find-or-create-and-links the user, issues OUR JWT.
  app.post('/auth/google', async (req, res) => {
    if (!verifyGoogleToken) return res.status(501).json({ error: 'google login not configured' });
    const { idToken } = req.body || {};
    const g = await verifyGoogleToken(idToken);
    if (!g || !g.email) return res.status(401).json({ error: 'invalid google token' });
    if (!emailAllowed(g.email)) return res.status(403).json({ error: 'not_allowed' });
    const user = store.findOrCreateGoogle(g.sub, auth.normalizeEmail(g.email));
    const token = auth.signToken({ sub: user.id, email: user.email }, secret);
    return res.json({ token, email: user.email });
  });

  // GET /auth/config -> { googleClientId }. PUBLIC — the web frontend needs the
  // client id to render the Google button; empty string means "not available".
  app.get('/auth/config', (req, res) => {
    res.json({ googleClientId });
  });

  const notes = app.locals.notes;
  const dbs = app.locals.dbs;
  const pdfs = createPdfStore(path.join(dataDir, 'vaults'));
  const vfs = createVaultFs(path.join(dataDir, 'vaults'));

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

  // DELETE /notes?name=<n> -> { ok }. SOFT delete: moves the note into .trash
  // (vfs.noteTrash) instead of hard-unlinking, mirroring Electron note:delete.
  app.delete('/notes', requireAuth, (req, res) => {
    const r = vfs.noteTrash(req.user.sub, req.query.name);
    res.json({ ok: r.ok === true });
  });

  // ---- folders (per-user cloud folder storage; mirrors Electron folder:*) ----
  // GET /folders -> { folders: [...] } (all dirs under userDir, including empty)
  app.get('/folders', requireAuth, (req, res) => {
    res.json({ folders: vfs.folderList(req.user.sub) });
  });

  // POST /folders { path } -> { name } | { error }
  app.post('/folders', requireAuth, (req, res) => {
    const r = vfs.folderCreate(req.user.sub, (req.body || {}).path);
    res.status(r.error ? 400 : 200).json(r);
  });

  // POST /folders/rename { from, to } -> { name } | { error }
  app.post('/folders/rename', requireAuth, (req, res) => {
    const r = vfs.folderRename(req.user.sub, (req.body || {}).from, (req.body || {}).to);
    res.status(r.error ? 400 : 200).json(r);
  });

  // DELETE /folders?path=<rel> -> { ok:true } | { error }  (moves folder to trash)
  app.delete('/folders', requireAuth, (req, res) => {
    res.json(vfs.folderDelete(req.user.sub, req.query.path));
  });

  // ---- trash (per-user cloud trash; mirrors Electron trash:*) ----
  // GET /trash -> { trash: [...] } sorted by deletedAt DESC
  app.get('/trash', requireAuth, (req, res) => {
    res.json({ trash: vfs.trashList(req.user.sub) });
  });

  // POST /trash/restore { id } -> { ok:true } | { error }
  app.post('/trash/restore', requireAuth, (req, res) => {
    res.json(vfs.trashRestore(req.user.sub, (req.body || {}).id));
  });

  // POST /trash/deleteForever { id } -> { ok:true }
  app.post('/trash/deleteForever', requireAuth, (req, res) => {
    res.json(vfs.trashDeleteForever(req.user.sub, (req.body || {}).id));
  });

  // POST /trash/empty -> { ok:true }
  app.post('/trash/empty', requireAuth, (req, res) => {
    res.json(vfs.trashEmpty(req.user.sub));
  });

  // ---- databases (per-user cloud DB storage, JSON blobs) ----
  // GET /dbs -> { dbs: [{ id, name, icon, cols, rows }] } (sorted by name)
  app.get('/dbs', requireAuth, (req, res) => {
    res.json({ dbs: dbs.list(req.user.sub) });
  });

  // GET /dbs/one?id=<id> -> { db: fullDB|null }
  app.get('/dbs/one', requireAuth, (req, res) => {
    res.json({ db: dbs.read(req.user.sub, req.query.id) });
  });

  // PUT /dbs { db } -> { ok }
  app.put('/dbs', requireAuth, (req, res) => {
    const db = (req.body || {}).db;
    const ok = dbs.write(req.user.sub, db);
    return res.status(ok ? 200 : 400).json({ ok });
  });

  // DELETE /dbs?id=<id> -> { ok }
  app.delete('/dbs', requireAuth, (req, res) => {
    res.json({ ok: dbs.remove(req.user.sub, req.query.id) });
  });

  // ---- pdfs (per-user cloud PDF binary + annot storage) ----
  // GET /pdfs -> { pdfs: [...] } (sorted filenames, excludes *.annot.json sidecars)
  app.get('/pdfs', requireAuth, (req, res) => {
    res.json({ pdfs: pdfs.list(req.user.sub) });
  });

  // POST /pdfs/upload?name=<file> -> { name }. RAW octet-stream body (NOT json) so
  // the binary bytes flow straight through; express.raw sits in front of requireAuth.
  app.post('/pdfs/upload', requireAuth, express.raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
    const name = req.query.name;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'empty' });
    const saved = pdfs.write(req.user.sub, name, buf);
    if (!saved) return res.status(400).json({ error: 'invalid' });
    res.json({ name: saved });
  });

  // GET /pdfs/read?name=<file> -> raw PDF bytes (application/pdf); 404 on miss.
  app.get('/pdfs/read', requireAuth, (req, res) => {
    const buf = pdfs.read(req.user.sub, req.query.name);
    if (!buf) return res.status(404).end();
    res.setHeader('content-type', 'application/pdf');
    res.end(buf);
  });

  // POST /pdfs/rename { from, to } -> { name } | { error }
  app.post('/pdfs/rename', requireAuth, (req, res) => {
    const { from, to } = req.body || {};
    res.json(pdfs.rename(req.user.sub, from, to));
  });

  // GET /pdfs/annots?name=<file> -> { highlights:[...] } (default empty)
  app.get('/pdfs/annots', requireAuth, (req, res) => {
    res.json(pdfs.readAnnots(req.user.sub, req.query.name));
  });

  // PUT /pdfs/annots { name, data } -> { ok }
  app.put('/pdfs/annots', requireAuth, (req, res) => {
    const { name, data } = req.body || {};
    res.json({ ok: pdfs.saveAnnots(req.user.sub, name, data) });
  });

  // POST /ai/chat (authed, streaming). Client may send its own {provider,key,model};
  // those WIN over the server's managed config when present, else managed is used.
  // 501 only when neither an injected streamChat nor any provider/key is available.
  app.post('/ai/chat', requireAuth, async (req, res) => {
    const b = req.body || {};
    const prompt = b.prompt || '';
    const provider = b.provider || aiProvider;
    const key = b.key || aiKey;
    const model = b.model || aiModel;
    if (!opts.streamChat && (!provider || !key)) return res.status(501).json({ error: 'no AI configured' });
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    try {
      for await (const delta of streamChat(prompt, { provider, key, model })) res.write(delta);
      res.end();
    } catch (_) { try { res.end(); } catch (__) {} }
  });

  // GET /ai/config -> { available }. PUBLIC (mirrors /auth/config) so the web UI
  // can decide whether to surface AI controls without an auth round-trip.
  app.get('/ai/config', (req, res) => {
    res.json({ available: !!(opts.streamChat || (aiProvider && aiKey)) });
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

  return { server, wss, port: realPort, secret, googleClientId, close };
}

module.exports = { startServer };

if (require.main === module) {
  startServer()
    .then((s) => console.log('[server] http+ws on http://127.0.0.1:' + s.port))
    .catch((e) => { console.error(e); process.exit(1); });
}
