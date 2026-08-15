import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createRateLimiter } = require('../../server/ratelimit');
const path = require('path');
const os = require('os');

let counter = 0;
const tmpDir = () => path.join(os.tmpdir(), 'washi-rl-' + (++counter) + '-' + process.pid);
const login = (base, email, password, headers) =>
  fetch(base + '/auth/login', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify({ email, password }) });
const signup = (base, email) =>
  fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });

describe('rate limiter — the store', () => {
  it('counts to max, then reports limited, and resets on a new window', () => {
    const clk = { t: 0 };
    const rl = createRateLimiter({ max: 3, windowMs: 1000, now: () => clk.t });
    expect(rl.check('k').limited).toBe(false);
    rl.hit('k'); rl.hit('k'); rl.hit('k');
    expect(rl.check('k').limited).toBe(true);        // 3 hits == max → blocked
    expect(rl.check('other').limited).toBe(false);   // independent key
    clk.t = 1001;                                    // window elapsed
    expect(rl.check('k').limited).toBe(false);       // reset
  });
  it('reset() clears a key immediately (used on successful login)', () => {
    const rl = createRateLimiter({ max: 1 });
    rl.hit('k'); expect(rl.check('k').limited).toBe(true);
    rl.reset('k'); expect(rl.check('k').limited).toBe(false);
  });
});

describe('P1 · /auth/login brute-force limit', () => {
  it('blocks after N failures, sets Retry-After, then re-allows after the window', async () => {
    const clk = { t: 1_000_000 };
    const s = await startServer({ port: 0, dataDir: tmpDir(), loginRateMax: 3, loginRateWindowMs: 60_000, now: () => clk.t });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      await signup(base, 'victim@b.com');   // real account exists
      // 3 wrong-password attempts → 401
      for (let i = 0; i < 3; i++) expect((await login(base, 'victim@b.com', 'WRONG')).status).toBe(401);
      // 4th is blocked
      const blocked = await login(base, 'victim@b.com', 'WRONG');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
      // even the CORRECT password is blocked while limited (can't bypass the wall by guessing right)
      expect((await login(base, 'victim@b.com', 'password123')).status).toBe(429);
      // window elapses → allowed again, correct password works
      clk.t += 61_000;
      expect((await login(base, 'victim@b.com', 'password123')).status).toBe(200);
    } finally { await s.close(); }
  }, 20000);

  it('a successful login clears the counter (a good user is not locked out by past typos)', async () => {
    const clk = { t: 5_000_000 };
    const s = await startServer({ port: 0, dataDir: tmpDir(), loginRateMax: 3, loginRateWindowMs: 60_000, now: () => clk.t });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      await signup(base, 'good@b.com');
      expect((await login(base, 'good@b.com', 'WRONG')).status).toBe(401);   // 1 typo
      expect((await login(base, 'good@b.com', 'WRONG')).status).toBe(401);   // 2 typos
      expect((await login(base, 'good@b.com', 'password123')).status).toBe(200);  // success → reset
      // budget is fresh again: two more failures still allowed (not immediately blocked)
      expect((await login(base, 'good@b.com', 'WRONG')).status).toBe(401);
      expect((await login(base, 'good@b.com', 'WRONG')).status).toBe(401);
    } finally { await s.close(); }
  }, 20000);
});
