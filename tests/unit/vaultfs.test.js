import { describe, it, expect } from 'vitest';
const { startServer } = require('../../server/index');
const { createWebApi } = require('../../web/api-web');
const path = require('path');
const os = require('os');

let counter = 0;
function tmpDir() {
  counter += 1;
  return path.join(os.tmpdir(), 'washi-vaultfs-' + counter + '-' + process.pid);
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

describe('web folders + trash (per-user cloud vault fs via real backend)', () => {
  it('FOLDERS HAPPY: create/list/rename/delete a folder', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'vaultfs-folders@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      expect(await api.folderCreate('bio')).toEqual({ name: 'bio' });
      // EMPTY folder shows up via the /folders merge in listNotes
      expect((await api.listNotes()).folders).toContain('bio');
      expect(await api.folderRename('bio', 'biology')).toEqual({ name: 'biology' });
      expect((await api.listNotes()).folders).toContain('biology');
      const d = await api.folderDelete('biology');
      expect(d.ok).toBe(true);
      expect((await api.listNotes()).folders).not.toContain('biology');
    } finally {
      await s.close();
    }
  }, 20000);

  it('FOLDERS EDGE: duplicate create returns {error:"exists"}', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'vaultfs-folders-edge@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      expect(await api.folderCreate('bio')).toEqual({ name: 'bio' });
      expect(await api.folderCreate('bio')).toEqual({ error: 'exists' });
    } finally {
      await s.close();
    }
  }, 20000);

  it('TRASH HAPPY: delete note -> trash -> restore', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'vaultfs-trash@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      await api.saveNote('t1.md', '# hi');
      await api.deleteNote('t1.md');
      expect((await api.listNotes()).notes).not.toContain('t1.md');
      const tl = await api.trashList();
      const ent = tl.find((x) => x.name === 't1.md');
      expect(ent).toBeTruthy();
      expect(await api.trashRestore(ent.id)).toEqual({ ok: true });
      expect((await api.listNotes()).notes).toContain('t1.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('TRASH EDGE: deleteForever + empty', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'vaultfs-trash-edge@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      await api.saveNote('t2.md', 'x');
      await api.deleteNote('t2.md');
      const id = (await api.trashList()).find((x) => x.name === 't2.md').id;
      expect(await api.trashDeleteForever(id)).toEqual({ ok: true });
      expect((await api.trashList()).some((x) => x.id === id)).toBe(false);

      await api.saveNote('t3.md', 'y');
      await api.deleteNote('t3.md');
      expect(await api.trashEmpty()).toEqual({ ok: true });
      expect((await api.trashList()).length).toBe(0);
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: folderList hides the internal pdfs dir', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const token = await signup(base, 'vaultfs-pdf-hide@b.com');
    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      expect(await api.folderCreate('realfolder')).toEqual({ name: 'realfolder' });
      // Seeding the reserved pdf store: upload a pdf so <userId>/pdfs exists.
      try { await api.uploadPdf('seed.pdf', Buffer.from('%PDF-1.4')); } catch (_) {}
      const folders = (await api.listNotes()).folders;
      expect(folders).toContain('realfolder');
      expect(folders).not.toContain('pdfs');
    } finally {
      await s.close();
    }
  }, 20000);
});
