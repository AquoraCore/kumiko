// Phase 7d-2: web window.api shim — full surface (contract parity with Electron preload).
// Storage half talks to the cloud backend (server/index.js /notes + /auth) over HTTP.
// The rest are web-specific safe implementations backed by opts.store (state/auth)
// or safe stubs (PTY, AI, derived) so the renderer boots without error.
// Dual-mode: Node require + browser global. No browser build yet (that's 7d-3).

// ---- pure helpers (mirror core/wikilinks + core/pathutil so the renderer
// consumes search/backlinks/graph output unchanged from the Electron shapes) ----
// Same tolerant regex as core/wikilinks: matches [[Note]], \[\[Note]], [[Note|alias]].
function _wikiTargets(text){
  const re = /\\?\[\\?\[([^\[\]\n]+?)\\?\]\\?\]/g;
  const out = []; let m;
  while ((m = re.exec(text || ''))) {
    const t = String(m[1]).split('|')[0].trim();
    if (t) out.push(t);
  }
  return out;
}
// Same semantics as core/pathutil baseName: strip dir + .md suffix.
function _baseName(rel){
  const b = String(rel || '').split('/').pop();
  return b.replace(/\.md$/i, '');
}

// Dual-mode CoreRag: browser global (set by core/rag.js UMD wrapper) else Node require.
// ponytail: null when neither is available (e.g. sandbox without the script) —
// ragContext then degrades to the empty fallback instead of throwing.
const _rag = (typeof window !== 'undefined' && window.CoreRag) ? window.CoreRag : (typeof require !== 'undefined' ? require('../core/rag') : null);

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
    let notes = [];
    try {
      const res = await req('GET', '/notes');
      if (!res || !res.ok) return { notes: [], folders: [], pdfs: [] };
      const data = await res.json();
      notes = (data && data.notes) || [];
    } catch (_) {
      return { notes: [], folders: [], pdfs: [] };
    }
    // Side-channel fetch of the user's pdfs; guarded — never breaks note listing.
    let pdfs = [];
    try {
      const pr = await req('GET', '/pdfs');
      if (pr && pr.ok) { const pd = await pr.json(); pdfs = (pd && pd.pdfs) || []; }
    } catch (_) {}
    // Derive folders from note rel-paths (web has no filesystem to walk): each
    // path prefix becomes a folder, e.g. 'a/b/c.md' -> 'a' and 'a/b'. Matches
    // Electron note:list which returns notes/folders/pdfs/companions.
    let folders = _foldersOf(notes);
    // Merge in EMPTY server folders (ones no note lives under). /folders walks
    // the userDir on the server so empty dirs surface here too. Guarded so a
    // missing/failed fetch never breaks note listing.
    try {
      const fr = await req('GET', '/folders');
      if (fr && fr.ok) {
        const fd = await fr.json();
        const set = new Set(folders);
        for (const f of ((fd && fd.folders) || [])) set.add(f);
        folders = Array.from(set).sort();
      }
    } catch (_) {}
    return { notes, folders, pdfs, companions: {} };
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

  // Directory prefixes of a set of `/`-separated rel-paths. ponytail: cloud
  // paths are unix-style; server never emits `\`, so `/`-split is enough.
  function _foldersOf(notes){
    const set = new Set();
    for (const n of notes){
      const parts = String(n).split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return Array.from(set).sort();
  }

  // Fetch every note's content. ponytail: N reads (one per note) — fine for a
  // personal vault; if this gets slow, add a server /notes/all endpoint later.
  async function _allNotes(){
    const l = await listNotes();
    const names = (l && l.notes) || [];
    const out = [];
    for (const n of names) out.push({ name: n, content: await readNote(n) });
    return out;
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
      let final = String(name || '').trim();
      if (!final) return { error: 'invalid' };
      if (!final.toLowerCase().endsWith('.md')) final += '.md';
      const res = await req('PUT', '/notes', { name: final, content: '' });
      if (!res || !res.ok) return { error: 'failed' };
      const data = await res.json();
      if (data && data.ok) return { name: final };
      return { error: 'failed' };
    } catch (_) {
      return { error: 'failed' };
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

  // ---- AI (web: streams the managed /ai/chat proxy; config via /ai/config) ----
  function aiGetConfig() {
    return Promise.resolve({ mode: 'managed', provider: '', model: '', hasKey: { anthropic: false, zai: false } });
  }
  function aiSetConfig() {
    return aiGetConfig();
  }
  function aiSetKey() { return Promise.resolve(true); }
  function aiTestConnection() { return Promise.resolve({ ok: false, error: 'not available on web' }); }
  // LEXICAL BM25 + wikilink expansion over the user's cloud notes — mirrors
  // main.js buildVaultContext (lexical-only branch). ponytail: no embeddings
  // on web for now; semantic fusion is a future step. Never throws — {} on error.
  async function ragContext(question) {
    try {
      if (!_rag) return { context: '', sources: [] };
      const all = await _allNotes();
      const docs = all.map((n) => ({ id: n.name, name: _baseName(n.name), text: n.content || '' }));
      if (!docs.length) return { context: '', sources: [] };
      // wikilink graph: id -> [neighbour ids], resolved by basename (first-wins), like buildVaultContext
      const baseToId = {};
      for (const d of docs) { const k = d.name.toLowerCase(); if (!(k in baseToId)) baseToId[k] = d.id; }
      const linkGraph = {};
      for (const d of docs) {
        const nb = [], seen = {};
        for (const raw of _wikiTargets(d.text)) {
          const tid = baseToId[String(raw).toLowerCase().trim()];
          if (tid && tid !== d.id && !seen[tid]) { seen[tid] = 1; nb.push(tid); }
        }
        linkGraph[d.id] = nb;
      }
      const index = _rag.buildIndex(docs);
      const ranked = _rag.rank(question, index, 6);
      if (!ranked.length) return { context: '', sources: [] };
      let orderedIds = _rag.expandByLinks(ranked.map((r) => r.id), linkGraph, 1);
      if (orderedIds.length > 10) orderedIds = orderedIds.slice(0, 10);
      const byId = {}; for (const d of docs) byId[d.id] = d;
      const entries = [];
      for (const id of orderedIds) {
        const d = byId[id];
        if (d) entries.push({ id: d.id, name: d.name, text: d.text });
      }
      const context = _rag.buildContextBlock(entries, 6000);
      const sources = entries.filter((d) => d.text && String(d.text).trim() !== '').map((d) => d.name);
      return { context, sources };
    } catch (_) {
      return { context: '', sources: [] };
    }
  }

  let _engineOut = null;
  let _engineDone = null;
  function onEngineOutput(cb) { _engineOut = cb; }
  function onEngineDone(cb) { _engineDone = cb; }
  // Streams the managed /ai/chat reply: each chunk -> onEngineOutput, then
  // onEngineDone({code:0}). Unreachable/non-ok -> [AI unavailable] + code:-1.
  // ponytail: stopEngine stays a no-op; a fetch AbortController is a future nicety.
  async function runEngine(payload) {
    const runId = payload && payload.runId;
    const prompt = (payload && payload.prompt) || '';
    try {
      const res = await fetch(baseUrl + '/ai/chat', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ prompt }) });
      if (!res.ok || !res.body) {
        if (_engineOut) _engineOut({ runId, data: '[AI unavailable]\r\n' });
        if (_engineDone) _engineDone({ runId, code: -1 });
        return;
      }
      const reader = res.body.getReader(); const dec = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        const chunk = dec.decode(value, { stream: true });
        if (chunk && _engineOut) _engineOut({ runId, data: chunk });
      }
      if (_engineDone) _engineDone({ runId, code: 0 });
    } catch (_) {
      if (_engineDone) _engineDone({ runId, code: -1 });
    }
  }
  function stopEngine() { return Promise.resolve(true); }

  // ---- pty / terminal (none on web) ----
  function startPty() {}
  function ptyInput() {}
  function ptyResize() {}
  function ptyRestart() {}
  function onPtyData() {}

  // ---- derived: computed client-side over /notes (Electron shapes) ----
  // Matches ipc note:search: {name, line:0+name match, else 1-indexed line}, cap 40.
  async function searchNotes(q) {
    const ql = String(q || '').trim().toLowerCase();
    if (!ql) return [];
    const results = [];
    for (const { name, content } of await _allNotes()) {
      if (name.toLowerCase().includes(ql)) results.push({ name, line: 0, snippet: name });
      const lines = String(content).split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(ql)) {
          results.push({ name, line: i + 1, snippet: lines[i].trim().slice(0, 120) });
        }
        if (results.length >= 40) return results;
      }
    }
    return results;
  }

  // Matches ipc note:backlinks: string[] of rel-paths whose wikilinks target
  // the basename of `name` (case-insensitive). Self skipped on exact rel-path.
  async function backlinks(name) {
    const base = _baseName(name).toLowerCase();
    const out = [];
    for (const { name: f, content } of await _allNotes()) {
      if (f === name) continue;
      if (_wikiTargets(content).some((t) => t.toLowerCase() === base)) out.push(f);
    }
    return out;
  }

  // Matches ipc graph:data: nodes deduped by lowercased basename (first wins),
  // edges per from→to pair, skip self-edges and targets with no node.
  async function graphData() {
    const notes = await _allNotes();
    const fileByBase = {};
    for (const { name } of notes) {
      const k = _baseName(name).toLowerCase();
      if (!(k in fileByBase)) fileByBase[k] = name;
    }
    const nodes = Object.keys(fileByBase).map((k) => ({ id: _baseName(fileByBase[k]), file: fileByBase[k] }));
    const edgeSeen = new Set(); const edges = [];
    for (const { name, content } of notes) {
      const fromKey = _baseName(name).toLowerCase();
      for (const raw of _wikiTargets(content)) {
        const toKey = raw.toLowerCase();
        if (!fileByBase[toKey] || toKey === fromKey) continue;
        const key = fromKey + '->' + toKey;
        if (edgeSeen.has(key)) continue; edgeSeen.add(key);
        edges.push({ from: _baseName(fileByBase[fromKey] || name), to: _baseName(fileByBase[toKey]) });
      }
    }
    return { nodes, edges };
  }

  function noteTable() { return Promise.resolve([]); }

  // ---- pdfs (per-user cloud PDF storage; mirrors Electron pdf:* handlers) ----
  // TESTABLE upload: raw octet-stream POST. Uses fetch directly (NOT `req`,
  // which JSON-stringifies the body) so the bytes flow through untouched.
  // ponytail: bytes accepted as Buffer/Uint8Array/ArrayBuffer — fetch handles all.
  async function uploadPdf(name, bytes) {
    try {
      const res = await fetch(baseUrl + '/pdfs/upload?name=' + encodeURIComponent(name), {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/octet-stream' }),
        body: bytes,
      });
      if (!res || !res.ok) return null;
      const d = await res.json();
      return { name: d.name };
    } catch (_) {
      return null;
    }
  }

  // BROWSER-ONLY picker (the one piece that needs a real DOM and so can't be
  // unit-tested). importPdf = pick a file via a hidden <input type=file>, then
  // hand the bytes to uploadPdf. Non-browser -> null. If the user cancels the
  // picker there is no reliable event, so the promise stays pending (matches a
  // canceled native dialog). Never throws — resolves null on any failure.
  async function importPdf() {
    if (typeof document === 'undefined') return null;
    return await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/pdf';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = async () => {
        try {
          const file = input.files && input.files[0];
          if (!file) { resolve(null); return; }
          const buf = await file.arrayBuffer();
          const r = await uploadPdf(file.name, new Uint8Array(buf));
          resolve(r);
        } catch (_) {
          resolve(null);
        } finally {
          try { input.remove(); } catch (__) {}
        }
      };
      input.click();
    });
  }

  // readPdf MUST resolve to a Uint8Array (or ArrayBuffer) on web — the renderer
  // does `pdfjsLib.getDocument({data})` with the result. Guarded; never throws.
  async function readPdf(name) {
    try {
      const res = await fetch(baseUrl + '/pdfs/read?name=' + encodeURIComponent(name), {
        method: 'GET',
        headers: authHeaders(),
      });
      if (!res || !res.ok) return null;
      const ab = await res.arrayBuffer();
      return new Uint8Array(ab);
    } catch (_) {
      return null;
    }
  }

  async function renamePdf(from, to) {
    try {
      const res = await req('POST', '/pdfs/rename', { from, to });
      if (!res || !res.ok) return { error: 'failed' };
      return await res.json();
    } catch (_) {
      return { error: 'failed' };
    }
  }

  async function readAnnots(name) {
    try {
      const res = await req('GET', '/pdfs/annots?name=' + encodeURIComponent(name));
      if (!res || !res.ok) return { highlights: [] };
      return await res.json();
    } catch (_) {
      return { highlights: [] };
    }
  }

  async function saveAnnots(name, data) {
    try {
      const res = await req('PUT', '/pdfs/annots', { name, data });
      if (!res || !res.ok) return false;
      const d = await res.json();
      return d.ok === true;
    } catch (_) {
      return false;
    }
  }

  // ---- databases (per-user cloud DB storage) ----
  // Matches Electron main.js db shapes; renderer's DB module consumes these
  // unchanged. dbCreate seeds client-side (same seed as Electron) then saves.
  async function dbList() {
    try {
      const res = await req('GET', '/dbs');
      if (!res || !res.ok) return [];
      const data = await res.json();
      return (data && data.dbs) || [];
    } catch (_) {
      return [];
    }
  }

  async function dbRead(id) {
    try {
      const res = await req('GET', '/dbs/one?id=' + encodeURIComponent(id));
      if (!res || !res.ok) return null;
      const data = await res.json();
      return (data && data.db) || null;
    } catch (_) {
      return null;
    }
  }

  async function dbSave(db) {
    try {
      const res = await req('PUT', '/dbs', { db });
      if (!res || !res.ok) return false;
      const data = await res.json();
      return !!(data && data.ok === true);
    } catch (_) {
      return false;
    }
  }

  async function dbDelete(id) {
    try {
      const res = await req('DELETE', '/dbs?id=' + encodeURIComponent(id));
      if (!res || !res.ok) return false;
      const data = await res.json();
      return !!(data && data.ok === true);
    } catch (_) {
      return false;
    }
  }

  async function dbCreate(opts) {
    const o = opts || {};
    const id = 'db_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
    const db = {
      id,
      name: o.name || 'ฐานข้อมูลใหม่',
      icon: o.icon || '',
      columns: [
        { id: 'c1', name: 'ชื่อ', type: 'text' },
        { id: 'c2', name: 'สถานะ', type: 'select', options: [
          { name: 'ยังไม่เริ่ม', color: 'gray' },
          { name: 'กำลังทำ', color: 'amber' },
          { name: 'เสร็จ', color: 'green' },
        ] },
        { id: 'c3', name: 'เสร็จ', type: 'checkbox' },
      ],
      rows: [ { id: 'r' + Date.now().toString(36), c1: '', c2: '', c3: false } ],
    };
    await dbSave(db);
    return db;
  }

  // ---- folders + trash (per-user cloud storage; mirrors Electron folder:* + trash:*) ----
  // Never throws — network failure returns {error:'failed'}/{ok:false} so the renderer keeps working.
  async function folderCreate(name) {
    try {
      const res = await req('POST', '/folders', { path: name });
      if (!res) return { error: 'failed' };
      const data = await res.json();
      if (data && data.name) return data;
      return data || { error: 'failed' };
    } catch (_) {
      return { error: 'failed' };
    }
  }

  async function folderDelete(name) {
    try {
      const res = await req('DELETE', '/folders?path=' + encodeURIComponent(name));
      if (!res) return { ok: false };
      return await res.json();
    } catch (_) {
      return { ok: false };
    }
  }

  async function folderRename(from, to) {
    try {
      const res = await req('POST', '/folders/rename', { from, to });
      if (!res) return { error: 'failed' };
      return await res.json();
    } catch (_) {
      return { error: 'failed' };
    }
  }

  async function trashList() {
    try {
      const res = await req('GET', '/trash');
      if (!res || !res.ok) return [];
      const data = await res.json();
      return (data && data.trash) || [];
    } catch (_) {
      return [];
    }
  }

  async function trashRestore(id) {
    try {
      const res = await req('POST', '/trash/restore', { id });
      if (!res) return { error: 'failed' };
      return await res.json();
    } catch (_) {
      return { error: 'failed' };
    }
  }

  async function trashDeleteForever(id) {
    try {
      const res = await req('POST', '/trash/deleteForever', { id });
      if (!res) return { ok: false };
      return await res.json();
    } catch (_) {
      return { ok: false };
    }
  }

  async function trashEmpty() {
    try {
      const res = await req('POST', '/trash/empty');
      if (!res) return { ok: false };
      return await res.json();
    } catch (_) {
      return { ok: false };
    }
  }
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
    importPdf, uploadPdf, readPdf, renamePdf, readAnnots, saveAnnots,
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
