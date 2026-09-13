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
const { createVaultReg } = require('./vaultreg');
const { createAiQuota } = require('./aiquota');
const { createRateLimiter } = require('./ratelimit');
// Real client IP behind the Cloudflare Tunnel: CF-Connecting-IP is the browser's IP;
// req.ip / the socket would just be the tunnel/localhost. Falls back for local dev.
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
}
const aiCore = require('../core/ai');
const coreEmail = require('../core/email');
const { sendEmail: sendEmailHttp } = require('./email');

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

// Reads the x-vault header, validates against the per-user registry, and falls
// back to the user's default (first) vault. Keeps existing no-header callers
// (and tests) on the default vault unchanged.
function makeVaultOf(vreg) {
  return function vaultOf(req) {
    return vreg.resolve(req.user.sub, req.get('x-vault'));
  };
}

async function startServer(opts = {}) {
  const port = opts.port != null ? opts.port : (Number(process.env.PORT) || 4321);
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', '.server-data');
  // AUTH_SECRET: opts (tests) > env > persisted <dataDir>/.auth-secret (auto-generated
  // on first boot). See auth.resolveAuthSecret — tokens survive restarts either way.
  const secret = opts.secret || auth.resolveAuthSecret(dataDir);
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

  // Email verification is OPT-IN (default OFF) so the existing single-user / locked flow is
  // unchanged. Turn it on with EMAIL_VERIFY=1 (or opts.emailVerify) when you open signup to
  // the public — new accounts then can't log in until they click the link in their email.
  const emailVerifyOn = (opts.emailVerify != null) ? !!opts.emailVerify : (process.env.EMAIL_VERIFY === '1');
  // REQUIRE_EMAIL_VERIFY (or opts.requireEmailVerify) is the code-based variant: signup
  // returns {pendingVerify:true}, the user confirms a 6-digit code via POST /auth/verify.
  // Also default OFF — no env set means today's behavior, bit for bit.
  const requireVerify = (opts.requireEmailVerify != null) ? !!opts.requireEmailVerify : (process.env.REQUIRE_EMAIL_VERIFY === '1');
  const appBaseUrl = (opts.appBaseUrl || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  // Pluggable mailer: opts.sendEmail(to, subject, text) -> Promise (tests inject here).
  // Default: server/email.js — real send with RESEND_API_KEY, dev-mode log without it.
  const hasMailer = typeof opts.sendEmail === 'function';
  const sendEmail = hasMailer ? opts.sendEmail
    : (to, subject, text) => sendEmailHttp({ to, subject, text });
  const crypto = require('crypto');
  const newVerifyToken = () => crypto.randomBytes(24).toString('hex');
  const verifyUrlFor = (req, token) => (appBaseUrl || (req.protocol + '://' + req.get('host'))) + '/auth/verify?token=' + token;

  // Injectable clock (tests drive expiry/limits without sleeping).
  const now = opts.now || (() => Date.now());
  const VERIFY_TTL_MS = 15 * 60 * 1000;
  const RESET_TTL_MS = 15 * 60 * 1000;
  const VERIFY_MAX_ATTEMPTS = 5;
  const newDigitCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const newResetToken = () => crypto.randomBytes(16).toString('hex');
  // Issue (or re-issue) a 6-digit code: bcrypt-hashed on disk, 15-minute expiry, attempts
  // reset to 0. Fire-and-forget email — auth must not fail because a mailer hiccupped.
  function issueVerifyCode(u) {
    const code = newDigitCode();
    store.update(u.id, {
      verifyCodeHash: auth.hashPassword(code),
      verifyCodeExpires: now() + VERIFY_TTL_MS,
      verifyAttempts: 0,
    });
    const m = coreEmail.verifyEmailMsg(code);
    Promise.resolve(sendEmail(u.email, m.subject, m.text)).catch(() => {});
  }

  // Resend-code limiter: tight, keyed by email (3/hour) — a code email is a spam vector.
  const resendLimiter = createRateLimiter({ max: 3, windowMs: 60 * 60 * 1000, now: opts.now });

  // Managed AI config (Phase 7e): the server holds the LLM key, the browser never
  // sees it. Empty provider/key = "not configured" -> /ai/chat returns 501.
  const aiProvider = opts.aiProvider || process.env.MANAGED_AI_PROVIDER || '';
  const aiKey = opts.aiKey || process.env.MANAGED_AI_KEY || '';
  const aiModel = opts.aiModel || process.env.MANAGED_AI_MODEL || (aiProvider === 'anthropic' ? 'claude-opus-4-8' : 'glm-5.2');
  // Per-user daily cap on MANAGED-key AI requests (the owner's cost). Default 100/day; set
  // MANAGED_AI_DAILY_LIMIT=0 (or negative) to disable. Users with their own key are exempt.
  const _dailyLimit = (opts.managedAiDailyLimit != null) ? opts.managedAiDailyLimit
    : (process.env.MANAGED_AI_DAILY_LIMIT != null && process.env.MANAGED_AI_DAILY_LIMIT !== '' ? parseInt(process.env.MANAGED_AI_DAILY_LIMIT, 10) : 100);
  const aiQuota = createAiQuota(path.join(dataDir, 'ai-quota.json'), _dailyLimit);
  // Brute-force guard on auth: N attempts per key (client IP + targeted email) per window,
  // then 429. Defaults: 10 / 15 min. Tunable via opts or LOGIN_RATE_MAX / LOGIN_RATE_WINDOW_MS.
  const loginLimiter = createRateLimiter({
    max: (opts.loginRateMax != null) ? opts.loginRateMax : (process.env.LOGIN_RATE_MAX ? parseInt(process.env.LOGIN_RATE_MAX, 10) : 10),
    windowMs: (opts.loginRateWindowMs != null) ? opts.loginRateWindowMs : (process.env.LOGIN_RATE_WINDOW_MS ? parseInt(process.env.LOGIN_RATE_WINDOW_MS, 10) : 15 * 60 * 1000),
    now: opts.now,
  });

  // Streaming chat over the configured provider. INJECTABLE via opts.streamChat so
  // tests run without a real LLM/key. Yields text deltas; returns early if unset.
  // creds = { provider, key, model } (client-provided wins over managed defaults).
  const streamChat = opts.streamChat || (async function* (prompt, creds) {
    const { provider, key, model, thinking, images } = creds || {};
    if (!provider || !key) return;
    // an image message on a text-only model → the provider's vision model (same auto-switch as desktop)
    let mdl = model;
    if (images && images.length && aiCore.modelSupportsVision && !aiCore.modelSupportsVision(provider, mdl)) {
      const vm = aiCore.visionModelFor(provider, mdl); if (vm) mdl = vm;
    }
    const req = aiCore.buildApiRequest(provider, mdl, prompt, key, { thinking: aiCore.resolveThinking(provider, mdl, thinking), images });
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
        // managed (web) stream is plain text: reasoning is DROPPED here — the web client has no
        // separate thinking channel yet, and mixing it into the answer is worse than omitting it
        const ev = aiCore.parseSseEvent(provider, m[1]);
        if (ev.text) yield ev.text;
      }
    }
  });

  const app = express();
  app.locals.secret = secret;
  app.locals.notes = createNoteStore(path.join(dataDir, 'vaults'));
  app.locals.dbs = createDbStore(path.join(dataDir, 'vaults'));
  // 25mb so crop-into-note (base64 PNG data-URIs) + large DB/annot payloads fit;
  // the express default is 100kb, which silently 413s a single cropped image.
  app.use(express.json({ limit: '25mb' }));

  // Per-user vault registry (Phase 8.2). Resolves the x-vault header to a
  // real vault id, falling back to the user's default vault.
  const vreg = createVaultReg(path.join(dataDir, 'vaults'));
  const vaultOf = makeVaultOf(vreg);

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
    // BUILD.txt is written by the deploy script (git short SHA). Missing → fall
    // back to assetVersion so the line always shows something.
    let build = '';
    try { build = fs.readFileSync(path.join(ROOT, 'BUILD.txt'), 'utf8').trim(); } catch (_) {}
    if (!build) build = assetVersion;
    // App semver from package.json (single source of truth) → shown as "v0.2.0" in settings.
    let appVer = '';
    try { appVer = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version) || ''; } catch (_) {}
    res.type('html').send(
      html.replace(/__ASSET_VERSION__/g, assetVersion).replace(/__BUILD__/g, build).replace(/__APP_VERSION__/g, appVer)
    );
  });

  // 429 helper — sets Retry-After and returns a friendly message.
  function tooMany(res, worstMs) {
    const s = Math.ceil(Math.max(0, worstMs) / 1000);
    res.set('Retry-After', String(s));
    return res.status(429).json({ error: 'พยายามบ่อยเกินไป — ลองใหม่ในอีก ' + s + ' วินาที', retryAfter: s });
  }

  // POST /auth/signup {email,password}
  app.post('/auth/signup', (req, res) => {
    const ipKey = 'signup:ip:' + clientIp(req);
    const c = loginLimiter.check(ipKey);
    if (c.limited) return tooMany(res, c.retryAfterMs);
    const { email, password } = req.body || {};
    const v = auth.validateCredentials(email, password);
    if (!v.ok) { loginLimiter.hit(ipKey); return res.status(400).json({ error: v.error }); }
    if (!emailAllowed(email)) { loginLimiter.hit(ipKey); return res.status(403).json({ error: 'not_allowed' }); }
    const em = auth.normalizeEmail(email);
    if (store.findByEmail(em)) return res.status(409).json({ error: 'email exists' });
    // When REQUIRE_EMAIL_VERIFY is on: create UNVERIFIED (plan 'free' comes with every new
    // user), email a 6-digit code, and hold the JWT until POST /auth/verify succeeds.
    if (requireVerify) {
      const user = store.create({ email: em, passwordHash: auth.hashPassword(password), verified: false });
      issueVerifyCode(user);
      return res.json({ email: em, pendingVerify: true });
    }
    // When verification is ON: create UNVERIFIED with a one-time token, email the link, and
    // do NOT hand back a session — the user logs in after verifying. When OFF (locked/trusted
    // deployment): create verified and return a token immediately, as before.
    if (emailVerifyOn) {
      const vtok = newVerifyToken();
      store.create({ email: em, passwordHash: auth.hashPassword(password), verified: false, verifyToken: vtok });
      const url = verifyUrlFor(req, vtok);
      Promise.resolve(sendEmail(em, 'ยืนยันอีเมลสำหรับ Kumiko', 'คลิกเพื่อยืนยันอีเมล: ' + url)).catch(() => {});
      return res.json({ email: em, verifyRequired: true });
    }
    const user = store.create({ email: em, passwordHash: auth.hashPassword(password), verified: true });
    const token = auth.signToken({ sub: user.id, email: em }, secret);
    return res.json({ token, email: em });
  });

  // GET /auth/verify?token=... — confirm an email. Returns a tiny HTML page (this is a link
  // click in a browser). Unknown/used token → a friendly failure, never a stack trace.
  app.get('/auth/verify', (req, res) => {
    const u = store.findByVerifyToken((req.query || {}).token);
    const page = (ok, msg) => res.status(ok ? 200 : 400).type('html').send(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<div style="font:16px/1.6 system-ui;max-width:420px;margin:14vh auto;padding:0 20px;text-align:center">' +
      '<div style="font-size:40px">' + (ok ? '✓' : '⚠️') + '</div><h2 style="margin:.3em 0">' + (ok ? 'ยืนยันอีเมลแล้ว' : 'ยืนยันไม่สำเร็จ') + '</h2>' +
      '<p style="color:#666">' + msg + '</p><p><a href="/" style="color:#3a56c5">ไปที่ Kumiko เพื่อเข้าสู่ระบบ</a></p></div>');
    if (!u) return page(false, 'ลิงก์ไม่ถูกต้องหรือถูกใช้ไปแล้ว');
    store.markVerified(u.id);
    return page(true, 'บัญชี ' + u.email + ' พร้อมใช้งานแล้ว เข้าสู่ระบบได้เลย');
  });

  // POST /auth/verify {email, code} — the code-based flow (REQUIRE_EMAIL_VERIFY). Correct +
  // unexpired code → verified:true + a JWT right here (no second login round-trip). Wrong →
  // 401 and the attempt count climbs; past 5 the code is dead and only a resend saves it.
  app.post('/auth/verify', (req, res) => {
    const { email, code } = req.body || {};
    const u = store.findByEmail(auth.normalizeEmail(email || ''));
    if (!u || u.verified === true || !u.verifyCodeHash) return res.status(401).json({ error: 'invalid code', pendingVerify: true });
    if ((u.verifyAttempts || 0) >= VERIFY_MAX_ATTEMPTS) return res.status(401).json({ error: 'too many attempts — request a new code', pendingVerify: true });
    if (now() > (u.verifyCodeExpires || 0)) {
      store.update(u.id, { verifyCodeHash: null, verifyCodeExpires: null });   // dead code, don't let it revive
      return res.status(401).json({ error: 'code expired — request a new code', pendingVerify: true });
    }
    if (!auth.verifyPassword(String(code || ''), u.verifyCodeHash)) {
      store.update(u.id, { verifyAttempts: (u.verifyAttempts || 0) + 1 });
      return res.status(401).json({ error: 'invalid code', pendingVerify: true });
    }
    store.markVerified(u.id);
    const token = auth.signToken({ sub: u.id, email: u.email }, secret);
    return res.json({ token, email: u.email, plan: u.plan || 'free' });
  });

  // POST /auth/resend-code {email} — always {ok:true} (never reveal whether the account
  // exists); a real unverified user gets a fresh code. Tight per-email limit: 3/hour.
  app.post('/auth/resend-code', (req, res) => {
    const em = auth.normalizeEmail((req.body || {}).email || '');
    const key = 'resend:' + (em || 'blank');
    const c = resendLimiter.check(key);
    if (c.limited) return tooMany(res, c.retryAfterMs);
    resendLimiter.hit(key);
    const u = em ? store.findByEmail(em) : null;
    if (u && u.verified === false) issueVerifyCode(u);
    return res.json({ ok: true });
  });

  // POST /auth/forgot {email} — 200 no matter what (account enumeration stays impossible).
  // For a real account: 32-hex one-time token (bcrypt-hashed at rest, 15 min), emailed as a
  // link + raw token. Works in dev-mode too — the "email" lands in the server log.
  app.post('/auth/forgot', (req, res) => {
    const ipKey = 'forgot:ip:' + clientIp(req);
    const c = loginLimiter.check(ipKey);
    if (c.limited) return tooMany(res, c.retryAfterMs);
    loginLimiter.hit(ipKey);   // every call counts — unauthenticated mail-spam vector
    const em = auth.normalizeEmail((req.body || {}).email || '');
    const u = em ? store.findByEmail(em) : null;
    if (u) {
      const token = newResetToken();
      store.update(u.id, { resetTokenHash: auth.hashPassword(token), resetExpires: now() + RESET_TTL_MS });
      const link = (appBaseUrl || (req.protocol + '://' + req.get('host'))) + '/?reset=' + token + '&email=' + encodeURIComponent(em);
      const m = coreEmail.resetEmailMsg(link);
      Promise.resolve(sendEmail(em, m.subject, m.text)).catch(() => {});
    }
    return res.json({ ok: true });
  });

  // POST /auth/reset {email, token, newPassword} — same length policy as signup; the token
  // is single-use and dies on success, failure, and expiry alike (uniform 'invalid token'
  // answer — no oracle about which part was wrong).
  app.post('/auth/reset', (req, res) => {
    const ipKey = 'reset:ip:' + clientIp(req);
    const c = loginLimiter.check(ipKey);
    if (c.limited) return tooMany(res, c.retryAfterMs);
    loginLimiter.hit(ipKey);
    const { email, token, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'password too short' });
    const em = auth.normalizeEmail(email || '');
    const u = em ? store.findByEmail(em) : null;
    const ok = !!(u && u.resetTokenHash && now() <= (u.resetExpires || 0) && auth.verifyPassword(String(token || ''), u.resetTokenHash));
    if (!ok) return res.status(400).json({ error: 'invalid token' });
    store.update(u.id, { passwordHash: auth.hashPassword(newPassword), resetTokenHash: null, resetExpires: null });
    return res.json({ ok: true });
  });

  // POST /auth/login {email,password} — brute-force limited by client IP AND targeted email
  // (so neither one IP guessing many accounts, nor many IPs guessing one account, is cheap).
  app.post('/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    const em = auth.normalizeEmail(email || '');
    const ipKey = 'login:ip:' + clientIp(req);
    const emKey = em ? 'login:em:' + em : null;
    const ci = loginLimiter.check(ipKey);
    const ce = emKey ? loginLimiter.check(emKey) : { limited: false, retryAfterMs: 0 };
    if (ci.limited || ce.limited) return tooMany(res, Math.max(ci.retryAfterMs, ce.retryAfterMs));
    if (!emailAllowed(email)) { loginLimiter.hit(ipKey); if (emKey) loginLimiter.hit(emKey); return res.status(403).json({ error: 'not_allowed' }); }
    const user = store.findByEmail(em);
    if (!user || !auth.verifyPassword(password, user.passwordHash)) {
      loginLimiter.hit(ipKey); if (emKey) loginLimiter.hit(emKey);   // only FAILURES count
      return res.status(401).json({ error: 'invalid credentials' });
    }
    // Block only accounts EXPLICITLY marked unverified; legacy users (no `verified` field)
    // are grandfathered so an existing owner is never locked out. A bad password above still
    // 401s first, so this doesn't reveal which emails exist.
    if (user.verified === false) {
      loginLimiter.reset(ipKey); if (emKey) loginLimiter.reset(emKey);   // credentials were right — don't penalise
      return res.status(403).json({ error: 'email_not_verified', pendingVerify: true });
    }
    loginLimiter.reset(ipKey); if (emKey) loginLimiter.reset(emKey);  // success clears the counters
    const token = auth.signToken({ sub: user.id, email: em }, secret);
    return res.json({ token, email: em, plan: user.plan || 'free' });
  });

  // GET /auth/me  (Authorization: Bearer <token>)
  app.get('/auth/me', (req, res) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = auth.verifyToken(token, secret);
    if (!payload) return res.status(401).json({ error: 'unauthorized' });
    const u = store.findByEmail(payload.email);
    return res.json({ email: payload.email, sub: payload.sub, plan: (u && u.plan) || 'free' });
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
    // Google has already confirmed this email — a Google login ALWAYS leaves the account
    // verified (even one that signed up by password and never entered a code).
    if (user.verified !== true || !user.plan) store.update(user.id, { verified: true, plan: user.plan || 'free' });
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

  // ---- global memory: KUMIKO-GLOBAL.md — per-USER, cross-vault (beside vaults.json).
  // Fixed filename + encodeURIComponent(userId) (same as vaultreg) → no path traversal surface.
  const gmemPath = (uid) => path.join(dataDir, 'vaults', encodeURIComponent(String(uid)), 'KUMIKO-GLOBAL.md');
  app.get('/memory/global', requireAuth, (req, res) => {
    try { res.json({ content: fs.readFileSync(gmemPath(req.user.sub), 'utf8') }); }
    catch (_) { res.json({ content: '' }); }
  });
  app.put('/memory/global', requireAuth, (req, res) => {
    try {
      fs.mkdirSync(path.dirname(gmemPath(req.user.sub)), { recursive: true });
      fs.writeFileSync(gmemPath(req.user.sub), String((req.body || {}).content || ''));
      res.json({ ok: true });
    } catch (_) { res.json({ error: 'failed' }); }
  });

  // ---- vaults (Phase 8.2): per-user vault registry CRUD ----
  // GET /vaults -> { vaults: [...] } (default vault is lazily created on first read)
  app.get('/vaults', requireAuth, (req, res) => {
    res.json({ vaults: vreg.list(req.user.sub) });
  });

  // POST /vaults { name } -> { vault }
  app.post('/vaults', requireAuth, (req, res) => {
    res.json({ vault: vreg.create(req.user.sub, (req.body || {}).name) });
  });

  // POST /vaults/rename { id, name } -> vault | { error }
  app.post('/vaults/rename', requireAuth, (req, res) => {
    res.json(vreg.rename(req.user.sub, (req.body || {}).id, (req.body || {}).name));
  });

  // DELETE /vaults?id=<id> -> { ok:true } | { error }  (never deletes the last vault)
  app.delete('/vaults', requireAuth, (req, res) => {
    res.json(vreg.remove(req.user.sub, req.query.id));
  });

  // GET /notes -> { notes: [...] }  (authed)
  app.get('/notes', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ notes: notes.list(req.user.sub, v) });
  });

  // GET /notes/content?name=<n> -> { name, content }
  app.get('/notes/content', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const name = req.query.name;
    res.json({ name, content: notes.read(req.user.sub, v, name) });
  });

  // PUT /notes { name, content } -> { ok }
  app.put('/notes', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const { name, content } = req.body || {};
    const ok = notes.write(req.user.sub, v, name, String(content || ''));
    return res.status(ok ? 200 : 400).json({ ok });
  });

  // DELETE /notes?name=<n> -> { ok }. SOFT delete: moves the note into .trash
  // (vfs.noteTrash) instead of hard-unlinking, mirroring Electron note:delete.
  app.delete('/notes', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const r = vfs.noteTrash(req.user.sub, v, req.query.name);
    res.json({ ok: r.ok === true });
  });

  // ---- folders (per-vault cloud folder storage; mirrors Electron folder:*) ----
  // GET /folders -> { folders: [...] } (all dirs under vaultDir, including empty)
  app.get('/folders', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ folders: vfs.folderList(req.user.sub, v) });
  });

  // POST /folders { path } -> { name } | { error }
  app.post('/folders', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const r = vfs.folderCreate(req.user.sub, v, (req.body || {}).path);
    res.status(r.error ? 400 : 200).json(r);
  });

  // POST /folders/rename { from, to } -> { name } | { error }
  app.post('/folders/rename', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const r = vfs.folderRename(req.user.sub, v, (req.body || {}).from, (req.body || {}).to);
    res.status(r.error ? 400 : 200).json(r);
  });

  // DELETE /folders?path=<rel> -> { ok:true } | { error }  (moves folder to trash)
  app.delete('/folders', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json(vfs.folderDelete(req.user.sub, v, req.query.path));
  });

  // ---- trash (per-vault cloud trash; mirrors Electron trash:*) ----
  // GET /trash -> { trash: [...] } sorted by deletedAt DESC
  app.get('/trash', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ trash: vfs.trashList(req.user.sub, v) });
  });

  // POST /trash/restore { id } -> { ok:true } | { error }
  app.post('/trash/restore', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json(vfs.trashRestore(req.user.sub, v, (req.body || {}).id));
  });

  // POST /trash/deleteForever { id } -> { ok:true }
  app.post('/trash/deleteForever', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json(vfs.trashDeleteForever(req.user.sub, v, (req.body || {}).id));
  });

  // POST /trash/empty -> { ok:true }
  app.post('/trash/empty', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json(vfs.trashEmpty(req.user.sub, v));
  });

  // ---- databases (per-vault cloud DB storage, JSON blobs) ----
  // GET /dbs -> { dbs: [{ id, name, icon, cols, rows }] } (sorted by name)
  app.get('/dbs', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ dbs: dbs.list(req.user.sub, v) });
  });

  // GET /dbs/one?id=<id> -> { db: fullDB|null }
  app.get('/dbs/one', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ db: dbs.read(req.user.sub, v, req.query.id) });
  });

  // PUT /dbs { db } -> { ok }
  app.put('/dbs', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const db = (req.body || {}).db;
    const ok = dbs.write(req.user.sub, v, db);
    return res.status(ok ? 200 : 400).json({ ok });
  });

  // DELETE /dbs?id=<id> -> { ok }
  app.delete('/dbs', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ ok: dbs.remove(req.user.sub, v, req.query.id) });
  });

  // ---- pdfs (per-vault cloud PDF binary + annot storage) ----
  // GET /pdfs -> { pdfs: [...] } (sorted filenames, excludes *.annot.json sidecars)
  // ---- note image assets (2026-09-05): binary files under <vault>/assets/, parity with the
  // desktop asset:save/asset:read pair. Names are server-generated (sanitized + suffixed).
  const _assetVaultDir = (req) => path.join(dataDir, 'vaults', encodeURIComponent(String(req.user.sub)), encodeURIComponent(String(vaultOf(req))));
  app.post('/assets', requireAuth, (req, res) => {
    try {
      const { name, dataUri } = req.body || {};
      const m = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i.exec(String(dataUri || ''));
      if (!m) return res.json({ error: 'bad-uri' });
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
      const safe = String(name || 'img').replace(/[\/\\:*?"<>|#()\[\]]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'img';   // markdown ](…) breaks on ")" and spaces
      const rel = 'assets/' + safe + '-' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36) + '.' + ext;
      const full = path.join(_assetVaultDir(req), rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(m[2], 'base64'));
      res.json({ rel });
    } catch (e) { res.json({ error: 'failed' }); }
  });
  // <img> tags cannot send Authorization headers, so this route ALSO accepts the token as
  // ?t= (same JWT the header would carry) + ?v= for the vault. Name shape is a strict
  // whitelist (assets/<safe>.<img-ext>) — no traversal surface.
  app.get('/assets/content', (req, res) => {
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : String(req.query.t || '');
      const p0 = auth.verifyToken(token, app.locals.secret);
      if (!p0) return res.status(401).end();
      req.user = p0;
      if (req.query.v) req.headers['x-vault'] = String(req.query.v);
      const rel = String(req.query.name || '');
      if (!/^assets\/[A-Za-z0-9 ._฀-๿-]+\.(jpg|png|webp|gif)$/i.test(rel)) return res.status(400).end();
      const full = path.join(_assetVaultDir(req), rel);
      const ext = rel.split('.').pop().toLowerCase();
      res.type(ext === 'jpg' ? 'jpeg' : ext).send(fs.readFileSync(full));
    } catch (_) { res.status(404).end(); }
  });

  app.get('/pdfs', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json({ pdfs: pdfs.list(req.user.sub, v) });
  });

  // POST /pdfs/upload?name=<file> -> { name }. RAW octet-stream body (NOT json) so
  // the binary bytes flow straight through; express.raw sits in front of requireAuth.
  app.post('/pdfs/upload', requireAuth, express.raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
    const v = vaultOf(req);
    const name = req.query.name;
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'empty' });
    const saved = pdfs.write(req.user.sub, v, name, buf);
    if (!saved) return res.status(400).json({ error: 'invalid' });
    res.json({ name: saved });
  });

  // GET /pdfs/read?name=<file> -> raw PDF bytes (application/pdf); 404 on miss.
  app.get('/pdfs/read', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const buf = pdfs.read(req.user.sub, v, req.query.name);
    if (!buf) return res.status(404).end();
    res.setHeader('content-type', 'application/pdf');
    res.end(buf);
  });

  // POST /pdfs/rename { from, to } -> { name } | { error }
  app.post('/pdfs/rename', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const { from, to } = req.body || {};
    res.json(pdfs.rename(req.user.sub, v, from, to));
  });

  // GET /pdfs/annots?name=<file> -> { highlights:[...] } (default empty)
  app.get('/pdfs/annots', requireAuth, (req, res) => {
    const v = vaultOf(req);
    res.json(pdfs.readAnnots(req.user.sub, v, req.query.name));
  });

  // PUT /pdfs/annots { name, data } -> { ok }
  app.put('/pdfs/annots', requireAuth, (req, res) => {
    const v = vaultOf(req);
    const { name, data } = req.body || {};
    res.json({ ok: pdfs.saveAnnots(req.user.sub, v, name, data) });
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
    const thinking = (b.thinking === true || b.thinking === false) ? b.thinking : null;   // client's choice; null = provider default
    if (!opts.streamChat && (!provider || !key)) return res.status(501).json({ error: 'no AI configured' });
    // Quota only bites when the request falls back to the MANAGED key (no client key of its
    // own) — that's the owner's cost. Count the request up front so retries can't dodge it.
    const usingManaged = !b.key;
    if (usingManaged && !aiQuota.unlimited) {
      const q = aiQuota.check(req.user.sub);
      if (!q.allowed) return res.status(429).json({ error: 'ถึงโควตา AI รายวันแล้ว — ใส่ API key ของคุณเองที่ตั้งค่า AI เพื่อใช้ต่อโดยไม่จำกัด', used: q.used, limit: q.limit });
      aiQuota.record(req.user.sub);
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    try {
      for await (const delta of streamChat(prompt, { provider, key, model, thinking, images: Array.isArray(b.images) ? b.images.slice(0, 4) : [] })) res.write(delta);
      res.end();
    } catch (_) { try { res.end(); } catch (__) {} }
  });

  // GET /ai/quota -> the caller's managed-AI usage today (so the UI can show remaining).
  app.get('/ai/quota', requireAuth, (req, res) => {
    const q = aiQuota.check(req.user.sub);
    res.json({ used: q.used, limit: aiQuota.unlimited ? null : q.limit, remaining: aiQuota.unlimited ? null : q.remaining, unlimited: aiQuota.unlimited });
  });

  // GET /ai/config -> { available }. PUBLIC (mirrors /auth/config) so the web UI
  // can decide whether to surface AI controls without an auth round-trip.
  app.get('/ai/config', (req, res) => {
    res.json({ available: !!(opts.streamChat || (aiProvider && aiKey)) });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // JWT-gated WS upgrade: a valid token in ?token= is required to join any room, AND the
  // room must belong to that user. Rooms are named "<email>::<note>" (see collabRoomName),
  // so a user may only join rooms prefixed with their OWN email — otherwise any authenticated
  // user could join someone else's room by name and read the shared CRDT doc (P0 isolation).
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const payload = auth.verifyToken(token, secret);
    if (!payload) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    let room = '';
    try { room = decodeURIComponent(url.pathname.slice(1)); } catch (_) { room = url.pathname.slice(1); }
    const email = payload.email || '';
    if (!email || room.indexOf(email + '::') !== 0) {   // room not owned by this user
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
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
