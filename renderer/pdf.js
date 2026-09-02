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
let pdfRestoring = 0;   // >0 while a programmatic scroll (page restore / goto) is in flight
let _pdfGotoSeq = 0;    // a newer goto cancels an older one's retry loop

function pdfPagesEl(){ return document.getElementById('pdfPages'); }

// ---- PDF → markdown text pipeline (POC) --------------------------------------
// Extract a PDF's text with pdf.js (getTextContent per page, joined into lines) and save
// it as a note under PDF-Text/, so the existing RAG index picks it up and the AI can
// "read" the PDF. Runs behind the scenes on open (once per PDF). Scanned/image PDFs yield
// little text — OCR (e.g. Typhoon-OCR) is the follow-up phase.
async function extractPdfToMarkdown(name, preData){
  if (!window.pdfjsLib) return null;
  let data = preData || null;
  if (!data) { try { const buf = await window.api.readPdf(name); data = buf ? (buf instanceof Uint8Array ? buf : new Uint8Array(buf)) : null; } catch (_) { data = null; } }
  if (!data) return null;
  let doc; try { doc = await window.pdfjsLib.getDocument({ data }).promise; } catch (_) { return null; }
  const base = name.replace(/\.pdf$/i, '').split('/').pop();
  let md = '# ' + base + '\n\n> ดึงข้อความอัตโนมัติจากไฟล์ PDF `' + name + '` (สำหรับให้ AI อ้างอิง)\n\n';
  for (let p = 1; p <= doc.numPages; p++){
    let text = '';
    try {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '', lastY = null;
      for (const it of tc.items){
        const y = (it.transform && it.transform.length > 5) ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 3){ text += line.replace(/\s+$/, '') + '\n'; line = ''; }
        line += (it.str || '') + (it.hasEOL ? '\n' : ' ');
        lastY = y;
      }
      text += line;
    } catch (_) {}
    md += '## หน้า ' + p + '\n\n' + text.trim() + '\n\n';
  }
  return md;
}
// The visible-body length of a pdf.js extraction (drops the # / > / ## scaffolding), so we
// can tell a DIGITAL pdf (lots of text) from a SCANNED one (little/none → needs OCR).
function _pdfBodyLen(md){
  if (!md) return 0;
  return md.replace(/^#.*$/gm, '').replace(/^>.*$/gm, '').replace(/^## หน้า.*$/gm, '').replace(/\s+/g, '').length;
}
// Cheap content signature (byte length + hashed head/tail) — changes whenever the PDF's
// bytes change, so a same-named NEW VERSION is detected and re-indexed instead of skipped.
function _djb2(bytes, start, end){ let h = 5381; for (let i = start; i < end; i++){ h = ((h << 5) + h + bytes[i]) | 0; } return h >>> 0; }
function _pdfSignature(bytes){
  const n = bytes.length, k = Math.min(4096, n);
  return n.toString(36) + '.' + _djb2(bytes, 0, k).toString(36) + '.' + _djb2(bytes, n - k, n).toString(36);
}
async function indexPdfIntoRag(name, preData){
  let md = await extractPdfToMarkdown(name, preData);  // fast path: pdf.js text (digital PDFs)
  // Sparse text ⇒ likely a scanned/image PDF ⇒ OCR with Apple Vision (desktop/macOS only;
  // window.api.pdfOcr returns null off-mac, so this quietly no-ops on web/Windows).
  if (_pdfBodyLen(md) < 40 && window.api && window.api.pdfOcr) {
    try {
      const ocr = await window.api.pdfOcr(name);
      if (ocr && ocr.replace(/\s+/g, '').length > _pdfBodyLen(md)) {
        const base = name.replace(/\.pdf$/i, '').split('/').pop();
        md = '# ' + base + '\n\n> ดึงข้อความจาก PDF `' + name + '` ด้วย OCR (Apple Vision) — สำหรับให้ AI อ้างอิง\n\n' + ocr;
      }
    } catch (_) {}
  }
  if (md == null) return { ok: false };
  const noteName = 'PDF-Text/' + name.replace(/\.pdf$/i, '').split('/').pop() + '.md';
  try { await window.api.saveNote(noteName, md); } catch (_) { return { ok: false }; }
  return { ok: true, note: noteName, chars: md.length };
}

// ---- Background PDF indexer (Cursor-style) --------------------------------------------
// Silently OCR/extract every PDF in the vault into RAG, one at a time, throttled so it never
// blocks the UI. A per-vault cache (by name) skips already-indexed PDFs so it only does new
// work — like Cursor indexing a codebase. A small chip shows progress.
let _pdfQueue = [], _pdfIndexing = false;
function _pdfIndexStatus(remaining){
  const el = document.getElementById('pdfIndexChip');
  if (!el) return;
  if (remaining > 0){ el.hidden = false; el.textContent = '📄 ' + t('อ่าน PDF…') + ' (' + remaining + ')'; }
  else el.hidden = true;
}
async function _indexPdfOnce(name, force){
  // Read bytes (cheap) to compute the content signature: skip only if the file is UNCHANGED
  // since last index. A new version of a same-named PDF has a new signature → re-indexed.
  let bytes = null;
  try { const b = await window.api.readPdf(name); bytes = b ? (b instanceof Uint8Array ? b : new Uint8Array(b)) : null; } catch (_) {}
  if (!bytes) return;
  const sig = _pdfSignature(bytes);
  const cache = (typeof vsGet === 'function') ? (vsGet('pdfIndexed', {}) || {}) : {};
  if (cache[name] === sig && !force) return;               // unchanged → skip the expensive extract/OCR
  const r = await indexPdfIntoRag(name, bytes);            // reuse the bytes we already read
  if (r && r.ok){ cache[name] = sig; if (typeof vsSet === 'function') vsSet('pdfIndexed', cache); }
}
async function _runPdfQueue(){
  if (_pdfIndexing) return; _pdfIndexing = true;
  while (_pdfQueue.length){
    _pdfIndexStatus(_pdfQueue.length);
    const name = _pdfQueue.shift();
    try { await _indexPdfOnce(name); } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));   // throttle — stay out of the way
  }
  _pdfIndexing = false; _pdfIndexStatus(0);
}
async function backgroundIndexAllPdfs(){
  let pdfs = []; try { const r = await window.api.listNotes(); pdfs = (r && r.pdfs) || []; } catch (_) { return; }
  // Queue EVERY PDF (not just unseen names) — _indexPdfOnce skips unchanged ones by signature,
  // so a re-uploaded / edited PDF is re-indexed. (Future optimisation: gate on file mtime via a
  // stat API to avoid re-reading bytes of unchanged files each pass.)
  const todo = pdfs.filter((p) => _pdfQueue.indexOf(p) < 0);
  if (!todo.length) return;
  _pdfQueue.push.apply(_pdfQueue, todo);
  _runPdfQueue();
}
window.backgroundIndexAllPdfs = backgroundIndexAllPdfs;
// Kick off ~5s after load (once the app has settled), and refresh when a vault syncs.
if (typeof window !== 'undefined') setTimeout(() => { try { backgroundIndexAllPdfs(); } catch (_) {} }, 5000);
window.extractPdfToMarkdown = extractPdfToMarkdown;
window.indexPdfIntoRag = indexPdfIntoRag;
const _pdfIndexed = new Set();   // don't re-extract the same PDF twice per session

async function openPdf(name){
  currentPdf = name;
  currentNote = null;
  // Behind-the-scenes: (re)extract the OPEN PDF's text into RAG — force a fresh pass once per
  // session so an opened PDF is always current; the background indexer handles the rest.
  if (!_pdfIndexed.has(name)) { _pdfIndexed.add(name); Promise.resolve().then(() => _indexPdfOnce(name, true)).catch(() => {}); }
  if (typeof clearAutolink === 'function') clearAutolink();
  const left = document.getElementById('left');
  if (left){ left.classList.remove('view-graph','view-table','view-dash','view-crate','view-trash'); left.classList.add('view-pdf'); }
  mainView = 'pdf';
  document.querySelectorAll('.sb-views .sbv').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('#noteList .note-item').forEach((el) => el.classList.toggle('active', el.dataset.pdf === name));
  try { const c = document.getElementById('crumb'); if (c) c.innerHTML = '<b>' + name.replace(/\.pdf$/i, '').split('/').pop() + '</b>'; } catch (_) {}
  vsSet('lastPdf', name);
  vsSet('lastOpen', { type: 'pdf', name });
  // recency list for the dashboard's "อ่านต่อ" widget
  try { const rp = (vsGet('recentPdfs', []) || []).filter((x) => x !== name); rp.unshift(name); vsSet('recentPdfs', rp.slice(0, 5)); } catch (_) {}
  if (name === pdfLoadedName && pdfDoc && pdfPagesEl() && pdfPagesEl().querySelector('.pdf-page')) {
    // Re-showing an already-loaded doc (note → back to the same PDF): after display:none the
    // browser restores scrollTop to a nearby-but-WRONG offset, so re-anchor to the remembered
    // page instead of trusting whatever the pane wakes up at.
    const back = vsPdfPageGet(name);
    pdfGoto((back && back > 0) ? back : pdfCurPage, true);
    return;
  }
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
  updateCaptureTargetBtn();   // the note button shows this PDF's capture target
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

// A scroll event may only UPDATE the remembered page when it is a real user scroll on the
// visible, fully-loaded doc: not while the pane is hidden or just re-shown (display:none
// clamps scrollTop to 0, and the browser's own restore on re-show lands on a nearby-but-wrong
// offset), not while a programmatic goto is mid-glide, and not while the host still shows the
// OLD doc during a PDF→PDF switch (the clamp-to-0 event would stamp "หน้า 1" onto the NEW pdf
// before its saved page is even read).
function pdfSyncAllowed(view, restoring, loadedName, curName, pageCount){
  return view === 'pdf' && !restoring && !!curName && loadedName === curName && pageCount > 0;
}
function pdfScrollSync(){
  const host = pdfPagesEl();
  if (!host || !pdfDoc) return;
  const pages = host.querySelectorAll('.pdf-page-wrap');
  if (!pdfSyncAllowed(mainView, pdfRestoring, pdfLoadedName, currentPdf, pages.length)) return;
  let cur = 1; const top = host.scrollTop;
  pages.forEach((c) => { if (c.offsetTop - host.offsetTop <= top + 80) cur = +c.dataset.page; });
  pdfCurPage = cur;
  const cnt = document.getElementById('pdfCount'); if (cnt) cnt.textContent = cur + ' / ' + pdfDoc.numPages;
  vsPdfPageSet(currentPdf, cur);
}

function pdfScrollToPage(page, yFrac, margin){
  const host = pdfPagesEl();
  if (!host || !pdfDoc) return;
  page = Math.min(pdfDoc.numPages, Math.max(1, page));
  yFrac = yFrac || 0; margin = margin || 0;
  let tries = 0, last = -1;
  const seq = ++_pdfGotoSeq;
  pdfRestoring++;
  // scroll events during the glide are OURS, not the user's — pdfScrollSync stays quiet until
  // we settle, then the DESTINATION is stamped as the current page (lazy-rendered pages shift
  // heights mid-glide, so trusting intermediate scrollTop readings saved wrong pages).
  const settle = (arrived) => {
    pdfRestoring = Math.max(0, pdfRestoring - 1);
    if (!arrived) return;
    pdfCurPage = page;
    const cnt = document.getElementById('pdfCount'); if (cnt && pdfDoc) cnt.textContent = page + ' / ' + pdfDoc.numPages;
    if (currentPdf && currentPdf === pdfLoadedName) vsPdfPageSet(currentPdf, page);
  };
  const step = () => {
    if (seq !== _pdfGotoSeq) { settle(false); return; }
    if (mainView !== 'pdf') { settle(false); return; }
    const c = host.querySelector('.pdf-page-wrap[data-page="' + page + '"]');
    if (!c) { settle(false); return; }
    const target = Math.max(0, Math.round(host.scrollTop + (c.getBoundingClientRect().top - host.getBoundingClientRect().top) + (yFrac * c.clientHeight) - margin));
    if (Math.abs(target - host.scrollTop) > 2) host.scrollTop = target;
    tries++;
    if (target === last && tries > 2) { settle(true); return; }
    last = target;
    if (tries < 10) setTimeout(step, 110); else settle(true);
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
  item.dataset.dragKind = 'pdf'; item.dataset.dragRel = rel;
  item.onclick = () => openPdf(rel);
  item.oncontextmenu = (e) => { e.preventDefault(); openPdfMenu(e.clientX, e.clientY, rel); };
  return item;
}

(function wirePdf(){
  const bind = () => {
    const pv = document.getElementById('pdfPrev'); if (pv) pv.onclick = () => pdfGoto(pdfCurPage - 1);
    const nx = document.getElementById('pdfNext'); if (nx) nx.onclick = () => pdfGoto(pdfCurPage + 1);
    const host = pdfPagesEl(); if (host) host.addEventListener('scroll', pdfScrollSync);
    if (host && window.ResizeObserver){ let _rt = null; pdfRO = new ResizeObserver(() => { if (!pdfAutoFit || !pdfDoc || mainView !== 'pdf') return; clearTimeout(_rt); _rt = setTimeout(() => renderPdf(++pdfRenderToken), 200); }); pdfRO.observe(host); }
    const abtn = document.getElementById('pdfAnnotsBtn'); if (abtn) abtn.onclick = () => toggleAnnotPanel();
    const cbtn = document.getElementById('pdfAreaBtn'); if (cbtn) cbtn.onclick = () => toggleAreaMode();
    const tbtn = document.getElementById('pdfTextBtn'); if (tbtn) tbtn.onclick = () => toggleTextMode();
    if (host) host.addEventListener('mousedown', pdfAreaMousedown, true);
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
  let to = nameNoSlash(nm.trim()); if (!/\.pdf$/i.test(to)) to += '.pdf';
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
  // capture target is stored in the OPEN pdf's annots — for another PDF, open it first
  const pickTarget = async () => { if (rel !== currentPdf) await openPdf(rel); openCaptureTargetMenu(null); };
  [[t('โน้ตเป้าหมาย (ที่เก็บไฮไลต์/สไลด์)…'), pickTarget], [t('เปลี่ยนชื่อ'), () => renamePdf(rel)], [t('ลบ (ไปถังขยะ)'), () => deletePdf(rel)]].forEach(([label, fn]) => {
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
let _hlSuppressClick = false;   // true for the click that ENDS an area drag/resize — don't open the bar

// AREA highlights are movable/resizable after creation (text highlights stay anchored to their
// glyphs). Drag the body to move, the corner grip to resize; a <4px press still counts as a click.
function attachAreaEdit(d, h){
  const grip = document.createElement('div'); grip.className = 'pdf-hl-grip';
  d.appendChild(grip);
  const start = (e, mode) => {
    if (e.button !== 0) return;
    const wrap = d.closest('.pdf-page-wrap'); if (!wrap) return;
    const cw = wrap.clientWidth, ch = wrap.clientHeight;
    if (!cw || !ch || !h.rects || !h.rects[0]) return;
    const r0 = Object.assign({}, h.rects[0]);
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const mm = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= 4) return;
      moved = true;
      const dx = (ev.clientX - sx) / cw, dy = (ev.clientY - sy) / ch;
      const r = h.rects[0];
      if (mode === 'move'){
        r.x = Math.max(0, Math.min(r0.x + dx, 1 - r0.w));
        r.y = Math.max(0, Math.min(r0.y + dy, 1 - r0.h));
      } else {
        r.w = Math.max(0.01, Math.min(r0.w + dx, 1 - r0.x));
        r.h = Math.max(0.01, Math.min(r0.h + dy, 1 - r0.y));
      }
      d.style.left = (r.x * cw) + 'px'; d.style.top = (r.y * ch) + 'px';
      d.style.width = (r.w * cw) + 'px'; d.style.height = (r.h * ch) + 'px';
    };
    const mu = () => {
      window.removeEventListener('mousemove', mm, true);
      window.removeEventListener('mouseup', mu, true);
      if (moved){
        savePdfAnnots();
        _hlSuppressClick = true; setTimeout(() => { _hlSuppressClick = false; }, 0);
      }
    };
    e.preventDefault(); e.stopPropagation();
    window.addEventListener('mousemove', mm, true);
    window.addEventListener('mouseup', mu, true);
  };
  d.addEventListener('mousedown', (e) => { if (e.target === grip) return; start(e, 'move'); });
  grip.addEventListener('mousedown', (e) => start(e, 'resize'));
}

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
      d.onclick = (ev) => { ev.stopPropagation(); if (_hlSuppressClick) return; showHlBar(ev.clientX, ev.clientY, 'edit', h); };
      if (h.area) attachAreaEdit(d, h);
      hlLayer.appendChild(d);
    });
  });
}
// recover the exact render scale for a page wrap (falls back to the doc scale, then 1) — text-box
// font sizing multiplies by this, so a missing scale would render boxes at native (huge) size.
function _wrapScale(wrap){ const s = wrap && parseFloat(wrap.dataset.scale); return (s && isFinite(s)) ? s : (pdfScale || 1); }
function redrawPage(pageNum){
  const host = pdfPagesEl(); if (!host) return;
  const wrap = host.querySelector('.pdf-page-wrap[data-page="' + pageNum + '"]'); if (!wrap) return;
  const hl = wrap.querySelector('.pdf-hllayer');
  if (hl) drawPageHighlights(pageNum, hl, wrap.clientWidth, wrap.clientHeight);
  const tl = wrap.querySelector('.pdf-tboxlayer');
  if (tl) drawPageTextboxes(pageNum, tl, wrap.clientWidth, wrap.clientHeight, _wrapScale(wrap));
}
function redrawCurrentPages(){
  const host = pdfPagesEl(); if (!host) return;
  host.querySelectorAll('.pdf-page-wrap').forEach((wrap) => {
    const hl = wrap.querySelector('.pdf-hllayer');
    if (hl) drawPageHighlights(+wrap.dataset.page, hl, wrap.clientWidth, wrap.clientHeight);
    const tl = wrap.querySelector('.pdf-tboxlayer');
    if (tl) drawPageTextboxes(+wrap.dataset.page, tl, wrap.clientWidth, wrap.clientHeight, _wrapScale(wrap));
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
    mk('note', 'ส่งเข้าโน้ตเป้าหมาย', () => { hideHlBar(); if (hl) sendHighlightToNote(hl); });
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

// ----- comment on a highlight — floating MULTILINE popover next to the highlight -----
// (was a one-line askName dialog; long notes were impossible to write)
function editHlComment(hl){
  if (!hl) return;
  const old = document.getElementById('hlNotePop'); if (old) old.remove();
  const pop = document.createElement('div'); pop.className = 'hl-note-pop'; pop.id = 'hlNotePop';
  const ta = document.createElement('textarea'); ta.className = 'hl-note-ta';
  ta.placeholder = t('คอมเมนต์สำหรับไฮไลต์');
  ta.value = hl.note || '';
  const row = document.createElement('div'); row.className = 'hl-note-row';
  const hint = document.createElement('span'); hint.className = 'hl-note-hint'; hint.textContent = t('Esc ยกเลิก');
  const okBtn = document.createElement('button'); okBtn.type = 'button'; okBtn.className = 'hl-note-save'; okBtn.textContent = t('บันทึก');
  row.appendChild(hint); row.appendChild(okBtn);
  pop.appendChild(ta); pop.appendChild(row);
  const close = () => { pop.remove(); document.removeEventListener('mousedown', onOut, true); };
  const commit = () => {
    hl.note = ta.value.trim();
    savePdfAnnots(); redrawCurrentPages();
    if (annotPanelOpen()) renderAnnotPanel();
    close();
  };
  // click-off SAVES (same feel as the sticky text-box editor); Esc discards
  const onOut = (e) => { if (!pop.contains(e.target)) commit(); };
  okBtn.onclick = (e) => { e.stopPropagation(); commit(); };
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
  };
  document.body.appendChild(pop);
  // anchor to the highlight's first on-screen rect; fall back to the centre of the PDF view
  const el = document.querySelector('.pdf-hl[data-hid="' + hl.id + '"]');
  const pw = pop.offsetWidth || 260, ph = pop.offsetHeight || 96;
  let left, top;
  if (el){
    const r = el.getBoundingClientRect();
    left = r.left; top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  } else {
    const host = document.querySelector('.pdf-body') || document.body;
    const r = host.getBoundingClientRect();
    left = r.left + r.width / 2 - pw / 2; top = r.top + 60;
  }
  pop.style.left = Math.max(8, Math.min(left, window.innerWidth - pw - 8)) + 'px';
  pop.style.top = top + 'px';
  setTimeout(() => { document.addEventListener('mousedown', onOut, true); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
}

// A highlight note may now span lines — every line must live inside the quote block.
function hlNoteQuote(note){
  return String(note || '').split(/\r?\n/).map((l, i) => '> ' + (i === 0 ? '— ' : '') + l).join('\n');
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
    meta.appendChild(paAction('note', 'ส่งเข้าโน้ตเป้าหมาย', () => sendHighlightToNote(h)));
    meta.appendChild(paAction('sparkle', 'ถาม AI', () => askAiHighlight(h)));
    meta.appendChild(paAction('chat', 'คอมเมนต์', () => editHlComment(h)));
    const pg = document.createElement('span'); pg.className = 'pa-pg'; pg.textContent = t('น.') + h.page; meta.appendChild(pg);
    body.appendChild(meta);
    row.appendChild(body);
    row.onclick = (e) => { if (e.target.closest('.pa-act') || e.target.closest('.pa-link')) return; jumpToHighlight(h); };
    p.appendChild(row);
  });
}

// ----- capture target: which TOPIC note captures from this PDF land in -------------------
// Replaces the per-PDF companion note ("1 note = 1 file" fought the whole app's 1-note-1-topic
// model). The target is chosen once per PDF (sticky, stored in the .annot.json sidecar); every
// capture — highlight, AI slide-clip — appends there with a source attribution line.
// Legacy: an old pdfAnnots.companion becomes the initial target, so existing PDFs keep working.
function captureTargetRel(){
  if (!currentPdf || !pdfAnnots) return null;
  const rel = pdfAnnots.captureTarget || pdfAnnots.companion || null;
  if (!rel) return null;
  // target must still exist (renames/deletes) — resolve against the sidebar's note map
  const known = window.__wlNoteRel ? Object.values(window.__wlNoteRel) : [];
  return known.indexOf(rel) >= 0 ? rel : null;
}
function setCaptureTarget(rel){
  if (!currentPdf || !pdfAnnots) return;
  pdfAnnots.captureTarget = rel;
  savePdfAnnots();
  updateCaptureTargetBtn();
}
// (No standalone toolbar button — the picker appears only in context: a capture with no
// target yet, or an AI clip. Kept as a no-op shim for the refreshList hook.)
function updateCaptureTargetBtn(){}
// Picker: filter input + note list + "create new" — the one decision per topic you read.
function openCaptureTargetMenu(anchor){
  // anchor is optional — with none (contextual open from a capture/AI), float near the top
  // centre of the PDF view instead.
  const old = document.getElementById('ctMenu'); if (old) { old.remove(); return; }
  const menu = document.createElement('div'); menu.className = 'ct-menu'; menu.id = 'ctMenu';
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ct-inp';
  inp.placeholder = t('ค้นหา หรือพิมพ์ชื่อโน้ตใหม่…');
  const list = document.createElement('div'); list.className = 'ct-list';
  menu.appendChild(inp); menu.appendChild(list);
  const cur = captureTargetRel();
  const close = () => { menu.remove(); document.removeEventListener('mousedown', onOut, true); };
  const onOut = (e) => { if (!menu.contains(e.target) && (!anchor || e.target !== anchor)) close(); };
  const pick = async (rel) => { setCaptureTarget(rel); close(); };
  const render = () => {
    const q = inp.value.trim().toLowerCase();
    list.innerHTML = '';
    if (cur) {
      const openRow = document.createElement('div'); openRow.className = 'ct-item ct-open';
      openRow.textContent = t('เปิด ') + cur.replace(/\.md$/i, '');
      openRow.onmousedown = (e) => { e.preventDefault(); close(); refreshList(cur); };
      list.appendChild(openRow);
    }
    if (inp.value.trim()) {
      const mk = document.createElement('div'); mk.className = 'ct-item ct-new';
      mk.textContent = t('สร้างโน้ตใหม่: ') + inp.value.trim();
      mk.onmousedown = async (e) => {
        e.preventDefault();
        const nm = nameNoSlash(inp.value.trim().replace(/\.md$/i, ''));
        try { await window.api.saveNote(nm + '.md', ''); await refreshList(currentNote); } catch (_) {}
        pick(nm + '.md');
      };
      list.appendChild(mk);
    }
    const rels = window.__wlNoteRel ? Object.values(window.__wlNoteRel) : [];
    rels.filter((r) => !q || r.toLowerCase().includes(q)).slice(0, 12).forEach((rel) => {
      const it = document.createElement('div'); it.className = 'ct-item' + (rel === cur ? ' on' : '');
      it.textContent = rel.replace(/\.md$/i, '');
      it.onmousedown = (e) => { e.preventDefault(); pick(rel); };
      list.appendChild(it);
    });
  };
  inp.addEventListener('input', render);
  render();
  document.body.appendChild(menu);
  if (anchor && anchor.getBoundingClientRect) {
    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
  } else {
    const host = document.querySelector('.pdf-body') || document.body;
    const r = host.getBoundingClientRect();
    menu.style.top = (r.top + 52) + 'px';
    menu.style.left = Math.max(8, r.left + r.width / 2 - 140) + 'px';
  }
  setTimeout(() => { document.addEventListener('mousedown', onOut, true); inp.focus(); }, 0);
}
// Resolve the target for a capture; when none is chosen yet, open the picker instead of
// silently inventing a destination.
function requireCaptureTarget(){
  const rel = captureTargetRel();
  if (rel) return rel;
  pdfToast(t('เลือกโน้ตเป้าหมายที่จะเก็บก่อน'));
  openCaptureTargetMenu(null);
  return null;
}
// Append a capture to the target note with a source-attribution line — topic notes can mix
// captures from many PDFs and still say where each came from.
async function appendCaptureToTarget(markdown, page){
  const rel = requireCaptureTarget(); if (!rel) return false;
  let content = '';
  try { content = await window.api.readNote(rel); } catch (_) {}
  const src = currentPdf.replace(/\.pdf$/i, '').split('/').pop();
  if (content && !/\n$/.test(content)) content += '\n';
  // attribution is a wikilink back into the PDF: clicking "— chapter10 · หน้า 12" reopens the
  // PDF at that page (handled by __wikiNav's .pdf#pN branch)
  content += '\n' + markdown + '\n\n[[' + currentPdf + '#p' + page + '|— ' + src + t(' · หน้า ') + page + ']]\n';
  await window.api.saveNote(rel, content);
  // capture log — feeds the dashboard's "เก็บเข้าโน้ตวันนี้" study widget
  try {
    const log = vsGet('captureLog', []) || [];
    const kind = markdown.startsWith('![') ? 'image' : (markdown.startsWith('>') ? 'quote' : 'text');
    log.unshift({ ts: Date.now(), page, target: rel, pdf: currentPdf, kind,
      text: markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/^[>\s]+/, '').split('\n')[0].slice(0, 70) });
    vsSet('captureLog', log.slice(0, 50));
  } catch (_) {}
  return true;
}

// ----- send a highlight into the TARGET note -----
async function sendHighlightToNote(hl){
  if (!currentPdf || !hl) return;
  let block = '> ' + (hl.text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (hl.note) block += '\n>\n' + hlNoteQuote(hl.note);
  const ok = await appendCaptureToTarget(block, hl.page);
  if (!ok) return;
  hl.sent = true; savePdfAnnots(); redrawCurrentPages();
  if (annotPanelOpen()) renderAnnotPanel();
  // name the destination + offer to change it — the sticky target used to be invisible and
  // unchangeable once set ("ทำไมเข้าโน้ต DFD เสมอ")
  pdfToast(t('ส่งเข้า ') + captureTargetLabel() + t(' · หน้า ') + hl.page,
    { action: { label: t('เปลี่ยนโน้ต'), fn: () => openCaptureTargetMenu(null) } });
}

// ----- ask AI about a highlight (opens a floating side chat, seeded) -----
function askAiHighlight(hl){
  if (!hl) return;
  const seed = 'ช่วยอธิบายและสรุปข้อความนี้จาก PDF (หน้า ' + hl.page + '):\n"' + (hl.text || '').trim() + '"';
  if (typeof openSideChat === 'function') openSideChat(seed);
}

// ----- tiny toast (reuses the .toast style); opts.action = {label, fn} adds a button -----
function pdfToast(msg, opts){
  const el = document.createElement('div'); el.className = 'toast';
  const life = (opts && opts.life) || ((opts && opts.action) ? 4500 : 2000);   // actionable toasts linger long enough to click
  const kill = () => { el.classList.remove('show'); setTimeout(() => { try { el.remove(); } catch (_) {} }, 300); };
  if (opts && opts.action) {
    const sp = document.createElement('span'); sp.textContent = msg; el.appendChild(sp);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act';
    b.textContent = opts.action.label;
    b.onclick = (e) => { e.stopPropagation(); kill(); try { opts.action.fn(); } catch (_) {} };
    el.appendChild(b);
  } else {
    el.textContent = msg;
  }
  // sticky (user request 2026-09-02: "อยู่ถาวรจนกว่าจะกด"): no auto-expiry — the toast stays
  // until the action button or the ✕ is pressed. Used for AI-created-note review prompts.
  if (opts && opts.sticky) {
    const x = document.createElement('button'); x.type = 'button'; x.className = 'toast-x'; x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); kill(); };
    el.appendChild(x);
  } else {
    setTimeout(kill, life);
  }
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
}
// Short display name of the current capture target ('' when none) — used by toasts so the
// user always SEES where a capture landed (and can change it right there).
function captureTargetLabel(){
  const rel = captureTargetRel();
  return rel ? rel.replace(/\.md$/i, '').split('/').pop() : '';
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
  wrap.dataset.scale = String(scale);   // so redraws can recover the exact render scale (text-box font sizing)
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
  drawPageTextboxes(n, tb, cssW, cssH, scale);
  tl.addEventListener('mouseup', () => onPdfSelectionMaybe(n, wrap, cssW, cssH));
  wrap.dataset.rendered = '1'; wrap.dataset.rendering = '0';
}

/* ========= PDF area-highlight mode (drag a box → highlight, works on scans) ========= */
let pdfAreaMode = false;
let areaDrag = null;

function clearAreaRect(){ const r = document.querySelector('.pdf-area-rect'); if (r) r.remove(); }

function toggleAreaMode(){
  pdfAreaMode = !pdfAreaMode;
  if (pdfAreaMode && pdfTextMode) toggleTextMode();
  const body = document.querySelector('.pdf-body');
  if (body) body.classList.toggle('area-mode', pdfAreaMode);
  const b = document.getElementById('pdfAreaBtn'); if (b) b.classList.toggle('on', pdfAreaMode);
  clearAreaRect();
}

/* ========= PDF text-box annotation (plain bordered box) ========= */
let pdfTextMode = false;
let _pdfTboxEditing = null;   // the text-box <div> whose Milkdown editor is currently open (only one at a time)
let _pdfSuppressCreate = false;
let _pdfTboxSelected = null;      // the box currently SELECTED (click) — distinct from editing (dblclick)   // true for one tick after a click FINISHED an edit, so that same click doesn't ALSO spawn a new box

function toggleTextMode(){
  pdfTextMode = !pdfTextMode;
  if (pdfTextMode && pdfAreaMode) toggleAreaMode();
  const body = document.querySelector('.pdf-body');
  if (body) body.classList.toggle('text-mode', pdfTextMode);
  const b = document.getElementById('pdfTextBtn'); if (b) b.classList.toggle('on', pdfTextMode);
}

function pdfTextMousedown(e){
  if (!pdfTextMode || e.button !== 0) return;
  if (e.target.closest && e.target.closest('.pdf-tbox')) return; // edit existing, don't create
  // If a box's editor is open, a click off it just FINISHES that edit (its own doc listener
  // ends it) — don't ALSO spawn a new box here. The doc listener runs in the CAPTURE phase on
  // `document` (an ancestor of this host), so it has already nulled _pdfTboxEditing by the time
  // this fires; _pdfSuppressCreate carries the "we just finished an edit" signal across that gap.
  if (_pdfTboxEditing || _pdfSuppressCreate) return;
  const wrap = e.target.closest && e.target.closest('.pdf-page-wrap');
  if (!wrap) return;
  e.preventDefault();
  const wr = wrap.getBoundingClientRect();
  const page = +wrap.dataset.page;
  const fx = (e.clientX - wr.left) / wr.width;
  const fy = (e.clientY - wr.top) / wr.height;
  // Store a native font size that renders readably at the CURRENT zoom (pdfScale), so a new
  // box on a small-scale slide isn't tiny. It still scales with the PDF afterwards.
  const sc = _wrapScale(wrap);
  const last = _tboxLast();
  const b = { id: pdfHlId(), page, x: Math.max(0, Math.min(fx - 0.04, 0.95)), y: Math.max(0, Math.min(fy - 0.01, 0.97)), w: 0.22, text: '',
    theme: TBOX_THEMES.indexOf(last.theme) >= 0 ? last.theme : 'yellow',
    align: (last.align === 'center' || last.align === 'right') ? last.align : 'left',
    fontSize: Math.round((last.px || TBOX_DEFAULT_PX) / (sc || 1)) };
  pdfAnnots.textboxes.push(b);
  savePdfAnnots();
  const layer = wrap.querySelector('.pdf-tboxlayer');
  if (layer) drawPageTextboxes(page, layer, wrap.clientWidth, wrap.clientHeight, sc);
  const el = layer && layer.querySelector('.pdf-tbox[data-tid="' + b.id + '"]');
  if (el && el._startEdit) setTimeout(() => el._startEdit(), 0);   // a brand-new box opens straight into the editor
}

function drawPageTextboxes(pageNum, layer, cssW, cssH, scale){
  if (_pdfTboxSelected && layer.contains(_pdfTboxSelected)) _pdfTboxSelected = null;
  layer.querySelectorAll('.pdf-tbox').forEach((el) => { if (el._crepe) { try { el._crepe.destroy(); } catch (_) {} el._crepe = null; if (_pdfTboxEditing === el) _pdfTboxEditing = null; } });
  layer.innerHTML = '';
  pdfAnnots.textboxes.filter((b) => b.page === pageNum).forEach((b) => {
    layer.appendChild(makeTboxEl(b, cssW, cssH, scale));
  });
}

// Font sizing model: `b.fontSize` is stored in NATIVE-PDF px (i.e. at scale 1) so the text
// stays proportional to the page and grows/shrinks with the PDF zoom. New boxes get a native
// size that renders ~TBOX_DEFAULT_PX on screen at the zoom they were created (so the default
// is always readable regardless of the PDF's native dimensions — slides render at a small
// scale, so a fixed native px would look tiny). Legacy boxes (no fontSize) fall back to the
// same readable on-screen default.
const TBOX_DEFAULT_PX = 15;
function tboxNativeFont(b, scale){ return b.fontSize || (TBOX_DEFAULT_PX / (scale || 1)); }
// ---- Sticky-note themes: ONE choice sets background + ink + border as a matched set ----
const TBOX_THEMES = ['yellow', 'pink', 'blue', 'green', 'purple', 'clear'];
// legacy b.bg hex -> nearest theme; unset/white stays the hidden 'white' theme so old boxes look unchanged
const TBOX_LEGACY_BG = { '#fff7c0': 'yellow', '#ffe0ea': 'pink', '#d9ecff': 'blue', '#dff2df': 'green', 'transparent': 'clear' };
function tboxTheme(b){
  if (b.theme && TBOX_THEMES.indexOf(b.theme) >= 0) return b.theme;
  if (b.bg && TBOX_LEGACY_BG[b.bg]) return TBOX_LEGACY_BG[b.bg];
  return 'white';
}
// last-used style (theme + on-screen px) so consecutive stickies come out matching
function _tboxRemember(patch){ try { vsSet('tboxStyle', Object.assign({}, vsGet('tboxStyle', {}) || {}, patch)); } catch (_) {} }
function _tboxLast(){ try { return vsGet('tboxStyle', {}) || {}; } catch (_) { return {}; } }
function makeTboxEl(b, cssW, cssH, scale){
  const el = document.createElement('div');
  el.className = 'pdf-tbox'; el.dataset.tid = b.id;
  el.style.fontSize = (tboxNativeFont(b, scale) * (scale || 1)).toFixed(1) + 'px';   // native px × zoom
  el.style.left = (b.x * cssW) + 'px';
  el.style.top = (b.y * cssH) + 'px';
  el.style.width = (b.w * cssW) + 'px';
  if (b.h) el.style.height = (b.h * cssH) + 'px';
  el.classList.add('tbox-theme-' + tboxTheme(b));   // theme = matched bg + ink + border

  // Content shows RENDERED markdown (cheap); on click it becomes a full Milkdown editor
  // (WYSIWYG, exactly like a note). Created LAZILY so N boxes don't each carry a live editor —
  // only the box you're editing has one at a time.
  const content = document.createElement('div'); content.className = 'pdf-tbox-content';
  const _mdRender = (s) => { try { return (window.CoreMarkdown && window.CoreMarkdown.mdToHtml) ? window.CoreMarkdown.mdToHtml(String(s || '')) : String(s || ''); } catch (_) { return String(s || ''); } };
  const _applyAlign = () => { content.style.textAlign = (b.align === 'center' || b.align === 'right') ? b.align : 'left'; };
  const renderPreview = () => {
    content.classList.remove('editing');
    const h = _mdRender(b.text);
    content.innerHTML = h || ('<div class="pdf-tbox-ph">' + t('พิมพ์ที่นี่…') + '</div>');
    // mermaid fences render as live diagrams in the preview too — same look as while editing
    content.querySelectorAll('pre.md-mermaid-src[data-mmd]').forEach((el2) => {
      const d = document.createElement('div'); d.className = 'md-mermaid-render';
      el2.replaceWith(d);
      try { renderMermaidInto(d, el2.dataset.mmd || ''); } catch (_) {}
    });
    _applyAlign();
  };
  _applyAlign();
  renderPreview();
  let saveT = null, crepe = null, creating = false, tbar = null;
  function _onDocDown(e){
    if (el.contains(e.target)) return;
    // this click ends the edit; block pdfTextMousedown (fires later, same event) from spawning a box
    _pdfSuppressCreate = true; setTimeout(() => { _pdfSuppressCreate = false; }, 0);
    endEdit();
  }
  async function startEdit(){
    if (crepe || creating) return;
    if (_pdfTboxEditing && _pdfTboxEditing !== el && _pdfTboxEditing._endEdit) { try { await _pdfTboxEditing._endEdit(); } catch (_) {} }
    creating = true; _pdfTboxEditing = el;
    content.classList.add('editing'); content.innerHTML = '';
    try {
      // Match the NOTE editor exactly (the user wants "เหมือน Note"): keep every markdown
      // feature — including the CommonMark input rules that turn "# ", "**", "- " into real
      // headings/bold/lists as you type — and disable ONLY the virtual Cursor (invisible in
      // small boxes; the native browser caret is used instead).
      const F = (window.Crepe && window.Crepe.Feature) || {};
      const feats = {};
      const curKey = F.Cursor || 'cursor';
      feats[curKey] = false;
      // crepe's floating B/I selection toolbar overlaps the small box AND duplicates the
      // box's own bar (grip/B/•/link/themes) — off inside sticky boxes (user request)
      feats[F.Toolbar || 'toolbar'] = false;
      const cfg = { root: content, defaultValue: b.text || '', features: feats };
      if (window.MDCodeLangs && F.CodeMirror) cfg.featureConfigs = { [F.CodeMirror]: { languages: window.MDCodeLangs } };
      const c = new window.Crepe(cfg);
      // SAME plugin set as the note editor — typing must look like the final display:
      // wikilinks without brackets, callout colours applied, mermaid rendered live.
      if (window.MDWikiLink) { try { c.editor.use(window.MDWikiLink); } catch (_) {} }
      if (window.MDCalloutColor) { try { c.editor.use(window.MDCalloutColor); } catch (_) {} }
      if (window.MDMermaid) { try { c.editor.use(window.MDMermaid); } catch (_) {} }
      if (window.MDTColor) { try { c.editor.use(window.MDTColor); } catch (_) {} }       // inline text colour
      if (window.MDLinkPaste) { try { c.editor.use(window.MDLinkPaste); } catch (_) {} }  // select + paste URL → link
      await c.create();
      crepe = c; el._crepe = c;
      el.classList.add('editing');
      showBar(true);                     // bar gains the edit-only writing tools
      c.on((l) => l.markdownUpdated(() => { b.text = c.getMarkdown(); clearTimeout(saveT); saveT = setTimeout(savePdfAnnots, 500); }));
      // Focus the editor AND drop a real caret at the end — a bare .focus() leaves
      // ProseMirror with no selection, so keystrokes go nowhere (box looks un-typeable).
      // Retry across a frame because the editor DOM settles just after create().
      const _focusEnd = () => {
        try {
          const ce = content.querySelector('.ProseMirror') || content.querySelector('[contenteditable="true"]');
          if (!ce) return;
          ce.focus({ preventScroll: true });
          const sel = window.getSelection && window.getSelection();
          if (sel) { const rg = document.createRange(); rg.selectNodeContents(ce); rg.collapse(false); sel.removeAllRanges(); sel.addRange(rg); }
        } catch (_) {}
      };
      _focusEnd();
      requestAnimationFrame(_focusEnd);
      document.addEventListener('mousedown', _onDocDown, true);
    } catch (_) { creating = false; if (_pdfTboxEditing === el) _pdfTboxEditing = null; renderPreview(); return; }
    creating = false;
  }
  async function endEdit(){
    document.removeEventListener('mousedown', _onDocDown, true);
    el.classList.remove('editing');
    hideBar(); deselect();
    if (_pdfTboxEditing === el) _pdfTboxEditing = null;
    if (!crepe) return;
    try { b.text = crepe.getMarkdown(); } catch (_) {}
    try { await crepe.destroy(); } catch (_) {}
    crepe = null; el._crepe = null;
    clearTimeout(saveT); savePdfAnnots();
    renderPreview();
  }
  el._startEdit = startEdit; el._endEdit = endEdit;
  // ---- Select-then-edit (Figma/Miro model): click selects (move · theme · size · delete),
  // double-click enters typing. One selected box at a time; Esc or an outside click deselects.
  function showBar(editing){
    if (!tbar) return;
    tbar.hidden = false;
    tbar.classList.toggle('is-editing', !!editing);
    // float above; flip below when the box hugs the page top
    try {
      const r = el.getBoundingClientRect();
      const body = el.closest('.pdf-body') || document.body;
      tbar.classList.toggle('tbar-below', (r.top - body.getBoundingClientRect().top) < 44);
    } catch (_) {}
  }
  function hideBar(){ if (tbar) tbar.hidden = true; }
  function _onDocDownSel(e){ if (!el.contains(e.target)) deselect(); }
  function _onEscSel(e){ if (e.key === 'Escape' && !crepe) deselect(); }
  function select(){
    if (_pdfTboxSelected && _pdfTboxSelected !== el && _pdfTboxSelected._deselect) { try { _pdfTboxSelected._deselect(); } catch (_) {} }
    _pdfTboxSelected = el;
    el.classList.add('selected');
    showBar(false);
    document.addEventListener('mousedown', _onDocDownSel, true);
    document.addEventListener('keydown', _onEscSel, true);
  }
  function deselect(){
    if (_pdfTboxSelected === el) _pdfTboxSelected = null;
    el.classList.remove('selected');
    if (!crepe) hideBar();
    document.removeEventListener('mousedown', _onDocDownSel, true);
    document.removeEventListener('keydown', _onEscSel, true);
  }
  el._deselect = deselect;

  // The WHOLE box is the drag surface while not editing (no more aiming at the thin head strip):
  // the selecting press also starts a move once the pointer travels past the threshold.
  let drag = null;
  function beginDrag(ev, threshold){
    const wrap = el.closest('.pdf-page-wrap'); if (!wrap) return;
    const er = el.getBoundingClientRect();
    const offX = ev.clientX - er.left, offY = ev.clientY - er.top;
    const sx = ev.clientX, sy = ev.clientY;
    let moving = !threshold;
    drag = { wrap, offX, offY };
    if (moving) el.classList.add('dragging');
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    function onMove(e){
      if (!drag) return;
      if (!moving) {
        if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < threshold) return;
        moving = true; el.classList.add('dragging');
      }
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
      if (moving) {
        const wr = drag.wrap.getBoundingClientRect();
        b.x = parseFloat(el.style.left) / wr.width;
        b.y = parseFloat(el.style.top) / wr.height;
        savePdfAnnots();
      }
      drag = null;
    }
  }
  content.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || crepe || creating) return;
    ev.stopPropagation(); ev.preventDefault();
    select();
    beginDrag(ev, 4);
  });
  content.addEventListener('dblclick', (ev) => { if (!crepe && !creating) { ev.stopPropagation(); startEdit(); } });

  const rz = document.createElement('div'); rz.className = 'pdf-tbox-resize'; rz.title = t('ลากเพื่อปรับขนาด');
  rz.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const wrap = el.closest('.pdf-page-wrap'); if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const startX = ev.clientX, startY = ev.clientY;
    const startW = el.offsetWidth, startH = el.offsetHeight;
    const left = parseFloat(el.style.left) || 0, top = parseFloat(el.style.top) || 0;
    el.classList.add('dragging');
    const onMove = (e) => {
      const { w: nw, h: nh } = window.CoreTbox.tboxClampSize(startW, startH, e.clientX - startX, e.clientY - startY, left, top, wr.width, wr.height);
      el.style.width = nw + 'px'; el.style.height = nh + 'px';
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      el.classList.remove('dragging');
      b.w = el.offsetWidth / wr.width;
      b.h = el.offsetHeight / wr.height;
      savePdfAnnots();
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  });
  el.appendChild(rz);

  // ---- Unified control bar — ONE place for everything ---------------------------------
  // Selected: theme dots · A-/A+ · delete. Editing adds B · list · link (everything else the
  // old bar had — headings, code, strike, align, per-word colour — was cut: markdown input
  // rules still cover writing (**bold**, - list, # heading), and colour is now the THEME.
  // Buttons use `mousedown` + preventDefault so the editor never loses its selection.
  tbar = document.createElement('div'); tbar.className = 'pdf-tbox-tbar'; tbar.hidden = true;
  const _view = () => (window.MDEdit && el._crepe) ? window.MDEdit.getView(el._crepe) : null;
  const _sync = () => { try { if (el._crepe) { b.text = el._crepe.getMarkdown(); clearTimeout(saveT); saveT = setTimeout(savePdfAnnots, 400); } } catch (_) {} };
  const tbtn = (label, title, onDown, cls) => {
    const bt = document.createElement('button'); bt.type = 'button'; bt.className = 'pdf-tbar-btn' + (cls ? ' ' + cls : '');
    bt.title = title; bt.innerHTML = label;
    bt.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); onDown(ev); });
    tbar.appendChild(bt); return bt;
  };
  const _mark = (name) => () => { const v = _view(); if (!v) return; const m = v.state.schema.marks[name]; if (!m) return; window.MDEdit.cmd.toggleMark(m)(v.state, v.dispatch, v); v.focus(); _sync(); };
  const _listCmd = (node) => () => { const v = _view(); if (!v) return; const n = v.state.schema.nodes[node]; if (!n) return; window.MDEdit.list.wrapInList(n)(v.state, v.dispatch, v); v.focus(); _sync(); };
  const _sep = (cls) => { const sp = document.createElement('span'); sp.className = 'pdf-tbar-sep' + (cls ? ' ' + cls : ''); tbar.appendChild(sp); };

  const grip = document.createElement('button'); grip.type = 'button';
  grip.className = 'pdf-tbar-btn grip'; grip.title = t('ลากเพื่อย้าย'); grip.textContent = '⠿';
  grip.addEventListener('mousedown', (ev) => { ev.preventDefault(); ev.stopPropagation(); beginDrag(ev, 0); });
  tbar.appendChild(grip);

  tbtn('<b>B</b>', t('ตัวหนา'), _mark('strong'), 'edit-only');
  tbtn('•', t('รายการจุด'), _listCmd('bullet_list'), 'edit-only');
  tbtn('🔗', t('ลิงก์ (ครอบข้อความก่อน)'), async () => {
    const v = _view(); if (!v) return;
    const { from, to, empty } = v.state.selection;
    if (empty) { try { window.toast && window.toast(t('เลือกข้อความที่จะทำลิงก์ก่อน')); } catch (_) {} return; }
    let url = '';
    try { const clip = await navigator.clipboard.readText(); if (/^https?:\/\/\S+$/i.test((clip || '').trim())) url = clip.trim(); } catch (_) {}
    if (!url) { url = (window.prompt ? window.prompt(t('วาง URL:'), 'https://') : '') || ''; url = url.trim(); }
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const mk = v.state.schema.marks.link; if (!mk) return;
    v.dispatch(v.state.tr.addMark(from, to, mk.create({ href: url, title: null })));
    v.focus(); _sync();
  }, 'edit-only');
  _sep('edit-only');

  // theme dots — one click applies the matched bg + ink + border set, remembered for the next box
  const themeBtns = {};
  TBOX_THEMES.forEach((name) => {
    const bt = document.createElement('button'); bt.type = 'button';
    bt.className = 'tb-theme dot-' + name; bt.title = t('ธีมสี');
    bt.addEventListener('mousedown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      TBOX_THEMES.concat(['white']).forEach((n) => el.classList.remove('tbox-theme-' + n));
      b.theme = name; delete b.bg;
      el.classList.add('tbox-theme-' + name);
      _syncThemeDots();
      _tboxRemember({ theme: name });
      savePdfAnnots();
    });
    tbar.appendChild(bt); themeBtns[name] = bt;
  });
  const _syncThemeDots = () => { const cur = tboxTheme(b); TBOX_THEMES.forEach((n) => themeBtns[n].classList.toggle('on', n === cur)); };
  _syncThemeDots();
  _sep();
  // per-box font size (stored native, shown × zoom; remembered for the next box)
  const _setSize = (mul) => {
    const sc2 = scale || 1;
    const next = Math.max(6, Math.min(60, Math.round(tboxNativeFont(b, sc2) * mul * 10) / 10));
    b.fontSize = next;
    el.style.fontSize = (next * sc2).toFixed(1) + 'px';
    _tboxRemember({ px: Math.round(next * sc2) });
    savePdfAnnots();
  };
  tbtn('A−', t('ลดขนาดตัวอักษร'), () => _setSize(1 / 1.2));
  tbtn('A+', t('เพิ่มขนาดตัวอักษร'), () => _setSize(1.2));
  _sep();
  // horizontal alignment — ONE cycling button (left → center → right) to keep the bar compact;
  // vertical is always centred by CSS. Remembered for the next box.
  const ALIGN_ICON = {
    left:   '<svg class="ic-al" viewBox="0 0 14 14"><path d="M2 3h10M2 7h6M2 11h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
    center: '<svg class="ic-al" viewBox="0 0 14 14"><path d="M2 3h10M4 7h6M3 11h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
    right:  '<svg class="ic-al" viewBox="0 0 14 14"><path d="M2 3h10M6 7h6M4 11h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>'
  };
  const ALIGN_ORDER = ['left', 'center', 'right'];
  const ALIGN_NAME = { left: 'ชิดซ้าย', center: 'กึ่งกลาง', right: 'ชิดขวา' };
  const _curAlign = () => (b.align === 'center' || b.align === 'right') ? b.align : 'left';
  const alignBtn = tbtn(ALIGN_ICON.left, '', () => {
    b.align = ALIGN_ORDER[(ALIGN_ORDER.indexOf(_curAlign()) + 1) % ALIGN_ORDER.length];
    _applyAlign(); _syncAlign();
    _tboxRemember({ align: b.align });
    savePdfAnnots();
  });
  const _syncAlign = () => {
    const cur = _curAlign();
    alignBtn.innerHTML = ALIGN_ICON[cur];
    alignBtn.title = t(ALIGN_NAME[cur]) + t(' — กดเพื่อสลับแนว');
  };
  _syncAlign();
  _sep();
  tbtn(icoSvg('trash', 'xs'), t('ลบกล่อง'), () => removeTbox(b.id), 'tb-del');   // NOT 'danger' — that collides with the global solid-red dialog button style

  el.appendChild(tbar); el.appendChild(content);
  return el;
}

function removeTbox(id){
  pdfAnnots.textboxes = pdfAnnots.textboxes.filter((b) => b.id !== id);
  savePdfAnnots();
  redrawCurrentPages();
}

function pdfAreaMousedown(e){
  if (!pdfAreaMode || e.button !== 0) return;
  const wrap = e.target.closest && e.target.closest('.pdf-page-wrap');
  if (!wrap) return;
  e.preventDefault();
  clearAreaRect();
  const wr = wrap.getBoundingClientRect();
  const x0 = e.clientX - wr.left, y0 = e.clientY - wr.top;
  const rect = document.createElement('div'); rect.className = 'pdf-area-rect';
  rect.style.left = x0 + 'px'; rect.style.top = y0 + 'px'; rect.style.width = '0px'; rect.style.height = '0px';
  wrap.appendChild(rect);
  areaDrag = { wrap, x0, y0, rect };
  window.addEventListener('mousemove', pdfAreaMousemove, true);
  window.addEventListener('mouseup', pdfAreaMouseup, true);
}
function pdfAreaMousemove(e){
  if (!areaDrag) return;
  const wr = areaDrag.wrap.getBoundingClientRect();
  let x = e.clientX - wr.left, y = e.clientY - wr.top;
  x = Math.max(0, Math.min(x, wr.width)); y = Math.max(0, Math.min(y, wr.height));
  const left = Math.min(x, areaDrag.x0), top = Math.min(y, areaDrag.y0);
  areaDrag.rect.style.left = left + 'px'; areaDrag.rect.style.top = top + 'px';
  areaDrag.rect.style.width = Math.abs(x - areaDrag.x0) + 'px';
  areaDrag.rect.style.height = Math.abs(y - areaDrag.y0) + 'px';
}
function pdfAreaMouseup(){
  window.removeEventListener('mousemove', pdfAreaMousemove, true);
  window.removeEventListener('mouseup', pdfAreaMouseup, true);
  if (!areaDrag) return;
  const d = areaDrag; areaDrag = null;
  const w = parseFloat(d.rect.style.width), h = parseFloat(d.rect.style.height);
  if (!(w >= 8 && h >= 8)) { d.rect.remove(); return; }
  // no menu — the drag IS the highlight (the old crop-to-image option was removed)
  areaHighlight(d.wrap, d.rect, +d.wrap.dataset.page);
}

// Only what ISN'T visible in the burned clip image: highlight COMMENTS (the highlight fills
// and sticky text-boxes themselves are drawn onto the image by drawPageAnnotsToCanvas, so
// repeating them as text under the image would be noise — user request 2026-08-25).
function pageNotesMarkdown(page){
  if (!pdfAnnots) return '';
  const parts = [];
  (pdfAnnots.highlights || []).filter((h) => h.page === page && h.note).forEach((h) => {
    const q = (h.text && h.text.trim()) ? '> ' + String(h.text).replace(/\s*\n\s*/g, ' ').trim() + '\n>\n' : '';
    parts.push(q + hlNoteQuote(h.note));
  });
  return parts.join('\n\n');
}

// ---- Burn the page's CURRENT annotations into a clip canvas --------------------------------
// A capture must be "ภาพของหน้านั้น ณ เวลานั้น": highlights as the same translucent fills the
// viewer shows, sticky text-boxes as filled rounded boxes with wrapped plain text. Canvas can't
// run the live markdown editor, so box text is flattened (markers stripped, bullets kept as •).
// Colours mirror the .tbox-theme-* CSS set (styles.css) — keep the two in sync.
const TBOX_CANVAS_THEME = {
  yellow: { bg: '#FAEEDA', ink: '#633806', bd: '#e5cb9e' },
  pink:   { bg: '#FBEAF0', ink: '#72243E', bd: '#efc6d5' },
  blue:   { bg: '#E6F1FB', ink: '#0C447C', bd: '#bfdaf2' },
  green:  { bg: '#EAF3DE', ink: '#27500A', bd: '#cadfaf' },
  purple: { bg: '#EEEDFE', ink: '#3C3489', bd: '#d1cdf3' },
  clear:  { bg: null,      ink: '#2c2c2a', bd: null },
  white:  { bg: '#ffffff', ink: '#2c2c2a', bd: '#d8d2c8' }
};
function _tboxPlainLines(md){
  const strip = (l) => l
    .replace(/^#+\s*/, '')
    .replace(/^\s*[-*+]\s+/, '• ')
    .replace(/^\s*>\s?/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g, (m, a, b2) => (b2 || a))
    // markdown backslash-escapes ("\=", "\-", …) display as the bare character — same set as
    // core _mdInline, otherwise a sticky saying "= Credit note" burns in as "\= Credit note"
    .replace(/\\([\\`*_{}\[\]()#+\-.!~|=:;,\/?@^$%'])/g, '$1');
  const out = String(md || '').replace(/```[\s\S]*?```/g, '').split(/\r?\n/).map(strip);
  while (out.length && !out[out.length - 1].trim()) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return out;
}
// Word-wrap for canvas text; Thai has no spaces, so an over-wide chunk falls back to
// per-character breaking instead of overflowing the box.
function _wrapCanvasText(ctx, lines, maxW){
  const out = [];
  lines.forEach((line) => {
    if (!line.trim()) { out.push(''); return; }
    let cur = '';
    const push = () => { const tl = cur.replace(/\s+$/, ''); if (tl) out.push(tl); cur = ''; };
    line.split(/(\s+)/).forEach((w) => {
      if (ctx.measureText(cur + w).width <= maxW) { cur += w; return; }
      push();
      if (ctx.measureText(w).width <= maxW) { cur = w.replace(/^\s+/, ''); return; }
      for (const ch of w.replace(/^\s+/, '')) {
        if (ctx.measureText(cur + ch).width > maxW) push();
        cur += ch;
      }
    });
    push();
  });
  return out;
}
function drawPageAnnotsToCanvas(ctx, pageNum, W, H){
  if (!pdfAnnots) return;
  const lw = Math.max(1.5, W / 800);
  (pdfAnnots.highlights || []).filter((h) => h.page === pageNum).forEach((h) => {
    const c = PDF_HL[h.color] || PDF_HL.gold;
    (h.rects || []).forEach((r) => {
      ctx.fillStyle = c.bg;
      ctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
      if (h.area) { ctx.strokeStyle = c.bd; ctx.lineWidth = lw; ctx.strokeRect(r.x * W, r.y * H, r.w * W, r.h * H); }
    });
  });
  (pdfAnnots.textboxes || []).filter((b) => b.page === pageNum && b.text && b.text.trim()).forEach((b) => {
    const th = TBOX_CANVAS_THEME[tboxTheme(b)] || TBOX_CANVAS_THEME.white;
    // clips render at viewport scale 2, so canvas px = native-PDF px × 2 (same model as the
    // on-screen fontSize × zoom in makeTboxEl)
    const fpx = tboxNativeFont(b, pdfScale || 1) * 2;
    ctx.font = fpx + 'px -apple-system, "SF Pro Text", "Sarabun", sans-serif';
    const bx = b.x * W, by = b.y * H, bw = Math.max(24, b.w * W);
    const pad = fpx * 0.5, lineH = fpx * 1.35;
    const lines = _wrapCanvasText(ctx, _tboxPlainLines(b.text), bw - pad * 2);
    const textH = lines.length * lineH;
    const bh = b.h ? b.h * H : textH + pad * 2;
    const rad = Math.min(10, fpx * 0.4);
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, rad);
    if (th.bg) { ctx.fillStyle = th.bg; ctx.fill(); }
    if (th.bd) { ctx.strokeStyle = th.bd; ctx.lineWidth = lw; ctx.stroke(); }
    // NO clipping — the on-screen box lets text overflow visibly (CSS overflow: visible,
    // content vertically centred), so a hand-shrunk box must not swallow its own lines here
    ctx.fillStyle = th.ink;
    ctx.textBaseline = 'middle';
    const align = (b.align === 'center' || b.align === 'right') ? b.align : 'left';
    ctx.textAlign = align;
    const tx = align === 'center' ? bx + bw / 2 : (align === 'right' ? bx + bw - pad : bx + pad);
    let ty = by + bh / 2 - textH / 2 + lineH / 2;
    lines.forEach((ln) => { ctx.fillText(ln, tx, ty); ty += lineH; });
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  });
}

// The jump-back attribution line for a capture from the open PDF (same format
// appendCaptureToTarget writes) — clicking it reopens the PDF at that page.
function pdfClipAttribution(page){
  const src = currentPdf.replace(/\.pdf$/i, '').split('/').pop();
  return '[[' + currentPdf + '#p' + page + '|— ' + src + t(' · หน้า ') + page + ']]';
}
// Render page N of the open PDF offscreen (works even when that page isn't rendered in the
// viewer) → markdown: JPEG image + the page's own annotations. JPEG keeps the inline data URI
// several times smaller than PNG for slide content. Shared by BOTH clip paths (standalone →
// capture target; in-note marker → resolved into the note body).
async function renderPdfClipMarkdown(pageNum){
  if (!currentPdf || !pdfDoc) return { ok: false, error: 'no-pdf' };
  const n = Math.round(pageNum);
  if (!(n >= 1 && n <= pdfDoc.numPages)) return { ok: false, error: 'bad-page' };
  try {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    // HARD TIMEOUT: a hidden/occluded window can stall pdf.js rendering indefinitely; an
    // unbounded await here once swallowed a whole NEW-NOTE (the save never ran). A timed-out
    // clip degrades to "note without the image" instead of "no note at all".
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    const done = await Promise.race([task.promise.then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]);
    if (!done) { try { task.cancel(); } catch (_) {} return { ok: false, error: 'render-timeout' }; }
    // snapshot "ณ เวลานั้น": the user's stickies + highlights are part of the picture
    try { drawPageAnnotsToCanvas(canvas.getContext('2d'), n, canvas.width, canvas.height); } catch (_) {}
    const uri = canvas.toDataURL('image/jpeg', 0.85);
    const notes = pageNotesMarkdown(n);
    return { ok: true, page: n, md: '![สไลด์หน้า ' + n + '](' + uri + ')' + (notes ? '\n\n' + notes : '') };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}
// AI command ===PDF-CLIP page=N=== OUTSIDE any note block: paste into the TARGET note.
async function clipPdfPageToTarget(pageNum){
  const r = await renderPdfClipMarkdown(pageNum);
  if (!r.ok) return r;
  const ok = await appendCaptureToTarget(r.md, r.page);
  return ok ? { ok: true } : { ok: false, error: 'no-target' };
}

function areaHighlight(wrap, rect, page){
  const cw = wrap.clientWidth, ch = wrap.clientHeight;
  const fr = { x: parseFloat(rect.style.left) / cw, y: parseFloat(rect.style.top) / ch, w: parseFloat(rect.style.width) / cw, h: parseFloat(rect.style.height) / ch };
  rect.remove();
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
  const r = await window.api.renamePdf(pdfRel, to);
  if (r && r.error === 'exists') { alert(t('มีไฟล์ชื่อนี้อยู่ในกล่องนั้นแล้ว')); await refreshList(currentNote); return; }
  if (r && r.error) { await refreshList(currentNote); return; }
  vsPdfPageRename(pdfRel, to);
  if (currentPdf === pdfRel) currentPdf = to;
  if (pdfLoadedName === pdfRel) pdfLoadedName = null;
  await refreshList(currentNote);
}
