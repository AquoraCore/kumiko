import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const path = require('path');
const os = require('os');
const fs = require('fs');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-notes-' + counter + '-' + process.pid);
}

function authHeaders(token) {
  return { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
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

describe('note store (cloud)', () => {
  it('HAPPY: a user can create, list, read, and delete their notes', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'a@b.com');

      // PUT hello.md
      let r = await fetch(base + '/notes', {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'hello.md', content: '# Hi' }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()).ok).toBe(true);

      // PUT nested
      r = await fetch(base + '/notes', {
        method: 'PUT',
        headers: authHeaders(token),
        body: JSON.stringify({ name: 'sub/deep.md', content: 'nested' }),
      });
      expect(r.status).toBe(200);

      // LIST
      r = await fetch(base + '/notes', { headers: authHeaders(token) });
      const list = (await r.json()).notes;
      expect(list).toContain('hello.md');
      expect(list).toContain('sub/deep.md');

      // READ
      r = await fetch(base + '/notes/content?name=hello.md', { headers: authHeaders(token) });
      const rd = await r.json();
      expect(rd.name).toBe('hello.md');
      expect(rd.content).toBe('# Hi');

      // DELETE
      r = await fetch(base + '/notes?name=hello.md', { method: 'DELETE', headers: authHeaders(token) });
      expect((await r.json()).ok).toBe(true);

      r = await fetch(base + '/notes', { headers: authHeaders(token) });
      expect((await r.json()).notes).not.toContain('hello.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: auth required + per-user isolation + path safety', async () => {
    const dir = tmpDir();
    const s = await startServer({ port: 0, dataDir: dir });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      // no Authorization header -> 401
      let r = await fetch(base + '/notes');
      expect(r.status).toBe(401);
      // garbage token -> 401
      r = await fetch(base + '/notes', { headers: { authorization: 'Bearer garbage.token.here' } });
      expect(r.status).toBe(401);

      // per-user isolation
      const tokA = await signup(base, 'a2@b.com');
      const tokB = await signup(base, 'b2@b.com');
      r = await fetch(base + '/notes', {
        method: 'PUT',
        headers: authHeaders(tokA),
        body: JSON.stringify({ name: 'secret.md', content: 'A-only' }),
      });
      expect(r.status).toBe(200);

      r = await fetch(base + '/notes', { headers: authHeaders(tokB) });
      expect((await r.json()).notes).not.toContain('secret.md');
      r = await fetch(base + '/notes/content?name=secret.md', { headers: authHeaders(tokB) });
      expect((await r.json()).content).toBe('');

      // path traversal blocked
      r = await fetch(base + '/notes', {
        method: 'PUT',
        headers: authHeaders(tokA),
        body: JSON.stringify({ name: '../escape.md', content: 'x' }),
      });
      expect(r.status).toBe(400);
      expect((await r.json()).ok).toBe(false);
      // confirm no file escaped outside the user dir
      const escPath = path.join(dir, 'escape.md');
      expect(fs.existsSync(escPath)).toBe(false);
    } finally {
      await s.close();
    }
  }, 20000);

  it('KUMIKO* root files: hidden from the list, still readable by direct rel (plan/worklog parity)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    try {
      const token = await signup(base, 'plan@b.com');
      const put = (name) => fetch(base + '/notes', {
        method: 'PUT', headers: authHeaders(token),
        body: JSON.stringify({ name, content: '# ' + name }),
      });
      await put('KUMIKO.md');
      await put('KUMIKO-MEMORY.md');
      await put('KUMIKO-LOG.md');
      await put('KUMIKO-PLAN — สรุป DS.md');
      await put('KUMIKOIDEAS ของฉัน.md');        // edge: ANY root KUMIKO prefix hides
      await put('วิชาเรียน/KUMIKO-PLAN — ในโฟลเดอร์.md');   // edge: subfolder KUMIKO file stays visible
      await put('ปกติ.md');

      const r = await fetch(base + '/notes', { headers: authHeaders(token) });
      const list = (await r.json()).notes;
      for (const hidden of ['KUMIKO.md', 'KUMIKO-MEMORY.md', 'KUMIKO-LOG.md', 'KUMIKO-PLAN — สรุป DS.md', 'KUMIKOIDEAS ของฉัน.md']) {
        expect(list).not.toContain(hidden);
      }
      expect(list).toContain('วิชาเรียน/KUMIKO-PLAN — ในโฟลเดอร์.md');
      expect(list).toContain('ปกติ.md');

      // hidden from the list ≠ gone: direct-rel reads still work (cards/links open them)
      const rd = await fetch(base + '/notes/content?name=' + encodeURIComponent('KUMIKO-PLAN — สรุป DS.md'), { headers: authHeaders(token) });
      expect((await rd.json()).content).toBe('# KUMIKO-PLAN — สรุป DS.md');
    } finally {
      await s.close();
    }
  }, 20000);
});
