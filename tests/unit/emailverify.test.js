import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

let counter = 0;
const tmpDir = () => path.join(os.tmpdir(), 'washi-ev-' + (++counter) + '-' + process.pid);
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('P1 · email verification (opt-in)', () => {
  it('full flow: signup unverified → login blocked → verify link → login works', async () => {
    let sent = null;
    const s = await startServer({ port: 0, dataDir: tmpDir(), emailVerify: true, sendEmail: (to, subject, text) => { sent = { to, subject, text }; } });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // signup returns NO token, just verifyRequired; the link is emailed
      const su = await post(base, '/auth/signup', { email: 'new@b.com', password: 'password123' });
      expect(su.status).toBe(200);
      const sb = await su.json();
      expect(sb).toMatchObject({ email: 'new@b.com', verifyRequired: true });
      expect(sb.token).toBeUndefined();
      expect(sent.to).toBe('new@b.com');
      const token = (sent.text.match(/token=([a-f0-9]+)/) || [])[1];
      expect(token).toBeTruthy();

      // login before verifying → 403 email_not_verified (even with the RIGHT password)
      const pre = await post(base, '/auth/login', { email: 'new@b.com', password: 'password123' });
      expect(pre.status).toBe(403);
      expect((await pre.json()).error).toBe('email_not_verified');

      // click the verify link
      const vr = await fetch(base + '/auth/verify?token=' + token);
      expect(vr.status).toBe(200);
      expect((await vr.text())).toContain('ยืนยัน');

      // now login works
      const ok = await post(base, '/auth/login', { email: 'new@b.com', password: 'password123' });
      expect(ok.status).toBe(200);
      expect(typeof (await ok.json()).token).toBe('string');

      // the token is one-time: reusing it fails
      expect((await fetch(base + '/auth/verify?token=' + token)).status).toBe(400);
      // a bogus token fails cleanly
      expect((await fetch(base + '/auth/verify?token=deadbeef')).status).toBe(400);
    } finally { await s.close(); }
  }, 20000);

  it('when OFF (default), signup returns a token immediately and login works — no verification', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });   // emailVerify defaults OFF
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const su = await post(base, '/auth/signup', { email: 'plain@b.com', password: 'password123' });
      expect(su.status).toBe(200);
      expect(typeof (await su.json()).token).toBe('string');   // token straight away
      const lg = await post(base, '/auth/login', { email: 'plain@b.com', password: 'password123' });
      expect(lg.status).toBe(200);
    } finally { await s.close(); }
  }, 20000);
});
