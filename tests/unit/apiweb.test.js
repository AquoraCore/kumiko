import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createWebApi } = require('../../web/api-web');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-apiweb-' + counter + '-' + process.pid);
}

describe('web api shim', () => {
  it('the web api shim round-trips notes through the cloud backend', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    // signup a user, capture its token in a mutable cell the shim reads via getToken
    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'web@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let body = await r.json();
    let token = body.token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });

    try {
      await api.createNote('a.md');
      await api.saveNote('a.md', '# Hello');

      const listed = await api.listNotes();
      expect(listed.notes).toContain('a.md');
      expect(listed.folders).toEqual([]);
      expect(listed.pdfs).toEqual([]);

      expect(await api.readNote('a.md')).toBe('# Hello');
      expect(await api.openNote('a.md')).toBe('# Hello');

      await api.saveNote('sub/deep.md', 'nested');
      expect((await api.listNotes()).notes).toContain('sub/deep.md');

      await api.renameNote('a.md', 'b.md');
      const afterRename = await api.listNotes();
      expect(afterRename.notes).toContain('b.md');
      expect(afterRename.notes).not.toContain('a.md');
      expect(await api.readNote('b.md')).toBe('# Hello');

      await api.deleteNote('b.md');
      expect((await api.listNotes()).notes).not.toContain('b.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('logged-out shim degrades safely (no token)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    // no signup, no token — every call hits a 401 and must resolve to a safe fallback
    const api2 = createWebApi({ baseUrl: base, getToken: () => null });

    try {
      const listed = await api2.listNotes();
      expect(listed).toEqual({ notes: [], folders: [], pdfs: [] });
      expect(await api2.readNote('x.md')).toBe('');
      expect(await api2.saveNote('x.md', 'y')).toEqual({ ok: false });
    } finally {
      await s.close();
    }
  }, 20000);
});
