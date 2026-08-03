import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-allow-' + counter + '-' + process.pid);
}

async function post(base, route, body) {
  return fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('email allowlist', () => {
  it('HAPPY: allowlisted email can sign up and log in', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), allowedEmails: 'ok@gmail.com' });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // signup
      let r = await post(base, '/auth/signup', { email: 'ok@gmail.com', password: 'secret123' });
      expect(r.status).toBe(200);
      let body = await r.json();
      expect(typeof body.token).toBe('string');

      // login with the same creds
      r = await post(base, '/auth/login', { email: 'ok@gmail.com', password: 'secret123' });
      expect(r.status).toBe(200);
      body = await r.json();
      expect(typeof body.token).toBe('string');
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: non-allowlisted email is rejected on signup + login', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), allowedEmails: 'ok@gmail.com' });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // signup blocked
      let r = await post(base, '/auth/signup', { email: 'nope@gmail.com', password: 'secret123' });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe('not_allowed');

      // login blocked
      r = await post(base, '/auth/login', { email: 'nope@gmail.com', password: 'secret123' });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe('not_allowed');
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: case-insensitive match (OK@Gmail.com passes when ok@gmail.com is listed)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), allowedEmails: 'ok@gmail.com' });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const r = await post(base, '/auth/signup', { email: 'OK@Gmail.com', password: 'secret123' });
      expect(r.status).toBe(200);
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: empty allowlist allows everyone (default open)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const r = await post(base, '/auth/signup', { email: 'anyone@example.com', password: 'secret123' });
      expect(r.status).toBe(200);
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: google login respects the allowlist', async () => {
    const s = await startServer({
      port: 0,
      dataDir: tmpDir(),
      allowedEmails: 'ok@gmail.com',
      googleClientId: 'test-client',
      verifyGoogleToken: async (t) =>
        t === 'good' ? { sub: 'g-1', email: 'ok@GMAIL.com' }
        : (t === 'bad' ? { sub: 'g-2', email: 'nope@gmail.com' } : null),
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // allowed (case-insensitive) -> 200
      let r = await post(base, '/auth/google', { idToken: 'good' });
      expect(r.status).toBe(200);

      // not allowed -> 403
      r = await post(base, '/auth/google', { idToken: 'bad' });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe('not_allowed');
    } finally {
      await s.close();
    }
  }, 20000);
});
