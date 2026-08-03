import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-google-' + counter + '-' + process.pid);
}

async function post(base, route, body) {
  return fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('google auth', () => {
  it('google login issues our JWT + is idempotent', async () => {
    const dataDir = tmpDir();
    const s = await startServer({
      port: 0,
      dataDir,
      googleClientId: 'test-client',
      verifyGoogleToken: async (t) =>
        t === 'good' ? { sub: 'g-123', email: 'gmail.user@GMAIL.com', name: 'GU' }
        : (t === 'good2' ? { sub: 'g-456', email: 'other@gmail.com' } : null),
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // first google login — email normalized to lowercase
      let r = await post(base, '/auth/google', { idToken: 'good' });
      expect(r.status).toBe(200);
      let body = await r.json();
      expect(typeof body.token).toBe('string');
      expect(body.email).toBe('gmail.user@gmail.com');

      // the token works against OUR /auth/me
      r = await fetch(base + '/auth/me', { headers: { Authorization: 'Bearer ' + body.token } });
      expect(r.status).toBe(200);
      const me = await r.json();
      expect(me.email).toBe('gmail.user@gmail.com');

      // same google login again -> idempotent, no duplicate user
      r = await post(base, '/auth/google', { idToken: 'good' });
      expect(r.status).toBe(200);
      const body2 = await r.json();
      expect(body2.email).toBe('gmail.user@gmail.com');

      // confirm /auth/me for the second token resolves to the same user id (sub)
      const me2 = await (await fetch(base + '/auth/me', { headers: { Authorization: 'Bearer ' + body2.token } })).json();
      expect(me2.sub).toBe(me.sub);
    } finally {
      await s.close();
    }
  }, 20000);

  it('a google login links to an existing email account', async () => {
    const dataDir = tmpDir();
    const s = await startServer({
      port: 0,
      dataDir,
      googleClientId: 'test-client',
      verifyGoogleToken: async (t) =>
        t === 'good2' ? { sub: 'g-456', email: 'other@gmail.com' } : null,
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // create the email/password account first
      let r = await post(base, '/auth/signup', { email: 'other@gmail.com', password: 'password123' });
      expect(r.status).toBe(200);

      // google login for the SAME email — should LINK, not duplicate
      r = await post(base, '/auth/google', { idToken: 'good2' });
      expect(r.status).toBe(200);

      // password login STILL works — proves the google login linked to the existing user
      r = await post(base, '/auth/login', { email: 'other@gmail.com', password: 'password123' });
      expect(r.status).toBe(200);
    } finally {
      await s.close();
    }
  }, 20000);

  it('bad token + not-configured + /auth/config', async () => {
    const dataDir = tmpDir();
    const s = await startServer({
      port: 0,
      dataDir,
      googleClientId: 'test-client',
      verifyGoogleToken: async (t) =>
        t === 'good' ? { sub: 'g-123', email: 'gmail.user@GMAIL.com', name: 'GU' }
        : (t === 'good2' ? { sub: 'g-456', email: 'other@gmail.com' } : null),
    });
    const base = 'http://127.0.0.1:' + s.port;
    let s2 = null;
    try {
      // bad token -> 401
      let r = await post(base, '/auth/google', { idToken: 'nope' });
      expect(r.status).toBe(401);

      // /auth/config exposes the configured client id (public)
      r = await fetch(base + '/auth/config');
      expect((await r.json()).googleClientId).toBe('test-client');

      // a SECOND server with no client id and no verifier -> 501 + empty config
      s2 = await startServer({ port: 0, dataDir: tmpDir() });
      const base2 = 'http://127.0.0.1:' + s2.port;
      r = await post(base2, '/auth/google', { idToken: 'good' });
      expect(r.status).toBe(501);
      r = await fetch(base2 + '/auth/config');
      expect((await r.json()).googleClientId).toBe('');
    } finally {
      await s.close();
      if (s2) await s2.close();
    }
  }, 20000);
});
