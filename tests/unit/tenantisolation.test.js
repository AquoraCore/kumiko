import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

// ============================================================================
// P0 SECURITY GATE — cross-tenant isolation.
// The whole multi-user story rests on ONE invariant: a request can only ever
// touch data owned by the JWT's user. The store builds every path as
// <root>/<userId>/<vaultId>/… with userId taken ONLY from req.user.sub, so even a
// forged x-vault header lands under the caller's OWN directory. These tests PROVE
// it end-to-end: user B must never see or read user A's notes, vaults, or PDFs —
// not by listing, not by name, not by spoofing A's vault id. If any of these fail,
// do NOT ship to more than one user.
// ============================================================================

let srv, base;
const H = (token, extra) => Object.assign({ authorization: 'Bearer ' + token, 'content-type': 'application/json' }, extra || {});

async function signup(email) {
  const r = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
  const j = await r.json();
  return j.token;
}

let tokenA, tokenB, vaultA;
const SECRET = 'TOP-SECRET-of-user-A-42';

beforeAll(async () => {
  srv = await startServer({ port: 0, dataDir: path.join(os.tmpdir(), 'washi-tenant-' + process.pid) });
  base = 'http://127.0.0.1:' + srv.port;
  tokenA = await signup('alice@x.com');
  tokenB = await signup('bob@x.com');
  // A writes a note in the DEFAULT vault
  await fetch(base + '/notes', { method: 'PUT', headers: H(tokenA), body: JSON.stringify({ name: 'secretA.md', content: SECRET }) });
  // A creates a SECOND vault and writes a note there too
  const vr = await fetch(base + '/vaults', { method: 'POST', headers: H(tokenA), body: JSON.stringify({ name: 'private' }) });
  vaultA = (await vr.json()).vault.id;
  await fetch(base + '/notes', { method: 'PUT', headers: H(tokenA, { 'x-vault': vaultA }), body: JSON.stringify({ name: 'vaultSecret.md', content: SECRET }) });
  // A uploads a PDF
  await fetch(base + '/pdfs/upload?name=' + encodeURIComponent('docA.pdf'), { method: 'POST', headers: { authorization: 'Bearer ' + tokenA, 'content-type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 secret-A-pdf') });
}, 20000);

afterAll(async () => { if (srv) await srv.close(); });

describe('P0 · tenant isolation — user B cannot reach user A', () => {
  it('sanity: user A CAN read its own note (the test is capable of seeing content)', async () => {
    const r = await fetch(base + '/notes/content?name=' + encodeURIComponent('secretA.md'), { headers: H(tokenA) });
    expect((await r.json()).content).toBe(SECRET);
  });

  it('B\'s note listing never includes A\'s notes', async () => {
    const r = await fetch(base + '/notes', { headers: H(tokenB) });
    const notes = (await r.json()).notes || [];
    expect(notes).not.toContain('secretA.md');
  });

  it('B reading A\'s note by name gets nothing (not the secret)', async () => {
    const r = await fetch(base + '/notes/content?name=' + encodeURIComponent('secretA.md'), { headers: H(tokenB) });
    const body = await r.json();
    expect(body.content || '').not.toContain('SECRET');
    expect(body.content || '').toBe('');
  });

  it('B FORGING A\'s vault id in x-vault still cannot read A\'s note (path is scoped to B)', async () => {
    const r = await fetch(base + '/notes/content?name=' + encodeURIComponent('vaultSecret.md'), { headers: H(tokenB, { 'x-vault': vaultA }) });
    const body = await r.json();
    expect(body.content || '').not.toContain('SECRET');
    expect(body.content || '').toBe('');
  });

  it('B listing notes with A\'s vault id sees an empty vault, not A\'s files', async () => {
    const r = await fetch(base + '/notes', { headers: H(tokenB, { 'x-vault': vaultA }) });
    const notes = (await r.json()).notes || [];
    expect(notes).not.toContain('vaultSecret.md');
  });

  it('B\'s vault list does not include A\'s vault', async () => {
    const r = await fetch(base + '/vaults', { headers: H(tokenB) });
    const ids = ((await r.json()).vaults || []).map((v) => v.id);
    expect(ids).not.toContain(vaultA);
  });

  it('B cannot list or read A\'s PDF', async () => {
    const list = await fetch(base + '/pdfs', { headers: H(tokenB) });
    expect(((await list.json()).pdfs || [])).not.toContain('docA.pdf');
    const read = await fetch(base + '/pdfs/read?name=' + encodeURIComponent('docA.pdf'), { headers: H(tokenB) });
    expect(read.status).toBe(404);   // not found in B's space
  });
});

describe('P0 · authentication is required', () => {
  it('no token → 401', async () => {
    const r = await fetch(base + '/notes');
    expect(r.status).toBe(401);
  });
  it('garbage token → 401', async () => {
    const r = await fetch(base + '/notes', { headers: { authorization: 'Bearer not.a.jwt' } });
    expect(r.status).toBe(401);
  });
});
