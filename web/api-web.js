// Phase 7d-2: web window.api shim — full surface (contract parity with Electron preload).
// Storage half talks to the cloud backend (server/index.js /notes + /auth) over HTTP.
// The rest are web-specific safe implementations backed by opts.store (state/auth)
// or safe stubs (PTY, AI, derived) so the renderer boots without error.
// Dual-mode: Node require + browser global. No browser build yet (that's 7d-3).

function createWebApi(opts) {
  opts = opts || {};
  let baseUrl = opts.baseUrl || 'http://127.0.0.1:4321';
  if (baseUrl.length > 0 && baseUrl[baseUrl.length - 1] === '/') baseUrl = baseUrl.slice(0, -1);

  // localStorage-style store: explicit opts.store > global localStorage > in-memory shim.
  // ponytail: in-memory shim matches localStorage semantics (string coercion) so JSON
  // parse/stringify round-trips identically in Node tests and the browser.
  let store = opts.store;
  if (!store) {
    if (typeof localStorage !== 'undefined' && localStorage) {
      store = localStorage;
    } else {
      const mem = {};
      store = {
        getItem: (k) => (k in mem ? mem[k] : null),
        setItem: (k, v) => { mem[k] = String(v); },
        removeItem: (k) => { delete mem[k]; },
      };
    }
  }

  const getToken = opts.getToken || (() => {
    try { return (JSON.parse(store.getItem('webAuth') || 'null') || {}).token || null; }
    catch (_) { return null; }
  });

  function authHeaders(extra) {
    const token = getToken();
    return Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {},
      extra || {}
    );
  }

  // Never throws — network failure resolves to null so each caller can pick
  // its own safe fallback (renderer expects resolved values, not rejections).
  async function req(method, pathAndQuery, body) {
    try {
      return await fetch(baseUrl + pathAndQuery, {
        method,
        headers: authHeaders(),
        body: body != null ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      return null;
    }
  }

  // ---- storage: real cloud backend (7d-1) ----
  async function listNotes() {
    try {
      const res = await req('GET', '/notes');
      if (!res || !res.ok) return { notes: [], folders: [], pdfs: [] };
      const data = await res.json();
      // folders/pdfs empty — web MVP is notes-only; keep the shape the renderer expects.
      return { notes: (data && data.notes) || [], folders: [], pdfs: [] };
    } catch (_) {
      return { notes: [], folders: [], pdfs: [] };
    }
  }

  async function readNote(name) {
    try {
      const res = await req('GET', '/notes/content?name=' + encodeURIComponent(name));
      if (!res || !res.ok) return '';
      const data = await res.json();
      return (data && data.content != null) ? data.content : '';
    } catch (_) {
      return '';
    }
  }

  // ponytail: openNote returns the content string; the Electron version returns
  // a richer object. The web renderer integration (7d-3) can enrich this later —
  // a plain string is enough for the MVP note editor to render.
  async function openNote(name) {
    return readNote(name);
  }

  async function saveNote(name, content) {
    try {
      const res = await req('PUT', '/notes', { name, content: String(content == null ? '' : content) });
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  async function createNote(name) {
    try {
      const res = await req('PUT', '/notes', { name, content: '' });
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  async function deleteNote(name) {
    try {
      const res = await req('DELETE', '/notes?name=' + encodeURIComponent(name));
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  // ponytail: no backend rename endpoint; compose read+write+delete.
  // Add a server /notes/rename when atomicity matters — a crash between the
  // write and the delete currently orphans the old file under the old name.
  async function renameNote(from, to) {
    const c = await readNote(from);
    const w = await saveNote(to, c);
    if (!w || !w.ok) return { ok: false };
    await deleteNote(from);
    return { ok: true };
  }

  // ---- state / vault (web = one "cloud" vault; state in store) ----
  // SYNC — matches preload's ipcRenderer.sendSync; renderer calls this during boot.
  function vaultStateReadSync() {
    try { return JSON.parse(store.getItem('webVaultState') || 'null'); }
    catch (_) { return null; }
  }

  function vaultConfigRead(key) {
    try { return Promise.resolve(JSON.parse(store.getItem('webCfg:' + key) || 'null')); }
    catch (_) { return Promise.resolve(null); }
  }

  // Renderer persists per-vault state via vaultConfigWrite('state', VS); mirror that
  // key into 'webVaultState' so the sync read sees it next load without a second lookup.
  function vaultConfigWrite(key, data) {
    try {
      const s = JSON.stringify(data);
      store.setItem('webCfg:' + key, s);
      if (key === 'state') store.setItem('webVaultState', s);
    } catch (_) {}
    return Promise.resolve(true);
  }

  function vaultList() { return Promise.resolve([{ path: 'cloud', name: 'Cloud' }]); }
  function vaultSwitch() { return Promise.resolve({ ok: true }); }
  function vaultOpen() { return Promise.resolve({ ok: true }); }
  function vaultCreate() { return Promise.resolve({ ok: true }); }

  // ---- auth (web token in store) ----
  function authGetToken() {
    try { return Promise.resolve(JSON.parse(store.getItem('webAuth') || 'null')); }
    catch (_) { return Promise.resolve(null); }
  }
  function authSetToken(token, email) {
    try { store.setItem('webAuth', JSON.stringify({ token, email })); } catch (_) {}
    return Promise.resolve(true);
  }
  function authClear() {
    try { store.removeItem('webAuth'); } catch (_) {}
    return Promise.resolve(true);
  }

  // ---- AI (web MVP placeholders; real managed AI is 7e) ----
  function aiGetConfig() {
    return Promise.resolve({ mode: 'managed', provider: '', model: '', hasKey: { anthropic: false, zai: false } });
  }
  function aiSetConfig() {
    return aiGetConfig();
  }
  function aiSetKey() { return Promise.resolve(true); }
  function aiTestConnection() { return Promise.resolve({ ok: false, error: 'not available on web' }); }
  function ragContext() { return Promise.resolve({ context: '', sources: [] }); }

  let _engineOut = null;
  let _engineDone = null;
  function onEngineOutput(cb) { _engineOut = cb; }
  function onEngineDone(cb) { _engineDone = cb; }
  function runEngine(payload) {
    const runId = payload && payload.runId;
    if (_engineOut) _engineOut({ runId, data: 'AI is not available on the web build yet.\r\n' });
    if (_engineDone) _engineDone({ runId, code: 0 });
    return Promise.resolve();
  }
  function stopEngine() { return Promise.resolve(true); }

  // ---- pty / terminal (none on web) ----
  function startPty() {}
  function ptyInput() {}
  function ptyResize() {}
  function ptyRestart() {}
  function onPtyData() {}

  // ---- derived / not-yet-on-web (safe empties so the UI renders) ----
  function searchNotes() { return Promise.resolve([]); }
  function backlinks() { return Promise.resolve([]); }
  function noteTable() { return Promise.resolve([]); }
  function graphData() { return Promise.resolve({ nodes: [], edges: [] }); }
  function importPdf() { return Promise.resolve(null); }
  function readPdf() { return Promise.resolve(null); }
  function renamePdf() { return Promise.resolve({ ok: true }); }
  function readAnnots() { return Promise.resolve({}); }
  function saveAnnots() { return Promise.resolve(true); }
  function dbList() { return Promise.resolve([]); }
  function dbRead() { return Promise.resolve(null); }
  function dbSave() { return Promise.resolve({ ok: true }); }
  function dbCreate() { return Promise.resolve({ ok: true }); }
  function dbDelete() { return Promise.resolve({ ok: true }); }
  function folderCreate() { return Promise.resolve({ ok: true }); }
  function folderDelete() { return Promise.resolve({ ok: true }); }
  function folderRename() { return Promise.resolve({ ok: true }); }
  function trashList() { return Promise.resolve([]); }
  function trashRestore() { return Promise.resolve({ ok: true }); }
  function trashDeleteForever() { return Promise.resolve({ ok: true }); }
  function trashEmpty() { return Promise.resolve({ ok: true }); }
  function crdtLoad() { return Promise.resolve(null); }
  function crdtSave() { return Promise.resolve(true); }

  // ---- misc ----
  function openExternal(url) {
    if (typeof window !== 'undefined' && window.open) window.open(url, '_blank');
    return Promise.resolve(true);
  }
  function onNoteChanged() {}

  return {
    // storage (7d-1, real)
    listNotes, openNote, readNote, saveNote, createNote, renameNote, deleteNote,
    // state / vault
    vaultStateReadSync, vaultConfigRead, vaultConfigWrite, vaultList, vaultSwitch, vaultOpen, vaultCreate,
    // auth
    authGetToken, authSetToken, authClear,
    // ai
    aiGetConfig, aiSetConfig, aiSetKey, aiTestConnection, ragContext,
    runEngine, stopEngine, onEngineOutput, onEngineDone,
    // pty
    startPty, ptyInput, ptyResize, ptyRestart, onPtyData,
    // derived
    searchNotes, backlinks, noteTable, graphData,
    importPdf, readPdf, renamePdf, readAnnots, saveAnnots,
    dbList, dbRead, dbSave, dbCreate, dbDelete,
    folderCreate, folderDelete, folderRename,
    trashList, trashRestore, trashDeleteForever, trashEmpty,
    crdtLoad, crdtSave,
    // misc
    openExternal, onNoteChanged,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createWebApi };
if (typeof window !== 'undefined') window.createWebApi = createWebApi;
