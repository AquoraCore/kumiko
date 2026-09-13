import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const auth = require('../../server/auth');
const { sendEmail } = require('../../server/email');
const coreEmail = require('../../core/email');
const fs = require('fs');
const path = require('path');
const os = require('os');

let counter = 0;
const tmpDir = () => path.join(os.tmpdir(), 'washi-vr-' + (++counter) + '-' + process.pid);
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const codeFrom = (text) => (String(text).match(/\b(\d{6})\b/) || [])[1];
const tokenFrom = (text) => (String(text).match(/reset=([a-f0-9]{32})/) || [])[1];

// ---------------------------------------------------------------------------
// E1 — pure email pipeline (core/email.js) + the side-effect sender (server/email.js)
// ---------------------------------------------------------------------------
describe('E1 · core/email — buildEmailRequest', () => {
  it('resend: POST url, Bearer header, {from,to,subject,text} body', () => {
    const r = coreEmail.buildEmailRequest('resend', { apiKey: 'k-123', from: 'Kumiko <no-reply@x.com>' }, { to: 'a@b.com', subject: 's', text: 't' });
    expect(r.url).toBe('https://api.resend.com/emails');
    expect(r.headers.Authorization).toBe('Bearer k-123');
    expect(r.body).toEqual({ from: 'Kumiko <no-reply@x.com>', to: 'a@b.com', subject: 's', text: 't' });
  });
  it('unknown provider → null', () => {
    expect(coreEmail.buildEmailRequest('sendgrid', { apiKey: 'k' }, { to: 'a@b.com' })).toBe(null);
    expect(coreEmail.buildEmailRequest('', {}, { to: 'a@b.com' })).toBe(null);
  });
  it('missing apiKey/from/to → null', () => {
    expect(coreEmail.buildEmailRequest('resend', {}, { to: 'a@b.com' })).toBe(null);
    expect(coreEmail.buildEmailRequest('resend', { apiKey: 'k' }, {})).toBe(null);
  });
});

describe('E1 · core/email — templates (TH first, EN appended)', () => {
  it('verifyEmailMsg carries the code in both languages', () => {
    const m = coreEmail.verifyEmailMsg('123456');
    expect(m.subject).toContain('ยืนยัน');
    expect(m.subject).toContain('verification');
    expect(m.text.indexOf('123456')).toBeGreaterThanOrEqual(0);
    expect(m.text).toContain('Your Kumiko verification code is 123456');
    expect(m.text).toContain('รหัสยืนยันอีเมลของคุณคือ 123456');
  });
  it('resetEmailMsg carries the link in both languages', () => {
    const m = coreEmail.resetEmailMsg('https://x.com/?reset=abc');
    expect(m.subject).toContain('ตั้งรหัสผ่านใหม่');
    expect(m.subject.toLowerCase()).toContain('reset');
    expect(m.text).toContain('https://x.com/?reset=abc');
    expect(m.text).toContain('Reset your Kumiko password');
  });
});

describe('E1 · server/email — sendEmail', () => {
  it('no RESEND_API_KEY → dev-mode: resolves true (logged, not sent)', async () => {
    delete process.env.RESEND_API_KEY;
    expect(await sendEmail({ to: 'a@b.com', subject: 's', text: 't' })).toBe(true);
  });
  it('with a key → real request via fetch (url/headers/body from core)', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    delete process.env.EMAIL_FROM;
    let captured = null;
    const ok = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true };
    });
    expect(ok).toBe(true);
    expect(captured.url).toBe('https://api.resend.com/emails');
    expect(captured.headers.Authorization).toBe('Bearer test-key');
    expect(captured.body.from).toBe('Kumiko <no-reply@aquoracore.com>');   // EMAIL_FROM default
    expect(captured.body.to).toBe('a@b.com');
    process.env.EMAIL_FROM = 'Custom <x@y.com>';
    await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, async (url, init) => {
      captured = { body: JSON.parse(init.body) };
      return { ok: true };
    });
    expect(captured.body.from).toBe('Custom <x@y.com>');
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });
  it('provider failure/fetch error → returns false, never throws', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    expect(await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, async () => ({ ok: false, status: 500 }))).toBe(false);
    expect(await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, async () => { throw new Error('boom'); })).toBe(false);
    delete process.env.RESEND_API_KEY;
  });
});

// ---------------------------------------------------------------------------
// E2.1 — code verification flow (REQUIRE_EMAIL_VERIFY, default OFF)
// ---------------------------------------------------------------------------
describe('E2 · verify-on-signup (opt-in)', () => {
  it('happy: signup → pendingVerify (no JWT) → code email → verify → JWT → login works', async () => {
    let sent = null;
    const s = await startServer({ port: 0, dataDir: tmpDir(), requireEmailVerify: true, sendEmail: (to, subject, text) => { sent = { to, subject, text }; } });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const su = await post(base, '/auth/signup', { email: 'new@b.com', password: 'password123' });
      expect(su.status).toBe(200);
      const sb = await su.json();
      expect(sb).toMatchObject({ email: 'new@b.com', pendingVerify: true });
      expect(sb.token).toBeUndefined();
      expect(sent.to).toBe('new@b.com');
      const code = codeFrom(sent.text);
      expect(code).toMatch(/^\d{6}$/);

      // login with the RIGHT password is still blocked while unverified
      const pre = await post(base, '/auth/login', { email: 'new@b.com', password: 'password123' });
      expect(pre.status).toBe(403);
      expect((await pre.json()).pendingVerify).toBe(true);

      // wrong code → 401
      expect((await post(base, '/auth/verify', { email: 'new@b.com', code: '000000' })).status).toBe(401);
      // correct code → JWT straight away
      const vr = await post(base, '/auth/verify', { email: 'new@b.com', code });
      expect(vr.status).toBe(200);
      const vb = await vr.json();
      expect(typeof vb.token).toBe('string');
      expect(vb.plan).toBe('free');
      // login now works
      expect((await post(base, '/auth/login', { email: 'new@b.com', password: 'password123' })).status).toBe(200);
    } finally { await s.close(); }
  }, 20000);

  it('edge: 5 wrong attempts kill the code — even the CORRECT code after; resend revives', async () => {
    let sent = null;
    const s = await startServer({ port: 0, dataDir: tmpDir(), requireEmailVerify: true, sendEmail: (to, subject, text) => { sent = { to, subject, text }; } });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      await post(base, '/auth/signup', { email: 'lim@b.com', password: 'password123' });
      const code = codeFrom(sent.text);
      for (let i = 0; i < 5; i++) expect((await post(base, '/auth/verify', { email: 'lim@b.com', code: '999999' })).status).toBe(401);
      // code is dead now — the correct one is refused too
      const dead = await post(base, '/auth/verify', { email: 'lim@b.com', code });
      expect(dead.status).toBe(401);
      expect((await dead.json()).pendingVerify).toBe(true);
      // resend issues a FRESH code (attempts reset) → it works
      sent = null;
      expect((await post(base, '/auth/resend-code', { email: 'lim@b.com' })).status).toBe(200);
      const code2 = codeFrom(sent.text);
      expect(code2).toMatch(/^\d{6}$/);
      const vr = await post(base, '/auth/verify', { email: 'lim@b.com', code: code2 });
      expect(vr.status).toBe(200);
      expect(typeof (await vr.json()).token).toBe('string');
    } finally { await s.close(); }
  }, 20000);

  it('edge: code expires after 15 minutes', async () => {
    const clk = { t: Date.now() };
    let sent = null;
    const s = await startServer({ port: 0, dataDir: tmpDir(), requireEmailVerify: true, now: () => clk.t, sendEmail: (to, subject, text) => { sent = { to, subject, text }; } });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      await post(base, '/auth/signup', { email: 'exp@b.com', password: 'password123' });
      const code = codeFrom(sent.text);
      clk.t += 16 * 60 * 1000;
      const r = await post(base, '/auth/verify', { email: 'exp@b.com', code });
      expect(r.status).toBe(401);
      expect((await r.json()).error).toContain('expired');
    } finally { await s.close(); }
  }, 20000);

  it('edge: resend-code is limited to 3/hour per email', async () => {
    let sent = null;
    const s = await startServer({ port: 0, dataDir: tmpDir(), requireEmailVerify: true, sendEmail: (to, subject, text) => { sent = { to, subject, text }; } });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      await post(base, '/auth/signup', { email: 'rl@b.com', password: 'password123' });
      for (let i = 0; i < 3; i++) expect((await post(base, '/auth/resend-code', { email: 'rl@b.com' })).status).toBe(200);
      const fourth = await post(base, '/auth/resend-code', { email: 'rl@b.com' });
      expect(fourth.status).toBe(429);
      expect(Number(fourth.headers.get('retry-after'))).toBeGreaterThan(0);
      // a different email is unaffected
      expect((await post(base, '/auth/resend-code', { email: 'other@b.com' })).status).toBe(200);
    } finally { await s.close(); }
  }, 20000);

  it('default OFF: signup returns a JWT immediately — no flag, no change', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const su = await post(base, '/auth/signup', { email: 'plain@b.com', password: 'password123' });
      expect(su.status).toBe(200);
      expect(typeof (await su.json()).token).toBe('string');
      expect((await post(base, '/auth/login', { email: 'plain@b.com', password: 'password123' })).status).toBe(200);
    } finally { await s.close(); }
  }, 20000);

  it('env wiring: REQUIRE_EMAIL_VERIFY=1 turns the flow on', async () => {
    process.env.REQUIRE_EMAIL_VERIFY = '1';
    let s = null;
    try {
      s = await startServer({ port: 0, dataDir: tmpDir() });
      const base = 'http://127.0.0.1:' + s.port;
      const su = await post(base, '/auth/signup', { email: 'env@b.com', password: 'password123' });
      const sb = await su.json();
      expect(sb.pendingVerify).toBe(true);
      expect(sb.token).toBeUndefined();
    } finally {
      delete process.env.REQUIRE_EMAIL_VERIFY;
      if (s) await s.close();
    }
  }, 20000);

  it('legacy user without `verified` (and without plan) logs in fine — plan views as free', async () => {
    const dataDir = tmpDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'users.json'), JSON.stringify([
      { id: 'u1_legacy@b.com', email: 'legacy@b.com', passwordHash: auth.hashPassword('password123'), createdAt: '2024-01-01T00:00:00.000Z' },
    ]));
    // flag ON — a legacy user must STILL sail through (verified undefined ≠ false)
    const s = await startServer({ port: 0, dataDir, requireEmailVerify: true });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const lg = await post(base, '/auth/login', { email: 'legacy@b.com', password: 'password123' });
      expect(lg.status).toBe(200);
      const lb = await lg.json();
      expect(lb.plan).toBe('free');   // view fills free for users with no plan field
      const me = await (await fetch(base + '/auth/me', { headers: { Authorization: 'Bearer ' + lb.token } })).json();
      expect(me.plan).toBe('free');
    } finally { await s.close(); }
  }, 20000);
});

// ---------------------------------------------------------------------------
// E2.2 — forgot / reset password (always available; dev-mode mailer is fine)
// ---------------------------------------------------------------------------
describe('E2 · forgot/reset password', () => {
  const setup = async (opts) => {
    let sent = null;
    const s = await startServer(Object.assign({ port: 0, dataDir: tmpDir(), sendEmail: (to, subject, text) => { sent = { to, subject, text }; } }, opts));
    return { s, base: 'http://127.0.0.1:' + s.port, getSent: () => sent };
  };

  it('forgot on a non-existent account → 200, silent, no email sent', async () => {
    const { s, base, getSent } = await setup();
    try {
      const r = await post(base, '/auth/forgot', { email: 'ghost@b.com' });
      expect(r.status).toBe(200);
      expect((await r.json()).ok).toBe(true);
      expect(getSent()).toBe(null);
    } finally { await s.close(); }
  }, 20000);

  it('happy: forgot → email link with 32-hex token → reset → login with the new password', async () => {
    const { s, base, getSent } = await setup();
    try {
      await post(base, '/auth/signup', { email: 'me@b.com', password: 'password123' });
      const fr = await post(base, '/auth/forgot', { email: 'me@b.com' });
      expect(fr.status).toBe(200);
      const sent = getSent();
      expect(sent.to).toBe('me@b.com');
      expect(sent.subject).toContain('ตั้งรหัสผ่านใหม่');
      const token = tokenFrom(sent.text);
      expect(token).toMatch(/^[a-f0-9]{32}$/);

      // wrong token → 400; short password → 400
      expect((await post(base, '/auth/reset', { email: 'me@b.com', token: 'f'.repeat(32), newPassword: 'newpassword1' })).status).toBe(400);
      expect((await post(base, '/auth/reset', { email: 'me@b.com', token, newPassword: 'short' })).status).toBe(400);

      // correct → 200, old password dead, new one live
      expect((await post(base, '/auth/reset', { email: 'me@b.com', token, newPassword: 'newpassword1' })).status).toBe(200);
      expect((await post(base, '/auth/login', { email: 'me@b.com', password: 'password123' })).status).toBe(401);
      expect((await post(base, '/auth/login', { email: 'me@b.com', password: 'newpassword1' })).status).toBe(200);

      // token is single-use
      expect((await post(base, '/auth/reset', { email: 'me@b.com', token, newPassword: 'anotherpass1' })).status).toBe(400);
    } finally { await s.close(); }
  }, 20000);

  it('edge: reset token expires after 15 minutes', async () => {
    const clk = { t: Date.now() };
    const { s, base, getSent } = await setup({ now: () => clk.t });
    try {
      await post(base, '/auth/signup', { email: 'slow@b.com', password: 'password123' });
      await post(base, '/auth/forgot', { email: 'slow@b.com' });
      const token = tokenFrom(getSent().text);
      clk.t += 16 * 60 * 1000;
      expect((await post(base, '/auth/reset', { email: 'slow@b.com', token, newPassword: 'newpassword1' })).status).toBe(400);
    } finally { await s.close(); }
  }, 20000);

  it('edge: reset for an unknown account → 400 invalid token (no oracle in forgot, but reset is honest)', async () => {
    const { s, base } = await setup();
    try {
      expect((await post(base, '/auth/reset', { email: 'nobody@b.com', token: 'a'.repeat(32), newPassword: 'newpassword1' })).status).toBe(400);
    } finally { await s.close(); }
  }, 20000);
});

// ---------------------------------------------------------------------------
// E2.5 — Google users are ALWAYS verified; plan is free
// ---------------------------------------------------------------------------
describe('E2 · google sign-in readiness', () => {
  it('google login on an UNVERIFIED email account verifies it; plan recorded as free', async () => {
    let sent = null;
    const dataDir = tmpDir();
    const s = await startServer({
      port: 0, dataDir, requireEmailVerify: true,
      sendEmail: (to, subject, text) => { sent = { to, subject, text }; },
      googleClientId: 'test-client',
      verifyGoogleToken: async (t) => (t === 'g') ? { sub: 'g-1', email: 'link@b.com' } : null,
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // password signup under the code regime → unverified, login blocked
      await post(base, '/auth/signup', { email: 'link@b.com', password: 'password123' });
      expect((await post(base, '/auth/login', { email: 'link@b.com', password: 'password123' })).status).toBe(403);

      // google login with the SAME email → linked AND verified
      const gr = await post(base, '/auth/google', { idToken: 'g' });
      expect(gr.status).toBe(200);
      expect(typeof (await gr.json()).token).toBe('string');

      // password login works now — google proved the email
      expect((await post(base, '/auth/login', { email: 'link@b.com', password: 'password123' })).status).toBe(200);

      // persisted state: verified true, plan free
      const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
      const u = users.find((x) => x.email === 'link@b.com');
      expect(u.verified).toBe(true);
      expect(u.plan).toBe('free');
    } finally { await s.close(); }
  }, 20000);

  it('a fresh google user is created verified with plan free', async () => {
    const dataDir = tmpDir();
    const s = await startServer({
      port: 0, dataDir, googleClientId: 'test-client',
      verifyGoogleToken: async (t) => (t === 'g2') ? { sub: 'g-2', email: 'pure@gmail.com' } : null,
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      expect((await post(base, '/auth/google', { idToken: 'g2' })).status).toBe(200);
      const users = JSON.parse(fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8'));
      const u = users.find((x) => x.email === 'pure@gmail.com');
      expect(u.verified).toBe(true);
      expect(u.plan).toBe('free');
    } finally { await s.close(); }
  }, 20000);
});
