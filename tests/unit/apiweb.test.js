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
  'listNotes', 'openNote', 'readNote', 'updateCheck', 'updateRun', 'updateRelaunch', 'updateOpenLog', 'onUpdateProgress', 'saveAsset', 'readAsset', 'pruneAssets', 'historyList', 'historyRead', 'historySnap', 'readGlobalMemory', 'saveGlobalMemory', 'importPdf', 'readPdf', 'renamePdf', 'readAnnots', 'saveAnnots',
  'saveNote', 'onNoteChanged', 'onNoteFlagged', 'createNote', 'renameNote', 'deleteNote', 'searchNotes', 'backlinks',
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

  it('HAPPY: createNote returns { name } and the note shows up in listNotes', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'create@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      const res = await api.createNote('NewNote.md');
      expect(res.name).toBe('NewNote.md');
      expect((await api.listNotes()).notes).toContain('NewNote.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('HAPPY: createNote appends .md when missing', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'noext@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      const res = await api.createNote('NoExt');
      expect(res.name).toBe('NoExt.md');
      expect((await api.listNotes()).notes).toContain('NoExt.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('EDGE: createNote against a logged-out backend returns { error } (no throw)', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const api = createWebApi({ baseUrl: base, getToken: () => null });
    try {
      const res = await api.createNote('Nope.md');
      expect(res.error).toBe('failed');
      expect((await api.listNotes()).notes).not.toContain('Nope.md');
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

  it('global memory round-trips per user and NEVER leaks across accounts', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const signup = async (email) => {
      const r = await fetch(base + '/auth/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' }),
      });
      return (await r.json()).token;
    };
    try {
      const tokA = await signup('gmem-a@b.com');
      const tokB = await signup('gmem-b@b.com');
      const apiA = createWebApi({ baseUrl: base, getToken: () => tokA, store: memStore() });
      const apiB = createWebApi({ baseUrl: base, getToken: () => tokB, store: memStore() });
      // happy: A writes their profile and reads it back verbatim
      expect(await apiA.readGlobalMemory()).toBe('');
      await apiA.saveGlobalMemory('## ผู้ใช้\n\n- ตอบไทยเสมอ <!--k 2026-08-29-->\n');
      expect(await apiA.readGlobalMemory()).toContain('ตอบไทยเสมอ');
      // isolation: B sees an empty profile, and B's write does not touch A's
      expect(await apiB.readGlobalMemory()).toBe('');
      await apiB.saveGlobalMemory('## ผู้ใช้\n\n- ของ B');
      expect(await apiA.readGlobalMemory()).toContain('ตอบไทยเสมอ');
      expect(await apiA.readGlobalMemory()).not.toContain('ของ B');
      // edge: logged-out shim degrades to empty read / {error} write
      const apiOut = createWebApi({ baseUrl: base, getToken: () => null, store: memStore() });
      expect(await apiOut.readGlobalMemory()).toBe('');
      expect(await apiOut.saveGlobalMemory('x')).toEqual({ error: 'failed' });
    } finally {
      await s.close();
    }
  }, 20000);

  it('exposes every method the Electron preload defines (contract parity, 70)', () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    const missing = PRELOAD_METHODS.filter((n) => typeof api[n] !== 'function');
    expect(missing).toEqual([]);
    expect(PRELOAD_METHODS.length).toBe(70);
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

      const names = (r) => (r.sources || []).map((s) => (s && typeof s === 'object') ? s.name : s);
      // HAPPY — BM25 ranks Nephron for this query; Mitochondria is irrelevant.
      const r1 = await api.ragContext('nephron kidney');
      expect(r1.context).toContain('Nephron');
      expect(r1.context.toLowerCase()).toContain('filters');
      expect(names(r1)).toContain('Nephron');
      expect(r1.context).not.toContain('Mitochondria');
      // sources now carry a reason label (tiered RAG)
      expect(r1.sources[0]).toHaveProperty('reason');

      // EDGE — no lexical match -> empty; empty query -> empty context.
      const r2 = await api.ragContext('zzzznomatch qqqq');
      expect(r2).toEqual({ context: '', sources: [] });
      const r3 = await api.ragContext('');
      expect(r3.context).toBe('');

      // EXCLUDE — the OPEN doc is P1 upstream, so RAG must NOT re-inject it. With Nephron
      // excluded, its body disappears from the RAG block entirely (no double-injection).
      const r4 = await api.ragContext('nephron kidney', { exclude: ['Nephron'] });
      expect(r4.context).not.toContain('filters');
      expect(names(r4)).not.toContain('Nephron');

      // ANCHOR — with Nephron open (as docQuery) + a note that LINKS to it, the explicit graph
      // channel surfaces the linker even though the question is generic.
      await api.saveNote('Glomerulus.md', '# Glomerulus\n\npart of the [[Nephron]] that filters');
      const r5 = await api.ragContext('anatomy', { openName: 'Nephron', docQuery: 'Nephron kidney', outlinks: [] });
      expect(names(r5)).toContain('Glomerulus');
      expect(r5.sources.find((s) => s.name === 'Glomerulus').reason).toBe('linked');

      // MENTION (Phase 2) — a note naming "Nephron" verbatim WITHOUT a [[link]] is a Tier-2 tie.
      // It is a BOOST, not an admission ticket: it surfaces when it also matches the question...
      await api.saveNote('Casual.md', '# Casual\n\nthe Nephron came up in lecture today');
      const r6 = await api.ragContext('lecture', { openName: 'Nephron', docQuery: 'Nephron kidney' });
      const casual = r6.sources.find((s) => s.name === 'Casual');
      expect(casual).toBeTruthy();
      expect(casual.reason).toBe('mention');

      // ...and is NOT injected when it has nothing to do with the question (the bug that made the
      // same notes reappear in every single answer).
      const r7 = await api.ragContext('zzzznomatch qqqq', { openName: 'Nephron', docQuery: 'Nephron kidney' });
      expect(names(r7)).not.toContain('Casual');
    } finally {
      await s.close();
    }
  }, 20000);

  it('renameNote rewrites [[links]] in other notes', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'rename@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      await api.saveNote('Alpha.md', '# Alpha\n\nsee [[Beta]] here');
      await api.saveNote('Beta.md', '# Beta\n\nbody');
      await api.renameNote('Beta.md', 'Gamma.md');
      const alpha = await api.readNote('Alpha.md');
      expect(alpha).toContain('[[Gamma]]');
      expect(alpha).not.toContain('[[Beta]]');
      expect((await api.listNotes()).notes).toContain('Gamma.md');
      expect((await api.listNotes()).notes).not.toContain('Beta.md');
    } finally {
      await s.close();
    }
  }, 20000);

  it('aiSetKey/aiGetConfig round-trip', async () => {
    const api = createWebApi({ baseUrl: 'http://x', getToken: () => null, store: memStore() });
    await api.aiSetKey('zai', 'k');
    expect((await api.aiGetConfig()).hasKey.zai).toBe(true);
    await api.aiSetKey('zai', '');
    expect((await api.aiGetConfig()).hasKey.zai).toBe(false);
  });

  it('runEngine sends the user API key when set', async () => {
    let seen = null;
    const s = await startServer({
      port: 0, dataDir: tmpDir(),
      streamChat: async function* (prompt, creds) { seen = creds; yield 'ok'; },
    });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'userkey@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      await api.aiSetKey('zai', 'sk-user');
      await api.aiSetConfig({ provider: 'zai', model: 'glm-5.2' });

      const parts = [];
      let done = false;
      api.onEngineOutput((m) => { parts.push(m.data); });
      api.onEngineDone(() => { done = true; });
      await api.runEngine({ runId: 'r', prompt: 'hi' });
      const ok = await new Promise((resolve) => {
        const start = Date.now();
        const tick = () => { if (done) return resolve(true); if (Date.now() - start > 5000) return resolve(false); setTimeout(tick, 20); };
        tick();
      });
      expect(ok).toBe(true);
      expect(parts.join('')).toBe('ok');
      expect(seen).toEqual({ provider: 'zai', key: 'sk-user', model: 'glm-5.2', thinking: null, images: [] });
    } finally {
      await s.close();
    }
  }, 20000);

  it('noteTable returns rows with status/tags/backlinks', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;

    let r = await fetch(base + '/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'table@b.com', password: 'password123' }),
    });
    expect(r.status).toBe(200);
    let token = (await r.json()).token;

    const api = createWebApi({ baseUrl: base, getToken: () => token });
    try {
      await api.saveNote('Kidney.md', '---\nstatus: อ่านแล้ว\ntags: bio\n---\n# Kidney\n\nthe kidney');
      await api.saveNote('Nephron.md', '# Nephron\n\npart of the [[Kidney]] system');
      const rows = await api.noteTable();
      const kidney = rows.find(r => r.name === 'Kidney.md');
      expect(kidney.status).toBe('อ่านแล้ว');
      expect(kidney.tags).toBe('bio');
      expect(kidney.backlinks).toBe(1);
      const nephron = rows.find(r => r.name === 'Nephron.md');
      expect(nephron.backlinks).toBe(0);
    } finally {
      await s.close();
    }
  }, 20000);
  it('note image assets: save → read → <img> URL token access · isolated per user', async () => {
    const s = await startServer({ port: 0, dataDir: tmpDir() });
    const base = 'http://127.0.0.1:' + s.port;
    const signup = async (email) => {
      const r = await fetch(base + '/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'password123' }) });
      return (await r.json()).token;
    };
    try {
      const tokA = await signup('asset-a@b.com');
      const tokB = await signup('asset-b@b.com');
      const apiA = createWebApi({ baseUrl: base, getToken: () => tokA, store: memStore() });
      const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      // happy: save (name sanitized) → read back a data URI → tokenized URL loads without headers
      const r = await apiA.saveAsset('สไลด์/ทดสอบ p1', px);
      expect(r.rel).toMatch(/^assets\/.+\.png$/);
      expect(r.rel).not.toContain('/ทดสอบ');   // "/" sanitized out of the NAME half
      expect(await apiA.readAsset(r.rel)).toMatch(/^data:image\/png;base64,/);
      expect((await fetch(apiA.assetUrl(r.rel))).status).toBe(200);
      // edge: another user's token cannot reach it (per-user vault dirs) → 404
      expect((await fetch(base + '/assets/content?name=' + encodeURIComponent(r.rel) + '&t=' + encodeURIComponent(tokB))).status).toBe(404);
      // edge: no token → 401 · traversal-shaped name → 400 · junk uri → error
      expect((await fetch(base + '/assets/content?name=' + encodeURIComponent(r.rel))).status).toBe(401);
      expect((await fetch(base + '/assets/content?name=' + encodeURIComponent('assets/../x.md') + '&t=' + encodeURIComponent(tokA))).status).toBe(400);
      expect((await apiA.saveAsset('x', 'not-a-uri')).error).toBeTruthy();
    } finally {
      await s.close();
    }
  }, 20000);
});
