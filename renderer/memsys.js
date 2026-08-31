// ============================================================
// MEMORY LAYER UI — per-vault fact store (KUMIKO-MEMORY.md · CoreMemory) + per-USER global
// profile (KUMIKO-GLOBAL.md). Three surfaces: (1) kumikoMemoryPrompt() — the block injected
// into every chat prompt, (2) the "🧠 จำไว้ไหม?" confirm card for ===REMEMBER===/===FORGET===
// proposals — the type is ALWAYS auto-detected from the text (CoreMemory.detectType; user
// request 2026-08-29: no manual type picking anywhere), (3) the memory desk — a VIEW-ONLY
// browser (indigo hanko) that groups cards by age (ใหม่/ก่อนหน้านี้/นานแล้ว); mutations happen
// only through the confirm chips or by editing the file itself. Saves run through
// CoreMemory.upsertCard, so a near-duplicate REPLACES the old card instead of stacking.
// Loaded after tagsys.js, before renderer.js.
// ============================================================
const MEMORY_FILE = 'KUMIKO-MEMORY.md';

function _memToday(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
async function memReadCards(){
  let s = '';
  try { s = String(await window.api.readNote(MEMORY_FILE) || ''); } catch (_) {}
  return window.CoreMemory ? window.CoreMemory.parse(s, _memToday()) : [];
}
async function memWriteCards(cards){
  await window.api.saveNote(MEMORY_FILE, window.CoreMemory.serialize(cards));
}
// ---- global profile: KUMIKO-GLOBAL.md — per-USER, cross-vault. ผู้ใช้ cards live HERE, not
// in any vault: identity follows the person (desktop: userData; web: per-account on the
// server). Global cards never fade — preferences don't expire the way course facts do.
async function memReadGlobal(){
  let s = '';
  try { s = String(await window.api.readGlobalMemory() || ''); } catch (_) {}
  if (!window.CoreMemory) return [];
  // profile-only file: whatever section a hand edit used, every card here IS a user card
  return window.CoreMemory.parse(s, _memToday()).map((c) => Object.assign({}, c, { type: 'user', g: true }));
}
async function memWriteGlobal(cards){
  await window.api.saveGlobalMemory(window.CoreMemory.serialize((cards || []).map((c) => Object.assign({}, c, { type: 'user' }))));
}
// Save a memory: type auto-detected from the text; ผู้ใช้ → global profile (ทุก vault),
// everything else → this vault's file. upsertCard replaces a near-duplicate (newest wins).
async function memSaveRouted(type, text){
  const tp = window.CoreMemory.normTypeOr(type, text);
  if (tp === 'user') {
    const r = window.CoreMemory.upsertCard(await memReadGlobal(), 'user', text, _memToday());
    if (r.added) await memWriteGlobal(r.cards);
    return { where: 'global', type: tp, replaced: r.replaced };
  }
  const r = window.CoreMemory.upsertCard(await memReadCards(), tp, text, _memToday());
  if (r.added) await memWriteCards(r.cards);
  return { where: 'vault', type: tp, replaced: r.replaced };
}
function _memUse(){ return (typeof vsGet === 'function' && (vsGet('memUse', {}) || {})) || {}; }

// ---- injection: profile always + top-K relevant to THIS question, inside the budget --------
async function kumikoMemoryPrompt(query){
  try {
    if (!window.CoreMemory) return '';
    const [gcards, cards] = await Promise.all([memReadGlobal(), memReadCards()]);
    if (!cards.length && !gcards.length) return '';
    const pb = window.CoreMemory.promptBlock(cards, query || '', { now: Date.now(), profileExtra: gcards });
    if (pb.ids.length && typeof vsSet === 'function') {
      const use = _memUse();
      pb.ids.forEach((id) => { use[id] = (use[id] || 0) + 1; });
      vsSet('memUse', use);
    }
    return pb.text;
  } catch (_) { return ''; }
}
// The AI's side of the contract: how to PROPOSE a memory (or forgetting one). Confirm-gated;
// the system classifies the type (and the global-vs-vault routing) from the text itself.
function kumikoMemoryLearnPrompt(){
  return '\nความจำถาวร: เมื่อพบข้อเท็จจริงที่ควรจำข้ามบทสนทนา (กำหนดสอบ จุดที่อาจารย์เน้น เล่มหลักของวิชา ความชอบของผู้ใช้ สถานะการอ่าน) ให้เสนอด้วยบล็อกนี้ (สั้น 1 บรรทัด ไม่เกิน 2 ข้อต่อคำตอบ):\n' +
    '===REMEMBER===\n(ข้อเท็จจริง)\n' + window.CoreMarkdown.NOTE_CLOSE + '\n' +
    'ระบบจำแนกประเภทจากข้อความเอง — ความชอบ/สไตล์ของผู้ใช้จะติดตัวข้ามทุก vault ส่วนข้อเท็จจริงของวิชาอยู่เฉพาะ vault นี้\n' +
    'ถ้าความจำเดิมผิดหรือหมดอายุ: ===FORGET text=ข้อความบางส่วนของใบนั้น===\n' +
    'ระบบจะถามผู้ใช้ก่อนบันทึก/ลบเสมอ — ห้ามแก้ไฟล์ KUMIKO-MEMORY.md ผ่านช่องทางโน้ต\n';
}

// ---- confirm card (above the chat input, like the KUMIKO-RULE card) ------------------------
async function maybeProposeMemories(text){
  if (!window.CoreMarkdown || !window.CoreMarkdown.extractMemories) return;
  let r;
  try { r = window.CoreMarkdown.extractMemories(text); } catch (_) { return; }
  // type is ALWAYS detected from the text — an AI-supplied type= is parsed but not trusted
  const props = (r.memories || []).map((m) => ({ kind: 'remember', type: window.CoreMemory.detectType(m.text), text: m.text }));
  // cap 3 shown individually; extras merge into one card so nothing is dropped silently
  let items = props.slice(0, 3);
  if (props.length > 3) {
    const restText = props.slice(3).map((p) => p.text).join(' · ');
    items.push({ kind: 'remember', type: window.CoreMemory.detectType(restText), text: restText });
  }
  if ((r.forgets || []).length) {
    const cards = (await memReadGlobal()).concat(await memReadCards());
    r.forgets.slice(0, 3).forEach((q) => {
      const hit = window.CoreMemory.findByText(cards, q);
      if (hit) items.push({ kind: 'forget', type: hit.type, text: hit.text, id: hit.id, g: !!hit.g });
    });
  }
  if (items.length) openMemoryConfirm(items);
}
function _memTypePill(tp){
  const p = document.createElement('span');
  p.className = 'mem-pill mp-' + tp;
  p.textContent = window.CoreMemory.TYPE_TH[tp] + (tp === 'user' ? ' 🌐' : '');
  p.title = tp === 'user' ? t('โปรไฟล์กลาง — ติดตัวทุก vault') : t('จำแนกอัตโนมัติจากข้อความ');
  return p;
}
function openMemoryConfirm(items){
  const old = document.getElementById('memConfirm'); if (old) old.remove();
  const box = document.createElement('div'); box.id = 'memConfirm'; box.className = 'mem-confirm';
  const head = document.createElement('div'); head.className = 'mem-c-head';
  head.textContent = '🧠 ' + t('จำไว้สำหรับ vault นี้ไหม?');
  box.appendChild(head);
  const closeIfEmpty = () => { if (!box.querySelector('.mem-c-row')) box.remove(); };
  items.forEach((it) => {
    const row = document.createElement('div'); row.className = 'mem-c-row';
    const txt = document.createElement('div'); txt.className = 'mem-c-text';
    txt.textContent = (it.kind === 'forget' ? t('ลืม: ') : '') + it.text;
    const acts = document.createElement('div'); acts.className = 'mem-c-acts';
    if (it.kind === 'remember') {
      let pill = _memTypePill(it.type);
      acts.appendChild(pill);
      const ed = document.createElement('button'); ed.type = 'button'; ed.className = 'mem-c-edit'; ed.textContent = t('แก้ก่อนจำ');
      ed.onclick = () => {
        const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'mem-c-inp'; inp.value = it.text;
        txt.replaceWith(inp); inp.focus();
        const commit = () => {
          it.text = inp.value.trim() || it.text;
          it.type = window.CoreMemory.detectType(it.text);   // re-classify the edited text
          const np = _memTypePill(it.type); pill.replaceWith(np); pill = np;
          txt.textContent = it.text; inp.replaceWith(txt);
        };
        inp.onblur = commit;
        inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
      };
      const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'mem-c-save'; ok.textContent = t('จำไว้');
      ok.onclick = async () => {
        ok.disabled = true;
        try {
          const r2 = await memSaveRouted(it.type, it.text);
          if (typeof pdfToast === 'function') {
            const upd = r2.replaced ? t(' (อัปเดตทับใบเดิมที่คล้ายกัน)') : '';
            pdfToast(r2.where === 'global' ? '🌐 ' + t('จำเป็นโปรไฟล์กลางแล้ว (ติดตัวทุก vault)') + upd : '🧠 ' + t('จำเป็น ') + window.CoreMemory.TYPE_TH[r2.type] + t(' แล้ว') + upd);
          }
        } catch (_) {}
        row.remove(); closeIfEmpty();
      };
      const no = document.createElement('button'); no.type = 'button'; no.className = 'mem-c-skip'; no.textContent = t('ไม่ต้อง');
      acts.appendChild(ed); acts.appendChild(no); acts.appendChild(ok);
      no.onclick = () => { row.remove(); closeIfEmpty(); };
    } else {
      const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'mem-c-save mem-c-del'; ok.textContent = t('ลืมได้');
      ok.onclick = async () => {
        ok.disabled = true;
        try {
          if (it.g) await memWriteGlobal(window.CoreMemory.removeCard(await memReadGlobal(), it.id));
          else await memWriteCards(window.CoreMemory.removeCard(await memReadCards(), it.id));
          if (typeof pdfToast === 'function') pdfToast('🧠 ' + t('ลืมแล้ว'));
        } catch (_) {}
        row.remove(); closeIfEmpty();
      };
      const no = document.createElement('button'); no.type = 'button'; no.className = 'mem-c-skip'; no.textContent = t('เก็บไว้');
      no.onclick = () => { row.remove(); closeIfEmpty(); };
      acts.appendChild(no); acts.appendChild(ok);
    }
    row.appendChild(txt); row.appendChild(acts);
    box.appendChild(row);
  });
  const wrapEl = document.querySelector('.chat-input-wrap');
  if (wrapEl && wrapEl.parentElement) wrapEl.parentElement.insertBefore(box, wrapEl);
  else document.body.appendChild(box);
}

// ---- memory desk (modal, VIEW-ONLY) --------------------------------------------------------
// A browser, not an editor: cards are grouped by the organize() pass (global profile · ใหม่ ·
// ก่อนหน้านี้ · นานแล้ว). Changing memory happens through the confirm chips (REMEMBER/FORGET)
// or by opening the raw file — the "เปิดไฟล์" doorway.
function closeMemoryDesk(){ const o = document.getElementById('memDeskOverlay'); if (o) o.remove(); }
async function openMemoryDesk(){
  closeMemoryDesk();
  const overlay = document.createElement('div'); overlay.id = 'memDeskOverlay'; overlay.className = 'modal-backdrop';
  overlay.onmousedown = (e) => { if (e.target === overlay) closeMemoryDesk(); };
  const card = document.createElement('div'); card.className = 'mem-desk';
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  await renderMemoryDesk(card);
}
function _memLastQuery(){
  try {
    const s = (typeof activeSession === 'function') ? activeSession() : null;
    const m = ((s && s.messages) || []).filter((x) => x.role === 'user').pop();
    return (m && m.text) || '';
  } catch (_) { return ''; }
}
async function renderMemoryDesk(card){
  const gcards = await memReadGlobal();     // ผู้ใช้ profile — cross-vault, never fades
  const vcards = await memReadCards();      // this vault's facts
  const cards = gcards.concat(vcards);
  const use = _memUse();
  const now = Date.now();
  const filter = card.dataset.filter || 'all';
  card.innerHTML = '';
  // header
  const head = document.createElement('div'); head.className = 'mem-head';
  const hanko = document.createElement('div'); hanko.className = 'mem-hanko'; hanko.textContent = '🧠';
  const ht = document.createElement('div');
  let vault = ''; try { vault = (document.getElementById('vaultChip') || {}).textContent || ''; } catch (_) {}
  ht.innerHTML = '<div class="mem-title"></div><div class="mem-sub"></div>';
  ht.querySelector('.mem-title').textContent = t('ความจำของ ') + (vault.trim() || 'vault ' + t('นี้'));
  const latest = cards.map((c) => c.ts).filter(Boolean).sort().pop();
  ht.querySelector('.mem-sub').textContent = cards.length + ' ' + t('ใบ') + ' (' + t('โปรไฟล์กลาง ') + gcards.length + ' · vault ' + vcards.length + ')' + (latest ? ' · ' + t('ใบล่าสุด ') + latest : '');
  const openFile = document.createElement('button'); openFile.className = 'mem-open-file'; openFile.textContent = t('เปิดไฟล์');
  openFile.title = t('เปิด ') + MEMORY_FILE + t(' เพื่อแก้/ลบด้วยมือ');
  openFile.onclick = async () => { closeMemoryDesk(); try { await openNote(MEMORY_FILE); } catch (_) {} };
  const x = document.createElement('button'); x.className = 'mem-x'; x.textContent = '✕'; x.onclick = closeMemoryDesk;
  head.appendChild(hanko); head.appendChild(ht); head.appendChild(openFile); head.appendChild(x);
  card.appendChild(head);
  // meter — what THIS question's injection would cost (sample = last user message)
  const pb = window.CoreMemory.promptBlock(vcards, _memLastQuery(), { now, profileExtra: gcards });
  const meter = document.createElement('div'); meter.className = 'mem-meter';
  const pct = Math.min(100, Math.round((pb.sel.chars / window.CoreMemory.BUDGET) * 100));
  meter.innerHTML = '<div class="mem-meter-bar"><div class="mem-meter-fill"></div></div><div class="mem-meter-lbl"><span></span><span></span></div>';
  meter.querySelector('.mem-meter-fill').style.width = pct + '%';
  meter.querySelector('.mem-meter-lbl span').textContent = t('ที่จะถูกฉีดต่อคำถาม ~') + pb.sel.chars.toLocaleString() + ' / ' + window.CoreMemory.BUDGET.toLocaleString() + ' ' + t('ตัวอักษร');
  meter.querySelectorAll('.mem-meter-lbl span')[1].textContent = t('โปรไฟล์ ') + pb.sel.profile.length + ' + ' + t('คัดตามคำถาม ≤') + window.CoreMemory.MAX_RELEVANT;
  card.appendChild(meter);
  // filters (read-only browsing aid) + injection preview
  const counts = { all: cards.length };
  window.CoreMemory.TYPES.forEach((tp) => { counts[tp] = cards.filter((c) => c.type === tp).length; });
  const frow = document.createElement('div'); frow.className = 'mem-filters';
  [['all', t('ทั้งหมด')]].concat(window.CoreMemory.TYPES.map((tp) => [tp, window.CoreMemory.TYPE_TH[tp]])).forEach(([val, label]) => {
    const f = document.createElement('button'); f.className = 'mem-fchip' + (filter === val ? ' on' : '');
    f.textContent = label + ' ' + (counts[val] || 0);
    f.onclick = () => { card.dataset.filter = val; renderMemoryDesk(card); };
    frow.appendChild(f);
  });
  const injBtn = document.createElement('button'); injBtn.className = 'mem-fchip mem-inj-btn'; injBtn.textContent = t('ดูที่ฉีด');
  frow.appendChild(injBtn);
  card.appendChild(frow);
  const injBox = document.createElement('pre'); injBox.className = 'mem-inj'; injBox.hidden = true;
  injBox.textContent = pb.text ? pb.text.trim() : t('(ยังไม่มีใบที่จะถูกฉีดสำหรับคำถามล่าสุด)');
  injBtn.onclick = () => { injBox.hidden = !injBox.hidden; injBtn.classList.toggle('on', !injBox.hidden); };
  card.appendChild(injBox);
  // grouped card list (view-only)
  const groups = window.CoreMemory.organize(cards, now);
  const list = document.createElement('div'); list.className = 'mem-list';
  const renderCard = (c, opts2) => {
    const row = document.createElement('div'); row.className = 'mem-card' + (opts2 && opts2.faded ? ' faded' : '');
    const pill = document.createElement('span'); pill.className = 'mem-pill mp-' + c.type;
    pill.textContent = window.CoreMemory.TYPE_TH[c.type];
    const body = document.createElement('div'); body.className = 'mem-body';
    const txt = document.createElement('div'); txt.className = 'mem-text'; txt.textContent = c.text;
    const meta = document.createElement('div'); meta.className = 'mem-meta';
    const bits = [];
    if (c.ts) bits.push(c.ts);
    if (c.g) bits.push('🌐 ' + t('โปรไฟล์กลาง — ติดตัวทุก vault · ฉีดทุกคำถาม'));
    else if (c.type === 'user') bits.push(t('โปรไฟล์ (เฉพาะ vault นี้) — ฉีดทุกคำถาม'));
    if (use[c.id]) bits.push(t('ถูกใช้ ') + use[c.id] + ' ' + t('ครั้ง'));
    meta.textContent = bits.join(' · ');
    body.appendChild(txt); body.appendChild(meta);
    row.appendChild(pill); row.appendChild(body);
    return row;
  };
  const section = (label, items, opts2) => {
    const match = items.filter((c) => filter === 'all' || c.type === filter);
    if (!match.length) return;
    const h = document.createElement('div'); h.className = 'mem-ghead'; h.textContent = label + ' · ' + match.length;
    list.appendChild(h);
    match.forEach((c) => list.appendChild(renderCard(c, opts2)));
  };
  section('🌐 ' + t('โปรไฟล์กลาง (ทุก vault)'), groups.global);
  section('✨ ' + t('ใหม่ — ') + window.CoreMemory.FRESH_DAYS + ' ' + t('วันล่าสุด'), groups.fresh);
  section('📚 ' + t('ก่อนหน้านี้'), groups.recent);
  section('⏳ ' + t('นานแล้ว (เกิน ') + window.CoreMemory.FADE_DAYS + ' ' + t('วัน) — ไม่ถูกฉีดแล้ว'), groups.old, { faded: true });
  if (!list.children.length) {
    const e = document.createElement('div'); e.className = 'mem-empty';
    e.textContent = t('ยังไม่มีความจำ — คุยกับ AI แล้วกด "จำไว้" เมื่อระบบเสนอ หรือพิมพ์บอกให้จำได้เลย');
    list.appendChild(e);
  }
  card.appendChild(list);
  const hint = document.createElement('div'); hint.className = 'mem-hint';
  hint.textContent = t('หน้านี้เรียกดูอย่างเดียว — เพิ่ม/แก้/ลบผ่านการ์ดยืนยันในแชต (REMEMBER/FORGET) หรือปุ่ม "เปิดไฟล์" · ประเภทถูกจำแนกอัตโนมัติ · ใบที่คล้ายใบเดิมจะแทนที่กันเอง');
  card.appendChild(hint);
}
