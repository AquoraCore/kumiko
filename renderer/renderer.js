// markdown rendering lives in core/markdown.js (loaded before this file); pull the pure fns from the global.
const { mdToHtml, _mdInline, _mdEsc } = window.CoreMarkdown;
const { parseFrontmatter, serializeFrontmatter } = window.CoreFrontmatter;
const { _lcsOps, diffSegments, addLinesFromText, mergeSegments } = window.CoreTextDiff;
const { _lev, _sim } = window.CoreTextSim;
const { composeRagPrompt } = window.CoreRag;
// ---------- Terminal ----------
const term = new Terminal({
  fontFamily: '"SF Mono", "JetBrains Mono", Menlo, monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
    selectionBackground: '#3a3d41',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open(document.getElementById('terminal'));

const TERM_THEME = {
  dark:  { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#3a3d41' },
  light: { background: '#f4f2ec', foreground: '#2c2c2a', cursor: '#2c2c2a', selectionBackground: '#dcd9cf' },
};
function applyTermTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  term.options.theme = isDark ? TERM_THEME.dark : TERM_THEME.light;
}
applyTermTheme();

function fitTerm() {
  try {
    fit.fit();
    window.api.ptyResize({ cols: term.cols, rows: term.rows });
  } catch (_) {}
}

window.api.startPty({ cols: term.cols, rows: term.rows });
window.api.onPtyData((d) => term.write(d));
term.onData((d) => window.api.ptyInput(d));
setTimeout(fitTerm, 60);
window.addEventListener('resize', () => setTimeout(fitTerm, 30));

// i18n moved to renderer/i18n.js (loaded before renderer.js): uiLang, t(), setUiLang(), applyStaticI18n(), I18N_EN
let termFontSize = parseInt(localStorage.getItem('termFontSize') || '13', 10);
term.options.fontSize = termFontSize;

document.getElementById('clearBtn').onclick = () => term.clear();

document.getElementById('termStopBtn').onclick = () => { window.api.ptyInput('\x03'); term.focus(); };
document.getElementById('termRestartBtn').onclick = () => { term.reset(); window.api.ptyRestart({ cols: term.cols, rows: term.rows }); term.focus(); };

// ---------- Engine switcher ----------
const engineSelect = document.getElementById('engineSelect');
const modelSelect = document.getElementById('modelSelect');
const claudeBtn = document.getElementById('claudeBtn');

let currentEngine = localStorage.getItem('engine') || 'glm';
let currentModel = localStorage.getItem('glmModel') || 'glm-5.2';

function applyEngineUI() {
  engineSelect.value = currentEngine;
  modelSelect.value = currentModel;
  modelSelect.hidden = currentEngine !== 'glm';
  claudeBtn.innerHTML = icoSvg('play') + (currentEngine === 'glm' ? t(' เริ่ม opencode') : t(' เริ่ม claude'));
}
function updateHint() {
  const h = document.getElementById('hint');
  if (!h) return;
  if (currentEngine === 'glm') {
    h.innerHTML = t('engine ปัจจุบัน: <code>GLM (OpenCode)</code> · คลุมคำในโน้ตแล้วกดปุ่ม action เพื่อให้ AI แก้โน้ตให้ (ไม่ต้อง login)');
  } else {
    h.innerHTML = t('engine ปัจจุบัน: <code>Claude</code> · ครั้งแรกกด “เริ่ม claude” เพื่อ login');
  }
}
engineSelect.onchange = () => { currentEngine = engineSelect.value; localStorage.setItem('engine', currentEngine); applyEngineUI(); updateHint(); };
modelSelect.onchange = () => { currentModel = modelSelect.value; localStorage.setItem('glmModel', currentModel); };
applyEngineUI();

claudeBtn.onclick = () => {
  window.api.ptyInput(currentEngine === 'glm' ? 'opencode\r' : 'claude\r');
  term.focus();
};

// ---------- AI Chat: multi-session (paper tabs) ----------
function stripAnsi(s){ return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, ''); }
function cleanChatText(s){
  return stripAnsi(s)
    .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
    .replace(/^\s*>\s*build\b.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}
function chatScroll(){ const m = document.getElementById('chatMessages'); if (m) m.scrollTop = m.scrollHeight; }

const SESSION_ICONS = ['note','task','graph','sparkle','pencil','dash','db','star'];
const SCOPE_LABEL = { note: 'อ้างอิงโน้ตนี้', vault: 'ทั้ง vault', free: 'อิสระ' };
const GLM_MODELS = ['glm-5.2','glm-5.1','glm-5-turbo','glm-4.7','glm-4.5-air'];
let sessions = [];
let activeId = null;
let liveBubble = null;     // ai bubble DOM element of the active session's running turn (else null)

function persistSessions(){
  try {
    const slim = sessions.map((s) => ({ id: s.id, name: s.name, icon: s.icon, engine: s.engine, model: s.model, scope: s.scope,
      messages: s.messages.map((m) => ({ role: m.role, text: m.text })) }));
    vsSet('aiSessions', { sessions: slim, activeId });
  } catch (_) {}
}
function newSession(opts){
  const id = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  return Object.assign({ id, name: 'แชตใหม่', icon: 'note', engine: currentEngine, model: currentModel, scope: 'free', messages: [], running: false }, opts || {});
}
function loadSessions(){
  let saved = vsGet('aiSessions', null);
  if (saved && Array.isArray(saved.sessions) && saved.sessions.length) {
    sessions = saved.sessions.map((s) => ({ id: s.id, name: s.name, icon: (s.icon && /^[a-z-]+$/.test(s.icon)) ? s.icon : 'note', engine: s.engine || 'glm',
      model: s.model || 'glm-5.2', scope: s.scope || 'free', running: false,
      messages: Array.isArray(s.messages) ? s.messages.map((m) => ({ role: m.role, text: m.text })) : [] }));
    activeId = (saved.activeId && sessions.some((s) => s.id === saved.activeId)) ? saved.activeId : sessions[0].id;
  } else {
    sessions = [
      newSession({ name: 'เนื้อหา', icon: 'note', scope: 'note', engine: 'glm', model: 'glm-5.2',
        messages: [{ role: 'ai', text: 'ถามเรื่องเนื้อหาในโน้ตได้เลย ผมอ้างอิงโน้ตที่เปิดอยู่' }] }),
      newSession({ name: 'งาน', icon: 'task', scope: 'free', engine: 'glm', model: 'glm-5.2',
        messages: [{ role: 'ai', text: 'วางแผน / สั่งงาน task ได้ที่นี่' }] }),
    ];
    activeId = sessions[0].id;
  }
}
function sessionById(id){ return sessions.find((s) => s.id === id) || null; }
function activeSession(){ return sessionById(activeId) || sessions[0]; }
function isRunning(id){ const s = sessionById(id); return !!(s && s.running); }
function syncEngineFromSession(){
  const s = activeSession(); if (!s) return;
  currentEngine = s.engine; currentModel = s.model;
  localStorage.setItem('engine', currentEngine); localStorage.setItem('glmModel', currentModel);
  if (typeof applyEngineUI === 'function') applyEngineUI();
}

function renderTabs(){
  const bar = document.getElementById('sessionTabs'); if (!bar) return;
  bar.innerHTML = '';
  sessions.forEach((s) => {
    const tab = document.createElement('div');
    tab.className = 'stab' + (s.id === activeId ? ' active' : '') + (s.engine === 'glm' ? ' g' : ' c');
    const ic = document.createElement('span'); ic.className = 'ico'; ic.innerHTML = icoSvg(s.icon || 'note', 'sm');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name;
    const eng = document.createElement('span'); eng.className = 'eng'; eng.textContent = s.engine === 'glm' ? 'GLM' : 'Claude';
    tab.appendChild(ic); tab.appendChild(nm); tab.appendChild(eng);
    if (s.running) { const d = document.createElement('span'); d.className = 'rundot'; tab.appendChild(d); }
    const x = document.createElement('span'); x.className = 'stab-x'; x.title = t('ปิดแท็บ'); x.innerHTML = '&times;';
    x.onclick = (e) => { e.stopPropagation(); deleteSession(s); };
    tab.appendChild(x);
    tab.onclick = () => switchSession(s.id);
    bar.appendChild(tab);
  });
  const add = document.createElement('div'); add.className = 'stab add'; add.textContent = '＋'; add.title = t('session ใหม่');
  add.onclick = addSession;
  bar.appendChild(add);
  if (typeof updateSendButton === 'function') updateSendButton();
}
function renderHead(){
  const head = document.getElementById('sessionHead'); if (!head) return;
  const s = activeSession(); head.innerHTML = '';
  const nm = document.createElement('span'); nm.className = 'sh-nm'; nm.innerHTML = icoSvg(s.icon || 'note', 'sm'); nm.appendChild(document.createTextNode(' ' + s.name));
  head.appendChild(nm);
  const scope = document.createElement('select'); scope.className = 'sh-scope'; scope.title = t('ขอบเขตบริบท');
  ['note','vault','free'].forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(SCOPE_LABEL[v]); if (s.scope === v) o.selected = true; scope.appendChild(o); });
  scope.onchange = () => { s.scope = scope.value; persistSessions(); };
  head.appendChild(scope);
  const sp = document.createElement('span'); sp.className = 'sh-sp'; head.appendChild(sp);
  const eng = document.createElement('select'); eng.className = 'sh-eng'; eng.title = 'engine';
  [['glm','GLM'],['claude','Claude']].forEach(([v,l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (s.engine === v) o.selected = true; eng.appendChild(o); });
  const mdl = document.createElement('select'); mdl.className = 'sh-mdl'; mdl.title = 'model';
  GLM_MODELS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (s.model === v) o.selected = true; mdl.appendChild(o); });
  mdl.hidden = s.engine !== 'glm';
  eng.onchange = () => { s.engine = eng.value; mdl.hidden = s.engine !== 'glm'; syncEngineFromSession(); persistSessions(); renderTabs(); };
  mdl.onchange = () => { s.model = mdl.value; syncEngineFromSession(); persistSessions(); };
  head.appendChild(eng); head.appendChild(mdl);
  const dots = document.createElement('button'); dots.className = 'sh-dots'; dots.textContent = '⋯'; dots.title = t('จัดการ session');
  dots.onclick = (e) => { e.stopPropagation(); openSessionMenu(dots, s); };
  head.appendChild(dots);
}
function renderChat(){
  const box = document.getElementById('chatMessages'); if (!box) return;
  const s = activeSession(); box.innerHTML = ''; liveBubble = null;
  s.messages.forEach((m, i) => {
    const wrap = document.createElement('div'); wrap.className = 'm-wrap ' + m.role;
    if (m.role === 'ai') { const who = document.createElement('div'); who.className = 'who'; who.textContent = s.engine === 'glm' ? 'GLM' : 'Claude'; wrap.appendChild(who); }
    if (m.role === 'ai' && Array.isArray(m.sources) && m.sources.length > 0) {
      const row = document.createElement('div');
      row.className = 'rag-sources';
      const label = document.createElement('span'); label.className = 'rag-sources-label';
      label.textContent = '📎 ' + t('อ้างอิง') + ' ' + m.sources.length + ' ' + t('โน้ต');
      row.appendChild(label);
      m.sources.forEach((src) => { const pill = document.createElement('span'); pill.className = 'rag-src'; pill.textContent = src; row.appendChild(pill); });
      wrap.appendChild(row);
    }
    const b = document.createElement('div'); b.className = 'm ' + m.role;
    const running = s.running && i === s.messages.length - 1 && m.role === 'ai';
    if (running && !m.text) { b.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>'; liveBubble = b; }
    else if (m.role === 'ai') { b.innerHTML = mdToHtml(m.text); if (running) liveBubble = b; }
    else { b.textContent = m.text; }
    wrap.appendChild(b); box.appendChild(wrap);
  });
  chatScroll();
  if (typeof updateSendButton === 'function') updateSendButton();
}
function renderSessions(){ renderTabs(); renderHead(); renderChat(); }
function switchSession(id){ if (id === activeId) return; activeId = id; syncEngineFromSession(); persistSessions(); renderSessions(); if (typeof updateSendButton === 'function') updateSendButton(); }
function addSession(){
  const s = newSession({ name: 'แชตใหม่', icon: SESSION_ICONS[sessions.length % SESSION_ICONS.length] });
  sessions.push(s); activeId = s.id; syncEngineFromSession(); persistSessions(); renderSessions();
  setTimeout(() => startRename(s), 0);
}
function deleteSession(s){
  const i = sessions.findIndex((x) => x.id === s.id); if (i < 0) return;
  sessions.splice(i, 1);
  if (!sessions.length) { sessions.push(newSession({ name: 'แชต', icon: 'note' })); }
  if (activeId === s.id) activeId = sessions[Math.max(0, i - 1)].id;
  syncEngineFromSession(); persistSessions(); renderSessions();
}
function startRename(s){
  const head = document.getElementById('sessionHead'); if (!head) return;
  const nmEl = head.querySelector('.sh-nm'); if (!nmEl) return;
  const inp = document.createElement('input'); inp.className = 'sh-rename'; inp.value = s.name;
  nmEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) s.name = v; persistSessions(); renderSessions(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderSessions(); } });
  inp.addEventListener('blur', commit);
}
function closeSessionMenu(){ const m = document.getElementById('shMenu'); if (m) m.remove(); }
function openSessionMenu(anchor, s){
  closeSessionMenu();
  const menu = document.createElement('div'); menu.className = 'sh-menu'; menu.id = 'shMenu';
  const items = [ [t('เปลี่ยนชื่อ'), () => startRename(s)], [t('ล้างแชต'), () => { s.messages = []; persistSessions(); renderChat(); }] ];
  if (sessions.length > 1) items.push([t('ลบ session'), () => deleteSession(s)]);
  items.forEach(([label, fn]) => { const it = document.createElement('div'); it.className = 'sh-mi'; it.textContent = label; it.onclick = () => { closeSessionMenu(); fn(); }; menu.appendChild(it); });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, r.right - 150) + 'px';
  setTimeout(() => document.addEventListener('mousedown', closeSessionMenu, { once: true }), 0);
}

// pushes a user turn + empty ai turn into the ACTIVE session, marks it running; returns its id (= runId)
function beginAiTurn(userText, sources){
  const s = activeSession();
  s.messages.push({ role: 'user', text: userText });
  s.messages.push({ role: 'ai', text: '', _acc: '', sources: Array.isArray(sources) ? sources : [] });
  s.running = true;
  persistSessions(); renderSessions();
  return s.id;
}
function buildSessionPrompt(s, msg){
  let ctx = '';
  if (s.scope === 'note' && currentNote) {
    let body = '';
    try { body = (typeof getFullMarkdown === 'function') ? getFullMarkdown() : ''; } catch (_) {}
    ctx = 'บริบท — โน้ต "' + currentNote + '":\n---\n' + body + '\n---\n\n';
  } else if (s.scope === 'vault') {
    const names = Array.from(document.querySelectorAll('#noteList .note-item')).map((n) => n.textContent.trim()).filter(Boolean);
    if (names.length) ctx = 'รายชื่อโน้ตทั้งหมด: ' + names.join(', ') + '\n\n';
  }
  const prior = s.messages.slice(-10).map((m) => (m.role === 'user' ? 'ผู้ใช้: ' : 'ผู้ช่วย: ') + m.text).join('\n');
  return ctx + (prior ? prior + '\n' : '') + 'ผู้ใช้: ' + msg;
}

// engine output → route to the session named by runId (multiple may run concurrently)
window.api.onEngineOutput((payload) => {
  const runId = payload && payload.runId;
  const data = (payload && payload.data) || '';
  term.write(data.replace(/\n/g, '\r\n'));
  if (!runId) return;
  const s = sessionById(runId); if (!s) return;
  const last = s.messages[s.messages.length - 1]; if (!last || last.role !== 'ai') return;
  last._acc = (last._acc || '') + stripAnsi(data);
  const shown = cleanChatText(last._acc).trim();
  if (shown) { last.text = shown; if (runId === activeId && liveBubble) { liveBubble.innerHTML = mdToHtml(shown); chatScroll(); } }
});
window.api.onEngineDone((payload) => { if (payload && typeof payload.code !== 'undefined') term.write('\r\n\x1b[32m[done] ' + t('เสร็จ') + ' (exit ' + payload.code + ')\x1b[0m\r\n'); });
window.api.onEngineDone((payload) => {
  const runId = payload && payload.runId; if (!runId) return;
  const s = sessionById(runId); if (!s) return;
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === 'ai') { const shown = cleanChatText(last._acc || '').trim(); last.text = shown || t('(เสร็จ · ไม่มีข้อความตอบกลับ)'); delete last._acc; }
  s.running = false;
  persistSessions(); renderTabs();
  if (runId === activeId) renderChat();
});

// ---------- Editor / notes ----------
const editorHost = document.getElementById('editorHost');
const noteTitleEl = document.getElementById('noteTitle');   // H0: read-only page title = filename
// The title is NOT editable inline; clicking it opens the rename dialog (renaming the file is the
// only way to change the title — duplicates are already forbidden and [[links]] auto-update on rename).
noteTitleEl.addEventListener('click', () => { if (currentNote) renameNoteAt(currentNote); });
let crepe = null;
let applying = false;
let currentAttrs = {};
let loadedBody = '';   // Crepe-normalized baseline; a change only counts as dirty if it differs from this
// The H0 title (#noteTitle, derived from the filename) replaces the old in-body H1, so drop a
// leading top-level "# ..." (the first non-empty line + one trailing blank) before it enters the
// editor. Done here, in loadEditor, so EVERY load path (open / reload / AI-accept / autolink) is
// consistent — and the `loadedBody` baseline below is captured from the stripped text, so merely
// opening an old note never looks dirty. Save (getFullMarkdown) never re-adds an H1.
function stripLeadingH1(md){
  const lines = String(md == null ? '' : md).split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;        // first non-empty line
  if (i < lines.length && /^#\s+/.test(lines[i])) {              // top-level "# ..." only (## stays)
    i++;
    if (i < lines.length && lines[i].trim() === '') i++;         // swallow one trailing blank
  }
  return lines.slice(i).join('\n');
}
async function loadEditor(bodyMarkdown){
  applying = true;
  if (crepe) { try { await crepe.destroy(); } catch (_) {} crepe = null; }
  editorHost.innerHTML = '';
  // Disable Crepe's virtual cursor — it renders invisible inside callout boxes.
  // The real browser caret (visible everywhere) is used instead.
  const feat = (window.Crepe.Feature && window.Crepe.Feature.Cursor) || 'cursor';
  crepe = new window.Crepe({ root: editorHost, defaultValue: stripLeadingH1(bodyMarkdown), features: { [feat]: false } });
  if (window.MDHeadingFold) { try { crepe.editor.use(window.MDHeadingFold); } catch (_) {} }
  if (window.MDWikiLink) { try { crepe.editor.use(window.MDWikiLink); } catch (_) {} }
  await crepe.create();
  loadedBody = crepe.getMarkdown();   // capture AFTER create so Crepe's own normalization isn't seen as an edit
  crepe.on((l) => l.markdownUpdated(() => {
    if (applying) return;
    if (crepe.getMarkdown().trim() === (loadedBody || '').trim()) return;   // spurious emit / no real change
    setDirty(true);
  }));
  applying = false;
}
function getBody(){ return crepe ? crepe.getMarkdown() : ''; }
function getFullMarkdown(){ return serializeFrontmatter(currentAttrs, getBody()); }
function currentSelection(){ return (window.getSelection ? window.getSelection().toString() : '').trim(); }

const noteList = document.getElementById('noteList');
const dirtyTag = document.getElementById('dirty');
const banner = document.getElementById('reloadBanner');

let currentNote = null;
let dirty = false;
let pendingClaudeContent = null;
let suppressWatcher = false;   // guard so applying a review's result doesn't re-trigger a review

function setDirty(v) {
  dirty = v;
  dirtyTag.hidden = !v;
}

// ---------- Per-vault state (stored in <vault>/.washi/state.json, NOT localStorage) ----------
// Read SYNC at boot; written ASYNC (debounced) via vaultConfigWrite('state', VS).
const VS_MIG_KEYS = ['aiSessions','dashboards','dashWidgets','curDashId','dashSeq','collapsedFolders','sbSecCollapsed','lastNote','lastOpen','lastPdf','taskDbId'];
function lsJson(k, dflt){ try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return (v == null) ? dflt : v; } catch (_) { return dflt; } }
function lsInt(k, dflt){ const n = parseInt(localStorage.getItem(k) || '', 10); return isNaN(n) ? dflt : n; }
function lsPdfPages(){ const out = {}; for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k && k.indexOf('pdfPage:') === 0){ const pg = parseInt(localStorage.getItem(k) || '1', 10); if (!isNaN(pg) && pg > 0) out[k.slice('pdfPage:'.length)] = pg; } } return out; }
function lsHasOldKeys(){ for (const k of VS_MIG_KEYS){ if (localStorage.getItem(k) !== null) return true; } for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k && k.indexOf('pdfPage:') === 0) return true; } return false; }

let VS = window.api.vaultStateReadSync();
if (VS == null) {
  if (!localStorage.getItem('washiStateMigrated') && lsHasOldKeys()) {
    // First upgrade: adopt the existing GLOBAL state into THIS (the current/default) vault.
    VS = {
      aiSessions: lsJson('aiSessions', null),
      dashboards: lsJson('dashboards', null),
      dashWidgets: lsJson('dashWidgets', []),
      curDashId: localStorage.getItem('curDashId'),
      dashSeq: lsInt('dashSeq', 1),
      collapsedFolders: lsJson('collapsedFolders', []),
      sbSecCollapsed: lsJson('sbSecCollapsed', []),
      lastNote: localStorage.getItem('lastNote'),
      lastOpen: lsJson('lastOpen', null),
      lastPdf: localStorage.getItem('lastPdf'),
      taskDbId: localStorage.getItem('taskDbId') || '',
      pdfPages: lsPdfPages(),
    };
    try { window.api.vaultConfigWrite('state', VS); } catch (_) {}
    localStorage.setItem('washiStateMigrated', '1');
    VS_MIG_KEYS.forEach((k) => localStorage.removeItem(k));   // remove migrated per-vault keys (global prefs untouched)
    for (let i = localStorage.length - 1; i >= 0; i--){ const k = localStorage.key(i); if (k && k.indexOf('pdfPage:') === 0) localStorage.removeItem(k); }
  } else {
    VS = {};   // fresh/other vault → start clean, NO global-state bleed
  }
}

let _vsTimer = null;
function vsSaveDebounced(){
  if (_vsTimer) clearTimeout(_vsTimer);
  _vsTimer = setTimeout(() => { _vsTimer = null; try { window.api.vaultConfigWrite('state', VS); } catch (_) {} }, 250);
}
function vsGet(k, dflt){ return (VS && VS[k] !== undefined && VS[k] !== null) ? VS[k] : dflt; }
function vsSet(k, v){ if (!VS) VS = {}; VS[k] = v; vsSaveDebounced(); }
function vsPdfPageGet(rel){ return (VS && VS.pdfPages) ? VS.pdfPages[rel] : undefined; }
function vsPdfPageSet(rel, v){ if (!VS) VS = {}; if (!VS.pdfPages) VS.pdfPages = {}; VS.pdfPages[rel] = v; vsSaveDebounced(); }
function vsPdfPageRename(oldRel, newRel){ if (!VS || !VS.pdfPages || VS.pdfPages[oldRel] == null) return; VS.pdfPages[newRel] = VS.pdfPages[oldRel]; delete VS.pdfPages[oldRel]; vsSaveDebounced(); }
function vsPdfPageDelete(rel){ if (!VS || !VS.pdfPages || VS.pdfPages[rel] == null) return; delete VS.pdfPages[rel]; vsSaveDebounced(); }

// ---------- Sidebar: folder tree ----------
const collapsedFolders = new Set(vsGet('collapsedFolders', []));
function persistCollapsed(){ vsSet('collapsedFolders', [...collapsedFolders]); }
let noteTreeRoot = null;
let currentCrate = '';   // folder path shown in #crateView ('' = root)
let noteDragSrc = null;
let pdfDragSrc = null;
let folderDragSrc = null;

function buildNoteTree(notes, folders, pdfs){
  const root = { name: '', path: '', folders: {}, notes: [], pdfs: [] };
  const ensure = (rel) => {
    if (!rel) return root;
    const parts = rel.split('/'); let node = root; let acc = '';
    for (const p of parts){ acc = acc ? acc + '/' + p : p; if (!node.folders[p]) node.folders[p] = { name: p, path: acc, folders: {}, notes: [], pdfs: [] }; node = node.folders[p]; }
    return node;
  };
  (folders || []).forEach((f) => ensure(f));
  (notes || []).forEach((n) => { const i = n.lastIndexOf('/'); const dir = i < 0 ? '' : n.slice(0, i); ensure(dir).notes.push(n); });
  (pdfs || []).forEach((p) => { const i = p.lastIndexOf('/'); const dir = i < 0 ? '' : p.slice(0, i); ensure(dir).pdfs.push(p); });
  return root;
}
function countTreeNotes(node){ if (!node) return 0; let c = (node.notes || []).length; Object.values(node.folders || {}).forEach((f) => { c += countTreeNotes(f); }); return c; }
async function moveNote(from, folderPath){
  const base = from.slice(from.lastIndexOf('/') + 1);
  const to = folderPath ? folderPath + '/' + base : base;
  if (to === from) return;
  const r = await window.api.renameNote(from, to);
  if (r && r.error === 'exists') { alert(t('มีโน้ตชื่อนี้อยู่ในกล่องนั้นแล้ว')); return; }
  await refreshList(r && r.name ? r.name : from);
}
function folderCanMoveTo(fromPath, destParentPath){
  if (destParentPath === fromPath) return false;
  if (destParentPath && destParentPath.startsWith(fromPath + '/')) return false;
  return true;
}
async function moveFolder(fromPath, destParentPath){
  const base = fromPath.slice(fromPath.lastIndexOf('/') + 1);
  const to = destParentPath ? destParentPath + '/' + base : base;
  if (to === fromPath) return;
  if (!folderCanMoveTo(fromPath, destParentPath)) return;
  const r = await window.api.folderRename(fromPath, to);
  if (r && r.error === 'exists') { alert(t('มีกล่องชื่อนี้อยู่ในกล่องนั้นแล้ว')); return; }
  if (destParentPath) collapsedFolders.delete(destParentPath);
  await refreshList(currentNote);
}
function makeNoteItem(rel, depth, opts){
  const o = opts || {};
  const item = document.createElement('div');
  item.className = 'note-item'; item.dataset.name = rel;
  if (o.companion) item.classList.add('companion-note');
  item.innerHTML = '<span class="sb-chevsp"></span>' + icoSvg(o.icon || 'note', 'sm') + '<span class="note-nm"></span>';
  item.querySelector('.note-nm').textContent = o.label != null ? o.label : rel.replace(/\.md$/i, '').split('/').pop();
  item.style.paddingLeft = (8 + depth * 22) + 'px';        // root notes line up with folders; nested notes step in
  if (depth > 0) item.classList.add('nested');
  item.draggable = true;
  item.onclick = () => openNote(rel);
  item.oncontextmenu = (e) => { e.preventDefault(); openNoteMenu(e.clientX, e.clientY, rel); };
  item.addEventListener('dragstart', (e) => { noteDragSrc = rel; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); });
  item.addEventListener('dragend', () => { noteDragSrc = null; item.classList.remove('dragging'); });
  return item;
}
function makeFolderRow(node, depth){
  const row = document.createElement('div');
  row.className = 'folder-row'; row.style.paddingLeft = (8 + depth * 22) + 'px';
  const collapsed = collapsedFolders.has(node.path);
  const tri = document.createElement('span'); tri.className = 'folder-tri'; tri.innerHTML = icoSvg(collapsed ? 'chev' : 'chevdown', 'xs');
  const ic = document.createElement('span'); ic.className = 'folder-ic'; ic.innerHTML = icoSvg('crate', 'sm');
  const nm = document.createElement('span'); nm.className = 'folder-nm'; nm.textContent = node.name;
  row.appendChild(tri); row.appendChild(ic); row.appendChild(nm);
  tri.onclick = (e) => { e.stopPropagation(); if (collapsed) collapsedFolders.delete(node.path); else collapsedFolders.add(node.path); persistCollapsed(); renderTree(); };
  row.onclick = () => openCrate(node.path);
  row.oncontextmenu = (e) => { e.preventDefault(); openFolderMenu(row, node); };
  row.draggable = true;
  row.addEventListener('dragstart', (e) => { folderDragSrc = node.path; e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); e.stopPropagation(); });
  row.addEventListener('dragend', () => { folderDragSrc = null; row.classList.remove('dragging'); });
  row.addEventListener('dragover', (e) => { if (noteDragSrc || pdfDragSrc) { e.preventDefault(); row.classList.add('drop-hi'); } else if (folderDragSrc && folderCanMoveTo(folderDragSrc, node.path)) { e.preventDefault(); row.classList.add('drop-hi'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop-hi'));
  row.addEventListener('drop', (e) => { e.preventDefault(); row.classList.remove('drop-hi'); if (pdfDragSrc) movePdf(pdfDragSrc, node.path); else if (noteDragSrc) moveNote(noteDragSrc, node.path); else if (folderDragSrc) moveFolder(folderDragSrc, node.path); });
  return row;
}
function renderFolderNode(node, container, depth){
  Object.values(node.folders).sort((a, b) => a.name.localeCompare(b.name)).forEach((sub) => {
    container.appendChild(makeFolderRow(sub, depth));
    if (!collapsedFolders.has(sub.path)) renderFolderNode(sub, container, depth + 1);
  });
  const pdfs = (node.pdfs || []).slice().sort();
  const companionOf = {};
  const companionSet = new Set();
  pdfs.forEach((p) => {
    // Prefer the stored link (robust to renames); fall back to the name convention for pairs that predate it.
    let comp = sbCompanionMap[p];
    if (!comp || !node.notes.includes(comp)) {
      comp = (typeof companionNoteName === 'function') ? companionNoteName(p) : p.replace(/\.pdf$/i, '') + ' · โน้ต.md';
      if (!node.notes.includes(comp)) comp = null;
    }
    if (comp) { companionOf[p] = comp; companionSet.add(comp); }
  });
  node.notes.slice().sort().forEach((n) => { if (companionSet.has(n)) return; container.appendChild(makeNoteItem(n, depth)); });
  pdfs.forEach((p) => {
    container.appendChild(makePdfItem(p, depth));
    if (companionOf[p]) container.appendChild(makeNoteItem(companionOf[p], depth + 1, { companion: true, icon: 'bookmark', label: t('โน้ตของเล่มนี้') }));
  });
}
function renderTree(){ renderSidebar(); }

function openCrate(folderPath){
  currentCrate = folderPath || '';
  const left = document.getElementById('left');
  if (left){ left.classList.remove('view-graph','view-table','view-dash','view-pdf','view-trash'); left.classList.add('view-crate'); }
  mainView = 'crate';
  document.querySelectorAll('.sb-views .sbv').forEach((b) => b.classList.remove('active'));
  try { const c = document.getElementById('crumb'); if (c){ const nm = currentCrate ? currentCrate.split('/').pop() : t('โน้ต'); c.innerHTML = '<b>' + nm + '</b>'; } } catch (_) {}
  renderCrateView();
}

function renderCrateView(){
  const host = document.getElementById('crateView');
  if (!host) return;
  host.innerHTML = '';
  if (!noteTreeRoot){ host.innerHTML = '<div class="crate-empty">' + t('ยังไม่มีโน้ต') + '</div>'; return; }
  let node = noteTreeRoot;
  const parts = currentCrate ? currentCrate.split('/').filter(Boolean) : [];
  for (const p of parts){ node = node.folders && node.folders[p]; if (!node) break; }
  if (!node){ host.innerHTML = '<div class="crate-empty">' + t('กล่องนี้ไม่มีอยู่แล้ว') + '</div>'; return; }

  const subs = Object.values(node.folders || {}).sort((a, b) => a.name.localeCompare(b.name));
  const notes = (node.notes || []).slice().sort();
  const pdfs = (node.pdfs || []).slice().sort();
  const crateName = currentCrate ? currentCrate.split('/').pop() : t('โน้ต');

  // Pair each PDF with its companion note (only if that note actually lives in THIS folder).
  // Same approach as the sidebar's renderFolderNode, so the slip-footer stays in sync.
  const companionOf = {};
  const companionSet = new Set();
  pdfs.forEach((p) => {
    let comp = sbCompanionMap[p];
    if (!comp || !notes.includes(comp)) {
      comp = (typeof companionNoteName === 'function') ? companionNoteName(p) : p.replace(/\.pdf$/i, '') + ' · โน้ต.md';
      if (!notes.includes(comp)) comp = null;
    }
    if (comp) { companionOf[p] = comp; companionSet.add(comp); }
  });

  const scroll = document.createElement('div'); scroll.className = 'crate-scroll';
  const head = document.createElement('div'); head.className = 'crate-head';
  const title = document.createElement('div'); title.className = 'crate-title';
  title.innerHTML = icoSvg('crate', 'sm') + '<span></span>';
  title.querySelector('span').textContent = crateName;
  const sum = document.createElement('div'); sum.className = 'crate-sum';
  sum.textContent = subs.length + t(' กล่องย่อย · ') + (notes.length - companionSet.size) + t(' โน้ต · ') + pdfs.length + t(' เล่ม');
  head.appendChild(title); head.appendChild(sum); scroll.appendChild(head);

  if (!subs.length && !notes.length && !pdfs.length){
    const empty = document.createElement('div'); empty.className = 'crate-empty'; empty.textContent = t('กล่องนี้ว่าง');
    scroll.appendChild(empty); host.appendChild(scroll); return;
  }

  const grid = document.createElement('div'); grid.className = 'crate-grid';
  const card = (kind, icon, name, label, onOpen) => {
    const el = document.createElement('button');
    el.className = 'crate-card cc-' + kind;
    el.title = name;
    el.innerHTML = '<span class="cc-ic"></span><span class="cc-nm"></span>';
    el.querySelector('.cc-ic').innerHTML = icoSvg(icon, 'sm');
    el.querySelector('.cc-nm').textContent = name;
    if (label) { const k = document.createElement('span'); k.className = 'cc-kind'; k.textContent = label; el.appendChild(k); }
    el.onclick = onOpen;
    return el;
  };
  subs.forEach((s) => {
    const cnt = Object.keys(s.folders || {}).length + (s.notes || []).length + (s.pdfs || []).length;
    grid.appendChild(card('box', 'crate', s.name, cnt + t(' รายการ'), () => openCrate(s.path)));
  });
  notes.forEach((n) => { if (companionSet.has(n)) return; grid.appendChild(card('note', 'note', n.replace(/\.md$/i, '').split('/').pop(), null, () => openNote(n))); });
  pdfs.forEach((p) => {
    if (companionOf[p]) {
      // Book card with a companion: a div (not a button) holding two clickable regions.
      const c = document.createElement('div'); c.className = 'crate-card cc-book has-companion';
      const book = document.createElement('div'); book.className = 'cc-book-region';
      const bookName = p.replace(/\.pdf$/i, '').split('/').pop();
      book.title = bookName;
      book.innerHTML = '<span class="cc-ic"></span><span class="cc-nm"></span>';
      book.querySelector('.cc-ic').innerHTML = icoSvg('book', 'sm');
      book.querySelector('.cc-nm').textContent = bookName;
      book.onclick = () => openPdf(p);
      const slip = document.createElement('div'); slip.className = 'cc-slip';
      slip.innerHTML = '<span class="cc-slip-ic"></span><span class="cc-slip-lbl"></span>';
      slip.querySelector('.cc-slip-lbl').textContent = t('โน้ตของเล่มนี้');
      slip.querySelector('.cc-slip-ic').innerHTML = icoSvg('bookmark', 'sm');
      slip.onclick = () => openNote(companionOf[p]);
      c.appendChild(book); c.appendChild(slip);
      grid.appendChild(c);
    } else {
      grid.appendChild(card('book', 'book', p.replace(/\.pdf$/i, '').split('/').pop(), null, () => openPdf(p)));
    }
  });
  scroll.appendChild(grid); host.appendChild(scroll);
}

async function refreshList(selectName){
  const res = await window.api.listNotes();
  const notes = Array.isArray(res) ? res : (res.notes || []);
  const folders = Array.isArray(res) ? [] : (res.folders || []);
  const pdfs = Array.isArray(res) ? [] : (res.pdfs || []);
  // Stored companion links from each PDF's .annot.json (robust to renames). Falls back to name convention below.
  sbCompanionMap = (res && res.companions && typeof res.companions === 'object') ? res.companions : {};
  window.__wlNotes = new Set(notes.map((n) => n.replace(/\.md$/i, '').split('/').pop().toLowerCase()));  // for broken-link detection
  window.__wlNoteNames = [...new Set(notes.map((n) => n.replace(/\.md$/i, '').split('/').pop()))].sort((a, b) => a.localeCompare(b));  // for [[ autocomplete
  noteTreeRoot = buildNoteTree(notes, folders, pdfs);
  try { sbDbCache = await window.api.dbList(); } catch (_) { sbDbCache = []; }
  renderTree();
  const target = selectName && notes.includes(selectName) ? selectName : notes[0];
  if (target) { await openNote(target); } else { highlightActiveNote(null); }
}
function highlightActiveNote(name){
  document.querySelectorAll('#noteList .note-item').forEach((el) => { el.classList.toggle('active', el.dataset.name === name); });
}

// root of the list = drop target to move a note to the top level
noteList.addEventListener('dragover', (e) => { if ((noteDragSrc || pdfDragSrc || (folderDragSrc && folderDragSrc.includes('/'))) && e.target === noteList) { e.preventDefault(); noteList.classList.add('drop-hi-root'); } });
noteList.addEventListener('dragleave', (e) => { if (e.target === noteList) noteList.classList.remove('drop-hi-root'); });
noteList.addEventListener('drop', (e) => { if ((noteDragSrc || pdfDragSrc || folderDragSrc) && e.target === noteList) { e.preventDefault(); noteList.classList.remove('drop-hi-root'); if (pdfDragSrc) movePdf(pdfDragSrc, ''); else if (noteDragSrc) moveNote(noteDragSrc, ''); else if (folderDragSrc) moveFolder(folderDragSrc, ''); } });

// ---- folder actions ----
async function createFolderAt(parentPath){
  const n = await askName(t('ชื่อกล่องใหม่'), '');
  if (!n) return;
  const rel = parentPath ? parentPath + '/' + n.trim() : n.trim();
  const r = await window.api.folderCreate(rel);
  if (r && r.error === 'exists') { alert(t('มีกล่องชื่อนี้อยู่แล้ว')); return; }
  if (r && r.name) collapsedFolders.delete(r.name);
  await refreshList(currentNote);
}
function closeFolderMenu(){ const m = document.getElementById('folderMenu'); if (m) m.remove(); document.removeEventListener('mousedown', onFolderMenuOutside, true); }
function onFolderMenuOutside(e){ const m = document.getElementById('folderMenu'); if (m && !m.contains(e.target)) closeFolderMenu(); }
function openFolderMenu(anchor, node){
  closeFolderMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
  const items = [
    [t('โน้ตใหม่ในกล่องนี้'), async () => { const nm = await askName(t('ตั้งชื่อโน้ตใหม่'), ''); if (!nm) return; const r = await window.api.createNote(node.path + '/' + nm.trim()); if (r && r.error === 'exists') { alert(t('มีโน้ตชื่อนี้อยู่แล้ว')); return; } collapsedFolders.delete(node.path); await refreshList(r && r.name); }],
    [t('กล่องย่อยใหม่'), () => createFolderAt(node.path)],
    [t('เปลี่ยนชื่อกล่อง'), async () => { const nm = await askName(t('เปลี่ยนชื่อกล่อง'), node.name); if (!nm || nm.trim() === node.name) return; const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''; const to = parent ? parent + '/' + nm.trim() : nm.trim(); const r = await window.api.folderRename(node.path, to); if (r && r.error) { alert(t('เปลี่ยนชื่อไม่ได้')); return; } await refreshList(currentNote); }],
    [t('ลบกล่อง (ไปถังขยะ)'), async () => { if (!(await confirmDelete(t('ย้ายกล่อง "') + node.name + t('" ไปถังขยะ?') ))) return; await window.api.folderDelete(node.path); await refreshList(); }],
  ];
  items.forEach(([label, fn]) => { const it = document.createElement('div'); it.className = 'db-mi' + (label.startsWith(t('ลบ')) ? ' db-mi-del' : ''); it.textContent = label; it.onclick = () => { closeFolderMenu(); fn(); }; menu.appendChild(it); });
  document.body.appendChild(menu);
  const rc = anchor.getBoundingClientRect();
  menu.style.top = (rc.bottom + 2) + 'px'; menu.style.left = Math.min(rc.left, window.innerWidth - 210) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onFolderMenuOutside, true), 0);
}
document.getElementById('newFolderBtn').onclick = () => createFolderAt('');

// cmd/ctrl-click a [[wikilink]] in the editor → jump to that note, or (broken) offer to create it
async function _resolveNoteFile(target){
  const res = await window.api.listNotes();
  const notes = Array.isArray(res) ? res : (res.notes || []);
  const base = (p) => p.replace(/\.md$/i, '').split('/').pop();
  return notes.find((p) => base(p) === target) || notes.find((p) => base(p).toLowerCase() === target.toLowerCase());
}
window.__wlClick = async (target, broken, el) => {
  if (!target) return;
  const hit = await _resolveNoteFile(target);
  if (hit) { refreshList(hit); return; }
  openBrokenLinkMenu(target, el);          // note doesn't exist → create it (blank / with AI)
};

function closeBrokenMenu(){ const m = document.getElementById('brokenMenu'); if (m) m.remove(); document.removeEventListener('mousedown', _bmOutside, true); }
function _bmOutside(e){ const m = document.getElementById('brokenMenu'); if (m && !m.contains(e.target)) closeBrokenMenu(); }
function openBrokenLinkMenu(target, el){
  closeBrokenMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu link-picker'; menu.id = 'brokenMenu';
  const hd = document.createElement('div'); hd.className = 'lp-hd'; hd.textContent = '“' + target + t('” ยังไม่มีโน้ต'); menu.appendChild(hd);
  const sub = document.createElement('div'); sub.className = 'lp-sub'; sub.textContent = t('สร้างหน้าเนื้อหาสำหรับลิงก์นี้'); menu.appendChild(sub);

  const blank = document.createElement('div'); blank.className = 'db-mi lp-add'; blank.textContent = t('＋ สร้างโน้ตเปล่า');
  blank.onclick = async () => {
    closeBrokenMenu();
    const keep = currentNote;
    if (typeof save === 'function' && currentNote) await save();   // persist current note (incl. this link) first
    const r = await window.api.createNote(target);
    if (r && r.error && r.error !== 'exists') { alert(t('สร้างโน้ตไม่ได้')); return; }
    await refreshList(keep || (r && r.name) || (target + '.md'));   // stay on current note; link now renders valid
  };
  menu.appendChild(blank);

  const ai = document.createElement('div'); ai.className = 'db-mi lp-item'; ai.innerHTML = icoSvg('sparkle', 'sm'); ai.appendChild(document.createTextNode(' ' + t('ให้ AI เขียนเนื้อหาให้')));
  ai.onclick = async () => {
    closeBrokenMenu();
    if (typeof save === 'function' && currentNote) await save();   // persist current note first
    const r = await window.api.createNote(target);
    if (r && r.error && r.error !== 'exists') { alert(t('สร้างโน้ตไม่ได้')); return; }
    const name = (r && r.name) || (target + '.md');
    await refreshList(name);                 // opens the new (empty) note -> currentNote = name
    runEngineAction('ในไฟล์ ' + name + ' เขียนโน้ตสรุปอธิบาย "' + target + '" เป็นภาษาไทย กระชับ อ่านง่าย มีหัวข้อย่อยและ bullet points ตามความเหมาะสม (เขียนทับเนื้อหาเดิมที่ว่างอยู่)');
  };
  menu.appendChild(ai);

  document.body.appendChild(menu);
  const r = el ? el.getBoundingClientRect() : { bottom: 200, top: 200, left: 200 };
  const mh = menu.offsetHeight || 150;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 270)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', _bmOutside, true), 0);
}

// H0 title text = current note's FILENAME (basename, no folder, no .md). Hidden when no note is open.
function setNoteTitle(name){
  if (!name) { noteTitleEl.hidden = true; return; }
  noteTitleEl.textContent = name.replace(/\.md$/i, '').split('/').pop();
  noteTitleEl.hidden = false;
}

async function openNote(name) {
  if (typeof setMainView === 'function') setMainView('note');
  if (typeof clearAutolink === 'function') clearAutolink();
  const content = await window.api.openNote(name);
  currentNote = name;
  setNoteTitle(name);
  const parsed = parseFrontmatter(content);
  currentAttrs = parsed.attrs;
  await loadEditor(parsed.body);
  setDirty(false);
  banner.hidden = true;
  loadPropsBar();
  vsSet('lastNote', name);
  vsSet('lastOpen', { type: 'note', name });
  refreshBacklinks(name);
  highlightActiveNote(name);
}

// ---------- Note management (create / rename / delete) ----------
function askName(title, defaultValue) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const card = document.createElement('div');
    card.className = 'modal-card';
    const h = document.createElement('h3');
    h.textContent = title;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue || '';
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = t('ยกเลิก');
    const ok = document.createElement('button');
    ok.className = 'solid';
    ok.textContent = t('ตกลง');
    actions.appendChild(cancel);
    actions.appendChild(ok);
    card.appendChild(h);
    card.appendChild(input);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const done = (val) => { document.body.removeChild(backdrop); resolve(val); };
    const submit = () => { const v = input.value.trim(); done(v ? v : null); };
    ok.onclick = submit;
    cancel.onclick = () => done(null);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

function confirmDelete(message, opts){
  const title = (opts && opts.title) || t('ยืนยันการลบ');
  const okLabel = (opts && opts.okLabel) || t('ลบ');
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const card = document.createElement('div');
    card.className = 'modal-card';
    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = t('ยกเลิก');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = okLabel;
    actions.appendChild(cancel);
    actions.appendChild(del);
    card.appendChild(h);
    card.appendChild(p);
    card.appendChild(actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    let settled = false;
    const done = (val) => { if (settled) return; settled = true; document.removeEventListener('keydown', onKey, true); document.body.removeChild(backdrop); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    del.onclick = () => done(true);
    cancel.onclick = () => done(false);
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(false); });
    setTimeout(() => { del.focus(); }, 0);
  });
}

document.getElementById('newNoteBtn').onclick = async () => {
  const n = await askName(t('ตั้งชื่อโน้ตใหม่'), '');
  if (!n) return;
  const r = await window.api.createNote(n);
  if (r.error === 'exists') { alert(t('มีโน้ตชื่อนี้อยู่แล้ว')); return; }
  await refreshList(r.name);
};
// rename an arbitrary note (by rel path) — preserves folder + .md extension
async function renameNoteAt(rel){
  if (!rel) return;
  const cur = rel.replace(/\.md$/i, '').split('/').pop();
  const nm = await askName(t('เปลี่ยนชื่อโน้ต'), cur);
  if (!nm || !nm.trim() || nm.trim() === cur) return;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  let to = nm.trim(); if (!/\.md$/i.test(to)) to += '.md';
  to = dir ? dir + '/' + to : to;
  const r = await window.api.renameNote(rel, to);
  if (r && r.error === 'exists') { alert(t('มีโน้ตชื่อนี้อยู่แล้ว')); return; }
  await refreshList(r && r.name ? r.name : rel);
}
// delete an arbitrary note (by rel path) to trash
async function deleteNoteAt(rel){
  if (!rel) return;
  if (!(await confirmDelete(t('ย้ายโน้ต "') + rel.replace(/\.md$/i, '').split('/').pop() + t('" ไปถังขยะ?')))) return;
  await window.api.deleteNote(rel);
  await refreshList();
}
// right-click menu on a note item (rename / delete) — built like openPdfMenu
function openNoteMenu(x, y, rel){
  if (typeof closeFolderMenu === 'function') closeFolderMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
  [[t('เปลี่ยนชื่อ'), () => renameNoteAt(rel)], [t('ลบ (ไปถังขยะ)'), () => deleteNoteAt(rel)]].forEach(([label, fn]) => {
    const it = document.createElement('div'); it.className = 'db-mi' + (label.startsWith(t('ลบ')) ? ' db-mi-del' : '');
    it.textContent = label; it.onclick = () => { if (typeof closeFolderMenu === 'function') closeFolderMenu(); fn(); }; menu.appendChild(it);
  });
  document.body.appendChild(menu);
  menu.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  setTimeout(() => { if (typeof onFolderMenuOutside === 'function') document.addEventListener('mousedown', onFolderMenuOutside, true); }, 0);
}

// ---------- Full-text search ----------
const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value;
  if (!q.trim()) { searchResults.hidden = true; searchResults.innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    const hits = await window.api.searchNotes(q);
    searchResults.innerHTML = '';
    if (!hits.length) { searchResults.hidden = true; return; }
    hits.forEach((hit) => {
      const row = document.createElement('div');
      row.className = 'sr-item';
      const b = document.createElement('b');
      b.textContent = hit.name + (hit.line ? ':' + hit.line : '');
      const snip = document.createElement('span');
      snip.textContent = ' : ' + hit.snippet;
      row.appendChild(b);
      row.appendChild(snip);
      row.onclick = async () => {
        await openNote(hit.name);
        searchResults.hidden = true;
        searchResults.innerHTML = '';
        searchInput.value = '';
      };
      searchResults.appendChild(row);
    });
    searchResults.hidden = false;
  }, 200);
});
searchInput.addEventListener('blur', () => { setTimeout(() => { searchResults.hidden = true; }, 150); });
searchInput.addEventListener('focus', () => { if (searchResults.innerHTML) searchResults.hidden = false; });

async function save() {
  if (!currentNote) return;
  await window.api.saveNote(currentNote, getFullMarkdown());
  setDirty(false);
}
document.getElementById('saveBtn').onclick = save;
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuickAsk(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
});

// ---------- Properties bar (status + tags via frontmatter) ----------
function loadPropsBar(){
  document.getElementById('statusSelect').value = currentAttrs.status || '';
  document.getElementById('tagsInput').value = currentAttrs.tags || '';
}
function applyProps(){
  if(!currentNote) return;
  const status=document.getElementById('statusSelect').value;
  const tags=document.getElementById('tagsInput').value.trim();
  if(status) currentAttrs.status=status; else delete currentAttrs.status;
  if(tags) currentAttrs.tags=tags; else delete currentAttrs.tags;
  setDirty(true);
  save();
}
document.getElementById('statusSelect').onchange = applyProps;
document.getElementById('tagsInput').addEventListener('change', applyProps);

// live reload from Claude / external edits → open the rich partial-accept review (covers BOTH chat + action-bar edits)
let _watchTimer = null, _watchLatest = null, _watchBefore = null;
function anyEngineRunning(){
  try {
    if (Array.isArray(sessions) && sessions.some((s) => s.running)) return true;
    if (Array.isArray(sideChats) && sideChats.some((s) => s.running)) return true;
  } catch (_) {}
  return false;
}
window.api.onNoteChanged(async ({ name, content, before }) => {
  if (name !== currentNote) return;
  if (suppressWatcher) { return; }   // this change is our own review-apply write
  _watchLatest = content;
  // baseline for the diff, captured once per burst:
  //  - unsaved local edits → use the editor buffer, so the user's own text is kept and only AI hunks are offered
  //  - otherwise → the pre-change disk content from main (no Crepe-normalization noise)
  if (_watchBefore == null) _watchBefore = dirty ? getFullMarkdown() : (before != null ? before : getFullMarkdown());
  clearTimeout(_watchTimer);
  const tick = () => {
    // an AI run usually writes the file several times; wait until it stops so the review opens once, at the end
    if (anyEngineRunning()) { _watchTimer = setTimeout(tick, 500); return; }
    const c = _watchLatest;
    const b = (suggestActive && reviewBase != null) ? reviewBase : _watchBefore;   // keep the original baseline while a review is open
    _watchBefore = null;
    if (c.trim() === (b || '').trim()) { return; }
    banner.hidden = true; pendingClaudeContent = null;
    flashUpdated();
    openDiffReview(currentNote, b, c);                   // rich review; closeSuggest() inside refreshes if already open
  };
  _watchTimer = setTimeout(tick, 250);
});
document.getElementById('reloadKeep').onclick = () => { banner.hidden = true; pendingClaudeContent = null; };
document.getElementById('reloadTake').onclick = async () => {
  if (pendingClaudeContent != null) {
    const parsed = parseFrontmatter(pendingClaudeContent);
    currentAttrs = parsed.attrs;
    await loadEditor(parsed.body);
    loadPropsBar();
    pendingClaudeContent = null;
    setDirty(false);
  }
  banner.hidden = true;
};

function flashUpdated() {
  document.querySelector('.dot').style.transition = 'none';
  document.querySelector('.dot').style.transform = 'scale(1.8)';
  setTimeout(() => {
    document.querySelector('.dot').style.transition = 'transform .5s';
    document.querySelector('.dot').style.transform = 'scale(1)';
  }, 30);
}

// ---------- Backlinks ----------
async function refreshBacklinks(name) {
  const el = document.getElementById('backlinks');
  const links = await window.api.backlinks(name);
  el.innerHTML = '';
  if (!links.length) { el.hidden = true; return; }
  const label = document.createElement('span');
  label.className = 'bl-label';
  label.innerHTML = icoSvg('link', 'sm'); label.appendChild(document.createTextNode(' ' + t('อ้างถึงโน้ตนี้ (') + links.length + t('): ')));
  el.appendChild(label);
  links.forEach((f) => {
    const a = document.createElement('a');
    a.className = 'bl-link';
    a.textContent = f.replace(/\.md$/i, '');
    a.onclick = () => refreshList(f);
    el.appendChild(a);
  });
  el.hidden = false;
}

// ---------- Selection -> action bar ----------
const actionBar = document.getElementById('actionBar');
const selText = document.getElementById('selText');

function updateActionBar() {
  const sel = currentSelection();
  if (sel) { selText.textContent = sel.length > 40 ? sel.slice(0, 40) + '…' : sel; actionBar.hidden = false; }
  else { actionBar.hidden = true; }
}
let selTimer = null;
document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(updateActionBar, 150); });

const DEFAULT_PROMPTS = {
  explain: 'อธิบายคำว่า "{term}" แบบสั้น กระชับ เข้าใจง่าย แล้วแทรกคำอธิบายเป็น bullet ย่อยใต้บรรทัดที่มีคำนี้ในไฟล์ {file}',
  search: 'ค้นข้อมูลเพิ่มเติมเกี่ยวกับ "{term}" แล้วสรุปเป็น 3-4 bullet พร้อมแหล่งอ้างอิง เพิ่มลงท้ายไฟล์ {file} ใต้หัวข้อ "## ข้อมูลเพิ่มเติม"',
  link: 'ในไฟล์ {file} เปลี่ยนคำว่า "{term}" ให้เป็นลิงก์แบบ [[{term}]] ทุกที่ที่พบ แล้วสร้างไฟล์โน้ตใหม่ {term}.md พร้อมนิยามสั้นๆ ของคำนี้',
  tldr: 'อ่านไฟล์ {file} แล้วเพิ่มหัวข้อ "## สรุป (TL;DR)" ท้ายไฟล์ สรุปสาระสำคัญเป็น 3-5 bullet กระชับ (ถ้ามีหัวข้อสรุปอยู่แล้วให้อัปเดตแทน)',
  quiz: 'อ่านไฟล์ {file} แล้วเพิ่มหัวข้อ "## Quiz" ท้ายไฟล์ ตั้งคำถามทบทวน 5 ข้อจากเนื้อหา (เว้นบรรทัดเฉลยไว้ใต้แต่ละข้อในรูปแบบ "เฉลย: ...")',
};
const PROMPT_LABELS = { explain:'อธิบาย', search:'หาข้อมูล', link:'ทำลิงก์', tldr:'TL;DR', quiz:'ทดสอบฉัน (Quiz)' };
let promptTemplates = Object.assign({}, DEFAULT_PROMPTS, JSON.parse(localStorage.getItem('prompts')||'{}'));
function fillPrompt(key, term, file){
  return (promptTemplates[key]||DEFAULT_PROMPTS[key]||'')
    .split('{term}').join(term||'')
    .split('{file}').join(file||'');
}

// ---------- Centralized engine action + AI undo ----------
let aiSnapshot = null; // {name, content}
let noteActionRunId = null; // runId of the note-editing action, for diff review
let diffRevertCb = null; // set while #diffOverlay is open, for Escape

function _pushRun(arr, type, ch){ const last = arr[arr.length-1]; if (last && last.type===type) last.text += ch; else arr.push({ type, text: ch }); }
function charRuns(a, b){
  const ops = _lcsOps([...a], [...b]);
  const before=[], after=[];
  for(const op of ops){
    if(op.t==='same'){ _pushRun(before,'same',op.line); _pushRun(after,'same',op.line); }
    else if(op.t==='del'){ _pushRun(before,'del',op.line); }
    else { _pushRun(after,'add',op.line); }
  }
  return { before, after };
}
function runSpans(runs, changeClass){
  const frag = document.createDocumentFragment();
  runs.forEach((r) => { const s = document.createElement('span'); if (r.type!=='same') s.className = changeClass; s.textContent = r.text; frag.appendChild(s); });
  return frag;
}

async function runEngineAction(prompt) {
  if (!currentNote) return;
  const s = activeSession();
  if (isRunning(s.id)) return;
  await save();                                              // flush editor -> file so AI edits latest
  aiSnapshot = { name: currentNote, content: await window.api.readNote(currentNote) };
  noteActionRunId = s.id;
  const engine = s.engine;
  const model = 'zai-coding-plan/' + s.model;
  term.write('\r\n\x1b[36m▶ [' + (engine === 'glm' ? ('GLM ' + s.model) : 'Claude') + '] ' + prompt + '\x1b[0m\r\n');
  beginAiTurn(prompt);
  window.api.runEngine({ engine, model: (engine === 'glm' ? model : ''), prompt, runId: s.id });
  term.focus();
}

actionBar.querySelectorAll('button[data-act]').forEach((btn) => {
  btn.onclick = () => {
    const sel = currentSelection();
    if (!sel || !currentNote) return;
    if (btn.dataset.act === 'link') { openLinkPicker(sel, btn); return; }
    if (btn.dataset.act === 'task') { openAddToDbMenu(sel, btn); return; }
    if (btn.dataset.act === 'sidechat') { openSideChat('เกี่ยวกับ "' + sel + '" — '); actionBar.hidden = true; return; }
    runEngineAction(fillPrompt(btn.dataset.act, sel, currentNote));
  };
});

// note-level AI actions
document.getElementById('tldrBtn').onclick = () => runEngineAction(fillPrompt('tldr','',currentNote));
document.getElementById('quizBtn').onclick = () => runEngineAction(fillPrompt('quiz','',currentNote));

// AI review is now driven by the file-watcher (onNoteChanged) so it covers chat edits too.
// Just clear the snapshot here; the watcher opens the rich review when the file actually changes.
window.api.onEngineDone(async (payload) => {
  const runId = payload && payload.runId;
  if (!aiSnapshot || runId !== noteActionRunId) return;
  aiSnapshot = null; noteActionRunId = null;
});
function showAiUndo(){ const bar=document.getElementById('aiUndo'); bar.hidden=false; }
document.getElementById('aiUndoBtn').onclick = async () => {
  if (!aiSnapshot) return;
  await window.api.saveNote(aiSnapshot.name, aiSnapshot.content);
  if (aiSnapshot.name === currentNote) { await openNote(currentNote); }
  document.getElementById('aiUndo').hidden = true;
  aiSnapshot = null;
};
document.getElementById('aiUndoDismiss').onclick = () => { document.getElementById('aiUndo').hidden = true; aiSnapshot = null; };

// ---------- AI inline "suggesting" review (in-editor, NOT a modal) ----------
let suggestActive = false;
let suggestApply = null;
let reviewBase = null;    // the baseline the open review diffs against — stays fixed while more AI writes land
function closeSuggest(){
  const v = document.getElementById('suggestView');
  if (v) v.remove();
  suggestActive = false; suggestApply = null;
}
// render same/del/add runs inline, in op order (word-level within a hunk)
function inlineDiffFrag(delText, addText){
  const ops = _lcsOps([...delText], [...addText]);
  const frag = document.createDocumentFragment();
  let buf = '', type = null;
  const flush = () => {
    if (type === null) return;
    const s = document.createElement('span');
    if (type === 'del') s.className = 'sg-del';
    else if (type === 'add') s.className = 'sg-add';
    s.textContent = buf; frag.appendChild(s); buf = ''; type = null;
  };
  for (const op of ops){
    const t = op.t;                       // 'same' | 'del' | 'add'
    if (t !== type){ flush(); type = t; buf = ''; }
    buf += op.line;
  }
  flush();
  return frag;
}
function openDiffReview(name, before, after){
  const segs = diffSegments(before, after);
  const hunkSegs = segs.filter((s) => s.type === 'hunk');
  if (!hunkSegs.length) return;
  closeSuggest();
  const wrap = document.getElementById('editorWrap');
  const view = document.createElement('div'); view.id = 'suggestView';
  const doc = document.createElement('div'); doc.className = 'sg-doc';
  const controls = [];
  segs.forEach((seg) => {
    if (seg.type === 'same'){
      const rich = document.createElement('div'); rich.className = 'sg-rich';
      rich.innerHTML = mdToHtml(seg.lines.join('\n'));
      doc.appendChild(rich);
      return;
    }
    const state = { accept: true, editing: false, value: seg.add.join('\n') };
    const block = document.createElement('div'); block.className = 'sg-hunk';
    const flow = document.createElement('span'); flow.className = 'sg-flow';
    const pill = document.createElement('span'); pill.className = 'sg-pill';
    const y = document.createElement('b'); y.className = 'y'; y.innerHTML = icoSvg('check', 'xs'); y.title = t('รับจุดนี้');
    const e = document.createElement('b'); e.className = 'e'; e.innerHTML = icoSvg('pencil', 'xs'); e.title = t('แก้ก่อนรับ');
    const n = document.createElement('b'); n.className = 'n'; n.innerHTML = icoSvg('x', 'xs'); n.title = t('ทิ้งจุดนี้');
    pill.appendChild(y); pill.appendChild(e); pill.appendChild(n);
    const renderFlow = () => {
      flow.innerHTML = '';
      if (state.editing){
        const ta = document.createElement('textarea'); ta.className = 'sg-edit'; ta.value = state.value; ta.spellcheck = false; ta.rows = 1;
        const sz = () => { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; };
        ta.addEventListener('input', () => { state.value = ta.value; sz(); });
        flow.appendChild(ta); setTimeout(sz, 0); setTimeout(() => ta.focus(), 0);
        return;
      }
      // rich preview: removed lines (struck if accepting) + added lines (green if accepting)
      if (seg.del.length){
        const del = document.createElement('div');
        del.className = 'sg-rich sg-del-block' + (state.accept ? ' struck' : '');
        del.innerHTML = mdToHtml(seg.del.join('\n'));
        flow.appendChild(del);
      }
      if (state.accept){
        const add = document.createElement('div');
        add.className = 'sg-rich sg-add-block';
        add.innerHTML = mdToHtml(state.value);
        flow.appendChild(add);
      } else if (!seg.del.length){
        const ph = document.createElement('div'); ph.className = 'sg-rich sg-ph'; ph.textContent = t('(ทิ้งการเพิ่มนี้)');
        flow.appendChild(ph);
      }
    };
    const applyState = () => {
      block.classList.toggle('sg-accepted', state.accept && !state.editing);
      block.classList.toggle('sg-rejected', !state.accept);
      y.classList.toggle('on', state.accept && !state.editing);
      n.classList.toggle('on', !state.accept);
    };
    y.onclick = () => { state.accept = true; state.editing = false; renderFlow(); applyState(); };
    n.onclick = () => { state.accept = false; state.editing = false; renderFlow(); applyState(); };
    e.onclick = () => { state.editing = !state.editing; state.accept = true; renderFlow(); applyState(); };
    block.appendChild(flow); block.appendChild(pill);
    doc.appendChild(block);
    renderFlow(); applyState();
    controls.push({ state });
  });
  view.appendChild(doc);
  const bar = document.createElement('div'); bar.className = 'sg-bar';
  const info = document.createElement('span'); info.className = 'sg-info';
  info.innerHTML = t('AI เสนอแก้ <b>') + hunkSegs.length + t('</b> จุด — เลือกรับ/แก้/ทิ้งที่แต่ละจุด');
  const sp = document.createElement('span'); sp.className = 'sg-sp';
  const noneBtn = document.createElement('button'); noneBtn.className = 'sg-btn none'; noneBtn.textContent = t('ทิ้งทั้งหมด');
  const allBtn = document.createElement('button'); allBtn.className = 'sg-btn all'; allBtn.textContent = t('รับทั้งหมด');
  const useBtn = document.createElement('button'); useBtn.className = 'sg-btn use'; useBtn.textContent = t('เสร็จ · ใช้ที่เลือก');
  bar.appendChild(info); bar.appendChild(sp); bar.appendChild(noneBtn); bar.appendChild(allBtn); bar.appendChild(useBtn);
  view.appendChild(bar);
  wrap.appendChild(view);
  suggestActive = true; reviewBase = before;

  const finish = async (merged) => {
    closeSuggest(); reviewBase = null;
    suppressWatcher = true;                              // our own write below must not re-open a review
    await window.api.saveNote(name, merged);
    if (name === currentNote){
      const parsed = parseFrontmatter(merged);
      currentAttrs = parsed.attrs;
      await loadEditor(parsed.body);
      loadPropsBar(); setDirty(false);
    }
    setTimeout(() => { suppressWatcher = false; }, 400);
  };
  const buildDecisions = (force) => {
    const d = {};
    controls.forEach((c, i) => { d[i] = { accept: force === null ? c.state.accept : force, addLines: addLinesFromText(c.state.value) }; });
    return d;
  };
  useBtn.onclick = () => finish(mergeSegments(segs, buildDecisions(null)));
  allBtn.onclick = () => finish(mergeSegments(segs, buildDecisions(true)));
  noneBtn.onclick = () => finish(before);
  suggestApply = () => finish(mergeSegments(segs, buildDecisions(null)));
}

// ---------- Quick-ask (Cmd/Ctrl+K) ----------
function openQuickAsk() {
  if (!currentNote) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const card = document.createElement('div');
  card.className = 'modal-card';
  const h = document.createElement('h3');
  h.textContent = t('ถาม AI เกี่ยวกับโน้ตนี้');
  const ta = document.createElement('textarea');
  ta.rows = 3;
  ta.setAttribute('style', 'width:100%');
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'ghost';
  cancel.textContent = t('ยกเลิก');
  const ok = document.createElement('button');
  ok.className = 'solid';
  ok.textContent = t('ตกลง');
  actions.appendChild(cancel);
  actions.appendChild(ok);
  card.appendChild(h);
  card.appendChild(ta);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const done = () => { document.body.removeChild(backdrop); };
  const submit = () => {
    const q = ta.value.trim();
    if (!q) return;
    done();
    runEngineAction(q + '\n\n(อ้างอิงจากไฟล์ ' + currentNote + ' ถ้าเกี่ยวข้อง หากผู้ใช้ขอให้เพิ่ม/แก้เนื้อหา ให้แก้ไฟล์นั้น)');
  };
  ok.onclick = submit;
  cancel.onclick = () => done();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); done(); }
  });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(); });
  setTimeout(() => ta.focus(), 0);
}

// ---------- Divider drag ----------
const divider = document.getElementById('divider');
divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  appEl.classList.add('resizing');
  const move = (ev) => {
    if (termPos === 'bottom') {
      const hh = Math.min(window.innerHeight - 120, Math.max(120, window.innerHeight - ev.clientY));
      appEl.style.setProperty('--term-h', hh + 'px');
    } else {
      const rw = Math.min(760, Math.max(320, window.innerWidth - ev.clientX));
      appEl.style.setProperty('--term-w', rw + 'px');
    }
    fitTerm();
  };
  const up = () => { appEl.classList.remove('resizing'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

// ---------- icon helper (SVG sprite; replaces all emoji) ----------
function icoSvg(name, cls){
  return '<svg class="ic ' + (cls || 'sm') + '"><use href="#i-' + name + '"/></svg>';
}
function icoEl(name, cls){
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'ic ' + (cls || 'sm'));
  s.innerHTML = '<use href="#i-' + name + '"/>';
  return s;
}
// ---------- Notion-style table view ----------
// ---------- Table databases (Notion-like) — the "ตาราง/DB" view ----------
const DB_COLORS = {
  gray:['#eee9df','#7a7161'], amber:['#fdefdc','#b07a2a'], green:['#e2efe4','#3f7d5c'],
  coral:['#f7ddd4','#b0503a'], blue:['#e2ece9','#4f7a70'], purple:['#ece2ef','#7a5f8a'], sand:['#e9e3d4','#7a6f52']
};
const DB_COLOR_KEYS = Object.keys(DB_COLORS);
const DB_TYPES = [ ['text','text','ข้อความ'], ['select','select','เลือก'], ['number','hash','ตัวเลข'], ['checkbox','checkbox','เช็คบ็อกซ์'], ['date','cal','วันที่'], ['relation','link','เชื่อมโยง DB'] ];
const DB_TYPE_ICON = { text:'text', select:'select', number:'hash', checkbox:'checkbox', date:'cal', relation:'link' };
const DB_VIEWS = [ ['table','table','ตาราง'], ['board','board','บอร์ด'], ['calendar','cal','ปฏิทิน'], ['gallery','gallery','แกลเลอรี'], ['chart','chart','ชาร์ต'] ];
let dbOpenId = null;   // null → show DB list; else the open DB id
let dbCache = null;    // the currently-open DB object
let relCache = {};     // relation target DBs, loaded on demand: { dbId: dbObject }
let calCursor = null;  // {y, m} for the calendar view (0-based month)
// ----- DB view helpers -----
function dbTitleCol(db){ return (db.columns || []).find((c) => c.type === 'text') || (db.columns || [])[0] || null; }
function rowTitle(db, row){ const c = dbTitleCol(db); const v = c ? row[c.id] : ''; return (v == null || v === '') ? t('(ไม่มีชื่อ)') : String(v); }
function firstColOfType(db, t){ return (db.columns || []).find((c) => c.type === t) || null; }
function pad2(n){ return (n < 10 ? '0' : '') + n; }
function todayISO(){ const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
async function loadRelTargets(db){ // preload related DBs so relation cells can render titles synchronously
  const ids = [...new Set((db.columns || []).filter((c) => c.type === 'relation' && c.relDb).map((c) => c.relDb))];
  for (const id of ids){ if (!relCache[id]){ try { relCache[id] = await window.api.dbRead(id); } catch (_) { relCache[id] = null; } } }
}
function relRowTitle(relDb, rowId){ const t = relCache[relDb]; if (!t) return rowId; const r = (t.rows || []).find((x) => x.id === rowId); return r ? rowTitle(t, r) : '?'; }
const DB_COL_W_DEFAULT = 190;   // px; per-column override lives in col.w
function dbNewId(p){ return p + Date.now().toString(36) + Math.floor(Math.random()*1e4).toString(36); }
// drag a column edge → live-resize that <col>, persist on release
function startColResize(e, col, colEl){
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX, startW = col.w || DB_COL_W_DEFAULT;
  document.body.classList.add('col-resizing');
  const move = (ev) => { const w = Math.max(70, Math.min(700, startW + (ev.clientX - startX))); col.w = w; if (colEl) colEl.style.width = w + 'px'; };
  const up = () => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    document.body.classList.remove('col-resizing'); saveDb();
  };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
}
function saveDb(){ if (dbCache) window.api.dbSave(dbCache); }

async function renderTable(){
  const host = document.getElementById('tableView'); if (!host) return;
  if (dbOpenId) await renderDbTable(host);
  else await renderDbList(host);
}

async function renderDbList(host){
  const dbs = await window.api.dbList();
  host.innerHTML = '';
  const head = document.createElement('div'); head.className = 'view-head';
  const title = document.createElement('span'); title.className = 'vh-title'; title.textContent = t('ฐานข้อมูล');
  head.appendChild(title); host.appendChild(head);
  const scroll = document.createElement('div'); scroll.className = 'view-scroll';
  const grid = document.createElement('div'); grid.className = 'db-grid';
  dbs.forEach((d) => {
    const card = document.createElement('div'); card.className = 'db-card';
    const ic = document.createElement('div'); ic.className = 'db-cardic'; ic.innerHTML = icoSvg('db', '');
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = d.name;
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = d.rows + t(' แถว · ') + d.cols + t(' คอลัมน์');
    card.appendChild(ic); card.appendChild(nm); card.appendChild(meta);
    card.onclick = () => { dbOpenId = d.id; renderTable(); };
    grid.appendChild(card);
  });
  const add = document.createElement('div'); add.className = 'db-card add';
  const plus = document.createElement('div'); plus.className = 'plus'; plus.textContent = '＋';
  const lab = document.createElement('div'); lab.textContent = t('สร้างฐานข้อมูลใหม่');
  add.appendChild(plus); add.appendChild(lab);
  add.onclick = async () => { const db = await window.api.dbCreate({}); if (db) { dbOpenId = db.id; try { sbDbCache = await window.api.dbList(); } catch (_) {} renderTable(); renderSidebar(); } };
  grid.appendChild(add);
  scroll.appendChild(grid); host.appendChild(scroll);
}

async function renderDbTable(host){
  const db = await window.api.dbRead(dbOpenId);
  if (!db) { dbOpenId = null; dbCache = null; return renderTable(); }
  dbCache = db;
  if (!db.view) db.view = 'table';
  await loadRelTargets(db);
  host.innerHTML = '';
  const head = document.createElement('div'); head.className = 'view-head';
  const back = document.createElement('button'); back.className = 'ghost sm'; back.textContent = t('‹ ฐานข้อมูล'); back.onclick = () => { dbOpenId = null; dbCache = null; renderTable(); };
  const title = document.createElement('span'); title.className = 'vh-title'; title.innerHTML = icoSvg('db', 'sm'); title.appendChild(document.createTextNode(' ' + db.name));
  // view switcher (segmented)
  const seg = document.createElement('div'); seg.className = 'db-viewseg';
  DB_VIEWS.forEach(([v, ic, label]) => {
    const tl = t(label);
    const b = document.createElement('button'); b.className = 'db-vbtn' + (db.view === v ? ' on' : ''); b.innerHTML = icoSvg(ic, 'sm'); b.appendChild(document.createTextNode(' ' + tl)); b.title = tl;
    b.onclick = () => { db.view = v; saveDb(); renderTable(); };
    seg.appendChild(b);
  });
  const sp = document.createElement('span'); sp.className = 'vh-sp';
  const menu = document.createElement('button'); menu.className = 'ghost sm'; menu.textContent = '⋯'; menu.onclick = (e) => { e.stopPropagation(); openDbMenu(menu); };
  const addRow = document.createElement('button'); addRow.className = 'solid sm'; addRow.textContent = t('＋ แถว'); addRow.onclick = () => addDbRow();
  sp.appendChild(menu); sp.appendChild(addRow);
  head.appendChild(back); head.appendChild(title); head.appendChild(seg); head.appendChild(sp); host.appendChild(head);

  const body = document.createElement('div'); body.className = 'db-viewbody'; host.appendChild(body);
  renderDbBody(body, db);
}
function renderDbBody(body, db){
  body.innerHTML = '';
  if (db.view === 'board') return renderBoardView(body, db);
  if (db.view === 'calendar') return renderCalendarView(body, db);
  if (db.view === 'gallery') return renderGalleryView(body, db);
  if (db.view === 'chart') return renderChartView(body, db);
  return renderTableBody(body, db);
}
function dbEmptyHint(body, msg){ const d = document.createElement('div'); d.className = 'db-hint'; d.textContent = msg; body.appendChild(d); }
function pickColControl(label, cols, curId, onPick){
  const wrap = document.createElement('div'); wrap.className = 'db-pickctl';
  const lb = document.createElement('span'); lb.className = 'db-pickctl-l'; lb.textContent = label; wrap.appendChild(lb);
  const sel = document.createElement('select');
  cols.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; if (c.id === curId) o.selected = true; sel.appendChild(o); });
  sel.onchange = () => onPick(sel.value);
  wrap.appendChild(sel); return wrap;
}

function renderTableBody(body, db){
  const scroll = document.createElement('div'); scroll.className = 'view-scroll db-scroll';
  const table = document.createElement('table'); table.className = 'db';
  // explicit column widths (persisted as col.w) so columns can be resized and the table can scroll sideways
  const cg = document.createElement('colgroup');
  db.columns.forEach((col) => { const c = document.createElement('col'); c.style.width = (col.w || DB_COL_W_DEFAULT) + 'px'; cg.appendChild(c); });
  const cAdd = document.createElement('col'); cAdd.style.width = '46px'; cg.appendChild(cAdd);   // ＋col header / row-delete cell
  table.appendChild(cg);
  const thead = document.createElement('thead'); const htr = document.createElement('tr');
  db.columns.forEach((col, i) => {
    const th = document.createElement('th');
    const ty = document.createElement('span'); ty.className = 'db-ty'; ty.appendChild(icoEl(DB_TYPE_ICON[col.type] || 'text', 'xs'));
    const nm = document.createElement('span'); nm.className = 'db-thnm'; nm.textContent = col.name;
    th.appendChild(ty); th.appendChild(nm);
    th.onclick = (e) => { if (e.target.classList.contains('db-res')) return; e.stopPropagation(); openColMenu(th, col); };
    const grip = document.createElement('div'); grip.className = 'db-res'; grip.title = t('ลากเพื่อปรับความกว้าง');
    grip.addEventListener('mousedown', (e) => startColResize(e, col, cg.children[i]));
    grip.addEventListener('dblclick', (e) => { e.stopPropagation(); col.w = DB_COL_W_DEFAULT; saveDb(); renderTable(); });   // dbl-click = reset width
    th.appendChild(grip);
    htr.appendChild(th);
  });
  const addTh = document.createElement('th'); addTh.className = 'db-addcol'; addTh.textContent = '＋'; addTh.title = t('เพิ่มคอลัมน์');
  addTh.onclick = (e) => { e.stopPropagation(); openAddColMenu(addTh); };
  htr.appendChild(addTh);
  thead.appendChild(htr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  db.rows.forEach((row) => tbody.appendChild(buildDbRow(db, row)));
  table.appendChild(tbody); scroll.appendChild(table);
  const addRowBar = document.createElement('div'); addRowBar.className = 'db-addrow'; addRowBar.textContent = t('＋ เพิ่มแถว'); addRowBar.onclick = () => addDbRow();
  scroll.appendChild(addRowBar); body.appendChild(scroll);
}

// ---------- BOARD (kanban) view: group rows by a select column ----------
function renderBoardView(body, db){
  const selCols = db.columns.filter((c) => c.type === 'select');
  if (!selCols.length){ dbEmptyHint(body, t('บอร์ดต้องมีคอลัมน์แบบ “เลือก” (select) อย่างน้อย 1 คอลัมน์ — เพิ่มในมุมมองตาราง')); return; }
  if (!db.boardBy || !selCols.find((c) => c.id === db.boardBy)) db.boardBy = selCols[0].id;
  const col = db.columns.find((c) => c.id === db.boardBy);
  const bar = document.createElement('div'); bar.className = 'db-viewbar';
  bar.appendChild(pickColControl(t('จัดกลุ่มตาม'), selCols, db.boardBy, (v) => { db.boardBy = v; saveDb(); renderTable(); }));
  body.appendChild(bar);
  const scroll = document.createElement('div'); scroll.className = 'db-board';
  const groups = [ ...(col.options || []).map((o) => ({ key: o.name, color: o.color })), { key: '', color: 'gray', empty: true } ];
  groups.forEach((g) => {
    const rows = db.rows.filter((r) => (r[col.id] || '') === g.key);
    const lane = document.createElement('div'); lane.className = 'db-lane';
    const lh = document.createElement('div'); lh.className = 'db-lane-h';
    const pill = document.createElement('span'); pill.className = 'db-pill'; const c = DB_COLORS[g.color || 'gray']; pill.style.background = c[0]; pill.style.color = c[1]; pill.textContent = g.empty ? t('ไม่ระบุ') : g.key;
    const cnt = document.createElement('span'); cnt.className = 'db-lane-c'; cnt.textContent = rows.length;
    lh.appendChild(pill); lh.appendChild(cnt); lane.appendChild(lh);
    const list = document.createElement('div'); list.className = 'db-lane-list'; lane.appendChild(list);
    rows.forEach((row) => list.appendChild(buildBoardCard(db, row)));
    // drop target
    lane.addEventListener('dragover', (e) => { e.preventDefault(); lane.classList.add('drop'); });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
    lane.addEventListener('drop', (e) => {
      e.preventDefault(); lane.classList.remove('drop');
      const rid = e.dataTransfer.getData('text/plain'); const r = db.rows.find((x) => x.id === rid);
      if (r){ r[col.id] = g.key; saveDb(); renderTable(); }
    });
    const add = document.createElement('div'); add.className = 'db-lane-add'; add.textContent = t('＋ การ์ด');
    add.onclick = () => { const row = { id: dbNewId('r') }; db.columns.forEach((c2) => { row[c2.id] = c2.type === 'checkbox' ? false : (c2.type === 'relation' ? [] : ''); }); row[col.id] = g.key; db.rows.push(row); saveDb(); renderTable(); };
    lane.appendChild(add);
    scroll.appendChild(lane);
  });
  body.appendChild(scroll);
}
function buildBoardCard(db, row){
  const card = document.createElement('div'); card.className = 'db-bcard'; card.draggable = true;
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', row.id); card.classList.add('dragging'); });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  const t = document.createElement('div'); t.className = 'db-bcard-t'; t.textContent = rowTitle(db, row); card.appendChild(t);
  const meta = document.createElement('div'); meta.className = 'db-bcard-m';
  db.columns.forEach((c) => { if (c.id === db.boardBy || c === dbTitleCol(db)) return; const chip = fieldChip(db, c, row); if (chip) meta.appendChild(chip); });
  if (meta.children.length) card.appendChild(meta);
  card.onclick = (e) => { if (e.target === card || e.target === t) openRowEditor(db, row); };
  return card;
}
// small read chip for a field (used in board / gallery / calendar)
function fieldChip(db, col, row){
  const v = row[col.id];
  if (col.type === 'select'){ if (!v) return null; const opt = (col.options || []).find((o) => o.name === v); const s = document.createElement('span'); s.className = 'db-pill sm'; const c = DB_COLORS[(opt && opt.color) || 'gray']; s.style.background = c[0]; s.style.color = c[1]; s.textContent = v; return s; }
  if (col.type === 'checkbox'){ const s = document.createElement('span'); s.className = 'db-chip'; s.innerHTML = icoSvg(v ? 'checkbox' : 'x', 'xs'); s.appendChild(document.createTextNode(' ' + col.name)); return s; }
  if (col.type === 'date'){ if (!v) return null; const s = document.createElement('span'); s.className = 'db-chip'; s.innerHTML = icoSvg('cal', 'xs'); s.appendChild(document.createTextNode(' ' + v)); return s; }
  if (col.type === 'number'){ if (v === '' || v == null) return null; const s = document.createElement('span'); s.className = 'db-chip'; s.textContent = col.name + ': ' + v; return s; }
  if (col.type === 'relation'){ const arr = Array.isArray(v) ? v : []; if (!arr.length) return null; const s = document.createElement('span'); s.className = 'db-chip'; s.innerHTML = icoSvg('link', 'xs'); s.appendChild(document.createTextNode(' ' + arr.map((id) => relRowTitle(col.relDb, id)).join(', '))); return s; }
  if (col.type === 'text'){ if (!v) return null; const s = document.createElement('span'); s.className = 'db-chip'; s.textContent = String(v).slice(0, 40); return s; }
  return null;
}

// ---------- CALENDAR view: place rows on a date column ----------
function renderCalendarView(body, db){
  const dateCols = db.columns.filter((c) => c.type === 'date');
  if (!dateCols.length){ dbEmptyHint(body, t('ปฏิทินต้องมีคอลัมน์แบบ “วันที่” (date) — เพิ่มในมุมมองตาราง')); return; }
  if (!db.calBy || !dateCols.find((c) => c.id === db.calBy)) db.calBy = dateCols[0].id;
  const col = db.columns.find((c) => c.id === db.calBy);
  const now = new Date();
  if (!calCursor) calCursor = { y: now.getFullYear(), m: now.getMonth() };
  const bar = document.createElement('div'); bar.className = 'db-viewbar';
  const prev = document.createElement('button'); prev.className = 'ghost sm'; prev.textContent = '‹';
  prev.onclick = () => { calCursor.m--; if (calCursor.m < 0){ calCursor.m = 11; calCursor.y--; } renderTable(); };
  const next = document.createElement('button'); next.className = 'ghost sm'; next.textContent = '›';
  next.onclick = () => { calCursor.m++; if (calCursor.m > 11){ calCursor.m = 0; calCursor.y++; } renderTable(); };
  const THM = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
  const lbl = document.createElement('span'); lbl.className = 'db-cal-title'; lbl.textContent = t(THM[calCursor.m]) + ' ' + (uiLang === 'en' ? calCursor.y : (calCursor.y + 543));
  const today = document.createElement('button'); today.className = 'ghost sm'; today.textContent = t('วันนี้'); today.onclick = () => { calCursor = { y: now.getFullYear(), m: now.getMonth() }; renderTable(); };
  bar.appendChild(prev); bar.appendChild(lbl); bar.appendChild(next); bar.appendChild(today);
  bar.appendChild(pickColControl(t('วันที่จาก'), dateCols, db.calBy, (v) => { db.calBy = v; saveDb(); renderTable(); }));
  body.appendChild(bar);

  const grid = document.createElement('div'); grid.className = 'db-cal';
  ['อา','จ','อ','พ','พฤ','ศ','ส'].forEach((d) => { const h = document.createElement('div'); h.className = 'db-cal-wd'; h.textContent = t(d); grid.appendChild(h); });
  const first = new Date(calCursor.y, calCursor.m, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(calCursor.y, calCursor.m + 1, 0).getDate();
  const tstr = todayISO();
  for (let i = 0; i < startDow; i++){ const blank = document.createElement('div'); blank.className = 'db-cal-cell blank'; grid.appendChild(blank); }
  for (let d = 1; d <= daysInMonth; d++){
    const iso = calCursor.y + '-' + pad2(calCursor.m + 1) + '-' + pad2(d);
    const cell = document.createElement('div'); cell.className = 'db-cal-cell' + (iso === tstr ? ' today' : '');
    const dn = document.createElement('div'); dn.className = 'db-cal-dn'; dn.textContent = d; cell.appendChild(dn);
    db.rows.filter((r) => (r[col.id] || '') === iso).forEach((r) => {
      const chip = document.createElement('div'); chip.className = 'db-cal-ev'; chip.textContent = rowTitle(db, r);
      chip.onclick = (e) => { e.stopPropagation(); openRowEditor(db, r); };
      cell.appendChild(chip);
    });
    cell.onclick = () => { const row = { id: dbNewId('r') }; db.columns.forEach((c2) => { row[c2.id] = c2.type === 'checkbox' ? false : (c2.type === 'relation' ? [] : ''); }); row[col.id] = iso; db.rows.push(row); saveDb(); renderTable(); setTimeout(() => openRowEditor(db, row), 0); };
    grid.appendChild(cell);
  }
  body.appendChild(grid);
}

// ---------- GALLERY view: cards of rows ----------
function renderGalleryView(body, db){
  const scroll = document.createElement('div'); scroll.className = 'view-scroll';
  const grid = document.createElement('div'); grid.className = 'db-grid';
  db.rows.forEach((row) => {
    const card = document.createElement('div'); card.className = 'db-gcard';
    const t = document.createElement('div'); t.className = 'db-gcard-t'; t.textContent = rowTitle(db, row); card.appendChild(t);
    const fields = document.createElement('div'); fields.className = 'db-gcard-f';
    db.columns.forEach((c) => { if (c === dbTitleCol(db)) return; const chip = fieldChip(db, c, row); if (chip) fields.appendChild(chip); });
    card.appendChild(fields);
    card.onclick = () => openRowEditor(db, row);
    grid.appendChild(card);
  });
  const add = document.createElement('div'); add.className = 'db-gcard add'; add.textContent = t('＋ เพิ่มแถว'); add.onclick = () => addDbRow();
  grid.appendChild(add);
  scroll.appendChild(grid); body.appendChild(scroll);
}

// ---------- CHART view: bar chart grouped by a select column ----------
function renderChartView(body, db){
  const selCols = db.columns.filter((c) => c.type === 'select');
  const numCols = db.columns.filter((c) => c.type === 'number');
  if (!selCols.length){ dbEmptyHint(body, t('ชาร์ตต้องมีคอลัมน์แบบ “เลือก” (select) สำหรับจัดกลุ่ม')); return; }
  if (!db.chartBy || !selCols.find((c) => c.id === db.chartBy)) db.chartBy = selCols[0].id;
  if (!db.chartAgg) db.chartAgg = 'count';
  const col = db.columns.find((c) => c.id === db.chartBy);
  const bar = document.createElement('div'); bar.className = 'db-viewbar';
  bar.appendChild(pickColControl(t('จัดกลุ่มตาม'), selCols, db.chartBy, (v) => { db.chartBy = v; saveDb(); renderTable(); }));
  // aggregation control
  const aggWrap = document.createElement('div'); aggWrap.className = 'db-pickctl';
  const al = document.createElement('span'); al.className = 'db-pickctl-l'; al.textContent = t('ค่า'); aggWrap.appendChild(al);
  const aggSel = document.createElement('select');
  const oc = document.createElement('option'); oc.value = 'count'; oc.textContent = t('จำนวนแถว'); aggSel.appendChild(oc);
  numCols.forEach((c) => { const o = document.createElement('option'); o.value = c.id; o.textContent = t('ผลรวม ') + c.name; if (c.id === db.chartAgg) o.selected = true; aggSel.appendChild(o); });
  if (db.chartAgg === 'count') oc.selected = true;
  aggSel.onchange = () => { db.chartAgg = aggSel.value; saveDb(); renderTable(); };
  aggWrap.appendChild(aggSel); bar.appendChild(aggWrap);
  body.appendChild(bar);

  const groups = [ ...(col.options || []).map((o) => ({ key: o.name, color: o.color })), { key: '', color: 'gray', empty: true } ];
  const data = groups.map((g) => {
    const rows = db.rows.filter((r) => (r[col.id] || '') === g.key);
    let val = rows.length;
    if (db.chartAgg !== 'count'){ val = rows.reduce((s, r) => s + (Number(r[db.chartAgg]) || 0), 0); }
    return { label: g.empty ? 'ไม่ระบุ' : g.key, color: g.color, val };
  }).filter((d) => d.val > 0 || !d.label.startsWith('ไม่ระบุ'));
  const max = Math.max(1, ...data.map((d) => d.val));
  const chart = document.createElement('div'); chart.className = 'view-scroll db-chart';
  data.forEach((d) => {
    const row = document.createElement('div'); row.className = 'db-chart-row';
    const lab = document.createElement('span'); lab.className = 'db-chart-lab'; lab.textContent = t(d.label); row.appendChild(lab);
    const track = document.createElement('div'); track.className = 'db-chart-track';
    const fill = document.createElement('div'); fill.className = 'db-chart-fill'; const c = DB_COLORS[d.color || 'gray']; fill.style.background = c[1]; fill.style.width = Math.round(d.val / max * 100) + '%';
    track.appendChild(fill); row.appendChild(track);
    const val = document.createElement('span'); val.className = 'db-chart-val'; val.textContent = d.val; row.appendChild(val);
    chart.appendChild(row);
  });
  body.appendChild(chart);
}

// ---------- Row editor (used by board/gallery/calendar cards) ----------
function openRowEditor(db, row){
  closeDbMenu();
  const back = document.createElement('div'); back.className = 'modal-backdrop'; back.id = 'rowEditor';
  const card = document.createElement('div'); card.className = 'modal-card db-roweditor';
  const h = document.createElement('h3'); h.textContent = rowTitle(db, row); card.appendChild(h);
  const list = document.createElement('div'); list.className = 'db-re-list';
  db.columns.forEach((col) => {
    const frow = document.createElement('div'); frow.className = 'db-re-row';
    const lab = document.createElement('label'); lab.className = 'db-re-lab'; lab.innerHTML = icoSvg(DB_TYPE_ICON[col.type] || 'text', 'xs'); lab.appendChild(document.createTextNode(' ' + col.name)); frow.appendChild(lab);
    const cell = document.createElement('div'); cell.className = 'db-re-val';
    const inner = document.createElement('div');
    fillCell(inner, col, row, () => { h.textContent = rowTitle(db, row); }, false);
    cell.appendChild(inner); frow.appendChild(cell); list.appendChild(frow);
  });
  card.appendChild(list);
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const del = document.createElement('button'); del.className = 'ghost'; del.textContent = t('ลบแถว'); del.onclick = async () => { if (!(await confirmDelete(t('ลบแถวนี้?')))) return; dbCache.rows = dbCache.rows.filter((r) => r.id !== row.id); saveDb(); back.remove(); renderTable(); };
  const done = document.createElement('button'); done.className = 'solid'; done.textContent = t('เสร็จ'); done.onclick = () => { back.remove(); renderTable(); };
  actions.appendChild(del); actions.appendChild(done); card.appendChild(actions);
  back.appendChild(card); document.body.appendChild(back);
  back.addEventListener('mousedown', (e) => { if (e.target === back){ back.remove(); renderTable(); } });
}

function buildDbRow(db, row){
  const tr = document.createElement('tr');
  db.columns.forEach((col) => tr.appendChild(buildCell(col, row)));
  const del = document.createElement('td'); del.className = 'db-delrow'; del.innerHTML = icoSvg('x', 'xs'); del.title = t('ลบแถว');
  del.onclick = async () => { if (!(await confirmDelete(t('ลบแถวนี้?')))) return; dbCache.rows = dbCache.rows.filter((r) => r.id !== row.id); saveDb(); renderTable(); };
  tr.appendChild(del);
  return tr;
}
function buildCell(col, row, onChange){ const td = document.createElement('td'); fillCell(td, col, row, onChange, true); return td; }
// populate ANY element (td in the table, or div in the row editor) with a cell's value + inline editing
function fillCell(el, col, row, onChange, isTd){
  el.className = (isTd ? 'db-cell ' : 'db-recell ') + 'db-' + col.type;
  el.innerHTML = ''; el.onclick = null;
  const val = row[col.id];
  const rer = () => fillCell(el, col, row, onChange, isTd);
  const changed = () => { saveDb(); if (onChange) onChange(); };
  if (col.type === 'checkbox'){
    const box = document.createElement('span'); box.className = 'db-chk' + (val ? ' on' : '');
    box.onclick = (e) => { e.stopPropagation(); row[col.id] = !row[col.id]; box.classList.toggle('on', row[col.id]); changed(); };
    el.appendChild(box);
  } else if (col.type === 'select'){
    if (val){ const opt = (col.options || []).find((o) => o.name === val); const pill = document.createElement('span'); pill.className = 'db-pill'; const c = DB_COLORS[(opt && opt.color) || 'gray']; pill.style.background = c[0]; pill.style.color = c[1]; pill.textContent = val; el.appendChild(pill); }
    else { const ph = document.createElement('span'); ph.className = 'db-empty'; ph.textContent = '—'; el.appendChild(ph); }
    el.onclick = (e) => { e.stopPropagation(); openSelectMenu(el, col, row, rer); };
  } else if (col.type === 'relation'){
    const arr = Array.isArray(val) ? val : [];
    if (arr.length){ arr.forEach((id) => { const pill = document.createElement('span'); pill.className = 'db-pill rel'; pill.innerHTML = icoSvg('link', 'xs'); pill.appendChild(document.createTextNode(' ' + relRowTitle(col.relDb, id))); el.appendChild(pill); }); }
    else { const ph = document.createElement('span'); ph.className = 'db-empty'; ph.textContent = t('＋ เชื่อมโยง'); el.appendChild(ph); }
    el.onclick = (e) => { e.stopPropagation(); openRelationPicker(el, col, row, rer); };
  } else {
    const span = document.createElement('span'); span.className = 'db-val' + (col.type === 'date' ? ' db-date' : '');
    span.textContent = (val == null || val === '') ? '' : String(val);
    el.appendChild(span);
    el.onclick = () => editTextCellEl(el, col, row, onChange, isTd);
  }
}
function editTextCellEl(el, col, row, onChange, isTd){
  if (el.querySelector('input')) return;
  const cur = row[col.id]; el.innerHTML = ''; el.onclick = null;
  const inp = document.createElement('input'); inp.className = 'db-input';
  inp.type = col.type === 'number' ? 'number' : (col.type === 'date' ? 'date' : 'text');
  inp.value = cur == null ? '' : cur;
  el.appendChild(inp); inp.focus();
  let done = false;
  const finish = () => { if (done) return; done = true; let v = inp.value; if (col.type === 'number') v = (v === '' ? '' : Number(v)); row[col.id] = v; saveDb(); if (onChange) onChange(); fillCell(el, col, row, onChange, isTd); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(); } else if (e.key === 'Escape') { done = true; fillCell(el, col, row, onChange, isTd); } });
  inp.addEventListener('blur', finish);
}
// relation cell picker: multi-select rows from the linked DB
function openRelationPicker(anchor, col, row, rer){
  closeDbMenu();
  const target = relCache[col.relDb];
  const menu = document.createElement('div'); menu.className = 'db-menu db-relmenu'; menu.id = 'dbMenu';
  if (!target){ const m = document.createElement('div'); m.className = 'db-mi db-mi-mut'; m.textContent = t('DB ปลายทางหาย'); menu.appendChild(m); placeDbMenu(menu, anchor); return; }
  const hd = document.createElement('div'); hd.className = 'lp-sub'; hd.textContent = t('เชื่อมกับ “') + target.name + '”'; menu.appendChild(hd);
  const search = document.createElement('input'); search.className = 'db-hinput'; search.placeholder = t('ค้นหา…'); menu.appendChild(search);
  const listWrap = document.createElement('div'); listWrap.className = 'db-rellist'; menu.appendChild(listWrap);
  const cur = () => (Array.isArray(row[col.id]) ? row[col.id] : []);
  const draw = (q) => {
    listWrap.innerHTML = '';
    (target.rows || []).filter((r) => rowTitle(target, r).toLowerCase().includes((q || '').toLowerCase())).slice(0, 40).forEach((r) => {
      const it = document.createElement('div'); it.className = 'db-mi';
      const on = cur().includes(r.id);
      const box = document.createElement('span'); box.className = 'db-chk sm' + (on ? ' on' : ''); it.appendChild(box);
      const nm = document.createElement('span'); nm.textContent = rowTitle(target, r); it.appendChild(nm);
      it.onclick = () => { let a = cur(); if (a.includes(r.id)) a = a.filter((x) => x !== r.id); else a = [...a, r.id]; row[col.id] = a; saveDb(); syncBackref(dbCache, col, row); box.classList.toggle('on', a.includes(r.id)); rer(); };
      listWrap.appendChild(it);
    });
    if (!listWrap.children.length){ const e = document.createElement('div'); e.className = 'db-mi db-mi-mut'; e.textContent = t('ไม่พบแถว'); listWrap.appendChild(e); }
  };
  search.addEventListener('input', () => draw(search.value));
  draw('');
  placeDbMenu(menu, anchor);
  setTimeout(() => search.focus(), 0);
}
function openSelectMenu(anchor, col, row, rer){
  closeDbMenu();
  const done = () => { saveDb(); closeDbMenu(); if (rer) rer(); };
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  (col.options || []).forEach((o) => {
    const it = document.createElement('div'); it.className = 'db-mi';
    const pill = document.createElement('span'); pill.className = 'db-pill'; const c = DB_COLORS[o.color || 'gray']; pill.style.background = c[0]; pill.style.color = c[1]; pill.textContent = o.name;
    it.appendChild(pill);
    it.onclick = () => { row[col.id] = o.name; done(); };
    menu.appendChild(it);
  });
  const clear = document.createElement('div'); clear.className = 'db-mi db-mi-mut'; clear.textContent = t('ล้างค่า');
  clear.onclick = () => { row[col.id] = ''; done(); };
  menu.appendChild(clear);
  const addWrap = document.createElement('div'); addWrap.className = 'db-addopt';
  const inp = document.createElement('input'); inp.className = 'db-hinput'; inp.placeholder = t('＋ ตัวเลือกใหม่ (Enter)');
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const name = inp.value.trim(); if (name) { const color = DB_COLOR_KEYS[(col.options || []).length % DB_COLOR_KEYS.length]; col.options = col.options || []; col.options.push({ name, color }); row[col.id] = name; done(); } } });
  addWrap.appendChild(inp); menu.appendChild(addWrap);
  placeDbMenu(menu, anchor);
  setTimeout(() => inp.focus(), 0);
}

function openColMenu(th, col){
  closeDbMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  const ren = document.createElement('div'); ren.className = 'db-mi'; ren.textContent = t('เปลี่ยนชื่อคอลัมน์'); ren.onclick = () => { closeDbMenu(); renameColHeader(th, col); };
  menu.appendChild(ren);
  if (dbCache.columns.length > 1) {
    const del = document.createElement('div'); del.className = 'db-mi db-mi-del'; del.textContent = t('ลบคอลัมน์');
    del.onclick = async () => {
      closeDbMenu();
      if (!(await confirmDelete(t('ลบคอลัมน์ “') + (col.name || '') + t('”? ข้อมูลในคอลัมน์นี้จะถูกลบด้วย')))) return;
      if (col.type === 'relation' && col.backCol && col.relDb && col.relDb !== dbCache.id){   // remove the paired back-reference column too
        try { const t = await window.api.dbRead(col.relDb); if (t){ t.columns = (t.columns || []).filter((c) => c.id !== col.backCol); t.rows.forEach((r) => { delete r[col.backCol]; }); await window.api.dbSave(t); relCache[col.relDb] = t; } } catch (_) {}
      }
      dbCache.columns = dbCache.columns.filter((c) => c.id !== col.id); dbCache.rows.forEach((r) => { delete r[col.id]; });
      saveDb(); renderTable();
    };
    menu.appendChild(del);
  }
  placeDbMenu(menu, th);
}
function renameColHeader(th, col){
  const inp = document.createElement('input'); inp.className = 'db-hinput'; inp.value = col.name;
  th.innerHTML = ''; th.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) col.name = v; saveDb(); renderTable(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderTable(); } });
  inp.addEventListener('blur', commit);
}
function addColumn(type, extra){
  const col = Object.assign({ id: dbNewId('c'), name: t('คอลัมน์ใหม่'), type }, extra || {});
  if (type === 'select') col.options = [];
  dbCache.columns.push(col);
  dbCache.rows.forEach((r) => { r[col.id] = type === 'checkbox' ? false : (type === 'relation' ? [] : ''); });
  saveDb(); closeDbMenu(); renderTable();
  setTimeout(() => { const ths = document.querySelectorAll('#tableView table.db thead th'); const th = ths[dbCache.columns.length - 1]; if (th) renameColHeader(th, col); }, 0);
}
function openAddColMenu(anchor){
  closeDbMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  DB_TYPES.forEach(([type, icon, label]) => {
    const it = document.createElement('div'); it.className = 'db-mi';
    const ty = document.createElement('span'); ty.className = 'db-ty'; ty.appendChild(icoEl(icon, 'sm'));
    const lab = document.createElement('span'); lab.textContent = ' ' + t(label);
    it.appendChild(ty); it.appendChild(lab);
    it.onclick = async () => {
      if (type === 'relation'){ openRelTargetMenu(anchor); return; }   // relation → choose which DB to link
      addColumn(type);
    };
    menu.appendChild(it);
  });
  placeDbMenu(menu, anchor);
}
async function openRelTargetMenu(anchor){
  closeDbMenu();
  const dbs = await window.api.dbList();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  const hd = document.createElement('div'); hd.className = 'lp-sub'; hd.textContent = t('เชื่อมโยงไปยังฐานข้อมูล:'); menu.appendChild(hd);
  dbs.forEach((d) => {
    const it = document.createElement('div'); it.className = 'db-mi';
    it.innerHTML = icoSvg('db','sm'); it.appendChild(document.createTextNode(' ' + d.name));
    it.onclick = () => addRelationColumn(d.id, d.name);
    menu.appendChild(it);
  });
  if (!dbs.length){ const e = document.createElement('div'); e.className = 'db-mi db-mi-mut'; e.textContent = t('ยังไม่มีฐานข้อมูลอื่น'); menu.appendChild(e); }
  placeDbMenu(menu, anchor);
}
// create a TWO-WAY relation: colX on this DB + an auto back-reference colY on the target DB (Notion-style)
async function addRelationColumn(targetId, targetName){
  const self = targetId === dbCache.id;
  const target = self ? dbCache : await window.api.dbRead(targetId);
  if (!target){ closeDbMenu(); return; }
  const colX = { id: dbNewId('c'), name: targetName, type: 'relation', relDb: targetId };
  const colY = { id: dbNewId('c'), name: '↩ ' + dbCache.name, type: 'relation', relDb: dbCache.id };
  colX.backCol = colY.id; colY.backCol = colX.id;
  dbCache.columns.push(colX); dbCache.rows.forEach((r) => { r[colX.id] = []; });
  target.columns.push(colY); target.rows.forEach((r) => { r[colY.id] = []; });
  if (!self){ await window.api.dbSave(target); relCache[targetId] = target; }
  saveDb(); closeDbMenu(); renderTable();
  setTimeout(() => { const ths = document.querySelectorAll('#tableView table.db thead th'); const th = ths[dbCache.columns.length - (self ? 2 : 1)]; if (th) renameColHeader(th, colX); }, 0);
}
// keep the paired back-reference column in sync after editing a relation cell
async function syncBackref(db, col, row){
  if (!col.backCol || !col.relDb) return;
  const self = col.relDb === db.id;
  const target = self ? db : (relCache[col.relDb] || await window.api.dbRead(col.relDb));
  if (!target) return;
  const bcol = (target.columns || []).find((c) => c.id === col.backCol);
  if (!bcol) return;
  const myId = row.id;
  const linked = new Set(Array.isArray(row[col.id]) ? row[col.id] : []);
  (target.rows || []).forEach((tr) => {
    if (self && tr.id === myId) return;
    const arr = Array.isArray(tr[bcol.id]) ? tr[bcol.id] : [];
    const has = arr.includes(myId);
    if (linked.has(tr.id) && !has) tr[bcol.id] = [...arr, myId];
    else if (!linked.has(tr.id) && has) tr[bcol.id] = arr.filter((x) => x !== myId);
  });
  if (!self){ await window.api.dbSave(target); relCache[col.relDb] = target; }
  else saveDb();
}

function openDbMenu(anchor){
  closeDbMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  const ren = document.createElement('div'); ren.className = 'db-mi'; ren.textContent = t('เปลี่ยนชื่อฐานข้อมูล'); ren.onclick = () => { closeDbMenu(); renameDbTitle(); };
  const del = document.createElement('div'); del.className = 'db-mi db-mi-del'; del.textContent = t('ลบฐานข้อมูล');
  del.onclick = async () => { closeDbMenu(); const _dn = dbCache && dbCache.name ? (' "' + dbCache.name + '"') : ''; if (!(await confirmDelete(t('ย้ายฐานข้อมูล') + _dn + t(' ไปถังขยะ?')))) return; await window.api.dbDelete(dbOpenId); dbOpenId = null; dbCache = null; try { sbDbCache = await window.api.dbList(); } catch (_) {} renderTable(); renderSidebar(); };
  menu.appendChild(ren); menu.appendChild(del);
  placeDbMenu(menu, anchor);
}
function renameDbTitle(){
  const title = document.querySelector('#tableView .view-head .vh-title'); if (!title || !dbCache) return;
  const inp = document.createElement('input'); inp.className = 'db-hinput'; inp.value = dbCache.name;
  title.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) dbCache.name = v; saveDb(); renderTable(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderTable(); } });
  inp.addEventListener('blur', commit);
}
function addDbRow(){
  if (!dbCache) return;
  const row = { id: dbNewId('r') };
  dbCache.columns.forEach((c) => { row[c.id] = c.type === 'checkbox' ? false : (c.type === 'relation' ? [] : ''); });
  dbCache.rows.push(row); saveDb(); renderTable();
}

function closeDbMenu(){ const m = document.getElementById('dbMenu'); if (m) m.remove(); document.removeEventListener('mousedown', onDbMenuOutside, true); }
function onDbMenuOutside(e){ const m = document.getElementById('dbMenu'); if (m && !m.contains(e.target)) closeDbMenu(); }
function placeDbMenu(menu, anchor){
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight || 200, mw = menu.offsetWidth || 200;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);   // flip up near the window bottom
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';   // keep the whole menu on-screen
  setTimeout(() => document.addEventListener('mousedown', onDbMenuOutside, true), 0);
}
// ---------- Selection → Database row (task tracking) ----------
function defaultTaskDb(){ return vsGet('taskDbId', ''); }
function setDefaultTaskDb(id){ vsSet('taskDbId', id || ''); }
async function openAddToDbMenu(text, anchor){
  closeDbMenu();
  const label = text.length > 26 ? text.slice(0, 26) + '…' : text;
  let dbs = await window.api.dbList();
  const defId = defaultTaskDb();
  dbs = dbs.slice().sort((a, b) => (b.id === defId ? 1 : 0) - (a.id === defId ? 1 : 0));   // default DB first
  const menu = document.createElement('div'); menu.className = 'db-menu db-taskmenu'; menu.id = 'dbMenu';
  const hd = document.createElement('div'); hd.className = 'lp-sub'; hd.textContent = t('เพิ่ม “') + label + t('” เป็นรายการใน:'); menu.appendChild(hd);
  dbs.forEach((d) => {
    const it = document.createElement('div'); it.className = 'db-mi db-taskrow';
    const nm = document.createElement('span'); nm.className = 'dt-nm'; nm.innerHTML = icoSvg('db','sm'); nm.appendChild(document.createTextNode(' ' + d.name));
    it.appendChild(nm);
    if (d.id === defId){ const bg = document.createElement('span'); bg.className = 'dt-badge'; bg.textContent = t('ค่าเริ่มต้น'); it.appendChild(bg); }
    const star = document.createElement('span'); star.className = 'dt-star' + (d.id === defId ? ' on' : ''); star.innerHTML = icoSvg('star', 'sm');
    star.title = d.id === defId ? t('เลิกผูกเป็น DB เริ่มต้น') : t('ผูกเป็น DB เริ่มต้นสำหรับ Task');
    star.onclick = (e) => { e.stopPropagation(); setDefaultTaskDb(d.id === defId ? '' : d.id); closeDbMenu(); openAddToDbMenu(text, anchor); };
    it.appendChild(star);
    it.onclick = () => { closeDbMenu(); addSelectionToDb(d.id, text); };
    menu.appendChild(it);
  });
  const add = document.createElement('div'); add.className = 'db-mi lp-add'; add.textContent = t('สร้าง DB “งานประจำวัน” ใหม่');
  add.onclick = async () => { closeDbMenu(); const db = await createTasksDb(); if (db) addSelectionToDb(db.id, text); };
  menu.appendChild(add);
  placeDbMenu(menu, anchor);
}
async function createTasksDb(){
  const db = await window.api.dbCreate({ name: 'งานประจำวัน' });   // reuse for a valid id, then reshape into a task tracker
  if (!db) return null;
  db.columns = [
    { id: 'c1', name: 'งาน', type: 'text' },
    { id: 'c2', name: 'สถานะ', type: 'select', options: [ { name: 'รอทำ', color: 'gray' }, { name: 'กำลังทำ', color: 'amber' }, { name: 'เสร็จ', color: 'green' } ] },
    { id: 'c3', name: 'ความสำคัญ', type: 'select', options: [ { name: 'สูง', color: 'coral' }, { name: 'กลาง', color: 'sand' }, { name: 'ต่ำ', color: 'blue' } ] },
    { id: 'c4', name: 'กำหนด', type: 'date' },
  ];
  db.rows = []; db.view = 'table';
  await window.api.dbSave(db);
  setDefaultTaskDb(db.id);          // a freshly made task DB becomes the bound default
  return db;
}
function taskRowFromText(db, text){
  const row = { id: dbNewId('r') };
  (db.columns || []).forEach((c) => { row[c.id] = c.type === 'checkbox' ? false : (c.type === 'relation' ? [] : ''); });
  const titleCol = (db.columns || []).find((c) => c.type === 'text') || (db.columns || [])[0];
  if (titleCol) row[titleCol.id] = text;
  const statusCol = (db.columns || []).find((c) => c.type === 'select' && (c.options || []).length);
  if (statusCol) row[statusCol.id] = statusCol.options[0].name;    // default to first status (e.g. "รอทำ")
  const dateCol = (db.columns || []).find((c) => c.type === 'date');
  if (dateCol) row[dateCol.id] = todayISO();                       // stamp today for daily tracking
  return row;
}
async function addSelectionToDb(dbId, text){
  const db = await window.api.dbRead(dbId); if (!db) return;
  db.rows = db.rows || []; db.rows.push(taskRowFromText(db, text));
  await window.api.dbSave(db);
  const ab = document.getElementById('actionBar'); if (ab) ab.hidden = true;
  toastAddedToDb(db);
}
function toastAddedToDb(db){
  document.querySelectorAll('.toast').forEach((el) => el.remove());
  const toast = document.createElement('div'); toast.className = 'toast';
  const msg = document.createElement('span'); msg.textContent = t('เพิ่มลง “') + db.name + t('” แล้ว');
  const open = document.createElement('button'); open.className = 'toast-btn'; open.textContent = t('เปิดตาราง');
  open.onclick = () => { dbOpenId = db.id; dbCache = null; if (typeof setMainView === 'function') setMainView('table'); toast.remove(); };
  toast.appendChild(msg); toast.appendChild(open); document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 4500);
}
// close on Escape while open
window.addEventListener('keydown', (e) => {
  if(e.key!=='Escape') return;
    if(suggestApply){ suggestApply(); return; }
  const dov=document.getElementById('diffOverlay');
  if(dov && !dov.hidden && diffRevertCb){ const fn=diffRevertCb; diffRevertCb=null; fn(); return; }
  const sov=document.getElementById('settingsOverlay');
  if(sov && !sov.hidden){ sov.hidden=true; sov.innerHTML=''; return; }
  if(mainView==='graph' || mainView==='table'){ setMainView('note'); return; }
});

// ---------- Main-area views (note / graph / table) + force-directed graph ----------
let graphRAF=null, graphRO=null;
function closeGraph(){ if(graphRAF) cancelAnimationFrame(graphRAF); graphRAF=null; if(graphRO){ try{ graphRO.disconnect(); }catch(_){} graphRO=null; } }
async function renderGraph(){
  closeGraph();
  const host = document.getElementById('graphView');
  const data = await window.api.graphData();
  host.innerHTML = '';
  const head = document.createElement('div'); head.className = 'view-head';
  const title = document.createElement('span'); title.className = 'vh-title'; title.textContent = t('บอร์ดความเชื่อมโยง (') + data.nodes.length + t(' โน้ต, ') + data.edges.length + t(' ลิงก์)');
  const back = document.createElement('button'); back.className = 'ghost sm'; back.textContent = t('↩ โน้ต'); back.onclick = () => setMainView('note');
  head.appendChild(title); head.appendChild(back); host.appendChild(head);
  const stage = document.createElement('div'); stage.className = 'cork-stage'; host.appendChild(stage);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'cork-svg'); stage.appendChild(svg);

  if (!data.nodes.length) { const e = document.createElement('div'); e.className = 'cork-empty'; e.textContent = t('ยังไม่มีลิงก์ระหว่างโน้ต — เพิ่ม [[ชื่อโน้ต]] ในเนื้อหาเพื่อสร้างความเชื่อมโยง'); stage.appendChild(e); return; }

  const curId = (currentNote || '').replace(/\.md$/i, '').toLowerCase();
  let W = 800, H = 500;
  function sizeStage(){ const r = stage.getBoundingClientRect(); W = Math.max(240, Math.round(r.width)); H = Math.max(220, Math.round(r.height)); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); }
  sizeStage();

  const nodes = data.nodes.map((n, i) => {
    const el = document.createElement('div'); el.className = 'cork-card' + (n.id.toLowerCase() === curId ? ' cur' : '');
    el.textContent = n.id; el.title = n.id;
    const rot = ((i * 37) % 7) - 3;
    el.style.transform = 'translate(-50%,-50%) rotate(' + rot + 'deg)';
    el.onclick = () => { const f = n.file || (n.id + '.md'); openNote(f).then(() => refreshList(f)).then(() => setMainView('note')); };
    stage.appendChild(el);
    return { id: n.id, el, x: W/2 + (Math.random()-0.5)*Math.min(W,H)*0.6, y: H/2 + (Math.random()-0.5)*Math.min(W,H)*0.6, vx: 0, vy: 0 };
  });
  const index = {}; nodes.forEach((n) => index[n.id.toLowerCase()] = n);
  const edges = data.edges.map((e) => ({ a: index[e.from.toLowerCase()], b: index[e.to.toLowerCase()] })).filter((e) => e.a && e.b);
  const strings = edges.map(() => { const p = document.createElementNS(NS, 'path'); p.setAttribute('class', 'cork-string'); svg.appendChild(p); return p; });

  function step(){
    for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++){ const a = nodes[i], b = nodes[j]; let dx = a.x-b.x, dy = a.y-b.y; let d2 = dx*dx+dy*dy || 0.01; let d = Math.sqrt(d2); const f = 9000/d2; const fx = f*dx/d, fy = f*dy/d; a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy; }
    for (const e of edges){ let dx = e.b.x-e.a.x, dy = e.b.y-e.a.y; let d = Math.sqrt(dx*dx+dy*dy) || 0.01; const f = (d-165)*0.02; const fx = f*dx/d, fy = f*dy/d; e.a.vx += fx; e.a.vy += fy; e.b.vx -= fx; e.b.vy -= fy; }
    for (const n of nodes){ n.vx += (W/2-n.x)*0.004; n.vy += (H/2-n.y)*0.004; n.vx *= 0.86; n.vy *= 0.86; n.x += n.vx; n.y += n.vy; n.x = Math.max(54, Math.min(W-54, n.x)); n.y = Math.max(44, Math.min(H-44, n.y)); }
  }
  function paint(){
    for (const n of nodes){ n.el.style.left = n.x + 'px'; n.el.style.top = n.y + 'px'; }
    edges.forEach((e, i) => { const mx = (e.a.x+e.b.x)/2, my = (e.a.y+e.b.y)/2 + 16; strings[i].setAttribute('d', 'M' + e.a.x + ' ' + e.a.y + ' Q' + mx + ' ' + my + ' ' + e.b.x + ' ' + e.b.y); });
  }
  let frames = 0;
  function loop(){ step(); paint(); frames++; if (frames < 520) graphRAF = requestAnimationFrame(loop); else graphRAF = null; }
  loop();
  graphRO = new ResizeObserver(() => { sizeStage(); frames = 0; if (!graphRAF) loop(); }); graphRO.observe(stage);
}
let mainView='note';
function setMainView(v){
  const left=document.getElementById('left'); if(!left) return;
  if(v===mainView) v='note';
  if(mainView==='graph' && v!=='graph') closeGraph();
  mainView=v;
  left.classList.toggle('view-graph', v==='graph');
  left.classList.toggle('view-table', v==='table');
  left.classList.toggle('view-dash', v==='dash');
  left.classList.toggle('view-pdf', v==='pdf');
  left.classList.toggle('view-crate', v==='crate');
  left.classList.toggle('view-trash', v==='trash');
  document.querySelectorAll('.sb-views .sbv').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if(v==='graph') renderGraph();
  else if(v==='table') renderTable();
  else if(v==='dash') renderDash();
  else if(v==='trash') renderTrashView();
  if (typeof renderSidebar === 'function') renderSidebar();
}
document.querySelectorAll('.sb-views .sbv').forEach((b) => { b.onclick = () => setMainView(b.dataset.view); });

// ---------- Theme ----------
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  applyTermTheme();
}
document.getElementById('themeBtn').onclick = () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', t);
  applyTheme(t);
};

// ---------- Settings popup menu (Language / Theme / AI prompt settings) ----------
function closeSettingsMenu(){ const m = document.getElementById('settingsMenu'); if (m) m.remove(); document.removeEventListener('mousedown', onSettingsMenuOutside, true); }
function onSettingsMenuOutside(e){ const m = document.getElementById('settingsMenu'); if (m && !m.contains(e.target)) closeSettingsMenu(); }
function openSettingsMenu(anchor){
  closeSettingsMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu settings-menu'; menu.id = 'settingsMenu';

  // Language row
  const langRow = document.createElement('div'); langRow.className = 'set-row';
  const langLab = document.createElement('span'); langLab.className = 'set-lab'; langLab.textContent = t('ภาษา / Language');
  const langSeg = document.createElement('div'); langSeg.className = 'set-seg';
  [['th','ไทย'],['en','English']].forEach(([v, l]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'set-seg-btn' + (uiLang === v ? ' on' : ''); b.textContent = l;
    b.onclick = (e) => { e.stopPropagation(); setUiLang(v); };
    langSeg.appendChild(b);
  });
  langRow.appendChild(langLab); langRow.appendChild(langSeg); menu.appendChild(langRow);

  // Theme row
  const thRow = document.createElement('div'); thRow.className = 'set-row';
  const thLab = document.createElement('span'); thLab.className = 'set-lab'; thLab.textContent = t('ธีม / Theme');
  const thSeg = document.createElement('div'); thSeg.className = 'set-seg';
  const curTheme = document.documentElement.getAttribute('data-theme') || 'light';
  [['light', t('สว่าง')], ['dark', t('มืด')]].forEach(([v, l]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'set-seg-btn' + (curTheme === v ? ' on' : ''); b.textContent = l;
    b.onclick = (e) => { e.stopPropagation(); localStorage.setItem('theme', v); applyTheme(v); thSeg.querySelectorAll('.set-seg-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
    thSeg.appendChild(b);
  });
  thRow.appendChild(thLab); thRow.appendChild(thSeg); menu.appendChild(thRow);

  const sep = document.createElement('div'); sep.className = 'set-sep'; menu.appendChild(sep);

  const ai = document.createElement('div'); ai.className = 'db-mi'; ai.innerHTML = icoSvg('settings', 'sm'); ai.appendChild(document.createTextNode(' ' + t('ตั้งค่าคำสั่ง AI…')));
  ai.onclick = () => { closeSettingsMenu(); openSettings(); };
  menu.appendChild(ai);

  const aip = document.createElement('div'); aip.className = 'db-mi'; aip.id = 'aiSettingsMenuItem';
  aip.innerHTML = icoSvg('sparkle','sm'); aip.appendChild(document.createTextNode(' ' + t('ตั้งค่า AI provider…')));
  aip.onclick = () => { closeSettingsMenu(); openAiSettings(); };
  menu.appendChild(aip);

  document.body.appendChild(menu);
  const rc = anchor.getBoundingClientRect();
  menu.style.left = Math.min(rc.left, window.innerWidth - 230) + 'px';
  menu.style.bottom = (window.innerHeight - rc.top + 4) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onSettingsMenuOutside, true), 0);
}

// ---------- Settings (editable prompt library) ----------
function openSettings(){
  const ov=document.getElementById('settingsOverlay'); ov.innerHTML='';
  const card=document.createElement('div'); card.className='settings-card';
  const head=document.createElement('div'); head.className='tbl-head';
  const title=document.createElement('span'); title.textContent=t('ตั้งค่า');
  const close=document.createElement('button'); close.className='rv-close'; close.innerHTML=icoSvg('x','sm');
  close.onclick=()=>{ ov.hidden=true; ov.innerHTML=''; };
  head.appendChild(title); head.appendChild(close); card.appendChild(head);
  const info=document.createElement('p'); info.className='settings-info'; info.textContent=t('แก้ข้อความคำสั่ง AI ได้ ใช้ {term} = คำที่เลือก, {file} = ชื่อไฟล์โน้ต'); card.appendChild(info);
  const fields={};
  Object.keys(DEFAULT_PROMPTS).forEach(key=>{
    const wrap=document.createElement('div'); wrap.className='settings-field';
    const lab=document.createElement('label'); lab.textContent=t(PROMPT_LABELS[key]||key);
    const ta=document.createElement('textarea'); ta.value=promptTemplates[key]||DEFAULT_PROMPTS[key]; ta.rows=2;
    wrap.appendChild(lab); wrap.appendChild(ta); card.appendChild(wrap); fields[key]=ta;
  });
  const actions=document.createElement('div'); actions.className='settings-actions';
  const reset=document.createElement('button'); reset.className='ghost'; reset.textContent=t('คืนค่าเริ่มต้น');
  const save=document.createElement('button'); save.className='solid'; save.textContent=t('บันทึก');
  reset.onclick=()=>{ Object.keys(DEFAULT_PROMPTS).forEach(k=>{ fields[k].value=DEFAULT_PROMPTS[k]; }); };
  save.onclick=()=>{
    const obj={};
    Object.keys(DEFAULT_PROMPTS).forEach(k=>{ obj[k]=fields[k].value.trim()||DEFAULT_PROMPTS[k]; });
    promptTemplates=Object.assign({}, DEFAULT_PROMPTS, obj);
    localStorage.setItem('prompts', JSON.stringify(promptTemplates));
    ov.hidden=true; ov.innerHTML='';
  };
  actions.appendChild(reset); actions.appendChild(save); card.appendChild(actions);
  ov.appendChild(card); ov.hidden=false;
}
document.getElementById('settingsBtn').onclick = openSettings;

// ---------- AI provider settings (step 3a-2) ----------
// Modal into #settingsOverlay, same pattern as openSettings(). Loads the safe
// view (aiGetConfig) — never the raw key. Default mode stays 'cli' so nothing
// changes for current users until they opt in. Writes only via 3a-1 IPC.
const AI_MODELS = {
  anthropic: ['claude-opus-4-8','claude-sonnet-5','claude-haiku-4-5-20251001'],
  zai: ['glm-5.2','glm-5.1','glm-4.7'],
};
async function openAiSettings(){
  const ov=document.getElementById('settingsOverlay'); ov.innerHTML='';
  const cfg = await window.api.aiGetConfig();

  const card=document.createElement('div'); card.className='settings-card'; card.id='aiSettingsModal';
  const head=document.createElement('div'); head.className='tbl-head';
  const title=document.createElement('span'); title.textContent=t('ตั้งค่า AI / AI Settings');
  const xBtn=document.createElement('button'); xBtn.className='rv-close'; xBtn.id='aiSettingsCancel'; xBtn.innerHTML=icoSvg('x','sm');
  const dismiss=()=>{ ov.hidden=true; ov.innerHTML=''; };
  xBtn.onclick=dismiss;
  head.appendChild(title); head.appendChild(xBtn); card.appendChild(head);

  let selectedMode = cfg.mode;

  // MODE segmented control — cli / api / managed(disabled)
  const modeSeg=document.createElement('div'); modeSeg.className='ai-mode-seg';
  const MODES=[
    ['cli', t('CLI (บนเครื่อง)'), 'opencode / claude'],
    ['api', t('API key'), t('ใส่คีย์เอง')],
    ['managed', t('Managed'), t('เร็ว ๆ นี้')],
  ];
  MODES.forEach(([m, label, sub])=>{
    const b=document.createElement('button'); b.type='button'; b.className='ai-mode-btn'+(cfg.mode===m?' on':''); b.dataset.mode=m;
    const l=document.createElement('span'); l.className='ai-mode-lab'; l.textContent=label;
    const s=document.createElement('span'); s.className='ai-mode-sub'; s.textContent=sub;
    b.appendChild(l); b.appendChild(s);
    if (m==='managed') b.disabled=true;
    b.onclick=()=>{ if (b.disabled) return; selectedMode=m; modeSeg.querySelectorAll('.ai-mode-btn').forEach((x)=>x.classList.remove('on')); b.classList.add('on'); syncApiSection(); };
    modeSeg.appendChild(b);
  });
  card.appendChild(modeSeg);

  // API SECTION — visible only when selected mode === 'api'
  const apiSection=document.createElement('div'); apiSection.id='aiApiSection'; apiSection.className='ai-api-section';

  const pRow=document.createElement('div'); pRow.className='settings-field';
  const pLab=document.createElement('label'); pLab.textContent=t('ผู้ให้บริการ');
  const pSel=document.createElement('select'); pSel.id='aiProviderSel'; pSel.className='ai-sel';
  [['anthropic','Anthropic (Claude)'],['zai','Z.ai (GLM)']].forEach(([v, l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; pSel.appendChild(o); });
  pSel.value = (cfg.provider==='zai') ? 'zai' : 'anthropic';
  pRow.appendChild(pLab); pRow.appendChild(pSel); apiSection.appendChild(pRow);

  const kRow=document.createElement('div'); kRow.className='settings-field';
  const kLab=document.createElement('label'); kLab.textContent=t('API key');
  const kWrap=document.createElement('div'); kWrap.className='ai-key-wrap';
  const kInput=document.createElement('input'); kInput.id='aiKeyInput'; kInput.type='password'; kInput.autocomplete='off'; kInput.spellcheck=false;
  const kToggle=document.createElement('button'); kToggle.type='button'; kToggle.id='aiKeyToggle'; kToggle.className='ai-key-toggle'; kToggle.textContent=t('แสดง');
  kToggle.onclick=()=>{ const shown=kInput.type==='text'; kInput.type=shown?'password':'text'; kToggle.textContent=shown?t('แสดง'):t('ซ่อน'); };
  kWrap.appendChild(kInput); kWrap.appendChild(kToggle); kRow.appendChild(kLab); kRow.appendChild(kWrap); apiSection.appendChild(kRow);

  const mRow=document.createElement('div'); mRow.className='settings-field';
  const mLab=document.createElement('label'); mLab.textContent=t('โมเดล');
  const mSel=document.createElement('select'); mSel.id='aiModelSel'; mSel.className='ai-sel';
  mRow.appendChild(mLab); mRow.appendChild(mSel); apiSection.appendChild(mRow);

  const note=document.createElement('p'); note.className='ai-note'; note.textContent=t('🔒 กุญแจถูกเข้ารหัสเก็บในเครื่อง — ไม่ถูกส่งไปที่ไหนนอกจากผู้ให้บริการที่เลือก');
  apiSection.appendChild(note);
  card.appendChild(apiSection);

  // AMBIENT RAG toggle — per-vault on/off (default ON). Applies to CLI + API chat alike.
  const ragRow=document.createElement('div'); ragRow.className='ai-rag-row';
  const ragCk=document.createElement('input'); ragCk.type='checkbox'; ragCk.id='aiRagToggle'; ragCk.checked=vsGet('ragAmbient', true);
  const ragLab=document.createElement('label'); ragLab.setAttribute('for','aiRagToggle'); ragLab.className='ai-rag-lab'; ragLab.textContent=t('ให้ AI อ้างอิงโน้ตของฉันอัตโนมัติ');
  ragRow.appendChild(ragCk); ragRow.appendChild(ragLab); card.appendChild(ragRow);
  const ragHint=document.createElement('p'); ragHint.className='ai-rag-hint'; ragHint.textContent=t('ใช้เนื้อหาโน้ตที่เกี่ยวข้องเป็นบริบทให้ AI โดยอัตโนมัติ (เฉพาะ vault นี้)');
  card.appendChild(ragHint);

  // SEMANTIC search toggle — per-vault on/off (default OFF). Requires a Z.ai key +
  // network calls; the main-side pipeline gates on this flag and degrades with no key.
  const semRow=document.createElement('div'); semRow.className='ai-rag-row';
  const semCk=document.createElement('input'); semCk.type='checkbox'; semCk.id='aiSemanticToggle'; semCk.checked=vsGet('ragSemantic', false);
  const semLab=document.createElement('label'); semLab.setAttribute('for','aiSemanticToggle'); semLab.className='ai-rag-lab'; semLab.textContent=t('ใช้การค้นหาเชิงความหมาย (semantic)');
  semRow.appendChild(semCk); semRow.appendChild(semLab); card.appendChild(semRow);
  const semHint=document.createElement('p'); semHint.className='ai-rag-hint'; semHint.textContent=t('ค้นเจอโน้ตที่เกี่ยวข้องแม้ใช้คำไม่ตรง — ต้องมี API key ของ Z.ai และมีการเรียกเครือข่าย (เฉพาะ vault นี้)');
  card.appendChild(semHint);
  const semWarn=document.createElement('p'); semWarn.id='aiSemanticWarn'; semWarn.className='ai-sem-warn'; semWarn.textContent=t('เปิด semantic ไว้แต่ยังไม่มี API key ของ Z.ai — จะยังไม่ทำงานจนกว่าจะใส่คีย์ที่โหมด API key ด้านบน');
  card.appendChild(semWarn);
  function refreshSemWarn(){ semWarn.hidden = !(semCk.checked && cfg.hasKey && !cfg.hasKey.zai); }
  semCk.onchange=refreshSemWarn;
  refreshSemWarn();

  function rebuildModels(){
    const list=AI_MODELS[pSel.value]||[];
    mSel.innerHTML='';
    list.forEach((id)=>{ const o=document.createElement('option'); o.value=id; o.textContent=id; mSel.appendChild(o); });
    const want=(pSel.value===cfg.provider && list.includes(cfg.model)) ? cfg.model : (list[0]||'');
    if (want) mSel.value=want;
  }
  function syncKeyPlaceholder(){
    const set=!!(cfg.hasKey && cfg.hasKey[pSel.value]);
    kInput.placeholder = set ? t('••• ตั้งค่าไว้แล้ว (ใส่ใหม่เพื่อเปลี่ยน)') : t('วางคีย์ที่นี่');
  }
  function syncApiSection(){ apiSection.style.display=(selectedMode==='api') ? '' : 'none'; }
  rebuildModels(); syncKeyPlaceholder(); syncApiSection();
  pSel.onchange=()=>{ rebuildModels(); syncKeyPlaceholder(); };

  // FOOTER
  const foot=document.createElement('div'); foot.className='settings-actions ai-settings-foot';
  const testBtn=document.createElement('button'); testBtn.type='button'; testBtn.id='aiTestBtn'; testBtn.className='ghost'; testBtn.textContent=t('ทดสอบการเชื่อมต่อ');
  const testRes=document.createElement('span'); testRes.id='aiTestResult'; testRes.className='ai-test-result';
  testBtn.onclick=async ()=>{
    testRes.textContent='…';
    let r;
    try { r=await window.api.aiTestConnection(); } catch (e) { r={ok:false,error:String(e)}; }
    if (r && r.ok) testRes.textContent=t('เชื่อมต่อได้ ✓');
    else testRes.textContent=t('เชื่อมต่อไม่ได้') + ' (' + ((r && (r.status||r.error)) || '') + ')';
  };
  const cancelBtn=document.createElement('button'); cancelBtn.type='button'; cancelBtn.className='ghost'; cancelBtn.textContent=t('ยกเลิก'); cancelBtn.onclick=dismiss;
  const saveBtn=document.createElement('button'); saveBtn.type='button'; saveBtn.id='aiSettingsSave'; saveBtn.className='solid'; saveBtn.textContent=t('บันทึก');
  saveBtn.onclick=async ()=>{
    await window.api.aiSetConfig({ mode:selectedMode, provider:pSel.value, model:mSel.value });
    const kv=kInput.value;
    if (kv && kv.length) await window.api.aiSetKey(pSel.value, kv);
    vsSet('ragAmbient', document.getElementById('aiRagToggle').checked);
    vsSet('ragSemantic', document.getElementById('aiSemanticToggle').checked);
    dismiss();
  };
  foot.appendChild(testBtn); foot.appendChild(testRes); foot.appendChild(cancelBtn); foot.appendChild(saveBtn); card.appendChild(foot);

  ov.appendChild(card); ov.hidden=false;
}

// ---------- Boot ----------
const app = document.getElementById('app');
if (localStorage.getItem('sidebar') === 'collapsed') app.classList.add('sidebar-collapsed');
document.getElementById('sidebarToggle').onclick = () => {
  const collapsed = app.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'open');
};

const appEl = document.getElementById('app');
let termPos = localStorage.getItem('termPos') || 'right';   // 'right' | 'bottom'
let termHidden = localStorage.getItem('termHidden') === '1';
function applyTermLayout() {
  appEl.classList.toggle('term-right', termPos === 'right');
  appEl.classList.toggle('term-bottom', termPos === 'bottom');
  appEl.classList.toggle('term-hidden', termHidden);
  setTimeout(fitTerm, 30);
}
applyTermLayout();
function setTermHidden(v) { termHidden = v; localStorage.setItem('termHidden', v ? '1' : '0'); applyTermLayout(); }
document.getElementById('termToggle').onclick = () => setTermHidden(!termHidden);
document.getElementById('termHideBtn').onclick = () => setTermHidden(true);
(() => {
  const posBtn = document.getElementById('termPosBtn');
  let drag = null;
  posBtn.addEventListener('pointerdown', (e) => { try { posBtn.setPointerCapture(e.pointerId); } catch (_) {} drag = { x: e.clientX, y: e.clientY, moved: false }; });
  posBtn.addEventListener('pointermove', (e) => { if (drag && (Math.abs(e.clientX - drag.x) > 5 || Math.abs(e.clientY - drag.y) > 5)) drag.moved = true; });
  posBtn.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    if (moved) termPos = (e.clientY > window.innerHeight * 0.6) ? 'bottom' : 'right';
    else termPos = (termPos === 'right') ? 'bottom' : 'right';
    localStorage.setItem('termPos', termPos);
    applyTermLayout();
  });
})();

// ---------- Chat send + mode toggle ----------
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
async function sendChat(){
  const msg = chatInput.value.trim(); if (!msg) return;
  const s = activeSession();
  if (isRunning(s.id)) return;
  chatInput.value = ''; chatInput.style.height = 'auto';
  const fullPrompt = buildSessionPrompt(s, msg);
  // AMBIENT RAG: opt-in per vault (default ON). When off, context '' + sources []
  // => composeRagPrompt returns fullPrompt unchanged and no chip renders, i.e. the
  // pre-Phase-5 plain chat. Never let a retrieval error block the send.
  let context = '', sources = [];
  if (vsGet('ragAmbient', true)) {
    try { const r = await window.api.ragContext(msg); if (r) { context = r.context || ''; sources = r.sources || []; } } catch (_) {}
  }
  const finalPrompt = composeRagPrompt(fullPrompt, context);
  beginAiTurn(msg, sources);
  const model = 'zai-coding-plan/' + s.model;
  window.api.runEngine({ engine: s.engine, model: (s.engine === 'glm' ? model : ''), prompt: finalPrompt, runId: s.id });
}
// the single #chatSend button reflects the ACTIVE session: SEND when idle, STOP when running.
function updateSendButton(){
  const s = activeSession(); if (!s) return;
  const running = isRunning(s.id);
  chatSend.classList.toggle('is-stop', running);
  chatSend.innerHTML = icoSvg(running ? 'stop' : 'send', 'sm');
  chatSend.title = running ? t('หยุดการตอบ') : t('ส่ง');
}
chatSend.onclick = () => {
  const s = activeSession();
  if (isRunning(s.id)) { window.api.stopEngine(s.id); return; }   // STOP, don't send
  sendChat();
};
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(100, chatInput.scrollHeight) + 'px'; });
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });

const rightEl = document.getElementById('right');
let rightMode = localStorage.getItem('rightMode') || 'chat';   // 'chat' | 'term'
function applyRightMode(){
  rightEl.classList.toggle('chat-mode', rightMode === 'chat');
  rightEl.classList.toggle('term-mode', rightMode === 'term');
  if (rightMode === 'term') setTimeout(fitTerm, 30);
}
applyRightMode();
loadSessions();
syncEngineFromSession();
renderSessions();
document.getElementById('chatClearBtn').onclick = () => { const s = activeSession(); s.messages = []; persistSessions(); renderChat(); };

const savedTheme = localStorage.getItem('theme');
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
const theme = savedTheme || (prefersDark ? 'dark' : 'light');
applyTheme(theme);
updateHint();
applyStaticI18n();

// ---------- Vault chip (current vault selector) ----------
function closeVaultMenu(){ const m = document.getElementById('vaultMenu'); if (m) m.remove(); document.removeEventListener('mousedown', onVaultMenuOutside, true); }
function onVaultMenuOutside(e){ const m = document.getElementById('vaultMenu'); if (m && !m.contains(e.target) && e.target.id !== 'vaultChip' && !document.getElementById('vaultChip').contains(e.target)) closeVaultMenu(); }
async function openVaultMenu(anchor){
  closeVaultMenu();
  let info = { current: null, recents: [] };
  try { info = await window.api.vaultList(); } catch (_) {}
  const menu = document.createElement('div'); menu.className = 'vault-menu'; menu.id = 'vaultMenu';

  if (info.recents && info.recents.length) {
    const hd = document.createElement('div'); hd.className = 'vm-hd'; hd.textContent = t('Vault'); menu.appendChild(hd);
    info.recents.forEach((r) => {
      const isCurrent = info.current && r.path === info.current.path;
      const row = document.createElement('div'); row.className = 'vm-row' + (isCurrent ? ' is-current' : '');
      const main = document.createElement('div'); main.className = 'vm-main';
      const nm = document.createElement('div'); nm.className = 'vm-nm'; nm.textContent = r.name; main.appendChild(nm);
      const pt = document.createElement('div'); pt.className = 'vm-path'; pt.textContent = r.path; main.appendChild(pt);
      row.appendChild(main);
      if (isCurrent) {
        const ck = document.createElement('span'); ck.className = 'vm-check'; ck.innerHTML = icoSvg('check', 'sm'); row.appendChild(ck);
      } else {
        row.onclick = async () => { closeVaultMenu(); const res = await window.api.vaultSwitch(r.path); if (res && res.ok) location.reload(); };
      }
      menu.appendChild(row);
    });
    const sep = document.createElement('div'); sep.className = 'vm-sep'; menu.appendChild(sep);
  }

  const open = document.createElement('div'); open.className = 'vm-act'; open.textContent = '📂 ' + t('เปิดโฟลเดอร์เป็น vault…');
  open.onclick = async () => { closeVaultMenu(); const r = await window.api.vaultOpen(); if (r && r.ok) location.reload(); };
  menu.appendChild(open);

  const create = document.createElement('div'); create.className = 'vm-act'; create.textContent = '＋ ' + t('สร้าง vault ใหม่…');
  create.onclick = async () => { closeVaultMenu(); const r = await window.api.vaultCreate(); if (r && r.ok) location.reload(); };
  menu.appendChild(create);

  document.body.appendChild(menu);
  const rc = anchor.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - rc.top + 4) + 'px';   // opens upward, anchored to the top edge of the chip
  menu.style.left = Math.max(8, Math.min(rc.left, window.innerWidth - 240)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', onVaultMenuOutside, true), 0);
}
async function initVaultChip(){
  const chip = document.getElementById('vaultChip');
  if (!chip) return;
  const nm = chip.querySelector('.vault-nm');
  try { const info = await window.api.vaultList(); if (nm && info && info.current && info.current.name) nm.textContent = info.current.name; }
  catch (_) {}
  chip.addEventListener('click', (e) => { e.stopPropagation(); openVaultMenu(chip); });
}
initVaultChip();

(async () => {
  let lastOpen = vsGet('lastOpen', null);
  const lastNote = vsGet('lastNote', 'ระบบไต.md');
  await refreshList(lastOpen && lastOpen.type === 'note' && lastOpen.name ? lastOpen.name : lastNote);
  if (lastOpen && lastOpen.type === 'pdf' && lastOpen.name) {
    const exists = Array.from(document.querySelectorAll('.pdf-item')).some((el) => el.dataset.pdf === lastOpen.name);
    if (exists) await openPdf(lastOpen.name);
  }
})();

// ---------- Auto-link (ร้อยเชือก) — user-triggered; AI suggests [[links]] to existing notes ----------
let autolinkAcc = '';
let autolinkRunning = false;
let autolinkNameSet = new Set();
function autolinkBarEl(){ return document.getElementById('autolinkBar'); }
function clearAutolink(){ if (typeof clearPhraseHighlight === 'function') clearPhraseHighlight(); const b = autolinkBarEl(); if (b) { b.hidden = true; b.innerHTML = ''; } }

async function runAutoLink(){
  if (!currentNote || autolinkRunning) return;
  await save();                                       // flush latest edits so the AI sees them
  const body = getBody();
  const res = await window.api.listNotes();
  const notes = Array.isArray(res) ? res : (res.notes || []);
  const curBase = currentNote.replace(/\.md$/i, '').split('/').pop().toLowerCase();
  const names = [...new Set(notes.map((n) => n.replace(/\.md$/i, '').split('/').pop()))].filter((b) => b && b.toLowerCase() !== curBase);
  if (!names.length) { const bar = autolinkBarEl(); if (bar) { bar.innerHTML = '<div class="al-empty">' + t('ยังไม่มีโน้ตอื่นให้ลิงก์') + '</div>'; bar.hidden = false; setTimeout(clearAutolink, 2400); } return; }
  autolinkNameSet = new Set(names.map((n) => n.toLowerCase()));
  autolinkAcc = ''; autolinkRunning = true;
  const btn = document.getElementById('autolinkBtn'); if (btn) { btn.disabled = true; btn.innerHTML = icoSvg('refresh'); btn.title = t('กำลังหา…'); }
  const bar = autolinkBarEl(); if (bar) { bar.innerHTML = '<div class="al-empty">' + t('AI กำลังหาจุดที่ลิงก์ได้…') + '</div>'; bar.hidden = false; }
  const prompt =
    'คุณคือผู้ช่วยจัดระเบียบโน้ต งานเดียว: หาว่าในเนื้อโน้ตด้านล่างมีคำ/วลีใดที่สื่อถึง "โน้ตที่มีอยู่แล้ว" และควรทำเป็นลิงก์\n' +
    'รายชื่อโน้ตที่มีอยู่ (ใช้ได้เฉพาะจากรายการนี้เท่านั้น): ' + names.join(', ') + '\n\n' +
    'เนื้อโน้ตปัจจุบัน:\n---\n' + body + '\n---\n\n' +
    'กติกา:\n' +
    '- ตอบเป็น JSON array อย่างเดียว ห้ามมีข้อความอื่นหรือ markdown fence\n' +
    '- แต่ละอัน: {"target":"<ชื่อโน้ตจากรายการ>","phrase":"<วลีที่ปรากฏจริงในเนื้อโน้ต แบบตรงตัว>","context":"<ประโยคสั้นรอบวลี>"}\n' +
    '- phrase ต้องคัดลอกจากเนื้อโน้ตแบบตรงตัว (จะได้หาเจอ)\n' +
    '- ห้ามเสนอคำที่เป็น [[...]] อยู่แล้ว · ห้ามแต่งชื่อโน้ตใหม่ · ถ้าไม่มีให้ตอบ []\n' +
    '- สูงสุด 8 รายการ ที่เกี่ยวข้องจริง ๆ';
  const model = 'zai-coding-plan/' + currentModel;
  window.api.runEngine({ engine: currentEngine, model: (currentEngine === 'glm' ? model : ''), prompt, runId: 'autolink' });
}

window.api.onEngineOutput((p) => { if (p && p.runId === 'autolink') autolinkAcc += stripAnsi(p.data || ''); });
window.api.onEngineDone((p) => { if (p && p.runId === 'autolink') finishAutoLink(); });

function extractJsonArray(text){
  const t = cleanChatText(text || '');
  const i = t.indexOf('['); const j = t.lastIndexOf(']');
  if (i < 0 || j < 0 || j < i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch (_) { return null; }
}
function finishAutoLink(){
  autolinkRunning = false;
  const btn = document.getElementById('autolinkBtn'); if (btn) { btn.disabled = false; btn.innerHTML = icoSvg('thread'); btn.title = t('ร้อยเชือก — AI แนะนำลิงก์ไปโน้ตอื่น'); }
  const arr = extractJsonArray(autolinkAcc);
  const body = getBody();
  const seen = new Set();
  const valid = (Array.isArray(arr) ? arr : []).filter((s) => {
    if (!s || !s.target || !s.phrase) return false;
    if (!autolinkNameSet.has(String(s.target).toLowerCase())) return false;   // target must be a real note
    if (!body.includes(s.phrase)) return false;                               // phrase must appear in the note
    if (body.includes('[[' + s.target + ']]')) return false;                  // already linked to this note
    const k = String(s.target).toLowerCase(); if (seen.has(k)) return false; seen.add(k);
    return true;
  });
  renderAutolinkBar(valid);
}

function renderAutolinkBar(list){
  const bar = autolinkBarEl(); if (!bar) return;
  bar.innerHTML = '';
  if (!list.length){ bar.innerHTML = '<div class="al-empty">' + t('ไม่พบจุดที่ควรลิงก์เพิ่ม') + '</div>'; bar.hidden = false; setTimeout(clearAutolink, 2600); return; }
  const hd = document.createElement('div'); hd.className = 'al-hd';
  hd.innerHTML = t('พบ <b>') + list.length + t('</b> จุดที่ลิงก์ได้ · กดเครื่องหมายถูกเพื่อแทรก');
  const x = document.createElement('button'); x.className = 'al-x'; x.innerHTML = icoSvg('x','xs'); x.title = t('ปิด'); x.onclick = clearAutolink;
  hd.appendChild(x); bar.appendChild(hd);
  list.forEach((s) => {
    const row = document.createElement('div'); row.className = 'al-row'; row._sug = s;
    row.addEventListener('mouseenter', () => highlightPhrase(s.phrase));
    row.addEventListener('mouseleave', clearPhraseHighlight);
    const lk = document.createElement('span'); lk.className = 'al-lk'; lk.textContent = '[[' + s.target + ']]';
    const ctx = document.createElement('span'); ctx.className = 'al-ctx'; ctx.textContent = s.context || ('…' + s.phrase + '…');
    const no = document.createElement('span'); no.className = 'al-no'; no.innerHTML = icoSvg('x','xs');
    const yes = document.createElement('span'); yes.className = 'al-yes'; yes.innerHTML = icoSvg('check','xs');
    no.onclick = () => { row.remove(); if (!bar.querySelector('.al-row')) clearAutolink(); };
    yes.onclick = async () => { await insertLinks([s]); row.remove(); if (!bar.querySelector('.al-row')) clearAutolink(); };
    row.appendChild(lk); row.appendChild(ctx); row.appendChild(no); row.appendChild(yes);
    bar.appendChild(row);
  });
  const foot = document.createElement('div'); foot.className = 'al-foot';
  const all = document.createElement('button'); all.className = 'al-all'; all.innerHTML = icoSvg('check','xs'); all.appendChild(document.createTextNode(' ' + t('แทรกทั้งหมด')));
  all.onclick = async () => { const sugs = [...bar.querySelectorAll('.al-row')].map((r) => r._sug); await insertLinks(sugs); clearAutolink(); };
  foot.appendChild(all); bar.appendChild(foot);
  bar.hidden = false;
  flashAllPhrases(list.map((s) => s.phrase));
}

async function insertLinks(sugs){
  if (!sugs || !sugs.length || !currentNote) return;
  let body = getBody();
  for (const s of sugs){
    const link = '[[' + s.target + ']]';
    if (body.includes(link)) continue;
    const idx = body.indexOf(s.phrase);
    if (idx < 0) continue;
    body = body.slice(0, idx) + link + body.slice(idx + s.phrase.length);
  }
  const full = serializeFrontmatter(currentAttrs, body);
  await window.api.saveNote(currentNote, full);
  await loadEditor(body);
  setDirty(false);
  if (typeof refreshBacklinks === 'function') refreshBacklinks(currentNote);
}

document.getElementById('autolinkBtn').onclick = runAutoLink;

// ---------- Link picker — suggest existing similar notes before creating a link (กันโน้ตซ้ำ) ----------
function closeLinkPicker(){ const m = document.getElementById('linkPicker'); if (m) m.remove(); document.removeEventListener('mousedown', _lpOutside, true); }
function _lpOutside(e){ const m = document.getElementById('linkPicker'); if (m && !m.contains(e.target)) closeLinkPicker(); }

async function openLinkPicker(term, anchor){
  term = (term || '').trim(); if (!term || !currentNote) return;
  closeLinkPicker();
  const res = await window.api.listNotes();
  const notes = Array.isArray(res) ? res : (res.notes || []);
  const curBase = currentNote.replace(/\.md$/i, '').split('/').pop().toLowerCase();
  const bases = [...new Set(notes.map((n) => n.replace(/\.md$/i, '').split('/').pop()))].filter((b) => b && b.toLowerCase() !== curBase);
  const scored = bases.map((b) => ({ name: b, s: _sim(term, b) })).filter((x) => x.s >= 0.42).sort((a, b) => b.s - a.s).slice(0, 6);
  const exact = scored.find((x) => x.s >= 0.999);

  const menu = document.createElement('div'); menu.className = 'db-menu link-picker'; menu.id = 'linkPicker';
  const hd = document.createElement('div'); hd.className = 'lp-hd'; hd.textContent = t('ลิงก์ “') + term + t('” ไปยัง:'); menu.appendChild(hd);
  if (scored.length){
    const sub = document.createElement('div'); sub.className = 'lp-sub'; sub.textContent = exact ? t('มีโน้ตนี้อยู่แล้ว — ลิงก์ไปเลย (ไม่ต้องสร้างซ้ำ)') : t('โน้ตเดิมที่ใกล้เคียง — ลิงก์ไปอันเดิมไหม?');
    menu.appendChild(sub);
    scored.forEach((x) => {
      const it = document.createElement('div'); it.className = 'db-mi lp-item';
      const nm = document.createElement('span'); nm.className = 'lp-nm'; nm.textContent = '[[' + x.name + ']]';
      const bd = document.createElement('span'); bd.className = 'lp-badge' + (x.s >= 0.999 ? ' exact' : ''); bd.textContent = x.s >= 0.999 ? t('ตรงกัน') : (t('ใกล้เคียง ') + Math.round(x.s * 100) + '%');
      it.appendChild(nm); it.appendChild(bd);
      it.onclick = () => { closeLinkPicker(); insertOneLink(term, x.name, false); };
      menu.appendChild(it);
    });
  } else {
    const none = document.createElement('div'); none.className = 'lp-sub'; none.textContent = t('ไม่พบโน้ตเดิมที่ใกล้เคียง');
    menu.appendChild(none);
  }
  const add = document.createElement('div'); add.className = 'db-mi lp-add'; add.textContent = t('＋ สร้างโน้ตใหม่ “') + term + t('” แล้วลิงก์');
  add.onclick = () => { closeLinkPicker(); insertOneLink(term, term, true); };
  menu.appendChild(add);

  document.body.appendChild(menu);
  const r = anchor ? anchor.getBoundingClientRect() : { bottom: 200, top: 200, left: 200 };
  const mh = menu.offsetHeight || 170;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 270)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', _lpOutside, true), 0);
}

async function insertOneLink(term, targetName, createNew){
  if (!currentNote) return;
  if (createNew){ const r = await window.api.createNote(targetName); if (r && r.error && r.error !== 'exists') { alert(t('สร้างโน้ตไม่ได้')); return; } }
  let body = getBody();
  const link = '[[' + targetName + ']]';
  const idx = body.indexOf(term);
  if (idx >= 0 && !body.includes(link)) body = body.slice(0, idx) + link + body.slice(idx + term.length);
  const full = serializeFrontmatter(currentAttrs, body);
  await window.api.saveNote(currentNote, full);
  await refreshList(currentNote);
  if (typeof refreshBacklinks === 'function') refreshBacklinks(currentNote);
  const ab = document.getElementById('actionBar'); if (ab) ab.hidden = true;
}

// ========================================================================
// Side chat — small floating quick-chat windows, each its own AI session
// (own runId, runs concurrently with the tabbed sessions; not persisted)
// ========================================================================
let sideChats = [];
let sideZ = 60;
function sideById(id){ return sideChats.find((s) => s.id === id) || null; }

function openSideChat(seed){
  const id = 'side' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  const sc = { id, engine: currentEngine, model: currentModel, scope: (currentNote ? 'note' : 'free'), messages: [], running: false };

  const card = document.createElement('div'); card.className = 'sidechat'; card.style.zIndex = ++sideZ;
  const head = document.createElement('div'); head.className = 'sc-head';
  const title = document.createElement('span'); title.className = 'sc-title'; title.innerHTML = icoSvg('chat','sm'); title.appendChild(document.createTextNode(' ' + t('แชตลอย')));
  const eng = document.createElement('select'); eng.className = 'sc-eng'; eng.title = 'engine';
  [['glm','GLM'],['claude','Claude']].forEach(([v,l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (sc.engine === v) o.selected = true; eng.appendChild(o); });
  eng.onchange = () => { sc.engine = eng.value; renderSideMsgs(sc); };
  eng.onmousedown = (e) => e.stopPropagation();
  const ctx = document.createElement('button'); ctx.className = 'sc-ctx' + (sc.scope === 'note' ? ' on' : ''); ctx.innerHTML = icoSvg('clip', 'sm'); ctx.title = t('อ้างอิงโน้ตที่เปิดอยู่');
  ctx.onmousedown = (e) => e.stopPropagation();
  ctx.onclick = (e) => { e.stopPropagation(); sc.scope = sc.scope === 'note' ? 'free' : 'note'; ctx.classList.toggle('on', sc.scope === 'note'); if (!sc.messages.length) renderSideMsgs(sc); };
  const x = document.createElement('button'); x.className = 'sc-x'; x.innerHTML = icoSvg('x','sm'); x.title = t('ปิด');
  x.onmousedown = (e) => e.stopPropagation();
  x.onclick = (e) => { e.stopPropagation(); closeSideChat(sc); };
  head.appendChild(title); head.appendChild(eng); head.appendChild(ctx); head.appendChild(x);
  card.appendChild(head);

  const msgs = document.createElement('div'); msgs.className = 'sc-msgs'; card.appendChild(msgs);
  const row = document.createElement('div'); row.className = 'sc-inputrow';
  const ta = document.createElement('textarea'); ta.className = 'sc-input'; ta.rows = 1; ta.placeholder = t('ถามเร็ว ๆ… (Enter ส่ง)');
  const send = document.createElement('button'); send.className = 'sc-send'; send.innerHTML = icoSvg('send','sm'); send.title = t('ส่ง');
  row.appendChild(ta); row.appendChild(send); card.appendChild(row);

  document.body.appendChild(card);
  const n = sideChats.length;
  card.style.left = Math.max(12, window.innerWidth - 392 - 24 - (n * 26) % 130) + 'px';
  card.style.top = (96 + (n * 26) % 130) + 'px';

  sc.els = { card, msgs, input: ta };
  sideChats.push(sc);
  makeSideDraggable(card, head);
  card.addEventListener('mousedown', () => { card.style.zIndex = ++sideZ; });
  send.onclick = () => sideSend(sc);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sideSend(sc); } });
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(90, ta.scrollHeight) + 'px'; });
  if (seed) ta.value = seed;
  renderSideMsgs(sc);
  setTimeout(() => ta.focus(), 0);
}
function closeSideChat(sc){ if (sc.els && sc.els.card) sc.els.card.remove(); sideChats = sideChats.filter((x) => x !== sc); }

function renderSideMsgs(sc){
  const box = sc.els.msgs; box.innerHTML = ''; sc._live = null;
  if (!sc.messages.length){ const h = document.createElement('div'); h.className = 'sc-hint'; h.innerHTML = icoSvg('clip', 'sm'); h.appendChild(document.createTextNode(' ' + (sc.scope === 'note' ? t('ถามเกี่ยวกับโน้ตนี้ได้เลย') : t('ถามอะไรก็ได้ (แชตนี้แยกจากแท็บหลัก)')))); box.appendChild(h); }
  sc.messages.forEach((m, i) => {
    const wrap = document.createElement('div'); wrap.className = 'm-wrap ' + m.role;
    if (m.role === 'ai'){ const who = document.createElement('div'); who.className = 'who'; who.textContent = sc.engine === 'glm' ? 'GLM' : 'Claude'; wrap.appendChild(who); }
    const b = document.createElement('div'); b.className = 'm ' + m.role;
    const running = sc.running && i === sc.messages.length - 1 && m.role === 'ai';
    if (running && !m.text){ b.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>'; sc._live = b; }
    else { b.textContent = m.text; if (running) sc._live = b; }
    wrap.appendChild(b); box.appendChild(wrap);
  });
  box.scrollTop = box.scrollHeight;
}
function sideSend(sc){
  const text = sc.els.input.value.trim(); if (!text || sc.running) return;
  sc.els.input.value = ''; sc.els.input.style.height = 'auto';
  sc.messages.push({ role: 'user', text });
  sc.messages.push({ role: 'ai', text: '', _acc: '' });
  sc.running = true;
  renderSideMsgs(sc);
  const prompt = buildSessionPrompt(sc, text);           // reuse the session context builder (scope note/free + history)
  const model = 'zai-coding-plan/' + sc.model;
  window.api.runEngine({ engine: sc.engine, model: (sc.engine === 'glm' ? model : ''), prompt, runId: sc.id });
}
// streaming + done for side chats (their runIds aren't in `sessions`, so the main handlers ignore them)
window.api.onEngineOutput((p) => {
  const sc = p && sideById(p.runId); if (!sc) return;
  const last = sc.messages[sc.messages.length - 1]; if (!last || last.role !== 'ai') return;
  last._acc = (last._acc || '') + stripAnsi(p.data || '');
  const shown = cleanChatText(last._acc).trim();
  if (shown){ last.text = shown; if (sc._live){ sc._live.textContent = shown; sc.els.msgs.scrollTop = sc.els.msgs.scrollHeight; } }
});
window.api.onEngineDone((p) => {
  const sc = p && sideById(p.runId); if (!sc) return;
  const last = sc.messages[sc.messages.length - 1];
  if (last && last.role === 'ai'){ last.text = cleanChatText(last._acc || '').trim() || t('(เสร็จ · ไม่มีข้อความตอบกลับ)'); delete last._acc; }
  sc.running = false; renderSideMsgs(sc);
});
function makeSideDraggable(card, handle){
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, select')) return;
    e.preventDefault();
    const r = card.getBoundingClientRect(); const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const move = (ev) => { card.style.left = Math.max(4, Math.min(window.innerWidth - 60, ev.clientX - ox)) + 'px'; card.style.top = Math.max(4, Math.min(window.innerHeight - 40, ev.clientY - oy)) + 'px'; };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
}
(function wireSideChat(){ const b = document.getElementById('sideChatBtn'); if (b) b.onclick = () => openSideChat(); })();
// ⌘J / Ctrl+J — open a side chat (seeded with the current selection, if any)
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'j' || e.key === 'J')){
    e.preventDefault();
    const sel = (typeof currentSelection === 'function' ? currentSelection() : '');
    openSideChat(sel ? 'เกี่ยวกับ "' + sel + '" — ' : '');
  }
});

// ========================================================================
// DASHBOARD — a central canvas (2 screens tall) of DB visualization cards
// ========================================================================
const DASH_VIZ = [
  ['stat', 'hash', 'ตัวเลขสรุป'],
  ['chart', 'chart', 'ชาร์ตแท่ง'],
  ['board', 'board', 'บอร์ดย่อ'],
  ['table', 'table', 'ตารางย่อ'],
  ['list', 'list', 'รายการ'],
  ['calendar', 'cal', 'ปฏิทินย่อ'],
];
const DASH_VIZ_LABEL = DASH_VIZ.reduce((a, [k, i, l]) => (a[k] = l, a), {});
const DASH_VIZ_ICON = DASH_VIZ.reduce((a, [k, i]) => (a[k] = i, a), {});
function loadDashboards(){ const d = vsGet('dashboards', null); return Array.isArray(d) ? d : null; }
function saveDashboards(d){ vsSet('dashboards', d); }
function ensureDashboards(){
  let d = loadDashboards();
  if (!d || !d.length){
    let old = vsGet('dashWidgets', []);
    d = [{ id: 'dash1', name: 'แดชบอร์ด 1', widgets: Array.isArray(old) ? old : [] }];
    saveDashboards(d);
  }
  return d;
}
function dashSeq(){ let n = vsGet('dashSeq', 1) || 1; n++; vsSet('dashSeq', n); return n; }
function currentDashId(){ const d = ensureDashboards(); const id = vsGet('curDashId', null); return (id && d.some((x) => x.id === id)) ? id : d[0].id; }
function setCurrentDashId(id){ vsSet('curDashId', id); }
function currentDashboard(){ const d = ensureDashboards(); return d.find((x) => x.id === currentDashId()) || d[0]; }
function loadDashWidgets(){ const b = currentDashboard(); return (b && Array.isArray(b.widgets)) ? b.widgets : []; }
function saveDashWidgets(w){ const d = ensureDashboards(); const b = d.find((x) => x.id === currentDashId()) || d[0]; if (b){ b.widgets = w; saveDashboards(d); } }
function createDashboard(name){ const d = ensureDashboards(); const id = 'dash' + Math.round(performance.now()) + '_' + dashSeq(); d.push({ id, name: name || ('แดชบอร์ด ' + (d.length + 1)), widgets: [] }); saveDashboards(d); setCurrentDashId(id); return id; }
function renameDashboard(id, name){ const d = ensureDashboards(); const b = d.find((x) => x.id === id); if (b && name){ b.name = name; saveDashboards(d); } }
function deleteDashboard(id){ let d = ensureDashboards(); if (d.length <= 1) return; d = d.filter((x) => x.id !== id); saveDashboards(d); if (currentDashId() === id) setCurrentDashId(d[0].id); }

async function renderDash(){
  const host = document.getElementById('dashView'); if (!host) return;
  const widgets = loadDashWidgets();
  const dbs = await window.api.dbList();
  host.innerHTML = '';

  const head = document.createElement('div'); head.className = 'view-head';
  const title = document.createElement('span'); title.className = 'vh-title'; title.textContent = (typeof currentDashboard === 'function' ? currentDashboard().name : t('แดชบอร์ด'));
  const sp = document.createElement('span'); sp.className = 'vh-sp';
  const add = document.createElement('button'); add.className = 'solid sm'; add.textContent = t('＋ เพิ่มการ์ด');
  add.onclick = (e) => { e.stopPropagation(); openDashAddMenu(add, dbs); };
  sp.appendChild(add);
  head.appendChild(title); head.appendChild(sp); host.appendChild(head);

  const scroll = document.createElement('div'); scroll.className = 'dash-scroll';
  const canvas = document.createElement('div'); canvas.className = 'dash-canvas';
  if (!widgets.length){
    const empty = document.createElement('div'); empty.className = 'dash-empty';
    empty.innerHTML = '<b>' + t('ยังไม่มีการ์ด') + '</b><br>' + t('กด “＋ เพิ่มการ์ด” เพื่อเลือกฐานข้อมูลและรูปแบบการแสดงผล');
    canvas.appendChild(empty);
  }
  // load each referenced DB once
  const need = [...new Set(widgets.map((w) => w.dbId))];
  const data = {};
  for (const id of need){ try { data[id] = await window.api.dbRead(id); } catch (_) { data[id] = null; } }
  widgets.forEach((w, i) => canvas.appendChild(buildDashCard(w, i, data[w.dbId], widgets)));
  scroll.appendChild(canvas); host.appendChild(scroll);
}

function buildDashCard(w, idx, db, widgets){
  const card = document.createElement('div'); card.className = 'dash-card span-' + (w.span || 1) + (w.tall ? ' tall' : '');
  const h = document.createElement('div'); h.className = 'dash-h';
  const ttl = document.createElement('span'); ttl.className = 'dash-t';
    if (db){ ttl.innerHTML = icoSvg('db', 'xs'); ttl.appendChild(document.createTextNode(' ' + (w.title || db.name))); }
    else { ttl.textContent = t('DB หาย'); }
  ttl.title = t('เปิดฐานข้อมูลนี้');
  ttl.onclick = () => { if (!db) return; dbOpenId = db.id; dbCache = null; setMainView('table'); };
    const kind = document.createElement('span'); kind.className = 'dash-kind'; kind.innerHTML = icoSvg(DASH_VIZ_ICON[w.viz] || 'table', 'xs'); kind.appendChild(document.createTextNode(' ' + t(DASH_VIZ_LABEL[w.viz] || w.viz)));
  const dots = document.createElement('button'); dots.className = 'dash-dots'; dots.textContent = '⋯';
  dots.onclick = (e) => { e.stopPropagation(); openDashCardMenu(dots, idx, widgets); };
  h.appendChild(ttl); h.appendChild(kind); h.appendChild(dots); card.appendChild(h);
  const body = document.createElement('div'); body.className = 'dash-body'; card.appendChild(body);
  if (!db){ body.innerHTML = '<div class="dash-warn">' + t('ฐานข้อมูลถูกลบไปแล้ว') + '</div>'; return card; }
  try { renderDashViz(body, db, w); } catch (_) { body.innerHTML = '<div class="dash-warn">' + t('แสดงผลไม่ได้') + '</div>'; }
  return card;
}

// ---- read-only mini visualizations ----
function dashGroups(db, colId){
  const col = (db.columns || []).find((c) => c.id === colId) || firstColOfType(db, 'select');
  if (!col) return null;
  const groups = [...(col.options || []).map((o) => ({ key: o.name, color: o.color })), { key: '', color: 'gray', empty: true }];
  return { col, groups: groups.map((g) => Object.assign(g, { rows: (db.rows || []).filter((r) => (r[col.id] || '') === g.key) })).filter((g) => !g.empty || g.rows.length) };
}
function renderDashViz(body, db, w){
  const rows = db.rows || [];
  if (w.viz === 'stat'){
    const wrap = document.createElement('div'); wrap.className = 'dash-stat';
    const big = document.createElement('div'); big.className = 'ds-big'; big.textContent = rows.length;
    const lab = document.createElement('div'); lab.className = 'ds-lab'; lab.textContent = t('รายการทั้งหมด');
    wrap.appendChild(big); wrap.appendChild(lab);
    const g = dashGroups(db, w.groupBy);
    if (g){
      const pills = document.createElement('div'); pills.className = 'ds-pills';
      g.groups.forEach((gr) => {
        const p = document.createElement('span'); p.className = 'db-pill sm'; const c = DB_COLORS[gr.color || 'gray'];
        p.style.background = c[0]; p.style.color = c[1]; p.textContent = (gr.empty ? t('ไม่ระบุ') : gr.key) + ' · ' + gr.rows.length;
        pills.appendChild(p);
      });
      wrap.appendChild(pills);
    }
    body.appendChild(wrap); return;
  }
  if (w.viz === 'chart'){
    const g = dashGroups(db, w.groupBy);
    if (!g){ body.innerHTML = '<div class="dash-warn">' + t('ต้องมีคอลัมน์แบบ “เลือก”') + '</div>'; return; }
    const max = Math.max(1, ...g.groups.map((x) => x.rows.length));
    const chart = document.createElement('div'); chart.className = 'dash-chart';
    g.groups.forEach((gr) => {
      const r = document.createElement('div'); r.className = 'db-chart-row';
      const lab = document.createElement('span'); lab.className = 'db-chart-lab'; lab.textContent = gr.empty ? t('ไม่ระบุ') : gr.key;
      const track = document.createElement('div'); track.className = 'db-chart-track';
      const fill = document.createElement('div'); fill.className = 'db-chart-fill';
      const c = DB_COLORS[gr.color || 'gray']; fill.style.background = c[1]; fill.style.width = Math.round(gr.rows.length / max * 100) + '%';
      track.appendChild(fill);
      const val = document.createElement('span'); val.className = 'db-chart-val'; val.textContent = gr.rows.length;
      r.appendChild(lab); r.appendChild(track); r.appendChild(val); chart.appendChild(r);
    });
    body.appendChild(chart); return;
  }
  if (w.viz === 'board'){
    const g = dashGroups(db, w.groupBy);
    if (!g){ body.innerHTML = '<div class="dash-warn">' + t('ต้องมีคอลัมน์แบบ “เลือก”') + '</div>'; return; }
    const lanes = document.createElement('div'); lanes.className = 'dash-lanes';
    g.groups.forEach((gr) => {
      const lane = document.createElement('div'); lane.className = 'dash-lane';
      const lh = document.createElement('div'); lh.className = 'dash-lane-h';
      const p = document.createElement('span'); p.className = 'db-pill sm'; const c = DB_COLORS[gr.color || 'gray'];
      p.style.background = c[0]; p.style.color = c[1]; p.textContent = gr.empty ? t('ไม่ระบุ') : gr.key;
      const n = document.createElement('span'); n.className = 'dash-lane-n'; n.textContent = gr.rows.length;
      lh.appendChild(p); lh.appendChild(n); lane.appendChild(lh);
      gr.rows.slice(0, 4).forEach((r) => { const it = document.createElement('div'); it.className = 'dash-mini-card'; it.textContent = rowTitle(db, r); lane.appendChild(it); });
      if (gr.rows.length > 4){ const m = document.createElement('div'); m.className = 'dash-more'; m.textContent = '+' + (gr.rows.length - 4) + t(' รายการ'); lane.appendChild(m); }
      lanes.appendChild(lane);
    });
    body.appendChild(lanes); return;
  }
  if (w.viz === 'table'){
    const cols = (db.columns || []).slice(0, 4);
    const tbl = document.createElement('table'); tbl.className = 'dash-table';
    const thead = document.createElement('thead'); const tr = document.createElement('tr');
    cols.forEach((c) => { const th = document.createElement('th'); th.textContent = c.name; tr.appendChild(th); });
    thead.appendChild(tr); tbl.appendChild(thead);
    const tb = document.createElement('tbody');
    rows.slice(0, 8).forEach((r) => {
      const trr = document.createElement('tr');
      cols.forEach((c) => {
        const td = document.createElement('td');
        const chip = fieldChip(db, c, r);
        if (c.type === 'select' && chip) td.appendChild(chip);
        else if (c.type === 'checkbox') { td.innerHTML = icoSvg(r[c.id] ? 'checkbox' : 'x', 'xs'); }
        else if (c.type === 'relation') td.textContent = (Array.isArray(r[c.id]) ? r[c.id] : []).map((id) => relRowTitle(c.relDb, id)).join(', ');
        else td.textContent = r[c.id] == null ? '' : String(r[c.id]);
        trr.appendChild(td);
      });
      tb.appendChild(trr);
    });
    tbl.appendChild(tb); body.appendChild(tbl);
    if (rows.length > 8){ const m = document.createElement('div'); m.className = 'dash-more'; m.textContent = '+' + (rows.length - 8) + t(' แถว'); body.appendChild(m); }
    return;
  }
  if (w.viz === 'list'){
    const ul = document.createElement('div'); ul.className = 'dash-list';
    rows.slice(0, 12).forEach((r) => {
      const it = document.createElement('div'); it.className = 'dash-li';
      const t = document.createElement('span'); t.className = 'dash-li-t'; t.textContent = rowTitle(db, r); it.appendChild(t);
      const sc = firstColOfType(db, 'select'); const chip = sc ? fieldChip(db, sc, r) : null; if (chip) it.appendChild(chip);
      ul.appendChild(it);
    });
    body.appendChild(ul);
    if (rows.length > 12){ const m = document.createElement('div'); m.className = 'dash-more'; m.textContent = '+' + (rows.length - 12) + t(' รายการ'); body.appendChild(m); }
    return;
  }
  if (w.viz === 'calendar'){
    const dcol = firstColOfType(db, 'date');
    if (!dcol){ body.innerHTML = '<div class="dash-warn">' + t('ต้องมีคอลัมน์แบบ “วันที่”') + '</div>'; return; }
    const now = new Date(); const y = now.getFullYear(), m = now.getMonth();
    const wrap = document.createElement('div'); wrap.className = 'dash-cal-wrap';
    const cap = document.createElement('div'); cap.className = 'dash-cal-cap';
    const THM2 = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
    cap.textContent = t(THM2[m]) + ' ' + (uiLang === 'en' ? y : (y + 543));
    wrap.appendChild(cap);
    const grid = document.createElement('div'); grid.className = 'dash-cal';
    ['อา','จ','อ','พ','พฤ','ศ','ส'].forEach((d) => { const e = document.createElement('div'); e.className = 'dash-cal-wd'; e.textContent = t(d); grid.appendChild(e); });
    const startDow = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate(), tt = todayISO();
    for (let i = 0; i < startDow; i++) grid.appendChild(document.createElement('div'));
    for (let d = 1; d <= days; d++){
      const iso = y + '-' + pad2(m + 1) + '-' + pad2(d);
      const cell = document.createElement('div'); cell.className = 'dash-cal-d' + (iso === tt ? ' today' : '');
      cell.textContent = d;
      const n = rows.filter((r) => (r[dcol.id] || '') === iso).length;
      if (n){ cell.classList.add('has'); cell.title = n + t(' รายการ'); const dot = document.createElement('i'); cell.appendChild(dot); }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid); body.appendChild(wrap); return;
  }
  body.innerHTML = '<div class="dash-warn">' + t('ไม่รู้จักรูปแบบนี้') + '</div>';
}

// ---- add / edit widgets ----
function openDashAddMenu(anchor, dbs){
  closeDbMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  const hd = document.createElement('div'); hd.className = 'lp-sub'; hd.textContent = t('เลือกฐานข้อมูล:'); menu.appendChild(hd);
  if (!dbs.length){ const e = document.createElement('div'); e.className = 'db-mi db-mi-mut'; e.textContent = t('ยังไม่มีฐานข้อมูล'); menu.appendChild(e); }
  dbs.forEach((d) => {
    const it = document.createElement('div'); it.className = 'db-mi'; it.innerHTML = icoSvg('db', 'sm'); it.appendChild(document.createTextNode(' ' + d.name));
    it.onclick = () => { closeDbMenu(); openDashVizMenu(anchor, d); };
    menu.appendChild(it);
  });
  placeDbMenu(menu, anchor);
}
function openDashVizMenu(anchor, d){
  closeDbMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  const hd = document.createElement('div'); hd.className = 'lp-sub'; hd.textContent = t('แสดง “') + d.name + t('” แบบ:'); menu.appendChild(hd);
  DASH_VIZ.forEach(([viz, ic, label]) => {
    const it = document.createElement('div'); it.className = 'db-mi'; it.innerHTML = icoSvg(ic, 'sm'); it.appendChild(document.createTextNode(' ' + t(label)));
    it.onclick = () => {
      closeDbMenu();
      const ws = loadDashWidgets();
      ws.push({ id: dbNewId('w'), dbId: d.id, viz, title: d.name, span: (viz === 'table' || viz === 'board') ? 2 : 1 });
      saveDashWidgets(ws); renderDash();
    };
    menu.appendChild(it);
  });
  placeDbMenu(menu, anchor);
}
function openDashCardMenu(anchor, idx, widgets){
  closeDbMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'dbMenu';
  const w = widgets[idx];
  const wide = document.createElement('div'); wide.className = 'db-mi'; wide.textContent = (w.span === 2 ? t('◧ ย่อความกว้าง') : t('◨ ขยายกว้าง 2 ช่อง'));
  wide.onclick = () => { const ws = loadDashWidgets(); ws[idx].span = ws[idx].span === 2 ? 1 : 2; saveDashWidgets(ws); closeDbMenu(); renderDash(); };
  const tall = document.createElement('div'); tall.className = 'db-mi'; tall.textContent = (w.tall ? t('▭ ลดความสูง') : t('▯ เพิ่มความสูง'));
  tall.onclick = () => { const ws = loadDashWidgets(); ws[idx].tall = !ws[idx].tall; saveDashWidgets(ws); closeDbMenu(); renderDash(); };
  const up = document.createElement('div'); up.className = 'db-mi'; up.textContent = t('เลื่อนขึ้น');
  up.onclick = () => { const ws = loadDashWidgets(); if (idx > 0){ const tmp = ws[idx-1]; ws[idx-1] = ws[idx]; ws[idx] = tmp; saveDashWidgets(ws); } closeDbMenu(); renderDash(); };
  const down = document.createElement('div'); down.className = 'db-mi'; down.textContent = t('เลื่อนลง');
  down.onclick = () => { const ws = loadDashWidgets(); if (idx < ws.length - 1){ const tmp = ws[idx+1]; ws[idx+1] = ws[idx]; ws[idx] = tmp; saveDashWidgets(ws); } closeDbMenu(); renderDash(); };
  const del = document.createElement('div'); del.className = 'db-mi db-mi-del'; del.textContent = t('ลบการ์ด');
  del.onclick = () => { const ws = loadDashWidgets(); ws.splice(idx, 1); saveDashWidgets(ws); closeDbMenu(); renderDash(); };
  [wide, tall, up, down, del].forEach((x) => menu.appendChild(x));
  placeDbMenu(menu, anchor);
}

// ========================================================================
// Extra actions inside Crepe's floating selection toolbar (next to the link icon)
// ========================================================================
const CREPE_TOOLBAR_EXTRAS = [
  ['sparkle', 'อธิบายด้วย AI', (sel) => runEngineAction(fillPrompt('explain', sel, currentNote))],
  ['link', 'ทำลิงก์ไปโน้ตอื่น', (sel, btn) => openLinkPicker(sel, btn)],
  ['task', 'เพิ่มเป็น Task', (sel, btn) => openAddToDbMenu(sel, btn)],
  ['chat', 'คุยเรื่องนี้ในแชตลอย', (sel) => openSideChat('เกี่ยวกับ "' + sel + '" — ')],
];
function decorateCrepeToolbar(tb){
  if (!tb || tb.dataset.dkExtras === '1') return;
  tb.dataset.dkExtras = '1';
  const div = document.createElement('div'); div.className = 'divider'; tb.appendChild(div);
  CREPE_TOOLBAR_EXTRAS.forEach(([icon, title, fn]) => {
    const b = document.createElement('div'); b.className = 'toolbar-item dk-tbi'; b.title = t(title); b.innerHTML = icoSvg(icon, 'sm');
    b.addEventListener('mousedown', (e) => e.preventDefault());          // keep the text selection alive
    b.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const sel = currentSelection();
      if (!sel || !currentNote) return;
      fn(sel, b);
    });
    tb.appendChild(b);
  });
}
new MutationObserver(() => {
  document.querySelectorAll('.milkdown-toolbar').forEach(decorateCrepeToolbar);
}).observe(document.body, { childList: true, subtree: true });

// ---------- New shell wiring: sidebar rail, AI menu, breadcrumb, saved tag ----------
(function shellWiring(){
  { const _tb = document.getElementById('trashBtn2'); if (_tb) _tb.onclick = () => setMainView('trash'); }
  { const _sb = document.getElementById('settingsBtn2'); if (_sb) _sb.onclick = (e) => { e.preventDefault(); openSettingsMenu(_sb); }; }

  // "＋ ใหม่" dropdown — create note / folder / db / board, or import PDF
  async function importPdfFlow(){
    const r = await window.api.importPdf();
    if (r && r.name) { await refreshList(currentNote); await openPdf(r.name); }
  }
  function openNewMenu(anchor){
    if (typeof closeFolderMenu === 'function') closeFolderMenu();
    const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
    const items = [
      [t('โน้ตใหม่'), () => { const b = document.getElementById('newNoteBtn'); if (b) b.click(); }],
      [t('กล่องใหม่'), () => { const b = document.getElementById('newFolderBtn'); if (b) b.click(); }],
      [t('ฐานข้อมูลใหม่'), () => sbNewDb()],
      [t('บอร์ดใหม่'), () => sbNewDash()],
      [t('นำเข้า PDF'), () => importPdfFlow()],
    ];
    items.forEach(([label, fn]) => {
      const it = document.createElement('div'); it.className = 'db-mi';
      it.textContent = label; it.onclick = () => { if (typeof closeFolderMenu === 'function') closeFolderMenu(); fn(); }; menu.appendChild(it);
    });
    document.body.appendChild(menu);
    const rc = anchor.getBoundingClientRect();
    menu.style.left = Math.min(rc.left, window.innerWidth - 210) + 'px';
    menu.style.bottom = (window.innerHeight - rc.top + 4) + 'px';  // popover sits just above the footer button
    setTimeout(() => { if (typeof onFolderMenuOutside === 'function') document.addEventListener('mousedown', onFolderMenuOutside, true); }, 0);
  }
  const newMenuBtn = document.getElementById('newMenuBtn');
  if (newMenuBtn) newMenuBtn.onclick = (e) => { e.preventDefault(); openNewMenu(newMenuBtn); };

  // AI tools dropdown (TL;DR / quiz)
  const aiBtn = document.getElementById('aiMenuBtn');
  if (aiBtn) aiBtn.onclick = (e) => {
    e.stopPropagation();
    const old = document.getElementById('aiMenu'); if (old) { old.remove(); return; }
    const m = document.createElement('div'); m.className = 'ai-menu'; m.id = 'aiMenu';
    const items = [
      ['i-tldr', t('สรุปทั้งโน้ต (TL;DR)'), 'tldrBtn'],
      ['i-quiz', t('ตั้งคำถามทดสอบ'), 'quizBtn'],
      ['i-thread', t('ร้อยเชือก — แนะนำลิงก์'), 'autolinkBtn'],
      ['i-chat', t('เปิดแชตลอย'), 'sideChatBtn'],
    ];
    items.forEach(([ic, label, targetId]) => {
      const b = document.createElement('button');
      b.innerHTML = '<svg class="ic sm"><use href="#' + ic + '"/></svg><span></span>';
      b.querySelector('span').textContent = label;
      b.onclick = () => { m.remove(); const t = document.getElementById(targetId); if (t) t.click(); };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = aiBtn.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.left = Math.max(8, Math.min(r.left - 60, window.innerWidth - m.offsetWidth - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function once(ev){
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', once, true); }
    }, true), 0);
  };

  // breadcrumb + saved indicator follow the open note / dirty state
  const crumb = document.getElementById('crumb');
  const savedTag = document.getElementById('savedTag');
  // clickable crumb segment: no-drag so clicks don't start a window-drag
  function crumbLink(text, fn, bold){
    const el = document.createElement(bold ? 'b' : 'span');
    el.className = 'crumb-link';
    el.textContent = text;
    if (fn) el.onclick = fn;
    return el;
  }
  function crateIc(){
    const ic = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ic.setAttribute('class', 'ic sm');
    ic.innerHTML = '<use href="#i-crate"/>';
    return ic;
  }
  function paintShell(){
    if (crumb && typeof currentPdf === 'string' && currentPdf && mainView === 'pdf'){
      crumb.innerHTML = '';
      const b = document.createElement('b');
      b.textContent = currentPdf.replace(/\.pdf$/i, '').split('/').pop();
      b.className = 'crumb-pdf';
      b.title = t('คลิกเพื่อเปลี่ยนชื่อไฟล์ PDF');
      b.onclick = () => { if (typeof renamePdf === 'function') renamePdf(currentPdf); };
      crumb.appendChild(b);
    } else if (crumb && mainView === 'table'){
      crumb.innerHTML = '';
      if (dbOpenId && dbCache && dbCache.id === dbOpenId){
        crumb.appendChild(crumbLink(t('ฐานข้อมูล'), () => { dbOpenId = null; dbCache = null; renderTable(); renderSidebar(); }));
        const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; crumb.appendChild(sep);
        const b = document.createElement('b'); b.textContent = dbCache.name || ''; crumb.appendChild(b);
      } else {
        const b = document.createElement('b'); b.textContent = t('ฐานข้อมูล'); crumb.appendChild(b);
      }
    } else if (crumb && mainView === 'crate'){
      crumb.innerHTML = '';
      const parts = (currentCrate || '').split('/').filter(Boolean);
      crumb.appendChild(crumbLink(t('โน้ต'), () => openCrate(''), parts.length === 0));
      let acc = [];
      parts.forEach((p, i) => {
        acc.push(p);
        const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; crumb.appendChild(sep);
        crumb.appendChild(crateIc());
        if (i === parts.length - 1){ const b = document.createElement('b'); b.textContent = p; crumb.appendChild(b); }
        else { crumb.appendChild(crumbLink(p, () => openCrate(acc.join('/')))); }
      });
    } else if (crumb && mainView === 'dash'){
      crumb.innerHTML = '';
      const board = (typeof currentDashboard === 'function') ? currentDashboard() : null;
      if (board && board.name){
        const s1 = document.createElement('span'); s1.textContent = t('แดชบอร์ด'); crumb.appendChild(s1);
        const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/'; crumb.appendChild(sep);
        const b = document.createElement('b'); b.textContent = board.name; crumb.appendChild(b);
      } else {
        const b = document.createElement('b'); b.textContent = t('แดชบอร์ด'); crumb.appendChild(b);
      }
    } else if (crumb && mainView === 'graph'){
      crumb.innerHTML = '';
      const b = document.createElement('b'); b.textContent = t('กราฟ'); crumb.appendChild(b);
    } else if (crumb && mainView === 'trash'){
      crumb.innerHTML = '';
      const b = document.createElement('b'); b.textContent = t('ถังขยะ'); crumb.appendChild(b);
    } else if (crumb){
      const rel = (typeof currentNote === 'string' && currentNote) ? currentNote : '';
      crumb.innerHTML = '';
      if (!rel){ crumb.appendChild(crumbLink(t('โน้ต'), () => openCrate(''), true)); }
      else {
        const parts = rel.replace(/\.md$/i, '').split('/');
        const folders = parts.slice(0, -1);
        parts.forEach((p, i) => {
          if (i){ const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; crumb.appendChild(s); }
          if (i === parts.length - 1){ const b = document.createElement('b'); b.textContent = p; crumb.appendChild(b); }
          else {
            crumb.appendChild(crateIc());
            crumb.appendChild(crumbLink(p, () => openCrate(folders.slice(0, i + 1).join('/'))));
          }
        });
      }
    }
    if (savedTag){
      const d = document.getElementById('dirty');
      const isDirty = d && !d.hidden;
      savedTag.classList.toggle('unsaved', !!isDirty);
      savedTag.title = isDirty ? t('มีการแก้ที่ยังไม่บันทึก — กด ⌘S เพื่อบันทึก') : t('บันทึกแล้ว');
      const _t = savedTag.querySelector('.saved-txt');
      if (_t) _t.textContent = isDirty ? t('ยังไม่บันทึก') : t('บันทึกแล้ว');
    }
  }
  setInterval(paintShell, 400);
  paintShell();
})();

// ---------- Auto-link: highlight where a suggested phrase sits in the editor ----------
let _alHlBoxes = [];
function clearPhraseHighlight(){ _alHlBoxes.forEach((e) => { try { e.remove(); } catch (_) {} }); _alHlBoxes = []; }
function _boxesForPhrase(phrase){
  const host = document.getElementById('editorHost'); if (!host || !phrase) return [];
  const root = host.querySelector('.ProseMirror') || host.querySelector('.milkdown') || host;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node, hit = null, idx = -1;
  while ((node = walker.nextNode())){
    const i = node.nodeValue ? node.nodeValue.indexOf(phrase) : -1;
    if (i >= 0){ hit = node; idx = i; break; }
  }
  if (!hit) return [];
  const range = document.createRange();
  range.setStart(hit, idx); range.setEnd(hit, idx + phrase.length);
  const hostRect = host.getBoundingClientRect();
  const made = [];
  for (const r of range.getClientRects()){
    const box = document.createElement('div'); box.className = 'al-hl';
    box.style.left = (r.left - hostRect.left + host.scrollLeft) + 'px';
    box.style.top = (r.top - hostRect.top + host.scrollTop) + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    host.appendChild(box); made.push(box); _alHlBoxes.push(box);
  }
  return range.getClientRects();
}
function highlightPhrase(phrase){                    // hover one suggestion: box it + scroll into view
  clearPhraseHighlight();
  const rects = _boxesForPhrase(phrase);
  const host = document.getElementById('editorHost');
  if (rects && rects[0] && host){
    const hostRect = host.getBoundingClientRect(), first = rects[0];
    if (first.top < hostRect.top + 24 || first.bottom > hostRect.bottom - 24){
      host.scrollTop += (first.top - hostRect.top) - host.clientHeight * 0.4;
    }
  }
}
function flashAllPhrases(phrases){                    // when results appear: briefly show every spot
  clearPhraseHighlight();
  (phrases || []).forEach((p) => _boxesForPhrase(p));
  setTimeout(clearPhraseHighlight, 1900);
}

/* =========================================================
   PDF viewer — phase 1 (open + render + zoom + page nav)
   ========================================================= */
if (window.pdfjsLib) {
  try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; } catch (_) {}
}
var currentPdf = null;
let pdfDoc = null;
let pdfScale = 1.2;
let pdfRenderToken = 0;
let pdfCurPage = 1;
let pdfLoadedName = null;
let pdfAnnots = { highlights: [], textboxes: [] };
let pendingSel = null;

function pdfPagesEl(){ return document.getElementById('pdfPages'); }

async function openPdf(name){
  currentPdf = name;
  currentNote = null;
  if (typeof clearAutolink === 'function') clearAutolink();
  const left = document.getElementById('left');
  if (left){ left.classList.remove('view-graph','view-table','view-dash','view-crate','view-trash'); left.classList.add('view-pdf'); }
  mainView = 'pdf';
  document.querySelectorAll('.sb-views .sbv').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#noteList .note-item').forEach((el) => el.classList.toggle('active', el.dataset.pdf === name));
  try { const c = document.getElementById('crumb'); if (c) c.innerHTML = '<b>' + name.replace(/\.pdf$/i, '').split('/').pop() + '</b>'; } catch (_) {}
  vsSet('lastPdf', name);
  vsSet('lastOpen', { type: 'pdf', name });
  if (name === pdfLoadedName && pdfDoc && pdfPagesEl() && pdfPagesEl().querySelector('.pdf-page')) return;
  const host = pdfPagesEl();
  if (host) host.innerHTML = '<div class="pdf-empty">' + t('กำลังเปิด…') + '</div>';
  const buf = await window.api.readPdf(name);
  if (!buf || !window.pdfjsLib){ if (host) host.innerHTML = '<div class="pdf-empty">' + t('เปิดไฟล์ไม่ได้') + '</div>'; return; }
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const token = ++pdfRenderToken;
  try { pdfDoc = await window.pdfjsLib.getDocument({ data }).promise; }
  catch (e) { if (host) host.innerHTML = '<div class="pdf-empty">' + t('อ่าน PDF ไม่ได้') + '</div>'; return; }
  if (token !== pdfRenderToken) return;
  pdfLoadedName = name;
  pdfAnnots = await loadPdfAnnots(name);
  const sp = vsPdfPageGet(name);
  const savedPage = (sp && sp > 0) ? sp : 1;
  pdfCurPage = savedPage;
  await renderPdf(token);
  if (savedPage > 1) pdfGoto(savedPage, true);
  if (typeof annotPanelOpen === 'function' && annotPanelOpen()) renderAnnotPanel();
}

async function renderPdf(token){
  const host = pdfPagesEl();
  if (!host || !pdfDoc) return;
  if (pdfIO) { try { pdfIO.disconnect(); } catch (_) {} pdfIO = null; }
  if (pdfAutoFit) await pdfComputeFit();
  if (token !== pdfRenderToken) return;
  host.innerHTML = '';
  const cnt = document.getElementById('pdfCount'); if (cnt) cnt.textContent = pdfCurPage + ' / ' + pdfDoc.numPages;
  let estW = pdfContainerWidth(), estH = estW * 1.414;
  try {
    const p1 = await pdfDoc.getPage(1);
    if (pdfAutoFit){ const v1 = p1.getViewport({ scale: 1 }); estW = pdfContainerWidth(); estH = estW * (v1.height / v1.width); }
    else { const vp = p1.getViewport({ scale: pdfScale }); estW = vp.width; estH = vp.height; }
  } catch (_) {}
  if (token !== pdfRenderToken) return;
  for (let n = 1; n <= pdfDoc.numPages; n++){
    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrap'; wrap.dataset.page = n; wrap.dataset.rendered = '0';
    wrap.style.width = estW + 'px'; wrap.style.height = estH + 'px';
    const ph = document.createElement('div'); ph.className = 'pdf-ph'; ph.textContent = t('หน้า ') + n; wrap.appendChild(ph);
    host.appendChild(wrap);
  }
  pdfIO = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const wrap = en.target;
      if (en.isIntersecting) renderOnePage(+wrap.dataset.page, wrap, token);
      else unloadPage(wrap);
    });
  }, { root: host, rootMargin: '1200px 0px' });
  host.querySelectorAll('.pdf-page-wrap').forEach((w) => pdfIO.observe(w));
  if (pdfCurPage > 1) pdfGoto(pdfCurPage, true);
}

function pdfScrollSync(){
  const host = pdfPagesEl();
  if (!host || !pdfDoc) return;
  const pages = host.querySelectorAll('.pdf-page-wrap');
  let cur = 1; const top = host.scrollTop;
  pages.forEach((c) => { if (c.offsetTop - host.offsetTop <= top + 80) cur = +c.dataset.page; });
  pdfCurPage = cur;
  const cnt = document.getElementById('pdfCount'); if (cnt) cnt.textContent = cur + ' / ' + pdfDoc.numPages;
  if (currentPdf) vsPdfPageSet(currentPdf, cur);
}

function pdfScrollToPage(page, yFrac, margin){
  const host = pdfPagesEl();
  if (!host || !pdfDoc) return;
  page = Math.min(pdfDoc.numPages, Math.max(1, page));
  yFrac = yFrac || 0; margin = margin || 0;
  let tries = 0, last = -1;
  const step = () => {
    if (mainView !== 'pdf') return;
    const c = host.querySelector('.pdf-page-wrap[data-page="' + page + '"]');
    if (!c) return;
    const target = Math.max(0, Math.round(host.scrollTop + (c.getBoundingClientRect().top - host.getBoundingClientRect().top) + (yFrac * c.clientHeight) - margin));
    if (Math.abs(target - host.scrollTop) > 2) host.scrollTop = target;
    tries++;
    if (target === last && tries > 2) return;
    last = target;
    if (tries < 10) setTimeout(step, 110);
  };
  step();
}
function pdfGoto(page, instant){ pdfScrollToPage(page, 0, 0); }

function makePdfItem(rel, depth){
  const item = document.createElement('div');
  item.className = 'note-item pdf-item'; item.dataset.pdf = rel;
  const label = rel.replace(/\.pdf$/i, '').split('/').pop();
  item.innerHTML = '<span class="sb-chevsp"></span>' + icoSvg('book', 'sm') + '<span class="pdf-nm"></span>';
  item.querySelector('.pdf-nm').textContent = label;
  item.style.paddingLeft = (8 + depth * 22) + 'px';
  if (depth > 0) item.classList.add('nested');
  item.draggable = true;
  item.onclick = () => openPdf(rel);
  item.oncontextmenu = (e) => { e.preventDefault(); openPdfMenu(e.clientX, e.clientY, rel); };
  item.addEventListener('dragstart', (e) => { pdfDragSrc = rel; e.dataTransfer.effectAllowed = 'move'; item.classList.add('dragging'); });
  item.addEventListener('dragend', () => { pdfDragSrc = null; item.classList.remove('dragging'); });
  return item;
}

(function wirePdf(){
  const bind = () => {
    const pv = document.getElementById('pdfPrev'); if (pv) pv.onclick = () => pdfGoto(pdfCurPage - 1);
    const nx = document.getElementById('pdfNext'); if (nx) nx.onclick = () => pdfGoto(pdfCurPage + 1);
    const host = pdfPagesEl(); if (host) host.addEventListener('scroll', pdfScrollSync);
    if (host && window.ResizeObserver){ let _rt = null; pdfRO = new ResizeObserver(() => { if (!pdfAutoFit || !pdfDoc || mainView !== 'pdf') return; clearTimeout(_rt); _rt = setTimeout(() => renderPdf(++pdfRenderToken), 200); }); pdfRO.observe(host); }
    const nbtn = document.getElementById('pdfNoteBtn'); if (nbtn) nbtn.onclick = () => openCompanionNote();
    const abtn = document.getElementById('pdfAnnotsBtn'); if (abtn) abtn.onclick = () => toggleAnnotPanel();
    const cbtn = document.getElementById('pdfCropBtn'); if (cbtn) cbtn.onclick = () => toggleCropMode();
    const tbtn = document.getElementById('pdfTextBtn'); if (tbtn) tbtn.onclick = () => toggleTextMode();
    if (host) host.addEventListener('mousedown', pdfCropMousedown, true);
    if (host) host.addEventListener('mousedown', pdfTextMousedown, true);
  };
  if (document.readyState !== 'loading') bind(); else document.addEventListener('DOMContentLoaded', bind);
})();

/* ---- PDF rename / delete / context menu ---- */
async function renamePdf(rel){
  if (!rel) return;
  const cur = rel.replace(/\.pdf$/i, '').split('/').pop();
  const nm = await askName(t('เปลี่ยนชื่อ PDF'), cur);
  if (!nm || !nm.trim() || nm.trim() === cur) return;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  let to = nm.trim(); if (!/\.pdf$/i.test(to)) to += '.pdf';
  to = dir ? dir + '/' + to : to;
  const r = await window.api.renamePdf(rel, to);
  if (r && r.error === 'exists') { alert(t('มีไฟล์ชื่อนี้อยู่แล้ว')); return; }
  if (r && r.error) { alert(t('เปลี่ยนชื่อไม่ได้')); return; }
  const newName = (r && r.name) ? r.name : to;
  vsPdfPageRename(rel, newName);
  pdfLoadedName = null;
  await refreshList(currentNote);
  await openPdf(newName);
}
async function deletePdf(rel){
  if (!rel) return;
  if (!(await confirmDelete(t('ย้าย "') + rel.split('/').pop() + t('" ไปถังขยะ?')))) return;
  await window.api.deleteNote(rel);
  vsPdfPageDelete(rel);
  if (currentPdf === rel){ currentPdf = null; pdfLoadedName = null; }
  await refreshList(currentNote);
}
function openPdfMenu(x, y, rel){
  if (typeof closeFolderMenu === 'function') closeFolderMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
  [[t('เปลี่ยนชื่อ'), () => renamePdf(rel)], [t('ลบ (ไปถังขยะ)'), () => deletePdf(rel)]].forEach(([label, fn]) => {
    const it = document.createElement('div'); it.className = 'db-mi' + (label.startsWith(t('ลบ')) ? ' db-mi-del' : '');
    it.textContent = label; it.onclick = () => { if (typeof closeFolderMenu === 'function') closeFolderMenu(); fn(); }; menu.appendChild(it);
  });
  document.body.appendChild(menu);
  menu.style.top = Math.min(y, window.innerHeight - 90) + 'px';
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  setTimeout(() => { if (typeof onFolderMenuOutside === 'function') document.addEventListener('mousedown', onFolderMenuOutside, true); }, 0);
}

/* ================= PDF highlights — phase 2 (append) ================= */
const PDF_HL = {
  persimmon: { bg: 'rgba(189,85,64,.32)',  bd: 'rgba(189,85,64,.6)' },
  sage:      { bg: 'rgba(125,148,113,.34)', bd: 'rgba(125,148,113,.62)' },
  gold:      { bg: 'rgba(189,154,78,.36)',  bd: 'rgba(189,154,78,.62)' },
  indigo:    { bg: 'rgba(63,92,125,.30)',   bd: 'rgba(63,92,125,.6)' }
};
const PDF_HL_ORDER = ['persimmon', 'sage', 'gold', 'indigo'];
let pdfHlSeq = 0;
function pdfHlId(){ pdfHlSeq++; return 'h' + Math.round(performance.now()) + '_' + pdfHlSeq; }

async function loadPdfAnnots(name){
  try {
    const a = await window.api.readAnnots(name);
    if (!a) return { highlights: [], textboxes: [] };
    if (!Array.isArray(a.highlights)) a.highlights = [];
    if (!Array.isArray(a.textboxes)) a.textboxes = [];
    return a;
  }
  catch (_) { return { highlights: [], textboxes: [] }; }
}
function savePdfAnnots(){
  if (!currentPdf) return;
  try { window.api.saveAnnots(currentPdf, pdfAnnots); } catch (_) {}
}

function drawPageHighlights(pageNum, hlLayer, cssW, cssH){
  hlLayer.innerHTML = '';
  pdfAnnots.highlights.filter((h) => h.page === pageNum).forEach((h) => {
    const c = PDF_HL[h.color] || PDF_HL.gold;
    (h.rects || []).forEach((r) => {
      const d = document.createElement('div');
      d.className = 'pdf-hl'; d.dataset.hid = h.id;
      d.style.left = (r.x * cssW) + 'px';
      d.style.top = (r.y * cssH) + 'px';
      d.style.width = (r.w * cssW) + 'px';
      d.style.height = (r.h * cssH) + 'px';
      d.style.background = c.bg;
      if (h.area) d.classList.add('pdf-hl-area');
      d.title = h.note ? h.note : t('คลิกเพื่อเปลี่ยนสี/ลบ');
      if (h.note) d.classList.add('has-note');
      d.onclick = (ev) => { ev.stopPropagation(); showHlBar(ev.clientX, ev.clientY, 'edit', h); };
      hlLayer.appendChild(d);
    });
  });
}
function redrawPage(pageNum){
  const host = pdfPagesEl(); if (!host) return;
  const wrap = host.querySelector('.pdf-page-wrap[data-page="' + pageNum + '"]'); if (!wrap) return;
  const hl = wrap.querySelector('.pdf-hllayer');
  if (hl) drawPageHighlights(pageNum, hl, wrap.clientWidth, wrap.clientHeight);
  const tl = wrap.querySelector('.pdf-tboxlayer');
  if (tl) drawPageTextboxes(pageNum, tl, wrap.clientWidth, wrap.clientHeight);
}
function redrawCurrentPages(){
  const host = pdfPagesEl(); if (!host) return;
  host.querySelectorAll('.pdf-page-wrap').forEach((wrap) => {
    const hl = wrap.querySelector('.pdf-hllayer');
    if (hl) drawPageHighlights(+wrap.dataset.page, hl, wrap.clientWidth, wrap.clientHeight);
    const tl = wrap.querySelector('.pdf-tboxlayer');
    if (tl) drawPageTextboxes(+wrap.dataset.page, tl, wrap.clientWidth, wrap.clientHeight);
  });
}

function onPdfSelectionMaybe(pageNum, wrap, cssW, cssH){
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) { return; }
  const text = sel.toString().trim();
  if (!text) { return; }
  const range = sel.getRangeAt(0);
  const wrapRect = wrap.getBoundingClientRect();
  const rects = [];
  const cr = range.getClientRects();
  for (let i = 0; i < cr.length; i++){
    const r = cr[i];
    if (r.width < 1 || r.height < 1) continue;
    rects.push({ x: (r.left - wrapRect.left) / cssW, y: (r.top - wrapRect.top) / cssH, w: r.width / cssW, h: r.height / cssH });
  }
  if (!rects.length) { return; }
  pendingSel = { page: pageNum, rects, text };
  const first = cr[0];
  showHlBar(first.left + first.width / 2, first.top, 'new', null);
}

function addHighlight(color){
  if (!pendingSel) return;
  pdfAnnots.highlights.push({ id: pdfHlId(), page: pendingSel.page, color, text: pendingSel.text, rects: pendingSel.rects });
  savePdfAnnots();
  redrawPage(pendingSel.page);
  pendingSel = null;
  hideHlBar();
  const sel = window.getSelection(); if (sel) sel.removeAllRanges();
  if (annotPanelOpen()) renderAnnotPanel();
}
function removeHighlight(id){
  pdfAnnots.highlights = pdfAnnots.highlights.filter((h) => h.id !== id);
  savePdfAnnots();
  redrawCurrentPages();
  if (annotPanelOpen()) renderAnnotPanel();
}

function hideHlBar(){ const b = document.getElementById('pdfHlBar'); if (b) b.remove(); }
function hlBarOutside(e){
  const b = document.getElementById('pdfHlBar');
  if (b && !b.contains(e.target) && !(e.target.classList && e.target.classList.contains('pdf-hl'))){
    hideHlBar(); document.removeEventListener('mousedown', hlBarOutside, true);
  }
}
function showHlBar(cx, cy, mode, hl){
  hideHlBar();
  const bar = document.createElement('div'); bar.id = 'pdfHlBar'; bar.className = 'pdf-hlbar';
  PDF_HL_ORDER.forEach((key) => {
    const s = document.createElement('button'); s.className = 'pdf-sw'; s.type = 'button';
    s.style.background = PDF_HL[key].bg; s.style.boxShadow = '0 0 0 1.5px ' + PDF_HL[key].bd + ' inset';
    if (mode === 'edit' && hl && hl.color === key) s.classList.add('on');
    s.onclick = (e) => {
      e.stopPropagation();
      if (mode === 'new') addHighlight(key);
      else if (hl) { hl.color = key; savePdfAnnots(); redrawCurrentPages(); hideHlBar(); }
    };
    bar.appendChild(s);
  });
  if (mode === 'new'){
    const nsep = document.createElement('span'); nsep.className = 'pdf-sw-sep'; bar.appendChild(nsep);
    const nb = document.createElement('button'); nb.className = 'pdf-sw pdf-sw-act'; nb.type = 'button'; nb.title = t('ไฮไลต์ + จดโน้ต'); nb.innerHTML = icoSvg('chat', 'xs');
    nb.onclick = (e) => { e.stopPropagation(); addHighlightNote(); };
    bar.appendChild(nb);
  }
  if (mode === 'edit'){
    const sep = document.createElement('span'); sep.className = 'pdf-sw-sep'; bar.appendChild(sep);
    const mk = (icon, title, fn) => { const b = document.createElement('button'); b.className = 'pdf-sw pdf-sw-act'; b.type = 'button'; b.title = t(title); b.innerHTML = icoSvg(icon, 'xs'); b.onclick = (e) => { e.stopPropagation(); fn(); }; bar.appendChild(b); };
    mk('chat', 'คอมเมนต์', () => { hideHlBar(); if (hl) editHlComment(hl); });
    mk('note', 'ส่งเข้าโน้ตคู่หู', () => { hideHlBar(); if (hl) sendHighlightToNote(hl); });
    mk('sparkle', 'ถาม AI', () => { hideHlBar(); if (hl) askAiHighlight(hl); });
    const del = document.createElement('button'); del.className = 'pdf-sw pdf-sw-del'; del.type = 'button'; del.title = t('ลบ');
    del.innerHTML = icoSvg('trash', 'xs');
    del.onclick = (e) => { e.stopPropagation(); if (hl) removeHighlight(hl.id); hideHlBar(); };
    bar.appendChild(del);
  }
  document.body.appendChild(bar);
  const bw = bar.offsetWidth || 150, bh = bar.offsetHeight || 34;
  let left = cx - bw / 2; left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  let top = cy - bh - 8; if (top < 8) top = cy + 16;
  bar.style.left = left + 'px'; bar.style.top = top + 'px';
  setTimeout(() => document.addEventListener('mousedown', hlBarOutside, true), 0);
}


/* ========= PDF annotate — phase 3+4: comments, panel, companion note, AI (append) ========= */

// Parse a comment string into DOM nodes: [[name]] / [[name|alias]] and http(s) URLs become
// clickable spans (data-kind + data-target); everything else is plain text. No innerHTML of raw text.
function appendCommentLinks(parent, text){
  const re = /\[\[([^\[\]|\n]+?)(?:\|([^\[\]\n]+?))?\]\]|(https?:\/\/[^\s<>"']+)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null){
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const sp = document.createElement('span');
    sp.className = 'pa-link';
    if (m[1] !== undefined){
      sp.classList.add('pa-link-wl');
      sp.textContent = m[2] || m[1];
      sp.dataset.kind = 'wl';
      sp.dataset.target = m[1];
    } else {
      sp.classList.add('pa-link-url');
      sp.textContent = m[3];
      sp.dataset.kind = 'url';
      sp.dataset.target = m[3];
    }
    parent.appendChild(sp);
    last = re.lastIndex;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// Tiny popup at the cursor: "ไปหน้านั้น" (follow) / "แก้ไข Link" (edit raw comment).
// Reuses the .db-menu + closeFolderMenu/onFolderMenuOutside pattern (same id, so only one menu at a time).
function openCommentLinkMenu(x, y, linkEl, hl){
  if (typeof closeFolderMenu === 'function') closeFolderMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
  const kind = linkEl.dataset.kind, target = linkEl.dataset.target;
  const items = [
    [t('ไปหน้านั้น'), () => {
      if (kind === 'wl') { if (typeof window.__wlClick === 'function') window.__wlClick(target); }
      else if (window.api && window.api.openExternal) window.api.openExternal(target);
    }],
    [t('แก้ไข Link'), () => { if (typeof editHlComment === 'function') editHlComment(hl); }],
  ];
  items.forEach(([label, fn]) => {
    const it = document.createElement('div'); it.className = 'db-mi';
    it.textContent = label;
    it.onclick = () => { if (typeof closeFolderMenu === 'function') closeFolderMenu(); fn(); };
    menu.appendChild(it);
  });
  document.body.appendChild(menu);
  menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  setTimeout(() => { if (typeof onFolderMenuOutside === 'function') document.addEventListener('mousedown', onFolderMenuOutside, true); }, 0);
}

// ----- comment on a highlight -----
async function editHlComment(hl){
  if (!hl) return;
  const val = await askName(t('คอมเมนต์สำหรับไฮไลต์'), hl.note || '');
  if (val === null || val === undefined) return;
  hl.note = (val || '').trim();
  savePdfAnnots();
  redrawCurrentPages();
  if (annotPanelOpen()) renderAnnotPanel();
}

// ----- annotations side panel -----
function annotPanelEl(){ return document.getElementById('pdfAnnotsPanel'); }
function annotPanelOpen(){ const p = annotPanelEl(); return !!(p && !p.hidden); }
function toggleAnnotPanel(){
  const p = annotPanelEl(); if (!p) return;
  p.hidden = !p.hidden;
  const b = document.getElementById('pdfAnnotsBtn'); if (b) b.classList.toggle('on', !p.hidden);
  if (!p.hidden) renderAnnotPanel();
}
function paAction(icon, title, fn){
  const b = document.createElement('button'); b.className = 'pa-act'; b.type = 'button'; b.title = t(title);
  b.innerHTML = icoSvg(icon, 'xs');
  b.onclick = (e) => { e.stopPropagation(); fn(); };
  return b;
}
function renderAnnotPanel(){
  const p = annotPanelEl(); if (!p) return;
  p.innerHTML = '';
  const hs = pdfAnnots.highlights.slice().sort((a, b) => (a.page - b.page));
  const head = document.createElement('div'); head.className = 'pa-head';
  head.textContent = t('ไฮไลต์ · ') + hs.length; p.appendChild(head);
  if (!hs.length){
    const e = document.createElement('div'); e.className = 'pa-empty';
    e.textContent = t('ยังไม่มีไฮไลต์ — ลากเลือกข้อความบนหน้า PDF แล้วเลือกสี'); p.appendChild(e); return;
  }
  hs.forEach((h) => {
    const c = PDF_HL[h.color] || PDF_HL.gold;
    const row = document.createElement('div'); row.className = 'pa-row';
    const bar = document.createElement('span'); bar.className = 'pa-bar'; bar.style.background = c.bd; row.appendChild(bar);
    const body = document.createElement('div'); body.className = 'pa-body';
    if (h.note){
      const main = document.createElement('div'); main.className = 'pa-main';
      main.innerHTML = icoSvg('chat', 'xs');
      const txt = document.createElement('span'); txt.className = 'pa-main-txt';
      appendCommentLinks(txt, ' ' + h.note);
      main.appendChild(txt);
      main.querySelectorAll('.pa-link').forEach((sp) => {
        sp.onclick = (e) => { e.stopPropagation(); e.preventDefault(); openCommentLinkMenu(e.clientX, e.clientY, sp, h); };
      });
      body.appendChild(main);
      if (h.text && !h.area){ const sub = document.createElement('div'); sub.className = 'pa-sub'; sub.textContent = h.text; body.appendChild(sub); }
    } else {
      const isPlaceholder = !h.text || /^พื้นที่ \(หน้า/.test(h.text);   // covers new (empty) + legacy "พื้นที่ (หน้า N)"
      if (h.area || isPlaceholder){
        const ph = document.createElement('div'); ph.className = 'pa-addnote'; ph.textContent = t('เพิ่มโน้ต…');
        ph.onclick = (e) => { e.stopPropagation(); editHlComment(h); };
        body.appendChild(ph);
      } else {
        const q = document.createElement('div'); q.className = 'pa-quote'; q.textContent = h.text; body.appendChild(q);
      }
    }
    const meta = document.createElement('div'); meta.className = 'pa-meta';
    meta.appendChild(paAction('note', 'ส่งเข้าโน้ตคู่หู', () => sendHighlightToNote(h)));
    meta.appendChild(paAction('sparkle', 'ถาม AI', () => askAiHighlight(h)));
    meta.appendChild(paAction('chat', 'คอมเมนต์', () => editHlComment(h)));
    const pg = document.createElement('span'); pg.className = 'pa-pg'; pg.textContent = t('น.') + h.page; meta.appendChild(pg);
    body.appendChild(meta);
    row.appendChild(body);
    row.onclick = (e) => { if (e.target.closest('.pa-act') || e.target.closest('.pa-link')) return; jumpToHighlight(h); };
    p.appendChild(row);
  });
}

// ----- companion note (one .md per PDF) -----
function companionNoteName(pdf){ return pdf.replace(/\.pdf$/i, '') + ' · โน้ต.md'; }
async function ensureCompanionNote(pdf){
  const name = companionNoteName(pdf);
  const res = await window.api.listNotes();
  const notes = Array.isArray(res) ? res : (res.notes || []);
  if (!notes.includes(name)) { await window.api.createNote(name); }
  // Persist the link in the PDF's sidecar so renaming either side never unlinks them.
  // Guard: only when this PDF is the one currently open (pdfAnnots belongs to it).
  if (currentPdf === pdf && pdfAnnots && pdfAnnots.companion !== name){
    pdfAnnots.companion = name;
    savePdfAnnots();
  }
  return name;
}
async function openCompanionNote(){
  if (!currentPdf) return;
  const name = await ensureCompanionNote(currentPdf);
  await refreshList(name);
}

// ----- send a highlight into the companion note under its page heading -----
async function sendHighlightToNote(hl){
  if (!currentPdf || !hl) return;
  const name = await ensureCompanionNote(currentPdf);
  let content = '';
  try { content = await window.api.readNote(name); } catch (_) {}
  const heading = '### หน้า ' + hl.page;
  let block = '> ' + (hl.text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (hl.note) block += '\n>\n> — ' + hl.note;
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx >= 0){
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++){ if (/^#{1,6}\s/.test(lines[i])) { end = i; break; } }
    lines.splice(end, 0, block, '');
    content = lines.join('\n');
  } else {
    if (content && !/\n$/.test(content)) content += '\n';
    content += '\n' + heading + '\n\n' + block + '\n';
  }
  await window.api.saveNote(name, content);
  hl.sent = true; savePdfAnnots(); redrawCurrentPages();
  if (annotPanelOpen()) renderAnnotPanel();
  pdfToast(t('ส่งเข้าโน้ตคู่หูแล้ว · หน้า ') + hl.page);
}

// ----- ask AI about a highlight (opens a floating side chat, seeded) -----
function askAiHighlight(hl){
  if (!hl) return;
  const seed = 'ช่วยอธิบายและสรุปข้อความนี้จาก PDF (หน้า ' + hl.page + '):\n"' + (hl.text || '').trim() + '"';
  if (typeof openSideChat === 'function') openSideChat(seed);
}

// ----- tiny toast (reuses the .toast style) -----
function pdfToast(msg){
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => { try { t.remove(); } catch (_) {} }, 300); }, 2000);
}

/* ============ PDF lazy render + fit-to-width helpers (append) ============ */
let pdfIO = null;
let pdfAutoFit = true;
let pdfRO = null;

function pdfContainerWidth(){
  const host = pdfPagesEl(); if (!host) return 800;
  const cs = getComputedStyle(host);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  return Math.max(220, host.clientWidth - pad - 2);
}
async function pdfComputeFit(){
  if (!pdfDoc) return;
  try {
    const p1 = await pdfDoc.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    const s = pdfContainerWidth() / vp1.width;
    pdfScale = Math.min(3, Math.max(0.3, Math.round(s * 100) / 100));
  } catch (_) {}
}
function unloadPage(wrap){
  if (!wrap || wrap.dataset.rendered !== '1') return;
  const h = wrap.style.height;
  wrap.innerHTML = '';
    const ph = document.createElement('div'); ph.className = 'pdf-ph'; ph.textContent = t('หน้า ') + wrap.dataset.page;
  wrap.appendChild(ph);
  wrap.dataset.rendered = '0'; wrap.style.height = h;
}
async function renderOnePage(n, wrap, token){
  if (!pdfDoc || token !== pdfRenderToken) return;
  if (wrap.dataset.rendered === '1' || wrap.dataset.rendering === '1') return;
  wrap.dataset.rendering = '1';
  const dpr = window.devicePixelRatio || 1;
  let page;
  try { page = await pdfDoc.getPage(n); } catch (_) { wrap.dataset.rendering = '0'; return; }
  if (token !== pdfRenderToken) { wrap.dataset.rendering = '0'; return; }
  let scale = pdfScale;
  if (pdfAutoFit){ try { const v1 = page.getViewport({ scale: 1 }); scale = Math.min(5, Math.max(0.1, pdfContainerWidth() / v1.width)); } catch (_) {} if (n === 1) pdfScale = scale; }
  const vp = page.getViewport({ scale: scale });
  const cssW = vp.width, cssH = vp.height;
  wrap.style.width = cssW + 'px'; wrap.style.height = cssH + 'px';
  wrap.innerHTML = '';
  const canvas = document.createElement('canvas'); canvas.className = 'pdf-page'; canvas.dataset.page = n;
  canvas.width = Math.floor(cssW * dpr); canvas.height = Math.floor(cssH * dpr);
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  wrap.appendChild(canvas);
  const tl = document.createElement('div'); tl.className = 'pdf-textlayer';
  tl.style.setProperty('--scale-factor', String(scale));
  wrap.appendChild(tl);
  const hl = document.createElement('div'); hl.className = 'pdf-hllayer';
  wrap.appendChild(hl);
  const tb = document.createElement('div'); tb.className = 'pdf-tboxlayer';
  wrap.appendChild(tb);
  try { await page.render({ canvasContext: canvas.getContext('2d'), viewport: page.getViewport({ scale: scale * dpr }) }).promise; }
  catch (_) {}
  if (token !== pdfRenderToken) { wrap.dataset.rendering = '0'; return; }
  try {
    const tc = await page.getTextContent();
    if (window.pdfjsLib && window.pdfjsLib.renderTextLayer){
      const task = window.pdfjsLib.renderTextLayer({ textContent: tc, container: tl, viewport: vp, textDivs: [] });
      if (task && task.promise) await task.promise;
    }
  } catch (_) {}
  drawPageHighlights(n, hl, cssW, cssH);
  drawPageTextboxes(n, tb, cssW, cssH);
  tl.addEventListener('mouseup', () => onPdfSelectionMaybe(n, wrap, cssW, cssH));
  wrap.dataset.rendered = '1'; wrap.dataset.rendering = '0';
}

/* ========= PDF crop / area capture + area-highlight (append) ========= */
let pdfCropMode = false;
let cropDrag = null;

function closeCropMenu(){ const m = document.getElementById('pdfCropMenu'); if (m) m.remove(); }
function clearCropRect(){ const r = document.querySelector('.pdf-crop-rect'); if (r) r.remove(); }

function toggleCropMode(){
  pdfCropMode = !pdfCropMode;
  if (pdfCropMode && pdfTextMode) toggleTextMode();
  const body = document.querySelector('.pdf-body');
  if (body) body.classList.toggle('crop-mode', pdfCropMode);
  const b = document.getElementById('pdfCropBtn'); if (b) b.classList.toggle('on', pdfCropMode);
  closeCropMenu(); clearCropRect();
}

/* ========= PDF text-box annotation (plain bordered box) ========= */
let pdfTextMode = false;

function toggleTextMode(){
  pdfTextMode = !pdfTextMode;
  if (pdfTextMode && pdfCropMode) toggleCropMode();
  const body = document.querySelector('.pdf-body');
  if (body) body.classList.toggle('text-mode', pdfTextMode);
  const b = document.getElementById('pdfTextBtn'); if (b) b.classList.toggle('on', pdfTextMode);
}

function pdfTextMousedown(e){
  if (!pdfTextMode || e.button !== 0) return;
  if (e.target.closest && e.target.closest('.pdf-tbox')) return; // edit existing, don't create
  const wrap = e.target.closest && e.target.closest('.pdf-page-wrap');
  if (!wrap) return;
  e.preventDefault();
  const wr = wrap.getBoundingClientRect();
  const page = +wrap.dataset.page;
  const fx = (e.clientX - wr.left) / wr.width;
  const fy = (e.clientY - wr.top) / wr.height;
  const b = { id: pdfHlId(), page, x: Math.max(0, Math.min(fx - 0.04, 0.95)), y: Math.max(0, Math.min(fy - 0.01, 0.97)), w: 0.22, text: '' };
  pdfAnnots.textboxes.push(b);
  savePdfAnnots();
  const layer = wrap.querySelector('.pdf-tboxlayer');
  if (layer) drawPageTextboxes(page, layer, wrap.clientWidth, wrap.clientHeight);
  const el = layer && layer.querySelector('.pdf-tbox[data-tid="' + b.id + '"]');
  if (el){ const body = el.querySelector('.pdf-tbox-body'); if (body) setTimeout(() => { body.focus(); }, 0); }
}

function drawPageTextboxes(pageNum, layer, cssW, cssH){
  layer.innerHTML = '';
  pdfAnnots.textboxes.filter((b) => b.page === pageNum).forEach((b) => {
    layer.appendChild(makeTboxEl(b, cssW, cssH));
  });
}

function makeTboxEl(b, cssW, cssH){
  const el = document.createElement('div');
  el.className = 'pdf-tbox'; el.dataset.tid = b.id;
  el.style.left = (b.x * cssW) + 'px';
  el.style.top = (b.y * cssH) + 'px';
  el.style.width = (b.w * cssW) + 'px';

  const head = document.createElement('div'); head.className = 'pdf-tbox-head'; head.title = t('ลากเพื่อย้าย');
  const body = document.createElement('div'); body.className = 'pdf-tbox-body';
  body.contentEditable = 'true'; body.spellcheck = false;
  body.dataset.ph = t('พิมพ์ที่นี่…');
  body.textContent = b.text || '';

  const del = document.createElement('button'); del.type = 'button';
  del.className = 'pdf-tbox-del'; del.title = t('ลบกล่อง');
  del.innerHTML = icoSvg('x', 'xs');
  del.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.preventDefault(); });
  del.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); removeTbox(b.id); });

  let drag = null;
  head.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const wrap = el.closest('.pdf-page-wrap'); if (!wrap) return;
    const er = el.getBoundingClientRect();
    const offX = ev.clientX - er.left, offY = ev.clientY - er.top;
    drag = { wrap, offX, offY };
    el.classList.add('dragging');
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    function onMove(e){
      if (!drag) return;
      const wr = drag.wrap.getBoundingClientRect();
      let nx = Math.max(0, Math.min(e.clientX - wr.left - drag.offX, wr.width - 12));
      let ny = Math.max(0, Math.min(e.clientY - wr.top - drag.offY, wr.height - 12));
      el.style.left = nx + 'px'; el.style.top = ny + 'px';
    }
    function onUp(){
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      el.classList.remove('dragging');
      if (!drag) return;
      const wr = drag.wrap.getBoundingClientRect();
      b.x = parseFloat(el.style.left) / wr.width;
      b.y = parseFloat(el.style.top) / wr.height;
      drag = null; savePdfAnnots();
    }
  });

  let saveT = null;
  body.addEventListener('input', () => {
    b.text = body.innerText;
    clearTimeout(saveT); saveT = setTimeout(savePdfAnnots, 400);
  });
  body.addEventListener('blur', () => { b.text = body.innerText; clearTimeout(saveT); savePdfAnnots(); });

  el.appendChild(head); el.appendChild(body); el.appendChild(del);
  return el;
}

function removeTbox(id){
  pdfAnnots.textboxes = pdfAnnots.textboxes.filter((b) => b.id !== id);
  savePdfAnnots();
  redrawCurrentPages();
}

function pdfCropMousedown(e){
  if (!pdfCropMode || e.button !== 0) return;
  const wrap = e.target.closest && e.target.closest('.pdf-page-wrap');
  if (!wrap) return;
  e.preventDefault();
  clearCropRect(); closeCropMenu();
  const wr = wrap.getBoundingClientRect();
  const x0 = e.clientX - wr.left, y0 = e.clientY - wr.top;
  const rect = document.createElement('div'); rect.className = 'pdf-crop-rect';
  rect.style.left = x0 + 'px'; rect.style.top = y0 + 'px'; rect.style.width = '0px'; rect.style.height = '0px';
  wrap.appendChild(rect);
  cropDrag = { wrap, x0, y0, rect };
  window.addEventListener('mousemove', pdfCropMousemove, true);
  window.addEventListener('mouseup', pdfCropMouseup, true);
}
function pdfCropMousemove(e){
  if (!cropDrag) return;
  const wr = cropDrag.wrap.getBoundingClientRect();
  let x = e.clientX - wr.left, y = e.clientY - wr.top;
  x = Math.max(0, Math.min(x, wr.width)); y = Math.max(0, Math.min(y, wr.height));
  const left = Math.min(x, cropDrag.x0), top = Math.min(y, cropDrag.y0);
  cropDrag.rect.style.left = left + 'px'; cropDrag.rect.style.top = top + 'px';
  cropDrag.rect.style.width = Math.abs(x - cropDrag.x0) + 'px';
  cropDrag.rect.style.height = Math.abs(y - cropDrag.y0) + 'px';
}
function pdfCropMouseup(){
  window.removeEventListener('mousemove', pdfCropMousemove, true);
  window.removeEventListener('mouseup', pdfCropMouseup, true);
  if (!cropDrag) return;
  const d = cropDrag; cropDrag = null;
  const w = parseFloat(d.rect.style.width), h = parseFloat(d.rect.style.height);
  if (!(w >= 8 && h >= 8)) { d.rect.remove(); return; }
  showCropMenu(d.wrap, d.rect);
}

function showCropMenu(wrap, rect){
  closeCropMenu();
  const page = +wrap.dataset.page;
  const menu = document.createElement('div'); menu.id = 'pdfCropMenu'; menu.className = 'pdf-crop-menu';
  const mk = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = (ev) => { ev.stopPropagation(); fn(); }; menu.appendChild(b); };
  mk(t('ครอปเข้าโน้ต'), () => cropToNote(wrap, rect, page));
  mk(t('ไฮไลต์พื้นที่'), () => areaHighlight(wrap, rect, page));
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'pdf-crop-cancel'; cancel.title = t('ยกเลิก');
  cancel.innerHTML = icoSvg('x', 'xs');
  cancel.onclick = (ev) => { ev.stopPropagation(); rect.remove(); closeCropMenu(); };
  menu.appendChild(cancel);
  document.body.appendChild(menu);
  const rr = rect.getBoundingClientRect();
  const mw = menu.offsetWidth || 220, mh = menu.offsetHeight || 34;
  let left = Math.max(8, Math.min(rr.left, window.innerWidth - mw - 8));
  let top = rr.bottom + 6; if (top + mh > window.innerHeight - 8) top = Math.max(8, rr.top - mh - 6);
  menu.style.left = left + 'px'; menu.style.top = top + 'px';
}

function captureCrop(wrap, rect){
  const canvas = wrap.querySelector('canvas.pdf-page');
  if (!canvas) return null;
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  if (!cw || !ch) return null;
  const sx = (parseFloat(rect.style.left) / cw) * canvas.width;
  const sy = (parseFloat(rect.style.top) / ch) * canvas.height;
  const sw = (parseFloat(rect.style.width) / cw) * canvas.width;
  const sh = (parseFloat(rect.style.height) / ch) * canvas.height;
  const tmp = document.createElement('canvas');
  tmp.width = Math.max(1, Math.round(sw)); tmp.height = Math.max(1, Math.round(sh));
  try { tmp.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height); } catch (_) { return null; }
  try { return tmp.toDataURL('image/png'); } catch (_) { return null; }
}

async function cropToNote(wrap, rect, page){
  const uri = captureCrop(wrap, rect);
  rect.remove(); closeCropMenu();
  if (!uri) { pdfToast(t('ครอปไม่ได้ — หน้ายังไม่เรนเดอร์')); return; }
  if (!currentPdf) return;
  const name = await ensureCompanionNote(currentPdf);
  let content = '';
  try { content = await window.api.readNote(name); } catch (_) {}
  const heading = '### หน้า ' + page;
  const block = '![ครอปหน้า ' + page + '](' + uri + ')';
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === heading);
  if (idx >= 0){
    let end = lines.length;
    for (let i = idx + 1; i < lines.length; i++){ if (/^#{1,6}\s/.test(lines[i])) { end = i; break; } }
    lines.splice(end, 0, block, '');
    content = lines.join('\n');
  } else {
    if (content && !/\n$/.test(content)) content += '\n';
    content += '\n' + heading + '\n\n' + block + '\n';
  }
  await window.api.saveNote(name, content);
  pdfToast(t('ครอปเข้าโน้ตคู่หูแล้ว · หน้า ') + page);
}

function areaHighlight(wrap, rect, page){
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const fr = { x: parseFloat(rect.style.left) / cw, y: parseFloat(rect.style.top) / ch, w: parseFloat(rect.style.width) / cw, h: parseFloat(rect.style.height) / ch };
  rect.remove(); closeCropMenu();
  const h = { id: pdfHlId(), page, color: 'gold', text: '', area: true, rects: [fr] };
  pdfAnnots.highlights.push(h);
  savePdfAnnots();
  redrawPage(page);
  if (annotPanelOpen()) renderAnnotPanel();
  editHlComment(h);   // ponytail: area highlights have no text — prompt for a note by default
}

function addHighlightNote(){
  if (!pendingSel) return;
  const h = { id: pdfHlId(), page: pendingSel.page, color: 'gold', text: pendingSel.text, rects: pendingSel.rects };
  pdfAnnots.highlights.push(h);
  savePdfAnnots();
  redrawPage(pendingSel.page);
  pendingSel = null;
  hideHlBar();
  const sel = window.getSelection(); if (sel) sel.removeAllRanges();
  if (annotPanelOpen()) renderAnnotPanel();
  editHlComment(h);
}

function jumpToHighlight(h){
  if (!h) return;
  const yFrac = (h.rects && h.rects[0]) ? h.rects[0].y : 0;
  pdfScrollToPage(h.page, yFrac, 90);
  flashHighlight(h);
}
function flashHighlight(h){
  let tries = 0;
  const tick = () => {
    const host = pdfPagesEl(); if (!host) return;
    const wrap = host.querySelector('.pdf-page-wrap[data-page="' + h.page + '"]');
    const nodes = wrap ? wrap.querySelectorAll('.pdf-hl[data-hid="' + h.id + '"]') : [];
    if (nodes && nodes.length){
      nodes.forEach((n) => { n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1400); });
    } else if (tries++ < 10){ setTimeout(tick, 150); }
  };
  setTimeout(tick, 250);
}

async function movePdf(pdfRel, folderPath){
  const base = pdfRel.slice(pdfRel.lastIndexOf('/') + 1);
  const to = folderPath ? folderPath + '/' + base : base;
  if (to === pdfRel) return;
  try {
    const comp = companionNoteName(pdfRel);
    const res = await window.api.listNotes();
    const notes = Array.isArray(res) ? res : (res.notes || []);
    if (notes.includes(comp)){
      const cbase = comp.slice(comp.lastIndexOf('/') + 1);
      const cto = folderPath ? folderPath + '/' + cbase : cbase;
      await window.api.renameNote(comp, cto);
    }
  } catch (_) {}
  const r = await window.api.renamePdf(pdfRel, to);
  if (r && r.error === 'exists') { alert(t('มีไฟล์ชื่อนี้อยู่ในกล่องนั้นแล้ว')); await refreshList(currentNote); return; }
  if (r && r.error) { await refreshList(currentNote); return; }
  vsPdfPageRename(pdfRel, to);
  if (currentPdf === pdfRel) currentPdf = to;
  if (pdfLoadedName === pdfRel) pdfLoadedName = null;
  await refreshList(currentNote);
}

/* ================= Sidebar collapsible sections (append) ================= */
var sbDbCache = [];
var sbCompanionMap = {};   // { pdfRel: companionNoteRel } from .annot.json sidecars; name convention is the fallback
var sbSecCollapsed = new Set(vsGet('sbSecCollapsed', []));
function persistSbSec(){ vsSet('sbSecCollapsed', [...sbSecCollapsed]); }

function openDbInView(id){ dbOpenId = id; if (mainView !== 'table'){ setMainView('table'); } else { renderTable(); renderSidebar(); } }
function openDashInView(id){ setCurrentDashId(id); if (mainView !== 'dash'){ setMainView('dash'); } else { renderDash(); renderSidebar(); } }
async function sbNewDb(){
  const db = await window.api.dbCreate({});
  if (!db) return;
  try { sbDbCache = await window.api.dbList(); } catch (_) {}
  openDbInView(db.id); renderSidebar();
}
async function sbNewDash(){
  const nm = await askName(t('ชื่อบอร์ดใหม่'), '');
  const id = createDashboard(nm && nm.trim() ? nm.trim() : undefined);
  openDashInView(id); renderSidebar();
}

function sbGroup(key, iconName, label, opts){
  opts = opts || {};
  const group = document.createElement('div'); group.className = 'sb-group';
  const collapsed = sbSecCollapsed.has(key);
  const gh = document.createElement('div'); gh.className = 'sb-gh';
  const tri = document.createElement('span'); tri.className = 'sb-gtri';
  if (!opts.leaf) tri.innerHTML = icoSvg(collapsed ? 'chev' : 'chevdown', 'xs');
  gh.appendChild(tri);
  // leaf sections (e.g. กราฟ) read as plain labels like the collapsible sections — no icon;
  // the empty .sb-gtri above is the chevron-width spacer so labels line up.
  const nm = document.createElement('span'); nm.className = 'sb-gnm'; nm.textContent = label; gh.appendChild(nm);
  if (opts.count != null){ const ct = document.createElement('span'); ct.className = 'sb-gcount'; ct.textContent = String(opts.count); gh.appendChild(ct); }
  const sp = document.createElement('span'); sp.className = 'sb-gsp'; gh.appendChild(sp);
  if (opts.addLabel){
    const ab = document.createElement('button'); ab.className = 'sb-gadd'; ab.title = opts.addLabel; ab.innerHTML = icoSvg('plus', 'xs');
    ab.onclick = (e) => { e.stopPropagation(); opts.onAdd(); };
    gh.appendChild(ab);
  }
  gh.onclick = () => {
    if (opts.leaf){ if (opts.onLeafClick) opts.onLeafClick(); return; }
    if (sbSecCollapsed.has(key)) sbSecCollapsed.delete(key); else sbSecCollapsed.add(key);
    persistSbSec(); renderSidebar();
  };
  if (opts.leaf && mainView === opts.leafView) gh.classList.add('on');
  group.appendChild(gh);
  const body = document.createElement('div'); body.className = 'sb-gbody';
  if (collapsed || opts.leaf) body.hidden = true;
  group.appendChild(body);
  return { group, body, collapsed };
}

function sbLeafItem(iconName, label, active, onClick, onCtx){
  const it = document.createElement('div'); it.className = 'note-item sb-leaf sb-leaf-' + iconName + (active ? ' active' : '');
  it.innerHTML = '<span class="sb-chevsp"></span>' + icoSvg(iconName, 'sm') + '<span class="sb-leaf-nm"></span>';
  it.querySelector('.sb-leaf-nm').textContent = label;
  it.style.paddingLeft = '8px';
  it.onclick = onClick;
  if (onCtx) it.oncontextmenu = (e) => { e.preventDefault(); onCtx(e); };
  return it;
}

function renderSbDbList(body){
  if (!sbDbCache || !sbDbCache.length){
    const e = document.createElement('div'); e.className = 'sb-empty'; e.textContent = t('ยังไม่มีฐานข้อมูล'); body.appendChild(e); return;
  }
  sbDbCache.forEach((d) => {
    const active = (mainView === 'table' && dbOpenId === d.id);
    body.appendChild(sbLeafItem('db', d.name || t('ฐานข้อมูล'), active, () => openDbInView(d.id)));
  });
}
function renderSbDashList(body){
  ensureDashboards().forEach((b) => {
    const active = (mainView === 'dash' && currentDashId() === b.id);
    body.appendChild(sbLeafItem('dash', b.name, active, () => openDashInView(b.id), (e) => openDashItemMenu(e.clientX, e.clientY, b.id)));
  });
}

function openDashItemMenu(x, y, id){
  if (typeof closeFolderMenu === 'function') closeFolderMenu();
  const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
  const items = [
    [t('เปลี่ยนชื่อ'), async () => {
      const b = ensureDashboards().find((z) => z.id === id);
      const nm = await askName(t('เปลี่ยนชื่อบอร์ด'), b ? b.name : '');
      if (nm && nm.trim()){ renameDashboard(id, nm.trim()); renderSidebar(); if (mainView === 'dash' && currentDashId() === id) renderDash(); }
    }],
    [t('ลบบอร์ด'), async () => {
      if (ensureDashboards().length <= 1){ alert(t('ต้องมีอย่างน้อย 1 บอร์ด')); return; }
      if (!(await confirmDelete(t('ลบบอร์ดนี้?')))) return;
      deleteDashboard(id); renderSidebar(); if (mainView === 'dash') renderDash();
    }]
  ];
  items.forEach(([label, fn]) => {
    const it = document.createElement('div'); it.className = 'db-mi' + (label.startsWith(t('ลบ')) ? ' db-mi-del' : '');
    it.textContent = label; it.onclick = () => { if (typeof closeFolderMenu === 'function') closeFolderMenu(); fn(); }; menu.appendChild(it);
  });
  document.body.appendChild(menu);
  menu.style.top = Math.min(y, window.innerHeight - 100) + 'px';
  menu.style.left = Math.min(x, window.innerWidth - 210) + 'px';
  setTimeout(() => { if (typeof onFolderMenuOutside === 'function') document.addEventListener('mousedown', onFolderMenuOutside, true); }, 0);
}

function renderSidebar(){
  const host = noteList; if (!host) return;
  host.innerHTML = '';
  const n = sbGroup('note', 'note', t('โน้ต'), { count: noteTreeRoot ? countTreeNotes(noteTreeRoot) : 0 });
  host.appendChild(n.group);
  if (!n.collapsed && noteTreeRoot) renderFolderNode(noteTreeRoot, n.body, 0);
  const d = sbGroup('db', 'db', t('ฐานข้อมูล'), { addLabel: t('ฐานข้อมูลใหม่'), onAdd: sbNewDb, count: (sbDbCache || []).length });
  host.appendChild(d.group);
  if (!d.collapsed) renderSbDbList(d.body);
  const b = sbGroup('dash', 'dash', t('แดชบอร์ด'), { addLabel: t('บอร์ดใหม่'), onAdd: sbNewDash, count: ensureDashboards().length });
  host.appendChild(b.group);
  if (!b.collapsed) renderSbDashList(b.body);
  const g = sbGroup('graph', 'graph', t('กราฟ'), { leaf: true, leafView: 'graph', onLeafClick: () => setMainView('graph') });
  host.appendChild(g.group);
}

/* ================= Trash view (ถังขยะ): list + restore + delete-forever ================= */
const TRASH_TYPE_ICON = { note: 'note', pdf: 'book', folder: 'crate', db: 'db' };
const TRASH_TYPE_LABEL = { note: 'โน้ต', pdf: 'เล่ม PDF', folder: 'กล่อง', db: 'ฐานข้อมูล' };
function formatTrashDate(iso){
  const dt = new Date(iso); if (isNaN(dt)) return '';
  const now = new Date(), sameDay = dt.toDateString() === now.toDateString();
  const mins = Math.max(0, Math.round((now - dt) / 60000));
  if (sameDay){
    if (mins < 1) return t('เมื่อสักครู่');
    if (mins < 60) return mins + t(' นาทีที่แล้ว');
    if (mins < 60 * 24) return Math.floor(mins / 60) + t(' ชม.ที่แล้ว');
  }
  return dt.toLocaleString(uiLang === 'en' ? 'en-US' : 'th-TH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function trashOriginLabel(item){
  if (item.type === 'db') return '';
  const slash = (item.origPath || '').lastIndexOf('/');
  const parent = slash >= 0 ? item.origPath.slice(0, slash) : '';
  return t('จาก ') + (parent || t('(ราก)'));
}
async function refreshAfterTrash(){
  try { await refreshList(currentNote); } catch (_) {}        // rebuilds note tree + sidebar (+ sbDbCache inside)
  try { sbDbCache = await window.api.dbList(); } catch (_) {} // keep DB list in sync
  if (typeof renderSidebar === 'function') renderSidebar();
  await renderTrashView();
}
async function renderTrashView(){
  const host = document.getElementById('trashView'); if (!host) return;
  let items = [];
  try { items = await window.api.trashList(); } catch (_) { items = []; }
  host.innerHTML = '';
  const scroll = document.createElement('div'); scroll.className = 'trash-scroll';

  const head = document.createElement('div'); head.className = 'trash-head';
  const title = document.createElement('div'); title.className = 'trash-title';
  title.innerHTML = icoSvg('trash', 'sm') + '<span>' + t('ถังขยะ') + '</span>';
  const sub = document.createElement('div'); sub.className = 'trash-sub';
  sub.textContent = t('รายการที่ลบจะเก็บไว้ที่นี่ · กดกู้คืนเพื่อย้ายกลับที่เดิม');
  const headLeft = document.createElement('div'); headLeft.className = 'trash-head-left';
  headLeft.appendChild(title); headLeft.appendChild(sub);
  const empBtn = document.createElement('button'); empBtn.className = 'ghost trash-empty-btn';
  empBtn.type = 'button'; empBtn.innerHTML = icoSvg('trash', 'xs') + '<span>' + t('ล้างถังขยะทั้งหมด') + '</span>';
  empBtn.disabled = !items.length;
  empBtn.onclick = async () => { if (!(await confirmDelete(t('ล้างถังขยะทั้งหมด? ลบถาวรและกู้คืนไม่ได้')))) return; await window.api.trashEmpty(); await refreshAfterTrash(); };
  head.appendChild(headLeft); head.appendChild(empBtn);
  scroll.appendChild(head);

  if (!items.length){
    const empty = document.createElement('div'); empty.className = 'trash-empty'; empty.textContent = t('ถังขยะว่าง');
    scroll.appendChild(empty); host.appendChild(scroll); return;
  }

  for (const it of items){
    const row = document.createElement('div'); row.className = 'trash-row trash-' + it.type;
    const chip = document.createElement('span'); chip.className = 'trash-chip';
    chip.innerHTML = icoSvg(TRASH_TYPE_ICON[it.type] || 'note', 'sm');
    const main = document.createElement('div'); main.className = 'trash-main';
    const nm = document.createElement('div'); nm.className = 'trash-nm'; nm.textContent = it.name || t('(ไม่มีชื่อ)');
    const meta = document.createElement('div'); meta.className = 'trash-meta';
    const parts = [t(TRASH_TYPE_LABEL[it.type] || 'รายการ')];
    const org = trashOriginLabel(it); if (org) parts.push(org);
    parts.push(t('ลบเมื่อ ') + formatTrashDate(it.deletedAt));
    meta.textContent = parts.join(' · ');
    main.appendChild(nm); main.appendChild(meta);

    const restore = document.createElement('button'); restore.className = 'ghost trash-restore';
    restore.type = 'button'; restore.innerHTML = '<span>' + t('↩ กู้คืน') + '</span>';
    restore.onclick = async () => { await window.api.trashRestore(it.id); await refreshAfterTrash(); };
    const del = document.createElement('button'); del.className = 'ghost trash-forever';
    del.type = 'button'; del.textContent = t('ลบถาวร');
    del.onclick = async () => { if (!(await confirmDelete(t('ลบ "') + (it.name || '') + t('" ถาวร? กู้คืนไม่ได้')))) return; await window.api.trashDeleteForever(it.id); await refreshAfterTrash(); };

    row.appendChild(chip); row.appendChild(main); row.appendChild(restore); row.appendChild(del);
    scroll.appendChild(row);
  }
  host.appendChild(scroll);
}
