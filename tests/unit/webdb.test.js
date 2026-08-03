import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createWebApi } = require('../../web/api-web');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-webdb-' + counter + '-' + process.pid);
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

describe('web databases (per-user cloud DB storage)', () => {
  it('HAPPY: a user can create, list, read, save, and delete a DB', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'webdb@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      const db = await api.dbCreate({ name: 'Tasks' });
      expect(db.id).toBeTruthy();
      expect(db.columns.length).toBe(3);

      const meta = await api.dbList();
      expect(meta.some((m) => m.id === db.id && m.name === 'Tasks' && m.cols === 3)).toBe(true);

      const full = await api.dbRead(db.id);
      expect(full.name).toBe('Tasks');
      expect(full.columns.length).toBe(3);

      full.rows.push({ id: 'r2', c1: 'hi' });
      expect(await api.dbSave(full)).toBe(true);

      expect((await api.dbRead(db.id)).rows.length).toBe(2);

      expect(await api.dbDelete(db.id)).toBe(true);
      expect((await api.dbList()).some((m) => m.id === db.id)).toBe(false);
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: per-user isolation + missing reads as null + save without id fails', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const tokA = await signup(base, 'a-webdb@b.com');
      const tokB = await signup(base, 'b-webdb@b.com');
      const apiA = createWebApi({ baseUrl: base, getToken: () => tokA });
      const apiB = createWebApi({ baseUrl: base, getToken: () => tokB });

      const aDb = await apiA.dbCreate({ name: 'A-only' });

      // B cannot see A's DB: not in list, not readable.
      const bList = await apiB.dbList();
      expect(bList.some((m) => m.id === aDb.id)).toBe(false);
      expect(await apiB.dbRead(aDb.id)).toBe(null);

      // missing id reads as null; empty object save returns false (no .id).
      expect(await apiA.dbRead('nope')).toBe(null);
      expect(await apiA.dbSave({})).toBe(false);
    } finally {
      await s.close();
    }
  }, 20000);
});
