const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const _tagIndex = require('./core/tagindex.js');
const fs = require('fs');
const chokidar = require('chokidar');
const { wikiTargets, linksTo, rewriteLinkTargets } = require('./core/wikilinks');
const { safeRel, baseName, vaultName } = require('./core/pathutil');
const { aiConfigView, setConfigKey, buildApiRequest, parseSseDelta, parseSseEvent, modelSupportsVision, visionModelFor, buildEmbedRequest, parseEmbedResponse, resolveThinking, buildEngineInvocation } = require('./core/ai');
const { spawn } = require('child_process');   // CLI (subscription) engine path — claude / opencode
const os = require('os');
// A GUI app launched from Finder/Dock inherits a MINIMAL PATH (/usr/bin:/bin:…) that does NOT
// include Homebrew etc., so `spawn('claude')` fails with ENOENT even though the CLI is installed.
// Rebuild a login-like PATH and resolve the binary to an absolute path so CLI mode actually works.
function _richEnv(){
  const home = os.homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.deno', 'bin'), '/usr/bin', '/bin'];
  const cur = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = {}, merged = [];
  for (const d of extra.concat(cur)) { if (d && !seen[d]) { seen[d] = 1; merged.push(d); } }
  return Object.assign({}, process.env, { PATH: merged.join(path.delimiter) });
}
function _resolveBin(cmd, env){
  if (cmd.indexOf('/') >= 0) return cmd;                       // already a path
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, cmd);
    try { if (fs.existsSync(f)) return f; } catch (_) {}
  }
  return cmd;                                                  // fall back to bare name (spawn may still find it)
}
const CoreRag = require('./core/rag');

// In dev, notes live beside the source. When packaged, __dirname is inside the
// read-only app.asar, so notes must live in a writable user location instead.
const BUNDLED_NOTES = path.join(__dirname, 'notes');
let NOTES_DIR = BUNDLED_NOTES;

// ---- AI provider config (per-user JSON in userData; keys encrypted) ----
// Stored separately from the vault so a vault switch does NOT move API keys.
// Safe view only ever crosses the IPC boundary (aiConfigView); raw keys stay
// main-process-side and are decrypted on demand by the API provider (step 3b).
function aiConfigFile(){ return path.join(app.getPath('userData'), 'ai-config.json'); }
function readAiConfig(){
  try {
    const a = JSON.parse(fs.readFileSync(aiConfigFile(), 'utf8'));
    return {
      mode: (a && typeof a.mode === 'string' && a.mode) ? a.mode : 'api',
      provider: (a && typeof a.provider === 'string' && a.provider) ? a.provider : 'anthropic',
      model: (a && typeof a.model === 'string') ? a.model : '',
      keys: (a && a.keys && typeof a.keys === 'object') ? a.keys : {},
      _plain: !!(a && a._plain),
    };
  } catch (_) { return { mode: 'api', provider: 'anthropic', model: '', keys: {} }; }
}
function writeAiConfig(cfg){
  try { fs.writeFileSync(aiConfigFile(), JSON.stringify(cfg, null, 2), 'utf8'); } catch (_) {}
}
// ponytail: when OS keychain is unavailable (headless/test), fall back to plain
// base64 and tag the config with _plain=true so decKey knows the encoding.
// Upgrade path: only ever hit when safeStorage is genuinely missing; real
// installs use the encrypted branch.
function encKey(plain){
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64');
  return Buffer.from(plain, 'utf8').toString('base64');
}
function decKey(enc){
  if (!enc || typeof enc !== 'string') return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    return Buffer.from(enc, 'base64').toString('utf8');
  } catch (_) { return ''; }
}
// INTERNAL — never exposed to the renderer. The API provider (step 3b) calls this.
function getDecryptedKey(provider){
  const cfg = readAiConfig(); const keys = (cfg.keys || {});
  // Z.ai: the Coding Plan and pay-as-you-go endpoints take the SAME key — use whichever was saved
  const alt = provider === 'zai-coding' ? 'zai' : provider === 'zai' ? 'zai-coding' : null;
  return decKey(keys[provider] || (alt ? keys[alt] : undefined));
}
// a provider error body → one short line the user can act on (Z.ai 1113 = the key is a Coding
// Plan key hitting the pay-as-you-go endpoint, or the reverse — the #1 cause of "429")
function apiErrorHint(provider, status, bodyText){
  let msg = '';
  try { const j = JSON.parse(bodyText || ''); msg = (j.error && (j.error.message || j.error.code)) || j.message || ''; if (j.error && j.error.code) msg = '[' + j.error.code + '] ' + msg; } catch (_) { msg = String(bodyText || '').slice(0, 200); }
  let hint = '';
  if (provider === 'zai' && /1113|balance|resource package/i.test(msg)) hint = ' → คีย์นี้น่าจะเป็น Z.ai Coding Plan: ไปที่ ตั้งค่า → ผู้ให้บริการ แล้วเลือก "GLM (Z.ai Coding Plan)"';
  else if (provider === 'zai-coding' && status === 429) hint = ' → โควตา Coding Plan ชั่วคราวเต็ม หรือคีย์นี้เป็นแบบเติมเงิน: ลองเลือก "GLM (Z.ai)"';
  else if (status === 429) hint = ' → ถูกจำกัดอัตรา/โควตา รอสักครู่แล้วลองใหม่';
  else if (status === 401 || status === 403) hint = ' → คีย์ไม่ถูกต้องหรือหมดอายุ';
  return (msg ? ' ' + msg : '') + hint;
}

ipcMain.handle('ai:getConfig', () => aiConfigView(readAiConfig()));
ipcMain.handle('ai:setConfig', (e, patch) => {
  const cfg = readAiConfig();
  if (patch && typeof patch === 'object') {
    if (patch.mode) cfg.mode = patch.mode;
    if (patch.provider) cfg.provider = patch.provider;
    if ('model' in patch) cfg.model = patch.model;
    if ('visionModel' in patch) cfg.visionModel = patch.visionModel;
    if ('autoVision' in patch) cfg.autoVision = patch.autoVision;
    if ('readNoteImages' in patch) cfg.readNoteImages = patch.readNoteImages;
    if ('thinking' in patch) cfg.thinking = patch.thinking;   // true/false/null (provider default)
    if ('cliEngine' in patch) cfg.cliEngine = patch.cliEngine;   // 'claude' | 'glm' (CLI/subscription mode)
    if ('cliModel' in patch) cfg.cliModel = patch.cliModel;
  }
  writeAiConfig(cfg);
  return aiConfigView(cfg);
});
ipcMain.handle('ai:setKey', (e, { provider, key } = {}) => {
  let cfg = readAiConfig();
  const enc = (key && String(key).length) ? encKey(String(key)) : null;
  cfg = setConfigKey(cfg, provider, enc);
  if (!safeStorage.isEncryptionAvailable()) cfg._plain = true;
  writeAiConfig(cfg);
  return aiConfigView(cfg);
});
// Minimal NON-streaming probe against the saved config. Uses buildApiRequest
// (stream:false, small max_tokens) so it stays cheap. Returns {ok,status} or
// {ok:false,error}. Never throws — the renderer just shows the inline result.
ipcMain.handle('ai:testConnection', async () => {
  const aicfg = readAiConfig();
  if (aicfg.mode !== 'api') return { ok: false, error: 'no key' };
  const key = getDecryptedKey(aicfg.provider);
  if (!key) return { ok: false, error: 'no key' };
  try {
    const built = buildApiRequest(aicfg.provider, aicfg.model || '', 'hi', key);
    if (!built) return { ok: false, error: 'unknown provider' };
    const body = Object.assign({}, built.body, { stream: false });
    if ('max_tokens' in body) body.max_tokens = 8;
    const res = await fetch(built.url, { method: 'POST', headers: built.headers, body: JSON.stringify(body) });
    let bt = ''; if (!res.ok) { try { bt = await res.text(); } catch (_) {} }
    return { ok: res.ok, status: res.status, hint: res.ok ? '' : apiErrorHint(aicfg.provider, res.status, bt).trim() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---- Collab auth token (phase 7b-4) -----------------------------------------
// OPTIONAL: stored only if the user logs in for authed collab. Reuses the same
// encKey/decKey as AI keys (safeStorage / encrypted at rest). Unlike AI keys,
// getToken returns the PLAINTEXT token — the renderer needs it to build the WS
// url (?token=…). It is still encrypted on disk; it just crosses the boundary.
function authFile(){ return path.join(app.getPath('userData'), 'auth.json'); }
ipcMain.handle('auth:setToken', (e, { token, email } = {}) => {
  try {
    fs.writeFileSync(authFile(), JSON.stringify({ email: email || '', enc: token ? encKey(String(token)) : '' }));
    return true;
  } catch (_) { return false; }
});
ipcMain.handle('auth:getToken', () => {
  try {
    const a = JSON.parse(fs.readFileSync(authFile(), 'utf8'));
    const token = a.enc ? decKey(a.enc) : '';
    return token ? { email: a.email || '', token } : null;
  } catch (_) { return null; }
});
ipcMain.handle('auth:clear', () => { try { fs.unlinkSync(authFile()); } catch (_) {} return true; });

// ---- Semantic embedding layer (opt-in; degrades to lexical-only when off) ----
// ponytail: stub embedder is a deterministic 64-dim token-frequency hash; it
// exercises the cache + fusion PLUMBING offline, NOT real semantic quality
// (which only a live model provides). Real path batches through Z.ai's
// OpenAI-compatible embeddings endpoint.
const EMBED_PROVIDER = 'zai', EMBED_MODEL = 'embedding-3';
function embHash(s){
  // FNV-1a 32-bit (unsigned). Cheap, deterministic; detects note content change.
  var h = 0x811c9dc5;
  var str = String(s == null ? '' : s);
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function stubEmbed(text){
  // Deterministic 64-dim bag-of-tokens vector. Cosine ≈ shared-token similarity.
  var v = new Array(64).fill(0);
  var toks = CoreRag.tokenize(String(text == null ? '' : text));
  for (var i = 0; i < toks.length; i++) v[embHash(toks[i]) % 64] += 1;
  return v;
}
// Returns an array of vectors (one per input, same order), or null on
// unavailable/error. Never throws. [] for empty input.
async function embedTexts(texts){
  if (!Array.isArray(texts) || texts.length === 0) return [];
  try {
    if (process.env.WASHI_TEST_EMBED) return texts.map(stubEmbed);
    const key = getDecryptedKey(EMBED_PROVIDER);
    if (!key) return null;
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
      const chunk = texts.slice(i, i + 64);
      const req = buildEmbedRequest(EMBED_PROVIDER, EMBED_MODEL, chunk, key);
      if (!req) return null;
      const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
      if (!res.ok) return null;
      const vecs = parseEmbedResponse(EMBED_PROVIDER, await res.json());
      if (vecs.length !== chunk.length) return null;
      for (let j = 0; j < vecs.length; j++) out.push(vecs[j]);
    }
    return out;
  } catch (_) {
    return null;
  }
}
// Incremental per-note embedding cache. Shape: { model, notes: { <rel>: { hash, vec } } }.
// .washi is in IGNORE_DIRS so walkNotes skips it (no scan/watcher loop).
function embCacheFile(){ return path.join(NOTES_DIR, '.washi', 'embeddings.json'); }
function readEmbCache(){
  try {
    const parsed = JSON.parse(fs.readFileSync(embCacheFile(), 'utf8'));
    if (!parsed || parsed.model !== EMBED_MODEL) return { model: EMBED_MODEL, notes: {} }; // model change invalidates all
    const notes = (parsed.notes && typeof parsed.notes === 'object' && !Array.isArray(parsed.notes)) ? parsed.notes : {};
    return { model: parsed.model, notes };
  } catch (_) { return { model: EMBED_MODEL, notes: {} }; }
}
function writeEmbCache(cache){
  try {
    fs.mkdirSync(path.join(NOTES_DIR, '.washi'), { recursive: true });
    fs.writeFileSync(embCacheFile(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (_) {}
}
// Reads the renderer's per-vault state for the semantic toggle (5d-3 writes it).
function readVaultStateRagSemantic(){
  try {
    const s = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, '.washi', 'state.json'), 'utf8'));
    return !!(s && s.ragSemantic === true);
  } catch (_) { return false; }
}

// ---- RAG: build vault context for a question (reads notes live, pure core ranks them) ----
// ponytail: SCAN_CAP=300 / FILE_CAP=40000 are known ceilings; very large vaults
// miss tail notes and very large notes get head-truncated. Upgrade only if a real
// vault exceeds either. Semantic is OPT-IN (WASHI_TEST_EMBED || state.ragSemantic)
// and degrades gracefully: off / no key / any error -> byte-for-byte the 5b
// lexical path. Never throws.
// rel-file -> { sig, text, tf, len, wt } — see the incremental-index note inside buildVaultContext.
const _ragIndexCache = new Map();
// Phase-1 tiered RAG: fuse channels — ① BM25(question) ② BM25(open-doc terms) ③ explicit graph
// (the open doc's [[outlinks]] + backlinks) ④ semantic (opt-in) — weighted by the user's config
// (see CoreRag.DEFAULT_RAG_WEIGHTS). Connection is a PRIOR amplifying relevance, never overriding.
// opts: { exclude[], docQuery, outlinks[], openName, weights }.
async function buildVaultContext(question, opts){
  try {
    opts = (opts && typeof opts === 'object') ? opts : {};
    const SCAN_CAP = 300, FILE_CAP = 40000;
    const excludeSet = new Set((Array.isArray(opts.exclude) ? opts.exclude : []).map((s) => String(s).toLowerCase()));
    const openName = opts.openName ? String(opts.openName).toLowerCase() : '';   // the open doc (P1), for backlinks
    const rels = walkNotes(NOTES_DIR, '');
    const docs = [], baseToId = {};
    for (let i = 0; i < rels.length && i < SCAN_CAP; i++) {
      const rel = rels[i];
      if (excludeSet.has(baseName(rel).toLowerCase())) continue;   // already P1
      // INCREMENTAL INDEX: read + tokenize a file only when its signature changed — the whole
      // vault used to be re-read and re-tokenized from scratch on every single question.
      const full = path.join(NOTES_DIR, rel);
      let st; try { st = fs.statSync(full); } catch (_) { continue; }
      const ck = NOTES_DIR + '|' + rel, sig = st.mtimeMs + ':' + st.size;
      let ent = _ragIndexCache.get(ck);
      if (!ent || ent.sig !== sig) {
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
        if (text.length > FILE_CAP) text = text.slice(0, FILE_CAP);
        const stats = CoreRag.docTf(text, baseName(rel));   // title indexed (boosted) here
        ent = { sig, text, tf: stats.tf, len: stats.len, wt: wikiTargets(text) };
        _ragIndexCache.set(ck, ent);
      }
      docs.push({ id: rel, name: baseName(rel), text: ent.text, tf: ent.tf, len: ent.len, wt: ent.wt });
      const k = baseName(rel).toLowerCase();      // first wins, like graph:data's fileByBase
      if (!(k in baseToId)) baseToId[k] = rel;
    }
    if (_ragIndexCache.size > SCAN_CAP * 3) _ragIndexCache.clear();   // blunt bound (renames / vault switches)
    if (!docs.length) return { context: '', sources: [] };

    // link graph + which docs link BACK to the open doc (explicit backlinks)
    const linkGraph = {}, backlinkIds = [];
    for (const d of docs) {
      const seen = new Set(), nb = [];
      let linksToOpen = false;
      for (const raw of d.wt) {
        const key = raw.toLowerCase().trim();
        if (openName && key === openName) linksToOpen = true;
        const tid = baseToId[key];
        if (!tid || tid === d.id || seen.has(tid)) continue;
        seen.add(tid); nb.push(tid);
      }
      linkGraph[d.id] = nb;
      if (linksToOpen) backlinkIds.push(d.id);
    }

    const index = CoreRag.buildIndexFromTf(docs);   // docs already carry cached {tf,len}
    // ① question channel + ② open-doc channel (BM25). minRelevance cuts weak matches HERE, on the
    // raw BM25 spread — after fusion every score is ~1/(k+rank) and a ratio can't tell them apart.
    const W = CoreRag.normalizeRagWeights(opts.weights);
    const questionIds = CoreRag.rank(question, index, 8, W.minRelevance).map((r) => r.id);
    const docIds = opts.docQuery ? CoreRag.rank(String(opts.docQuery), index, 8, W.minRelevance).map((r) => r.id) : [];
    // ③ explicit graph channel: the open doc's [[outlinks]] (resolved) ∪ its backlinks; two-way = reciprocal
    const outIds = [];
    (Array.isArray(opts.outlinks) ? opts.outlinks : []).forEach((raw) => {
      const tid = baseToId[String(raw).toLowerCase().trim()];
      if (tid && outIds.indexOf(tid) < 0) outIds.push(tid);
    });
    const outSet = new Set(outIds);
    const explicitIds = outIds.slice();
    backlinkIds.forEach((id) => { if (!outSet.has(id)) explicitIds.push(id); });
    const reciprocalIds = backlinkIds.filter((id) => outSet.has(id));   // linked BOTH ways

    // ③b implicit graph (Tier 2, Phase 2): unlinked MENTIONS — no [[link]] but the title appears
    // verbatim. Forward = titles the OPEN doc mentions (detected renderer-side, opts.mentions);
    // reverse = docs that mention the open doc's title. This is the auto layer that connects PDFs.
    const mentionIds = [], mentionSeen = new Set();
    (Array.isArray(opts.mentions) ? opts.mentions : []).forEach((raw) => {
      const tid = baseToId[String(raw).toLowerCase().trim()];
      if (tid && !mentionSeen.has(tid)) { mentionSeen.add(tid); mentionIds.push(tid); }
    });
    if (opts.openName) {
      for (const d of docs) {
        if (mentionSeen.has(d.id)) continue;
        if (CoreRag.detectMentions(d.text, [opts.openName]).length) { mentionSeen.add(d.id); mentionIds.push(d.id); }
      }
    }

    // ④ semantic channel (opt-in) → feeds the 'similar' tier
    let similarIds = [];
    const semOn = !!process.env.WASHI_TEST_EMBED || readVaultStateRagSemantic();
    if (semOn && docs.length) {
      const cache = readEmbCache();
      const toEmbed = [];
      for (const d of docs) {
        const sig = d.name + '\n' + String(d.text).slice(0, 2000);
        const hash = embHash(sig);
        const e = cache.notes[d.id];
        if (!e || e.hash !== hash) toEmbed.push({ id: d.id, sig, hash });
      }
      if (toEmbed.length) {
        const fresh = await embedTexts(toEmbed.map((t) => t.sig));
        if (fresh) { for (let i = 0; i < toEmbed.length; i++) cache.notes[toEmbed[i].id] = { hash: toEmbed[i].hash, vec: fresh[i] }; writeEmbCache(cache); }
      }
      const qv = await embedTexts([question]);
      if (qv && qv[0]) {
        const docVecs = [];
        for (const d of docs) { const e = cache.notes[d.id]; if (e && Array.isArray(e.vec)) docVecs.push({ id: d.id, vec: e.vec }); }
        similarIds = CoreRag.rankByVector(qv[0], docVecs, 8).map((s) => s.id);
      }
    }

    const fused = CoreRag.fuseRag(
      { question: questionIds, doc: docIds, explicit: explicitIds, mention: mentionIds, similar: similarIds, reciprocal: reciprocalIds },
      opts.weights
    );
    if (!fused.length) return { context: '', sources: [] };

    const byId = {}; for (const d of docs) byId[d.id] = d;
    const entries = [], reasonByName = {};
    // One document must be cited ONCE, even though it may exist as pdf + PDF-Text/ + companion note.
    // Seed with the open doc so RAG never cites a second copy of what's already P1.
    const famSeen = new Set();
    (Array.isArray(opts.exclude) ? opts.exclude : []).forEach((n) => famSeen.add(CoreRag.docFamilyKey(n)));
    for (const f of fused) {
      const d = byId[f.id];
      if (!d || !d.text || String(d.text).trim() === '') continue;
      const fam = CoreRag.docFamilyKey(d.name);
      if (famSeen.has(fam)) continue;
      famSeen.add(fam);
      // Same rule as P1: inject the passages of this note that RELATE to the question, not the
      // whole file — one long note otherwise eats the entire context budget (and got head-cut).
      entries.push({ id: d.id, name: d.name, text: CoreRag.selectPassages(d.text, question, W.noteBudget) });
      reasonByName[d.name] = f.reason;
    }
    const context = CoreRag.buildContextBlock(entries, 6000);
    const sources = entries.map((d) => ({ name: d.name, reason: reasonByName[d.name] || 'question' }));
    return { context, sources };
  } catch (_) {
    return { context: '', sources: [] };
  }
}

ipcMain.handle('rag:context', async (e, { question, opts } = {}) => await buildVaultContext(typeof question === 'string' ? question : '', opts || {}));

// ---- Vault registry (per-user JSON: which folder is the active vault) ----
function vaultsFile(){ return path.join(app.getPath('userData'), 'vaults.json'); }
function readVaults(){
  try {
    const a = JSON.parse(fs.readFileSync(vaultsFile(), 'utf8'));
    const recents = Array.isArray(a && a.recents) ? a.recents : [];
    return {
      current: (a && typeof a.current === 'string' && a.current) ? a.current : null,
      recents: recents.filter((r) => r && typeof r.path === 'string'),
    };
  } catch (_) { return { current: null, recents: [] }; }
}
function writeVaults(v){
  try { fs.writeFileSync(vaultsFile(), JSON.stringify(v, null, 2), 'utf8'); } catch (_) {}
}
function registerVault(p){
  const v = readVaults();
  const name = vaultName(p);
  v.recents = [{ path: p, name }, ...v.recents.filter((r) => r.path !== p)].slice(0, 12);
  v.current = p;
  writeVaults(v);
}

function resolveNotesDir() {
  // ponytail: TEST-ONLY hook — when this env var is set the app uses a throwaway
  // temp vault and skips the registry + default seeding entirely. Only ever set
  // by the Playwright helper, so normal launches are completely unaffected.
  if (process.env.WASHI_TEST_NOTES_DIR) {
    const d = process.env.WASHI_TEST_NOTES_DIR;
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  const reg = readVaults();
  if (reg.current && fs.existsSync(reg.current)) return reg.current;
  let dir;
  if (!app.isPackaged) {
    dir = BUNDLED_NOTES;
  } else {
    dir = path.join(app.getPath('documents'), 'StudyNotes');
    fs.mkdirSync(dir, { recursive: true });
    // Seed the sample notes from the bundle on first run (empty target only).
    try {
      const hasNotes = fs.readdirSync(dir).some((f) => f.endsWith('.md'));
      if (!hasNotes && fs.existsSync(BUNDLED_NOTES)) {
        for (const f of fs.readdirSync(BUNDLED_NOTES)) {
          if (f.endsWith('.md')) fs.copyFileSync(path.join(BUNDLED_NOTES, f), path.join(dir, f));
        }
      }
    } catch (_) {}
  }
  registerVault(dir);
  return dir;
}

let win;
let watcher;
let openFilePath = null;
let lastKnownContent = null;
const engineProcs = new Map();
let _lastEngineExit = 0;   // gate for flagging AI edits to non-open files   // runId -> child process (concurrent runs)
const MAX_ENGINES = 4;

function loadWinState() {
  try {
    const f = path.join(app.getPath('userData'), 'window-state.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { return {}; }
}
function saveWinState() {
  try {
    if (win && !win.isDestroyed()) {
      const f = path.join(app.getPath('userData'), 'window-state.json');
      fs.writeFileSync(f, JSON.stringify(win.getBounds()));
    }
  } catch (_) {}
}

function createWindow() {
  const st = loadWinState();
  win = new BrowserWindow({
    width: st.width || 1240,
    height: st.height || 800,
    x: st.x != null ? st.x : undefined,
    y: st.y != null ? st.y : undefined,
    title: 'Kumiko',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
    backgroundColor: '#f3ece0',
    show: false,   // shown on ready-to-show: no half-painted layout flash (see below)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // rAF must keep ticking while the window is hidden/occluded: pdf.js page renders
      // (AI slide-clips) hang otherwise, which silently killed a NEW-NOTE (log 2026-08-19).
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // first paint already has the theme tokens + static layout classes (index.html head script),
  // so showing here means the user never sees the raw grid; tests keep the window hidden.
  win.once('ready-to-show', () => { if (!process.env.WASHI_TEST) win.show(); });
  win.on('resize', saveWinState);
  win.on('move', saveWinState);
  win.on('close', saveWinState);
}

app.whenReady().then(() => {
  NOTES_DIR = resolveNotesDir();
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (watcher) watcher.close();
  if (process.platform !== 'darwin') app.quit();
});

// ---- API provider runner (HTTPS streaming over global fetch) ----
// Streaming twin of the CLI spawn path. Same emit/finish/engineProcs shape, so
// engine:stop (which calls .kill() on the stored handle) aborts API runs too.
// Pure request/parse logic lives in core/ai.js; only the fetch+stream plumbing
// is here. engineProcs[rid] holds { kill() -> ctrl.abort() } so SIGINT/SIGKILL
// calls from engine:stop become a no-op abort on the AbortController.
async function runApiProvider({ provider, model, prompt, key, rid, emit, thinking, images }){
  const ctrl = new AbortController();
  engineProcs.set(rid, { kill(){ try { ctrl.abort(); } catch (_) {} } });
  const killer = setTimeout(() => {
    if (engineProcs.has(rid)) { try { ctrl.abort(); } catch (_) {} emit('\r\n[timeout — engine killed]\r\n'); }
  }, 300000);
  const finish = (code) => { clearTimeout(killer); engineProcs.delete(rid); _lastEngineExit = Date.now(); win.webContents.send('engine:done', { runId: rid, code }); };
  const emitLine = (line) => {
    const trimmed = line.trim();
    if (trimmed.indexOf('data:') !== 0) return;     // skip event:/ping/blank lines
    let rest = trimmed.slice(5);                    // drop "data:"
    if (rest.charCodeAt(0) === 32) rest = rest.slice(1);   // drop one leading space
    const ev = parseSseEvent(provider, rest);
    if (ev.reasoning) emitReasoning(ev.reasoning);   // thinking → its own channel, never the answer
    if (ev.text) emit(ev.text);
  };
  const emitReasoning = (data) => win.webContents.send('engine:output', { runId: rid, data, kind: 'reasoning' });
  const built = buildApiRequest(provider, model, prompt, key, { thinking: resolveThinking(provider, model, thinking), images });
  if (!built) { finish(-1); return; }
  try {
    const res = await fetch(built.url, { method: 'POST', headers: built.headers, body: JSON.stringify(built.body), signal: ctrl.signal });
    if (!res.ok) { let bt = ''; try { bt = await res.text(); } catch (_) {} emit('\r\n[API error ' + res.status + ']' + apiErrorHint(provider, res.status, bt) + '\r\n'); finish(res.status); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { emitLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    }
    if (buf) emitLine(buf);                          // flush a trailing un-newlined line
    finish(0);
  } catch (err) {
    if (err && err.name === 'AbortError') { finish(130); return; }   // aborted via engine:stop / timeout
    emit('\r\n[API error] ' + (err && err.message ? err.message : String(err)) + '\r\n');
    finish(-1);
  }
}

// ---- CLI (subscription) engine — spawns `claude`/`opencode` so AI runs on the user's
// logged-in SUBSCRIPTION, NO API key. Desktop only (a browser can't spawn a process).
// buildEngineInvocation (core/ai.js) maps engine+model+prompt -> {cmd,args,stdin}. The child
// is stored in engineProcs so the existing engine:stop (SIGINT→SIGKILL) aborts it too.
function runCliEngine({ engine, model, prompt, rid, emit }){
  const inv = buildEngineInvocation(engine, model, prompt);
  if (!inv) { emit('\r\n[ไม่รู้จัก engine: ' + engine + ']\r\n'); win.webContents.send('engine:done', { runId: rid, code: -1 }); return; }
  const env = _richEnv();
  const bin = _resolveBin(inv.cmd, env);   // absolute path so Finder-launched apps find it
  let child;
  // cwd MUST be the vault so the CLI can open/edit the note by its {file} name (e.g. "Nephron.md").
  // Without this the action-bar "let AI edit this note" flow silently no-ops: claude runs in the app
  // dir, can't find the file, edits nothing → the chokidar watcher never fires → no accept/review.
  try { child = spawn(bin, inv.args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: NOTES_DIR }); }
  catch (err) { emit('\r\n[เรียก ' + inv.cmd + ' ไม่ได้ — ติดตั้ง/ล็อกอิน CLI แล้วหรือยัง?] ' + (err && err.message || '') + '\r\n'); win.webContents.send('engine:done', { runId: rid, code: -1 }); return; }
  engineProcs.set(rid, child);   // child.kill(signal) satisfies engine:stop
  child.on('error', (err) => { emit('\r\n[' + inv.cmd + ' error: ' + (err && err.message || err) + ' — ' + (String(err && err.code) === 'ENOENT' ? ('หา `' + inv.cmd + '` ไม่เจอ — ติดตั้งแล้วหรือยัง? (PATH: ' + env.PATH.split(path.delimiter).slice(0,3).join(', ') + '…)') : 'ติดตั้ง CLI แล้วหรือยัง?') + ']\r\n'); });
  if (child.stdin) { if (inv.stdin != null) { try { child.stdin.write(inv.stdin); } catch (_) {} } try { child.stdin.end(); } catch (_) {} }
  if (child.stdout) child.stdout.on('data', (d) => emit(d.toString()));
  if (child.stderr) child.stderr.on('data', (d) => emit(d.toString()));
  child.on('close', (code) => { engineProcs.delete(rid); _lastEngineExit = Date.now(); win.webContents.send('engine:done', { runId: rid, code: (code == null ? 0 : code) }); });
}

// ---- One-shot engine runner (no shell, argv array) ----
ipcMain.handle('engine:run', (e, { engine, model, prompt, runId, images }) => {
  images = Array.isArray(images) ? images.filter((u) => /^data:image\//.test(String(u))).slice(0, 4) : [];
  const rid = runId || 'default';
  const emit = (data) => win.webContents.send('engine:output', { runId: rid, data });
  // ponytail: TEST-ONLY stub engine. Streams a canned reply over ~600ms and is
  // abortable via the existing engine:stop path (which calls .kill()). Only
  // triggers when WASHI_TEST_ENGINE is set (Playwright chat spec); normal runs
  // are 100% unchanged. Delete when provider refactor lands deterministic unit tests.
  if (process.env.WASHI_TEST_ENGINE) {
    if (engineProcs.has(rid)) return;
    let done = false;
    const timers = [];
    const fake = { kill() {
      if (done) return; done = true;
      timers.forEach(clearTimeout);
      engineProcs.delete(rid); _lastEngineExit = Date.now();
      win.webContents.send('engine:done', { runId: rid, code: 130 });   // aborted
    }};
    engineProcs.set(rid, fake);
    const chunks = ['Stubbed ', 'AI ', 'reply.'];
    chunks.forEach((c, i) => timers.push(setTimeout(() => { if (!done) emit(c); }, 150 * (i + 1))));
    timers.push(setTimeout(() => {
      if (done) return; done = true;
      engineProcs.delete(rid); _lastEngineExit = Date.now();
      win.webContents.send('engine:done', { runId: rid, code: 0 });     // finished
    }, 150 * (chunks.length + 1)));
    return;
  }
  if (engineProcs.has(rid)) { return; }                        // this session is already running
  if (engineProcs.size >= MAX_ENGINES) {
    emit('\r\n[คิว engine เต็ม (สูงสุด ' + MAX_ENGINES + ' พร้อมกัน) — รอสักครู่แล้วลองใหม่]\r\n');
    win.webContents.send('engine:done', { runId: rid, code: -1 });
    return;
  }
  const aicfg = readAiConfig();
  // CLI (subscription) mode — spawn the logged-in `claude`/`opencode` CLI, no API key.
  if (aicfg.mode === 'cli') {
    const eng = aicfg.cliEngine || 'claude';
    // glm needs an opencode model (default the Coding-Plan one); claude's model is an
    // OPTIONAL alias (opus/sonnet/haiku) — empty means the claude CLI's own default.
    const mdl = (eng === 'glm') ? (aicfg.cliModel || 'zai-coding-plan/glm-5.2') : (aicfg.cliModel || '');
    // CLI can't take content blocks — write images to temp files and point the CLI at them
    // (both `claude` and `opencode` read image files with their own tools)
    if (images.length) prompt += '\n\n' + _imagesToTempFiles(images).map((f, i) => '[ภาพแนบที่ ' + (i + 1) + ': ' + f + ' — เปิดอ่านไฟล์ภาพนี้ประกอบคำตอบ]').join('\n');
    runCliEngine({ engine: eng, model: mdl, prompt, rid, emit });
    return;
  }
  // Otherwise the API-key path. If no key/api config is set, emit a graceful error.
  const key = getDecryptedKey(aicfg.provider);
  if (!key) { emit('\r\n[ยังไม่ได้ตั้งค่า API key — ไปที่ ⚙ ตั้งค่า AI]\r\n'); win.webContents.send('engine:done', { runId: rid, code: -1 }); return; }
  let apiModel = aicfg.model || model;
  let usedVision = false;
  if (images.length) {
    if (!modelSupportsVision(aicfg.provider, apiModel)) {
      const vm = (aicfg.autoVision !== false) ? (aicfg.visionModel || visionModelFor(aicfg.provider, apiModel)) : null;
      if (vm && modelSupportsVision(aicfg.provider, vm)) { apiModel = vm; usedVision = true; }
      else { emit('\r\n[โมเดล ' + apiModel + ' มองภาพไม่ได้ และไม่ได้เปิดสลับรุ่นอัตโนมัติ — ภาพถูกตัดออก]\r\n'); images = []; }
    } else usedVision = true;
  }
  if (usedVision) win.webContents.send('engine:output', { runId: rid, data: apiModel, kind: 'vision-model' });
  runApiProvider({ provider: aicfg.provider, model: apiModel, prompt, key, rid, emit, thinking: aicfg.thinking, images });
});

// data URIs → temp .jpg/.png files for the CLI path; best-effort cleanup after 10 minutes
function _imagesToTempFiles(images){
  const os = require('os');
  const out = [];
  images.forEach((u, i) => {
    const m = String(u).match(/^data:image\/([a-z+.-]+);base64,(.*)$/s); if (!m) return;
    const ext = m[1] === 'png' ? 'png' : 'jpg';
    const f = path.join(os.tmpdir(), 'kumiko-img-' + Date.now() + '-' + i + '.' + ext);
    try { fs.writeFileSync(f, Buffer.from(m[2], 'base64')); out.push(f); setTimeout(() => { try { fs.unlinkSync(f); } catch (_) {} }, 600000); } catch (_) {}
  });
  return out;
}

// ---- Stop a running engine for ONE runId (other concurrent runs untouched) ----
ipcMain.handle('engine:stop', (e, { runId }) => {
  const rid = runId || 'default';
  const proc = engineProcs.get(rid);
  if (!proc) return false;                          // nothing to stop
  try { proc.kill('SIGINT'); } catch (_) {}
  // hard fallback if SIGINT didn't end it within 600ms; the existing 'close'
  // handler then fires engine:done and cleans engineProcs up.
  setTimeout(() => {
    if (engineProcs.get(rid) === proc) { try { proc.kill('SIGKILL'); } catch (_) {} }
  }, 600);
  return true;
});

// ---- Notes ----
// ---- folder-aware helpers (notes may live in subfolders of NOTES_DIR) ----
const IGNORE_DIRS = new Set(['.trash', 'databases', '.washi']);
function walkNotes(dir, base){
  base = base || ''; let out = []; let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents){
    if (ent.name.startsWith('.')) continue;
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) { if (IGNORE_DIRS.has(ent.name)) continue; out = out.concat(walkNotes(path.join(dir, ent.name), rel)); }
    // KUMIKO.md (standing rules) + KUMIKO-MEMORY.md (memory layer) are the AI's own files —
    // hidden from every list-driven surface (sidebar, graph, @-mentions, RAG) by user request;
    // read/written directly by name (rules desk / memory desk).
    else if (ent.name.endsWith('.md') && rel !== 'KUMIKO.md' && rel !== 'KUMIKO-MEMORY.md') out.push(rel);
  }
  return out;
}
function walkFolders(dir, base){
  base = base || ''; let out = []; let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents){
    if (!ent.isDirectory() || ent.name.startsWith('.') || IGNORE_DIRS.has(ent.name)) continue;
    const rel = base ? base + '/' + ent.name : ent.name;
    out.push(rel);
    out = out.concat(walkFolders(path.join(dir, ent.name), rel));
  }
  return out;
}
function walkPdfs(dir, base){
  base = base || ''; let out = []; let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents){
    if (ent.name.startsWith('.')) continue;
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) { if (IGNORE_DIRS.has(ent.name)) continue; out = out.concat(walkPdfs(path.join(dir, ent.name), rel)); }
    else if (ent.name.toLowerCase().endsWith('.pdf')) out.push(rel);
  }
  return out;
}
function walkAnnot(dir, base){
  base = base || ''; let out = []; let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of ents){
    const rel = base ? base + '/' + ent.name : ent.name;
    if (ent.isDirectory()) { if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith('.')) continue; out = out.concat(walkAnnot(path.join(dir, ent.name), rel)); }
    else if (ent.name.endsWith('.annot.json')) out.push(rel);   // .annot.json starts with '.', so no dotfile skip at file level
  }
  return out;
}

// ---- Trash manifest (.trash/.trash.json): tracks original location for restore ----
// Each entry: { id, type, trashedName, sidecarTrashedName?, origPath, name, dbId?, deletedAt }
function trashDir(){ return path.join(NOTES_DIR, '.trash'); }
function trashManifestPath(){ return path.join(trashDir(), '.trash.json'); }
function readTrashManifest(){
  try { const a = JSON.parse(fs.readFileSync(trashManifestPath(), 'utf8')); return Array.isArray(a) ? a : []; }
  catch (_) { return []; }
}
function writeTrashManifest(arr){
  try { fs.mkdirSync(trashDir(), { recursive: true }); fs.writeFileSync(trashManifestPath(), JSON.stringify(arr, null, 2), 'utf8'); } catch (_) {}
}
function appendTrashEntry(entry){ const a = readTrashManifest(); a.push(entry); writeTrashManifest(a); }
let _trashSeq = 0;
function trashEntryId(){ return 't' + Date.now().toString(36) + (_trashSeq++).toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
// Move srcAbs into .trash with a collision-safe basename; return the chosen basename.
function trashMove(srcAbs){
  const trash = trashDir();
  if (!fs.existsSync(trash)) fs.mkdirSync(trash, { recursive: true });
  const ext = path.extname(srcAbs);
  const stem = ext ? path.basename(srcAbs, ext) : path.basename(srcAbs);
  let dest = path.join(trash, path.basename(srcAbs));
  let i = 1;
  while (fs.existsSync(dest)){ dest = path.join(trash, stem + '.' + i + ext); i++; }
  fs.renameSync(srcAbs, dest);
  return path.basename(dest);
}
function rmIfExists(p){
  try {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch (_) {}
}
function dispName(p){ return path.basename(p).replace(/\.(md|pdf)$/i, ''); }

ipcMain.handle('note:list', () => {
  try {
    const pdfs = walkPdfs(NOTES_DIR).sort();
    // Read the stored companion link from each PDF's sidecar (robust to renames). Missing/malformed → skip.
    const companions = {};
    for (const rel of pdfs) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, rel + '.annot.json'), 'utf8'));
        if (data && typeof data.companion === 'string' && data.companion) companions[rel] = data.companion;
      } catch (_) { /* no sidecar or malformed → skip */ }
    }
    return { notes: walkNotes(NOTES_DIR).sort(), folders: walkFolders(NOTES_DIR).sort(), pdfs, companions };
  }
  catch (_) { return { notes: [], folders: [] }; }
});

ipcMain.handle('note:open', (e, name) => {
  const p = path.join(NOTES_DIR, name);
  openFilePath = p;
  const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  lastKnownContent = content;
  startWatch();
  return content;
});

ipcMain.handle('note:save', (e, payload) => {
  const p = path.join(NOTES_DIR, payload.name);
  fs.mkdirSync(path.dirname(p), { recursive: true });   // AI NEW-NOTE may name a brand-new folder
  fs.writeFileSync(p, payload.content, 'utf8');
  lastKnownContent = payload.content;
  return true;
});

ipcMain.handle('note:read', (e, name) => {
  try { return fs.readFileSync(path.join(NOTES_DIR, name), 'utf8'); } catch (_) { return ''; }
});

// ---- global memory (cross-vault, per-user): KUMIKO-GLOBAL.md lives in userData, NOT in any
// vault — the ผู้ใช้ (profile) memory cards follow the person across every vault on this machine.
function globalMemFile(){ return path.join(app.getPath('userData'), 'KUMIKO-GLOBAL.md'); }
ipcMain.handle('memory:global:read', () => {
  try { return fs.readFileSync(globalMemFile(), 'utf8'); } catch (_) { return ''; }
});
ipcMain.handle('memory:global:save', (e, content) => {
  try { fs.writeFileSync(globalMemFile(), String(content || '')); return { ok: true }; }
  catch (_) { return { error: 'failed' }; }
});

ipcMain.handle('pdf:read', (e, name) => {
  const rel = safeRel(name); if (!rel) return null;
  try { return fs.readFileSync(path.join(NOTES_DIR, rel)); } catch (_) { return null; }
});

// Apple Vision OCR for a PDF (macOS only) — spawns the bundled `pdf-ocr` Swift helper on the
// file and returns its extracted text. Returns null off-macOS / if the binary is missing, so
// the renderer falls back to pdf.js text. The helper is on-device (no cloud, free, Thai+Eng).
const OCR_BIN = app.isPackaged ? path.join(process.resourcesPath, 'pdf-ocr') : path.join(__dirname, 'native', 'pdf-ocr');
ipcMain.handle('pdf:ocr', (e, { name, maxPages } = {}) => {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const rel = safeRel(name); if (!rel) return Promise.resolve(null);
  const file = path.join(NOTES_DIR, rel);
  if (!fs.existsSync(file) || !fs.existsSync(OCR_BIN)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const args = [file]; if (maxPages) args.push(String(maxPages));
    let out = '', done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawn(OCR_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (_) { return finish(null); }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out.trim() ? out : null));
    setTimeout(() => { try { child.kill(); } catch (_) {} finish(out.trim() ? out : null); }, 180000);   // 3-min safety cap
  });
});

ipcMain.handle('pdf:import', async (e, payload) => {
  const win = BrowserWindow.getFocusedWindow();
  let r;
  try { r = await dialog.showOpenDialog(win, { title: 'นำเข้า PDF', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] }); }
  catch (_) { return null; }
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const base = path.basename(src);
  // land in the box the user is WORKING IN (aligned with note/box creation), root when none
  const dir = safeRel(String((payload && payload.dir) || '')) || '';
  const destDir = dir ? path.join(NOTES_DIR, dir) : NOTES_DIR;
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (_) {}
  let dest = path.join(destDir, base);
  let i = 1;
  while (fs.existsSync(dest)) { const ext = path.extname(base); const stem = base.slice(0, base.length - ext.length); dest = path.join(destDir, stem + ' (' + i + ')' + ext); i++; }
  try { fs.copyFileSync(src, dest); } catch (_) { return null; }
  return { name: (dir ? dir + '/' : '') + path.basename(dest) };
});

ipcMain.handle('pdf:rename', (e, { from, to }) => {
  const fromRel = safeRel(from); if (!fromRel) return { error: 'invalid' };
  let final = safeRel((to || '').trim()); if (!final) return { error: 'invalid' };
  if (!final.toLowerCase().endsWith('.pdf')) final += '.pdf';
  const fromPath = path.join(NOTES_DIR, fromRel);
  const toPath = path.join(NOTES_DIR, final);
  if (fs.existsSync(toPath)) return { error: 'exists' };
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  try { fs.renameSync(fromPath, toPath); } catch (_) { return { error: 'failed' }; }
  try { const aFrom = fromPath + '.annot.json'; if (fs.existsSync(aFrom)) fs.renameSync(aFrom, toPath + '.annot.json'); } catch (_) {}
  if (openFilePath && path.resolve(fromPath) === path.resolve(openFilePath)) openFilePath = toPath;
  return { name: final };
});

ipcMain.handle('pdf:readAnnots', (e, name) => {
  const rel = safeRel(name); if (!rel) return { highlights: [] };
  try { return JSON.parse(fs.readFileSync(path.join(NOTES_DIR, rel + '.annot.json'), 'utf8')); }
  catch (_) { return { highlights: [] }; }
});

ipcMain.handle('pdf:saveAnnots', (e, { name, data }) => {
  const rel = safeRel(name); if (!rel) return false;
  try { fs.writeFileSync(path.join(NOTES_DIR, rel + '.annot.json'), JSON.stringify(data || { highlights: [] }), 'utf8'); return true; }
  catch (_) { return false; }
});

ipcMain.handle('note:create', (e, name) => {
  let final = safeRel((name || '').trim());
  if (!final) return { error: 'invalid' };
  if (!final.toLowerCase().endsWith('.md')) final += '.md';
  const p = path.join(NOTES_DIR, final);
  if (fs.existsSync(p)) return { error: 'exists' };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '', 'utf8');   // no H1 — the filename is the title (shown by #noteTitle)
  return { name: final };
});

ipcMain.handle('note:rename', (e, { from, to }) => {
  let final = safeRel((to || '').trim());
  if (!final) return { error: 'invalid' };
  if (!final.toLowerCase().endsWith('.md')) final += '.md';
  const fromPath = path.join(NOTES_DIR, from);
  const toPath = path.join(NOTES_DIR, final);
  if (fs.existsSync(toPath)) return { error: 'exists' };
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.renameSync(fromPath, toPath);
  if (openFilePath && path.resolve(fromPath) === path.resolve(openFilePath)) openFilePath = toPath;

  // Wikilinks resolve by basename (folder-independent). Only a basename change
  // breaks them; a folder-only move needs no rewrite. oldBase === newBase uses
  // case-sensitive equality so a pure case-flip rename also counts as a change
  // and gets rewritten (file system already allowed the new name above).
  const oldBase = baseName(from), newBase = baseName(final);
  let updated = 0;
  if (oldBase !== newBase) {
    for (const rel of walkNotes(NOTES_DIR)) {
      const fp = path.join(NOTES_DIR, rel);
      try {
        const src = fs.readFileSync(fp, 'utf8');
        const out = rewriteLinkTargets(src, oldBase, newBase);
        if (out !== src) { fs.writeFileSync(fp, out, 'utf8'); updated++; }
      } catch (_) { /* one bad file must not abort the rename */ }
    }
    // Same rewrite for [[wikilinks]] inside PDF highlight comments + text boxes
    // (.annot.json sidecars). Free text — not escaped like the .md editor writes —
    // but rewriteLinkTargets tolerates both. One malformed sidecar must not abort.
    for (const rel of walkAnnot(NOTES_DIR)) {
      const fp = path.join(NOTES_DIR, rel);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        let dirty = false;
        const rw = (o, k) => { if (o && typeof o[k] === 'string') { const r = rewriteLinkTargets(o[k], oldBase, newBase); if (r !== o[k]) { o[k] = r; dirty = true; } } };
        if (Array.isArray(data.highlights)) data.highlights.forEach((h) => rw(h, 'note'));
        if (Array.isArray(data.textboxes)) data.textboxes.forEach((t) => rw(t, 'text'));
        if (dirty) fs.writeFileSync(fp, JSON.stringify(data), 'utf8');
      } catch (_) { /* one bad sidecar must not abort the rename */ }
    }
  }
  // Keep stored companion links pointed at the new rel path. Runs on every rename
  // (basename change AND folder-only move), since the companion field is a full note rel path.
  for (const rel of walkAnnot(NOTES_DIR)) {
    const fp = path.join(NOTES_DIR, rel);
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (data && data.companion === from) {
        data.companion = final;
        fs.writeFileSync(fp, JSON.stringify(data), 'utf8');
      }
    } catch (_) { /* one bad sidecar must not abort the rename */ }
  }
  return { name: final, updated };
});

ipcMain.handle('note:delete', (e, name) => {
  const src = path.join(NOTES_DIR, name);
  if (!fs.existsSync(src)) return { ok: false };
  const trashedName = trashMove(src); // non-destructive: move to .trash, never unlink
  const isPdf = /\.pdf$/i.test(name);
  let sidecarTrashedName = null;
  if (isPdf){
    const sc = src + '.annot.json';
    if (fs.existsSync(sc)) { try { sidecarTrashedName = trashMove(sc); } catch (_) {} }
  }
  appendTrashEntry({
    id: trashEntryId(), type: isPdf ? 'pdf' : 'note',
    trashedName, sidecarTrashedName, origPath: name, name: dispName(name),
    deletedAt: new Date().toISOString()
  });
  return { ok: true };
});

// ---- Folder operations ----
ipcMain.handle('folder:create', (e, name) => {
  const rel = safeRel((name || '').trim());
  if (!rel) return { error: 'invalid' };
  const p = path.join(NOTES_DIR, rel);
  if (fs.existsSync(p)) return { error: 'exists' };
  try { fs.mkdirSync(p, { recursive: true }); return { name: rel }; } catch (_) { return { error: 'failed' }; }
});
ipcMain.handle('folder:rename', (e, { from, to }) => {
  const relFrom = safeRel(from), relTo = safeRel((to || '').trim());
  if (!relFrom || !relTo) return { error: 'invalid' };
  const fromP = path.join(NOTES_DIR, relFrom), toP = path.join(NOTES_DIR, relTo);
  if (fs.existsSync(toP)) return { error: 'exists' };
  try { fs.mkdirSync(path.dirname(toP), { recursive: true }); fs.renameSync(fromP, toP); return { name: relTo }; } catch (_) { return { error: 'failed' }; }
});
ipcMain.handle('folder:delete', (e, name) => {
  const rel = safeRel((name || '').trim());
  if (!rel) return { error: 'invalid' };
  const src = path.join(NOTES_DIR, rel);
  if (!fs.existsSync(src)) return { error: 'failed' };
  let trashedName;
  try { trashedName = trashMove(src); } catch (_) { return { error: 'failed' }; }
  appendTrashEntry({
    id: trashEntryId(), type: 'folder', trashedName,
    origPath: rel, name: path.basename(rel), deletedAt: new Date().toISOString()
  });
  return { ok: true };
});

ipcMain.handle('note:backlinks', (e, name) => {
  const base = baseName(name);
  const out = [];
  let files = [];
  files = walkNotes(NOTES_DIR);
  for (const f of files) {
    if (f === name) continue;
    let c = '';
    try { c = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8'); } catch (_) { continue; }
    if (linksTo(c, base)) out.push(f);
  }
  return out;
});

// ---- CRDT persistence substrate (Phase 6, step 6b) ---------------------------
// Stores each note's Yjs update blob as a sidecar under <vault>/.washi/crdt/,
// mirroring the note's rel path with a .ydoc suffix. Nothing in the running
// app calls these handlers yet; they exist so the renderer can persist/restore
// CRDT state once the editor is bound to Yjs. OFFLINE: no network.
function crdtDir(){ return path.join(NOTES_DIR, '.washi', 'crdt'); }
function crdtBlobPath(rel){
  const safe = safeRel(rel);
  if (!safe) return null;
  return path.join(crdtDir(), safe + '.ydoc');
}
function crdtLoad(rel){
  try {
    const p = crdtBlobPath(rel);
    if (!p || !fs.existsSync(p)) return null;
    return fs.readFileSync(p);
  } catch (_) { return null; }
}
function crdtSave(rel, data){
  try {
    const p = crdtBlobPath(rel);
    if (!p) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(data));
    return true;
  } catch (_) { return false; }
}
ipcMain.handle('crdt:load', (e, { name } = {}) => crdtLoad(typeof name === 'string' ? name : ''));
ipcMain.handle('crdt:save', (e, { name, data } = {}) => crdtSave(typeof name === 'string' ? name : '', data));

// ---- Notion-style table view ----
function parseFMattrs(content){
  const attrs={};
  if(!content.startsWith('---')) return attrs;
  const lines=content.split(/\r?\n/);
  if(lines[0].trim()!=='---') return attrs;
  for(let i=1;i<lines.length;i++){
    if(lines[i].trim()==='---') break;
    const m=lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if(m) attrs[m[1]]=m[2].trim();
  }
  return attrs;
}

ipcMain.handle('note:table', () => {
  let files=[];
  files = walkNotes(NOTES_DIR);
  const contents={};
  for(const f of files){ try{ contents[f]=fs.readFileSync(path.join(NOTES_DIR,f),'utf8'); }catch(_){ contents[f]=''; } }
  const rows=[];
  for(const f of files){
    const attrs=parseFMattrs(contents[f]);
    const base=baseName(f);
    let backlinks=0;
    for(const g of files){ if(g===f) continue; if(linksTo(contents[g], base)) backlinks++; }
    // bodyTags: #hashtags written in the markdown body (CoreTagIndex) — source 'body' in the tag index
    let bodyTags=[]; try { bodyTags=_tagIndex.bodyTags(contents[f].replace(/^---[\s\S]*?---\n/, '')); } catch(_){}
    rows.push({ name:f, status:attrs.status||'', tags:attrs.tags||'', backlinks, bodyTags });
  }
  return rows;
});

ipcMain.handle('note:search', (e, query) => {
  const q = (query || '').trim();
  if (!q) return [];
  const ql = q.toLowerCase();
  const results = [];
  let files = [];
  files = walkNotes(NOTES_DIR);
  for (const name of files) {
    // PDF-Text/ shadows are machinery — a hit there is really a hit IN THE PDF: report it as
    // the PDF (basename + page from the '## หน้า N' markers), capped so slides don't crowd
    // out real notes. Never list the shadow file itself (log 2026-08-26).
    const isShadow = name.startsWith('PDF-Text/');
    if (!isShadow && name.toLowerCase().includes(ql)) results.push({ name, line: 0, snippet: name });
    let content = '';
    try { content = fs.readFileSync(path.join(NOTES_DIR, name), 'utf8'); } catch (_) { continue; }
    const lines = content.split(/\r?\n/);
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
});

// ---- Graph view (notes + [[wikilinks]]) ----
ipcMain.handle('graph:data', () => {
  let files=[];
  // PDF-Text/ shadow notes are RAG machinery — they'd render as orphan nodes in the graph
  files = walkNotes(NOTES_DIR).filter((f) => !f.startsWith('PDF-Text/'));
  // wikilinks resolve by BASENAME, so the graph namespace is basenames:
  // two files sharing a basename (e.g. ระบบไต.md and ชีววิทยา/ระบบไต.md) are one node,
  // otherwise the duplicates render as orphan cards with no strings attached.
  const fileByBase={};
  for(const f of files){ const k=baseName(f).toLowerCase(); if(!(k in fileByBase)) fileByBase[k]=f; }
  const nodes=Object.keys(fileByBase).map(k=>({ id: baseName(fileByBase[k]), file: fileByBase[k] }));
  const edgeSeen=new Set(); const edges=[];
  for(const f of files){
    let c=''; try{ c=fs.readFileSync(path.join(NOTES_DIR,f),'utf8'); }catch(_){ continue; }
    const fromKey=baseName(f).toLowerCase();
    for(const raw of wikiTargets(c)){          // tolerates \[\[escaped]] and [[target|alias]]
      const toKey=raw.toLowerCase();
      if(!fileByBase[toKey] || toKey===fromKey) continue;
      const key=fromKey+'->'+toKey;
      if(edgeSeen.has(key)) continue; edgeSeen.add(key);     // one string per pair, even from duplicate files
      edges.push({ from: baseName(fileByBase[fromKey] || f), to: baseName(fileByBase[toKey]) });
    }
  }
  return {nodes, edges};
});

// ---- Table databases (Notion-like), stored as JSON in <NOTES_DIR>/databases ----
function dbsDir(){ return path.join(NOTES_DIR, 'databases'); }
function ensureDbs(){ try { if(!fs.existsSync(dbsDir())) fs.mkdirSync(dbsDir(), { recursive: true }); } catch (_) {} }
function dbFilePath(id){ return path.join(dbsDir(), id + '.json'); }
function readDbFile(id){ try { return JSON.parse(fs.readFileSync(dbFilePath(id), 'utf8')); } catch (_) { return null; } }
function writeDbFile(db){ ensureDbs(); fs.writeFileSync(dbFilePath(db.id), JSON.stringify(db, null, 2), 'utf8'); }
function seedSampleDb(){
  ensureDbs();
  const marker = path.join(dbsDir(), '.seeded');
  if (fs.existsSync(marker)) return;
  try { fs.writeFileSync(marker, '1'); } catch (_) {}
  const sample = {
    id: 'db_reading_sample', name: 'รายการอ่านหนังสือ', icon: '',
    columns: [
      { id: 'c1', name: 'ชื่อเรื่อง', type: 'text' },
      { id: 'c2', name: 'สถานะ', type: 'select', options: [ { name: 'ยังไม่อ่าน', color: 'gray' }, { name: 'กำลังอ่าน', color: 'amber' }, { name: 'อ่านจบ', color: 'green' } ] },
      { id: 'c3', name: 'ความสำคัญ', type: 'select', options: [ { name: 'สูง', color: 'coral' }, { name: 'กลาง', color: 'sand' }, { name: 'ต่ำ', color: 'blue' } ] },
      { id: 'c4', name: 'หน้า', type: 'number' },
      { id: 'c5', name: 'อ่านจบ', type: 'checkbox' },
      { id: 'c6', name: 'กำหนด', type: 'date' }
    ],
    rows: [
      { id: 'r1', c1: 'Sapiens', c2: 'กำลังอ่าน', c3: 'สูง', c4: 243, c5: false, c6: '2026-07-30' },
      { id: 'r2', c1: 'Atomic Habits', c2: 'อ่านจบ', c3: 'กลาง', c4: 320, c5: true, c6: '2026-07-12' },
      { id: 'r3', c1: 'Thinking, Fast and Slow', c2: 'ยังไม่อ่าน', c3: 'สูง', c4: 0, c5: false, c6: '2026-08-15' },
      { id: 'r4', c1: 'Deep Work', c2: 'กำลังอ่าน', c3: 'ต่ำ', c4: 98, c5: false, c6: '' }
    ]
  };
  try { writeDbFile(sample); } catch (_) {}
}
ipcMain.handle('db:list', () => {
  ensureDbs(); seedSampleDb();
  let files = [];
  try { files = fs.readdirSync(dbsDir()).filter((f) => f.endsWith('.json')); } catch (_) {}
  const out = [];
  for (const f of files) {
    try {
      const db = JSON.parse(fs.readFileSync(path.join(dbsDir(), f), 'utf8'));
      out.push({ id: db.id, name: db.name, icon: '', cols: (db.columns || []).length, rows: (db.rows || []).length });
    } catch (_) {}
  }
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return out;
});
ipcMain.handle('db:read', (e, id) => readDbFile(id));
ipcMain.handle('db:save', (e, db) => { if (db && db.id) { writeDbFile(db); return true; } return false; });
ipcMain.handle('db:create', (e, opts) => {
  const o = opts || {};
  const id = 'db_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const db = {
    id, name: o.name || 'ฐานข้อมูลใหม่', icon: o.icon || '',
    columns: [
      { id: 'c1', name: 'ชื่อ', type: 'text' },
      { id: 'c2', name: 'สถานะ', type: 'select', options: [ { name: 'ยังไม่เริ่ม', color: 'gray' }, { name: 'กำลังทำ', color: 'amber' }, { name: 'เสร็จ', color: 'green' } ] },
      { id: 'c3', name: 'เสร็จ', type: 'checkbox' }
    ],
    rows: [ { id: 'r' + Date.now().toString(36), c1: '', c2: '', c3: false } ]
  };
  writeDbFile(db); return db;
});
ipcMain.handle('db:delete', (e, id) => {
  const db = readDbFile(id);                 // grab display name BEFORE the file moves
  const src = dbFilePath(id);
  if (!fs.existsSync(src)) return false;
  let trashedName;
  try { trashedName = trashMove(src); } catch (_) { return false; }
  appendTrashEntry({
    id: trashEntryId(), type: 'db', trashedName,
    origPath: 'databases/' + id + '.json', name: (db && db.name) || id, dbId: id,
    deletedAt: new Date().toISOString()
  });
  return true;
});

// ---- Trash: list / restore / delete-forever / empty ----
// Restore: move .trash/<trashedName> back to origPath under NOTES_DIR (mkdir parents;
// collision-safe numeric suffix on the basename if the destination already exists).
// PDF entries also move their sidecar next to the restored file.
function restoreIntoPlace(entry){
  const src = path.join(trashDir(), entry.trashedName);
  const destAbs = path.join(NOTES_DIR, entry.origPath);
  try { fs.mkdirSync(path.dirname(destAbs), { recursive: true }); } catch (_) {}
  const ext = path.extname(destAbs);
  const stem = ext ? destAbs.slice(0, destAbs.length - ext.length) : destAbs;
  let final = destAbs; let i = 1;
  while (fs.existsSync(final)){ final = stem + '.' + i + ext; i++; }
  fs.renameSync(src, final);
  if (entry.type === 'pdf' && entry.sidecarTrashedName){
    const scSrc = path.join(trashDir(), entry.sidecarTrashedName);
    if (fs.existsSync(scSrc)){ try { fs.renameSync(scSrc, final + '.annot.json'); } catch (_) {} }
  }
  return true;
}
ipcMain.handle('trash:list', () => {
  const out = [];
  for (const e of readTrashManifest()){
    if (!fs.existsSync(path.join(trashDir(), e.trashedName))) continue;  // stale — omit
    out.push({ id: e.id, type: e.type, name: e.name, origPath: e.origPath, deletedAt: e.deletedAt });
  }
  out.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')));
  return out;
});
ipcMain.handle('trash:restore', (e, id) => {
  const arr = readTrashManifest();
  const idx = arr.findIndex((x) => x.id === id);
  if (idx < 0) return { error: 'notfound' };
  const ent = arr[idx];
  if (!fs.existsSync(path.join(trashDir(), ent.trashedName))){ arr.splice(idx, 1); writeTrashManifest(arr); return { error: 'gone' }; }
  try { restoreIntoPlace(ent); } catch (_) { return { error: 'failed' }; }
  arr.splice(idx, 1); writeTrashManifest(arr);
  return { ok: true, type: ent.type };
});
ipcMain.handle('trash:deleteForever', (e, id) => {
  const arr = readTrashManifest();
  const idx = arr.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: true };
  const ent = arr[idx];
  rmIfExists(path.join(trashDir(), ent.trashedName));
  if (ent.sidecarTrashedName) rmIfExists(path.join(trashDir(), ent.sidecarTrashedName));
  arr.splice(idx, 1); writeTrashManifest(arr);
  return { ok: true };
});
ipcMain.handle('trash:empty', () => {
  const arr = readTrashManifest();
  for (const ent of arr){
    rmIfExists(path.join(trashDir(), ent.trashedName));
    if (ent.sidecarTrashedName) rmIfExists(path.join(trashDir(), ent.sidecarTrashedName));
  }
  writeTrashManifest([]);
  return { ok: true };
});

// open an external http(s) URL in the user's default browser (annotation comment links)
ipcMain.handle('open:external', (e, url) => { try { if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url); } catch (_) {} });

function startWatch() {
  if (watcher) watcher.close();
  watcher = chokidar.watch(NOTES_DIR, { ignoreInitial: true });
  watcher.on('change', (p) => {
    const rel = path.relative(NOTES_DIR, p).split(path.sep).join('/');
    if (!rel.endsWith('.md') || rel.startsWith('.washi/') || rel.startsWith('.trash/') || rel.startsWith('databases/')) return;
    const isOpen = openFilePath && path.resolve(p) === path.resolve(openFilePath);
    if (!isOpen) {
      // An AI edit to a file the user does NOT have open used to land silently (auto-accepted).
      // Flag it so the sidebar can show a review dot. Gated to engine activity so app-driven
      // multi-file writes (rename link rewrites, sync) don't false-flag.
      if (engineProcs.size > 0 || Date.now() - _lastEngineExit < 10000) {
        if (win && !win.isDestroyed()) win.webContents.send('note:flagged', { name: rel });
      }
      return;
    }
    let content;
    try { content = fs.readFileSync(p, 'utf8'); } catch (_) { return; }
    if (content === lastKnownContent) return; // our own save, ignore
    const before = lastKnownContent;          // previous on-disk content, for a clean (un-normalized) diff base
    lastKnownContent = content;
    if (win && !win.isDestroyed()) {
      const rel = path.relative(NOTES_DIR, p).split(path.sep).join('/');   // match currentNote (rel path, / separators) so folder notes reload too
      win.webContents.send('note:changed', { name: rel, content, before });
    }
  });
}

// ---- Vault: list / switch / open / create ----
ipcMain.handle('vault:list', () => {
  const reg = readVaults();
  const recents = reg.recents
    .filter((r) => fs.existsSync(r.path))
    .map((r) => ({ path: r.path, name: vaultName(r.path) }));
  const current = reg.current && fs.existsSync(reg.current)
    ? { path: reg.current, name: vaultName(reg.current) }
    : null;
  return { current, recents };
});

ipcMain.handle('vault:switch', (e, { path: p } = {}) => {
  if (typeof p !== 'string' || !p || !fs.existsSync(p)) return { error: 'missing' };
  registerVault(p);
  NOTES_DIR = p;
  return { ok: true };
});

ipcMain.handle('vault:open', async () => {
  if (!win || win.isDestroyed()) return { error: 'nowin' };
  let r;
  try { r = await dialog.showOpenDialog(win, { title: 'เปิดโฟลเดอร์เป็น vault', properties: ['openDirectory'] }); }
  catch (_) { return { error: 'failed' }; }
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
  const dir = r.filePaths[0];
  registerVault(dir);
  NOTES_DIR = dir;
  return { ok: true, path: dir };
});

ipcMain.handle('vault:create', async () => {
  if (!win || win.isDestroyed()) return { error: 'nowin' };
  let r;
  try { r = await dialog.showOpenDialog(win, { title: 'สร้าง/เลือกโฟลเดอร์ vault ใหม่', properties: ['openDirectory', 'createDirectory'] }); }
  catch (_) { return { error: 'failed' }; }
  if (!r || r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
  const dir = r.filePaths[0];
  registerVault(dir);
  NOTES_DIR = dir;
  return { ok: true, path: dir };
});

// ---- Per-vault .washi/<key>.json config (Phase 2 plumbing) ----
function safeConfigKey(k){
  return typeof k === 'string' && /^[A-Za-z0-9_-]+$/.test(k) ? k : null;
}
function washiDir(){ return path.join(NOTES_DIR, '.washi'); }
ipcMain.handle('vault:configRead', (e, { key } = {}) => {
  const k = safeConfigKey(key); if (!k) return null;
  try { return JSON.parse(fs.readFileSync(path.join(washiDir(), k + '.json'), 'utf8')); }
  catch (_) { return null; }
});
ipcMain.handle('vault:configWrite', (e, { key, data } = {}) => {
  const k = safeConfigKey(key); if (!k) return { error: 'invalid' };
  try {
    fs.mkdirSync(washiDir(), { recursive: true });
    fs.writeFileSync(path.join(washiDir(), k + '.json'), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true };
  } catch (_) { return { error: 'failed' }; }
});

// Sync read of per-vault state at renderer boot (small JSON; reading synchronously is fine).
ipcMain.on('vault:stateReadSync', (e) => {
  try { e.returnValue = JSON.parse(fs.readFileSync(path.join(washiDir(), 'state.json'), 'utf8')); }
  catch (_) { e.returnValue = null; }
});

