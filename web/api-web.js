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
// Dual-mode CoreWikilinks: browser global (set by core/wikilinks.js UMD wrapper) else Node require.
// ponytail: null when neither is available — renameNote then skips link rewrite instead of throwing.
const _wl = (typeof window !== 'undefined' && window.CoreWikilinks) ? window.CoreWikilinks
          : (typeof require !== 'undefined' ? require('../core/wikilinks') : null);
// Dual-mode CoreFrontmatter: browser global (set by core/frontmatter.js UMD wrapper) else Node require.
// ponytail: null when neither is available — noteTable then skips frontmatter parsing instead of throwing.
const _fm = (typeof window !== 'undefined' && window.CoreFrontmatter) ? window.CoreFrontmatter
          : (typeof require !== 'undefined' ? require('../core/frontmatter') : null);

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

  function _curVault() { try { return store.getItem('webCurrentVault') || null; } catch (_) { return null; } }

  function authHeaders(extra) {
    const token = getToken(); const v = _curVault();
    return Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {},
      v ? { 'x-vault': v } : {},
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
      // KUMIKO.md + KUMIKO-MEMORY.md are hidden from every list-driven surface (parity with
      // the desktop walker)
      notes = ((data && data.notes) || []).filter(function (n) { return n !== 'KUMIKO.md' && n !== 'KUMIKO-MEMORY.md'; });
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

  // Global memory (KUMIKO-GLOBAL.md): per-USER, cross-vault — the profile cards that follow
  // the person across every vault. Never throws — failures read as an empty profile.
  async function updateCheck() { return { behind: 0 }; }   // web = server-deployed, no git pull
  async function readGlobalMemory() {
    try {
      const res = await req('GET', '/memory/global');
      if (!res || !res.ok) return '';
      const data = await res.json();
      return (data && data.content != null) ? data.content : '';
    } catch (_) {
      return '';
    }
  }
  async function saveGlobalMemory(content) {
    try {
      const res = await req('PUT', '/memory/global', { content: String(content || '') });
      return (res && res.ok) ? await res.json() : { error: 'failed' };
    } catch (_) {
      return { error: 'failed' };
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

  // Fetch every note's content, cached for 15s — chat needs the whole corpus per question, and
  // without the cache the shim refetched EVERY note over HTTP each time. Mutations bust it.
  let _allNotesCache = { t: 0, v: null };
  function _bustNotes(){ _allNotesCache = { t: 0, v: null }; }
  async function _allNotes(){
    if (_allNotesCache.v && (Date.now() - _allNotesCache.t) < 15000) return _allNotesCache.v;
    const l = await listNotes();
    const names = (l && l.notes) || [];
    const out = [];
    for (const n of names) out.push({ name: n, content: await readNote(n) });
    _allNotesCache = { t: Date.now(), v: out };
    return out;
  }

  // ponytail: openNote returns the content string; the Electron version returns
  // a richer object. The web renderer integration (7d-3) can enrich this later —
  // a plain string is enough for the MVP note editor to render.
  function onNoteFlagged() { /* web: no external FS watcher */ }
  async function openNote(name) {
    return readNote(name);
  }

  async function saveNote(name, content) {
    try {
      const res = await req('PUT', '/notes', { name, content: String(content == null ? '' : content) });
      if (!res || !res.ok) return { ok: false };
      const data = await res.json();
      if (data && data.ok) _bustNotes();
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
      if (data && data.ok) { _bustNotes(); return { name: final }; }
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
      if (data && data.ok) _bustNotes();
      return { ok: !!(data && data.ok) };
    } catch (_) {
      return { ok: false };
    }
  }

  // ponytail: no backend rename endpoint; compose read+write+delete.
  // Add a server /notes/rename when atomicity matters — a crash between the
  // write and the delete currently orphans the old file under the old name.
  // After the move, rewrite [[links]] that pointed to the old basename across
  // every other note so links don't break (parity with the desktop renameNote).
  async function renameNote(from, to) {
    const c = await readNote(from);
    const w = await saveNote(to, c);
    if (!w || !w.ok) return { ok: false };
    await deleteNote(from);
    // rewrite [[links]] that pointed to the old basename -> new basename
    try {
      if (_wl && _wl.rewriteLinkTargets) {
        const oldBase = _baseName(from);
        const newBase = _baseName(to);
        if (oldBase && newBase && oldBase !== newBase) {
          const all = await _allNotes();
          for (const n of all) {
            if (n.name === from || n.name === to) continue;
            const rewritten = _wl.rewriteLinkTargets(n.content || '', oldBase, newBase);
            if (rewritten !== (n.content || '')) { await saveNote(n.name, rewritten); }
          }
        }
      }
    } catch (_) {}
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

  async function vaultList() {
    try {
      const res = await req('GET', '/vaults');
      const arr = (res && res.ok) ? ((await res.json()).vaults || []) : [];
      if (!arr.length) return { current: null, recents: [] };
      const curId = _curVault();
      const cur = arr.find((v) => v.id === curId) || arr[0];
      return {
        current: { name: cur.name, path: cur.id },
        recents: arr.map((v) => ({ name: v.name, path: v.id })),
      };
    } catch (_) { return { current: null, recents: [] }; }
  }
  async function vaultSwitch(id) { try { store.setItem('webCurrentVault', String(id)); } catch (_) {} return { ok: true }; }
  async function vaultCreate(name) {
    try {
      const res = await req('POST', '/vaults', { name: name || 'Vault ใหม่' });
      if (!res || !res.ok) return { ok: false };
      const v = (await res.json()).vault;
      if (v && v.id) { try { store.setItem('webCurrentVault', v.id); } catch (_) {} }
      return { ok: true, id: v && v.id };
    } catch (_) { return { ok: false }; }
  }
  async function vaultRename(id, name) {
    try { const res = await req('POST', '/vaults/rename', { id, name }); return (res && res.ok) ? await res.json() : { error: 'failed' }; }
    catch (_) { return { error: 'failed' }; }
  }
  async function vaultDelete(id) {
    try {
      const res = await req('DELETE', '/vaults?id=' + encodeURIComponent(id));
      const r = (res && res.ok) ? await res.json() : { error: 'failed' };
      if (r && r.ok && _curVault() === String(id)) { try { store.removeItem('webCurrentVault'); } catch (_) {} }
      return r;
    } catch (_) { return { error: 'failed' }; }
  }
  function vaultOpen() { return Promise.resolve({ ok: false }); }

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

  // ---- AI (web: user supplies their OWN key, kept in store; runEngine forwards it) ----
  // Shape under 'webAiCfg': { mode, provider, model, keys: { anthropic, zai } }.
  function _readAiCfg() {
    try { return JSON.parse(store.getItem('webAiCfg') || 'null') || {}; }
    catch (_) { return {}; }
  }
  function _writeAiCfg(c) {
    try { store.setItem('webAiCfg', JSON.stringify(c)); } catch (_) {}
  }
  function aiGetConfig() {
    const c = _readAiCfg(); const keys = c.keys || {};
    return Promise.resolve({
      mode: c.mode || 'api',
      provider: c.provider || 'zai',
      model: c.model || '',
      thinking: (c.thinking === true || c.thinking === false) ? c.thinking : null,
      hasKey: { anthropic: !!keys.anthropic, zai: !!keys.zai },
    });
  }
  function aiSetConfig(patch) {
    const c = _readAiCfg(); const p = patch || {};
    if (p.mode != null) c.mode = p.mode;
    if (p.provider != null) c.provider = p.provider;
    if (p.model != null) c.model = p.model;
    if ('thinking' in p) c.thinking = p.thinking;   // true/false/null (provider default)
    _writeAiCfg(c); return aiGetConfig();
  }
  function aiSetKey(provider, key) {
    if (provider !== 'anthropic' && provider !== 'zai') return Promise.resolve(false);
    const c = _readAiCfg(); c.keys = c.keys || {};
    if (key == null || key === '') delete c.keys[provider]; else c.keys[provider] = String(key);
    _writeAiCfg(c); return Promise.resolve(true);
  }
  function aiTestConnection() {
    const c = _readAiCfg(); const keys = c.keys || {}; const prov = c.provider || 'zai';
    return Promise.resolve(keys[prov] ? { ok: true } : { ok: false, error: 'no key set for ' + prov });
  }
  // Phase-1 tiered RAG (lexical): channels ① BM25(question) ② BM25(open-doc terms) ③ explicit
  // graph (open doc [[outlinks]] + backlinks), fused by CoreRag.fuseRag with the user's weights.
  // Mirrors main.js buildVaultContext minus the semantic channel (no embeddings on web yet).
  async function ragContext(question, opts) {
    try {
      if (!_rag) return { context: '', sources: [] };
      opts = (opts && typeof opts === 'object') ? opts : {};
      const excludeSet = new Set((Array.isArray(opts.exclude) ? opts.exclude : []).map((s) => String(s).toLowerCase()));
      const openName = opts.openName ? String(opts.openName).toLowerCase() : '';
      const all = await _allNotes();
      const docs = all
        .map((n) => ({ id: n.name, name: _baseName(n.name), title: _baseName(n.name), text: n.content || '' }))
        .filter((d) => !excludeSet.has(d.name.toLowerCase()));
      if (!docs.length) return { context: '', sources: [] };
      const baseToId = {};
      for (const d of docs) { const k = d.name.toLowerCase(); if (!(k in baseToId)) baseToId[k] = d.id; }
      // link graph + backlinks to the open doc (explicit graph channel)
      const backlinkIds = [];
      for (const d of docs) {
        let linksToOpen = false;
        for (const raw of _wikiTargets(d.text)) { if (openName && String(raw).toLowerCase().trim() === openName) { linksToOpen = true; break; } }
        if (linksToOpen) backlinkIds.push(d.id);
      }
      const index = _rag.buildIndex(docs);
      // minRelevance cuts weak matches on the raw BM25 spread (see main.js buildVaultContext).
      const W = _rag.normalizeRagWeights(opts.weights);
      const questionIds = _rag.rank(question, index, 8, W.minRelevance).map((r) => r.id);
      const docIds = opts.docQuery ? _rag.rank(String(opts.docQuery), index, 8, W.minRelevance).map((r) => r.id) : [];
      const outIds = [];
      (Array.isArray(opts.outlinks) ? opts.outlinks : []).forEach((raw) => {
        const tid = baseToId[String(raw).toLowerCase().trim()];
        if (tid && outIds.indexOf(tid) < 0) outIds.push(tid);
      });
      const outSet = new Set(outIds);
      const explicitIds = outIds.slice();
      backlinkIds.forEach((id) => { if (!outSet.has(id)) explicitIds.push(id); });
      const reciprocalIds = backlinkIds.filter((id) => outSet.has(id));

      // ③b implicit graph (Tier 2): unlinked mentions — forward (opts.mentions from the open doc)
      // + reverse (docs that mention the open doc's title). Auto layer that connects PDFs to notes.
      const mentionIds = [], mentionSeen = new Set();
      (Array.isArray(opts.mentions) ? opts.mentions : []).forEach((raw) => {
        const tid = baseToId[String(raw).toLowerCase().trim()];
        if (tid && !mentionSeen.has(tid)) { mentionSeen.add(tid); mentionIds.push(tid); }
      });
      if (opts.openName) {
        for (const d of docs) {
          if (mentionSeen.has(d.id)) continue;
          if (_rag.detectMentions(d.text, [opts.openName]).length) { mentionSeen.add(d.id); mentionIds.push(d.id); }
        }
      }

      const fused = _rag.fuseRag(
        { question: questionIds, doc: docIds, explicit: explicitIds, mention: mentionIds, reciprocal: reciprocalIds },
        opts.weights
      );
      if (!fused.length) return { context: '', sources: [] };
      const byId = {}; for (const d of docs) byId[d.id] = d;
      const entries = [], reasonByName = {};
      // One document, one citation — pdf + PDF-Text/ + companion note collapse to one family key.
      const famSeen = new Set();
      (Array.isArray(opts.exclude) ? opts.exclude : []).forEach((n) => famSeen.add(_rag.docFamilyKey(n)));
      for (const f of fused) {
        const d = byId[f.id];
        if (!d || !d.text || String(d.text).trim() === '') continue;
        const fam = _rag.docFamilyKey(d.name);
        if (famSeen.has(fam)) continue;
        famSeen.add(fam);
        // Same rule as P1: only the passages that relate to the question, never the whole file.
        entries.push({ id: d.id, name: d.name, text: _rag.selectPassages(d.text, question, W.noteBudget) });
        reasonByName[d.name] = f.reason;
      }
      const context = _rag.buildContextBlock(entries, 6000);
      const sources = entries.map((d) => ({ name: d.name, reason: reasonByName[d.name] || 'question' }));
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
  const _aborters = new Map();   // runId -> AbortController, so stopEngine() can cancel a live stream
  async function runEngine(payload) {
    const runId = payload && payload.runId;
    const prompt = (payload && payload.prompt) || '';
    const c = _readAiCfg(); const keys = c.keys || {};
    const provider = c.provider || 'zai'; const key = keys[provider]; const model = c.model || '';
    const thinking = (c.thinking === true || c.thinking === false) ? c.thinking : null;
    const body = { prompt };
    const imgs = (payload && Array.isArray(payload.images)) ? payload.images.filter((u) => /^data:image\//.test(String(u))).slice(0, 4) : [];
    if (imgs.length) body.images = imgs;
    if (key) { body.provider = provider; body.key = key; if (model) body.model = model; if (thinking !== null) body.thinking = thinking; }
    const ctrl = new AbortController();
    if (runId != null) _aborters.set(runId, ctrl);
    try {
      const res = await fetch(baseUrl + '/ai/chat', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body), signal: ctrl.signal });
      if (res.status === 429) {   // daily managed-AI quota reached
        let msg = 'ถึงโควตา AI รายวันแล้ว — ใส่ API key ของคุณเองที่ ⚙ ตั้งค่า AI เพื่อใช้ต่อ';
        try { const j = await res.json(); if (j && j.error) msg = j.error + (j.limit ? ' (' + j.used + '/' + j.limit + ')' : ''); } catch (_) {}
        if (_engineOut) _engineOut({ runId, data: '[' + msg + ']\r\n' });
        if (_engineDone) _engineDone({ runId, code: -1 });
        return;
      }
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
    } catch (e) {
      // AbortError = the user hit Stop; end quietly (code 0), else it's a real failure (-1).
      const aborted = e && (e.name === 'AbortError');
      if (_engineDone) _engineDone({ runId, code: aborted ? 0 : -1 });
    } finally {
      if (runId != null) _aborters.delete(runId);
    }
  }
  function stopEngine(runId) {
    const c = _aborters.get(runId);
    if (c) { try { c.abort(); } catch (_) {} _aborters.delete(runId); }
    return Promise.resolve(true);
  }

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
      const isShadow = name.startsWith('PDF-Text/');
      if (!isShadow && name.toLowerCase().includes(ql)) results.push({ name, line: 0, snippet: name });
      const lines = String(content).split(/\r?\n/);
      let page = 0, shadowHits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (isShadow) { const pm = lines[i].match(/^## หน้า (\d+)/); if (pm) page = +pm[1]; }
        if (lines[i].toLowerCase().includes(ql)) {
          if (isShadow) {
            if (shadowHits >= 3) continue;
            shadowHits++;
            results.push({ name, line: i + 1, snippet: lines[i].trim().slice(0, 120), pdf: name.replace(/^PDF-Text\//, '').replace(/\.md$/i, ''), page });
          } else {
            results.push({ name, line: i + 1, snippet: lines[i].trim().slice(0, 120) });
          }
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
    // parity with desktop: PDF-Text/ shadow notes stay out of the graph
    const notes = (await _allNotes()).filter(function (n) { return !n.name.startsWith('PDF-Text/'); });
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

  // Matches ipc note:table: one row per note {name, status, tags, backlinks}.
  // status/tags from the note's YAML frontmatter; backlinks = count of OTHER
  // notes whose [[wikilinks]] target this note's basename. Client-side, never throws.
  async function noteTable() {
    try {
      const all = await _allNotes();
      const rows = [];
      for (const n of all) {
        const attrs = (_fm && _fm.parseFrontmatter) ? (_fm.parseFrontmatter(n.content || '').attrs || {}) : {};
        const base = _baseName(n.name);
        let backlinks = 0;
        for (const m of all) {
          if (m.name === n.name) continue;
          if (_wl && _wl.linksTo && _wl.linksTo(m.content || '', base)) backlinks++;
        }
        let bodyTags = []; try { bodyTags = (window.CoreTagIndex ? window.CoreTagIndex.bodyTags((n.content || '').replace(/^---[\s\S]*?---\n/, '')) : []); } catch (_) {}
        rows.push({ name: n.name, status: attrs.status || '', tags: attrs.tags || '', backlinks, bodyTags });
      }
      return rows;
    } catch (_) {
      return [];
    }
  }

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
    updateCheck, readGlobalMemory, saveGlobalMemory,
    // state / vault
    vaultStateReadSync, vaultConfigRead, vaultConfigWrite, vaultList, vaultSwitch, vaultOpen, vaultCreate, vaultRename, vaultDelete,
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
    openExternal, onNoteChanged, onNoteFlagged,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createWebApi };
if (typeof window !== 'undefined') window.createWebApi = createWebApi;
