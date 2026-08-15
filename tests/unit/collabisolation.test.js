import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const { startServer } = require('../../server/index');
const WS = require('ws');
const path = require('path');
const os = require('os');

// ============================================================================
// P0 SECURITY GATE — collab (WebSocket / CRDT) room isolation.
// Collab rooms are named "<email>::<note>". The WS upgrade verifies the JWT AND that the
// room is prefixed with the token's OWN email — otherwise any authenticated user could
// join another user's room by name and read/edit the shared Yjs doc. These tests prove a
// second user cannot join user A's room even with a perfectly valid token of their own.
// ============================================================================

let srv, base;
async function signup(email) {
  const r = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  return (await r.json()).token;
}
// Try to open a raw WS to /<room>?token=... ; resolves 'open' or 'rejected:<status>'.
function tryConnect(room, token) {
  return new Promise((resolve) => {
    const url = base.replace('http', 'ws') + '/' + encodeURIComponent(room) + (token ? '?token=' + encodeURIComponent(token) : '');
    const ws = new WS(url);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(r); } };
    ws.on('open', () => done('open'));
    ws.on('unexpected-response', (_req, res) => done('rejected:' + res.statusCode));
    ws.on('error', () => done('rejected'));
    setTimeout(() => done('timeout'), 4000);
  });
}

let tokenA, tokenB;
beforeAll(async () => {
  srv = await startServer({ port: 0, dataDir: path.join(os.tmpdir(), 'washi-collab-' + process.pid) });
  base = 'http://127.0.0.1:' + srv.port;
  tokenA = await signup('alice@x.com');
  tokenB = await signup('bob@x.com');
}, 20000);
afterAll(async () => { if (srv) await srv.close(); });

describe('P0 · collab room isolation', () => {
  it('user A can join its OWN room', async () => {
    expect(await tryConnect('alice@x.com::Note', tokenA)).toBe('open');
  });
  it('user B CANNOT join user A\'s room — even with a valid token (403)', async () => {
    expect(await tryConnect('alice@x.com::Note', tokenB)).toBe('rejected:403');
  });
  it('user B can join its own room', async () => {
    expect(await tryConnect('bob@x.com::Note', tokenB)).toBe('open');
  });
  it('an unscoped room (no <email>:: prefix) is refused for an authed user (403)', async () => {
    expect(await tryConnect('justANote', tokenA)).toBe('rejected:403');
  });
  it('no token → 401', async () => {
    expect(await tryConnect('alice@x.com::Note', null)).toBe('rejected:401');
  });
});
