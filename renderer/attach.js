// ============================================================
// IMAGE ATTACH — pick images (current PDF page / images in the open note / file / paste),
// show them as removable chips above the chat input, and hand them to runEngine per message.
// Loaded after chat.js, before renderer.js.
// ============================================================
let __chatImages = [];   // [{ uri (normalized data URI), thumb (small data URI), label }]

// downscale + recompress so a message never carries multi-MB canvases (Anthropic's sweet spot
// is ≤1568px; JPEG 85%). Returns {uri, thumb}.
function normalizeImageUri(uri, maxSide, q){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, (maxSide || 1568) / Math.max(img.width, img.height));
        const draw = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c; };
        const main = draw(img.width * scale, img.height * scale).toDataURL('image/jpeg', q || 0.85);
        const ts = Math.min(1, 200 / Math.max(img.width, img.height));
        const thumb = draw(img.width * ts, img.height * ts).toDataURL('image/jpeg', 0.6);
        resolve({ uri: main, thumb });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('bad image'));
    img.src = uri;
  });
}

async function attachChatImage(uri, label){
  if (__chatImages.length >= 4) { pdfToast(t('แนบได้สูงสุด 4 ภาพต่อข้อความ')); return; }
  try {
    const n = await normalizeImageUri(uri);
    __chatImages.push({ uri: n.uri, thumb: n.thumb, label: label || '' });
    renderAttachBar();
  } catch (_) { pdfToast(t('อ่านรูปนี้ไม่ได้')); }
}
function takeChatImages(){ const out = __chatImages.slice(); __chatImages = []; renderAttachBar(); return out; }
function renderAttachBar(){
  const bar = document.getElementById('attachBar'); if (!bar) return;
  bar.innerHTML = ''; bar.hidden = !__chatImages.length;
  __chatImages.forEach((im, i) => {
    const chip = document.createElement('span'); chip.className = 'athumb';
    const img = document.createElement('img'); img.src = im.thumb; chip.appendChild(img);
    if (im.label) { const tg = document.createElement('span'); tg.className = 'athumb-tag'; tg.textContent = im.label; chip.appendChild(tg); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'athumb-x'; x.textContent = '×'; x.title = t('เอาภาพนี้ออก');
    x.onclick = () => { __chatImages.splice(i, 1); renderAttachBar(); };
    chip.appendChild(x);
    bar.appendChild(chip);
  });
  const btn = document.getElementById('chatAttach');
  if (btn) { const b = btn.querySelector('.att-badge'); if (b) { b.hidden = !__chatImages.length; b.textContent = String(__chatImages.length); } }
}

// images in the open note: legacy inline base64 AND assets/ file refs (loaded back to data
// URIs so the picker thumbnails + the engine attach path keep working after migration)
async function noteImageUris(limit){
  if (!currentNote || typeof getBody !== 'function') return [];
  const out = [];
  const body = getBody();
  const re = /!\[([^\]]*)\]\((data:image\/[a-z+.-]+;base64,[^)\s]+|assets\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(body)) && out.length < (limit || 6)) {
    let uri = m[2];
    if (uri.startsWith('assets/')) {
      try { uri = window.api.readAsset ? await window.api.readAsset(uri) : null; } catch (_) { uri = null; }
      if (!uri) continue;
    }
    out.push({ uri, label: m[1] || t('รูปในโน้ต') });
  }
  return out;
}

function closeAttachMenu(){ const m = document.getElementById('attachMenu'); if (m) m.remove(); document.removeEventListener('mousedown', _attOutside, true); }
function _attOutside(e){ const m = document.getElementById('attachMenu'); if (m && !m.contains(e.target)) closeAttachMenu(); }
async function openAttachMenu(anchor){
  closeAttachMenu();
  const m = document.createElement('div'); m.className = 'db-menu'; m.id = 'attachMenu';
  const mi = (icon, label, small, fn) => {
    const d = document.createElement('div'); d.className = 'db-mi';
    d.innerHTML = icoSvg(icon, 'sm') + '<span></span>' + (small ? '<small class="att-sm"></small>' : '');
    d.querySelector('span').textContent = label;
    if (small) d.querySelector('.att-sm').textContent = small;
    if (fn) d.onclick = fn; else d.classList.add('db-mi-mut');
    m.appendChild(d); return d;
  };
  // 1 · the open PDF's current page
  if (typeof currentPdf === 'string' && currentPdf && typeof pdfDoc !== 'undefined' && pdfDoc) {
    const pg = (typeof pdfCurPage !== 'undefined' && pdfCurPage) ? pdfCurPage : 1;
    mi('book', t('หน้า PDF ที่เปิดอยู่') + ' (' + t('หน้า ') + pg + ')', t('แนบทันที'), async () => {
      closeAttachMenu();
      try {
        const page = await pdfDoc.getPage(pg);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        await attachChatImage(c.toDataURL('image/jpeg', 0.85), 'PDF·' + pg);
      } catch (_) { pdfToast(t('เรนเดอร์หน้า PDF ไม่สำเร็จ')); }
    });
  }
  // 2 · images already in the open note
  const noteImgs = await noteImageUris(6);
  if (noteImgs.length) {
    mi('gallery', t('รูปในโน้ตที่เปิดอยู่'), noteImgs.length + ' ' + t('รูป'), null);
    const row = document.createElement('div'); row.className = 'att-row';
    noteImgs.forEach((im) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'athumb att-pick';
      const img = document.createElement('img'); img.src = im.uri; b.appendChild(img);
      b.onclick = async () => { closeAttachMenu(); await attachChatImage(im.uri, im.label.slice(0, 12)); };
      row.appendChild(b);
    });
    m.appendChild(row);
  }
  // 3 · file picker (paste works directly on the input — ⌘V)
  mi('clip', t('เลือกไฟล์รูป…'), '⌘V ' + t('วางได้'), () => {
    closeAttachMenu();
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = () => {
      [...(inp.files || [])].slice(0, 4).forEach((f) => {
        const r = new FileReader();
        r.onload = () => attachChatImage(String(r.result), f.name.slice(0, 12));
        r.readAsDataURL(f);
      });
    };
    inp.click();
  });
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
  m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  setTimeout(() => document.addEventListener('mousedown', _attOutside, true), 0);
}

// attach button state: dim (but keep clickable for the tooltip) when the configured API model
// can't see images and auto-switch is off. CLI + managed paths can always take images.
function refreshAttachState(){
  const btn = document.getElementById('chatAttach'); if (!btn) return;
  const cfg = window.__aiCfg;
  let off = false, why = '';
  if (cfg && cfg.mode === 'api' && window.AICaps) {
    const can = window.AICaps.modelSupportsVision(cfg.provider, cfg.model);
    const auto = cfg.autoVision !== false && !!window.AICaps.visionModelFor(cfg.provider, cfg.model);
    if (!can && !auto) { off = true; why = t('โมเดล ') + (cfg.model || '?') + t(' มองภาพไม่ได้ — เปิดสลับรุ่นอัตโนมัติหรือเปลี่ยนรุ่นใน ตั้งค่า'); }
  }
  btn.classList.toggle('att-off', off);
  btn.title = off ? why : t('แนบภาพ (หน้า PDF · รูปในโน้ต · ไฟล์ · ⌘V)');
}
async function refreshAiCfgCache(){
  try { window.__aiCfg = await window.api.aiGetConfig(); } catch (_) {}
  refreshAttachState();
  // the chat header's per-tab engine picker mirrors the same config — rebuild its options
  if (typeof resetEngineTabOpts === 'function') { try { resetEngineTabOpts(); } catch (_) {} }
}

(function initAttach(){
  const btn = document.getElementById('chatAttach');
  if (btn) btn.onclick = (e) => { e.preventDefault(); openAttachMenu(btn); };
  const inp = document.getElementById('chatInput');
  if (inp) inp.addEventListener('paste', (e) => {
    const items = [...((e.clipboardData && e.clipboardData.items) || [])].filter((it) => it.type && it.type.indexOf('image/') === 0);
    if (!items.length) return;
    e.preventDefault();
    items.slice(0, 4).forEach((it) => {
      const f = it.getAsFile(); if (!f) return;
      const r = new FileReader();
      r.onload = () => attachChatImage(String(r.result), t('วางรูป'));
      r.readAsDataURL(f);
    });
  });
  refreshAiCfgCache();
})();
