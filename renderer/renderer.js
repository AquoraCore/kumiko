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

// AI chat multi-session module moved to renderer/chat.js

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
let collabDoc = null;  // the current note's Y.Doc when collab is active; null otherwise
let collabProvider = null;  // the current note's y-websocket provider when collab is active; null otherwise
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
// Per-vault collab opt-in (default off). The test hook forces it on regardless of state.
function collabEnabled(){ return !!(window.MilkdownCollab && window.Y) && (vsGet('collab', false) === true || !!(window.__WASHI_TEST_COLLAB)); }
// Relay URL: env override (test / future setting) → localStorage → default local relay.
function collabRelayUrl(){ return (window.api && window.api.collabRelay) || localStorage.getItem('collabRelay') || 'ws://127.0.0.1:1234'; }
// Stable-ish local identity (ephemeral, no auth yet). Color picked deterministically per install
// (NOT Math.random) so it stays the same across reloads; name defaults to the UI name.
function collabIdentity(){
  let id = localStorage.getItem('collabIdentity');
  if (id) { try { return JSON.parse(id); } catch (_) {} }
  const palette = ['#E2542A','#3B82C4','#8B5CB8','#2E9E6B','#D98A1E','#C0433F'];
  const pick = palette[(localStorage.length + 3) % palette.length];
  const who = { name: (localStorage.getItem('uiName') || 'ฉัน'), color: pick };
  localStorage.setItem('collabIdentity', JSON.stringify(who));
  return who;
}
// Render the collab presence bar (status pill + peer avatars). No-op when collab is
// OFF or the provider is gone — the bar stays hidden so the default editor is unchanged.
function renderCollabBar(){
  const bar = document.getElementById('collabBar');
  if (!bar) return;
  const statusEl = document.getElementById('collabStatus');
  const presenceEl = document.getElementById('collabPresence');
  if (!collabProvider || !collabProvider.awareness) {
    bar.hidden = true;
    if (statusEl) { statusEl.className = 'collab-status'; statusEl.textContent = ''; }
    if (presenceEl) presenceEl.innerHTML = '';
    return;
  }
  bar.hidden = false;
  // STATUS PILL — derived from the provider's wsconnected / synced flags.
  let tone = 'off', label = t('ออฟไลน์');
  try {
    const connected = !!collabProvider.wsconnected;
    const connecting = !!collabProvider.wsconnecting;
    const synced = !!collabProvider.synced;
    if (connected && synced) { tone = 'ok'; label = t('ซิงก์แล้ว'); }
    else if (connecting || (connected && !synced)) { tone = 'sync'; label = t('กำลังซิงก์…'); }
  } catch (_) {}
  if (statusEl) { statusEl.className = 'collab-status ' + tone; statusEl.textContent = label; }
  // PRESENCE AVATARS — one circle per peer (excluding ourselves), capped at 5.
  if (presenceEl) {
    const me = collabProvider.awareness.clientID;
    const peers = [];
    try {
      collabProvider.awareness.getStates().forEach((st, cid) => {
        if (cid === me) return;
        if (st && st.user && st.user.name) peers.push(st.user);
      });
    } catch (_) {}
    const shown = peers.slice(0, 5);
    const rest = peers.length - shown.length;
    presenceEl.innerHTML = '';
    shown.forEach((u) => {
      const av = document.createElement('span');
      av.className = 'collab-av';
      av.style.background = u.color || '#888';
      av.title = u.name;
      av.textContent = String(u.name).charAt(0).toUpperCase();
      presenceEl.appendChild(av);
    });
    if (rest > 0) {
      const more = document.createElement('span');
      more.className = 'collab-av more';
      more.textContent = '+' + rest;
      presenceEl.appendChild(more);
    }
  }
}
async function loadEditor(bodyMarkdown){
  applying = true;
  if (crepe) { try { await crepe.destroy(); } catch (_) {} crepe = null; }
  if (collabProvider) { try { collabProvider.destroy(); } catch (_) {} collabProvider = null; }  // provider BEFORE doc
  if (collabDoc) { try { collabDoc.destroy(); } catch (_) {} collabDoc = null; }
  document.body.removeAttribute('data-collab');   // clear the connection status hook (6c-3b will style it)
  renderCollabBar();                              // hide the presence bar until a provider is wired (covers !collabOn + teardown)
  editorHost.innerHTML = '';
  const collabOn = collabEnabled();
  // Disable Crepe's virtual cursor — it renders invisible inside callout boxes.
  // The real browser caret (visible everywhere) is used instead.
  const feat = (window.Crepe.Feature && window.Crepe.Feature.Cursor) || 'cursor';
  crepe = new window.Crepe({ root: editorHost, defaultValue: collabOn ? '' : stripLeadingH1(bodyMarkdown), features: { [feat]: false } });
  if (window.MDHeadingFold) { try { crepe.editor.use(window.MDHeadingFold); } catch (_) {} }
  if (window.MDWikiLink) { try { crepe.editor.use(window.MDWikiLink); } catch (_) {} }
  if (collabOn) { try { crepe.editor.use(window.MilkdownCollab.collab); } catch (_) {} }
  await crepe.create();
  if (collabOn) {
    const tpl = stripLeadingH1(bodyMarkdown) || '';
    try {
      collabDoc = new window.Y.Doc();
      const room = currentNote || 'untitled';
      try {
        // WebSocket is native in the renderer — no polyfill needed. A ctor failure
        // (or an unreachable relay) leaves collabProvider null; the editor keeps working
        // offline and the provider retries in the background once it exists.
        collabProvider = new window.WebsocketProvider(collabRelayUrl(), room, collabDoc);
        const me = collabIdentity();
        collabProvider.awareness.setLocalStateField('user', { name: me.name, color: me.color });
        collabProvider.on('status', (e) => {
          document.body.setAttribute('data-collab', String((e && e.status) || 'unknown'));
          renderCollabBar();
        });
        collabProvider.on('sync', () => renderCollabBar());
        collabProvider.awareness.on('change', () => renderCollabBar());
        renderCollabBar();
      } catch (_) { collabProvider = null; }
      crepe.editor.action((ctx) => {
        const svc = ctx.get(window.MilkdownCollab.collabServiceCtx);
        svc.bindDoc(collabDoc);
        if (collabProvider) svc.setAwareness(collabProvider.awareness);
        svc.connect();
      });
      // Seed the note's disk content ONLY when the room is empty, so a second client
      // joining a populated room does NOT re-seed and duplicate the shared text.
      // applyTemplate's own empty-doc guard makes it a no-op once remote content has
      // arrived. We defer the seed until the first 'synced' (or a short offline
      // timeout) so the room state is known before we decide. ponytail: a provider
      // ctor failure (collabProvider null) seeds now so the editor still shows the note.
      if (tpl) {
        const seed = () => { try { crepe.editor.action((ctx) => { ctx.get(window.MilkdownCollab.collabServiceCtx).applyTemplate(tpl); }); } catch (_) {} };
        if (collabProvider) {
          let done = false;
          const run = () => { if (done) return; done = true; seed(); };
          collabProvider.once('synced', run);            // room state known → seed only if still empty
          setTimeout(run, 1200);                          // relay unreachable / no sync in 1.2s → seed offline
        } else {
          seed();
        }
      }
    } catch (e) {
      if (collabProvider) { try { collabProvider.destroy(); } catch (_) {} } collabProvider = null;
      if (collabDoc) { try { collabDoc.destroy(); } catch (_) {} } collabDoc = null;
      /* fall back: editor still usable */
    }
  }
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

// Per-vault state module moved to renderer/state.js

// Sidebar folder-tree module moved to renderer/sidebar.js

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
// DB view module moved to renderer/db.js
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

  // COLLAB toggle — per-vault opt-in (default OFF). Real-time co-editing via a
  // relay; experimental. Reads the same vsGet('collab') the editor gates on.
  const collabHeadRow=document.createElement('div'); collabHeadRow.className='ai-rag-row';
  const collabHead=document.createElement('span'); collabHead.className='ai-rag-lab'; collabHead.textContent=t('การทำงานร่วมกัน (ทดลอง)');
  collabHeadRow.appendChild(collabHead); card.appendChild(collabHeadRow);
  const collabRow=document.createElement('div'); collabRow.className='ai-rag-row';
  const collabCk=document.createElement('input'); collabCk.type='checkbox'; collabCk.id='aiCollabToggle'; collabCk.checked=vsGet('collab', false);
  const collabLab=document.createElement('label'); collabLab.setAttribute('for','aiCollabToggle'); collabLab.className='ai-rag-lab'; collabLab.textContent=t('เปิดการแก้ไขร่วมกันแบบเรียลไทม์ (collab)');
  collabRow.appendChild(collabCk); collabRow.appendChild(collabLab); card.appendChild(collabRow);
  const collabHint=document.createElement('p'); collabHint.className='ai-rag-hint'; collabHint.textContent=t('แก้โน้ตพร้อมกันหลายเครื่องผ่านเซิร์ฟเวอร์ relay — ทดลอง, เฉพาะ vault นี้ (ต้องรีโหลดหลังเปลี่ยน)');
  card.appendChild(collabHint);
  // relay URL — app-wide (localStorage). Default matches collabRelayUrl()'s fallback.
  const relayRow=document.createElement('div'); relayRow.className='ai-rag-row';
  const relayLab=document.createElement('label'); relayLab.setAttribute('for','aiCollabRelay'); relayLab.className='ai-rag-lab'; relayLab.textContent=t('ที่อยู่ relay');
  const relayInput=document.createElement('input'); relayInput.type='text'; relayInput.id='aiCollabRelay'; relayInput.className='ai-collab-relay'; relayInput.placeholder='ws://127.0.0.1:1234'; relayInput.value=localStorage.getItem('collabRelay') || 'ws://127.0.0.1:1234';
  relayRow.appendChild(relayLab); relayRow.appendChild(relayInput); card.appendChild(relayRow);

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
    const collabOn = document.getElementById('aiCollabToggle').checked;
    vsSet('collab', collabOn);
    const relay = (document.getElementById('aiCollabRelay').value || '').trim();
    if (relay) localStorage.setItem('collabRelay', relay); else localStorage.removeItem('collabRelay');
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

// Dashboard module moved to renderer/dashboard.js

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

// PDF viewer/annotate module moved to renderer/pdf.js

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
