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
