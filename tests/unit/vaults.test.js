import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-vaults-' + counter + '-' + process.pid);
}

function authHeaders(token, vaultId) {
  const h = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  if (vaultId) h['x-vault'] = vaultId;
  return h;
}

async function signup(base, email) {
  const r = await fetch(base + '/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const body = await r.json();
  return body.token;
}

describe('multi-vault (Phase 8.2)', () => {
  it('HAPPY: notes are isolated per vault; default vault auto-created', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'a@b.com');

      // GET /vaults -> at least one vault (the lazily-created default).
      let r = await fetch(base + '/vaults', { headers: authHeaders(token) });
      expect(r.status).toBe(200);
      let body = await r.json();
      expect(Array.isArray(body.vaults)).toBe(true);
      expect(body.vaults.length).toBeGreaterThanOrEqual(1);
      expect(body.vaults[0].name).toBe('บันทึกของฉัน');
      const V1 = body.vaults[0].id;

      // POST /vaults { name } -> a new vault id distinct from V1.
      r = await fetch(base + '/vaults', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'งานวิจัย' }),
      });
      expect(r.status).toBe(200);
      const V2 = (await r.json()).vault.id;
      expect(V2).toBeTruthy();
      expect(V2).not.toBe(V1);

      // PUT a.md into V1.
      r = await fetch(base + '/notes', {
        method: 'PUT',
        headers: authHeaders(token, V1),
        body: JSON.stringify({ name: 'a.md', content: 'in V1' }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()).ok).toBe(true);

      // GET /notes with x-vault: V2 -> must NOT include a.md.
      r = await fetch(base + '/notes', { headers: authHeaders(token, V2) });
      expect(((await r.json()).notes || []).includes('a.md')).toBe(false);

      // GET /notes with x-vault: V1 -> includes a.md.
      r = await fetch(base + '/notes', { headers: authHeaders(token, V1) });
      expect(((await r.json()).notes || []).includes('a.md')).toBe(true);
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: rename + cannot delete the last vault + bad id falls back to default', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'b@c.com');

      const V1 = (await (await fetch(base + '/vaults', { headers: authHeaders(token) })).json()).vaults[0].id;
      const V2 = (await (await fetch(base + '/vaults', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'งานวิจัย' }),
      })).json()).vault.id;

      // seed a.md in V1 so the fallback assertion below can check it survives.
      await fetch(base + '/notes', {
        method: 'PUT',
        headers: authHeaders(token, V1),
        body: JSON.stringify({ name: 'a.md', content: 'in V1' }),
      });

      // rename V2 -> 'lab'
      let r = await fetch(base + '/vaults/rename', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ id: V2, name: 'lab' }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()).name).toBe('lab');

      // DELETE V2 -> ok; only V1 remains.
      r = await fetch(base + '/vaults?id=' + encodeURIComponent(V2), { method: 'DELETE', headers: authHeaders(token) });
      expect(await r.json()).toEqual({ ok: true });
      r = await fetch(base + '/vaults', { headers: authHeaders(token) });
      const after = (await r.json()).vaults.map((v) => v.id);
      expect(after).toEqual([V1]);

      // DELETE the last vault (V1) -> refused with { error: 'last' }.
      r = await fetch(base + '/vaults?id=' + encodeURIComponent(V1), { method: 'DELETE', headers: authHeaders(token) });
      expect(await r.json()).toEqual({ error: 'last' });

      // a garbage x-vault falls back to the default vault (200, a.md still present).
      r = await fetch(base + '/notes', { headers: authHeaders(token, 'garbage') });
      expect(r.status).toBe(200);
      expect(((await r.json()).notes || []).includes('a.md')).toBe(true);
    } finally {
      await s.close();
    }
  }, 20000);
});
