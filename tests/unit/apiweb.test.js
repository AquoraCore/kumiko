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

// In-memory localStorage-shaped store for Node tests (the shim's default opts.store path).
function memStore() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
  };
}

// Every function name preload.js exposes on window.api (56). collabRelay is a string
// value, not a function, so it's intentionally absent. This list IS the contract:
// if the shim is missing any of these, the renderer hits an undefined call at boot.
const PRELOAD_METHODS = [
  'startPty', 'ptyInput', 'ptyResize', 'ptyRestart', 'onPtyData',
  'listNotes', 'openNote', 'readNote', 'importPdf', 'readPdf', 'renamePdf', 'readAnnots', 'saveAnnots',
  'saveNote', 'onNoteChanged', 'createNote', 'renameNote', 'deleteNote', 'searchNotes', 'backlinks',
  'crdtLoad', 'crdtSave', 'noteTable', 'graphData',
  'dbList', 'dbRead', 'dbSave', 'dbCreate', 'dbDelete', 'folderCreate', 'folderRename', 'folderDelete',
  'trashList', 'trashRestore', 'trashDeleteForever', 'trashEmpty',
  'runEngine', 'stopEngine', 'onEngineOutput', 'onEngineDone',
  'openExternal',
  'vaultList', 'vaultSwitch', 'vaultOpen', 'vaultCreate', 'vaultConfigRead', 'vaultConfigWrite', 'vaultStateReadSync',
  'aiGetConfig', 'aiSetConfig', 'aiSetKey', 'aiTestConnection', 'ragContext',
  'authSetToken', 'authGetToken', 'authClear',
];

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

  it('exposes every method the Electron preload defines (contract parity, 56)', () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    const missing = PRELOAD_METHODS.filter((n) => typeof api[n] !== 'function');
    expect(missing).toEqual([]);
    expect(PRELOAD_METHODS.length).toBe(56);
  });

  it('vault state round-trips through store (vaultStateReadSync is sync)', async () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    expect(api.vaultStateReadSync()).toBe(null); // empty store
    await api.vaultConfigWrite('state', { a: 1 });
    // sync read sees the mirror written by vaultConfigWrite('state', ...)
    expect(api.vaultStateReadSync()).toEqual({ a: 1 });
    // arbitrary config key round-trips via the async read
    await api.vaultConfigWrite('x', { b: 2 });
    expect(await api.vaultConfigRead('x')).toEqual({ b: 2 });
    expect(await api.vaultConfigRead('missing')).toBe(null);
  });

  it('auth token round-trips through store', async () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    expect(await api.authGetToken()).toBe(null);
    await api.authSetToken('T', 'e@e.com');
    expect(await api.authGetToken()).toEqual({ token: 'T', email: 'e@e.com' });
    await api.authClear();
    expect(await api.authGetToken()).toBe(null);
  });

  it('derived stubs and pty no-ops never throw', async () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    await Promise.all([
      api.searchNotes('x'), api.dbList(), api.trashList(), api.graphData(),
      api.ragContext('x'), api.aiGetConfig(),
    ]);
    expect(api.vaultStateReadSync()).toBe(null);
    api.startPty();
    api.ptyInput('x');
    api.ptyResize({ cols: 80, rows: 24 });
    api.ptyRestart({ cols: 80, rows: 24 });
    api.onPtyData(() => {});
  });

  it('runEngine emits the web AI-not-available notice via the output callback', async () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    let out = null;
    let done = null;
    api.onEngineOutput((m) => { out = m; });
    api.onEngineDone((m) => { done = m; });
    await api.runEngine({ runId: 'r' });
    expect(out).not.toBe(null);
    expect(out.runId).toBe('r');
    expect(String(out.data)).toContain('not available');
    expect(done).toEqual({ runId: 'r', code: 0 });
  });
});
