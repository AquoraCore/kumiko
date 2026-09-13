import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const fs = require('fs');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  const d = path.join(os.tmpdir(), 'kumiko-host-' + counter + '-' + process.pid);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
async function post(base, route, body) {
  return fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('host mode server (mirrorVault / pair / devices)', () => {
  it('MIRROR (happy): pair token -> JWT -> notes read/write land in the mirrored dir', async () => {
    const dataDir = tmpDir();
    const vaultDir = tmpDir();
    fs.writeFileSync(path.join(vaultDir, 'hello.md'), 'สวัสดี', 'utf8');
    const s = await startServer({
      port: 0, dataDir,
      pairToken: 'a'.repeat(32),
      mirrorVault: { email: 'owner@kumiko.local', dir: vaultDir },
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // pair with the right token -> a JWT for the mirror account
      let r = await post(base, '/auth/pair', { token: 'a'.repeat(32) });
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(typeof body.token).toBe('string');
      expect(body.email).toBe('owner@kumiko.local');
      const auth = { Authorization: 'Bearer ' + body.token };

      // the account sees the desktop vault's existing note
      r = await fetch(base + '/notes', { headers: auth });
      expect(r.status).toBe(200);
      expect((await r.json()).notes).toContain('hello.md');

      // writes land in the MIRRORED dir (the desktop vault), not server-local storage
      r = await fetch(base + '/notes', {
        method: 'PUT',
        headers: Object.assign({ 'content-type': 'application/json' }, auth),
        body: JSON.stringify({ name: 'from-phone.md', content: 'hi' }),
      });
      expect(r.status).toBe(200);
      expect(fs.readFileSync(path.join(vaultDir, 'from-phone.md'), 'utf8')).toBe('hi');

      // restarting (same mirror dir re-registered) keeps pointing at the same place
      // — covered implicitly by the symlink idempotence check in the next test.
    } finally { await s.close(); }
  }, 20000);

  it('MIRROR (edge): wrong token -> 401; password login for the mirror account -> rejected', async () => {
    const dataDir = tmpDir();
    const s = await startServer({
      port: 0, dataDir,
      pairToken: 'b'.repeat(32),
      mirrorVault: { email: 'owner@kumiko.local', dir: tmpDir() },
    });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      let r = await post(base, '/auth/pair', { token: 'wrong' });
      expect(r.status).toBe(401);
      r = await post(base, '/auth/pair', {});
      expect(r.status).toBe(401);
      // no password exists for the mirror account — normal login must refuse it
      r = await post(base, '/auth/login', { email: 'owner@kumiko.local', password: 'whatever123' });
      expect([401, 403]).toContain(r.status);
    } finally { await s.close(); }
  }, 20000);

  it('MIRROR: re-starting with the SAME mirror dir does not duplicate or break the binding', async () => {
    const dataDir = tmpDir();
    const vaultDir = tmpDir();
    const opts = { port: 0, dataDir, pairToken: 'c'.repeat(32), mirrorVault: { email: 'owner@kumiko.local', dir: vaultDir } };
    let s = await startServer(opts);
    await s.close();
    s = await startServer(opts);   // second boot: vault dir is already the symlink
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const r = await post(base, '/auth/pair', { token: 'c'.repeat(32) });
      const body = await r.json();
      const w = await fetch(base + '/notes', {
        method: 'PUT',
        headers: Object.assign({ 'content-type': 'application/json' }, { Authorization: 'Bearer ' + body.token }),
        body: JSON.stringify({ name: 'again.md', content: 'x' }),
      });
      expect(w.status).toBe(200);
      expect(fs.existsSync(path.join(vaultDir, 'again.md'))).toBe(true);
    } finally { await s.close(); }
  }, 20000);

  it('FAMILY: no pair endpoint (404) — members sign up normally', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    try {
      const r = await post('http://127.0.0.1:' + s.port + '/auth/pair', { token: 'x' });
      expect(r.status).toBe(404);
    } finally { await s.close(); }
  }, 20000);

  it('DEVICES: requests are counted per ip and expire after 10 minutes', async () => {
    let clock = 1000000;
    const s = await startServer({ port: 0, dataDir: tmpDir(), now: () => clock });
    try {
      expect(s.getDevices()).toEqual([]);
      await fetch('http://127.0.0.1:' + s.port + '/ai/config', { headers: { 'user-agent': 'vitest-agent' } });
      const devs = s.getDevices();
      expect(devs.length).toBe(1);
      expect(devs[0].ip).toBe('127.0.0.1');
      expect(devs[0].ua).toBe('vitest-agent');
      // same ip again -> still one entry
      await fetch('http://127.0.0.1:' + s.port + '/ai/config');
      expect(s.getDevices().length).toBe(1);
      // 11 minutes later -> gone
      clock += 11 * 60 * 1000;
      expect(s.getDevices()).toEqual([]);
    } finally { await s.close(); }
  }, 20000);
});
