const noteList = document.getElementById('noteList');

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
  item.dataset.dragKind = 'note'; item.dataset.dragRel = rel;
  if (window.__flaggedNotes && window.__flaggedNotes.has(rel)) {
    const dot = document.createElement('span'); dot.className = 'review-dot';
    dot.title = t('AI แก้โน้ตนี้ระหว่างที่ไม่ได้เปิด — เปิดเพื่อตรวจ');
    item.appendChild(dot);
  }
  item.onclick = () => openNote(rel);
  item.oncontextmenu = (e) => { e.preventDefault(); openNoteMenu(e.clientX, e.clientY, rel); };
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
  // a flagged note inside a COLLAPSED folder is invisible — bubble the review dot up to the
  // folder row so "AI ฝากของไว้ให้ตรวจ" can always be seen (log 2026-08-25)
  if (collapsed && window.__flaggedNotes && [...window.__flaggedNotes].some((n) => n.startsWith(node.path + '/'))) {
    const dot = document.createElement('span'); dot.className = 'review-dot';
    dot.title = t('มีโน้ตรอตรวจอยู่ในกล่องนี้ — กางเพื่อดู');
    row.appendChild(dot);
  }
  tri.onclick = (e) => { e.stopPropagation(); if (collapsed) collapsedFolders.delete(node.path); else collapsedFolders.add(node.path); persistCollapsed(); renderTree(); };
  row.onclick = () => openCrate(node.path);
  row.oncontextmenu = (e) => { e.preventDefault(); openFolderMenu(row, node); };
  row.dataset.dragKind = 'folder'; row.dataset.dragRel = node.path; row.dataset.dropPath = node.path;
  return row;
}
function renderFolderNode(node, container, depth){
  Object.values(node.folders).sort((a, b) => a.name.localeCompare(b.name)).forEach((sub) => {
    container.appendChild(makeFolderRow(sub, depth));
    if (!collapsedFolders.has(sub.path)) renderFolderNode(sub, container, depth + 1);
  });
  const pdfs = (node.pdfs || []).slice().sort();
  // Companion pairing removed (capture-target redesign): every note is an ordinary topic note,
  // legacy " · โน้ต" files included — nothing is nested under a PDF anymore.
  node.notes.slice().sort().forEach((n) => { container.appendChild(makeNoteItem(n, depth)); });
  pdfs.forEach((p) => { container.appendChild(makePdfItem(p, depth)); });
}
function renderTree(){ renderSidebar(); }

function openCrate(folderPath){
  currentCrate = folderPath || '';
  const left = document.getElementById('left');
  if (left){ left.classList.remove('view-graph','view-table','view-dash','view-pdf','view-trash','view-canvas'); left.classList.add('view-crate'); }
  mainView = 'crate';
  document.querySelectorAll('.sb-views .sbv').forEach((b) => b.classList.remove('active'));
  try { const c = document.getElementById('crumb'); if (c){ const nm = currentCrate ? currentCrate.split('/').pop() : t('โน้ต'); c.innerHTML = '<b>' + nm + '</b>'; } } catch (_) {}
  try { if (typeof vsSet === 'function') vsSet('lastOpen', { type: 'view', view: 'crate', path: currentCrate }); } catch (_) {}
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

  const scroll = document.createElement('div'); scroll.className = 'crate-scroll';
  const head = document.createElement('div'); head.className = 'crate-head';
  const title = document.createElement('div'); title.className = 'crate-title';
  title.innerHTML = icoSvg('crate', 'sm') + '<span></span>';
  title.querySelector('span').textContent = crateName;
  const sum = document.createElement('div'); sum.className = 'crate-sum';
  sum.textContent = subs.length + t(' กล่องย่อย · ') + notes.length + t(' โน้ต · ') + pdfs.length + t(' เล่ม');
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
  notes.forEach((n) => { grid.appendChild(card('note', 'note', n.replace(/\.md$/i, '').split('/').pop(), null, () => openNote(n))); });
  pdfs.forEach((p) => { grid.appendChild(card('book', 'book', p.replace(/\.pdf$/i, '').split('/').pop(), null, () => openPdf(p))); });
  scroll.appendChild(grid); host.appendChild(scroll);
}

async function refreshList(selectName, opts){
  const res = await window.api.listNotes();
  const notes = Array.isArray(res) ? res : (res.notes || []);
  const folders = Array.isArray(res) ? [] : (res.folders || []);
  const pdfs = Array.isArray(res) ? [] : (res.pdfs || []);
  // Stored companion links from each PDF's .annot.json (robust to renames). Falls back to name convention below.
  sbCompanionMap = (res && res.companions && typeof res.companions === 'object') ? res.companions : {};
  window.__wlNotes = new Set(notes.map((n) => n.replace(/\.md$/i, '').split('/').pop().toLowerCase()));  // for broken-link detection
  window.__wlNoteNames = [...new Set(notes.map((n) => n.replace(/\.md$/i, '').split('/').pop()))].sort((a, b) => a.localeCompare(b));  // for [[ autocomplete + chat @-mention
  window.__wlNoteRel = {};   // basename -> rel path (first wins), so @-mentions can fetch content
  notes.forEach((n) => { const k = n.replace(/\.md$/i, '').split('/').pop().toLowerCase(); if (!(k in window.__wlNoteRel)) window.__wlNoteRel[k] = n; });
  // PDF-Text/ is the auto-extracted "shadow text" of every PDF — machinery for RAG, not a box
  // the user works in. HIDDEN from the tree + box lists (like KUMIKO.md) but kept in the name
  // maps and RAG so the AI can still read PDF content.
  // assets/ (note-image files, 2026-09-05) is machinery too — never a box in the tree
  const treeNotes = notes.filter((n) => !n.startsWith('PDF-Text/') && !n.startsWith('assets/'));
  const treeFolders = folders.filter((f) => f !== 'PDF-Text' && !f.startsWith('PDF-Text/') && f !== 'assets' && !f.startsWith('assets/'));
  window.__wlFolders = treeFolders.slice();   // folder rel paths — AI folder-aware note creation
  window.__wlPdfRel = {};    // pdf basename -> rel, so [source: <pdf>] chat refs can open the PDF
  pdfs.forEach((p) => { const k = p.replace(/\.pdf$/i, '').split('/').pop().toLowerCase(); if (!(k in window.__wlPdfRel)) window.__wlPdfRel[k] = p; });
  noteTreeRoot = buildNoteTree(treeNotes, treeFolders, pdfs);
  if (typeof refreshTagIndex === 'function') { try { await refreshTagIndex(true); } catch (_) {} }
  if (typeof updateCaptureTargetBtn === 'function') { try { updateCaptureTargetBtn(); } catch (_) {} }
  if (opts && opts.keepView) { renderTree(); highlightActiveNote(currentNote); return; }   // refresh data only — never switch what the user is looking at
  try { sbDbCache = await window.api.dbList(); } catch (_) { sbDbCache = []; }
  renderTree();
  const target = selectName && notes.includes(selectName) ? selectName : notes[0];
  if (target) { await openNote(target); } else { highlightActiveNote(null); }
}
function highlightActiveNote(name){
  document.querySelectorAll('#noteList .note-item').forEach((el) => { el.classList.toggle('active', el.dataset.name === name); });
}

// Expand every ancestor box of a note/PDF and scroll its row into view — for opens that come
// from OUTSIDE the tree (search results), where the item may sit in a collapsed box far away
// (user request 2026-09-05). A short pulse marks which row it landed on.
function revealInSidebar(rel, kind){
  try {
    if (!rel) return;
    const parts = String(rel).split('/'); parts.pop();
    let changed = false, p = '';
    for (const seg of parts) {
      p = p ? p + '/' + seg : seg;
      if (collapsedFolders.has(p)) { collapsedFolders.delete(p); changed = true; }
    }
    if (changed) { persistCollapsed(); renderTree(); }
    const esc = (window.CSS && CSS.escape) ? CSS.escape(rel) : rel;
    const el = document.querySelector('#noteList .' + (kind === 'pdf' ? 'pdf-item[data-pdf="' + esc + '"]' : 'note-item[data-name="' + esc + '"]'));
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('reveal-flash');
      setTimeout(() => { try { el.classList.remove('reveal-flash'); } catch (_) {} }, 1300);
    }
  } catch (_) {}
}

// root of the list = drop target to move a note to the top level (handled by dragdrop.js)

// ---- folder actions ----
async function createFolderAt(parentPath){
  const n = await askName(t('ชื่อกล่องใหม่'), '');
  if (!n) return;
  const nm0 = nameNoSlash(n.trim());
  const rel = parentPath ? parentPath + '/' + nm0 : nm0;
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
    [t('โน้ตใหม่ในกล่องนี้'), async () => { const nm = await askName(t('ตั้งชื่อโน้ตใหม่'), ''); if (!nm) return; const r = await window.api.createNote(node.path + '/' + nameNoSlash(nm.trim())); if (r && r.error === 'exists') { alert(t('มีโน้ตชื่อนี้อยู่แล้ว')); return; } collapsedFolders.delete(node.path); await refreshList(r && r.name); }],
    [t('กล่องย่อยใหม่'), () => createFolderAt(node.path)],
    [t('เปลี่ยนชื่อกล่อง'), async () => { const nm = await askName(t('เปลี่ยนชื่อกล่อง'), node.name); if (!nm || nm.trim() === node.name) return; const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : ''; const nm0 = nameNoSlash(nm.trim()); const to = parent ? parent + '/' + nm0 : nm0; const r = await window.api.folderRename(node.path, to); if (r && r.error) { alert(t('เปลี่ยนชื่อไม่ได้')); return; } await refreshList(currentNote); }],
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
  if (window.__flaggedNotes && window.__flaggedNotes.delete(name)) { try { renderTree(); } catch (_) {} }   // opening = reviewed
  // a deferred AI edit for this note? open the accept-review once the editor is ready
  const _pending = (window.__pendingReviews && window.__pendingReviews.get(name)) || null;
  // Flush any pending autosave of the CURRENT note before loading the next one,
  // so unsaved edits are never lost or bled into the new note.
  if (typeof window.flushAutosave === 'function') { try { await window.flushAutosave(); } catch (_) {} }
  if (typeof setMainView === 'function') setMainView('note');
  if (typeof clearAutolink === 'function') clearAutolink();
  const content = await window.api.openNote(name);
  currentNote = name;
  // deferred AI review: diff RAW-vs-RAW. The editor normalizes markdown on load (escapes, bullet
  // style, H1 stripping), so diffing the raw-file-based proposal against the editor's serialization
  // marked ~every line as changed — a one-section edit read as "แก้ทั้ง sheet" (log 2026-08-24).
  if (_pending) {
    window.__pendingReviews.delete(name);
    setTimeout(() => { try { if (currentNote === name && typeof applyReplyToNote === 'function') applyReplyToNote(_pending, { silent: true, baseRaw: content }); } catch (_) {} }, 250);
  }
  setNoteTitle(name);
  const parsed = parseFrontmatter(content);
  currentAttrs = parsed.attrs;
  await loadEditor(parsed.body);
  setDirty(false);
  banner.hidden = true;
  loadPropsBar();
  if (typeof applyRulesMode === 'function') applyRulesMode(name);
  if (typeof maybeShowNewNoteProposal === 'function') maybeShowNewNoteProposal(name); else { const b = document.getElementById('nnPropose'); if (b) b.remove(); }
  vsSet('lastNote', name);
  vsSet('lastOpen', { type: 'note', name });
  try { if (typeof touchRecentNote === 'function') touchRecentNote(name); } catch (_) {}
  refreshBacklinks(name);
  highlightActiveNote(name);
}
