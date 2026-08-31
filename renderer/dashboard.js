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
  // "หน้าแรก" role (from the Study-Scroll direction): open this dashboard on app start
  const startLab = document.createElement('label'); startLab.className = 'dash-start';
  const startCk = document.createElement('input'); startCk.type = 'checkbox'; startCk.checked = !!vsGet('startDash', false);
  startCk.onchange = () => vsSet('startDash', startCk.checked);
  startLab.appendChild(startCk); startLab.appendChild(document.createTextNode(' ' + t('เปิดหน้านี้เมื่อเริ่มแอพ')));
  sp.appendChild(startLab);
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
  widgets.forEach((w, i) => canvas.appendChild(w.study ? buildStudyCard(w, i, widgets) : buildDashCard(w, i, data[w.dbId], widgets)));
  scroll.appendChild(canvas); host.appendChild(scroll);
}

// ---- study widgets (2026-08-20): the vault's own life on the dashboard --------------------
const STUDY_KINDS = { reviews: 'รอรีวิวจาก AI', reading: 'อ่านต่อ', captures: 'เก็บเข้าโน้ตวันนี้', recent: 'โน้ตแก้ล่าสุด' };
function _agoText(ts){
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return t('เมื่อครู่');
  if (m < 60) return m + ' ' + t('นาทีก่อน');
  const h = Math.round(m / 60);
  if (h < 24) return h + ' ' + t('ชม.ก่อน');
  const d = Math.round(h / 24);
  return d === 1 ? t('เมื่อวาน') : d + ' ' + t('วันก่อน');
}
function _studyRow(icon, label, sub, onClick){
  const row = document.createElement('div'); row.className = 'dash-li study';
  row.innerHTML = icoSvg(icon, 'xs');
  const nm = document.createElement('span'); nm.className = 'dl-nm'; nm.textContent = label; row.appendChild(nm);
  if (sub){ const s = document.createElement('span'); s.className = 'dl-sub'; s.textContent = sub; row.appendChild(s); }
  if (onClick) row.onclick = onClick;
  return row;
}
function buildStudyCard(w, idx, widgets){
  const card = document.createElement('div'); card.className = 'dash-card span-' + (w.span || 1) + (w.tall ? ' tall' : '');
  const h = document.createElement('div'); h.className = 'dash-h';
  const ttl = document.createElement('span'); ttl.className = 'dash-t';
  ttl.innerHTML = icoSvg(w.study === 'reading' ? 'book' : 'note', 'xs');
  ttl.appendChild(document.createTextNode(' ' + t(STUDY_KINDS[w.study] || w.study)));
  const kind = document.createElement('span'); kind.className = 'dash-kind'; kind.textContent = t('การเรียน');
  const dots = document.createElement('button'); dots.className = 'dash-dots'; dots.textContent = '⋯';
  dots.onclick = (e) => { e.stopPropagation(); openDashCardMenu(dots, idx, widgets); };
  h.appendChild(ttl); h.appendChild(kind); h.appendChild(dots); card.appendChild(h);
  const body = document.createElement('div'); body.className = 'dash-body dash-study';
  card.appendChild(body);
  const empty = (msg) => { const e = document.createElement('div'); e.className = 'ds-done'; e.textContent = msg; body.appendChild(e); };
  const base = (rel) => String(rel || '').replace(/\.md$/i, '').split('/').pop();

  if (w.study === 'reviews'){
    const pending = (window.__pendingReviews) ? [...window.__pendingReviews.keys()] : [];
    const flagged = (window.__flaggedNotes) ? [...window.__flaggedNotes].filter((r) => pending.indexOf(r) < 0) : [];
    card.classList.toggle('dash-attn', pending.length + flagged.length > 0);
    if (!pending.length && !flagged.length) { empty(t('済 ไม่มีงานรอรีวิว')); return card; }
    pending.slice(0, 5).forEach((rel) => body.appendChild(_studyRow('note', base(rel), t('เสนอแก้ — เปิดเพื่อรีวิว'), () => openNote(rel))));
    flagged.slice(0, 5).forEach((rel) => body.appendChild(_studyRow('note', base(rel), t('มีการแก้ไขใหม่'), () => openNote(rel))));
    return card;
  }
  if (w.study === 'reading'){
    const lo = vsGet('lastOpen', null);
    const pdfs = (vsGet('recentPdfs', []) || []).slice();
    if (lo && lo.type === 'pdf' && lo.name && pdfs.indexOf(lo.name) < 0) pdfs.unshift(lo.name);
    if (!pdfs.length) { empty(t('ยังไม่เคยเปิด PDF ใน vault นี้')); return card; }
    pdfs.slice(0, 3).forEach((rel) => {
      const pg = (typeof vsPdfPageGet === 'function') ? vsPdfPageGet(rel) : null;
      body.appendChild(_studyRow('pdf', base(rel), pg ? (t('หน้า ') + pg) : '', () => openPdf(rel)));
    });
    const cap = (vsGet('captureLog', []) || [])[0];
    if (cap && cap.target){
      const s = document.createElement('div'); s.className = 'ds-target';
      s.textContent = t('โน้ตเป้าหมายล่าสุด: ') + base(cap.target);
      s.onclick = () => openNote(cap.target);
      body.appendChild(s);
    }
    return card;
  }
  if (w.study === 'captures'){
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const log = (vsGet('captureLog', []) || []).filter((c) => c.ts >= day0.getTime());
    if (!log.length) { empty(t('วันนี้ยังไม่มีการเก็บเข้าโน้ต')); return card; }
    log.slice(0, 6).forEach((c) => {
      const icon = c.kind === 'image' ? 'gallery' : 'note';
      const label = (c.kind === 'image' ? t('ภาพสไลด์หน้า ') + c.page : (c.text || t('ข้อความ')));
      body.appendChild(_studyRow(icon, label, '→ ' + base(c.target), () => openNote(c.target)));
    });
    return card;
  }
  if (w.study === 'recent'){
    const rec = vsGet('recentNotes', []) || [];
    if (!rec.length) { empty(t('ยังไม่มีประวัติการแก้โน้ต')); return card; }
    rec.slice(0, 6).forEach((r) => body.appendChild(_studyRow('note', base(r.rel), _agoText(r.ts), () => openNote(r.rel))));
    return card;
  }
  empty('?');
  return card;
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
  // study widgets first — the dashboard's "หน้าแรกของวันนี้" role
  const sh = document.createElement('div'); sh.className = 'lp-sub'; sh.textContent = t('การ์ดการเรียน:'); menu.appendChild(sh);
  Object.keys(STUDY_KINDS).forEach((k) => {
    const it = document.createElement('div'); it.className = 'db-mi';
    it.innerHTML = icoSvg(k === 'reading' ? 'book' : 'note', 'sm');
    it.appendChild(document.createTextNode(' ' + t(STUDY_KINDS[k])));
    it.onclick = () => {
      closeDbMenu();
      const ws = loadDashWidgets();
      ws.push({ id: dbNewId('w'), study: k, span: k === 'captures' ? 2 : 1 });
      saveDashWidgets(ws); renderDash();
    };
    menu.appendChild(it);
  });
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
