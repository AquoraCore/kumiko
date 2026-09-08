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
    '<select id="kvBoardSel" title="' + t('เลือกบอร์ด') + '"></select>' +
    '<button id="kvAddB" class="ghost sm" title="' + t('สร้างบอร์ดใหม่') + '">＋ ' + t('บอร์ด') + '</button>' +
    '<button id="kvRenB" class="ghost sm" title="' + t('เปลี่ยนชื่อบอร์ด') + '">✎</button>' +
    '<button id="kvDelB" class="ghost sm" title="' + t('ลบบอร์ดนี้') + '">🗑</button>' +
    '<span class="kv-cnt" id="kvCnt"></span>' +
    '<button id="kvAddN" class="ghost sm">＋ ' + t('เพิ่มโน้ต') + '</button>' +
    '<button id="kvAddS" class="ghost sm">＋ ' + t('สติกกี้') + '</button>' +
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
  document.getElementById('kvBoardSel').onchange = (e) => kvSwitchBoard(+e.target.value);
  document.getElementById('kvAddB').onclick = () => {
    const n = prompt(t('ชื่อบอร์ดใหม่'), t('บอร์ดใหม่')); if (!n) return;
    KV.boards.push(window.CoreCanvas.newBoard(n.trim() || t('บอร์ดใหม่')));
    kvSwitchBoard(KV.boards.length - 1);
  };
  document.getElementById('kvRenB').onclick = () => {
    const n = prompt(t('ชื่อบอร์ด'), kvState().name); if (!n || !n.trim()) return;
    kvState().name = n.trim(); kvSyncBoards(); kvSave();
  };
  document.getElementById('kvDelB').onclick = () => {
    if (KV.boards.length <= 1) { alert(t('ต้องมีอย่างน้อย 1 บอร์ด')); return; }
    if (!confirm(t('ลบบอร์ด') + ' "' + kvState().name + '" ?')) return;
    KV.boards.splice(KV.cur, 1); kvSwitchBoard(Math.max(0, KV.cur - 1));
  };
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
  const st = kvState(), pz = document.getElementById('kvPz');
  if (pz) pz.style.transform = 'translate(' + st.view.tx + 'px,' + st.view.ty + 'px) scale(' + st.view.scale + ')';
}

function kvSyncBoards() {
  const sel = document.getElementById('kvBoardSel');
  if (sel) sel.innerHTML = KV.boards.map((b, i) =>
    '<option value="' + i + '"' + (i === KV.cur ? ' selected' : '') + '>' + String(b.name).replace(/</g, '&lt;') + '</option>').join('');
}

function kvSwitchBoard(i) { KV.cur = i; kvSave(); kvPaintBoard(); }

function kvSyncCnt() {
  const st = kvState(), el = document.getElementById('kvCnt');
  if (el) el.textContent = st.cards.length + ' ' + t('การ์ด') + ' · ' + st.edges.length + ' ' + t('เส้น');
}

// ---------- board paint ----------
async function kvPaintBoard() {
  const st = kvState(), pz = document.getElementById('kvPz');
  if (!pz) return;
  [...pz.querySelectorAll('.kv-card')].forEach((n) => n.remove());
  for (const c of st.cards) if (c.type === 'note') await kvSectionsOf(c.rel);   // warm cache for sync render
  st.cards.forEach((c) => kvRenderCard(c));
  kvApplyView(); kvSyncBoards(); kvSyncCnt(); kvDrawWires();
}

function kvAddCard(card) {
  const st = kvState();
  st.cards.push(card);
  kvRenderCard(card); kvSyncCnt(); kvDrawWires(); kvSave();
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
    const mm = (ev) => {
      c.x = ox + (ev.clientX - sx) / st.view.scale; c.y = oy + (ev.clientY - sy) / st.view.scale;
      node.style.left = c.x + 'px'; node.style.top = c.y + 'px'; kvDrawWires();
    };
    const mu = () => { removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true); kvSave(); };
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
    const mm = (ev) => {
      c.w = Math.min(KV_MAX_W, Math.max(KV_MIN_W, ow + (ev.clientX - sx) / st.view.scale));
      node.style.width = c.w + 'px'; node.classList.toggle('kv-wide', c.w >= KV_BIG_W); kvDrawWires();
    };
    const mu = () => { removeEventListener('mousemove', mm, true); removeEventListener('mouseup', mu, true); kvSave(); };
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
