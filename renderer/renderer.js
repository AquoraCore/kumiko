// markdown rendering lives in core/markdown.js (loaded before this file); pull the pure fns from the global.
const { mdToHtml, _mdInline, _mdEsc } = window.CoreMarkdown;
const { parseFrontmatter, serializeFrontmatter } = window.CoreFrontmatter;
const { _lcsOps, diffSegments, addLinesFromText, mergeSegments } = window.CoreTextDiff;
const { _lev, _sim } = window.CoreTextSim;
const { composeRagPrompt } = window.CoreRag;

// ---------- Engine switcher ----------
const engineSelect = document.getElementById('engineSelect');
const modelSelect = document.getElementById('modelSelect');

let currentEngine = localStorage.getItem('engine') || 'glm';
let currentModel = localStorage.getItem('glmModel') || 'glm-5.2';

function applyEngineUI() {
  engineSelect.value = currentEngine;
  modelSelect.value = currentModel;
  modelSelect.hidden = currentEngine !== 'glm';
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

// AI chat multi-session module moved to renderer/chat.js

// ---------- Editor / notes ----------
const editorHost = document.getElementById('editorHost');

// (removed 2026-08-26) installBlockHandleCentering — a legacy hack that re-centred Crepe's
// block handle by matching its `top` against TOP-LEVEL blocks only. On nested list items it
// matched the whole outer <ul> and shoved the handle to that list's vertical centre (log:
// "จุดหกจุดแสดงผิดตอน indent", off by +161px). Current Crepe positions the handle correctly
// on its own (top/left via floating-ui + placement left/left-start) — no correction needed.

// Callout colour palette — a floating swatch bar that appears when the caret is inside a
// blockquote (callout). Swatches call the bundle's window.__calloutSetColor(hex), which
// writes a `[!#hex]` marker into the callout's first line (persists in markdown); '' clears.
function installCalloutPalette(root){
  const COLORS = ['#ef4444','#f59e0b','#22c55e','#3b82f6','#a855f7','#94a3b8'];
  const bar = document.createElement('div'); bar.className = 'callout-palette'; bar.hidden = true;
  COLORS.forEach((c) => {
    const b = document.createElement('button'); b.type='button'; b.className='callout-sw'; b.style.background=c; b.dataset.c=c; b.title=c;
    b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); if (window.__calloutSetColor) window.__calloutSetColor(c); requestAnimationFrame(reposition); });
    bar.appendChild(b);
  });
  const clr = document.createElement('button'); clr.type='button'; clr.className='callout-sw none'; clr.title=t('ไม่มีสี'); clr.textContent='×';
  clr.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); if (window.__calloutSetColor) window.__calloutSetColor(''); bar.hidden = true; });
  bar.appendChild(clr);
  document.body.appendChild(bar);
  function currentBq(){
    const sel = window.getSelection && window.getSelection();
    if (!sel || !sel.anchorNode) return null;
    const el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    const bq = el && el.closest && el.closest('blockquote');
    return (bq && root.contains(bq)) ? bq : null;
  }
  function reposition(){
    const bq = currentBq();
    const info = (bq && window.__calloutCurrent) ? window.__calloutCurrent() : { inCallout: false, color: null };
    if (!bq || !info.inCallout){ bar.hidden = true; return; }
    bar.hidden = false;
    const r = bq.getBoundingClientRect();
    bar.style.left = Math.round(r.right - bar.offsetWidth - 6) + 'px';
    bar.style.top = Math.round(r.top + 6) + 'px';
    bar.querySelectorAll('.callout-sw').forEach((s) => s.classList.toggle('active', !!(info.color && s.dataset.c && s.dataset.c.toLowerCase() === String(info.color).toLowerCase())));
  }
  document.addEventListener('selectionchange', () => requestAnimationFrame(reposition));
  root.addEventListener('keyup', () => requestAnimationFrame(reposition));
  window.addEventListener('scroll', () => requestAnimationFrame(reposition), true);
}
if (editorHost) installCalloutPalette(editorHost);
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
// Auth HTTP base derived from the collab relay WS url (same server, http scheme).
function collabHttpBase(){ return collabRelayUrl().replace(/^wss:/,'https:').replace(/^ws:/,'http:').replace(/\/+$/,''); }
// Local collab identity (offline first, phase 7b-1). Name + color the user
// chose in AI Settings; read fresh each call so a Save is picked up with no
// stale cache. No random pick — the palette default is stable until set.
function collabIdentity(){
  const palette = ['#E2542A','#3B82C4','#8B5CB8','#2E9E6B','#D98A1E','#C0433F'];
  const name = (localStorage.getItem('collabName') || '').trim() || 'ฉัน';
  const color = localStorage.getItem('collabColor') || palette[0];
  return { name, color };
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
  const _crepeCfg = { root: editorHost, defaultValue: collabOn ? '' : stripLeadingH1(bodyMarkdown), features: { [feat]: false },
    featureConfigs: { 'block-edit': { blockHandle: {
      // handle sits vertically CENTRED on single-line rows (≤60px), top-aligned on tall blocks
      getPlacement: ({ active }) => {
        try {
          const r = active.el.getBoundingClientRect();
          const place = r.height <= 60 ? 'left' : 'left-start';
          window.__lastPlacement = { h: r.height, top: r.top, place, node: active.node.type.name };
          return place;
        } catch (_) { return 'left-start'; }
      },
    } } } };
  // mermaid appears in the code-block language picker (list built in crepe-entry)
  if (window.MDCodeLangs && window.Crepe.Feature && window.Crepe.Feature.CodeMirror) {
    _crepeCfg.featureConfigs = Object.assign({}, _crepeCfg.featureConfigs, { [window.Crepe.Feature.CodeMirror]: { languages: window.MDCodeLangs } });   // MERGE — a plain assignment silently wiped the block-edit config
  }
  crepe = new window.Crepe(_crepeCfg);
  if (window.MDHeadingFold) { try { crepe.editor.use(window.MDHeadingFold); } catch (_) {} }
  if (window.MDWikiLink) { try { crepe.editor.use(window.MDWikiLink); } catch (_) {} }
  if (window.MDCalloutColor) { try { crepe.editor.use(window.MDCalloutColor); } catch (_) {} }
  if (window.MDTColor) { try { crepe.editor.use(window.MDTColor); } catch (_) {} }         // inline `{c:name}…{/c}` colour
  if (window.MDLinkPaste) { try { crepe.editor.use(window.MDLinkPaste); } catch (_) {} }   // select + paste URL → link
  if (window.MDExposeView) { try { crepe.editor.use(window.MDExposeView); } catch (_) {} } // window.__pmView for diagnostics
  if (window.MDMermaid) { try { crepe.editor.use(window.MDMermaid); } catch (_) {} }
  if (collabOn) { try { crepe.editor.use(window.MilkdownCollab.collab); } catch (_) {} }
  await crepe.create();
  if (collabOn) {
    const tpl = stripLeadingH1(bodyMarkdown) || '';
    try {
        collabDoc = new window.Y.Doc();
        // Fetch auth ONCE up front: token drives the WS param, email scopes the room name
        // (V2.3) so different users — or the same user's two vaults — with a same-named
        // note never share one room. Same user on web + desktop still share.
        let __acc = null; try { __acc = await window.api.authGetToken(); } catch (_) {}
        const __authTok = (__acc && __acc.token) || null;
        const room = window.CoreCollabRoom.collabRoomName(__acc && __acc.email, currentNote);
        try {
          // WebSocket is native in the renderer — no polyfill needed. A ctor failure
          // (or an unreachable relay) leaves collabProvider null; the editor keeps working
          // offline and the provider retries in the background once it exists.
          // Phase 7b-4: if the user logged in, pass the auth token as a WS query param so
          // JWT-gated relays accept the connection. Standalone relays ignore the extra param.
          collabProvider = new window.WebsocketProvider(collabRelayUrl(), room, collabDoc,
            __authTok ? { params: { token: __authTok } } : undefined);
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
    scheduleAutosave();
    updateRulesMeter();
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
// "/" cannot live in a file name — it's the folder separator, so "ใบลดหนี้/Credit note" used
// to silently spawn a folder. Name fields swap it for the visually identical FRACTION SLASH
// (⁄ U+2044) so the title stays ONE file (user request 2026-08-25).
function nameNoSlash(s){
  const raw = String(s || '');
  const name = raw.replace(/\//g, '⁄');
  if (name !== raw && typeof pdfToast === 'function') pdfToast(t('ใช้ ⁄ แทน / ในชื่อ — เครื่องหมาย / คือตัวแบ่งกล่อง'));
  return name;
}
// The new-note popover doubles as a path field ("กล่อง/ชื่อ" targets a box) — keep that ONLY
// when everything before the last "/" is a box that actually exists; otherwise the slash is
// part of the intended title and gets the ⁄ treatment. Pure so it's unit-testable.
function resolveTypedName(input, folders){
  const s = String(input || '').trim();
  if (!s.includes('/')) return { dir: '', name: s, converted: false };
  const i = s.lastIndexOf('/');
  const dir = s.slice(0, i).replace(/\/+$/, '');
  const rest = s.slice(i + 1).trim();
  if (rest && dir && (folders || []).indexOf(dir) >= 0) return { dir, name: rest.replace(/\//g, '⁄'), converted: false };
  return { dir: '', name: s.replace(/\//g, '⁄'), converted: true };
}
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

// Quick-create popover (design "Option B", 2026-08-19): anchored under the + button.
// The CURRENT box (กล่อง — the app's crate metaphor) is a chip prefix; Enter creates there.
// The switcher below changes level; typing "กล่อง/ชื่อ" overrides with an explicit path.
function openNewNotePopover(anchor, kind){
  kind = kind === 'box' ? 'box' : 'note';   // same aligned popover creates NOTES and BOXES
  const old = document.getElementById('nnPop'); if (old) { old.remove(); return; }
  let box = (typeof currentFolder === 'function') ? currentFolder() : '';
  const pop = document.createElement('div'); pop.id = 'nnPop'; pop.className = 'nn-pop';
  const row = document.createElement('div'); row.className = 'nn-row';
  const chip = document.createElement('span'); chip.className = 'nn-chip';
  const chipNm = document.createElement('span');
  const syncChip = () => { chip.innerHTML = icoSvg('crate', 'xs'); chipNm.textContent = box ? box.split('/').pop() : t('Vault'); chip.appendChild(chipNm); };
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'nn-inp';
  inp.placeholder = kind === 'box' ? t('ชื่อกล่องใหม่…') : t('ชื่อโน้ตใหม่…');
  row.appendChild(chip); row.appendChild(inp);
  const hint = document.createElement('div'); hint.className = 'nn-hint';
  hint.textContent = kind === 'box' ? t('Enter สร้างกล่องในระดับที่เลือก · Esc ปิด') : t('Enter สร้าง · พิมพ์ กล่อง/ชื่อ เพื่อระบุเอง · Esc ปิด');
  const list = document.createElement('div'); list.className = 'nn-list';
  pop.appendChild(row); pop.appendChild(hint); pop.appendChild(list);
  const close = () => { pop.remove(); document.removeEventListener('mousedown', onOut, true); };
  const onOut = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const create = async () => {
    const n0 = inp.value.trim(); if (!n0) return;
    const rs = resolveTypedName(n0, window.__wlFolders || []);
    if (rs.converted && typeof pdfToast === 'function') pdfToast(t('ใช้ ⁄ แทน / ในชื่อ — เครื่องหมาย / คือตัวแบ่งกล่อง'));
    const target = rs.dir ? rs.dir + '/' + rs.name : (box ? box + '/' + rs.name : rs.name);
    if (kind === 'box') {
      const r = await window.api.folderCreate(target);
      if (r && r.error === 'exists') { alert(t('มีกล่องชื่อนี้อยู่แล้ว')); return; }
      try { collapsedFolders.delete(target); } catch (_) {}
      close();
      await refreshList(currentNote);
      try { if (typeof pdfToast === 'function') pdfToast(t('สร้างกล่อง ') + target + t(' แล้ว')); } catch (_) {}
      return;
    }
    const r = await window.api.createNote(target);
    if (r && r.error === 'exists') { alert(t('มีโน้ตชื่อนี้อยู่แล้ว')); return; }
    close();
    await refreshList(r && r.name);
  };
  const mkRow = (label, value, opts) => {
    const it = document.createElement('div');
    it.className = 'nn-item' + ((opts && opts.cls) || '') + ((value === box && !(opts && opts.noOn)) ? ' on' : '');
    it.innerHTML = icoSvg('crate', 'xs');
    const nm = document.createElement('span'); nm.className = 'nn-nm'; nm.textContent = label; it.appendChild(nm);
    if (opts && opts.badge) { const b = document.createElement('span'); b.className = 'nn-badge'; b.textContent = opts.badge; it.appendChild(b); }
    it.onmousedown = (e) => {
      e.preventDefault();
      if (opts && opts.pick) { opts.pick(); return; }
      box = value; syncChip(); renderList(); inp.focus();
    };
    list.appendChild(it);
  };
  const renderList = () => {
    list.innerHTML = '';
    const cur = (typeof currentFolder === 'function') ? currentFolder() : '';
    if (cur) mkRow(cur, cur, { badge: t('ระดับที่เปิดอยู่') });
    mkRow(t('Vault (ระดับบนสุด)'), '');
    (window.__wlFolders || []).filter((f) => f !== cur).slice(0, 12).forEach((f) => mkRow(f, f));
    // in box mode the whole popover already IS "create a box" — the extra row is noise
    if (kind !== 'box') mkRow(t('กล่องใหม่…'), null, { cls: ' nn-new', noOn: true, pick: async () => {
      const nm = await askName(t('ตั้งชื่อกล่องใหม่'), '');
      if (!nm || !nm.trim()) { inp.focus(); return; }
      const rel = (box ? box + '/' : '') + nm.trim();
      try { await window.api.folderCreate(rel); await refreshList(currentNote); } catch (_) {}
      box = rel; syncChip(); renderList(); inp.focus();
    } });
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); create(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  syncChip(); renderList();
  document.body.appendChild(pop);
  let r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (!r || (r.width === 0 && r.height === 0)) {   // hidden anchor (#newNoteBtn stub) → use the visible + button
    const alt = document.getElementById('newMenuBtn');
    r = (alt && alt.getBoundingClientRect().width) ? alt.getBoundingClientRect() : { left: 12, bottom: 40, top: 40 };
  }
  const pw = pop.offsetWidth || 300, ph = pop.offsetHeight || 200;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);   // open upward when no room below
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  setTimeout(() => { document.addEventListener('mousedown', onOut, true); inp.focus(); }, 0);
}
document.getElementById('newNoteBtn').onclick = () => openNewNotePopover(document.getElementById('newNoteBtn'));
// rename an arbitrary note (by rel path) — preserves folder + .md extension
async function renameNoteAt(rel){
  if (!rel) return;
  const cur = rel.replace(/\.md$/i, '').split('/').pop();
  const nm = await askName(t('เปลี่ยนชื่อโน้ต'), cur);
  if (!nm || !nm.trim() || nm.trim() === cur) return;
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  let to = nameNoSlash(nm.trim()); if (!/\.md$/i.test(to)) to += '.md';
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
      row.className = 'sr-item' + (hit.pdf ? ' sr-pdf' : '');
      const b = document.createElement('b');
      // a hit inside a PDF's shadow text is shown AS the PDF (book icon + page), never as PDF-Text/
      b.textContent = hit.pdf ? '📕 ' + hit.pdf + (hit.page ? ' · ' + t('หน้า ') + hit.page : '') : (hit.name + (hit.line ? ':' + hit.line : ''));
      const snip = document.createElement('span');
      snip.textContent = ' : ' + hit.snippet;
      row.appendChild(b);
      row.appendChild(snip);
      row.onclick = async () => {
        if (hit.pdf) {
          const rel = (window.__wlPdfRel || {})[hit.pdf.toLowerCase()];
          if (rel) { try { await window.__wikiNav(rel + (hit.page ? '#p' + hit.page : '')); } catch (_) { await openPdf(rel); } }
        } else {
          await openNote(hit.name);
        }
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

// Wikilink click navigation — resolves a [[name]] (basename, no .md) to an actual note and opens it.
// Called from the Crepe wikiLink plugin's handleClick via window.__wikiNav(rawName).
window.__wikiNav = async (name) => {
  try {
    // "<rel>.pdf#pN" = jump back to page N of that PDF (clip-attribution links)
    const pm = String(name).match(/^(.+\.pdf)#p(\d+)$/i);
    if (pm) {
      const rel = pm[1], page = parseInt(pm[2], 10);
      if (typeof openPdf === 'function') {
        await openPdf(rel);
        setTimeout(() => { try { if (typeof pdfGoto === 'function') pdfGoto(page); } catch (_) {} }, 350);
      }
      return;
    }
    const key = String(name).toLowerCase().replace(/\.md$/, '');
    const l = await window.api.listNotes();
    const notes = (l && l.notes) || [];
    let target = notes.find((p) => p.replace(/\.md$/i, '').split('/').pop().toLowerCase() === key);
    if (!target) return;                          // no such note -> do nothing (no crash)
    await openNote(target);
  } catch (_) {}
};

async function save() {
  if (!currentNote) return;
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  await window.api.saveNote(currentNote, getFullMarkdown());
  setDirty(false);
  if (window.syncSoon) window.syncSoon();
  if (typeof tagIndexChanged === 'function') { clearTimeout(window.__tagIxTimer); window.__tagIxTimer = setTimeout(() => { tagIndexChanged(); }, 600); }
}
// ---------- Autosave ----------
// Debounced: every edit reschedules a save ~1s later, so notes persist without ⌘S.
// flushAutosave() forces a pending save NOW — called before switching notes (openNote)
// so edits never bleed into the next note or get lost on switch. ⌘S still works.
let _autosaveTimer = null;
function scheduleAutosave() {
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => { _autosaveTimer = null; if (dirty && currentNote) save(); }, 1000);
}
async function flushAutosave() {
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  if (dirty && currentNote) await save();
}
window.flushAutosave = flushAutosave;
// Best-effort flush when the app/tab closes (async can't be awaited here, but the
// desktop IPC / web HTTP save usually lands before teardown).
window.addEventListener('beforeunload', () => { try { if (dirty && currentNote) window.api.saveNote(currentNote, getFullMarkdown()); } catch (_) {} });
document.getElementById('saveBtn').onclick = save;
window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openQuickAsk(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
});

// ---------- Properties bar (status + tags via frontmatter) ----------
// Obsidian-style tags: user-defined chips with autocomplete drawn from every note's tags.
// Still stored in frontmatter as a comma string (CoreTags handles parse/serialise), so it's
// fully back-compatible with the old plain-text field.
const TagsUI = (function installTagsEditor(){
  const bar = document.getElementById('tagsBar');
  if (!bar || !window.CoreTags) return { setTags(){}, getTags(){ return []; }, refreshGhosts(){} };
  const CT = window.CoreTags;
  let tags = [];
  let acEl = null;
  // "+ แท็ก" affordance: the input is hidden until the user wants to add (the bar reads as chips, not a form)
  const addBtn = document.createElement('button'); addBtn.type = 'button'; addBtn.className = 'tg-add'; addBtn.innerHTML = icoSvg('plus', 'xs') + '<span></span>'; addBtn.querySelector('span').textContent = t('แท็ก');
  const input = document.createElement('input');
  input.type = 'text'; input.className = 'tags-input'; input.placeholder = t('ชื่อแท็ก… (Enter)'); input.hidden = true;
  addBtn.onclick = async () => { input.hidden = false; addBtn.hidden = true; input.focus(); };
  const hasTag = (x) => tags.some((tg) => tg.toLowerCase() === x.toLowerCase());
  function commit(raw){
    const v = window.CoreTagIndex ? window.CoreTagIndex.norm(raw) : String(raw || '').trim().replace(/^#/, '');
    if (v && !hasTag(v)) { tags.push(v); render(); applyProps(); }
    input.value = ''; closeAc();
  }
  function removeAt(i){ tags.splice(i, 1); render(); applyProps(); }
  function hideInput(){ input.hidden = true; addBtn.hidden = false; input.value = ''; }
  function render(){
    bar.querySelectorAll('.tg-chip').forEach((c) => c.remove());
    tags.forEach((tg, i) => {
      const chip = tagChipEl(tg, { onX: () => removeAt(i), onClick: () => { if (typeof openTagView === 'function') openTagView(tg); }, title: t('คลิก = เปิดหน้าแท็ก · คลิกขวา = เมนู') });
      bar.insertBefore(chip, addBtn);
    });
    refreshGhosts();
  }
  // body #tags (from the index) that are NOT in frontmatter — dashed chips; click = keep as a real tag
  function refreshGhosts(){
    bar.querySelectorAll('.tg-chip.ghost').forEach((c) => c.remove());
    if (!currentNote || typeof tagIndex !== 'function') return;
    const ix = tagIndex(); const list = (ix && ix.byNote[currentNote]) || [];
    list.filter((x) => x.source === 'body' && !hasTag(x.name)).forEach((x) => {
      const chip = tagChipEl(x.name, { ghost: true, suffix: t('ในเนื้อหา'), title: t('พบ #' + x.name + ' ในเนื้อโน้ต — คลิกเพื่อเก็บเป็นแท็กถาวร'), onClick: () => commit(x.name) });
      bar.insertBefore(chip, addBtn);
    });
  }
  function closeAc(){ if (acEl){ acEl.remove(); acEl = null; } }
  function openAc(){
    closeAc();
    const ix = (typeof tagIndex === 'function') ? tagIndex() : null;
    const pool = ix ? ix.pool : [];
    const q = input.value.trim().replace(/^#/, '');
    const sugg = CT.suggestTags(pool, q, tags, 8);
    acEl = document.createElement('div'); acEl.className = 'tags-ac';
    sugg.forEach((sg) => {
      const e = ix && ix.tags[window.CoreTagIndex.key(sg)];
      const b = tagChipEl(sg, { button: true, cls: 'tags-ac-item', count: e ? e.count : undefined });
      b.onmousedown = (ev) => { ev.preventDefault(); commit(sg); };
      acEl.appendChild(b);
    });
    if (q && !sugg.some((x) => x.toLowerCase() === q.toLowerCase()) && !hasTag(q)) {
      const nb = document.createElement('button'); nb.type = 'button'; nb.className = 'tags-ac-new'; nb.textContent = '+ ' + t('สร้าง') + ' #' + q;
      nb.onmousedown = (ev) => { ev.preventDefault(); commit(q); }; acEl.appendChild(nb);
    }
    if (!acEl.children.length) { closeAc(); return; }
    const r = input.getBoundingClientRect();
    acEl.style.left = r.left + 'px'; acEl.style.top = (r.bottom + 4) + 'px'; acEl.style.minWidth = Math.max(220, r.width) + 'px';
    document.body.appendChild(acEl);
  }
  input.addEventListener('focus', async () => { if (typeof refreshTagIndex === 'function') await refreshTagIndex(); openAc(); });
  input.addEventListener('input', openAc);
  input.addEventListener('blur', () => setTimeout(() => { closeAc(); if (!input.value.trim()) hideInput(); }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(input.value); }
    else if (e.key === 'Backspace' && !input.value && tags.length) { removeAt(tags.length - 1); }
    else if (e.key === 'Escape') { closeAc(); hideInput(); }
  });
  bar.appendChild(addBtn); bar.appendChild(input);
  return {
    setTags(arr){ tags = CT.parseTags((arr || []).join(',')); render(); },
    getTags(){ return tags.slice(); },
    refreshGhosts,
  };
})();

function loadPropsBar(){
  document.getElementById('statusSelect').value = currentAttrs.status || '';
  TagsUI.setTags(window.CoreTags ? window.CoreTags.parseTags(currentAttrs.tags) : []);
}
function applyProps(){
  if(!currentNote) return;
  const status=document.getElementById('statusSelect').value;
  const tags = window.CoreTags ? window.CoreTags.serializeTags(TagsUI.getTags()) : '';
  if(status) currentAttrs.status=status; else delete currentAttrs.status;
  if(tags) currentAttrs.tags=tags; else delete currentAttrs.tags;
  setDirty(true);
  save();
}
document.getElementById('statusSelect').onchange = applyProps;

// live reload from Claude / external edits → open the rich partial-accept review (covers BOTH chat + action-bar edits)
let _watchTimer = null, _watchLatest = null, _watchBefore = null;
function anyEngineRunning(){
  try {
    if (Array.isArray(sessions) && sessions.some((s) => s.running)) return true;
    if (Array.isArray(sideChats) && sideChats.some((s) => s.running)) return true;
  } catch (_) {}
  return false;
}
// Notes an AI edited while NOT open — red review-dot in the sidebar until opened. PERSISTED per
// vault: dots, staged proposals and new-note keep/discard decisions used to live only in memory,
// so an app restart silently swallowed every "รอตรวจ" signal (log 2026-08-25).
function persistAiReview(){
  try {
    vsSet('aiReviewState', {
      flagged: [...window.__flaggedNotes],
      // bodies can carry slide images — cap count and size so vault state stays sane
      pending: [...window.__pendingReviews].map(([k, v]) => [k, String(v).slice(0, 2000000)]).slice(0, 6),
      proposals: [...window.__newNoteProposals],
    });
  } catch (_) {}
}
class _PSet extends Set { add(v){ super.add(v); persistAiReview(); return this; } delete(v){ const r = super.delete(v); if (r) persistAiReview(); return r; } clear(){ super.clear(); persistAiReview(); } }
class _PMap extends Map { set(k, v){ super.set(k, v); persistAiReview(); return this; } delete(k){ const r = super.delete(k); if (r) persistAiReview(); return r; } clear(){ super.clear(); persistAiReview(); } }
window.__flaggedNotes = new _PSet();
window.__pendingReviews = new _PMap();   // rel -> proposed body: AI edits to notes you're NOT viewing wait here until you open them
window.__newNoteProposals = new _PSet(); // rels of AI-created notes awaiting the keep/discard decision
try {
  const _st = vsGet('aiReviewState', null);
  if (_st) {
    (_st.flagged || []).forEach((n) => Set.prototype.add.call(window.__flaggedNotes, n));
    (_st.pending || []).forEach(([k, v]) => Map.prototype.set.call(window.__pendingReviews, k, v));
    (_st.proposals || []).forEach((n) => Set.prototype.add.call(window.__newNoteProposals, n));
  }
} catch (_) {}
if (window.api.onNoteFlagged) window.api.onNoteFlagged(({ name }) => {
  if (!name || name === currentNote) return;
  window.__flaggedNotes.add(name);
  if (typeof renderTree === 'function') { try { renderTree(); } catch (_) {} }
});
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
const PROMPT_LABELS = { explain:'อธิบาย', search:'หาข้อมูล', link:'ทำลิงก์', tldr:'สรุปทั้งโน้ต (TL;DR)', quiz:'ตั้งคำถามทดสอบ' };
// where each shortcut lives — shown on its card so the user knows which button they are editing
const PROMPT_WHERE = { explain:'toolbar', search:'toolbar', link:'toolbar', tldr:'menu', quiz:'menu' };
let promptTemplates = Object.assign({}, DEFAULT_PROMPTS, JSON.parse(localStorage.getItem('prompts')||'{}'));
// PROMPT VARIABLES — the single registry. fillPrompt() substitutes exactly these keys and the
// settings page renders its legend + chips from the same list, so adding a variable here is
// the whole job. `scope` tells the legend which buttons can supply a value.
const PROMPT_VARS = [
  { key: 'term',   label: 'ข้อความที่คุณลากเลือกในโน้ตตอนกดปุ่ม', scope: 'toolbar', example: 'DFD' },
  { key: 'line',   label: 'ทั้งบรรทัดที่ข้อความที่เลือกอยู่',      scope: 'toolbar', example: 'DFD คือแผนภาพกระแสข้อมูล' },
  { key: 'file',   label: 'ชื่อไฟล์โน้ตที่เปิดอยู่',                scope: 'all',     example: 'DFD - Data Flow Diagram.md' },
  { key: 'folder', label: 'กล่อง (โฟลเดอร์) ที่โน้ตนี้อยู่',          scope: 'all',     example: 'BUSINESS SW REQ ANALYSIS/Note' },
  { key: 'today',  label: 'วันที่วันนี้ (YYYY-MM-DD)',             scope: 'all',     example: '' },
];
function _todayStr(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function _selectedLine(){
  try {
    const sel = window.getSelection(); if (!sel || !sel.rangeCount) return '';
    let node = sel.anchorNode; if (!node) return '';
    if (node.nodeType === 3) node = node.parentElement;
    const block = node.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th') || node;
    return (block.textContent || '').trim();
  } catch (_) { return ''; }
}
// values for every registered variable, from the live editor state
function promptVarValues(term, file){
  const f = file || currentNote || '';
  return {
    term: term || '',
    line: term ? _selectedLine() : '',
    file: f,
    folder: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '',
    today: _todayStr(),
  };
}
function fillPrompt(key, term, file){
  const vals = promptVarValues(term, file);
  let out = (promptTemplates[key]||DEFAULT_PROMPTS[key]||'');
  PROMPT_VARS.forEach((v) => { out = out.split('{' + v.key + '}').join(vals[v.key] || ''); });
  return out;
}
// {name} tokens in a template that are NOT registered variables (typos like {Term}, { term })
function unknownPromptVars(tpl){
  const known = new Set(PROMPT_VARS.map((v) => v.key));
  return [...String(tpl || '').matchAll(/\{([^{}\n]{1,24})\}/g)].map((m) => m[1]).filter((k) => !known.has(k));
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
  beginAiTurn(prompt);
  window.api.runEngine({ engine, model: (engine === 'glm' ? model : ''), prompt, runId: s.id });
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
// ---- Apply an AI chat reply as the whole new note, via the SAME per-hunk
// review card. Works in EVERY engine mode (CLI / API / cloud) because it operates on the reply
// TEXT, never the filesystem — so API/managed mode (which can't edit files) gets note editing too.
// Frontmatter (status/tags) is preserved: the AI reply becomes the body, only the body diffs.
function canApplyToNote(){ return !!currentNote; }
// The chat AI has no file tools, so left to itself it (truthfully) answers "I can't edit files" —
// while the app CAN write for it. This tells it the capability EXISTS and how to use it: emit the
// whole revised note between markers, and the app opens the review + saves. Without this line the
// model refuses edits that the product actually supports.
// ---- Default KUMIKO.md: the "habits" that used to be hardcoded prompt rules now live in a
// USER-OWNED file — every line can be edited or deleted by the user. Seeded once per vault
// (kumikoSeeded flag); deleting the file afterwards is respected, never re-seeded.
const DEFAULT_KUMIKO = '# KUMIKO — กติกาการทำงานร่วมกัน\n\n' +
  'ไฟล์นี้ถูกส่งให้ AI ทุกครั้งที่คุยกัน แก้/ลบได้เหมือนโน้ตทั่วไป — คำสั่งล่าสุดในแชทสำคัญกว่ากติกาในไฟล์นี้เสมอ\n\n' +
  '## กติกาพื้นฐาน\n' +
  '- ยึดคำสั่งล่าสุดของผู้ใช้เป็นหลัก ถ้าขัดกับคำขอเก่าในบทสนทนา ให้ทำตามคำสั่งล่าสุดเท่านั้น\n' +
  '- เลือกโน้ตเป้าหมายให้ถูกก่อนแก้เสมอ — การที่โน้ตหนึ่งถูกเปิดอยู่ ไม่ใช่เหตุผลให้แก้มัน\n' +
  '- แก้บางส่วนของโน้ต ใช้ UPDATED-SECTION เป็นค่าปกติ\n' +
  '- อย่าเดาเนื้อหาโน้ตที่ไม่อยู่ในบริบท — ใช้ READ-NOTE/SEARCH ก่อน\n' +
  '- เนื้อหาที่สรุปจากหน้าสไลด์ ให้แปะสไลด์ (PDF-CLIP) ประกอบเสมอ และเขียนเลขหน้าไว้ในหัวข้อ เช่น "## Merge Sort (หน้า 66)"\n' +
  '- เขียนโน้ตเป็นภาษาไทยเสมอ คงศัพท์เทคนิคเป็นอังกฤษได้ (ยกเว้นผู้ใช้ขอภาษาอื่น)\n' +
  '- เสนอกติกาใหม่ (KUMIKO-RULE) เฉพาะ pattern ที่ชัดเจน ห้ามใช้พร่ำเพรื่อ\n\n' +
  '## กติกาที่เรียนรู้\n';
async function ensureKumikoSeed(){
  if (vsGet('kumikoSeeded', false)) return;
  let cur = '';
  try { cur = String(await window.api.readNote('KUMIKO.md') || ''); } catch (_) {}
  if (!cur.trim()) {
    try { await window.api.saveNote('KUMIKO.md', DEFAULT_KUMIKO); await refreshList(currentNote); } catch (_) {}
  }
  vsSet('kumikoSeeded', true);
}
// ---- KUMIKO.md: the user's standing work rules (per-vault, a normal editable note at the
// vault root). Injected into EVERY chat prompt. Hierarchy is stated explicitly so a standing
// rule never overrides what the user just asked for.
async function kumikoRulesPrompt(){
  let s = '';
  try { s = String(await window.api.readNote('KUMIKO.md') || ''); } catch (_) { return ''; }
  s = s.trim();
  if (!s) return '';
  if (s.length > 2000) s = s.slice(0, 2000) + '…';
  return 'กติกาการทำงานของผู้ใช้ (จาก KUMIKO.md — ลำดับความสำคัญ: ข้อความล่าสุดของผู้ใช้ > กติกานี้ > บทสนทนาก่อนหน้า):\n' + s + '\n\n';
}
// ---- KUMIKO.md "rules desk" — the standing-rules file is not an ordinary note: it is a contract
// the AI reads on every message. When it is open the editor swaps the page title for a header
// (hanko, what the file does, a 2,000-char budget meter) and hides note-only chrome (status/tags,
// backlinks, AI tools). Budget = the cap kumikoRulesPrompt() injects (anything past it is dropped).
const RULES_BUDGET = 2000;
function isRulesNote(name){ return !!name && String(name).replace(/\.md$/i, '').split('/').pop().trim().toLowerCase() === 'kumiko'; }
function applyRulesMode(name){
  const on = isRulesNote(name);
  const left = document.getElementById('left'); if (left) left.classList.toggle('rules-mode', on);
  const head = document.getElementById('rulesHead'); if (head) head.hidden = !on;
  if (on) updateRulesMeter();
}
function updateRulesMeter(){
  const left = document.getElementById('left'); if (!left || !left.classList.contains('rules-mode')) return;
  const n = getBody().trim().length;
  const fill = document.getElementById('rulesBarFill'), cnt = document.getElementById('rulesCount');
  const pct = Math.min(100, Math.round(n / RULES_BUDGET * 100));
  if (fill) { fill.style.width = pct + '%'; fill.classList.toggle('over', n > RULES_BUDGET); fill.classList.toggle('warn', n > RULES_BUDGET * 0.85 && n <= RULES_BUDGET); }
  if (cnt) { cnt.textContent = n.toLocaleString() + ' / ' + RULES_BUDGET.toLocaleString(); cnt.classList.toggle('over', n > RULES_BUDGET); cnt.title = n > RULES_BUDGET ? t('เกินงบ — ส่วนที่เกินจะไม่ถูกส่งให้ AI') : t('ตัวอักษรที่ส่งให้ AI ต่อข้อความ'); }
}
{ const rb = document.getElementById('rulesBackBtn'); if (rb) rb.onclick = () => openAiSettings('prompts');
  const rr = document.getElementById('rulesResetBtn'); if (rr) rr.onclick = async () => {
    if (!confirm(t('คืนค่ากติกาเป็นค่าเริ่มต้น? ข้อความปัจจุบันจะถูกแทนที่'))) return;
    try { await loadEditor(DEFAULT_KUMIKO.replace(/^---[\s\S]*?---\n/, '')); setDirty(true); scheduleAutosave(); updateRulesMeter(); } catch (_) {}
  }; }

// Phase 2 — the AI can PROPOSE a new standing rule when it notices a repeated correction.
// Proposals are confirmed by the user (kr-confirm card) before anything touches KUMIKO.md.
function kumikoLearnPrompt(){
  return '\nการเรียนรู้กติกา: เมื่อผู้ใช้แก้/ปฏิเสธแนวทางของคุณ หรือสั่งเรื่องเดิมซ้ำ และคุณเห็น "กติกาถาวร" ที่ควรจดจำ ให้เสนอด้วยบล็อกนี้ (สั้น 1-2 บรรทัด, ไม่เกิน 1 ข้อต่อคำตอบ):\n===KUMIKO-RULE===\n(กติกา)\n' + window.CoreMarkdown.NOTE_CLOSE + '\nระบบจะถามผู้ใช้ก่อนบันทึกเสมอ\n';
}
// One-shot feedback: how the user judged the AI's LAST note proposal (per-hunk review).
// Discards/edits are the strongest learning signal the chat itself never sees — the review
// happens outside the conversation. Cleared after one injection.
function reviewOutcomeLine(){
  const o = vsGet('aiReviewOutcome', null);
  if (!o || !((o.rej || 0) + (o.edited || 0))) return '';
  try { vsSet('aiReviewOutcome', null); } catch (_) {}
  return 'ผลรีวิวข้อเสนอแก้โน้ตล่าสุดของคุณ: ผู้ใช้รับ ' + (o.acc || 0) + ' จุด, แก้เอง ' + (o.edited || 0) + ' จุด, ทิ้ง ' + (o.rej || 0) + ' จุด — พิจารณาว่าส่วนที่ถูกแก้/ทิ้งพลาดตรงไหน และถ้าเห็นกติกาชัดเจน เสนอผ่าน KUMIKO-RULE ได้\n';
}

// ---- Kumiko tools: the shared read/search + file verbs (one grammar: ===VERB key=value===).
// READ/SEARCH results are fed BACK to the AI (continuation turn) so it works from real
// content instead of guessing — the capability that replaces most of the old "ห้าม" rules.
function kumikoToolsPrompt(){
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractActions) return '';
  const names = (window.__wlNoteNames || []);
  let list = names.slice(0, 300).join(' · ');
  if (list.length > 1500) list = list.slice(0, 1500) + '…';
  return '\nเครื่องมือ (พิมพ์เป็นบรรทัดเดี่ยว ระบบทำจริง):\n' +
    '===READ-NOTE name=ชื่อโน้ต=== — ขออ่านโน้ต ผลจะถูกส่งกลับมาให้คุณตอบต่อ (สูงสุด 3 ต่อรอบ)\n' +
    '===SEARCH query=คำค้น=== — ค้นทั้ง vault แล้วส่งผลกลับมาให้คุณ\n' +
    '===RENAME-NOTE from=ชื่อเดิม to=ชื่อใหม่=== — เปลี่ยนชื่อ/ย้ายโน้ต (ลิงก์ถูกแก้ให้อัตโนมัติ)\n' +
    '===DELETE-NOTE name=ชื่อโน้ต=== — ลบโน้ต (ระบบถามยืนยันผู้ใช้ก่อน ลงถังขยะ กู้คืนได้)\n' +
    ((typeof currentPdf === 'string' && currentPdf) ? '===SET-CAPTURE-TARGET name=ชื่อโน้ต=== — ตั้งโน้ตรับไฮไลต์/สไลด์ของ PDF ที่เปิดอยู่\n' : '') +
    '===LIST-TAGS=== — ขอรายการแท็กทั้ง vault พร้อมจำนวน · ===NOTES-BY-TAG tags=a, b=== — ขอรายชื่อโน้ตที่ติดแท็กครบทุกตัว (ผลส่งกลับมาให้คุณตอบต่อ)\n' +
    '===ADD-TAGS name=ชื่อโน้ต tags=a, b/c=== · ===REMOVE-TAGS name=… tags=…=== · ===SET-TAGS name=… tags=…=== — ติด/ถอด/แทนที่แท็กของโน้ต (ทำทันที แท็กซ้อนชั้นใช้ / เช่น exam/midterm; ใช้ชื่อแท็กที่มีอยู่ก่อนสร้างใหม่)\n' +
    '===RENAME-TAG from=เก่า to=ใหม่=== — เปลี่ยนชื่อแท็กทั้ง vault รวมทั้ง #แท็กที่พิมพ์ในเนื้อหา (ระบบถามยืนยันผู้ใช้ก่อน เลิกทำได้)\n' +
    'ข้อห้าม: KUMIKO.md แก้ผ่านบล็อก KUMIKO-RULE และ KUMIKO-MEMORY.md แก้ผ่าน REMEMBER/FORGET เท่านั้น — ห้ามใช้ช่องทางแก้/สร้าง/ลบโน้ตกับสองไฟล์นี้\n' +
    (list ? 'โน้ตทั้งหมดใน vault: ' + list + '\n' : '') +
    _folderListLine() + ((typeof tagPromptLine === 'function') ? tagPromptLine() : '');
}
// existing folder paths (capped) — the AI picks a folder for NEW-NOTE from these
function _folderListLine(){
  const folders = (window.__wlFolders || []);
  if (!folders.length) return '';
  let list = folders.slice(0, 120).join(' · ');
  if (list.length > 900) list = list.slice(0, 900) + '…';
  const cur = currentFolder();
  return 'โฟลเดอร์ที่มีอยู่: ' + list + (cur ? '\nโฟลเดอร์ที่เปิดอยู่ตอนนี้: ' + cur : '') + '\n';
}

function noteEditCapabilityPrompt(){
  if (!window.CoreMarkdown || !window.CoreMarkdown.NOTE_OPEN) return '';
  // CREATE is always available — without it, "สร้างโน้ตใหม่" had no channel and the model
  // shoved the content into the open note (the only marker it knew).
  const create = '\nคุณสร้างโน้ตใหม่ได้: เมื่อผู้ใช้ขอให้สร้าง/แยกเป็นโน้ตใหม่ ห้ามยัดเนื้อหาลงโน้ตที่เปิดอยู่ ให้ตอบสั้น ๆ แล้วใส่บล็อกนี้ (ตั้งชื่อโน้ตให้สื่อความหมาย)\n' +
    '===NEW-NOTE name=โฟลเดอร์/ชื่อโน้ต===\n(เนื้อหาโน้ตทั้งหมด)\n' + window.CoreMarkdown.NOTE_CLOSE + '\n' +
    'เลือกโฟลเดอร์ให้เข้ากับเรื่องจากรายการโฟลเดอร์ที่มีอยู่ — ถ้าไม่ระบุโฟลเดอร์ โน้ตจะไปอยู่โฟลเดอร์เดียวกับเอกสารที่เปิดอยู่\n';
  // MECHANICS only — the behavioural rules ("ยึดคำสั่งล่าสุด", "โน้ตที่เปิดไม่ใช่เป้าหมายอัตโนมัติ")
  // moved to DEFAULT_KUMIKO where the user owns and can edit every line.
  const edit = 'คุณแก้โน้ตได้จริง (ระบบบันทึกให้เอง หลังผู้ใช้ตรวจ) — ห้ามตอบว่าคุณแก้ไฟล์ไม่ได้\n' +
    '- แก้/เพิ่มเฉพาะบางหัวข้อ (ค่าปกติสำหรับการแก้บางส่วน):\n===UPDATED-SECTION heading=ชื่อหัวข้อ=== (โน้ตที่เปิดอยู่) หรือ ===UPDATED-SECTION name=ชื่อโน้ต heading=ชื่อหัวข้อ=== (โน้ตอื่นตามชื่อ)\n(เนื้อหาใหม่ของหัวข้อนั้น รวมบรรทัดหัวข้อ)\n' + window.CoreMarkdown.NOTE_CLOSE + '\nส่วนอื่นของโน้ตจะถูกเก็บไว้ให้เอง — ห้ามส่งทั้งไฟล์ ถ้าหัวข้อยังไม่มีอยู่ ระบบจะเพิ่มต่อท้ายโน้ตให้\nสำคัญ: ถ้าโน้ตเป้าหมายไม่ได้เปิดอยู่ (เช่น ผู้ใช้กำลังดู PDF) ต้องใส่ name=ชื่อโน้ต เสมอ ไม่งั้นการแก้จะไปไม่ถึงโน้ต\n' +
    '- แก้โน้ตอื่นตามชื่อที่ผู้ใช้ระบุหรือ @อ้างถึง: ===UPDATED-NOTE name=ชื่อโน้ต=== (ทั้งไฟล์)\n' +
    (currentNote ? '- เขียนโน้ตที่เปิดอยู่ใหม่ทั้งฉบับ: ' + window.CoreMarkdown.NOTE_OPEN + ' (ทั้งไฟล์) — ใช้ได้เฉพาะเมื่อบริบทมีเนื้อหาเต็ม: ถ้าบริบทมีเครื่องหมาย "…" แปลว่าเป็นฉบับตัดตอน ห้ามใช้ช่องทางทั้งไฟล์ ให้ใช้ UPDATED-SECTION แทน\n' : '') +
    'ทุกบล็อกปิดด้วย ' + window.CoreMarkdown.NOTE_CLOSE + ' และถ้าเป็นการถาม-ตอบธรรมดา ห้ามใส่ตัวคั่นพวกนี้\n';
  return create + edit;
}
// Tell the AI it can paste PDF slides (only when a PDF is open — the currentPdf handle
// survives switching to a note, which is the main use case).
// The AI can pick pages from the extracted text; it cannot SEE the images, so this is page-level.
function pdfClipCapabilityPrompt(){
  if (!(typeof currentPdf === 'string' && currentPdf)) return '';
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractPdfClips) return '';
  return '\nคุณแปะภาพสไลด์จาก PDF ที่เปิดอยู่ได้: เมื่อผู้ใช้ขอให้นำสไลด์/ภาพหน้าใดมาแปะ ให้เพิ่มบรรทัดคำสั่ง (หนึ่งหน้าต่อหนึ่งบรรทัด ห้ามมีข้อความอื่นในบรรทัดนั้น)\n===PDF-CLIP page=เลขหน้า===\n' +
    'ตำแหน่งของบรรทัดนี้สำคัญ: ถ้าวางไว้ในบล็อกโน้ต (UPDATED-NOTE / NEW-NOTE / UPDATED-SECTION) ภาพจะถูกแทรกในโน้ตนั้น ตรงจุดที่วางบรรทัดไว้ — เมื่อผู้ใช้ขอ "เพิ่มภาพ/อ้างอิงหน้า X ในโน้ต Y" ให้วางไว้ในบล็อกของโน้ตนั้นเสมอ; วางนอกบล็อกเมื่อต้องการส่งเข้าโน้ตเป้าหมายของ PDF เท่านั้น\n' +
    'ค่าปกติ (กติกาของผู้ใช้): ทุกหัวข้อที่สรุปจากหน้าสไลด์ ต้องวาง ===PDF-CLIP page=N=== ไว้ใต้หัวข้อนั้นเสมอโดยไม่ต้องรอให้ขอ — ห้ามถามว่า "อยากให้แนบสไลด์ไหม" และเขียนเลขหน้าไว้ในหัวข้อ เช่น "## Merge Sort (หน้า 66)"\n';
}
// Replace ===PDF-CLIP page=N=== marker lines INSIDE a note body with the rendered slide image
// (at the marker's position, with attribution). The AI places clips where it wants them; the
// old executor ignored position and dumped every clip into the capture target — and the raw
// marker line leaked into the saved note. Failed renders remove the line (never leak protocol).
async function resolvePdfClipMarkers(body){
  let s = String(body == null ? '' : body);
  // standing rule: content that cites slide pages carries the slide images — inject missing
  // markers before resolving, so it holds even when the AI forgets (log 2026-08-24: a Sorting
  // note cited 5 pages, attached none, and asked the user whether it should)
  if (typeof currentPdf === 'string' && currentPdf && pdfDoc && window.CoreMarkdown.ensureSlideClips) {
    try { s = window.CoreMarkdown.ensureSlideClips(s, pdfDoc.numPages).body; } catch (_) {}
  }
  if (!/^[ \t]*===PDF-CLIP page=\d/m.test(s)) return s;
  const lines = s.split('\n');
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[ \t]*===PDF-CLIP page=(\d{1,4})===[ \t]*$/);
    if (!m) continue;
    let rep = '';
    if (used < 5 && typeof renderPdfClipMarkdown === 'function') {
      try {
        const r = await renderPdfClipMarkdown(parseInt(m[1], 10));
        if (r && r.ok) { rep = r.md + '\n\n' + pdfClipAttribution(r.page); used++; }
        else { try { pdfToast(t('แปะภาพหน้า ') + m[1] + t(' ไม่สำเร็จ — บันทึกโน้ตโดยไม่มีภาพ')); } catch (_) {} }
      } catch (_) {}
    }
    lines[i] = rep;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Execute STANDALONE ===PDF-CLIP=== commands (outside note blocks) in a finished reply —
// these go to the PDF's capture target. Markers inside note blocks are handled by
// resolvePdfClipMarkers when that note body is applied.
async function maybeClipPdfPages(text){
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractPdfClips) return;
  let pages = [];
  try {
    const scope = window.CoreMarkdown.stripNoteBlocks ? window.CoreMarkdown.stripNoteBlocks(text) : text;
    pages = window.CoreMarkdown.extractPdfClips(scope).pages;
  } catch (_) { return; }
  if (!pages.length || typeof clipPdfPageToTarget !== 'function') return;
  for (const p of pages.slice(0, 5)) {
    const r = await clipPdfPageToTarget(p);
    try {
      const tgt = (typeof captureTargetLabel === 'function') ? captureTargetLabel() : '';
      if (r && r.ok) { if (typeof pdfToast === 'function') pdfToast(t('AI แปะสไลด์หน้า ') + p + t(' เข้า ') + tgt,
        { action: { label: t('เปลี่ยนโน้ต'), fn: () => openCaptureTargetMenu(null) } }); }
      else if (typeof pdfToast === 'function') pdfToast(t('แปะสไลด์หน้า ') + p + t(' ไม่สำเร็จ'));
    } catch (_) {}
  }
}

// Execute ===NEW-NOTE=== blocks in a finished reply: create the notes (never overwrite an
// existing name — uniquified), then open the first one so the user lands on what they asked for.
async function maybeCreateNewNotes(text){
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractNewNotes) return;
  let notes = [];
  try { notes = window.CoreMarkdown.extractNewNotes(text).notes; } catch (_) { return; }
  if (!notes.length) return;
  let firstRel = null;
  for (const n of notes.slice(0, 3)) {
    if (_aiProtectedName(n.name)) { _aiProtectToast(); continue; }
    // name may carry a folder path ("Folder/Note"); a bare name lands in the CURRENT folder —
    // new notes used to always drop at the vault root regardless of where the user was working
    const base = _noteRelFromName(n.name);
    if (!base) continue;
    const existing = new Set(Object.values(window.__wlNoteRel || {}).map((x) => String(x).toLowerCase()));
    // EXACT name of a note that already exists → the AI means "replace that note" (log 2026-08-24:
    // a translate request came back as NEW-NOTE with the same name and silently spawned "… 2").
    // Route it through the same review gate as UPDATED-NOTE name= instead of uniquifying.
    if (existing.has((base + '.md').toLowerCase())) {
      const rel0 = Object.values(window.__wlNoteRel || {}).find((x) => String(x).toLowerCase() === (base + '.md').toLowerCase()) || (base + '.md');
      try {
        const nb0 = await resolvePdfClipMarkers(n.body);
        if (rel0 === currentNote) { applyReplyToNote(nb0, { silent: true }); }
        else {
          window.__pendingReviews.set(rel0, nb0);
          window.__flaggedNotes.add(rel0);
          try { renderTree(); } catch (_) {}
          pdfToast(t('มีโน้ตชื่อนี้อยู่แล้ว — AI เสนอเขียนทับ ') + rel0.replace(/\.md$/i, '').split('/').pop(),
          { sticky: true, action: { label: t('เปิดรีวิว'), fn: () => openNote(rel0) } });
        }
      } catch (_) {}
      continue;
    }
    let final = base, i = 2;
    while (existing.has((final + '.md').toLowerCase())) final = base + ' ' + (i++);
    try {
      const nb = await resolvePdfClipMarkers(n.body);
      await window.api.saveNote(final + '.md', nb);
      if (!firstRel) firstRel = final + '.md';
      window.__newNoteProposals.add(final + '.md');   // opening shows เก็บ/ทิ้ง — the accept step
      window.__flaggedNotes.add(final + '.md');
      try { touchRecentNote(final + '.md'); } catch (_) {}
    } catch (_) {}
  }
  // refresh the list but STAY where the user is; new notes get the red dot so they're findable
  if (firstRel && typeof refreshList === 'function') { try { await refreshList(firstRel, { keepView: true }); } catch (_) {} }
  // ...and the toast carries a jump button: creations used to announce themselves only as a
  // sidebar dot, leaving the user to hunt for the note (user request 2026-09-02). Opening the
  // first new note lands directly on its เก็บ/ทิ้ง review banner.
  if (firstRel && currentNote !== firstRel && typeof pdfToast === 'function') {
    const label = firstRel.replace(/\.md$/i, '').split('/').pop();
    pdfToast('🆕 ' + t('AI สร้างโน้ตใหม่: ') + label,
      { sticky: true, action: { label: t('เปิดรีวิว'), fn: () => openNote(firstRel) } });
  }
}

// ---- Kumiko tool executors -------------------------------------------------------------
// Resolve a spoken note name to a vault rel via the sidebar's name map (case-insensitive).
function _resolveNoteRel(name){
  const key = String(name || '').trim().replace(/\.md$/i, '').split('/').pop().toLowerCase();
  return (window.__wlNoteRel || {})[key] || null;
}
// KUMIKO.md is written ONLY via the KUMIKO-RULE confirm card — the AI once "helpfully"
// edited it through the note channels (log 2026-08-19), which bypasses the rule governance.
// KUMIKO-MEMORY.md gets the same shield: memory changes only via the REMEMBER/FORGET cards.
function _aiProtectedName(name){
  const base = String(name || '').replace(/\.md$/i, '').split('/').pop().trim().toLowerCase();
  return base === 'kumiko' || base === 'kumiko-memory';
}
function _aiProtectToast(){
  try { if (typeof pdfToast === 'function') pdfToast(t('KUMIKO.md แก้ผ่านการเสนอกติกา (การ์ดยืนยัน) เท่านั้น')); } catch (_) {}
}
// Recency log for the dashboard's "โน้ตแก้ล่าสุด" widget — touched on open/save/create.
function touchRecentNote(rel){
  if (!rel || _aiProtectedName(rel)) return;
  try {
    const rec = (vsGet('recentNotes', []) || []).filter((r) => r.rel !== rel);
    rec.unshift({ rel, ts: Date.now() });
    vsSet('recentNotes', rec.slice(0, 10));
  } catch (_) {}
}
// The folder the user is WORKING IN right now — new notes land here by default.
function currentFolder(){
  const src = currentNote || (typeof currentPdf === 'string' ? currentPdf : '') || '';
  return src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : '';
}
// "Folder/Sub/Name" → sanitized rel path (no .md). A bare name gets the current folder.
function _noteRelFromName(name){
  const segs = String(name || '').replace(/\.md$/i, '').split('/').map((x) => x.trim().slice(0, 80)).filter(Boolean);
  if (!segs.length) return null;
  if (segs.length === 1) { const f = currentFolder(); return (f ? f + '/' : '') + segs[0]; }
  return segs.join('/');
}
// File verbs — executed immediately. Rename/target are undo-able by nature; delete goes to
// the trash and asks the user ONCE (the same confirm the sidebar uses).
async function runKumikoVerbs(acts){
  for (const r of (acts.renames || [])) {
    if (_aiProtectedName(r.from) || _aiProtectedName(r.to)) { _aiProtectToast(); continue; }
    const from = _resolveNoteRel(r.from);
    if (!from) { pdfToast(t('ไม่พบโน้ต ') + r.from); continue; }
    let to = String(r.to).replace(/\.md$/i, '').trim(); if (!to) continue;
    if (!/\//.test(to) && /\//.test(from)) to = from.slice(0, from.lastIndexOf('/') + 1) + to;   // keep folder unless a path was given
    try {
      const res = await window.api.renameNote(from, to + '.md');
      if (res && res.error) { pdfToast(t('เปลี่ยนชื่อไม่ได้: ') + r.from); continue; }
      window.__pendingReviews && window.__pendingReviews.delete(from);
      pdfToast(t('เปลี่ยนชื่อ ') + from.replace(/\.md$/i, '') + ' → ' + to);
    } catch (_) { pdfToast(t('เปลี่ยนชื่อไม่ได้: ') + r.from); }
  }
  for (const d of (acts.deletes || [])) {
    if (_aiProtectedName(d)) { _aiProtectToast(); continue; }
    const rel = _resolveNoteRel(d);
    if (!rel) { pdfToast(t('ไม่พบโน้ต ') + d); continue; }
    if (!(await confirmDelete(t('AI ขอลบโน้ต "') + rel.replace(/\.md$/i, '') + t('" (ไปถังขยะ) — ยืนยัน?')))) continue;
    try {
      await window.api.deleteNote(rel);
      window.__pendingReviews && window.__pendingReviews.delete(rel);
      window.__flaggedNotes && window.__flaggedNotes.delete(rel);
      if (rel === currentNote) currentNote = null;
      pdfToast(t('ลบ ') + rel.replace(/\.md$/i, '') + t(' ไปถังขยะแล้ว'));
    } catch (_) {}
  }
  for (const tg of (acts.targets || [])) {
    if (_aiProtectedName(tg)) { _aiProtectToast(); continue; }
    const rel = _resolveNoteRel(tg);
    if (!rel) { pdfToast(t('ไม่พบโน้ต ') + tg); continue; }
    if (typeof setCaptureTarget === 'function' && typeof currentPdf === 'string' && currentPdf) {
      setCaptureTarget(rel);
      pdfToast(t('โน้ตเป้าหมายของ PDF นี้: ') + rel.replace(/\.md$/i, ''));
    }
  }
  if ((acts.renames || []).length || (acts.deletes || []).length) {
    try { await refreshList(currentNote); } catch (_) {}
  }
  if (acts.tagWrites && typeof runTagVerbs === 'function') { try { await runTagVerbs(acts); } catch (_) {} }
}
// READ/SEARCH results → the text block fed back to the AI in the continuation turn.
async function buildToolResults(acts){
  const parts = [];
  for (const nm of (acts.reads || [])) {
    const rel = _resolveNoteRel(nm);
    if (!rel) { parts.push('[อ่าน ' + nm + '] ไม่พบโน้ตชื่อนี้'); continue; }
    // the note the AI just asked to read is the natural target of its NEXT reply's edits —
    // remember it so a name-less UPDATED-SECTION with no open note still lands (log 2026-08-24:
    // 4 sections for "Asymptotic formulae" evaporated because the PDF was in front)
    if (!window.__aiReadTarget) window.__aiReadTarget = rel;
    let body = '';
    try { body = String(await window.api.readNote(rel) || ''); } catch (_) {}
    // embedded data-URI images: pull them OUT of the text (the 6,000-char slice used to fill up
    // with base64) — and, when enabled + the engine can take images, attach the real pictures
    let imgN = 0;
    body = body.replace(/!\[([^\]]*)\]\((data:image\/[a-z+.-]+;base64,[^)\s]+)\)/g, (_, alt, uri) => {
      imgN++;
      const cfg = window.__aiCfg || {};
      if (cfg.readNoteImages !== false && (window.__toolImages = window.__toolImages || []).length < 4) window.__toolImages.push(uri);
      return '[ภาพที่ ' + imgN + (alt ? ': ' + alt : '') + (imgN <= 4 ? ' — แนบมาให้ดูด้วย' : '') + ']';
    });
    if (body.length > 6000) body = body.slice(0, 6000) + '\n…(ตัดที่ 6,000 ตัวอักษร)';
    parts.push('[เนื้อหาโน้ต ' + rel.replace(/\.md$/i, '') + ']\n' + (body.trim() || '(โน้ตว่าง)'));
  }
  for (const q of (acts.searches || [])) {
    let ctx = '';
    try {
      const r = await window.api.ragContext(q, { weights: (typeof ragWeights === 'function') ? ragWeights() : undefined });
      ctx = (r && r.context) || '';
    } catch (_) {}
    parts.push('[ผลค้นหา "' + q + '"]\n' + (ctx.trim() || '(ไม่พบผลลัพธ์)'));
  }
  if ((acts.listTags || (acts.notesByTag || []).length) && typeof buildTagToolResults === 'function') { try { parts.push(...(await buildTagToolResults(acts))); } catch (_) {} }
  return parts.join('\n\n');
}
// The continuation prompt: tool results + the original question + full write capabilities,
// so the AI can now act on REAL content (the whole point of the loop).
function buildToolContinuationPrompt(userMsg, results, ownPlan){
  // ownPlan = what the AI TOLD the user before reaching for the tool ("จะแปลทั้งฉบับ…").
  // Without it the model lost its own intent and once echoed the read content back verbatim
  // as a same-name NEW-NOTE (log 2026-08-24).
  return 'คุณขอข้อมูลด้วยเครื่องมือ และนี่คือผลลัพธ์:\n\n' + results + '\n\n' +
    (ownPlan ? 'สิ่งที่คุณบอกผู้ใช้ไว้ก่อนใช้เครื่องมือ (ทำตามนี้ให้จบ): ' + ownPlan + '\n' : '') +
    'ห้ามคัดลอกเนื้อหาที่อ่านมาส่งกลับโดยไม่แก้ — ใช้มันทำงานตามที่รับปากไว้ และถ้าจะแก้โน้ตเดิม ใช้ UPDATED-NOTE name= ไม่ใช่ NEW-NOTE\n' +
    noteEditCapabilityPrompt() + pdfClipCapabilityPrompt() + kumikoToolsPrompt() +
    '\nตอบคำถามเดิมของผู้ใช้ต่อให้จบโดยใช้ข้อมูลข้างบน: ' + userMsg;
}

// ===KUMIKO-RULE=== executor: show a confirm card above the chat input — the user accepts or
// rejects each proposed rule; ONLY an accept writes to KUMIKO.md (propose, never auto-learn).
async function maybeProposeKumikoRules(text){
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractKumikoRules) return;
  let rules = [];
  try { rules = window.CoreMarkdown.extractKumikoRules(text).rules; } catch (_) { return; }
  if (rules.length) openKumikoRuleConfirm(rules.slice(0, 3));
}
function openKumikoRuleConfirm(rules){
  const old = document.getElementById('krConfirm'); if (old) old.remove();
  const box = document.createElement('div'); box.id = 'krConfirm'; box.className = 'kr-confirm';
  const head = document.createElement('div'); head.className = 'kr-head';
  head.textContent = t('AI เสนอกติกาการทำงานใหม่ → KUMIKO.md');
  box.appendChild(head);
  const closeIfEmpty = () => { if (!box.querySelector('.kr-row')) box.remove(); };
  rules.forEach((r) => {
    const row = document.createElement('div'); row.className = 'kr-row';
    const txt = document.createElement('div'); txt.className = 'kr-text'; txt.textContent = r;
    const acts = document.createElement('div'); acts.className = 'kr-acts';
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'kr-add'; ok.textContent = t('เพิ่ม');
    const no = document.createElement('button'); no.type = 'button'; no.className = 'kr-skip'; no.textContent = t('ไม่เอา');
    ok.onclick = async () => { ok.disabled = true; try { await appendKumikoRule(r); } catch (_) {} row.remove(); closeIfEmpty(); };
    no.onclick = () => { row.remove(); closeIfEmpty(); };
    acts.appendChild(ok); acts.appendChild(no);
    row.appendChild(txt); row.appendChild(acts);
    box.appendChild(row);
  });
  // lives ABOVE the chat input (outside #chatMessages, so re-renders don't wipe it)
  const wrapEl = document.querySelector('.chat-input-wrap');
  if (wrapEl && wrapEl.parentElement) wrapEl.parentElement.insertBefore(box, wrapEl);
  else document.body.appendChild(box);
}
async function appendKumikoRule(rule){
  let cur = '';
  try { cur = String(await window.api.readNote('KUMIKO.md') || ''); } catch (_) {}
  if (!cur.trim()) {
    cur = '# KUMIKO — กติกาการทำงานของฉัน\n\nกติกาในไฟล์นี้ถูกส่งให้ AI ทุกครั้งที่คุยกัน (คำสั่งล่าสุดของผู้ใช้สำคัญกว่ากติกาในไฟล์เสมอ) แก้/ลบได้เหมือนโน้ตทั่วไป\n';
  }
  if (!/## กติกาที่เรียนรู้/.test(cur)) cur += (/\n$/.test(cur) ? '' : '\n') + '\n## กติกาที่เรียนรู้\n';
  if (!/\n$/.test(cur)) cur += '\n';
  cur += '- ' + rule.replace(/\s*\n\s*/g, ' ').trim() + '\n';
  await window.api.saveNote('KUMIKO.md', cur);
  try { await refreshList(currentNote); } catch (_) {}
  try { if (typeof pdfToast === 'function') pdfToast(t('เพิ่มกติกาลง KUMIKO.md แล้ว')); } catch (_) {}
}

// A NEW-NOTE block the stream never closed (engine died mid-write): save what arrived as a
// draft note with the review red-dot, so the user keeps the partial work and can retry.
async function salvagePartialNoteBlock(text){
  const s = String(text || '');
  const m = [...s.matchAll(/^[ \t]*===NEW-NOTE name=(.+?)===[ \t]*$/gm)].pop();
  if (!m) return;
  const after = s.slice(m.index + m[0].length);
  if (/===END-NOTE===/.test(after)) return;                    // closed → normal executor handled it
  const body = after.replace(/^[\s\r\n]+/, '');
  if (body.length < 200) return;                               // too little to be worth keeping
  if (_aiProtectedName(m[1])) return;
  const base = _noteRelFromName(m[1]); if (!base) return;
  const existing = new Set(Object.values(window.__wlNoteRel || {}).map((x) => String(x).toLowerCase()));
  let final = base + ' (ร่างไม่จบ)', i = 2;
  while (existing.has((final + '.md').toLowerCase())) final = base + ' (ร่างไม่จบ ' + (i++) + ')';
  try {
    await window.api.saveNote(final + '.md', await resolvePdfClipMarkers(body));
    window.__flaggedNotes.add(final + '.md');
    await refreshList(currentNote, { keepView: true });
    pdfToast(t('สตรีมหยุดกลางคัน — เก็บร่างไว้ที่ ') + final);
  } catch (_) {}
}

// ชั้น 3 — stranded sections (no name=, no open note, no read target): a card above the chat
// input asks WHICH note they belong to instead of a 2-second toast that loses 4,000 chars.
function openOrphanSectionCard(secs){
  const old = document.getElementById('orphanSec'); if (old) old.remove();
  const box = document.createElement('div'); box.className = 'kr-confirm'; box.id = 'orphanSec';
  const hd = document.createElement('div'); hd.className = 'kr-hd';
  hd.textContent = '📌 ' + t('AI เขียนเนื้อหาไว้ ') + secs.length + t(' หัวข้อ แต่ไม่รู้ว่าจะลงโน้ตไหน');
  box.appendChild(hd);
  const list = document.createElement('div'); list.className = 'orph-list';
  list.textContent = secs.map((x) => '· ' + x.heading).join('\n');
  box.appendChild(list);
  const row = document.createElement('div'); row.className = 'kr-row';
  const sel = document.createElement('select'); sel.className = 'orph-sel';
  const names = (window.__wlNoteNames || []).slice(0, 200);
  const cur = [...(vsGet('recentNotes', []) || [])].map((r) => r.rel).filter(Boolean);
  const opts = [...new Set([...cur.map((r) => r.replace(/\.md$/i, '').split('/').pop()), ...names])];
  opts.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'solid sm'; ok.textContent = t('ลงโน้ตนี้');
  ok.onclick = async () => {
    const rel = _resolveNoteRel(sel.value); if (!rel) return;
    let raw = ''; try { raw = String(await window.api.readNote(rel) || ''); } catch (_) { return; }
    let body = parseFrontmatter(raw).body;
    for (const sec of secs) {
      const sb = await resolvePdfClipMarkers(sec.body);
      const merged = window.CoreMarkdown.replaceSection(body, sec.heading, sb);
      body = (merged == null) ? (body.replace(/\s*$/, '') + '\n\n' + sb + '\n') : merged;
    }
    window.__pendingReviews.set(rel, body);
    window.__flaggedNotes.add(rel);
    try { renderTree(); } catch (_) {}
    box.remove();
    pdfToast(t('AI เสนอแก้ ') + rel.replace(/\.md$/i, '') + t(' — เปิดโน้ตเพื่อรีวิว'));
    if (rel !== currentNote) { try { await openNote(rel); } catch (_) {} }
  };
  const no = document.createElement('button'); no.type = 'button'; no.className = 'ghost sm'; no.textContent = t('ทิ้ง');
  no.onclick = () => box.remove();
  row.appendChild(sel); row.appendChild(ok); row.appendChild(no); box.appendChild(row);
  const wrapEl = document.querySelector('.chat-input-wrap');
  if (wrapEl && wrapEl.parentElement) wrapEl.parentElement.insertBefore(box, wrapEl);
  else document.body.appendChild(box);
}

// A note the AI CREATED is a proposal too: opening it shows a keep/discard bar (the "accept"
// the user expects for everything the AI writes). ทิ้ง → trash, exactly undoable.
function maybeShowNewNoteProposal(rel){
  const old = document.getElementById('nnPropose'); if (old) old.remove();
  if (!rel || !window.__newNoteProposals || !window.__newNoteProposals.has(rel)) return;
  const bar = document.createElement('div'); bar.className = 'banner nn-propose'; bar.id = 'nnPropose';
  // same banner, richer info (user request 2026-09-02): the NOTE NAME sits in the line, and
  // each button advertises its shortcut. ⌘⇧⌫ (not bare ⌘⌫) for discard — the editor behind
  // this banner is live, and macOS uses ⌘⌫ for delete-to-line-start while typing.
  const txt = document.createElement('span');
  txt.innerHTML = '<b>🆕 ' + t('AI สร้างโน้ตนี้') + '</b> — <b class="nn-name"></b> — ' + t('ตรวจแล้วเลือกได้ว่าจะเก็บหรือทิ้ง');
  txt.querySelector('.nn-name').textContent = rel.replace(/\.md$/i, '').split('/').pop();
  const btns = document.createElement('span');
  const onKey = (e) => {
    if (!document.body.contains(bar)) { document.removeEventListener('keydown', onKey, true); return; }
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'Enter') { e.preventDefault(); keep.onclick(); }
    else if (e.key === 'Backspace' && e.shiftKey) { e.preventDefault(); drop.onclick(); }
  };
  const unbind = () => document.removeEventListener('keydown', onKey, true);
  const keep = document.createElement('button'); keep.className = 'solid sm';
  keep.innerHTML = ''; keep.appendChild(document.createTextNode(t('เก็บโน้ตนี้')));
  { const k = document.createElement('kbd'); k.textContent = '⌘↩'; keep.appendChild(k); }
  keep.onclick = () => { window.__newNoteProposals.delete(rel); bar.remove(); unbind(); };
  const drop = document.createElement('button'); drop.className = 'ghost sm';
  drop.appendChild(document.createTextNode(t('ทิ้ง (ลงถังขยะ)')));
  { const k = document.createElement('kbd'); k.textContent = '⌘⇧⌫'; drop.appendChild(k); }
  drop.onclick = async () => {
    window.__newNoteProposals.delete(rel); bar.remove(); unbind();
    try { await window.api.deleteNote(rel); if (rel === currentNote) currentNote = null; await refreshList(null, {}); } catch (_) {}
    pdfToast(t('ทิ้งโน้ตของ AI ลงถังขยะแล้ว'));
  };
  document.addEventListener('keydown', onKey, true);
  btns.appendChild(keep); btns.appendChild(drop); bar.appendChild(txt); bar.appendChild(btns);
  const wrap = document.getElementById('editorWrap');
  if (wrap && wrap.parentElement) wrap.parentElement.insertBefore(bar, wrap);
}

// Called when a chat turn finishes: if the AI emitted a note update, open the review AUTOMATICALLY
// — same feel as the CLI path (edit → review appears by itself), no "apply" button to press first.
async function maybeAutoReviewReply(text){
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractNoteUpdate) return;
  if (suggestActive) return;                       // a review is already open; don't stack
  // SECTION edits first — the AI sends only the changed section; we merge into the full body.
  try {
    const su = window.CoreMarkdown.extractSectionUpdates ? window.CoreMarkdown.extractSectionUpdates(text) : { sections: [] };
    if (su.sections.length) {
      // Group by target: name= aims at ANY note; no name = the open note. The old executor
      // handled only the open note and SILENTLY dropped everything else (log 2026-08-19:
      // "เพิ่มใน Functional Modelling" went nowhere with a PDF in front).
      const groups = new Map();
      const orphanSecs = [];
      for (const sec of su.sections.slice(0, 5)) {
        let rel = null;
        if (sec.name) {
          if (_aiProtectedName(sec.name)) { _aiProtectToast(); continue; }
          rel = _resolveNoteRel(sec.name);
          if (!rel) { try { if (typeof pdfToast === 'function') pdfToast(t('ไม่พบโน้ต ') + sec.name); } catch (_) {} continue; }
        } else if (currentNote) {
          if (_aiProtectedName(currentNote)) { _aiProtectToast(); continue; }
          rel = currentNote;
        } else if (window.__aiReadTarget) {
          rel = window.__aiReadTarget;   // ชั้น 1: the note the AI read in this tool round
        } else {
          orphanSecs.push(sec);          // ชั้น 3: never drop content — ask the user instead
          continue;
        }
        if (!groups.has(rel)) groups.set(rel, []);
        groups.get(rel).push(sec);
      }
      for (const [rel, secs] of groups) {
        let baseBody;
        if (rel === currentNote) baseBody = parseFrontmatter(getFullMarkdown()).body;
        else {
          let raw = '';
          try { raw = String(await window.api.readNote(rel) || ''); } catch (_) { continue; }
          baseBody = parseFrontmatter(raw).body;
        }
        let body = baseBody;
        for (const sec of secs) {
          const secBody = await resolvePdfClipMarkers(sec.body);
          const merged = window.CoreMarkdown.replaceSection(body, sec.heading, secBody);
          // unknown heading → APPEND at the end ("เพิ่มใน X" usually MEANS a new section);
          // the review card still gates the result either way
          body = (merged == null) ? (body.replace(/\s*$/, '') + '\n\n' + secBody + '\n') : merged;
        }
        if (body === baseBody) continue;
        if (rel === currentNote) { applyReplyToNote(body, { silent: true }); continue; }
        window.__pendingReviews.set(rel, body);
        window.__flaggedNotes.add(rel);
        try { if (typeof renderTree === 'function') renderTree(); } catch (_) {}
        try { if (typeof pdfToast === 'function') pdfToast(t('AI เสนอแก้ ') + rel.replace(/\.md$/i, '') + t(' — เปิดโน้ตเพื่อรีวิว')); } catch (_) {}
      }
      if (orphanSecs.length) openOrphanSectionCard(orphanSecs);
      return;
    }
  } catch (_) {}
  let r = null;
  try { r = window.CoreMarkdown.extractNoteUpdate(text); } catch (_) { return; }
  if (!r || !r.body) return;
  try { r.body = await resolvePdfClipMarkers(r.body); } catch (_) {}
  if (r.name) {
    if (_aiProtectedName(r.name)) { _aiProtectToast(); return; }
    // the AI targeted a NAMED note. NEVER switch the user's view (their explicit ask):
    // stage the proposal + red-dot the note — the review opens when THEY open it.
    let rel = _resolveNoteRel(r.name);
    if (!rel) {
      // creating a missing target is folder-aware, same as NEW-NOTE
      const base = _noteRelFromName(r.name);
      if (!base) return;
      rel = base + '.md';
      try { await window.api.saveNote(rel, ''); } catch (_) { return; }
      try { await refreshList(rel, { keepView: true }); } catch (_) {}
    }
    if (rel === currentNote) { applyReplyToNote(r.body, { silent: true }); return; }   // already looking at it
    window.__pendingReviews.set(rel, r.body);
    window.__flaggedNotes.add(rel);
    try { if (typeof renderTree === 'function') renderTree(); } catch (_) {}
    try { if (typeof pdfToast === 'function') pdfToast(t('AI เสนอแก้ ') + rel.replace(/\.md$/i, '') + t(' — เปิดโน้ตเพื่อรีวิว')); } catch (_) {}
    return;
  }
  if (!currentNote) return;
  if (_aiProtectedName(currentNote)) { _aiProtectToast(); return; }
  applyReplyToNote(r.body, { silent: true });
}
function applyReplyToNote(replyText, opts){
  const silent = !!(opts && opts.silent);        // auto path: never interrupt with alerts
  if (!currentNote) { if (!silent) alert(t('เปิดโน้ตก่อนจึงจะแทนที่ได้')); return; }
  // baseRaw: the proposal was built from the RAW file (deferred review) — compare against that
  // same raw text, not the editor's normalized serialization, or every line diffs
  const before = (opts && opts.baseRaw != null) ? String(opts.baseRaw) : getFullMarkdown();
  const body = (window.CoreMarkdown && window.CoreMarkdown.stripMdFence) ? window.CoreMarkdown.stripMdFence(replyText) : String(replyText || '').trim();
  const after = serializeFrontmatter(currentAttrs, body);
  if (before.trim() === after.trim()) { if (!silent) alert(t('เนื้อหาเหมือนเดิม ไม่มีอะไรต้องแทนที่')); return; }
  openDiffReview(currentNote, before, after);   // user reviews (accept/edit/discard) then applies
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
    controls.push({ state, orig: seg.add.join('\n') });
  });
  view.appendChild(doc);
  const bar = document.createElement('div'); bar.className = 'sg-bar';
  const info = document.createElement('span'); info.className = 'sg-info';
  info.innerHTML = t('AI เสนอแก้ <b>') + hunkSegs.length + t('</b> จุด — เลือกรับ/แก้/ทิ้งที่แต่ละจุด');
  if (String(after || '').length < String(before || '').length * 0.5 && String(before || '').length > 800) {
    info.innerHTML += ' <b style="color:#c0433f">' + t('⚠ เนื้อหาหายไปมาก — ตรวจก่อนรับ') + '</b>';
  }
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
    try { touchRecentNote(name); } catch (_) {}
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
  // Learning signal (KUMIKO.md phase 2): how the user judged this proposal. Discards/edits
  // happen OUTSIDE the chat, so without this the AI never finds out it was wrong. Injected
  // once into the next prompt by reviewOutcomeLine().
  const recordOutcome = (force) => {
    try {
      let acc = 0, rej = 0, edited = 0;
      controls.forEach((c) => {
        const accepted = force === null ? c.state.accept : force;
        if (!accepted) rej++;
        else if (c.state.value !== c.orig) edited++;
        else acc++;
      });
      vsSet('aiReviewOutcome', { acc, rej, edited, ts: Date.now() });
    } catch (_) {}
  };
  useBtn.onclick = () => { recordOutcome(null); finish(mergeSegments(segs, buildDecisions(null))); };
  allBtn.onclick = () => { recordOutcome(true); finish(mergeSegments(segs, buildDecisions(true))); };
  noneBtn.onclick = () => { recordOutcome(false); finish(before); };
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

// ---------- Shoji rails: chat divider + sidebar rail (drag · double-click reset · persisted) ----------
const RAIL = { side: { def: 232, min: 180, max: 400, snap: 140 }, chat: { def: 470, min: 320, max: 760 } };
function applyRailWidths(){
  const sw = vsGet('sidebarW', null), tw = vsGet('termW', null);
  // --sidebar-w lives on <html>: an inline value on #app would beat the .sidebar-collapsed class rule
  if (sw) document.documentElement.style.setProperty('--sidebar-w', sw + 'px'); else document.documentElement.style.removeProperty('--sidebar-w');
  if (tw) document.getElementById('app').style.setProperty('--term-w', tw + 'px'); else document.getElementById('app').style.removeProperty('--term-w');
}
function clampRail(kind, v){ const r = RAIL[kind]; return Math.min(r.max, Math.max(r.min, Math.round(v))); }
function bindRail(el, kind, onMove, onReset){
  if (!el) return;
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const appEl = document.getElementById('app');
    appEl.classList.add('resizing', kind === 'side' ? 'rs-side' : 'rs-chat');
    const move = (ev) => onMove(ev);
    const up = () => {
      appEl.classList.remove('resizing', 'rs-side', 'rs-chat');
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  el.addEventListener('dblclick', (e) => { e.preventDefault(); onReset(); });
}
(function initRails(){
  const appEl = document.getElementById('app');
  applyRailWidths();
  bindRail(document.getElementById('divider'), 'chat', (ev) => {
    const w = clampRail('chat', window.innerWidth - ev.clientX);
    appEl.style.setProperty('--term-w', w + 'px'); vsSet('termW', w);
  }, () => { vsSet('termW', null); appEl.style.removeProperty('--term-w'); });
  bindRail(document.getElementById('sbRail'), 'side', (ev) => {
    if (ev.clientX < RAIL.side.snap) {           // dragged past the snap point → collapse (Finder-style)
      if (!appEl.classList.contains('sidebar-collapsed')) { appEl.classList.add('sidebar-collapsed'); localStorage.setItem('sidebar', 'collapsed'); }
      return;
    }
    if (appEl.classList.contains('sidebar-collapsed')) { appEl.classList.remove('sidebar-collapsed'); localStorage.setItem('sidebar', 'open'); }
    const w = clampRail('side', ev.clientX);
    document.documentElement.style.setProperty('--sidebar-w', w + 'px'); vsSet('sidebarW', w);
  }, () => { vsSet('sidebarW', null); document.documentElement.style.removeProperty('--sidebar-w'); });
})();

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
  left.classList.toggle('view-tag', v==='tag');
  if (v!=='note') left.classList.remove('rules-mode');
  document.querySelectorAll('.sb-views .sbv').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if(v==='graph') renderGraph();
  else if(v==='table') renderTable();
  else if(v==='dash') renderDash();
  else if(v==='trash') renderTrashView();
  if (typeof renderSidebar === 'function') renderSidebar();
  // Remember the last-open PAGE so a reload restores it (note/pdf/crate are saved by
  // openNote/openPdf/openCrate; here we cover the standalone views).
  try {
    if (v==='graph' || v==='table' || v==='dash' || v==='trash') vsSet('lastOpen', { type:'view', view:v });
  } catch (_) {}
}
document.querySelectorAll('.sb-views .sbv').forEach((b) => { b.onclick = () => setMainView(b.dataset.view); });

// ---------- Theme ----------
// MODE axis: 'light' | 'dark' | 'system' (follows the OS). 墨 is the name of dark mode.
function resolveMode(t){
  if (t === 'system') { try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (_) { return 'light'; } }
  return t === 'dark' ? 'dark' : 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', resolveMode(t));
  try { applyKumikoTheme(); } catch (_) {}   // accent/pattern/ground variants differ per mode
}
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((localStorage.getItem('theme') || 'light') === 'system') applyTheme('system'); }); } catch (_) {}
document.getElementById('themeBtn').onclick = () => {
  const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', t);
  applyTheme(t);
};

// ---------- Kumiko theme (HUE axis: palette preset · pattern · intensity · radii) ----------
// Colour is chosen from the palette only (no free accent); every hue works in light AND dark
// because grounds derive per mode. Global default in localStorage; a vault can override.
function currentKumikoTheme(){
  let th = null;
  try { th = vsGet('vaultTheme', null); } catch (_) {}
  if (!th) { try { th = JSON.parse(localStorage.getItem('kumikoTheme') || 'null'); } catch (_) {} }
  return window.CoreTheme ? window.CoreTheme.normalize(th) : th;
}
function applyKumikoTheme(){
  if (!window.CoreTheme) return;
  const r = document.documentElement;
  const dark = r.getAttribute('data-theme') === 'dark';
  // ONE token map shared with the head boot script (index.html) — the first paint and every
  // later theme change go through CoreTheme.tokens, so they can never disagree.
  const tk = window.CoreTheme.tokens(currentKumikoTheme(), dark);
  Object.keys(tk).forEach((k) => r.style.setProperty(k, tk[k]));
}
function saveKumikoTheme(th, perVault){
  th = window.CoreTheme ? window.CoreTheme.normalize(th) : th;
  if (perVault) { vsSet('vaultTheme', th); }
  else {
    try { localStorage.setItem('kumikoTheme', JSON.stringify(th)); } catch (_) {}
    vsSet('vaultTheme', null);
  }
  applyKumikoTheme();
}
// Patch ONE field of the active theme (used by the gear menu's quick "ลายพื้น" row).
function patchKumikoTheme(patch){
  const th = Object.assign({}, currentKumikoTheme(), patch);
  saveKumikoTheme(th, !!vsGet('vaultTheme', null));
}
try { applyKumikoTheme(); } catch (_) {}

// Theme Studio v2 — two axes (mode × hue), palette-only colour, 4-step pattern intensity.
// Every label goes through t() so the whole sheet is ONE language.
const PATTERN_NAMES = { none: 'ไม่มีลาย', sakura: '桜 ซากุระคุมิโกะ', kazaguruma: '風車 คาซะกุรุมะ', shippou: '七宝 ชิปโป', asanoha: '麻の葉 อาซาโนฮะ', kagome: '籠目 คาโกเมะ',
  kikko: '亀甲 คิกโก', sayagata: '紗綾形 ซายากาตะ', masu: '桝格子 มาสุ', seigaiha: '青海波 เซไกฮะ',
  // 2026-09-01 batch — drawn from the user's refs (hex sheet · sakura woodwork · Tanihata 18/18)
  sakuragoshi: '桜格子 ซากุระโกชิ', hanaasa: '花麻 ฮานะอาสะ', yukiwa: '雪輪 ยูกิวะ', asanoha6: '麻の葉六角 อาสะโนฮะรังผึ้ง',
  kiku: '菊 คิคุ', kumo: '蜘蛛の巣 คุโมะ', goma: '胡麻 โกมะ', shokko6: '蜀江六角 โชกโกหกเหลี่ยม', izutsu: '井筒 อิซุสึ',
  hoshi: '星 โฮชิ', hikari: '光 ฮิคาริ', rindo: '竜胆 รินโด', kakuasa: '角麻 คาคุอาสะ', sanjubishi: '三重菱 ซันจูบิชิ',
  tsumiishi: '積石 สึมิอิชิ', hanabishi: '花菱 ฮานะบิชิ', mitsukude: '三つ組手 มิสึคุเดะ', mikado: '帝 มิคาโดะ',
  shokko8: '蜀江 โชกโก', fundo: '分銅繋ぎ ฟุนโดสึนางิ', senbon: '千本格子 เซ็นบงโกชิ' };
const INTENSITY_NAMES = { off: 'ปิดลาย', faint: 'จาง', mid: 'กลาง', strong: 'ชัด' };
// Theme Studio renders INTO a host (the Settings hub's appearance panel). All changes apply
// instantly — there is no save step for appearance.
function buildThemeStudio(body){
  const CT = window.CoreTheme;
  let th = currentKumikoTheme();
  let perVault = !!vsGet('vaultTheme', null);
  body.classList.add('theme-studio');
  const commit = () => { saveKumikoTheme(th, perVault); render(); };
  const lab = (txt) => { const l = document.createElement('div'); l.className = 'ts-lab'; l.textContent = txt; return l; };
  const seg = (options, cur, onPick) => {
    const s = document.createElement('div'); s.className = 'set-seg';
    options.forEach(([v, l]) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'set-seg-btn' + (cur === v ? ' on' : '');
      b.textContent = l; b.onclick = () => onPick(v); s.appendChild(b);
    });
    return s;
  };
  function render(){
    th = CT.normalize(th);
    body.innerHTML = '';
    // 0 · language (lives here so the hub has ONE appearance page)
    const langRow = document.createElement('div'); langRow.className = 'ts-row';
    langRow.appendChild(lab(t('ภาษา')));
    langRow.appendChild(seg([['th','ไทย'],['en','English']], uiLang, (v) => setUiLang(v)));
    body.appendChild(langRow);
    // 1 · mode
    const mode = localStorage.getItem('theme') || 'light';
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const modeRow = document.createElement('div'); modeRow.className = 'ts-row';
    modeRow.appendChild(lab(t('1 · โหมด')));
    modeRow.appendChild(seg([['light', t('☀ สว่าง')], ['dark', t('墨 มืด')], ['system', t('ตามระบบ')]], mode, (v) => { localStorage.setItem('theme', v); applyTheme(v); render(); }));
    body.appendChild(modeRow);
    // 2 · hue — the palette; cards preview in the CURRENT mode
    body.appendChild(lab(t('2 · สีธีม — ทุกสีใช้ได้ทั้งสว่างและมืด')));
    const pr = document.createElement('div'); pr.className = 'ts-presets six';
    Object.keys(CT.PRESETS).forEach((key) => {
      const p = CT.PRESETS[key];
      const b = document.createElement('button'); b.type = 'button';
      b.className = 'ts-preset' + (th.preset === key ? ' on' : '');
      const sw = document.createElement('span'); sw.className = 'ts-preset-sw';
      const ground = dark ? CT.deriveDark(p.accent).bg : p.palette.bg;
      sw.style.background = ground; sw.style.borderColor = dark ? CT.deriveDark(p.accent).line : p.palette.hover;
      const dot = document.createElement('span'); dot.className = 'ts-preset-dot'; dot.style.background = dark ? CT.deriveAccent(p.accent).accentDark : p.accent;
      sw.appendChild(dot); b.appendChild(sw);
      const nm = document.createElement('span'); nm.textContent = t(p.label); b.appendChild(nm);
      b.onclick = () => { th.preset = key; th.pattern = p.pattern; commit(); };   // a hue brings its paired lattice
      pr.appendChild(b);
    });
    body.appendChild(pr);
    // 3 · pattern + intensity steps
    body.appendChild(lab(t('3 · ลายพื้น (แชต · รายการโน้ต)')));
    const pat = document.createElement('div'); pat.className = 'ts-patterns';
    CT.PATTERNS.forEach((name) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ts-pat' + (th.pattern === name ? ' on' : '');
      b.textContent = t(PATTERN_NAMES[name] || name);
      if (name !== 'none') b.style.backgroundImage = CT.patternUri(name, CT.accentOf(th), 0.22);
      b.onclick = () => { th.pattern = name; commit(); };
      pat.appendChild(b);
    });
    body.appendChild(pat);
    const intRow = document.createElement('div'); intRow.className = 'ts-row';
    intRow.appendChild(lab(t('ความเข้มลาย')));
    intRow.appendChild(seg(CT.INTENSITY_ORDER.map((k) => [k, t(INTENSITY_NAMES[k])]), th.intensity, (v) => { th.intensity = v; commit(); }));
    body.appendChild(intRow);
    // 4 · radius
    const radRow = document.createElement('div'); radRow.className = 'ts-row';
    radRow.appendChild(lab(t('4 · มุม')));
    radRow.appendChild(seg([['shoji', t('โชจิ (คม)')], ['soft', t('นุ่ม (แบบเดิม)')]], th.radius, (v) => { th.radius = v; commit(); }));
    body.appendChild(radRow);
    // foot
    const foot = document.createElement('div'); foot.className = 'ts-foot';
    const cb = document.createElement('label'); cb.className = 'ts-check';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = perVault;
    c.onchange = () => { perVault = c.checked; saveKumikoTheme(th, perVault); };
    cb.appendChild(c); cb.appendChild(document.createTextNode(' ' + t('ใช้ธีมนี้กับ vault นี้เท่านั้น')));
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'ghost sm'; reset.textContent = t('คืนค่าเดิม');
    reset.onclick = () => { th = Object.assign({}, CT.DEFAULT); perVault = false; localStorage.setItem('theme', 'light'); applyTheme('light'); commit(); };
    foot.appendChild(cb); foot.appendChild(reset);
    body.appendChild(foot);
  }
  render();
}
function openThemeStudio(){ openAiSettings('appearance'); }

// Modal into #settingsOverlay. Loads the safe
// view (aiGetConfig) — never the raw key. Default mode is 'api' (the raw CLI /
// terminal was removed in phase 8.5); a stale 'cli' from an older config is
// treated as 'api'. Writes only via 3a-1 IPC.
const AI_MODELS = {
  anthropic: ['claude-opus-4-8','claude-sonnet-5','claude-haiku-4-5-20251001'],
  zai: ['glm-5.2','glm-5.1','glm-4.7'],
};
async function openAiSettings(tab){
  const ov=document.getElementById('settingsOverlay'); ov.innerHTML='';
  const cfg = await window.api.aiGetConfig();

  const card=document.createElement('div'); card.className='settings-card'; card.id='aiSettingsModal';
  const head=document.createElement('div'); head.className='tbl-head';
  const title=document.createElement('span'); title.textContent=t('ตั้งค่า');
  const xBtn=document.createElement('button'); xBtn.className='rv-close'; xBtn.id='aiSettingsCancel'; xBtn.innerHTML=icoSvg('x','sm');
  const dismiss=()=>{ ov.hidden=true; ov.innerHTML=''; };
  xBtn.onclick=dismiss;
  head.appendChild(title); head.appendChild(xBtn); card.appendChild(head);

  // SIDEBAR layout: left nav (section titles) + right detail pane. Each section appends
  // into its panel; the nav toggles which panel is visible. The footer stays global.
  const sbody=document.createElement('div'); sbody.className='ai-settings-body';
  const snav=document.createElement('div'); snav.className='ai-settings-nav';
  const sdetail=document.createElement('div'); sdetail.className='ai-settings-detail';
  sbody.appendChild(snav); sbody.appendChild(sdetail); card.appendChild(sbody);
  const _panels={};
  const _panel=(key)=>{ const p=document.createElement('div'); p.className='ai-panel'; sdetail.appendChild(p); _panels[key]=p; return p; };
  const panelAppearance=_panel('appearance');
  const panelProvider=_panel('provider'), panelRag=_panel('rag'), panelPrompts=_panel('prompts'), panelCollab=_panel('collab'), panelAbout=_panel('about');
  // footer follows the section: Test connection only makes sense on Provider; Save/Cancel only on
  // pages that hold AI config (appearance applies instantly, about has nothing to save).
  const FOOT_SAVE=new Set(['provider','rag','prompts','collab']);
  let _foot=null;
  const _showPanel=(key)=>{ Object.keys(_panels).forEach(k=>{ _panels[k].style.display=(k===key)?'':'none'; }); snav.querySelectorAll('.ai-nav-item').forEach(n=>n.classList.toggle('on', n.dataset.k===key));
    if (_foot){ _foot.classList.toggle('foot-provider', key==='provider'); _foot.classList.toggle('foot-save', FOOT_SAVE.has(key)); } };
  // nav groups: Appearance · AI (provider / RAG / prompts) · Account · About
  const _navSec=(label)=>{ const h=document.createElement('div'); h.className='ai-nav-sec'; h.textContent=label; snav.appendChild(h); };
  const _navItem=(k,icon,label)=>{ const n=document.createElement('button'); n.type='button'; n.className='ai-nav-item'; n.dataset.k=k; n.innerHTML=icoSvg(icon,'sm')+'<span></span>'; n.querySelector('span').textContent=label; n.onclick=()=>_showPanel(k); snav.appendChild(n); };
  _navItem('appearance','crate',t('การแสดงผล'));
  _navSec('AI');
  _navItem('provider','sparkle',t('ผู้ให้บริการ & โมเดล'));
  _navItem('rag','search',t('อ้างอิงโน้ต (RAG)'));
  _navItem('prompts','terminal',t('คำสั่ง & กติกา'));
  _navSec(t('อื่น ๆ'));
  _navItem('collab','link',t('Collab & บัญชี'));
  _navItem('about','note',t('เกี่ยวกับ'));
  // appearance applies instantly — no save needed; the footer's save only concerns AI config
  { const note=document.createElement('div'); note.className='ai-note'; note.textContent=t('การเปลี่ยนแปลงในหน้านี้มีผลทันที'); panelAppearance.appendChild(note);
    const host=document.createElement('div'); panelAppearance.appendChild(host); buildThemeStudio(host); }

  // CLI (subscription) mode is DESKTOP-only — a browser can't spawn a process. On web,
  // a stale 'cli' config falls back to 'api'.
  const isDesktop = (typeof window.KUMIKO_WEB === 'undefined');
  let selectedMode = cfg.mode;
  if (selectedMode === 'cli' && !isDesktop) selectedMode = 'api';
  if (selectedMode !== 'cli' && selectedMode !== 'managed') selectedMode = 'api';

  // MODE segmented control — cli(desktop) / api / managed(disabled).
  const modeSeg=document.createElement('div'); modeSeg.className='ai-mode-seg';
  const MODES=[];
  if (isDesktop) MODES.push(['cli', t('CLI (subscription)'), t('ใช้ subscription — ไม่ต้องมีคีย์')]);
  MODES.push(['api', t('API key'), t('ใส่คีย์เอง')]);
  MODES.push(['managed', t('Managed'), t('เร็ว ๆ นี้')]);
  MODES.forEach(([m, label, sub])=>{
    const b=document.createElement('button'); b.type='button'; b.className='ai-mode-btn'+(selectedMode===m?' on':''); b.dataset.mode=m;
    const l=document.createElement('span'); l.className='ai-mode-lab'; l.textContent=label;
    const s=document.createElement('span'); s.className='ai-mode-sub'; s.textContent=sub;
    b.appendChild(l); b.appendChild(s);
    if (m==='managed') b.disabled=true;
    b.onclick=()=>{ if (b.disabled) return; selectedMode=m; modeSeg.querySelectorAll('.ai-mode-btn').forEach((x)=>x.classList.remove('on')); b.classList.add('on'); syncApiSection(); };
    modeSeg.appendChild(b);
  });
  panelProvider.appendChild(modeSeg);

  // API SECTION — visible only when selected mode === 'api'
  const apiSection=document.createElement('div'); apiSection.id='aiApiSection'; apiSection.className='ai-api-section';

  const pRow=document.createElement('div'); pRow.className='settings-field';
  const pLab=document.createElement('label'); pLab.textContent=t('ผู้ให้บริการ');
  const pSel=document.createElement('select'); pSel.id='aiProviderSel'; pSel.className='ai-sel';
  [['anthropic','Anthropic (Claude)'],['zai-coding','Z.ai Coding Plan (GLM) — แพ็กเกจรายเดือน'],['zai','Z.ai (GLM) — เติมเงิน pay-as-you-go']].forEach(([v, l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; pSel.appendChild(o); });
  pSel.value = (cfg.provider==='zai' || cfg.provider==='zai-coding') ? cfg.provider : 'anthropic';
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

  // Thinking / reasoning mode — enabled only for models that actually support it
  // (per the AICaps capability table). Off for others.
  const tRow=document.createElement('div'); tRow.className='settings-field ai-think-row';
  const tLab=document.createElement('label'); tLab.textContent=t('โหมดคิด (thinking)');
  const tWrap=document.createElement('div'); tWrap.className='ai-think-wrap';
  const tChk=document.createElement('input'); tChk.type='checkbox'; tChk.id='aiThinkToggle';
  const tHint=document.createElement('span'); tHint.className='ai-think-hint';
  tWrap.appendChild(tChk); tWrap.appendChild(tHint); tRow.appendChild(tLab); tRow.appendChild(tWrap); apiSection.appendChild(tRow);

  // ---- vision: which model handles image messages (Z.ai only — every Claude model sees) ----
  const vRow=document.createElement('div'); vRow.className='settings-field';
  const vLab=document.createElement('label'); vLab.textContent=t('โมเดลสำหรับภาพ') + ' 👁';
  const vSel=document.createElement('select'); vSel.id='aiVisionSel'; vSel.className='ai-sel';
  const vHint=document.createElement('p'); vHint.className='ai-note'; vHint.textContent=t('ใช้เฉพาะข้อความที่มีภาพแนบ — อยู่ในแพ็กเกจเดียวกับโมเดลหลัก');
  vRow.appendChild(vLab); vRow.appendChild(vSel); vRow.appendChild(vHint); apiSection.appendChild(vRow);
  const avRow=document.createElement('label'); avRow.className='ai-rag-row'; avRow.style.display='flex'; avRow.style.gap='8px'; avRow.style.alignItems='flex-start';
  const avChk=document.createElement('input'); avChk.type='checkbox'; avChk.id='aiAutoVision'; avChk.checked = cfg.autoVision !== false;
  const avTxt=document.createElement('span'); avTxt.innerHTML='<b></b><small class="ai-note" style="display:block"></small>';
  avTxt.querySelector('b').textContent=t('สลับไปรุ่นภาพอัตโนมัติเมื่อแนบภาพ');
  avTxt.querySelector('small').textContent=t('ปิด = ปุ่มแนบจะจางเมื่อโมเดลหลักมองภาพไม่ได้');
  avRow.appendChild(avChk); avRow.appendChild(avTxt); apiSection.appendChild(avRow);
  const rnRow=document.createElement('label'); rnRow.className='ai-rag-row'; rnRow.style.display='flex'; rnRow.style.gap='8px'; rnRow.style.alignItems='flex-start';
  const rnChk=document.createElement('input'); rnChk.type='checkbox'; rnChk.id='aiReadNoteImages'; rnChk.checked = cfg.readNoteImages !== false;
  const rnTxt=document.createElement('span'); rnTxt.innerHTML='<b></b><small class="ai-note" style="display:block"></small>';
  rnTxt.querySelector('b').textContent=t('ให้ AI เห็นภาพในโน้ตเมื่อใช้ READ-NOTE');
  rnTxt.querySelector('small').textContent=t('โน้ตที่มีสไลด์/ภาพฝังอยู่จะแนบภาพจริงให้ AI (สูงสุด 4 ภาพ/ครั้ง)');
  rnRow.appendChild(rnChk); rnRow.appendChild(rnTxt); apiSection.appendChild(rnRow);
  function syncVision(){
    const caps = window.AICaps; if (!caps) { vRow.style.display='none'; return; }
    const allSee = caps.modelsForProvider(pSel.value).length && caps.modelsForProvider(pSel.value).every((m) => m.vision);
    const vModels = caps.modelsForProvider(pSel.value).filter((m) => m.vision);
    if (allSee || !vModels.length) { vRow.style.display='none'; return; }
    vRow.style.display='';
    vSel.innerHTML='';
    vModels.forEach((m) => { const o=document.createElement('option'); o.value=m.id; o.textContent=m.label; vSel.appendChild(o); });
    const want = (cfg.provider === pSel.value && cfg.visionModel && vModels.some((m) => m.id === cfg.visionModel)) ? cfg.visionModel : (caps.visionModelFor(pSel.value, mSel.value) || vModels[0].id);
    vSel.value = want;
  }
  function syncThinking(){
    const caps = window.AICaps;
    const supported = caps ? caps.modelSupportsThinking(pSel.value, mSel.value) : false;
    tChk.disabled = !supported;
    tRow.classList.toggle('disabled', !supported);
    if (!supported){ tChk.checked = false; tHint.textContent = t('โมเดลนี้ไม่รองรับ'); return; }
    const userChoice = (cfg.provider === pSel.value && cfg.model === mSel.value) ? cfg.thinking : null;
    tChk.checked = caps.resolveThinking(pSel.value, mSel.value, userChoice);
    syncVision();
    tHint.textContent = t('ค่าเริ่มต้น: ') + (caps.thinkingDefault(pSel.value) ? t('เปิด') : t('ปิด'));
  }
  mSel.onchange = syncThinking;

  const note=document.createElement('p'); note.className='ai-note'; note.textContent=t('🔒 กุญแจถูกเข้ารหัสเก็บในเครื่อง — ไม่ถูกส่งไปที่ไหนนอกจากผู้ให้บริการที่เลือก');
  apiSection.appendChild(note);
  panelProvider.appendChild(apiSection);

  // CLI (subscription) SECTION — desktop only. Runs the logged-in `claude` / `opencode`
  // CLI so AI uses your SUBSCRIPTION (no API key). Visible only when mode === 'cli'.
  let ceSel=null, cmInput=null, cmRow=null, claudeSel=null, claudeRow=null;
  const CLAUDE_CLI_MODELS = [['', t('ค่าเริ่มต้นของ CLI')], ['opus','Opus'], ['sonnet','Sonnet'], ['haiku','Haiku']];
  const cliSection=document.createElement('div'); cliSection.id='aiCliSection'; cliSection.className='ai-api-section';
  if (isDesktop){
    const ceRow=document.createElement('div'); ceRow.className='settings-field';
    const ceLab=document.createElement('label'); ceLab.textContent=t('เครื่องมือ (CLI)');
    ceSel=document.createElement('select'); ceSel.id='aiCliEngine'; ceSel.className='ai-sel';
    [['claude','Claude — claude CLI (Pro/Max subscription)'],['glm','GLM — opencode (Coding Plan)']].forEach(([v,l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; ceSel.appendChild(o); });
    ceSel.value = (cfg.cliEngine==='glm') ? 'glm' : 'claude';
    ceRow.appendChild(ceLab); ceRow.appendChild(ceSel); cliSection.appendChild(ceRow);

    // Claude model picker (alias → `claude --model`); shown when engine === 'claude'
    claudeRow=document.createElement('div'); claudeRow.className='settings-field';
    const clLab=document.createElement('label'); clLab.textContent=t('โมเดล (Claude)');
    claudeSel=document.createElement('select'); claudeSel.id='aiCliClaudeModel'; claudeSel.className='ai-sel';
    CLAUDE_CLI_MODELS.forEach(([v,l])=>{ const o=document.createElement('option'); o.value=v; o.textContent=l; claudeSel.appendChild(o); });
    claudeSel.value = (cfg.cliEngine!=='glm' && cfg.cliModel) ? cfg.cliModel : '';
    claudeRow.appendChild(clLab); claudeRow.appendChild(claudeSel); cliSection.appendChild(claudeRow);

    // opencode/GLM model (free text); shown when engine === 'glm'
    cmRow=document.createElement('div'); cmRow.className='settings-field';
    const cmLab=document.createElement('label'); cmLab.textContent=t('โมเดล (opencode)');
    cmInput=document.createElement('input'); cmInput.id='aiCliModel'; cmInput.type='text'; cmInput.className='ai-sel'; cmInput.placeholder='zai-coding-plan/glm-5.2';
    cmInput.value = (cfg.cliEngine==='glm' && cfg.cliModel) ? cfg.cliModel : 'zai-coding-plan/glm-5.2';
    cmRow.appendChild(cmLab); cmRow.appendChild(cmInput); cliSection.appendChild(cmRow);

    const cliNote=document.createElement('p'); cliNote.className='ai-note';
    cliNote.textContent=t('ใช้ subscription ที่ล็อกอินไว้ในเครื่องผ่าน CLI — ต้องติดตั้ง `claude` / `opencode` และล็อกอินแล้ว (ไม่ต้องใช้ API key)');
    cliSection.appendChild(cliNote);
    const syncCliEngine=()=>{ const glm = (ceSel.value==='glm'); cmRow.style.display = glm ? '' : 'none'; claudeRow.style.display = glm ? 'none' : ''; };
    ceSel.onchange=syncCliEngine; syncCliEngine();
  }
  panelProvider.appendChild(cliSection);

  // AMBIENT RAG toggle — per-vault on/off (default ON). Applies to CLI + API chat alike.
  const ragRow=document.createElement('div'); ragRow.className='ai-rag-row';
  const ragCk=document.createElement('input'); ragCk.type='checkbox'; ragCk.id='aiRagToggle'; ragCk.checked=vsGet('ragAmbient', true);
  const ragLab=document.createElement('label'); ragLab.setAttribute('for','aiRagToggle'); ragLab.className='ai-rag-lab'; ragLab.textContent=t('ให้ AI อ้างอิงโน้ตของฉันอัตโนมัติ');
  ragRow.appendChild(ragCk); ragRow.appendChild(ragLab); panelRag.appendChild(ragRow);
  const ragHint=document.createElement('p'); ragHint.className='ai-rag-hint'; ragHint.textContent=t('ใช้เนื้อหาโน้ตที่เกี่ยวข้องเป็นบริบทให้ AI โดยอัตโนมัติ (เฉพาะ vault นี้)');
  panelRag.appendChild(ragHint);

  // SEMANTIC search toggle — per-vault on/off (default OFF). Requires a Z.ai key +
  // network calls; the main-side pipeline gates on this flag and degrades with no key.
  const semRow=document.createElement('div'); semRow.className='ai-rag-row';
  const semCk=document.createElement('input'); semCk.type='checkbox'; semCk.id='aiSemanticToggle'; semCk.checked=vsGet('ragSemantic', false);
  const semLab=document.createElement('label'); semLab.setAttribute('for','aiSemanticToggle'); semLab.className='ai-rag-lab'; semLab.textContent=t('ใช้การค้นหาเชิงความหมาย (semantic)');
  semRow.appendChild(semCk); semRow.appendChild(semLab); panelRag.appendChild(semRow);
  const semHint=document.createElement('p'); semHint.className='ai-rag-hint'; semHint.textContent=t('ค้นเจอโน้ตที่เกี่ยวข้องแม้ใช้คำไม่ตรง — ต้องมี API key ของ Z.ai และมีการเรียกเครือข่าย (เฉพาะ vault นี้)');
  panelRag.appendChild(semHint);
  const semWarn=document.createElement('p'); semWarn.id='aiSemanticWarn'; semWarn.className='ai-sem-warn'; semWarn.textContent=t('เปิด semantic ไว้แต่ยังไม่มี API key ของ Z.ai — จะยังไม่ทำงานจนกว่าจะใส่คีย์ที่โหมด API key ด้านบน');
  panelRag.appendChild(semWarn);
  function refreshSemWarn(){ semWarn.hidden = !(semCk.checked && cfg.hasKey && !cfg.hasKey.zai); }
  semCk.onchange=refreshSemWarn;
  refreshSemWarn();

  // ---- RAG weight tuning (Phase 1) — how the AI ranks which notes to pull in. Two axes:
  // RELEVANCE (question + open doc) × CONNECTION prior (your links > system guesses). Live-tunable.
  const RAG_W_DEFAULTS = (window.CoreRag && window.CoreRag.DEFAULT_RAG_WEIGHTS) || {};
  const RAG_W_FIELDS = [
    ['question',    t('คำถามปัจจุบัน'),        t('ยิ่งสูง ยิ่งเน้นโน้ตที่ตรงกับสิ่งที่ถามตอนนี้')],
    ['doc',         t('เล่มที่เปิดอยู่'),       t('ยิ่งสูง ยิ่งดึงโน้ตที่ “เรื่องเดียวกัน” กับเอกสารที่กำลังเปิด แม้คำถามจะกว้าง')],
    ['explicit',    t('ลิงก์ที่คุณสร้าง (Tier 1)'), t('[[wikilink]] + backlink ที่คุณเขียนเอง — เจตนาชัดสุด ควรสูงสุด')],
    ['mention',     t('การพาดพิงชื่อโน้ต (Tier 2)'), t('ข้อความพูดถึงชื่อโน้ตตรง ๆ แต่ยังไม่ได้ทำลิงก์ (unlinked mention)')],
    ['similar',     t('ความคล้ายเชิงความหมาย (Tier 3)'), t('ระบบเดาจากความคล้ายของเนื้อหา (ต้องเปิด semantic) — อ่อนสุด')],
    ['reciprocity', t('ตัวคูณลิงก์สองทาง'),     t('เมื่อสองโน้ตลิงก์หากันไป-กลับ ความเชื่อมโยงแข็งกว่า → คูณเพิ่ม')],
    ['minRelevance', t('เกณฑ์ผ่านขั้นต่ำ'), t('โน้ตต้องได้คะแนนอย่างน้อยกี่เท่าของอันดับ 1 ถึงจะถูกดึงมา (0.25 = 25%) — ยิ่งสูงยิ่งอ้างอิงน้อยแต่ตรงขึ้น ตั้ง 0 = เอาหมดทุกอันที่แตะกัน')],
    ['capExplicit', t('เพดานโน้ตที่ดึงเพราะลิงก์อย่างเดียว'), t('โน้ตที่ “คุณลิงก์เอง” เท่านั้นที่ขึ้นมาได้แม้ไม่ตรงคำถาม และไม่เกินจำนวนนี้ — ส่วนการพาดพิง/ความคล้ายต้องตรงคำถามด้วยเสมอ ตั้ง 0 = ต้องตรงคำถามทุกกรณี')],
    ['limit',       t('จำนวนโน้ตสูงสุดต่อครั้ง'), t('เพดานรวมของโน้ตที่ดึงเข้าบริบทแต่ละครั้ง')],
    ['p1Budget',    t('งบเอกสารที่เปิด (ตัวอักษร)'), t('เกินงบนี้ ระบบจะคัดเฉพาะท่อนที่เกี่ยวกับคำถาม — ตั้งต่ำ = คัดแทบทุกครั้ง, ตั้งสูง = ส่งทั้งเอกสารบ่อยขึ้น')],
    ['noteBudget',  t('งบต่อโน้ตเสริม (ตัวอักษร)'), t('โน้ตเสริมแต่ละใบถูกคัดเฉพาะท่อนที่เกี่ยวข้องภายในงบนี้ — ไม่ยัดทั้งใบอีกต่อไป')],
  ];
  const wHd=document.createElement('h4'); wHd.className='ai-rag-wh'; wHd.textContent=t('น้ำหนักการดึงบริบท (ปรับทดลองได้)'); panelRag.appendChild(wHd);
  const wIntro=document.createElement('p'); wIntro.className='ai-rag-hint'; wIntro.textContent=t('คะแนนสุดท้าย = ความเกี่ยวกับคำถาม/เล่มที่เปิด × (1 + ความเชื่อมโยง) ค่าลิงก์ที่คุณสร้างจึงเป็น “ตัวคูณ” ไม่ใช่ตัวกลบคำถาม'); panelRag.appendChild(wIntro);
  const wSaved = vsGet('ragWeights', {});
  const wInputs = {};
  const collectWeights = () => { const o={}; RAG_W_FIELDS.forEach(([k])=>{ const v=parseFloat(wInputs[k].value); if(isFinite(v)) o[k]=v; }); vsSet('ragWeights', o); };
  RAG_W_FIELDS.forEach(([key, label, hint]) => {
    const row=document.createElement('div'); row.className='ai-ragw-row';
    const lab=document.createElement('label'); lab.className='ai-ragw-lab'; lab.textContent=label;
    const inp=document.createElement('input'); inp.type='number'; inp.className='ai-ragw-inp';
    inp.step=({capExplicit:'1',limit:'1',minRelevance:'0.05',p1Budget:'500',noteBudget:'100'})[key]||'0.1'; inp.min='0';
    inp.value=String((key in wSaved)?wSaved[key]:(RAG_W_DEFAULTS[key]!=null?RAG_W_DEFAULTS[key]:''));
    inp.oninput=collectWeights; wInputs[key]=inp;
    const hintEl=document.createElement('p'); hintEl.className='ai-ragw-hint'; hintEl.textContent=hint;
    const head=document.createElement('div'); head.className='ai-ragw-head'; head.appendChild(lab); head.appendChild(inp);
    row.appendChild(head); row.appendChild(hintEl); panelRag.appendChild(row);
  });
  const wReset=document.createElement('button'); wReset.type='button'; wReset.className='ai-ragw-reset'; wReset.textContent=t('คืนค่าเริ่มต้น');
  wReset.onclick=()=>{ RAG_W_FIELDS.forEach(([k])=>{ if(wInputs[k]) wInputs[k].value=String(RAG_W_DEFAULTS[k]!=null?RAG_W_DEFAULTS[k]:''); }); vsSet('ragWeights', {}); };
  panelRag.appendChild(wReset);

  // ---- PROMPTS & RULES page ----
  // (1) KUMIKO.md card → the rules desk. (2) Variable legend from PROMPT_VARS. (3) One card per
  // shortcut: where it lives, a textarea with a mirror layer that paints {var} chips (unknown
  // ones red), insert buttons, per-card reset + edited dot, and a live "will be sent as" preview
  // substituted from the open note. The footer's Save persists (same ptFields contract).
  const _sec=(txt)=>{ const h=document.createElement('div'); h.className='pt-sec'; h.textContent=txt; return h; };
  panelPrompts.appendChild(_sec(t('กติกายืนพื้น')));
  const kmCard=document.createElement('div'); kmCard.className='pt-rules';
  kmCard.innerHTML='<div class="rules-hanko" aria-hidden="true">組</div><div class="pt-rules-t"><b></b><small></small><div class="rules-meter"><div class="rules-bar"><i></i></div><span class="pt-rules-cnt">…</span></div></div>';
  kmCard.querySelector('b').textContent='KUMIKO.md — '+t('กติกาการทำงานร่วมกับ AI');
  kmCard.querySelector('small').textContent=t('ส่งให้ AI ทุกข้อความ · AI แก้เองไม่ได้ เสนอได้ คุณยืนยัน');
  const kmBtn=document.createElement('button'); kmBtn.type='button'; kmBtn.className='solid'; kmBtn.textContent=t('เปิดแก้');
  // resetting the seed flag first means this doorway also RE-CREATES a deleted file —
  // explicitly asking to edit the rules is consent to have the file exist
  kmBtn.onclick=async()=>{ dismiss(); vsSet('kumikoSeeded', false); try { await ensureKumikoSeed(); } catch (_) {} try { await openNote('KUMIKO.md'); } catch (_) {} };
  kmCard.appendChild(kmBtn); panelPrompts.appendChild(kmCard);
  (async()=>{ let n=0; try { n=String(await window.api.readNote('KUMIKO.md')||'').trim().length; } catch(_){}
    const pct=Math.min(100,Math.round(n/RULES_BUDGET*100)); const fill=kmCard.querySelector('.rules-bar i'); fill.style.width=pct+'%'; fill.classList.toggle('over',n>RULES_BUDGET);
    kmCard.querySelector('.pt-rules-cnt').textContent=n.toLocaleString()+' / '+RULES_BUDGET.toLocaleString(); })();

  panelPrompts.appendChild(_sec(t('ตัวแปรที่ใช้ได้')));
  const legend=document.createElement('div'); legend.className='pt-legend';
  PROMPT_VARS.forEach((v)=>{
    const chip=document.createElement('span'); chip.className='pt-var v-'+v.key; chip.textContent='{'+v.key+'}';
    const d=document.createElement('span'); d.innerHTML='<span></span><small></small>';
    d.querySelector('span').textContent=t(v.label);
    d.querySelector('small').textContent=v.scope==='toolbar' ? t('เฉพาะคำสั่งใน toolbar (เมื่อเลือกข้อความ) — ในเมนู ✨ ค่าจะว่าง') : t('ใช้ได้ทุกคำสั่ง');
    legend.appendChild(chip); legend.appendChild(d);
  });
  panelPrompts.appendChild(legend);

  panelPrompts.appendChild(_sec(t('คำสั่งปุ่มลัด AI')));
  const ptFields={};
  const _esc=(x)=>x.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _paint=(tpl)=>{ const known=new Set(PROMPT_VARS.map(v=>v.key));
    return _esc(tpl).replace(/\{([^{}\n]{1,24})\}/g,(m,k)=> known.has(k) ? '<b class="pt-var v-'+k+'">'+m+'</b>' : '<b class="pt-var v-bad" title="'+t('ไม่รู้จักตัวแปรนี้')+'">'+m+'</b>'); };
  const _previewVals=promptVarValues(PROMPT_VARS[0].example, currentNote || PROMPT_VARS[2].example);
  Object.keys(DEFAULT_PROMPTS).forEach((key)=>{
    const card=document.createElement('div'); card.className='pt-cmd';
    const head=document.createElement('div'); head.className='pt-cmd-head';
    head.innerHTML=icoSvg({explain:'sparkle',search:'search',link:'link',tldr:'tldr',quiz:'quiz'}[key]||'sparkle','sm')+'<b></b><span class="pt-where"></span><span class="pt-dot" title="'+t('แก้ไขแล้ว')+'"></span><button type="button" class="pt-mini"></button>';
    head.querySelector('b').textContent=t(PROMPT_LABELS[key]||key);
    head.querySelector('.pt-where').textContent=PROMPT_WHERE[key]==='toolbar' ? t('ใน toolbar เมื่อเลือกข้อความ') : t('ในเมนู ✨ ของแถบบน');
    const mini=head.querySelector('.pt-mini'); mini.textContent=t('คืนค่าข้อนี้');
    card.appendChild(head);
    const wrap=document.createElement('div'); wrap.className='pt-ta-wrap';
    const hl=document.createElement('div'); hl.className='pt-hl'; hl.setAttribute('aria-hidden','true');
    const ta=document.createElement('textarea'); ta.className='ai-prompt-ta pt-ta'; ta.value=promptTemplates[key]||DEFAULT_PROMPTS[key]; ta.rows=2; ta.spellcheck=false;
    wrap.appendChild(hl); wrap.appendChild(ta); card.appendChild(wrap); ptFields[key]=ta;
    const ins=document.createElement('div'); ins.className='pt-ins'; const insLab=document.createElement('span'); insLab.textContent=t('แทรกตัวแปร:'); ins.appendChild(insLab);
    PROMPT_VARS.forEach((v)=>{ const b=document.createElement('button'); b.type='button'; b.className='pt-var v-'+v.key; b.textContent='{'+v.key+'}';
      b.onclick=()=>{ const st=ta.selectionStart||0, en=ta.selectionEnd||st; ta.value=ta.value.slice(0,st)+'{'+v.key+'}'+ta.value.slice(en); ta.focus(); ta.selectionStart=ta.selectionEnd=st+v.key.length+2; refresh(); };
      ins.appendChild(b); });
    card.appendChild(ins);
    const prev=document.createElement('div'); prev.className='pt-prev'; prev.innerHTML='<span class="pt-pl"></span><span class="pt-prev-txt"></span>'; prev.querySelector('.pt-pl').textContent=t('จะส่งเป็น');
    card.appendChild(prev);
    const refresh=()=>{ const v=ta.value; hl.innerHTML=_paint(v)+'\n';
      ta.style.height='auto'; ta.style.height=Math.max(44, ta.scrollHeight)+'px'; hl.style.height=ta.style.height;
      const edited=v.trim()!==DEFAULT_PROMPTS[key]; card.classList.toggle('edited',edited);
      let out=v; PROMPT_VARS.forEach((pv)=>{ out=out.split('{'+pv.key+'}').join(_previewVals[pv.key]||''); });
      prev.querySelector('.pt-prev-txt').textContent=out; };
    ta.addEventListener('input',refresh); ta.addEventListener('scroll',()=>{ hl.scrollTop=ta.scrollTop; });
    mini.onclick=()=>{ ta.value=DEFAULT_PROMPTS[key]; refresh(); };
    card._refresh=refresh; panelPrompts.appendChild(card);
    setTimeout(refresh,0);
  });
  const ptReset=document.createElement('button'); ptReset.type='button'; ptReset.className='ghost sm pt-reset-all'; ptReset.textContent=t('คืนค่าคำสั่งเริ่มต้นทั้งหมด');
  ptReset.onclick=()=>{ panelPrompts.querySelectorAll('.pt-cmd').forEach((c)=>{ const k=Object.keys(ptFields).find(k=>c.contains(ptFields[k])); if(k){ ptFields[k].value=DEFAULT_PROMPTS[k]; c._refresh(); } }); };
  panelPrompts.appendChild(ptReset);

  // PROFILE section (phase 7b-1) — local name + color for collab identity.
  // Sits above the collab toggle. Selection is held in selectedColor and only
  // persisted on Save (Cancel/close changes nothing). Reuses ai-rag-row so it
  // lines up with the RAG/semantic/collab rows.
  const COLLAB_PALETTE = ['#E2542A','#3B82C4','#8B5CB8','#2E9E6B','#D98A1E','#C0433F'];
  let selectedColor = localStorage.getItem('collabColor') || COLLAB_PALETTE[0];
  const profHeadRow=document.createElement('div'); profHeadRow.className='ai-rag-row';
  const profHead=document.createElement('span'); profHead.className='ai-rag-lab'; profHead.textContent=t('โปรไฟล์ของฉัน (สำหรับ collab)');
  profHeadRow.appendChild(profHead); panelCollab.appendChild(profHeadRow);
  const profNameRow=document.createElement('div'); profNameRow.className='ai-rag-row';
  const profNameLab=document.createElement('label'); profNameLab.setAttribute('for','aiProfileName'); profNameLab.className='ai-rag-lab'; profNameLab.textContent=t('ชื่อที่แสดง');
  const profNameInput=document.createElement('input'); profNameInput.type='text'; profNameInput.id='aiProfileName'; profNameInput.className='ai-collab-relay'; profNameInput.value=localStorage.getItem('collabName') || ''; profNameInput.placeholder=t('ชื่อที่จะแสดงตอนแก้ร่วมกัน');
  profNameRow.appendChild(profNameLab); profNameRow.appendChild(profNameInput); panelCollab.appendChild(profNameRow);
  const profColorRow=document.createElement('div'); profColorRow.id='aiProfileColors'; profColorRow.className='profile-sw-row';
  COLLAB_PALETTE.forEach((c)=>{
    const sw=document.createElement('span'); sw.className='profile-sw'+(c===selectedColor?' sel':''); sw.style.background=c; sw.dataset.color=c;
    sw.onclick=()=>{ selectedColor=c; profColorRow.querySelectorAll('.profile-sw').forEach((x)=>x.classList.toggle('sel', x.dataset.color===c)); };
    profColorRow.appendChild(sw);
  });
  panelCollab.appendChild(profColorRow);
  const profHint=document.createElement('p'); profHint.className='ai-rag-hint'; profHint.textContent=t('ใช้แสดงชื่อ/สีของคุณให้คนอื่นเห็นตอนแก้โน้ตร่วมกัน (เก็บในเครื่องนี้)');
  panelCollab.appendChild(profHint);

  // COLLAB toggle — per-vault opt-in (default OFF). Real-time co-editing via a
  // relay; experimental. Reads the same vsGet('collab') the editor gates on.
  const collabHeadRow=document.createElement('div'); collabHeadRow.className='ai-rag-row';
  const collabHead=document.createElement('span'); collabHead.className='ai-rag-lab'; collabHead.textContent=t('การทำงานร่วมกัน (ทดลอง)');
  collabHeadRow.appendChild(collabHead); panelCollab.appendChild(collabHeadRow);
  const collabRow=document.createElement('div'); collabRow.className='ai-rag-row';
  const collabCk=document.createElement('input'); collabCk.type='checkbox'; collabCk.id='aiCollabToggle'; collabCk.checked=vsGet('collab', false);
  const collabLab=document.createElement('label'); collabLab.setAttribute('for','aiCollabToggle'); collabLab.className='ai-rag-lab'; collabLab.textContent=t('เปิดการแก้ไขร่วมกันแบบเรียลไทม์ (collab)');
  collabRow.appendChild(collabCk); collabRow.appendChild(collabLab); panelCollab.appendChild(collabRow);
  const collabHint=document.createElement('p'); collabHint.className='ai-rag-hint'; collabHint.textContent=t('แก้โน้ตพร้อมกันหลายเครื่องผ่านเซิร์ฟเวอร์ relay — ทดลอง, เฉพาะ vault นี้ (ต้องรีโหลดหลังเปลี่ยน)');
  panelCollab.appendChild(collabHint);
  // relay URL — app-wide (localStorage). Default matches collabRelayUrl()'s fallback.
  const relayRow=document.createElement('div'); relayRow.className='ai-rag-row';
  const relayLab=document.createElement('label'); relayLab.setAttribute('for','aiCollabRelay'); relayLab.className='ai-rag-lab'; relayLab.textContent=t('ที่อยู่ relay');
  const relayInput=document.createElement('input'); relayInput.type='text'; relayInput.id='aiCollabRelay'; relayInput.className='ai-collab-relay'; relayInput.placeholder='ws://127.0.0.1:1234'; relayInput.value=localStorage.getItem('collabRelay') || 'ws://127.0.0.1:1234';
  relayRow.appendChild(relayLab); relayRow.appendChild(relayInput); panelCollab.appendChild(relayRow);

  // ACCOUNT area (phase 7b-4) — OPTIONAL login/signup for authed collab relays.
  // Token stored encrypted via safeStorage; only used to build the WS url. Login is
  // OPTIONAL — without it the app works fully offline (provider connects with no token).
  const authHeadRow=document.createElement('div'); authHeadRow.className='ai-rag-row';
  const authHead=document.createElement('span'); authHead.className='ai-rag-lab'; authHead.textContent=t('บัญชี (ไม่บังคับ — สำหรับ collab)');
  authHeadRow.appendChild(authHead); panelCollab.appendChild(authHeadRow);
  const authArea=document.createElement('div'); authArea.id='aiAuthArea'; authArea.className='ai-auth-area';
  const authInner=document.createElement('div'); authInner.id='aiAuthInner';
  const authMsg=document.createElement('p'); authMsg.id='aiAuthMsg'; authMsg.className='ai-auth-msg';
  authArea.appendChild(authInner); authArea.appendChild(authMsg); panelCollab.appendChild(authArea);
  function setAuthMsg(s){ authMsg.textContent = s || ''; }
  async function renderAuthArea(){
    let acc = null;
    try { acc = await window.api.authGetToken(); } catch (_) { acc = null; }
    authInner.innerHTML='';
    if (acc && acc.token) {
      const line=document.createElement('span'); line.className='ai-auth-line'; line.textContent=t('เข้าสู่ระบบเป็น') + ' ' + acc.email;
      const lo=document.createElement('button'); lo.type='button'; lo.id='aiAuthLogout'; lo.className='ghost'; lo.textContent=t('ออกจากระบบ');
      lo.onclick=async ()=>{ await window.api.authClear(); if (typeof window.KUMIKO_WEB !== 'undefined') { location.reload(); return; } setAuthMsg(''); await renderAuthArea(); };
      authInner.appendChild(line); authInner.appendChild(lo);
      // SYNC-NOW (phase 8.3b) — desktop only. Reconciles local vault with cloud.
      if (typeof window.KUMIKO_WEB === 'undefined') {
        const syncBtn=document.createElement('button'); syncBtn.type='button'; syncBtn.id='aiSyncNow'; syncBtn.className='ghost'; syncBtn.textContent='⟳ '+t('ซิงก์กับคลาวด์ตอนนี้');
        const syncMsg=document.createElement('span'); syncMsg.className='ai-auth-line';
        syncBtn.onclick=async ()=>{
          syncBtn.disabled=true;
          let r;
          try { r=await window.syncNow(); } catch(e){ r={ok:false,error:String(e&&e.message||e)}; }
          syncBtn.disabled=false;
          syncMsg.textContent = r.ok ? (t('ซิงก์แล้ว: ส่งขึ้น ')+r.pushed+t(' ดึงลง ')+r.pulled+(r.conflicts?(' · '+r.conflicts+t(' ชนกัน (เก็บสำเนาไว้)')):'')) : (t('ซิงก์ไม่สำเร็จ: ')+r.error);
          if (r.ok && (r.pulled||r.conflicts) && typeof refreshList==='function') await refreshList();
        };
        authInner.appendChild(syncBtn); authInner.appendChild(syncMsg);
      }
    } else {
      const wrap=document.createElement('div'); wrap.className='ai-auth-fields';
      const em=document.createElement('input'); em.type='text'; em.id='aiAuthEmail'; em.placeholder='email'; em.autocomplete='off'; em.spellcheck=false;
      const pw=document.createElement('input'); pw.type='password'; pw.id='aiAuthPass'; pw.placeholder='password'; pw.autocomplete='off';
      const li=document.createElement('button'); li.type='button'; li.id='aiAuthLogin'; li.className='ghost'; li.textContent=t('เข้าสู่ระบบ');
      const su=document.createElement('button'); su.type='button'; su.id='aiAuthSignup'; su.className='ghost'; su.textContent=t('สมัครสมาชิก');
      const doAuth=async (kind)=>{
        const emailVal=em.value.trim(); const passVal=pw.value;
        setAuthMsg('');
        try {
          const res=await fetch(collabHttpBase()+'/auth/'+kind, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ email: emailVal, password: passVal }) });
          if (res.ok) {
            const data=await res.json();
            await window.api.authSetToken(data.token, data.email);
            await renderAuthArea();
            setAuthMsg(t('สำเร็จ'));
          } else {
            let err=''; try { err=(await res.json()).error || ''; } catch (_) {}
            setAuthMsg(err || t('ล้มเหลว'));
          }
        } catch (_) {
          setAuthMsg(t('เชื่อมต่อ backend ไม่ได้'));
        }
      };
      li.onclick=()=>doAuth('login');
      su.onclick=()=>doAuth('signup');
      wrap.appendChild(em); wrap.appendChild(pw); wrap.appendChild(li); wrap.appendChild(su);
      authInner.appendChild(wrap);
    }
  }
  renderAuthArea();

  function rebuildModels(){
    const caps = window.AICaps;
    const list = caps ? caps.modelsForProvider(pSel.value) : (AI_MODELS[pSel.value]||[]).map((id)=>({ id, label:id, thinking:false }));
    mSel.innerHTML='';
    list.forEach((m)=>{ const o=document.createElement('option'); o.value=m.id; o.textContent=m.label + (m.thinking?'  🧠':''); mSel.appendChild(o); });
    const ids = list.map((m)=>m.id);
    const want=(pSel.value===cfg.provider && ids.includes(cfg.model)) ? cfg.model : (ids[0]||'');
    if (want) mSel.value=want;
    syncThinking();
  }
  function syncKeyPlaceholder(){
    const set=!!(cfg.hasKey && cfg.hasKey[pSel.value]);
    kInput.placeholder = set ? t('••• ตั้งค่าไว้แล้ว (ใส่ใหม่เพื่อเปลี่ยน)') : t('วางคีย์ที่นี่');
  }
  function syncApiSection(){
    apiSection.style.display=(selectedMode==='api') ? '' : 'none';
    cliSection.style.display=(selectedMode==='cli') ? '' : 'none';
    if (selectedMode==='cli' && ceSel && cmRow && claudeRow){
      const glm = (ceSel.value==='glm');
      cmRow.style.display = glm ? '' : 'none';
      claudeRow.style.display = glm ? 'none' : '';
    }
  }
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
    else testRes.textContent=t('เชื่อมต่อไม่ได้') + ' (' + ((r && (r.status||r.error)) || '') + ')' + ((r && r.hint) ? ' ' + r.hint : '');
  };
  const cancelBtn=document.createElement('button'); cancelBtn.type='button'; cancelBtn.className='ghost'; cancelBtn.textContent=t('ยกเลิก'); cancelBtn.onclick=dismiss;
  const saveBtn=document.createElement('button'); saveBtn.type='button'; saveBtn.id='aiSettingsSave'; saveBtn.className='solid'; saveBtn.textContent=t('บันทึก');
  saveBtn.onclick=async ()=>{
    const cfgPatch = { mode:selectedMode, provider:pSel.value, model:mSel.value, thinking: (tChk.disabled ? null : tChk.checked),
      visionModel: (vRow.style.display==='none' ? '' : vSel.value), autoVision: avChk.checked, readNoteImages: rnChk.checked };
    if (selectedMode==='cli' && ceSel){
      cfgPatch.cliEngine = ceSel.value;
      cfgPatch.cliModel = (ceSel.value==='glm') ? ((cmInput && cmInput.value.trim()) || '') : (claudeSel ? claudeSel.value : '');
    }
    await window.api.aiSetConfig(cfgPatch);
    if (typeof refreshAiCfgCache === 'function') refreshAiCfgCache();
    const kv=kInput.value;
    if (kv && kv.length) await window.api.aiSetKey(pSel.value, kv);
    vsSet('ragAmbient', document.getElementById('aiRagToggle').checked);
    vsSet('ragSemantic', document.getElementById('aiSemanticToggle').checked);
    // AI prompt templates (merged section) — persist alongside provider config.
    const ptObj={}; Object.keys(DEFAULT_PROMPTS).forEach((k)=>{ ptObj[k]=(ptFields[k].value.trim())||DEFAULT_PROMPTS[k]; });
    promptTemplates=Object.assign({}, DEFAULT_PROMPTS, ptObj);
    try { localStorage.setItem('prompts', JSON.stringify(promptTemplates)); } catch (_) {}
    const collabOn = document.getElementById('aiCollabToggle').checked;
    vsSet('collab', collabOn);
    const relay = (document.getElementById('aiCollabRelay').value || '').trim();
    if (relay) localStorage.setItem('collabRelay', relay); else localStorage.removeItem('collabRelay');
    // PROFILE (phase 7b-1) — local collab name + color. Empty name clears the
    // stored value (collabIdentity falls back to 'ฉัน'); color is always set.
    const pname = (document.getElementById('aiProfileName').value || '').trim();
    if (pname) localStorage.setItem('collabName', pname); else localStorage.removeItem('collabName');
    localStorage.setItem('collabColor', selectedColor);
    dismiss();
  };
  const closeBtn=document.createElement('button'); closeBtn.type='button'; closeBtn.className='ghost foot-close'; closeBtn.textContent=t('ปิด'); closeBtn.onclick=dismiss;
  testBtn.classList.add('foot-test'); testRes.classList.add('foot-test'); cancelBtn.classList.add('foot-cfg'); saveBtn.classList.add('foot-cfg');
  foot.appendChild(testBtn); foot.appendChild(testRes); foot.appendChild(closeBtn); foot.appendChild(cancelBtn); foot.appendChild(saveBtn); card.appendChild(foot);
  _foot=foot;

  // BUILD/ASSET version line — stale-cache diagnostic. Placeholders stay literal
  // on desktop (file://), so sanitize to 'desktop'/'local' there.
  const ver=document.createElement('div'); ver.className='ai-settings-ver';
  const _b=(window.KUMIKO_BUILD && window.KUMIKO_BUILD.indexOf('__')!==0) ? window.KUMIKO_BUILD : 'desktop';
  const _a=(window.KUMIKO_ASSETV && window.KUMIKO_ASSETV.indexOf('__')!==0) ? window.KUMIKO_ASSETV : 'local';
  const _v=(window.KUMIKO_VERSION && window.KUMIKO_VERSION.indexOf('__')!==0) ? window.KUMIKO_VERSION : '';
  ver.textContent=(_v?'v'+_v+' · ':'')+t('รุ่น')+' '+_b+' · assets '+_a;
  panelAbout.appendChild(ver);

  _showPanel(_panels[tab] ? tab : 'appearance');   // gear → appearance; AI doorways pass their tab
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
// ponytail: the panel is chat-only now (terminal removed in phase 8.5). The grid
// template still lives on the .term-right class in styles.css, so apply it once
// to give #right its column. The dynamic termPos/termHidden/toggle/drag logic is
// gone — there is no terminal to reposition or hide.
appEl.classList.add('term-right');

// AI chat panel show/hide — reuses the .term-hidden grid collapse in styles.css.
function applyChatHidden(){
  const hidden = localStorage.getItem('chatHidden') === '1';
  appEl.classList.toggle('term-hidden', hidden);
  const tgl = document.getElementById('aiPanelToggle');
  if (tgl) tgl.classList.toggle('on', !hidden);
}
function setChatHidden(v){ localStorage.setItem('chatHidden', v ? '1' : '0'); applyChatHidden(); }
applyChatHidden();
{ const tg = document.getElementById('aiPanelToggle'); if (tg) tg.onclick = () => setChatHidden(localStorage.getItem('chatHidden') !== '1'); }

// ---------- Chat send + mode toggle ----------
const chatInput = document.getElementById('chatInput');
const chatSend = document.getElementById('chatSend');
// PRIORITY CONTEXT INJECTION (replaces the old scope dropdown). Every send auto-assembles
// ONE context block ranked by priority — no mode to pick:
//   P1  the OPEN note (primary focus, always first)
//   P2  RAG-related notes for the question (supporting; opt-in ragAmbient, deduped vs P1)
// The model is told to prioritise the open note but answer normally if the question is
// unrelated to any note. Retrieval errors never block the send.
// Extract the retrieval SIGNALS from the open document so RAG can rank notes CONNECTED to what
// you're viewing (not just matching the question): docQuery = title + headings (its topic), and
// outlinks = the [[wikilinks]] it contains (explicit graph). See CoreRag.fuseRag.
function _docSignals(name, body){
  const outlinks = [];
  const re = /\[\[([^\[\]|\n]+?)(?:\|[^\]]*)?\]\]/g; let m;
  while ((m = re.exec(String(body || ''))) !== null) { const t = m[1].trim(); if (t && outlinks.indexOf(t) < 0) outlinks.push(t); }
  const headings = String(body || '').split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#{1,6}\s+/, '').trim());
  const docQuery = [name].concat(headings).join(' ').slice(0, 600);
  return { outlinks, docQuery };
}
function ragWeights(){ return vsGet('ragWeights', {}); }   // partial overrides; backend fills defaults

// P1 is the OPEN document. Injecting it WHOLE (an open PDF can be hundreds of KB) buried the
// question and made every turn slow — but head-truncating it is worse, because the part that
// answers the question is usually NOT in the first N characters. So select the passages that
// actually match the question, kept in document order. A doc that fits the budget is untouched.
// Budget is TUNABLE (Settings → p1Budget): set it low to select passages on almost every doc,
// high to send whole docs more often. Under budget the doc goes whole — "summarize this note"
// has no keywords to match, so question-driven selection there would drop the actual content.
function _clipP1(body, question){
  const W = (window.CoreRag && window.CoreRag.normalizeRagWeights) ? window.CoreRag.normalizeRagWeights(ragWeights()) : null;
  const budget = (W && W.p1Budget) || 12000;
  const s = String(body || '');
  if (s.length <= budget) return s;
  if (window.CoreRag && window.CoreRag.selectPassages) {
    const sel = window.CoreRag.selectPassages(s, question || '', budget);
    // generic asks ("สรุป/brief เอกสารนี้") share no keywords with the passages, so the selector
    // returns almost nothing — eval 2026-08-24: 126 of 19,546 chars reached the model and it
    // (rightly) refused to summarize. A near-empty selection falls back to the document HEAD.
    if (sel && sel.length >= Math.min(budget, s.length) * 0.25) return sel;
  }
  return s.slice(0, budget) + '\n\n…';
}
async function buildPriorityContext(question, refNames){
  const parts = [], sources = [], seen = new Set();
  const exclude = [];              // basenames already injected as P1 — RAG must NOT re-inject them
  let openName = '', docQuery = '', outlinks = [], openBody = '';
  // P0 — notes the user EXPLICITLY @-mentioned in this message: deliberate, so they outrank
  // even the open document. Passage-selected like everything else; deduped from P1/RAG below.
  for (const nm of (Array.isArray(refNames) ? refNames : []).slice(0, 5)) {
    const k = nm.toLowerCase();
    if (seen.has(k)) continue;
    const rel = (window.__wlNoteRel || {})[k];
    if (!rel) continue;
    let body = ''; try { body = await window.api.readNote(rel); } catch (_) {}
    if (!body || !body.trim()) continue;
    const clipped = (window.CoreRag && window.CoreRag.selectPassages) ? window.CoreRag.selectPassages(body, question || '', 4000) : body.slice(0, 4000);
    parts.push('[อ้างอิงโดยผู้ใช้ — @' + nm + '] [source: ' + nm + ']\n' + clipped);
    sources.push({ name: nm, reason: 'open' }); seen.add(k); exclude.push(nm);
  }
  // P1 — the OPEN document (note or PDF) is the PRIMARY context, placed first and marked
  // highest-priority. It's always injected when something is open, and also becomes the ANCHOR
  // for retrieval (its topic + its links feed the RAG channels below).
  if (currentNote) {
    let body = ''; try { body = (typeof getFullMarkdown === 'function') ? getFullMarkdown() : ''; } catch (_) {}
    const nm0 = currentNote.replace(/\.md$/i, '');
    if (body && body.trim() && !seen.has(nm0.toLowerCase())) {
      const nm = nm0;
      parts.push('[ความสำคัญสูงสุด — โน้ตที่กำลังเปิด] [source: ' + nm + ']\n' + _clipP1(body, question));
      sources.push({ name: nm, reason: 'open' }); seen.add(nm.toLowerCase()); exclude.push(nm);
      openName = nm; openBody = body; const sig = _docSignals(nm, body); docQuery = sig.docQuery; outlinks = sig.outlinks;
    }
  } else if (typeof currentPdf === 'string' && currentPdf) {
    // A PDF is open (not a note) → its extracted text IS the primary context. Prefer the
    // cached PDF-Text note; if the background indexer hasn't produced it yet, extract on demand.
    const base = currentPdf.replace(/\.pdf$/i, '').split('/').pop();
    let body = ''; try { body = await window.api.openNote('PDF-Text/' + base + '.md'); } catch (_) {}
    if (!body || !body.trim()) { try { body = (typeof extractPdfToMarkdown === 'function') ? (await extractPdfToMarkdown(currentPdf)) || '' : ''; } catch (_) {} }
    if (body && body.trim() && !seen.has(base.toLowerCase())) {
      parts.push('[ความสำคัญสูงสุด — PDF ที่กำลังเปิด] [source: ' + base + ']\n' + _clipP1(body, question));
      sources.push({ name: base, reason: 'open' }); seen.add(base.toLowerCase()); exclude.push(base);
      openName = base; openBody = body; const sig = _docSignals(base, body); docQuery = sig.docQuery; outlinks = sig.outlinks;
    }
  }
  // Tier-2 forward mentions: OTHER note titles that appear verbatim in the open doc but aren't
  // [[linked]]. Uses the known-title list the sidebar already maintains for [[ autocomplete.
  let mentions = [];
  if (openBody && window.CoreRag && window.CoreRag.detectMentions) {
    try {
      const outSet = new Set(outlinks.map((o) => String(o).toLowerCase()));
      const known = (window.__wlNoteNames || []).filter((n) => n && n.toLowerCase() !== openName.toLowerCase());
      mentions = window.CoreRag.detectMentions(openBody, known).filter((tn) => !outSet.has(String(tn).toLowerCase()));
    } catch (_) {}
  }
  // P2 — ambient RAG ALWAYS runs (even with a doc open): related notes are supporting context,
  // fused from the question + the open-doc topic + the explicit graph, ranked by the tiered
  // weights. The open doc is EXCLUDED from retrieval (it's already P1) so it's never double-injected.
  if (vsGet('ragAmbient', true)) {
    try {
      const r = await window.api.ragContext(question, { exclude, openName, docQuery, outlinks, mentions, weights: ragWeights() });
      const ctx = (r && r.context) || '';
      if (ctx.trim()) {
        parts.push('[บริบทเกี่ยวข้องเพิ่มเติม]\n' + ctx);
        ((r && r.sources) || []).forEach((s) => {
          const nm = (s && typeof s === 'object') ? s.name : s;
          const reason = (s && typeof s === 'object') ? s.reason : 'question';
          const k = String(nm).toLowerCase();
          if (nm && !seen.has(k)) { seen.add(k); sources.push({ name: nm, reason }); }
        });
      }
    } catch (_) {}
  }
  return { context: parts.join('\n\n'), sources };
}
async function sendChat(){
  const msg = chatInput.value.trim();
  const images = (typeof takeChatImages === 'function') ? takeChatImages() : [];
  if (!msg && !images.length) return;
  const s = activeSession();
  if (isRunning(s.id)) { __chatImages = images; renderAttachBar(); return; }
  chatInput.value = ''; chatInput.style.height = 'auto';
  chatInput.dispatchEvent(new Event('input'));   // clear the highlight backdrop too — it lingered and overlapped the placeholder
  const { context, sources } = await buildPriorityContext(msg, parseAtRefs(msg));
  // History is context about the conversation, not a payload channel: historyText strips the
  // full note body an edit-turn emitted (it was re-injected verbatim into every later prompt)
  // and caps each line.
  const _ht = (x) => (window.CoreMarkdown && window.CoreMarkdown.historyText) ? window.CoreMarkdown.historyText(x) : String(x || '');
  const history = s.messages.slice(-10).map((m) => (m.role === 'user' ? 'ผู้ใช้: ' : 'ผู้ช่วย: ') + _ht(m.text)).join('\n');
  // The QUESTION leads the prompt and is restated at the end. Buried at the bottom it looked like
  // just another history line, so long contexts steered answers away from what was actually asked.
  await ensureKumikoSeed();
  const rules = await kumikoRulesPrompt();
  const mem = (typeof kumikoMemoryPrompt === 'function') ? await kumikoMemoryPrompt(msg) : '';
  const reviewFb = reviewOutcomeLine();
  s._toolRounds = 0;   // fresh user message → fresh read/search budget
  const finalPrompt = context
    ? ('คำถามล่าสุดของผู้ใช้: ' + msg + '\n\n' +
       rules + mem + reviewFb +
       'ด้านล่างคือบริบทจากโน้ตของผู้ใช้ เรียงตามความสำคัญ (บนสุด = เอกสารที่เปิดอยู่ — ยึดเป็นหลัก)\n' +
       'ใช้เฉพาะส่วนที่เกี่ยวข้องกับคำถาม อ้างอิงแหล่งด้วย [source: …] เมื่อใช้ หากคำถามไม่เกี่ยวกับโน้ต ให้ตอบตามปกติได้เลย\n' +
       noteEditCapabilityPrompt() + pdfClipCapabilityPrompt() + kumikoLearnPrompt() + kumikoMemoryLearnPrompt() + kumikoToolsPrompt() + '\n' +
       context + '\n\n' +
       (history ? 'บทสนทนาก่อนหน้า:\n' + history + '\n\n' : '') +
       'ตอบคำถามนี้: ' + msg)
    : (rules + mem + reviewFb + noteEditCapabilityPrompt() + pdfClipCapabilityPrompt() + kumikoLearnPrompt() + kumikoMemoryLearnPrompt() + kumikoToolsPrompt() + (history ? 'บทสนทนาก่อนหน้า:\n' + history + '\n\n' : '') + 'ผู้ใช้: ' + msg);
  beginAiTurn(msg || t('(ส่งภาพ)'), sources, images);
  const model = 'zai-coding-plan/' + s.model;
  window.api.runEngine({ engine: s.engine, model: (s.engine === 'glm' ? model : ''), prompt: finalPrompt, runId: s.id, images: images.map((im) => im.uri) });
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
  // STOP, don't send — remember it was the USER who stopped, so the done-handler renders a
  // calm "หยุดแล้ว" state instead of the engine-failure warning (exit 130 alone is ambiguous:
  // the main process also aborts with 130 on timeout)
  if (isRunning(s.id)) { s._stopReq = Date.now(); window.api.stopEngine(s.id); return; }
  sendChat();
};
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(100, chatInput.scrollHeight) + 'px'; });
// Live hyperlink look for @[Name] while typing: the textarea's own text is transparent and this
// backdrop paints the same characters — mentions in accent, the @[ ] syntax faded.
const chatInputHl = document.getElementById('chatInputHl');
function renderChatInputHl(){
  if (!chatInputHl) return;
  const esc = (x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let h = esc(chatInput.value).replace(/@\[([^\]\n]+)\]/g,
    '<span class="tok-br">@[</span><span class="tok-nm">$1</span><span class="tok-br">]</span>');
  // plain @Name (current syntax): longest-first known names; SAME characters, colour only
  const names = (window.__wlNoteNames || []).slice().sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (!n) continue;
    const lit = esc(n);
    h = h.split('\u200B' + lit).join('<span class="tok-nm">\u200B' + lit + '</span>');
    h = h.split('@' + lit).join('<span class="tok-at">@</span><span class="tok-nm">' + lit + '</span>');
  }
  chatInputHl.innerHTML = h + '\n';
  chatInputHl.scrollTop = chatInput.scrollTop;
}
chatInput.addEventListener('input', renderChatInputHl);
chatInput.addEventListener('scroll', () => { if (chatInputHl) chatInputHl.scrollTop = chatInput.scrollTop; });
renderChatInputHl();
chatInput.addEventListener('keydown', (e) => {
  // @-menu keyboard: ↑/↓ move the highlight, Tab or Enter confirm, Esc closes
  if (_atMenu) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); _atMove(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (e.key === 'Tab') { e.preventDefault(); _atPick(); return; }
    if (e.key === 'Escape') { e.preventDefault(); _atClose(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _atPick(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

// ---------- @-mention: reference any vault note in the chat ----------
// Typing @ opens an autocomplete over every note name; picking inserts `@[Name]`. On send those
// notes are fetched and injected as USER-REFERENCED context (top priority, above the open doc).
let _atMenu = null;
function _atState(){
  // the "@fragment" being typed just before the caret, if any
  const upto = chatInput.value.slice(0, chatInput.selectionStart == null ? chatInput.value.length : chatInput.selectionStart);
  const m = upto.match(/(^|[\s(])@([^@\s\[\]]{0,40})$/);
  return m ? { frag: m[2], start: upto.length - m[2].length - 1 } : null;
}
function _atClose(){ if (_atMenu) { _atMenu.remove(); _atMenu = null; } }
function _atPick(){
  const it = _atMenu && _atMenu.querySelector('.at-item.on');
  if (it) _atInsert(it.dataset.name);
}
function _atMove(dir){
  if (!_atMenu) return;
  const items = [..._atMenu.querySelectorAll('.at-item')];
  if (!items.length) return;
  let i = items.findIndex((n) => n.classList.contains('on'));
  i = (i + dir + items.length) % items.length;
  items.forEach((n, j) => n.classList.toggle('on', j === i));
  try { items[i].scrollIntoView({ block: 'nearest' }); } catch (_) {}
}
function _atInsert(name){
  const st = _atState(); if (!st) { _atClose(); return; }
  const after = chatInput.value.slice(st.start + 1 + st.frag.length);
  chatInput.value = chatInput.value.slice(0, st.start) + '\u200B' + name + ' ' + after;   // zero-width marker: no visible @, no gap, caret alignment intact
  _atClose();
  chatInput.dispatchEvent(new Event('input'));
  chatInput.focus();
}
function _atRender(){
  const st = _atState();
  if (!st) { _atClose(); return; }
  const names = (window.__wlNoteNames || []).filter((n) => n.toLowerCase().includes(st.frag.toLowerCase())).slice(0, 8);
  if (!names.length) { _atClose(); return; }
  if (!_atMenu) {
    _atMenu = document.createElement('div'); _atMenu.className = 'at-menu';
    document.body.appendChild(_atMenu);
    const r = chatInput.getBoundingClientRect();
    _atMenu.style.left = r.left + 'px';
    _atMenu.style.width = Math.min(320, r.width) + 'px';
    _atMenu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  }
  _atMenu.innerHTML = '';
  names.forEach((n, i) => {
    const it = document.createElement('div');
    it.className = 'at-item' + (i === 0 ? ' on' : '');
    it.dataset.name = n; it.textContent = n;
    it.addEventListener('mousedown', (ev) => { ev.preventDefault(); _atInsert(n); });
    it.addEventListener('mouseenter', () => { _atMenu.querySelectorAll('.at-item').forEach((x) => x.classList.toggle('on', x === it)); });
    _atMenu.appendChild(it);
  });
}
chatInput.addEventListener('input', _atRender);
chatInput.addEventListener('blur', () => setTimeout(_atClose, 150));
// parse `@[Name]` tokens out of an outgoing message -> unique names
function parseAtRefs(text){
  const out = [], seen = new Set();
  let s = String(text || '');
  s = s.replace(/@\[([^\]]+)\]/g, (_, n) => { const k = n.trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); out.push(n.trim()); } return ' '; });
  // plain @Name against the known note list — longest first, then masked out so "@BSD Cost"
  // can never re-match as "@BSD"
  const names = (window.__wlNoteNames || []).slice().sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (!n || seen.has(n.toLowerCase())) continue;
    if (s.includes('@' + n) || s.includes('\u200B' + n)) {
      seen.add(n.toLowerCase()); out.push(n);
      s = s.split('@' + n).join(' '); s = s.split('\u200B' + n).join(' ');
    }
  }
  return out;
}

const rightEl = document.getElementById('right');
let rightMode = localStorage.getItem('rightMode') || 'chat';   // 'chat' only now (terminal removed)
function applyRightMode(){
  rightEl.classList.toggle('chat-mode', rightMode === 'chat');
  rightEl.classList.toggle('term-mode', rightMode === 'term');
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
      if (window.KUMIKO_WEB) {
        const ren = document.createElement('button'); ren.className = 'vm-mini'; ren.title = t('เปลี่ยนชื่อ'); ren.textContent = '✎';
        ren.onclick = async (e) => { e.stopPropagation(); const nn = await askName(t('เปลี่ยนชื่อ vault'), r.name); if (!nn) return; await window.api.vaultRename(r.path, nn); await window.updateVaultChipName(); openVaultMenu(document.getElementById('vaultChip')); };
        row.appendChild(ren);
        if (info.recents.length > 1) {
          const del = document.createElement('button'); del.className = 'vm-mini'; del.title = t('ลบ'); del.textContent = '🗑';
          del.onclick = async (e) => { e.stopPropagation(); if (!confirm(t('ลบ vault "') + r.name + t('" และโน้ตทั้งหมดในนั้น?'))) return; const res = await window.api.vaultDelete(r.path); if (res && res.ok) { if (info.current && r.path === info.current.path) location.reload(); else openVaultMenu(document.getElementById('vaultChip')); } };
          row.appendChild(del);
        }
      }
      if (isCurrent) {
        const ck = document.createElement('span'); ck.className = 'vm-check'; ck.innerHTML = icoSvg('check', 'sm'); row.appendChild(ck);
      } else {
        row.onclick = async () => { closeVaultMenu(); const res = await window.api.vaultSwitch(r.path); if (res && res.ok) location.reload(); };
      }
      menu.appendChild(row);
    });
    const sep = document.createElement('div'); sep.className = 'vm-sep'; menu.appendChild(sep);
  }

  if (!window.KUMIKO_WEB) {
    const open = document.createElement('div'); open.className = 'vm-act'; open.textContent = '📂 ' + t('เปิดโฟลเดอร์เป็น vault…');
    open.onclick = async () => { closeVaultMenu(); const r = await window.api.vaultOpen(); if (r && r.ok) location.reload(); };
    menu.appendChild(open);
  }

  const create = document.createElement('div'); create.className = 'vm-act'; create.textContent = '＋ ' + t('สร้าง vault ใหม่…');
  create.onclick = async () => {
    closeVaultMenu();
    let name = '';
    if (window.KUMIKO_WEB) { name = await askName(t('ตั้งชื่อ vault ใหม่'), ''); if (name == null) return; }
    const r = await window.api.vaultCreate(name);
    if (r && r.ok) location.reload();
  };
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
  chip.addEventListener('click', (e) => { e.stopPropagation(); openVaultMenu(chip); });
  await window.updateVaultChipName();
}
window.updateVaultChipName = async () => {
  const chip = document.getElementById('vaultChip'); if (!chip) return;
  const nm = chip.querySelector('.vault-nm'); if (!nm) return;
  try { const info = await window.api.vaultList(); if (info && info.current && info.current.name) nm.textContent = info.current.name; } catch (_) {}
};
initVaultChip();

(async () => {
  let lastOpen = vsGet('lastOpen', null);
  const lastNote = vsGet('lastNote', 'ระบบไต.md');
  await refreshList(lastOpen && lastOpen.type === 'note' && lastOpen.name ? lastOpen.name : lastNote);
  if (lastOpen && lastOpen.type === 'pdf' && lastOpen.name) {
    // Check the DATA, not the DOM — a PDF inside a COLLAPSED folder has no rendered .pdf-item,
    // which used to make the restore silently fall back to a note.
    let pdfs = [];
    try { const _r = await window.api.listNotes(); pdfs = (_r && _r.pdfs) || []; } catch (_) {}
    if (pdfs.includes(lastOpen.name)) await openPdf(lastOpen.name);
  } else if (lastOpen && lastOpen.type === 'view' && lastOpen.view) {
    // restore the last standalone view (graph/table/dash/trash/crate)
    if (lastOpen.view === 'crate' && typeof openCrate === 'function') openCrate(lastOpen.path || '');
    else if (lastOpen.view === 'tag' && lastOpen.tag && typeof openTagView === 'function') { await refreshTagIndex(true); openTagView(lastOpen.tag); }
    else if (typeof setMainView === 'function') setMainView(lastOpen.view);
  }
  // "เปิดหน้านี้เมื่อเริ่มแอพ" (dashboard as the day's front page) wins over the last view
  if (vsGet('startDash', false) && typeof setMainView === 'function') setMainView('dash');
  hideSplash();
})();
// splash comes down once the vault is on screen (or after a hard 6s cap so a boot error never traps the user)
function hideSplash(){ const sp = document.getElementById('splash'); if (!sp) return; sp.classList.add('out'); setTimeout(() => sp.remove(), 320); }
setTimeout(hideSplash, 6000);

// ---------- Auto-link (ร้อยเชือก) — user-triggered; AI suggests [[links]] to existing notes ----------
let autolinkAcc = '';
let autolinkRunning = false;
let autolinkNameSet = new Set();
let autolinkTagSet = new Set();
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
  // tags: the AI may only SUGGEST tags that already exist (same rule as note names — no near-duplicates)
  let tagList = '';
  try { if (typeof refreshTagIndex === 'function') { await refreshTagIndex(); const ix = tagIndex(); if (ix && ix.total) tagList = window.CoreTagIndex.summary(ix, 60); } } catch (_) {}
  autolinkTagSet = new Set(tagList ? tagIndex().pool.map((x) => window.CoreTagIndex.key(x)) : []);
  const curTags = new Set((window.CoreTags ? window.CoreTags.parseTags(currentAttrs.tags) : []).map((x) => x.toLowerCase()));
  autolinkAcc = ''; autolinkRunning = true;
  const btn = document.getElementById('autolinkBtn'); if (btn) { btn.disabled = true; btn.innerHTML = icoSvg('refresh'); btn.title = t('กำลังหา…'); }
  const bar = autolinkBarEl(); if (bar) { bar.innerHTML = '<div class="al-empty">' + t('AI กำลังหาจุดที่ลิงก์ได้…') + '</div>'; bar.hidden = false; }
  const prompt =
    'คุณคือผู้ช่วยจัดระเบียบโน้ต สองงาน: (1) หาว่าในเนื้อโน้ตด้านล่างมีคำ/วลีใดที่สื่อถึง "โน้ตที่มีอยู่แล้ว" และควรทำเป็นลิงก์ (2) หาว่าโน้ตนี้ควรติด "แท็กที่มีอยู่แล้ว" ตัวใด\n' +
    'รายชื่อโน้ตที่มีอยู่ (ใช้ได้เฉพาะจากรายการนี้เท่านั้น): ' + names.join(', ') + '\n' +
    (tagList ? 'แท็กที่มีอยู่ (ชื่อ จำนวนโน้ต — ใช้ได้เฉพาะจากรายการนี้ ห้ามแต่งใหม่): ' + tagList + '\n' : 'ยังไม่มีแท็กใน vault — ไม่ต้องเสนอแท็ก\n') +
    (curTags.size ? 'แท็กที่โน้ตนี้ติดอยู่แล้ว (ไม่ต้องเสนอซ้ำ): ' + [...curTags].join(', ') + '\n' : '') +
    '\nเนื้อโน้ตปัจจุบัน:\n---\n' + body + '\n---\n\n' +
    'กติกา:\n' +
    '- ตอบเป็น JSON array อย่างเดียว ห้ามมีข้อความอื่นหรือ markdown fence\n' +
    '- ลิงก์: {"type":"link","target":"<ชื่อโน้ตจากรายการ>","phrase":"<วลีที่ปรากฏจริงในเนื้อโน้ต แบบตรงตัว>","context":"<ประโยคสั้นรอบวลี>"}\n' +
    '- แท็ก: {"type":"tag","tag":"<แท็กจากรายการ>","reason":"<เหตุผลสั้น ๆ ว่าทำไมโน้ตนี้ควรติด>"}\n' +
    '- phrase ต้องคัดลอกจากเนื้อโน้ตแบบตรงตัว (จะได้หาเจอ)\n' +
    '- ห้ามเสนอคำที่เป็น [[...]] อยู่แล้ว · ห้ามแต่งชื่อโน้ตหรือแท็กใหม่ · ถ้าไม่มีให้ตอบ []\n' +
    '- ลิงก์สูงสุด 8 · แท็กสูงสุด 3 · เฉพาะที่เกี่ยวข้องจริง ๆ';
  const model = 'zai-coding-plan/' + currentModel;
  window.api.runEngine({ engine: currentEngine, model: (currentEngine === 'glm' ? model : ''), prompt, runId: 'autolink' });
}

window.api.onEngineOutput((p) => { if (p && p.runId === 'autolink' && p.kind !== 'reasoning') autolinkAcc += stripAnsi(p.data || ''); });
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
  const items = Array.isArray(arr) ? arr : [];
  const curTags = new Set((window.CoreTags ? window.CoreTags.parseTags(currentAttrs.tags) : []).map((x) => x.toLowerCase()));
  const seenTag = new Set();
  const tagSugs = items.filter((s) => {
    if (!s || s.type !== 'tag' || !s.tag) return false;
    const k = window.CoreTagIndex ? window.CoreTagIndex.key(s.tag) : String(s.tag).toLowerCase().replace(/^#/, '');
    if (!autolinkTagSet.has(k) || curTags.has(k) || seenTag.has(k)) return false;   // must exist · not already on this note
    seenTag.add(k); s.tag = (tagIndex().tags[k] || {}).name || s.tag; return true;
  }).slice(0, 3);
  const valid = items.filter((s) => {
    if (!s || s.type === 'tag' || !s.target || !s.phrase) return false;
    if (!autolinkNameSet.has(String(s.target).toLowerCase())) return false;   // target must be a real note
    if (!body.includes(s.phrase)) return false;                               // phrase must appear in the note
    if (body.includes('[[' + s.target + ']]')) return false;                  // already linked to this note
    const k = String(s.target).toLowerCase(); if (seen.has(k)) return false; seen.add(k);
    return true;
  });
  renderAutolinkBar(valid, tagSugs);
}

function renderAutolinkBar(list, tagSugs){
  const bar = autolinkBarEl(); if (!bar) return;
  tagSugs = tagSugs || [];
  bar.innerHTML = '';
  if (!list.length && !tagSugs.length){ bar.innerHTML = '<div class="al-empty">' + t('ไม่พบจุดที่ควรลิงก์หรือแท็กเพิ่ม') + '</div>'; bar.hidden = false; setTimeout(clearAutolink, 2600); return; }
  const hd = document.createElement('div'); hd.className = 'al-hd';
  const parts = [];
  if (list.length) parts.push('<b>' + list.length + '</b> ' + t('จุดที่ลิงก์ได้'));
  if (tagSugs.length) parts.push('<b>' + tagSugs.length + '</b> ' + t('แท็กที่แนะนำ'));
  hd.innerHTML = t('พบ ') + parts.join(' · ') + ' · ' + t('กดเครื่องหมายถูกเพื่อแทรก');
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
  // tag suggestions: coloured chip + reason; ✓ adds to frontmatter (no body edit)
  tagSugs.forEach((s) => {
    const row = document.createElement('div'); row.className = 'al-row al-tagrow'; row._tag = s.tag;
    const chip = (typeof tagChipEl === 'function') ? tagChipEl(s.tag) : document.createTextNode('#' + s.tag);
    const ctx = document.createElement('span'); ctx.className = 'al-ctx'; ctx.textContent = s.reason || '';
    const no = document.createElement('span'); no.className = 'al-no'; no.innerHTML = icoSvg('x','xs');
    const yes = document.createElement('span'); yes.className = 'al-yes'; yes.innerHTML = icoSvg('check','xs');
    no.onclick = () => { row.remove(); if (!bar.querySelector('.al-row')) clearAutolink(); };
    yes.onclick = async () => { await addSuggestedTags([s.tag]); row.remove(); if (!bar.querySelector('.al-row')) clearAutolink(); };
    row.appendChild(chip); row.appendChild(ctx); row.appendChild(no); row.appendChild(yes);
    bar.appendChild(row);
  });
  const foot = document.createElement('div'); foot.className = 'al-foot';
  const all = document.createElement('button'); all.className = 'al-all'; all.innerHTML = icoSvg('check','xs'); all.appendChild(document.createTextNode(' ' + t('แทรกทั้งหมด')));
  all.onclick = async () => {
    const sugs = [...bar.querySelectorAll('.al-row:not(.al-tagrow)')].map((r) => r._sug);
    const tgs = [...bar.querySelectorAll('.al-tagrow')].map((r) => r._tag);
    await insertLinks(sugs); await addSuggestedTags(tgs); clearAutolink();
  };
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

// accepted tag suggestions go to the note's frontmatter through the same path as the props bar
async function addSuggestedTags(tags){
  if (!tags || !tags.length || !currentNote || typeof TagsUI === 'undefined') return;
  const cur = TagsUI.getTags();
  tags.forEach((tg) => { if (!cur.some((x) => x.toLowerCase() === String(tg).toLowerCase())) cur.push(tg); });
  TagsUI.setTags(cur); applyProps(); await save();
  pdfToast('🏷 ' + tags.map((x) => '#' + x).join(' '));
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
    if (running && !m.text){ b.innerHTML = '<span class="chat-typing"><i class="spin-kaza"></i></span>'; sc._live = b; }
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
  const sc = p && sideById(p.runId); if (!sc || p.kind === 'reasoning') return;
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
// Drop the selected text into the AI chat input as a quoted reference (with its source) —
// the user finishes the question themselves. Replaces the old one-shot "explain" button.
function quoteToChat(sel){
  const input = document.getElementById('chatInput'); if (!input) return;
  const src = currentNote ? currentNote.replace(/\.md$/i, '') : (typeof currentPdf === 'string' && currentPdf ? currentPdf : '');
  const quote = '> "' + String(sel).trim() + '"' + (src ? ' — ' + src : '');
  input.value = (input.value ? input.value.replace(/\s+$/, '') + '\n' : '') + quote + '\n';
  input.dispatchEvent(new Event('input'));   // autoresize
  input.focus();
}
const CREPE_TOOLBAR_EXTRAS = [
  ['sparkle', 'อ้างอิงข้อความนี้ในแชต AI', (sel) => quoteToChat(sel)],
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
  { const _sb = document.getElementById('settingsBtn2'); if (_sb) _sb.onclick = (e) => { e.preventDefault(); openAiSettings('appearance'); }; }

  // "＋ ใหม่" dropdown — create note / folder / db / board, or import PDF
  async function importPdfFlow(){
    // aligned: the PDF lands in the box the user is working in (web pdfstore is flat — its
    // importPdf ignores the argument by design)
    const r = await window.api.importPdf((typeof currentFolder === 'function') ? currentFolder() : '');
    if (r && r.name) { await refreshList(currentNote); await openPdf(r.name); }
  }
  function openNewMenu(anchor){
    if (typeof closeFolderMenu === 'function') closeFolderMenu();
    const menu = document.createElement('div'); menu.className = 'db-menu'; menu.id = 'folderMenu';
    const items = [
      // the quick-create popover, anchored to the VISIBLE + button (the hidden #newNoteBtn
      // is a 0×0 header stub — anchoring there dumped the popover in the top-left corner)
      [t('โน้ตใหม่'), () => openNewNotePopover(anchor)],
      [t('กล่องใหม่'), () => openNewNotePopover(anchor, 'box')],   // same aligned popover, box mode
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

  // AI tools dropdown (TL;DR / quiz) — and the narrow-pane ⋯ overflow that folds it in
  const AI_MENU_ITEMS = () => [
    ['i-tldr', t('สรุปทั้งโน้ต (TL;DR)'), 'tldrBtn'],
    ['i-quiz', t('ตั้งคำถามทดสอบ'), 'quizBtn'],
    ['i-thread', t('ร้อยเชือก — แนะนำลิงก์'), 'autolinkBtn'],
    ['i-chat', t('เปิดแชตลอย'), 'sideChatBtn'],
  ];
  // items: [icon, label, targetId | fn]; a null item renders a divider
  function openBarMenu(anchor, items){
    const old = document.getElementById('aiMenu'); if (old) { old.remove(); return; }
    const m = document.createElement('div'); m.className = 'ai-menu'; m.id = 'aiMenu';
    items.forEach((it) => {
      if (!it) { const d = document.createElement('div'); d.className = 'ai-menu-div'; m.appendChild(d); return; }
      const [ic, label, target] = it;
      const b = document.createElement('button');
      b.innerHTML = '<svg class="ic sm"><use href="#' + ic + '"/></svg><span></span>';
      b.querySelector('span').textContent = label;
      b.onclick = () => { m.remove(); if (typeof target === 'function') target(); else { const el = document.getElementById(target); if (el) el.click(); } };
      m.appendChild(b);
    });
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + 'px';
    m.style.left = Math.max(8, Math.min(r.left - 60, window.innerWidth - m.offsetWidth - 8)) + 'px';
    setTimeout(() => document.addEventListener('mousedown', function once(ev){
      if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('mousedown', once, true); }
    }, true), 0);
  }
  const aiBtn = document.getElementById('aiMenuBtn');
  if (aiBtn) aiBtn.onclick = (e) => { e.stopPropagation(); openBarMenu(aiBtn, AI_MENU_ITEMS()); };
  // ⋯ appears only when the editor pane is too narrow for ✨ + save (styles.css @container ≤420px).
  // It carries everything that was hidden — nothing becomes unreachable, and the two panel
  // toggles stay outside it on purpose (they are the way out of a cramped layout).
  const moreBtn = document.getElementById('barMoreBtn');
  if (moreBtn) moreBtn.onclick = (e) => {
    e.stopPropagation();
    openBarMenu(moreBtn, [['i-save', t('บันทึก (⌘S)'), 'saveBtn'], null, ...AI_MENU_ITEMS()]);
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
  if (!n.collapsed && noteTreeRoot) {
    if (window.__tagFilter && window.__tagFilter.length && typeof renderFilteredNotes === 'function') renderFilteredNotes(n.body);
    else renderFolderNode(noteTreeRoot, n.body, 0);
  }
  // แท็ก — the second way through the vault (crates = where, tags = what/state)
  const tg = sbGroup('tags', 'hash', t('แท็ก'), { count: (typeof tagIndex === 'function' && tagIndex()) ? tagIndex().total : 0 });
  host.appendChild(tg.group);
  if (!tg.collapsed && typeof renderTagSection === 'function') renderTagSection(tg.body);
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
