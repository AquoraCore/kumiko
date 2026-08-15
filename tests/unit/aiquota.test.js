import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createAiQuota } = require('../../server/aiquota');
const path = require('path');
const os = require('os');
const fs = require('fs');

let counter = 0;
const tmpDir = () => path.join(os.tmpdir(), 'washi-aiquota-' + (++counter) + '-' + process.pid);
const stub = async function* () { yield 'ok'; };
async function signup(base, email) {
  const r = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  return (await r.json()).token;
}
const chat = (base, token, body) => fetch(base + '/ai/chat', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body || { prompt: 'hi' }) });

describe('AI cost quota — the managed key store', () => {
  it('counts per user per day, resets on a new day, and treats <=0 as unlimited', () => {
    const f = path.join(tmpDir(), 'q.json');
    const q = createAiQuota(f, 2);
    expect(q.check('u1').allowed).toBe(true);
    q.record('u1'); q.record('u1');
    expect(q.check('u1')).toMatchObject({ allowed: false, used: 2, limit: 2, remaining: 0 });
    expect(q.check('u2').allowed).toBe(true);   // a different user is independent
    // simulate a previous day for u1 -> resets
    fs.writeFileSync(f, JSON.stringify({ u1: { date: '2000-01-01', count: 99 } }));
    expect(q.check('u1').allowed).toBe(true);
    expect(createAiQuota(f, 0).unlimited).toBe(true);
    expect(createAiQuota(f, -5).unlimited).toBe(true);
  });
});

describe('P0 · /ai/chat enforces the managed-AI daily quota', () => {
  it('allows up to the limit on the managed key, then 429s — own-key requests are exempt', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), streamChat: stub, managedAiDailyLimit: 3 });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'q@b.com');
      // 3 managed requests (no client key) succeed
      for (let i = 0; i < 3; i++) expect((await chat(base, token, { prompt: 'hi' })).status).toBe(200);
      // 4th is over the cap
      const over = await chat(base, token, { prompt: 'hi' });
      expect(over.status).toBe(429);
      expect((await over.json())).toMatchObject({ limit: 3, used: 3 });
      // a request WITH the user's own key bypasses the quota
      expect((await chat(base, token, { prompt: 'hi', provider: 'zai', key: 'sk-mine' })).status).toBe(200);
      // /ai/quota reports usage
      const qr = await fetch(base + '/ai/quota', { headers: { authorization: 'Bearer ' + token } });
      expect(await qr.json()).toMatchObject({ used: 3, limit: 3, remaining: 0, unlimited: false });
    } finally { await s.close(); }
  }, 20000);

  it('a second user has an independent quota', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), streamChat: stub, managedAiDailyLimit: 1 });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const a = await signup(base, 'a2@b.com');
      const b = await signup(base, 'b2@b.com');
      expect((await chat(base, a)).status).toBe(200);
      expect((await chat(base, a)).status).toBe(429);   // A is capped
      expect((await chat(base, b)).status).toBe(200);   // B still has its own allowance
    } finally { await s.close(); }
  }, 20000);

  it('limit 0 = unlimited (owner opt-out)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir(), streamChat: stub, managedAiDailyLimit: 0 });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'u0@b.com');
      for (let i = 0; i < 5; i++) expect((await chat(base, token)).status).toBe(200);
    } finally { await s.close(); }
  }, 20000);
});
