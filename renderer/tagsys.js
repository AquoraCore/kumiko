// ============================================================
// TAG SYSTEM (renderer) — one index (CoreTagIndex) feeding: coloured chips, the sidebar
// "แท็ก" tree + filter, the Tag view, right-click vault-wide ops, and the AI tag verbs.
// Loaded before renderer.js (which owns the props-bar TagsUI and calls into here).
// ============================================================
let _tagIx = null;          // CoreTagIndex.build(rows)
let _tagRows = [];          // raw noteTable rows (name/status/tags/bodyTags)
let _tagIxAt = 0;
let _tagIxPromise = null;
window.__tagFilter = [];    // active sidebar filter (tag keys, AND)

function tagIndex(){ return _tagIx || (window.CoreTagIndex ? window.CoreTagIndex.build([]) : null); }
async function refreshTagIndex(force){
  if (!window.CoreTagIndex) return null;
  if (!force && _tagIx && (Date.now() - _tagIxAt < 4000)) return _tagIx;
  if (_tagIxPromise) return _tagIxPromise;
  _tagIxPromise = (async () => {
    try { _tagRows = await window.api.noteTable(); } catch (_) { _tagRows = []; }
    _tagRows = _tagRows.filter((r) => r && r.name && !/^PDF-Text\//.test(r.name) && !(typeof _aiProtectedName === 'function' && _aiProtectedName(r.name)));
    _tagIx = window.CoreTagIndex.build(_tagRows); _tagIxAt = Date.now(); _tagIxPromise = null;
    return _tagIx;
  })();
  return _tagIxPromise;
}
// refresh + repaint everything that shows tags (sidebar section, open tag view, props bar ghosts)
async function tagIndexChanged(){
  await refreshTagIndex(true);
  try { if (typeof renderSidebar === 'function') renderSidebar(); } catch (_) {}
  try { if (mainView === 'tag' && _tagViewKey) renderTagView(_tagViewKey); } catch (_) {}
  try { if (typeof TagsUI !== 'undefined' && TagsUI.refreshGhosts) TagsUI.refreshGhosts(); } catch (_) {}
}

// ---- colour: hash → one of the 6 palette hues, pulled 25% toward the theme accent; per-tag override in vault state ----
function tagHueSlot(name){
  const ov = vsGet('tagColors', {}) || {};
  const k = window.CoreTagIndex.key(name).split('/')[0];
  if (ov[k] != null) return ov[k];
  return window.CoreTagIndex.hueOf(name);
}
function tagHueColor(slot){
  const CT = window.CoreTheme; if (!CT) return 'var(--accent)';
  const hues = Object.keys(CT.PRESETS).map((k) => CT.PRESETS[k].accent);
  const base = hues[((slot % hues.length) + hues.length) % hues.length];
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#bd5540';
  const c = CT.mix(base, acc, 0.25);
  return dark ? CT.mix(c, '#ffffff', 0.22) : c;
}
function tagColor(name){ return tagHueColor(tagHueSlot(name)); }
function setTagColor(name, slot){
  const ov = Object.assign({}, vsGet('tagColors', {}) || {});
  const k = window.CoreTagIndex.key(name).split('/')[0];
  if (slot == null) delete ov[k]; else ov[k] = slot;
  vsSet('tagColors', ov);
  tagIndexChanged();
}

// ---- chip element (shared by props bar / sidebar filter row / tag view / autocomplete) ----
function tagChipEl(name, o){
  o = o || {};
  const el = document.createElement(o.button ? 'button' : 'span'); el.className = 'tg-chip' + (o.ghost ? ' ghost' : '') + (o.cls ? ' ' + o.cls : '');
  if (o.button) el.type = 'button';
  el.style.setProperty('--tg', tagColor(name));
  el.innerHTML = '<i class="tg-dot"></i><span class="tg-nm"></span>';
  el.querySelector('.tg-nm').textContent = '#' + name;
  if (o.count != null) { const c = document.createElement('em'); c.className = 'tg-cnt'; c.textContent = String(o.count); el.appendChild(c); }
  if (o.suffix) { const s = document.createElement('em'); s.className = 'tg-suf'; s.textContent = o.suffix; el.appendChild(s); }
  if (o.onX) { const x = document.createElement('b'); x.className = 'tg-x'; x.textContent = '×'; x.title = o.xTitle || t('เอาออก'); x.onclick = (e) => { e.stopPropagation(); o.onX(); }; el.appendChild(x); }
  if (o.onClick) { el.classList.add('clickable'); el.onclick = (e) => { e.stopPropagation(); o.onClick(e); }; }
  if (o.title) el.title = o.title;
  el.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); openTagMenu(e.clientX, e.clientY, name); };
  return el;
}

// ---- sidebar: "แท็ก" section (tree with counts) + filter row ----
function renderTagSection(body){
  const TI = window.CoreTagIndex; const ix = tagIndex(); if (!ix) return;
  if (!ix.total) {
    const e = document.createElement('div'); e.className = 'tg-empty'; e.textContent = t('ยังไม่มีแท็ก — ใส่ที่แถบบนโน้ต หรือพิมพ์ #แท็ก ในเนื้อหา'); body.appendChild(e); return;
  }
  const coll = new Set(vsGet('tagCollapsed', []) || []);
  const row = (k, depth) => {
    const e = ix.tags[k];
    const r = document.createElement('div'); r.className = 'tg-row' + (window.__tagFilter.includes(k) ? ' on' : ''); r.style.paddingLeft = (10 + depth * 18) + 'px';
    r.dataset.key = k;
    const tri = document.createElement('span'); tri.className = 'tg-tri';
    if (e.children.length) { tri.innerHTML = icoSvg(coll.has(k) ? 'chev' : 'chevdown', 'xs'); tri.onclick = (ev) => { ev.stopPropagation(); if (coll.has(k)) coll.delete(k); else coll.add(k); vsSet('tagCollapsed', [...coll]); renderSidebar(); }; }
    const dot = document.createElement('i'); dot.className = 'tg-dot'; dot.style.background = tagColor(e.name);
    const nm = document.createElement('span'); nm.className = 'tg-rnm'; nm.textContent = TI.leaf(e.name);
    const ct = document.createElement('span'); ct.className = 'tg-rcnt'; ct.textContent = String(e.count);
    r.appendChild(tri); r.appendChild(dot); r.appendChild(nm); r.appendChild(ct);
    r.title = '#' + e.name + ' · ' + t('คลิก = กรอง · ⌘คลิก = เพิ่มเงื่อนไข · ดับเบิลคลิก = เปิดหน้าแท็ก');
    r.onclick = (ev) => toggleTagFilter(k, ev.metaKey || ev.ctrlKey);
    r.ondblclick = (ev) => { ev.preventDefault(); openTagView(k); };
    r.oncontextmenu = (ev) => { ev.preventDefault(); openTagMenu(ev.clientX, ev.clientY, e.name); };
    body.appendChild(r);
    if (!coll.has(k)) e.children.forEach((c) => row(c, depth + 1));
  };
  ix.roots.forEach((k) => row(k, 0));
}
function toggleTagFilter(k, additive){
  const f = window.__tagFilter;
  if (f.includes(k)) window.__tagFilter = f.filter((x) => x !== k);
  else window.__tagFilter = additive ? f.concat([k]) : [k];
  renderSidebar();
}
function clearTagFilter(){ window.__tagFilter = []; renderSidebar(); }
// when a filter is active the note tree shows only matching notes, grouped by crate
function renderFilteredNotes(body){
  const TI = window.CoreTagIndex; const ix = tagIndex();
  const bar = document.createElement('div'); bar.className = 'tg-filterbar';
  const lab = document.createElement('span'); lab.className = 'tg-flab'; lab.textContent = t('กรอง:'); bar.appendChild(lab);
  window.__tagFilter.forEach((k, i) => {
    if (i) { const and = document.createElement('span'); and.className = 'tg-and'; and.textContent = t('และ'); bar.appendChild(and); }
    bar.appendChild(tagChipEl(ix.tags[k] ? ix.tags[k].name : k, { onX: () => toggleTagFilter(k, true), xTitle: t('เอาเงื่อนไขออก') }));
  });
  const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'tg-fclear'; clr.textContent = t('ล้าง'); clr.onclick = clearTagFilter; bar.appendChild(clr);
  body.appendChild(bar);
  const notes = TI.filterNotes(ix, window.__tagFilter);
  if (!notes.length) { const e = document.createElement('div'); e.className = 'tg-empty'; e.textContent = t('ไม่มีโน้ตที่ตรงทุกเงื่อนไข'); body.appendChild(e); return; }
  const groups = {}; notes.forEach((n) => { const i = n.lastIndexOf('/'); const d = i < 0 ? '' : n.slice(0, i); (groups[d] = groups[d] || []).push(n); });
  Object.keys(groups).sort().forEach((d) => {
    const gh = document.createElement('div'); gh.className = 'tg-grp'; gh.innerHTML = icoSvg('crate', 'xs') + '<span></span>'; gh.querySelector('span').textContent = d || t('(ราก)'); body.appendChild(gh);
    groups[d].forEach((n) => body.appendChild(makeNoteItem(n, 1)));
  });
  if (typeof highlightActiveNote === 'function') highlightActiveNote(currentNote);
}

// ---- Tag view (main area) ----
let _tagViewKey = null;
function openTagView(k){
  const TI = window.CoreTagIndex; _tagViewKey = TI.key(k);
  setMainView('tag');
  vsSet('lastOpen', { type: 'view', view: 'tag', tag: _tagViewKey });
  renderTagView(_tagViewKey);
}
function renderTagView(k){
  const host = document.getElementById('tagView'); if (!host) return;
  const TI = window.CoreTagIndex; const ix = tagIndex(); const e = ix && ix.tags[k];
  host.innerHTML = '';
  const scroll = document.createElement('div'); scroll.className = 'tg-scroll';
  if (!e) { const em = document.createElement('div'); em.className = 'tg-empty big'; em.textContent = t('ไม่มีแท็กนี้แล้ว'); scroll.appendChild(em); host.appendChild(scroll); return; }
  const notes = TI.filterNotes(ix, [k]);
  const head = document.createElement('div'); head.className = 'tg-vhead';
  head.appendChild(tagChipEl(e.name, { cls: 'big' }));
  const big = document.createElement('span'); big.className = 'tg-vbig'; big.textContent = notes.length + ' ' + t('โน้ต'); head.appendChild(big);
  const acts = document.createElement('div'); acts.className = 'tg-vacts';
  const mk = (label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost sm' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = fn; acts.appendChild(b); };
  mk(t('กรองในรายการ'), () => { window.__tagFilter = [k]; renderSidebar(); });
  mk(t('เปลี่ยนชื่อ…'), () => renameTagFlow(e.name));
  mk(t('รวมเข้ากับ…'), () => mergeTagFlow(e.name));
  mk(t('สี ▾'), (ev) => openTagColorMenu(ev.currentTarget, e.name));
  head.appendChild(acts); scroll.appendChild(head);
  const sub = document.createElement('div'); sub.className = 'tg-vsub';
  const bits = [];
  if (e.parent && ix.tags[e.parent]) { bits.push(t('ลูกของ') + ' #' + ix.tags[e.parent].name); }
  if (e.children.length) bits.push(t('ลูกแท็ก') + ': ' + e.children.map((c) => '#' + TI.leaf(ix.tags[c].name) + ' ' + ix.tags[c].count).join(' · '));
  if (e.sources.body) bits.push(t('จากในเนื้อหา') + ' ' + e.sources.body);
  sub.textContent = bits.join(' · ') || t('แท็กระดับบนสุด'); scroll.appendChild(sub);
  if (e.children.length) {
    const kids = document.createElement('div'); kids.className = 'tg-kids';
    e.children.forEach((c) => kids.appendChild(tagChipEl(ix.tags[c].name, { count: ix.tags[c].count, onClick: () => openTagView(c) })));
    scroll.appendChild(kids);
  }
  const groups = {}; notes.forEach((n) => { const i = n.lastIndexOf('/'); const d = i < 0 ? '' : n.slice(0, i); (groups[d] = groups[d] || []).push(n); });
  const rowByName = {}; _tagRows.forEach((r) => { rowByName[r.name] = r; });
  Object.keys(groups).sort().forEach((d) => {
    const gh = document.createElement('div'); gh.className = 'tg-grp'; gh.innerHTML = icoSvg('crate', 'xs') + '<span></span>'; gh.querySelector('span').textContent = d || t('(ราก)');
    gh.onclick = () => { if (typeof openCrate === 'function') openCrate(d); }; scroll.appendChild(gh);
    groups[d].forEach((n) => {
      const r = rowByName[n] || {};
      const row = document.createElement('div'); row.className = 'tg-note';
      row.innerHTML = icoSvg('note', 'sm') + '<span class="tg-nnm"></span><span class="tg-nst"></span><span class="tg-ntags"></span>';
      row.querySelector('.tg-nnm').textContent = n.replace(/\.md$/i, '').split('/').pop();
      row.querySelector('.tg-nst').textContent = r.status ? t(r.status) : '';
      const tgs = row.querySelector('.tg-ntags');
      (ix.byNote[n] || []).filter((x) => TI.key(x.name) !== k).slice(0, 4).forEach((x) => tgs.appendChild(tagChipEl(x.name, { ghost: x.source === 'body', onClick: () => openTagView(TI.key(x.name)) })));
      row.onclick = () => openNote(n);
      scroll.appendChild(row);
    });
  });
  host.appendChild(scroll);
}

// ---- menus ----
function closeTagMenu(){ const m = document.getElementById('tagMenu'); if (m) m.remove(); document.removeEventListener('mousedown', _onTagMenuOutside, true); }
function _onTagMenuOutside(e){ const m = document.getElementById('tagMenu'); if (m && !m.contains(e.target)) closeTagMenu(); }
function openTagMenu(x, y, name){
  closeTagMenu();
  const TI = window.CoreTagIndex; const k = TI.key(name); const ix = tagIndex(); const e = ix.tags[k];
  const m = document.createElement('div'); m.className = 'db-menu'; m.id = 'tagMenu';
  const head = document.createElement('div'); head.className = 'tg-mhead'; head.appendChild(tagChipEl(e ? e.name : name, { count: e ? e.count : undefined })); m.appendChild(head);
  const mi = (label, fn, cls) => { const d = document.createElement('div'); d.className = 'db-mi' + (cls ? ' ' + cls : ''); d.textContent = label; d.onclick = () => { closeTagMenu(); fn(); }; m.appendChild(d); };
  mi(t('เปิดหน้าแท็ก'), () => openTagView(k));
  mi(window.__tagFilter.includes(k) ? t('เอาออกจากตัวกรอง') : t('กรองด้วยแท็กนี้'), () => toggleTagFilter(k, true));
  mi(t('เปลี่ยนชื่อ… (ทุกโน้ต)'), () => renameTagFlow(name));
  mi(t('รวมเข้ากับแท็กอื่น…'), () => mergeTagFlow(name));
  const sw = document.createElement('div'); sw.className = 'db-mi tg-swrow'; const lab = document.createElement('span'); lab.textContent = t('สี'); sw.appendChild(lab);
  const cur = tagHueSlot(name);
  for (let i = 0; i < window.CoreTagIndex.HUES; i++) { const b = document.createElement('button'); b.type = 'button'; b.className = 'tg-sw' + (i === cur ? ' on' : ''); b.style.background = tagHueColor(i); b.title = t('สี') + ' ' + (i + 1); b.onclick = (ev) => { ev.stopPropagation(); closeTagMenu(); setTagColor(name, i); }; sw.appendChild(b); }
  m.appendChild(sw);
  const sep = document.createElement('div'); sep.className = 'set-sep'; m.appendChild(sep);
  mi(t('เอาออกจากทุกโน้ต'), () => removeTagFlow(name), 'db-mi-del');
  const snap = vsGet(TAG_UNDO_KEY, null);
  if (snap && snap.files && snap.files.length) mi('↩ ' + t('เลิกทำ') + ': ' + snap.label, undoTagRename, 'db-mi-mut');
  document.body.appendChild(m);
  m.style.left = Math.max(8, Math.min(x, window.innerWidth - 240)) + 'px';
  m.style.top = Math.max(8, Math.min(y, window.innerHeight - m.offsetHeight - 8)) + 'px';
  setTimeout(() => document.addEventListener('mousedown', _onTagMenuOutside, true), 0);
}
function openTagColorMenu(anchor, name){ const r = anchor.getBoundingClientRect(); openTagMenu(r.left, r.bottom + 4, name); }

// ---- vault-wide writes: plan (pure, frontmatter + body) → confirm (counts) → write → undo snapshot ----
// rows with bodies, so renamePlan can rewrite in-body #tags too (the user's "#exam stays" gap)
async function tagRowsWithBodies(){
  const out = [];
  await Promise.all(_tagRows.map(async (r) => {
    let body = '';
    try {
      const raw = (r.name === currentNote) ? getFullMarkdown() : String(await window.api.readNote(r.name) || '');
      body = parseFrontmatter(raw).body || '';
    } catch (_) {}
    out.push({ name: r.name, tags: r.tags, body });
  }));
  return out;
}
const TAG_UNDO_KEY = 'tagRenameUndo';
async function applyTagPlan(plan, label){
  if (!plan.length) { pdfToast(t('ไม่มีโน้ตที่ต้องแก้')); return 0; }
  const fmN = plan.filter((p) => p.tags !== undefined).length;
  const bodyN = plan.reduce((n, p) => n + (p.bodyHits || 0), 0);
  const bodyNotes = plan.filter((p) => p.bodyHits).length;
  const detail = [fmN ? t('แท็กในหัวโน้ต') + ' ' + fmN + ' ' + t('โน้ต') : '', bodyN ? t('ข้อความ #แท็กในเนื้อหา') + ' ' + bodyN + ' ' + t('จุด') + ' (' + bodyNotes + ' ' + t('โน้ต') + ')' : ''].filter(Boolean).join(' · ');
  if (!(await confirmDelete(label + '\n' + detail + '\n' + t('เลิกทำได้จากเมนูแท็กหลังแก้'), { title: t('แก้แท็กทั้ง vault'), okLabel: t('แก้') }))) return 0;
  const snap = { ts: Date.now(), label, files: [] };
  let n = 0;
  for (const p of plan) {
    try {
      const raw = (p.name === currentNote) ? getFullMarkdown() : String(await window.api.readNote(p.name) || '');
      snap.files.push({ name: p.name, before: raw });
      const fm = parseFrontmatter(raw); const attrs = fm.attrs || {};
      if (p.tags !== undefined) { if (p.tags) attrs.tags = p.tags; else delete attrs.tags; }
      const body = (p.body !== undefined) ? p.body : fm.body;
      const next = serializeFrontmatter(attrs, body);
      if (p.name === currentNote) {
        currentAttrs = attrs; TagsUI.setTags(window.CoreTags.parseTags(attrs.tags));
        if (p.body !== undefined) await loadEditor(body);
        setDirty(true); await save();
      } else {
        await window.api.saveNote(p.name, next);
      }
      n++;
    } catch (_) {}
  }
  vsSet(TAG_UNDO_KEY, snap);
  await tagIndexChanged();
  pdfToast(label + ' · ' + n + ' ' + t('โน้ต'), { action: { label: t('เลิกทำ'), fn: undoTagRename } });
  return n;
}
async function undoTagRename(){
  const snap = vsGet(TAG_UNDO_KEY, null);
  if (!snap || !snap.files || !snap.files.length) { pdfToast(t('ไม่มีอะไรให้เลิกทำ')); return; }
  let n = 0;
  for (const f of snap.files) {
    try {
      if (f.name === currentNote) { const fm = parseFrontmatter(f.before); currentAttrs = fm.attrs || {}; TagsUI.setTags(window.CoreTags.parseTags(currentAttrs.tags)); await loadEditor(fm.body); setDirty(true); await save(); }
      else await window.api.saveNote(f.name, f.before);
      n++;
    } catch (_) {}
  }
  vsSet(TAG_UNDO_KEY, null);
  await tagIndexChanged();
  pdfToast(t('เลิกทำแล้ว') + ' · ' + n + ' ' + t('โน้ต'));
}
async function renameTagFlow(name){
  const to = await askName(t('เปลี่ยนชื่อแท็ก #') + name + t(' เป็น'), name);
  if (!to || window.CoreTagIndex.key(to) === window.CoreTagIndex.key(name)) return;
  await applyTagPlan(window.CoreTagIndex.renamePlan(await tagRowsWithBodies(), name, to), t('เปลี่ยนชื่อ #') + name + ' → #' + window.CoreTagIndex.norm(to));
}
async function mergeTagFlow(name){
  const ix = tagIndex(); const others = ix.pool.filter((p) => window.CoreTagIndex.key(p) !== window.CoreTagIndex.key(name));
  const to = await askName(t('รวม #') + name + t(' เข้ากับแท็ก (พิมพ์ชื่อ): ') + others.slice(0, 12).join(', '), '');
  if (!to) return;
  await applyTagPlan(window.CoreTagIndex.renamePlan(await tagRowsWithBodies(), name, to), t('รวม #') + name + ' → #' + window.CoreTagIndex.norm(to));
}
async function removeTagFlow(name){
  await applyTagPlan(window.CoreTagIndex.renamePlan(await tagRowsWithBodies(), name, ''), t('เอา #') + name + t(' ออกจากทุกโน้ต'));
}
// per-note tag change (AI verbs + props bar) — immediate, with toast
async function setNoteTags(rel, tags, toastLabel){
  const TI = window.CoreTagIndex;
  if (rel === currentNote) {
    currentAttrs.tags = tags; if (!tags) delete currentAttrs.tags;
    TagsUI.setTags(window.CoreTags.parseTags(tags)); setDirty(true); await save();
  } else {
    const content = String(await window.api.readNote(rel) || '');
    const fm = parseFrontmatter(content); const attrs = fm.attrs || {};
    if (tags) attrs.tags = tags; else delete attrs.tags;
    await window.api.saveNote(rel, serializeFrontmatter(attrs, fm.body));
  }
  if (toastLabel) pdfToast(toastLabel);
}

// ---- AI verbs ----
// ask: LIST-TAGS / NOTES-BY-TAG → text for the continuation turn
async function buildTagToolResults(acts){
  const TI = window.CoreTagIndex; const parts = [];
  if (!TI) return parts;
  const ix = await refreshTagIndex(true);
  if (acts.listTags) parts.push('[แท็กทั้งหมด — ชื่อ จำนวนโน้ต (ลูกแท็ก)]\n' + (TI.summary(ix, 80) || '(ยังไม่มีแท็ก)'));
  for (const q of (acts.notesByTag || [])) {
    const names = window.CoreTags.parseTags(q);
    const notes = TI.filterNotes(ix, names);
    parts.push('[โน้ตที่ติดแท็ก ' + names.map((n) => '#' + n).join(' และ ') + ' — ' + notes.length + ']\n' + (notes.map((n) => n.replace(/\.md$/i, '')).join('\n') || '(ไม่มี)'));
  }
  return parts;
}
// write: SET/ADD/REMOVE-TAGS per note (immediate + toast) · RENAME-TAG vault-wide (confirm)
async function runTagVerbs(acts){
  const TI = window.CoreTagIndex; if (!TI || !acts.tagWrites) return;
  const CT = window.CoreTags;
  const rowOf = (rel) => _tagRows.find((r) => r.name === rel) || { tags: '' };
  const curTagsOf = (rel) => rel === currentNote ? CT.serializeTags(TagsUI.getTags()) : rowOf(rel).tags || '';
  await refreshTagIndex(true);
  const perNote = [].concat(
    (acts.setTags || []).map((x) => Object.assign({ op: 'set' }, x)),
    (acts.addTags || []).map((x) => Object.assign({ op: 'add' }, x)),
    (acts.removeTags || []).map((x) => Object.assign({ op: 'remove' }, x)));
  for (const w of perNote) {
    if (_aiProtectedName(w.name)) { _aiProtectToast(); continue; }
    const rel = _resolveNoteRel(w.name); if (!rel) { pdfToast(t('ไม่พบโน้ต ') + w.name); continue; }
    const cur = curTagsOf(rel);
    const next = w.op === 'set' ? CT.serializeTags(CT.parseTags(w.tags)) : w.op === 'add' ? TI.addTags(cur, w.tags) : TI.removeTags(cur, w.tags);
    if (next === cur) continue;
    const short = rel.replace(/\.md$/i, '').split('/').pop();
    try { await setNoteTags(rel, next, '🏷 ' + short + ': ' + (next ? next.split(',').map((s) => '#' + s.trim()).join(' ') : t('(ไม่มีแท็ก)'))); } catch (_) {}
  }
  for (const r of (acts.renameTags || [])) {
    const plan = TI.renamePlan(await tagRowsWithBodies(), r.from, r.to);
    await applyTagPlan(plan, r.to ? t('AI ขอเปลี่ยนชื่อ #') + r.from + ' → #' + TI.norm(r.to) : t('AI ขอเอา #') + r.from + t(' ออกจากทุกโน้ต'));
  }
  await tagIndexChanged();
}
// one line for kumikoToolsPrompt: what tags exist, so the AI reuses them instead of inventing near-duplicates
function tagPromptLine(){
  const TI = window.CoreTagIndex; const ix = tagIndex(); if (!TI || !ix || !ix.total) return '';
  let s = TI.summary(ix, 40); if (s.length > 700) s = s.slice(0, 700) + '…';
  return 'แท็กที่มีอยู่ (ชื่อ จำนวน): ' + s + '\n';
}
