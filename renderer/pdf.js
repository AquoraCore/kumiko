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
let _pdfTboxEditing = null;   // the text-box <div> whose Milkdown editor is currently open (only one at a time)

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
  // If a box's editor is open, a click off it just FINISHES that edit (its own doc listener
  // ends it) — don't ALSO spawn a new box here.
  if (_pdfTboxEditing) return;
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
  if (el && el._startEdit) setTimeout(() => el._startEdit(), 0);   // a brand-new box opens straight into the editor
}

function drawPageTextboxes(pageNum, layer, cssW, cssH){
  layer.querySelectorAll('.pdf-tbox').forEach((el) => { if (el._crepe) { try { el._crepe.destroy(); } catch (_) {} el._crepe = null; if (_pdfTboxEditing === el) _pdfTboxEditing = null; } });
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
  if (b.h) el.style.height = (b.h * cssH) + 'px';
  if (b.bg) el.style.background = (b.bg === 'transparent' ? 'transparent' : b.bg);   // chosen background colour

  const head = document.createElement('div'); head.className = 'pdf-tbox-head'; head.title = t('ลากเพื่อย้าย');
  // Content shows RENDERED markdown (cheap); on click it becomes a full Milkdown editor
  // (WYSIWYG, exactly like a note). Created LAZILY so N boxes don't each carry a live editor —
  // only the box you're editing has one at a time.
  const content = document.createElement('div'); content.className = 'pdf-tbox-content';
  const _mdRender = (s) => { try { return (window.CoreMarkdown && window.CoreMarkdown.mdToHtml) ? window.CoreMarkdown.mdToHtml(String(s || '')) : String(s || ''); } catch (_) { return String(s || ''); } };
  const renderPreview = () => { content.classList.remove('editing'); const h = _mdRender(b.text); content.innerHTML = h || ('<div class="pdf-tbox-ph">' + t('พิมพ์ที่นี่…') + '</div>'); };
  renderPreview();
  let saveT = null, crepe = null, creating = false;
  function _onDocDown(e){ if (!el.contains(e.target)) endEdit(); }
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
      const c = new window.Crepe({ root: content, defaultValue: b.text || '', features: feats });
      await c.create();
      crepe = c; el._crepe = c;
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
    if (_pdfTboxEditing === el) _pdfTboxEditing = null;
    if (!crepe) return;
    try { b.text = crepe.getMarkdown(); } catch (_) {}
    try { await crepe.destroy(); } catch (_) {}
    crepe = null; el._crepe = null;
    clearTimeout(saveT); savePdfAnnots();
    renderPreview();
  }
  el._startEdit = startEdit; el._endEdit = endEdit;
  content.addEventListener('mousedown', (ev) => { if (ev.button === 0 && !crepe && !creating) { ev.stopPropagation(); startEdit(); } });

  const del = document.createElement('button'); del.type = 'button';
  del.className = 'pdf-tbox-del'; del.title = t('ลบกล่อง');
  del.innerHTML = icoSvg('x', 'xs');
  del.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.preventDefault(); });
  del.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); removeTbox(b.id); });

  // Background-colour palette (shown on hover/focus). '' swatch = transparent.
  const palette = document.createElement('div'); palette.className = 'pdf-tbox-palette';
  ['#ffffff', '#fff7c0', '#ffe0ea', '#d9ecff', '#dff2df', 'transparent'].forEach((col) => {
    const sw = document.createElement('button'); sw.type = 'button';
    sw.className = 'pdf-tbox-sw' + (col === 'transparent' ? ' none' : '');
    if (col !== 'transparent') sw.style.background = col;
    sw.title = col === 'transparent' ? t('โปร่งใส') : col;
    sw.addEventListener('mousedown', (ev) => { ev.stopPropagation(); ev.preventDefault(); });
    sw.addEventListener('click', (ev) => {
      ev.stopPropagation(); ev.preventDefault();
      b.bg = col; el.style.background = (col === 'transparent' ? 'transparent' : col); savePdfAnnots();
    });
    palette.appendChild(sw);
  });

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

  el.appendChild(head); el.appendChild(content); el.appendChild(del); el.appendChild(palette);
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
