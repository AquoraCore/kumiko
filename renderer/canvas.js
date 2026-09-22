// ================= Kumiko Canvas (แคนวาสสรุปงาน) =================
// A board = chosen notes as cards (each card = the FULL text of its chosen sections,
// rendered markdown incl. mermaid + assets images), stickies, and wires that anchor to the
// SEGMENT, not the card. Dashed wires are live suggestions from [[wikilinks]] inside a
// section — recomputed every paint from note content (never saved, never stale); clicking
// one confirms it into a solid edge stored on the board. Manual wires drag from the ⚬ port.
// Boards persist per-vault through vaultConfigRead/Write('canvas') — the existing config
// channel, so web parity comes for free. Media (mermaid/images) is capped at 340px per
// segment; widen the card to ≥560px (drag the corner) and it shows full height on-canvas.

const KV_BIG_W = 560, KV_MIN_W = 200, KV_MAX_W = 1400;
let KV = null;                    // {boards:[], cur} (CoreCanvas.normState shape)
let kvSaveT = null, kvBuilt = false, kvMmSeq = 0;
const kvNoteCache = new Map();    // rel -> {sections:[{name,text}]}
const kvOpenFolders = new Set();

function kvState() { return KV.boards[KV.cur]; }

function kvSave() {
  clearTimeout(kvSaveT);
  kvSaveT = setTimeout(() => { try { window.api.vaultConfigWrite('canvas', KV); } catch (_) {} }, 600);
}

async function kvLoad() {
  let raw = null;
  try { raw = await window.api.vaultConfigRead('canvas'); } catch (_) {}
  KV = window.CoreCanvas.normState(raw);
}

async function kvSectionsOf(rel) {
  let c = kvNoteCache.get(rel);
  if (!c) {
    let md = '';
    try { md = await window.api.readNote(rel); } catch (_) {}
    c = { sections: window.CoreCanvas.parseSections(typeof md === 'string' ? md : (md && md.content) || '') };
    kvNoteCache.set(rel, c);
  }
  return c.sections;
}
function kvSectionsSync(rel) { const c = kvNoteCache.get(rel); return c ? c.sections : []; }

// ---- mermaid: same contract as the editor (window.mermaid), unique ids, orphan sweep ----
function kvMermaid(el, code, isRetry) {
  const mm = window.mermaid;
  if (!mm || !String(code || '').trim()) { el.textContent = ''; return; }
  const id = 'kvmm-' + (++kvMmSeq);
  Promise.resolve().then(async () => {
    try {
      const r = await mm.render(id, code);
      el.innerHTML = (r && r.svg) || '';
      kvDrawWires();
    } catch (e) {
      // the very first render after a view swap can lose mermaid's temp container mid-measure
      // ("Cannot read properties of null (reading 'firstChild')") — one delayed retry fixes it
      if (!isRetry) { setTimeout(() => kvMermaid(el, code, true), 350); return; }
      el.innerHTML = '<div class="md-mermaid-err">' + String(e && e.message || e).replace(/</g, '&lt;').slice(0, 200) + '</div>';
    }
    try { document.querySelectorAll('body > svg[id^="kvmm-"], body > div[id^="dkvmm-"]').forEach((n) => n.remove()); } catch (_) {}
  });
}

// ---------- view entry (called by setMainView) ----------
async function renderCanvas() {
  const host = document.getElementById('canvasView');
  if (!host) return;
  if (!kvBuilt) { kvBuild(host); kvBuilt = true; }
  if (!KV) await kvLoad();
  // fresh content every time the view opens (web has no watcher; desktop also picks up edits)
  kvNoteCache.clear();
  await kvPaintBoard();
}

function kvBuild(host) {
  host.innerHTML =
    '<div class="kv-bar">' +
    // board picking/adding moved to the sidebar list (like dashboards, user 2026-09-15) —
    // the bar shows the OPEN board's name; rename/delete still act on it here
    '<span class="kv-title" id="kvBoardTitle"></span>' +
    '<button id="kvRenB" class="ghost sm" title="' + t('เปลี่ยนชื่อบอร์ด') + '">✎</button>' +
    '<button id="kvDelB" class="ghost sm" title="' + t('ลบบอร์ดนี้') + '">🗑</button>' +
    '<span class="kv-cnt" id="kvCnt"></span>' +
    '<button id="kvAddN" class="ghost sm">＋ ' + t('เพิ่มโน้ต') + '</button>' +
    '<button id="kvAddS" class="ghost sm">＋ ' + t('สติกกี้') + '</button>' +
    '<button id="kvArr" class="ghost sm" title="' + t('จัดตำแหน่งการ์ดใหม่ตามขนาดจริง ไม่ให้ซ้อนกัน') + '">⊞ ' + t('จัดเรียง') + '</button>' +
    '<button id="kvHub" class="ghost sm" title="' + t('ภาพรวมอยู่กลาง รายละเอียดกระจายรอบ (การ์ดที่มีเส้นมากสุดเป็นศูนย์กลาง)') + '">☉ ' + t('ศูนย์กลาง') + '</button>' +
    '<button id="kvRz" class="ghost sm">' + t('รีเซ็ตซูม') + '</button>' +
    '</div>' +
    '<div class="kv-world" id="kvWorld">' +
    '<div class="kv-pz" id="kvPz"><svg class="kv-wires" id="kvWires"></svg></div>' +
    '<div class="kv-picker" id="kvPicker" hidden><input id="kvPq" placeholder="' + t('ค้นหาโน้ตใน vault…') + '"><div id="kvPlist"></div></div>' +
    '<div class="kv-hint">' + t('ลากหัวการ์ด = ย้าย · ลากมุมขวาล่าง = ปรับขนาด · เส้นปะ = ข้อเสนอจาก [[ลิงก์]] คลิกเพื่อยืนยัน · ลากจุด ⚬ ข้างท่อน = เชื่อมเอง') + '</div>' +
    '</div>';

  const world = document.getElementById('kvWorld');

  // pan (drag empty space) + pinch/⌘-scroll zoom anchored at the cursor, two-finger scroll pans
  world.addEventListener('mousedown', (e) => {
    if (e.target.closest('.kv-card') || e.target.closest('.kv-picker')) return;
    const st = kvState(), sx = e.clientX, sy = e.clientY, ox = st.view.tx, oy = st.view.ty;
    world.classList.add('kv-grabbing');
    const mm = (ev) => { st.view.tx = ox + ev.clientX - sx; st.view.ty = oy + ev.clientY - sy; kvApplyView(); };
    const mu = () => { world.classList.remove('kv-grabbing'); removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true); kvSave(); };
    addEventListener('mousemove', mm, true); addEventListener('mouseup', mu, true);
  });
  world.addEventListener('wheel', (e) => {
    e.preventDefault();
    const st = kvState();
    if (e.ctrlKey || e.metaKey) {
      const r = world.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      const ns = Math.min(2.5, Math.max(0.3, st.view.scale * Math.exp(-e.deltaY * 0.01)));
      st.view.tx = cx - (cx - st.view.tx) * (ns / st.view.scale);
      st.view.ty = cy - (cy - st.view.ty) * (ns / st.view.scale);
      st.view.scale = ns;
    } else { st.view.tx -= e.deltaX; st.view.ty -= e.deltaY; }
    kvApplyView(); kvSave();
  }, { passive: false });

  document.getElementById('kvRz').onclick = () => { const st = kvState(); st.view = { tx: 40, ty: 30, scale: 1 }; kvApplyView(); kvSave(); };
  // ⊞ grid arrange: grid is always-on now (adopt at paint + birth), so this is just a
  // force re-settle. ☉ hub maps its result back onto cells (see kvHubArrange).
  document.getElementById('kvArr').onclick = () => { kvGridSuckIn(null); kvArrangeSettled(null, 'grid'); };
  document.getElementById('kvHub').onclick = () => kvArrangeSettled(null, true);
  document.getElementById('kvRenB').onclick = () => kvRenameBoard(KV.cur);
  document.getElementById('kvDelB').onclick = () => kvDeleteBoard(KV.cur);
  document.getElementById('kvAddS').onclick = () => {
    const st = kvState();
    kvAddCard({ id: st.seq++, type: 'sticky', body: '', x: 120 + Math.random() * 260, y: 120 + Math.random() * 160, w: 200 });
  };
  document.getElementById('kvAddN').onclick = () => {
    const p = document.getElementById('kvPicker');
    p.hidden = !p.hidden;
    if (!p.hidden) { document.getElementById('kvPq').value = ''; kvRenderPicker(); document.getElementById('kvPq').focus(); }
  };
  document.getElementById('kvPq').addEventListener('input', kvRenderPicker);
  addEventListener('mousedown', (e) => {
    const p = document.getElementById('kvPicker');
    if (p && !p.hidden && !e.target.closest('.kv-picker') && e.target.id !== 'kvAddN') p.hidden = true;
  }, true);

  // note edited anywhere (chat edit, another window) -> drop cache, repaint if visible
  try {
    window.api.onNoteChanged(({ name }) => {
      if (!kvNoteCache.has(name)) return;
      kvNoteCache.delete(name);
      if (typeof mainView !== 'undefined' && mainView === 'canvas') kvPaintBoard();
    });
  } catch (_) {}
}

function kvApplyView() {
  const st = kvState(), pz = document.getElementById('kvPz'), world = document.getElementById('kvWorld');
  if (pz) pz.style.transform = 'translate(' + st.view.tx + 'px,' + st.view.ty + 'px) scale(' + st.view.scale + ')';
  // background follows the pan/zoom (user 2026-09-22): the 1-PITCH dot tile is anchored to
  // the cell origin and scaled with the view, so dots always sit on real cell corners
  if (world && window.CoreCanvasGrid) {
    const bg = window.CoreCanvasGrid.bgFor(st.view);
    world.style.backgroundPosition = bg.position;
    world.style.backgroundSize = bg.size;
  }
}

function kvSyncBoards() {
  const ttl = document.getElementById('kvBoardTitle');
  if (ttl) ttl.textContent = kvState() ? kvState().name : '';
  if (typeof renderSidebar === 'function') renderSidebar();   // board rows live in the sidebar now
}

function kvSwitchBoard(i) { KV.cur = i; kvSave(); kvPaintBoard(); }

// ---- sidebar board list API (mirrors dashboards: rows in the sidebar, ＋ on the group) ----
async function kvEnsureLoaded() { if (!KV) await kvLoad(); return KV; }
function kvBoardNames() { return KV ? KV.boards.map((b) => b.name) : null; }   // null = not loaded yet
function kvCurBoard() { return KV ? KV.cur : -1; }
async function kvOpenBoard(i) {
  await kvEnsureLoaded();
  if (i < 0 || i >= KV.boards.length) return;
  KV.cur = i; kvSave();
  if (typeof mainView !== 'undefined' && mainView !== 'canvas' && typeof setMainView === 'function') setMainView('canvas');
  else await kvPaintBoard();
}
async function kvNewBoardFlow() {
  await kvEnsureLoaded();
  const n = prompt(t('ชื่อบอร์ดใหม่'), t('บอร์ดใหม่')); if (!n) return;
  KV.boards.push(window.CoreCanvas.newBoard(n.trim() || t('บอร์ดใหม่')));
  await kvOpenBoard(KV.boards.length - 1);
}
function kvRenameBoard(i) {
  if (!KV || !KV.boards[i]) return;
  const n = prompt(t('ชื่อบอร์ด'), KV.boards[i].name); if (!n || !n.trim()) return;
  KV.boards[i].name = n.trim(); kvSyncBoards(); kvSave();
}
function kvDeleteBoard(i) {
  if (!KV || !KV.boards[i]) return;
  if (KV.boards.length <= 1) { alert(t('ต้องมีอย่างน้อย 1 บอร์ด')); return; }
  if (!confirm(t('ลบบอร์ด') + ' "' + KV.boards[i].name + '" ?')) return;
  KV.boards.splice(i, 1);
  kvSwitchBoard(Math.min(Math.max(0, KV.cur - (i <= KV.cur ? 1 : 0)), KV.boards.length - 1));
  kvSyncBoards();
}

function kvSyncCnt() {
  const st = kvState(), el = document.getElementById('kvCnt');
  if (el) el.textContent = st.cards.length + ' ' + t('การ์ด') + ' · ' + st.edges.length + ' ' + t('เส้น');
}

// ---------- board paint ----------
async function kvPaintBoard() {
  const st = kvState(), pz = document.getElementById('kvPz');
  if (!pz) return;
  // grid ALWAYS-ON (user 2026-09-22): a board with any free card adopts it at paint time —
  // opening a legacy board = it enters the grid immediately, no ⊞ needed. Adopt happens
  // ONLY here, so boards the user never opened are never written (migration rule).
  const adopting = st.cards.some((c) => !c.at);
  [...pz.querySelectorAll('.kv-card')].forEach((n) => n.remove());
  for (const c of st.cards) if (c.type === 'note') await kvSectionsOf(c.rel);   // warm cache for sync render
  st.cards.forEach((c) => kvRenderCard(c));
  kvApplyView(); kvSyncBoards(); kvSyncCnt(); kvDrawWires();
  if (adopting) kvGridAdopt();
  // pending arrange flag (AI CANVAS-ARRANGE, or auto after place/add): the board is visible
  // now, so run the mode and clear it — the settle loop re-checks visibility itself
  if (st.needsArrange || adopting) {
    const host = document.getElementById('canvasView');
    if (host && host.offsetParent) {
      const mode = st.needsArrange === 'hub' ? 'hub' : 'grid';
      st.needsArrange = null;
      kvArrangeSettled(null, mode);
    }
  }
}

function kvAddCard(card) {
  const st = kvState(), G = window.CoreCanvasGrid;
  // grid always-on: every new card is BORN on the grid — firstFit from the current board,
  // px geometry straight from the cell, then one settle stretch. No free cards remain.
  if (G && !card.at) {
    card.span = G.spanFromPx(card.w, 180);
    card.at = G.firstFit(st.cards.filter((o) => o.at && o.span).map((o) => ({ c: o.at.c, r: o.at.r, w: o.span.w, h: o.span.h })), card.span, 8);
    const p = G.cellToPx(card.at, card.span);
    card.x = p.x; card.y = p.y; card.w = p.w;
  }
  st.cards.push(card);
  kvRenderCard(card); kvSyncCnt(); kvDrawWires(); kvSave();
  kvArrangeSettled(null, 'grid');
}

function kvRemoveCard(card) {
  const st = kvState();
  st.cards = st.cards.filter((x) => x.id !== card.id);
  st.edges = st.edges.filter((e) => e.a !== card.id && e.b !== card.id);
  const n = kvCardEl(card.id); if (n) n.remove();
  kvSyncCnt(); kvDrawWires(); kvSave();
}

function kvCardEl(id) { return document.querySelector('#kvPz .kv-card[data-id="' + id + '"]'); }

function kvRenderCard(c) {
  const pz = document.getElementById('kvPz');
  let node = kvCardEl(c.id);
  if (!node) { node = document.createElement('div'); node.className = 'kv-card'; node.dataset.id = c.id; pz.appendChild(node); }
  node.classList.toggle('kv-sticky', c.type === 'sticky');
  node.classList.toggle('kv-wide', c.w >= KV_BIG_W);
  node.style.left = c.x + 'px'; node.style.top = c.y + 'px'; node.style.width = c.w + 'px';

  const title = c.type === 'sticky' ? t('สติกกี้') : window.CoreCanvas.titleOfRel(c.rel);
  node.innerHTML = '';
  const hd = document.createElement('div'); hd.className = 'kv-hd';
  hd.innerHTML = '<span>' + (c.type === 'sticky' ? '🗒' : '📄') + '</span><span class="kv-ttl"></span><button class="kv-x" title="' + t('เอาการ์ดออกจากบอร์ด') + '">✕</button>';
  hd.querySelector('.kv-ttl').textContent = title;
  if (c.type === 'note') { hd.title = t('ลากเพื่อย้าย · ดับเบิลคลิกเพื่อเปิดโน้ต'); hd.ondblclick = () => { try { openNote(c.rel); } catch (_) {} }; }
  hd.querySelector('.kv-x').onclick = (e) => { e.stopPropagation(); kvRemoveCard(c); };
  hd.onmousedown = (e) => {
    if (e.target.classList.contains('kv-x')) return;
    e.preventDefault(); e.stopPropagation();
    const st = kvState(), sx = e.clientX, sy = e.clientY, ox = c.x, oy = c.y;
    const world = document.getElementById('kvWorld');
    if (world) world.classList.add('kv-griding');   // faint grid = snapping is live
    const mm = (ev) => {
      c.x = ox + (ev.clientX - sx) / st.view.scale; c.y = oy + (ev.clientY - sy) / st.view.scale;
      node.style.left = c.x + 'px'; node.style.top = c.y + 'px'; kvDrawWires();
    };
    const mu = () => {
      removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true);
      if (world) world.classList.remove('kv-griding');
      kvSnapCard(c);   // px -> nearest cell -> px (always-on grid)
      kvSave();
    };
    addEventListener('mousemove', mm, true); addEventListener('mouseup', mu, true);
  };
  node.appendChild(hd);

  if (c.type === 'sticky') {
    const sg = document.createElement('div'); sg.className = 'kv-seg';
    const tx = document.createElement('div'); tx.className = 'kv-tx'; tx.contentEditable = 'true';
    tx.textContent = c.body || '';
    tx.setAttribute('data-ph', t('พิมพ์สรุปตรงนี้…'));
    tx.oninput = () => { c.body = tx.textContent; kvSave(); };
    tx.onmousedown = (e) => e.stopPropagation();
    sg.appendChild(tx); node.appendChild(sg);
  } else {
    const secs = kvSectionsSync(c.rel);
    (c.segs || []).forEach((name, si) => {
      const sec = window.CoreCanvas.sectionByName(secs, name);
      const sg = document.createElement('div'); sg.className = 'kv-seg'; sg.dataset.seg = si;
      const links = sec ? window.CoreCanvas.sectionLinks(sec.text) : [];
      if (links.length) sg.classList.add('kv-linked');
      sg.innerHTML = '<div class="kv-sn">§ <span></span><button class="kv-sx" title="' + t('เอาท่อนนี้ออก') + '">✕</button></div>' +
        '<div class="kv-tx md"></div><div class="kv-port" title="' + t('ลากไปการ์ด/ท่อนอื่นเพื่อเชื่อมเอง') + '"></div>';
      sg.querySelector('.kv-sn span').textContent = name;
      const tx = sg.querySelector('.kv-tx');
      if (!sec) tx.innerHTML = '<span class="kv-miss">' + t('ไม่พบหัวข้อนี้ในโน้ตแล้ว') + '</span>';
      else kvRenderMd(tx, sec.text);
      sg.querySelector('.kv-sx').onclick = (e) => {
        e.stopPropagation();
        const st = kvState();
        c.segs.splice(si, 1);
        st.edges = st.edges.filter((e2) => !((e2.a === c.id && e2.aSeg === si) || (e2.b === c.id && e2.bSeg === si)));
        // seg indexes above the removed one shift down — remap surviving edge anchors
        st.edges.forEach((e2) => {
          if (e2.a === c.id && e2.aSeg != null && e2.aSeg > si) e2.aSeg--;
          if (e2.b === c.id && e2.bSeg != null && e2.bSeg > si) e2.bSeg--;
        });
        kvRenderCard(c); kvDrawWires(); kvSave();
      };
      sg.querySelector('.kv-port').onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); kvStartWire(c, si); };
      node.appendChild(sg);
    });
    const remaining = secs.map((s) => s.name).filter((n) => !(c.segs || []).includes(n));
    if (remaining.length) {
      const sel = document.createElement('select'); sel.className = 'kv-addseg';
      sel.innerHTML = '<option value="">▾ ' + t('เพิ่มท่อนจากโน้ตนี้…') + '</option>' +
        remaining.map((n) => '<option>' + n.replace(/</g, '&lt;') + '</option>').join('');
      sel.onmousedown = (e) => e.stopPropagation();
      sel.onchange = () => { if (sel.value) { c.segs.push(sel.value); kvRenderCard(c); kvDrawWires(); kvSave(); } };
      node.appendChild(sel);
    }
  }

  // resize corner: card width is per-card; ≥560px lifts the 340px media cap (full diagram on-canvas)
  const rs = document.createElement('div'); rs.className = 'kv-rs'; rs.title = t('ลากเพื่อปรับขนาดการ์ด');
  rs.onmousedown = (e) => {
    e.preventDefault(); e.stopPropagation();
    const st = kvState(), sx = e.clientX, ow = c.w;
    const world = document.getElementById('kvWorld');
    if (world) world.classList.add('kv-griding');
    const mm = (ev) => {
      c.w = Math.min(KV_MAX_W, Math.max(KV_MIN_W, ow + (ev.clientX - sx) / st.view.scale));
      node.style.width = c.w + 'px'; node.classList.toggle('kv-wide', c.w >= KV_BIG_W); kvDrawWires();
    };
    const mu = () => {
      removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true);
      if (world) world.classList.remove('kv-griding');
      kvSnapCard(c);   // width px -> nearest cell span -> px (always-on grid)
      kvSave();
    };
    addEventListener('mousemove', mm, true); addEventListener('mouseup', mu, true);
  };
  node.appendChild(rs);
}

// section markdown -> HTML (assets resolved), mermaid fences -> live diagrams, media capped
function kvRenderMd(el, md) {
  el.innerHTML = mdToHtmlAssets(md);
  el.querySelectorAll('pre.md-mermaid-src[data-mmd]').forEach((pre) => {
    const d = document.createElement('div'); d.className = 'md-mermaid-render';
    pre.replaceWith(d);
    kvMermaid(d, pre.dataset.mmd || '');
  });
  el.querySelectorAll('img, .md-mermaid-render').forEach((m) => {
    const wrap = document.createElement('div'); wrap.className = 'kv-media';
    m.replaceWith(wrap); wrap.appendChild(m);
    if (m.tagName === 'IMG') m.addEventListener('load', () => kvDrawWires());
  });
}

// ---------- wires (anchor at the SEGMENT; dashed = suggestion, solid = confirmed) ----------
function kvAnchor(id, seg, side) {
  const st = kvState(), c = st.cards.find((x) => x.id === id), node = kvCardEl(id);
  if (!c || !node) return { x: 0, y: 0 };
  let y = c.y + node.offsetHeight / 2;
  const sgEl = seg != null ? node.querySelector('.kv-seg[data-seg="' + seg + '"]') : null;
  if (sgEl) y = c.y + sgEl.offsetTop + sgEl.offsetHeight / 2;
  return { x: c.x + (side === 'l' ? 0 : node.offsetWidth), y };
}

function kvAllEdges() {
  const st = kvState();
  const sugg = window.CoreCanvas.suggestEdges(st.cards, kvSectionsSync, st.edges);
  return st.edges.map((e) => ({ ...e, auto: false })).concat(sugg);
}

function kvDrawWires(temp) {
  const st = kvState(), svg = document.getElementById('kvWires');
  if (!svg) return;
  svg.innerHTML = '';
  const NS = 'http://www.w3.org/2000/svg';
  for (const e of kvAllEdges()) {
    const ca = st.cards.find((x) => x.id === e.a), cb = st.cards.find((x) => x.id === e.b);
    if (!ca || !cb) continue;
    const leftToRight = cb.x >= ca.x;
    const p1 = kvAnchor(e.a, e.aSeg, leftToRight ? 'r' : 'l'), p2 = kvAnchor(e.b, e.bSeg, leftToRight ? 'l' : 'r');
    const mx = (p1.x + p2.x) / 2;
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M' + p1.x + ' ' + p1.y + ' C' + mx + ' ' + p1.y + ' ' + mx + ' ' + p2.y + ' ' + p2.x + ' ' + p2.y);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', e.auto ? 'var(--wa-gold)' : 'var(--accent)');
    path.setAttribute('stroke-width', e.auto ? 1.6 : 2.2);
    if (e.auto) path.setAttribute('stroke-dasharray', '6 4');
    svg.appendChild(path);
    // fat transparent hit path: dashed -> click to CONFIRM into a saved edge; solid -> click to remove
    const hit = document.createElementNS(NS, 'path');
    hit.setAttribute('d', path.getAttribute('d'));
    hit.setAttribute('stroke', 'transparent'); hit.setAttribute('stroke-width', 14); hit.setAttribute('fill', 'none');
    hit.style.pointerEvents = 'stroke'; hit.style.cursor = 'pointer';
    const tt = document.createElementNS(NS, 'title');
    tt.textContent = e.auto ? t('เส้นแนะนำจาก [[ลิงก์]] ในโน้ต — คลิกเพื่อยืนยันเป็นเส้นถาวร') : t('เส้นที่ยืนยันแล้ว — คลิกเพื่อลบ');
    hit.appendChild(tt);
    hit.onmouseenter = () => path.setAttribute('stroke-width', e.auto ? 3 : 3.4);
    hit.onmouseleave = () => path.setAttribute('stroke-width', e.auto ? 1.6 : 2.2);
    hit.onclick = () => {
      if (e.auto) st.edges.push({ a: e.a, b: e.b, aSeg: e.aSeg, bSeg: e.bSeg });
      else {
        if (!confirm(t('ลบเส้นนี้?'))) return;
        st.edges = st.edges.filter((x) => !(x.a === e.a && x.b === e.b && x.aSeg === e.aSeg && x.bSeg === e.bSeg));
      }
      kvSyncCnt(); kvDrawWires(); kvSave();
    };
    svg.appendChild(hit);
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', p1.x); dot.setAttribute('cy', p1.y); dot.setAttribute('r', 3);
    dot.setAttribute('fill', e.auto ? 'var(--wa-gold)' : 'var(--accent)');
    svg.appendChild(dot);
  }
  if (temp) {
    const p1 = kvAnchor(temp.a, temp.aSeg, 'r');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M' + p1.x + ' ' + p1.y + ' L' + temp.x + ' ' + temp.y);
    path.setAttribute('stroke', 'var(--accent)'); path.setAttribute('stroke-width', 2);
    path.setAttribute('stroke-dasharray', '4 4'); path.setAttribute('fill', 'none');
    svg.appendChild(path);
  }
}

function kvStartWire(c, si) {
  const world = document.getElementById('kvWorld');
  const mm = (ev) => {
    const st = kvState(), r = world.getBoundingClientRect();
    kvDrawWires({ a: c.id, aSeg: si, x: (ev.clientX - r.left - st.view.tx) / st.view.scale, y: (ev.clientY - r.top - st.view.ty) / st.view.scale });
  };
  const mu = (ev) => {
    removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true);
    const st = kvState();
    const hitEl = document.elementFromPoint(ev.clientX, ev.clientY);
    const sgEl = hitEl && hitEl.closest('.kv-seg'), cdEl = hitEl && hitEl.closest('.kv-card');
    if (cdEl && +cdEl.dataset.id !== c.id) {
      st.edges.push({ a: c.id, aSeg: si, b: +cdEl.dataset.id, bSeg: sgEl && sgEl.dataset.seg != null ? +sgEl.dataset.seg : null });
      kvSyncCnt(); kvSave();
    }
    kvDrawWires();
  };
  addEventListener('mousemove', mm, true); addEventListener('mouseup', mu, true);
}

// ---------- auto-arrange: shelf layout from MEASURED heights ----------
// The op-time layout can only guess (content heights are unknown until render), so tall
// cards could overlap. This packs cards row-by-row using the real node heights. ids=null
// arranges the whole board; an id list re-places ONLY those cards below the existing
// content (AI additions never disturb a hand-arranged board).
function kvAutoArrange(ids) {
  const st = kvState(), GAP = 36, MAXW = 1300;
  const hOf = (c) => { const n = kvCardEl(c.id); return n ? n.offsetHeight : 220; };
  let targets = st.cards, x = 40, y = 40, rowH = 0;
  if (Array.isArray(ids)) {
    targets = st.cards.filter((c) => ids.includes(c.id));
    if (!targets.length) return;
    const others = st.cards.filter((c) => !ids.includes(c.id));
    y = others.length ? Math.max(...others.map((c) => c.y + hOf(c))) + GAP : 40;
  }
  for (const c of targets) {
    if (x > 40 && x + c.w > MAXW) { x = 40; y += rowH + GAP; rowH = 0; }
    c.x = x; c.y = y;
    const n = kvCardEl(c.id);
    if (n) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px'; }
    x += c.w + GAP; rowH = Math.max(rowH, hOf(c));
  }
  kvDrawWires(); kvSave();
}

// Hub layout (user idea 2026-09-09): the OVERVIEW card sits in the middle and detail cards
// flank it left/right in height-balanced columns — hub = the most-wired card (suggestions
// count too), tie-broken by width, so the board's own link structure picks the centre.
// Cards wired to the hub come first (nearest), stickies and strays fill after.
function kvHubArrange() {
  const st = kvState(), GAP = 70, VGAP = 40;
  if (st.cards.length < 3) { kvAutoArrange(null); return; }
  const hOf = (c) => { const n = kvCardEl(c.id); return n ? n.offsetHeight : 220; };
  const edges = kvAllEdges(), deg = {};
  edges.forEach((e) => { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; });
  const notes = st.cards.filter((c) => c.type === 'note');
  const hub = (notes.length ? notes : st.cards).slice()
    .sort((a, b) => ((deg[b.id] || 0) - (deg[a.id] || 0)) || (b.w - a.w))[0];
  const linkedToHub = (c) => edges.some((e) => (e.a === hub.id && e.b === c.id) || (e.b === hub.id && e.a === c.id));
  const rest = st.cards.filter((c) => c.id !== hub.id)
    .sort((a, b) => (linkedToHub(b) - linkedToHub(a)) || ((deg[b.id] || 0) - (deg[a.id] || 0)));
  const maxSideW = Math.max(200, ...rest.map((c) => c.w));
  hub.x = 60 + maxSideW + GAP; hub.y = 60;
  let leftH = 0, rightH = 0;
  for (const c of rest) {
    const h = hOf(c);
    if (leftH <= rightH) { c.x = hub.x - GAP - c.w; c.y = 60 + leftH; leftH += h + VGAP; }
    else { c.x = hub.x + hub.w + GAP; c.y = 60 + rightH; rightH += h + VGAP; }
  }
  // grid always-on: map the hub result back to CELLS — pxToCell per card, collisions
  // resolved by firstFit in y,x order (same machinery as adopt) — then a full grid layout.
  // The hub still FEELS centred, but every card lands on a real cell.
  const G = window.CoreCanvasGrid;
  if (G) {
    const got = G.adoptFreeCards(st.cards.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w })));
    for (const c of st.cards) { const a = got[c.id]; if (a) { c.at = a.at; c.span = a.span; } }
    kvGridArrange();
    return;
  }
  st.cards.forEach((c) => { const n = kvCardEl(c.id); if (n) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px'; } });
  kvDrawWires(); kvSave();
}

// ---------- square-grid layout (G2, 2026-09-22): cells, not pixels ----------
// The AI/user states position in CELL units (at) and span (size); CoreCanvasGrid does the
// pure math. This side measures REAL heights after render and writes results back into the
// normal x/y/w state, so wires/zoom keep working unchanged.
const kvHOf = (c) => { const n = kvCardEl(c.id); return n ? n.offsetHeight : 0; };

// Always-on adopt (pure core fn): every free card gets at/span AT its current position.
// Called from kvPaintBoard only — a board is migrated the first time it is OPENED, never
// from a background write (migration rule).
function kvGridAdopt() {
  const st = kvState(), G = window.CoreCanvasGrid;
  if (!G) return;
  const got = G.adoptFreeCards(st.cards);
  for (const c of st.cards) {
    const a = got[c.id];
    if (a) { c.at = a.at; c.span = a.span; }
    else if (c.at && !c.span) c.span = G.spanFromPx(c.w, 0);   // stray at without span
  }
  kvSave();
}

// Give free cards an at/span via firstFit. ids=null -> ALL free cards (the ⊞ button — the
// ONE moment independent cards join the grid per rule 5); an id list only sucks those in.
function kvGridSuckIn(ids) {
  const st = kvState(), G = window.CoreCanvasGrid;
  if (!G) return;
  st.cards
    .filter((c) => !c.at && (!Array.isArray(ids) || ids.includes(c.id)))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .forEach((c) => {
      c.span = G.spanFromPx(c.w, kvHOf(c) || 180);
      const occ = st.cards.filter((o) => o.at && o.span).map((o) => ({ c: o.at.c, r: o.at.r, w: o.span.w, h: o.span.h }));
      c.at = G.firstFit(occ, c.span, 8);
    });
}

// Layout every grid card from measured heights: no overlap, no scroll, vertical centring in
// the reserved block (centerDy). Cards without at are untouched (rule 5).
function kvGridArrange() {
  const st = kvState(), G = window.CoreCanvasGrid;
  if (!G) return;
  const lay = G.layoutGrid(st.cards
    .filter((c) => c.at && c.span)
    .map((c) => ({ id: c.id, c: c.at.c, r: c.at.r, w: c.span.w, h: c.span.h, measuredH: kvHOf(c) })));
  for (const c of st.cards) {
    const L = lay[c.id];
    if (!L) continue;
    c.at = { c: L.c, r: L.r };
    c.w = L.wPx; c.x = L.x; c.y = L.y + L.centerDy;
    const n = kvCardEl(c.id);
    if (n) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px'; n.style.width = c.w + 'px'; n.classList.toggle('kv-wide', c.w >= KV_BIG_W); }
  }
  kvDrawWires(); kvSave();
}

// Drop/resize snap: nearest cell -> back to px. A collision hands over to a full grid settle.
function kvSnapCard(c) {
  const st = kvState(), G = window.CoreCanvasGrid;
  if (!G) return;
  c.at = G.pxToCell(c.x, c.y);
  c.span = G.spanFromPx(c.w, kvHOf(c) || 180);
  const p = G.cellToPx(c.at, c.span);
  c.w = p.w; c.x = p.x; c.y = p.y;
  const n = kvCardEl(c.id);
  if (n) { n.style.left = c.x + 'px'; n.style.top = c.y + 'px'; n.style.width = c.w + 'px'; n.classList.toggle('kv-wide', c.w >= KV_BIG_W); }
  const clash = st.cards.some((o) => o.id !== c.id && o.at && o.span &&
    c.at.c < o.at.c + o.span.w && o.at.c < c.at.c + c.span.w &&
    c.at.r < o.at.r + o.span.h && o.at.r < c.at.r + c.span.h);
  kvDrawWires();
  if (clash) kvArrangeSettled(null, 'grid');
}

// Arrange keeps re-running until measured heights STOP CHANGING: a big mermaid card can take
// seconds to render, and a single pass taken too early measures bare headers, packs tightly,
// then the late diagrams grow into their neighbours (log 2026-09-09, Cheat Sheet board).
// mode: true/'hub' = hub · 'grid' = square grid · else shelf (ids subset).
let kvArrT = null;
function kvArrangeSettled(ids, mode) {
  clearTimeout(kvArrT);
  let tries = 0, prev = '';
  const pass = () => {
    // view hidden (boot restore raced the switch) -> nodes measure 0 and the layout collapses;
    // wait instead of arranging garbage, and never let a 0-height pass count as "settled"
    const host = document.getElementById('canvasView');
    if (!host || !host.offsetParent) { if (tries++ < 12) kvArrT = setTimeout(pass, 700); return; }
    mode === 'grid' ? kvGridArrange() : (mode ? kvHubArrange() : kvAutoArrange(ids));
    const sig = kvState().cards.map((c) => { const n = kvCardEl(c.id); return n ? n.offsetHeight : 0; }).join(',');
    if (sig !== prev && tries++ < 12) { prev = sig; kvArrT = setTimeout(pass, 700); }
  };
  pass();
}

// ---------- AI verbs (===CANVAS-*===) ----------
// Executes the ordered op list from an AI reply: resolve note names with the same resolver
// the other verbs use, warm the section cache so the pure applier can validate seg names,
// then apply + save + repaint. A sticky toast summarizes what changed (with a jump button).
// AI-written note names come clipped ("AP-CD Process" for the full dashed title) — after the
// exact resolver, accept a UNIQUE title prefix, then a UNIQUE substring (log 2026-09-08:
// GLM's first real board lost 2 of 3 cards to short names).
function kvResolveNoteLoose(nm) {
  try {
    const exact = (typeof _resolveNoteRel === 'function' && _resolveNoteRel(nm)) || null;
    if (exact) return exact;
    const key = String(nm || '').trim().replace(/\.md$/i, '').split('/').pop().toLowerCase();
    if (!key) return null;
    const map = window.__wlNoteRel || {}, st = [], hs = [];
    for (const k of Object.keys(map)) {
      if (k.startsWith(key)) st.push(map[k]); else if (k.includes(key)) hs.push(map[k]);
    }
    if (st.length === 1) return st[0];
    if (!st.length && hs.length === 1) return hs[0];
    return null;
  } catch (_) { return null; }
}

async function kvApplyAiOps(ops) {
  if (!KV) await kvLoad();
  const resolveNote = kvResolveNoteLoose;
  for (const o of ops) {
    for (const nm of [o.name, o.from, o.to]) {
      const rel = nm && resolveNote(nm);
      if (rel) { try { await kvSectionsOf(rel); } catch (_) {} }
    }
  }
  const r = window.CoreCanvas.applyVerbOps(KV, ops, { resolveNote, sectionsOf: kvSectionsSync });
  // grid (G2): a batch that placed/added cards pulls the NEW cards onto the grid and flags a
  // grid arrange — explicit CANVAS-ARRANGE (either mode) already set by the AI wins.
  const batchPlaced = (r.addedIds || []).length > 0 || ops.some((o) => o.op === 'place' || o.op === 'add');
  if (batchPlaced) {
    if ((r.addedIds || []).length) kvGridSuckIn(r.addedIds);
    const st = kvState();
    if (!st.needsArrange) st.needsArrange = 'grid';
  }
  kvSave();
  if (typeof mainView !== 'undefined' && mainView === 'canvas') { try { await kvPaintBoard(); } catch (_) {} }
  // belt for slow media: one delayed grid settle when the view is open (mermaid grows late)
  if (batchPlaced) {
    setTimeout(() => { try { if (typeof mainView !== 'undefined' && mainView === 'canvas') kvArrangeSettled(null, 'grid'); } catch (_) {} }, 900);
  }
  const msg = '🖼 ' + t('แคนวาส') + ': ' + (r.applied.length ? r.applied.join(' · ') : t('ไม่มีอะไรเปลี่ยน')) +
    (r.errors.length ? ' — ⚠ ' + r.errors.join(' · ') : '');
  if (typeof pdfToast === 'function') {
    pdfToast(msg.slice(0, 300), { sticky: true, action: { label: t('เปิดแคนวาส'), fn: () => setMainView('canvas') } });
  }
  return r;
}

// ===CANVAS-LIST=== -> the board state fed back to the AI (boards, cards with their CHOSEN
// segs, edges, plus each note's full section-name list so the AI can pick segs correctly).
async function kvCanvasToolResult() {
  if (!KV) await kvLoad();
  const st = kvState(), lines = [];
  lines.push('บอร์ดทั้งหมด: ' + KV.boards.map((b, i) => (i === KV.cur ? '▶ ' : '') + b.name).join(' · '));
  lines.push('บอร์ดปัจจุบัน "' + st.name + '" — ' + st.cards.length + ' การ์ด, ' + st.edges.length + ' เส้น');
  for (const c of st.cards) {
    if (c.type === 'sticky') { lines.push('- สติกกี้: ' + String(c.body || '').slice(0, 80)); continue; }
    const secs = await kvSectionsOf(c.rel);
    lines.push('- การ์ด "' + window.CoreCanvas.titleOfRel(c.rel) + '" ท่อนที่แสดง: ' + (c.segs.join(' | ') || '(ไม่มี)') +
      ' | หัวข้อทั้งหมดในโน้ต: ' + secs.map((s) => s.name).join(' | ').slice(0, 500));
  }
  for (const e of st.edges) {
    const ca = st.cards.find((x) => x.id === e.a), cb = st.cards.find((x) => x.id === e.b);
    if (ca && cb) lines.push('- เส้น: ' + window.CoreCanvas.titleOfRel(ca.rel || 'สติกกี้') + ' → ' + window.CoreCanvas.titleOfRel(cb.rel || 'สติกกี้'));
  }
  return '[สถานะแคนวาส]\n' + lines.join('\n').slice(0, 4000);
}

// ---------- note picker: drill-down by folder like the sidebar; typing flattens to search ----------
async function kvRenderPicker() {
  const plist = document.getElementById('kvPlist'), q = document.getElementById('kvPq').value.trim().toLowerCase();
  let notes = [];
  try { const r = await window.api.listNotes(); notes = (r && r.notes) || []; } catch (_) {}
  const rels = notes.map((n) => (typeof n === 'string' ? n : (n.rel || n.path || ''))).filter((rel) =>
    rel && !/^PDF-Text\//.test(rel) && !/^KUMIKO[-.]/i.test(rel));
  plist.innerHTML = '';
  const st = kvState();
  const mk = (rel) => {
    const used = st.cards.some((c) => c.rel === rel);
    const it = document.createElement('div'); it.className = 'kv-pit' + (used ? ' kv-used' : '');
    it.textContent = '📄 ' + window.CoreCanvas.titleOfRel(rel) + (used ? ' ✓' : '');
    it.title = rel;
    it.onclick = async () => {
      if (used) return;
      const secs = await kvSectionsOf(rel);
      kvAddCard({
        id: st.seq++, type: 'note', rel, x: 100 + Math.random() * 320, y: 110 + Math.random() * 220, w: 264,
        segs: secs.length ? [secs[0].name] : [],
      });
      kvRenderPicker();
    };
    return it;
  };
  if (q) { rels.filter((rel) => rel.toLowerCase().includes(q)).forEach((rel) => plist.appendChild(mk(rel))); return; }
  const folders = [...new Set(rels.map((rel) => rel.includes('/') ? rel.split('/')[0] : t('(นอกกล่อง)')))];
  for (const f of folders) {
    const items = rels.filter((rel) => (rel.includes('/') ? rel.split('/')[0] : t('(นอกกล่อง)')) === f);
    const open = kvOpenFolders.has(f);
    const fh = document.createElement('div'); fh.className = 'kv-fh';
    fh.innerHTML = '<span class="kv-tri">' + (open ? '▼' : '▶') + '</span>📁 <span></span> <span class="kv-fn">(' + items.length + ')</span>';
    fh.querySelectorAll('span')[1].textContent = f;
    fh.onclick = () => { open ? kvOpenFolders.delete(f) : kvOpenFolders.add(f); kvRenderPicker(); };
    plist.appendChild(fh);
    if (open) items.forEach((rel) => plist.appendChild(mk(rel)));
  }
}
