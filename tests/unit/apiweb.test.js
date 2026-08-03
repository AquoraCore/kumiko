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

  it('runEngine degrades safely when the AI endpoint is unreachable (no server)', async () => {
    // closed local port -> fetch rejects -> catch fires done with code:-1, no output
    const api = createWebApi({ baseUrl: 'http://127.0.0.1:1', getToken: () => null, store: memStore() });
    let out = null;
    let done = null;
    api.onEngineOutput((m) => { out = m; });
    api.onEngineDone((m) => { done = m; });
    await api.runEngine({ runId: 'r' });
    expect(out).toBe(null);
    expect(done).toEqual({ runId: 'r', code: -1 });
  }, 20000);

  it('runEngine streams the managed /ai/chat reply through onEngineOutput', async () => {
    const s = await startServer({
      port: 0, dataDir: tmpDir(),
      streamChat: async function* (prompt) { yield 'Hello, '; yield 'you said: '; yield prompt; },
    });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ai@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      const parts = [];
      let done = null;
      api.onEngineOutput((m) => { parts.push(m.data); });
      api.onEngineDone((m) => { done = m; });
      await api.runEngine({ runId: 'r', prompt: 'hi' });
      // runEngine resolves only after _engineDone fires, but poll defensively.
      const ok = await new Promise((resolve) => {
        const start = Date.now();
        const tick = () => { if (done) return resolve(true); if (Date.now() - start > 5000) return resolve(false); setTimeout(tick, 20); };
        tick();
      });
      expect(ok).toBe(true);
      expect(parts.join('')).toBe('Hello, you said: hi');
      expect(done).toEqual({ runId: 'r', code: 0 });
    } finally {
      await s.close();
    }
  }, 20000);

  it('searchNotes / backlinks / graphData / listNotes folders match Electron shapes (client-side)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'web@c.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });

    try {
      // Seed a tiny vault: index wikilinks Nephron (root) + Kidney (in bio/).
      await api.saveNote('index.md', 'see [[Nephron]] and [[Kidney]] here');
      await api.saveNote('Nephron.md', '# Nephron\nit filters blood');
      await api.saveNote('bio/Kidney.md', '# Kidney\nthe organ');

      // SEARCH — empty query short-circuits; non-empty yields Electron's
      // {name, line, snippet} and finds content hits across notes.
      expect(await api.searchNotes('')).toEqual([]);
      const found = await api.searchNotes('filters');
      expect(found.some((x) => x.name === 'Nephron.md')).toBe(true);
      expect(found.every((x) => typeof x.name === 'string' && typeof x.line === 'number' && typeof x.snippet === 'string')).toBe(true);

      // BACKLINKS — string[] of rel-paths; basename match crosses folders
      // (index links [[Kidney]] -> bio/Kidney.md resolves by basename).
      expect((await api.backlinks('Nephron.md'))).toContain('index.md');
      expect((await api.backlinks('bio/Kidney.md'))).toContain('index.md');

      // GRAPH — nodes keyed by basename, edges by from→to basename pairs.
      const g = await api.graphData();
      expect(g.nodes.some((n) => n.id === 'Nephron')).toBe(true);
      expect(g.nodes.some((n) => n.id === 'index')).toBe(true);
      expect(g.nodes.some((n) => n.id === 'Kidney')).toBe(true);
      expect(g.edges.some((e) => e.from === 'index' && e.to === 'Nephron')).toBe(true);
      expect(g.edges.some((e) => e.from === 'index' && e.to === 'Kidney')).toBe(true);

      // FOLDERS — derived from note rel-paths; 'bio/Kidney.md' -> 'bio'.
      const listed = await api.listNotes();
      expect(listed.folders).toContain('bio');
      expect(listed.notes).toContain('bio/Kidney.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('ragContext builds vault context client-side', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rag@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });

    try {
      await api.saveNote('Nephron.md', '# Nephron\n\nthe nephron filters blood in the kidney');
      await api.saveNote('Mitochondria.md', '# Mitochondria\n\nmakes ATP energy');

      // HAPPY — BM25 ranks Nephron for this query; Mitochondria is irrelevant.
      const r1 = await api.ragContext('nephron kidney');
      expect(r1.context).toContain('Nephron');
      expect(r1.context.toLowerCase()).toContain('filters');
      expect(r1.sources).toContain('Nephron');
      expect(r1.context).not.toContain('Mitochondria');

      // EDGE — no lexical match -> empty; empty query -> empty context.
      const r2 = await api.ragContext('zzzznomatch qqqq');
      expect(r2).toEqual({ context: '', sources: [] });
      const r3 = await api.ragContext('');
      expect(r3.context).toBe('');
    } finally {
      await s.close();
    }
  }, 20000);
});
