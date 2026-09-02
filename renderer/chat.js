// ---------- AI Chat: multi-session (paper tabs) ----------
function stripAnsi(s){ return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, ''); }
function cleanChatText(s){
  return stripAnsi(s)
    .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
    .replace(/^\s*>\s*build\b.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}
// STICKY scroll: follow the stream only while the user is already at (near) the bottom.
// Scrolling up to read history "unsticks" it — streaming tokens no longer yank the view back
// down (log 2026-08-24). Sending a message or switching sessions forces a stick again.
function chatScroll(force){
  const m = document.getElementById('chatMessages'); if (!m) return;
  if (!force && !window.__chatStick) return;
  m.scrollTop = m.scrollHeight;
}
(function watchChatScroll(){
  window.__chatStick = true;
  const m = document.getElementById('chatMessages'); if (!m) return;
  m.addEventListener('scroll', () => {
    window.__chatStick = (m.scrollHeight - m.scrollTop - m.clientHeight) < 60;
  }, { passive: true });
})();
// What the user SEES for an AI reply: the note-update block is the payload for the review card,
// not conversation, so strip it out of the bubble (keeps the AI's short remark around it).
// While a note block is still STREAMING (opened, not yet closed) the raw protocol + note body
// used to scroll by in the bubble, and the note only appears when the stream ends — which read
// as "GLM answered but the note failed" (log 2026-08-24). Collapse the open block into a live
// progress line instead.
function _openBlockProgress(s){
  const re = /^[ \t]*===(NEW-NOTE|UPDATED-NOTE|UPDATED-SECTION)((?:[^=\n]|=(?!==))*)===[ \t]*$/gm;
  let m, last = null;
  while ((m = re.exec(s))) last = m;
  if (!last) return null;
  const after = s.slice(last.index);
  if (/===END-NOTE===/.test(after)) return null;              // block already closed
  const nm = (last[2].match(/name=([^=]+?)(?: heading=|$)/) || [])[1]
    || (last[2].match(/heading=(.+)$/) || [])[1] || '';
  return {
    before: s.slice(0, last.index),
    line: '\n\n*✍️ ' + (last[1] === 'NEW-NOTE' ? t('กำลังเขียนโน้ตใหม่') : t('กำลังเขียนการแก้โน้ต')) +
      (nm ? ' "' + nm.trim() + '"' : '') + ' — ' + after.length + ' ' + t('ตัวอักษร') + '… ' + t('(จะสร้าง/แก้จริงเมื่อเขียนจบ)') + '*',
  };
}
function chatDisplayText(s, streaming){
  if (streaming) {
    const ob = _openBlockProgress(s);
    if (ob) return chatDisplayText(ob.before, false) + ob.line;
  }
  let createdLine = '';
  try {
    const ac = window.CoreMarkdown && window.CoreMarkdown.extractActions && window.CoreMarkdown.extractActions(s);
    if (ac && ac.any) {
      s = ac.chat;
      const bits = [];
      if (ac.reads.length) bits.push('🔎 ' + t('อ่าน') + ': ' + ac.reads.join(', '));
      if (ac.searches.length) bits.push('🔎 ' + t('ค้นหา') + ': ' + ac.searches.join(', '));
      if (ac.renames.length) bits.push('✏️ ' + t('เปลี่ยนชื่อ') + ': ' + ac.renames.map((x) => x.from + ' → ' + x.to).join(', '));
      if (ac.deletes.length) bits.push('🗑 ' + t('ขอลบ') + ': ' + ac.deletes.join(', '));
      if (ac.targets.length) bits.push('🎯 ' + t('โน้ตเป้าหมาย') + ': ' + ac.targets.join(', '));
      if (ac.listTags) bits.push('🏷 ' + t('ดูแท็กทั้งหมด'));
      if ((ac.notesByTag || []).length) bits.push('🏷 ' + t('หาโน้ตตามแท็ก') + ': ' + ac.notesByTag.join(' | '));
      const tw = [].concat(ac.addTags || [], ac.setTags || [], ac.removeTags || []);
      if (tw.length) bits.push('🏷 ' + t('แก้แท็ก') + ': ' + tw.map((x) => x.name + (x.tags ? ' → ' + x.tags : '')).join(', '));
      if ((ac.renameTags || []).length) bits.push('🏷 ' + t('เปลี่ยนชื่อแท็ก') + ': ' + ac.renameTags.map((x) => '#' + x.from + (x.to ? ' → #' + x.to : ' (เอาออก)')).join(', '));
      createdLine += '\n\n*' + bits.join(' · ') + '*';
    }
  } catch (_) {}
  try {
    const kr = window.CoreMarkdown && window.CoreMarkdown.extractKumikoRules && window.CoreMarkdown.extractKumikoRules(s);
    if (kr && kr.rules.length) { s = kr.chat; createdLine += '\n\n*💡 ' + t('เสนอกติกาใหม่ — ยืนยันที่การ์ดด้านล่าง') + '*'; }
  } catch (_) {}
  try {
    const mm = window.CoreMarkdown && window.CoreMarkdown.extractMemories && window.CoreMarkdown.extractMemories(s);
    if (mm && (mm.memories.length || mm.forgets.length)) { s = mm.chat; createdLine += '\n\n*🧠 ' + t('เสนอความจำ — ยืนยันที่การ์ดด้านล่าง') + '*'; }
  } catch (_) {}
  try {
    const su = window.CoreMarkdown && window.CoreMarkdown.extractSectionUpdates && window.CoreMarkdown.extractSectionUpdates(s);
    if (su && su.sections.length) { s = su.chat; createdLine += '\n\n*✂️ ' + t('แก้หัวข้อ') + ': ' + su.sections.map((x) => x.heading).join(', ') + '*'; }
  } catch (_) {}
  try {
    const nn = window.CoreMarkdown && window.CoreMarkdown.extractNewNotes && window.CoreMarkdown.extractNewNotes(s);
    // base names (no folder path) so linkifyRefs turns them into clickable note links —
    // the reader can jump straight from this line to the review (user request 2026-09-02)
    if (nn && nn.notes.length) { s = nn.chat; createdLine += '\n\n*🆕 ' + t('สร้างโน้ตใหม่') + ': ' + nn.notes.map((x) => String(x.name || '').split('/').pop()).join(', ') + '*'; }
  } catch (_) {}
  try {
    const r = window.CoreMarkdown && window.CoreMarkdown.extractNoteUpdate && window.CoreMarkdown.extractNoteUpdate(s);
    if (r && r.body) {
      const head = r.chat || t('แก้โน้ตให้แล้ว — ตรวจการเปลี่ยนแปลงทางซ้าย');
      // While the note body streams there is nothing to show — hiding it silently froze the
      // bubble on one short line for the whole (possibly long) write, which reads as "the AI
      // worked for ages then died". Show live progress instead.
      if (streaming) return head + createdLine + '\n\n*✍️ ' + t('กำลังเขียนโน้ตใหม่') + ' — ' + r.body.length + ' ' + t('ตัวอักษร') + '…*';
      return head + createdLine;
    }
  } catch (_) {}
  // hide ===PDF-CLIP=== command lines; show a human line for what was pasted
  try {
    const c = window.CoreMarkdown && window.CoreMarkdown.extractPdfClips && window.CoreMarkdown.extractPdfClips(s);
    if (c && c.pages.length) return (c.chat ? c.chat + '\n\n' : '') + '*🖼 ' + t('แปะสไลด์หน้า') + ' ' + c.pages.join(', ') + ' ' + t('เข้าโน้ตเป้าหมาย') + '*' + createdLine;
  } catch (_) {}
  return s + createdLine;
}

// clickable @[Name] / [source: Name] references (see CoreMarkdown.linkifyRefs)
const _linkify = (h) => (window.CoreMarkdown && window.CoreMarkdown.linkifyRefs) ? window.CoreMarkdown.linkifyRefs(h, window.__wlNoteNames || []) : h;

const SESSION_ICONS = ['note','task','graph','sparkle','pencil','dash','db','star'];
const SCOPE_LABEL = { note: 'อ้างอิงโน้ตนี้', vault: 'ทั้ง vault', free: 'อิสระ' };
const GLM_MODELS = ['glm-5.2','glm-5.1','glm-5-turbo','glm-4.7','glm-4.5-air'];
let sessions = [];
let activeId = null;
let liveBubble = null;     // ai bubble DOM element of the active session's running turn (else null)

function persistSessions(){
  try {
    const slim = sessions.map((s) => ({ id: s.id, name: s.name, icon: s.icon, engine: s.engine, model: s.model, scope: s.scope,
      messages: s.messages.map((m) => ({ role: m.role, text: m.text, thumbs: m.thumbs })) }));
    vsSet('aiSessions', { sessions: slim, activeId });
  } catch (_) {}
}
function newSession(opts){
  const id = 's' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  return Object.assign({ id, name: 'แชตใหม่', icon: 'note', engine: currentEngine, model: currentModel, scope: 'free', messages: [], running: false }, opts || {});
}
function loadSessions(){
  let saved = vsGet('aiSessions', null);
  if (saved && Array.isArray(saved.sessions) && saved.sessions.length) {
    sessions = saved.sessions.map((s) => ({ id: s.id, name: s.name, icon: (s.icon && /^[a-z-]+$/.test(s.icon)) ? s.icon : 'note', engine: s.engine || 'glm',
      model: s.model || 'glm-5.2', scope: s.scope || 'free', running: false,
      // repair legacy empty AI bubbles (pre-fix saves) into a visible failure line
      messages: Array.isArray(s.messages) ? s.messages.map((m) => ({ role: m.role,
        text: (m.role === 'ai' && !(m.text || '').trim()) ? t('⚠ engine ไม่ตอบกลับ (คำตอบว่าง) — ลองส่งข้อความเดิมอีกครั้ง') : m.text })) : [] }));
    activeId = (saved.activeId && sessions.some((s) => s.id === saved.activeId)) ? saved.activeId : sessions[0].id;
  } else {
    sessions = [
      newSession({ name: 'เนื้อหา', icon: 'note', scope: 'note', engine: 'glm', model: 'glm-5.2',
        messages: [{ role: 'ai', text: 'ถามเรื่องเนื้อหาในโน้ตได้เลย ผมอ้างอิงโน้ตที่เปิดอยู่' }] }),
      newSession({ name: 'งาน', icon: 'task', scope: 'free', engine: 'glm', model: 'glm-5.2',
        messages: [{ role: 'ai', text: 'วางแผน / สั่งงาน task ได้ที่นี่' }] }),
    ];
    activeId = sessions[0].id;
  }
}
function sessionById(id){ return sessions.find((s) => s.id === id) || null; }
function activeSession(){ return sessionById(activeId) || sessions[0]; }
function isRunning(id){ const s = sessionById(id); return !!(s && s.running); }
function syncEngineFromSession(){
  const s = activeSession(); if (!s) return;
  currentEngine = s.engine; currentModel = s.model;
  localStorage.setItem('engine', currentEngine); localStorage.setItem('glmModel', currentModel);
  if (typeof applyEngineUI === 'function') applyEngineUI();
}

function renderTabs(){
  const bar = document.getElementById('sessionTabs'); if (!bar) return;
  bar.innerHTML = '';
  sessions.forEach((s) => {
    const tab = document.createElement('div');
    tab.className = 'stab' + (s.id === activeId ? ' active' : '') + (s.engine === 'glm' ? ' g' : ' c');
    const ic = document.createElement('span'); ic.className = 'ico'; ic.innerHTML = icoSvg(s.icon || 'note', 'sm');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = s.name;
    const eng = document.createElement('span'); eng.className = 'eng'; eng.textContent = s.engine === 'glm' ? 'GLM' : 'Claude';
    tab.appendChild(ic); tab.appendChild(nm); tab.appendChild(eng);
    if (s.running) { const d = document.createElement('span'); d.className = 'rundot'; tab.appendChild(d); }
    const x = document.createElement('span'); x.className = 'stab-x'; x.title = t('ปิดแท็บ'); x.innerHTML = '&times;';
    x.onclick = (e) => { e.stopPropagation(); deleteSession(s); };
    tab.appendChild(x);
    tab.onclick = () => switchSession(s.id);
    bar.appendChild(tab);
  });
  const add = document.createElement('div'); add.className = 'stab add'; add.textContent = '＋'; add.title = t('session ใหม่');
  add.onclick = addSession;
  bar.appendChild(add);
  if (typeof updateSendButton === 'function') updateSendButton();
}
function renderHead(){
  const head = document.getElementById('sessionHead'); if (!head) return;
  const s = activeSession(); head.innerHTML = '';
  const nm = document.createElement('span'); nm.className = 'sh-nm'; nm.innerHTML = icoSvg(s.icon || 'note', 'sm'); nm.appendChild(document.createTextNode(' ' + s.name));
  head.appendChild(nm);
  // Scope dropdown removed — context is now injected automatically by PRIORITY
  // (open note first, then RAG-related notes). See buildPriorityContext in renderer.js.
  const sp = document.createElement('span'); sp.className = 'sh-sp'; head.appendChild(sp);
  const eng = document.createElement('select'); eng.className = 'sh-eng'; eng.title = 'engine';
  [['glm','GLM'],['claude','Claude']].forEach(([v,l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (s.engine === v) o.selected = true; eng.appendChild(o); });
  const mdl = document.createElement('select'); mdl.className = 'sh-mdl'; mdl.title = 'model';
  GLM_MODELS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (s.model === v) o.selected = true; mdl.appendChild(o); });
  mdl.hidden = s.engine !== 'glm';
  eng.onchange = () => { s.engine = eng.value; mdl.hidden = s.engine !== 'glm'; syncEngineFromSession(); persistSessions(); renderTabs(); };
  mdl.onchange = () => { s.model = mdl.value; syncEngineFromSession(); persistSessions(); };
  head.appendChild(eng); head.appendChild(mdl);
  const mem = document.createElement('button'); mem.className = 'sh-mem'; mem.textContent = '🧠'; mem.title = t('ความจำของ vault นี้ (KUMIKO-MEMORY.md)');
  mem.onclick = (e) => { e.stopPropagation(); if (typeof openMemoryDesk === 'function') openMemoryDesk(); };
  head.appendChild(mem);
  const dots = document.createElement('button'); dots.className = 'sh-dots'; dots.textContent = '⋯'; dots.title = t('จัดการ session');
  dots.onclick = (e) => { e.stopPropagation(); openSessionMenu(dots, s); };
  head.appendChild(dots);
}
function renderChat(){
  const box = document.getElementById('chatMessages'); if (!box) return;
  const keep = window.__chatStick ? null : box.scrollTop;   // full re-render must not move an unstuck reader
  const s = activeSession(); box.innerHTML = ''; liveBubble = null;
  s.messages.forEach((m, i) => {
    const wrap = document.createElement('div'); wrap.className = 'm-wrap ' + m.role;
    if (m.role === 'ai') { const who = document.createElement('div'); who.className = 'who'; who.textContent = s.engine === 'glm' ? 'GLM' : 'Claude';
      if (m.visionModel) { const vb = document.createElement('span'); vb.className = 'who-vision'; vb.textContent = '👁 ' + m.visionModel; vb.title = t('ข้อความนี้มีภาพ — ส่งด้วยรุ่น vision'); who.appendChild(vb); }
      wrap.appendChild(who); }
    // (No source pills: the reference row was removed on request. `m.sources` is still recorded
    // on the message — the retrieval side returns it and the reasons are useful for diagnosing
    // what RAG pulled in — it just isn't rendered.)
    const b = document.createElement('div'); b.className = 'm ' + m.role;
    const running = s.running && i === s.messages.length - 1 && m.role === 'ai';
    if (running && !m.text) { buildWaitInto(b, m); liveBubble = b; }
    else if (m.role === 'ai') {
      b.innerHTML = thinkBlockHtml(m, running && !m.text) + _linkify(mdToHtml(chatDisplayText(m.text, running)));
      // user-stopped reply — "ลมหยุดพัด": the marker is the kazaguruma itself, still and
      // muted. Empty ones become a whisper bubble (dashed, transparent) with the BIG pinwheel
      // that was just spinning; it decelerates to a stop once (kaza-stopping) right after the
      // press, then stays frozen. Mid-text stops get the tiny still pinwheel under the text.
      if (m.stopped) {
        const emptyStop = !(m.text || '').trim();
        if (emptyStop) b.classList.add('m-stop-empty');
        const st = document.createElement('div'); st.className = 'm-stop' + (emptyStop ? ' m-stop-big' : '');
        // a toy pinwheel AT REST: masked head on a planted stick (the stick is the tell that
        // the wind is gone — user-picked design, mock 2026-08-29)
        const stick = document.createElement('span'); stick.className = 'kaza-stick' + (emptyStop ? ' lg' : ' sm');
        const kz = document.createElement('span');
        kz.className = 'spin-kaza kaza-stopped' + (emptyStop ? ' lg' : ' sm');
        if (m._justStopped) { kz.classList.add('kaza-stopping'); delete m._justStopped; }
        stick.appendChild(kz);
        st.appendChild(stick);
        const tx = document.createElement('span'); tx.className = 'm-stop-txt';
        tx.textContent = t(emptyStop ? 'หยุดการตอบแล้ว' : 'หยุดโดยคุณ — ตอบไม่จบ');
        st.appendChild(tx);
        b.appendChild(st);
      }
      if (running) liveBubble = b;
    }
    else if (window.CoreMarkdown && window.CoreMarkdown._mdEsc) { b.innerHTML = _linkify(window.CoreMarkdown._mdEsc(m.text)); }
    else { b.textContent = m.text; }
    if (m.role === 'user' && m.thumbs && m.thumbs.length) {
      const ir = document.createElement('div'); ir.className = 'm-imgs';
      m.thumbs.forEach((u) => { const im = document.createElement('img'); im.src = u; ir.appendChild(im); });
      b.insertBefore(ir, b.firstChild);
    }
    wrap.appendChild(b);
    // When the AI edited the note, the review card opens by itself (see maybeAutoReviewReply) —
    // no apply button to press. The bubble shows only its remark; the note body it emitted is
    // stripped by chatDisplayText() so the chat isn't a wall of duplicated note text.
    box.appendChild(wrap);
  });
  if (keep != null) box.scrollTop = keep; else chatScroll(true);
  if (typeof updateSendButton === 'function') updateSendButton();
}
function renderSessions(){ renderTabs(); renderHead(); renderChat(); }
function switchSession(id){ if (id === activeId) return; activeId = id; window.__chatStick = true; syncEngineFromSession(); persistSessions(); renderSessions(); if (typeof updateSendButton === 'function') updateSendButton(); }
function addSession(){
  const s = newSession({ name: 'แชตใหม่', icon: SESSION_ICONS[sessions.length % SESSION_ICONS.length] });
  sessions.push(s); activeId = s.id; syncEngineFromSession(); persistSessions(); renderSessions();
  setTimeout(() => startRename(s), 0);
}
function deleteSession(s){
  const i = sessions.findIndex((x) => x.id === s.id); if (i < 0) return;
  sessions.splice(i, 1);
  if (!sessions.length) { sessions.push(newSession({ name: 'แชต', icon: 'note' })); }
  if (activeId === s.id) activeId = sessions[Math.max(0, i - 1)].id;
  syncEngineFromSession(); persistSessions(); renderSessions();
}
function startRename(s){
  const head = document.getElementById('sessionHead'); if (!head) return;
  const nmEl = head.querySelector('.sh-nm'); if (!nmEl) return;
  const inp = document.createElement('input'); inp.className = 'sh-rename'; inp.value = s.name;
  nmEl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; const v = inp.value.trim(); if (v) s.name = v; persistSessions(); renderSessions(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { done = true; renderSessions(); } });
  inp.addEventListener('blur', commit);
}
function closeSessionMenu(){ const m = document.getElementById('shMenu'); if (m) m.remove(); }
function openSessionMenu(anchor, s){
  closeSessionMenu();
  const menu = document.createElement('div'); menu.className = 'sh-menu'; menu.id = 'shMenu';
  const items = [ [t('เปลี่ยนชื่อ'), () => startRename(s)], [t('ล้างแชต'), () => { s.messages = []; persistSessions(); renderChat(); }] ];
  if (sessions.length > 1) items.push([t('ลบ session'), () => deleteSession(s)]);
  items.forEach(([label, fn]) => { const it = document.createElement('div'); it.className = 'sh-mi'; it.textContent = label; it.onclick = () => { closeSessionMenu(); fn(); }; menu.appendChild(it); });
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = Math.max(8, r.right - 150) + 'px';
  setTimeout(() => document.addEventListener('mousedown', closeSessionMenu, { once: true }), 0);
}

// pushes a user turn + empty ai turn into the ACTIVE session, marks it running; returns its id (= runId)
function beginAiTurn(userText, sources, images){
  window.__chatStick = true;   // sending = the user wants to see the reply
  const s = activeSession();
  const um = { role: 'user', text: userText };
  if (images && images.length) um.thumbs = images.map((im) => im.thumb);   // small previews persist; full images do not
  s.messages.push(um);
  s.messages.push({ role: 'ai', text: '', _acc: '', sources: Array.isArray(sources) ? sources : [] });
  s.running = true;
  persistSessions(); renderSessions();
  return s.id;
}
function buildSessionPrompt(s, msg){
  let ctx = '';
  if (s.scope === 'note' && currentNote) {
    let body = '';
    try { body = (typeof getFullMarkdown === 'function') ? getFullMarkdown() : ''; } catch (_) {}
    ctx = 'บริบท — โน้ต "' + currentNote + '":\n---\n' + body + '\n---\n\n';
  } else if (s.scope === 'vault') {
    const names = Array.from(document.querySelectorAll('#noteList .note-item')).map((n) => n.textContent.trim()).filter(Boolean);
    if (names.length) ctx = 'รายชื่อโน้ตทั้งหมด: ' + names.join(', ') + '\n\n';
  }
  const prior = s.messages.slice(-10).map((m) => (m.role === 'user' ? 'ผู้ใช้: ' : 'ผู้ช่วย: ') + m.text).join('\n');
  return ctx + (prior ? prior + '\n' : '') + 'ผู้ใช้: ' + msg;
}

// engine output → route to the session named by runId (multiple may run concurrently)
window.api.onEngineOutput((payload) => {
  const runId = payload && payload.runId;
  const data = (payload && payload.data) || '';
  if (!runId) return;
  const s = sessionById(runId); if (!s) return;
  const last = s.messages[s.messages.length - 1]; if (!last || last.role !== 'ai') return;
  // reasoning (GLM reasoning_content / Claude thinking) is shown as a collapsible block and
  // kept OUT of the answer text — it used to be concatenated into the reply (2026-08-22)
  if (payload.kind === 'vision-model') { last.visionModel = data; return; }
  if (payload.kind === 'reasoning') {
    // keep the TAIL — a heavy job thinks 50k+ chars, and the 💭 chip is more useful showing
    // where the thinking ENDED (conclusions) than where it began (was slice(0,6000))
    last.think = ((last.think || '') + stripAnsi(data)).slice(-6000);
    if (runId === activeId && liveBubble) { renderLive(last, true); chatScroll(); }
    return;
  }
  last._acc = (last._acc || '') + stripAnsi(data);
  const shown = cleanChatText(last._acc).trim();
  if (shown) { last.text = shown; if (runId === activeId && liveBubble) { renderLive(last, true); chatScroll(); } }
});
// live bubble while WAITING/THINKING: a frameless large pinwheel + the model's thinking flowing
// as ghost text (no box). The spinner node is built ONCE and only the text updates afterwards —
// rewriting innerHTML per token restarted the CSS animation on every chunk, which read as a
// stuttering "refresh" instead of a spin (log 2026-08-25). Once answer text arrives the normal
// bubble takes over (thinking collapses to the 💭 chip).
function buildWaitInto(el, m){
  el.classList.add('m-wait');
  // design A + proof-of-work (2026-09-02): pinwheel + label + an ELAPSED CLOCK — a real
  // 3-chapter diagram job thinks silently for ~4:24, and without visible life the user
  // stopped it at 95% believing it hung. No thinking text here (user: "ไม่ต้องแสดง word") —
  // the reasoning stays in the collapsed 💭 chip. Spinner node still built ONCE (rebuilding
  // restarts the CSS spin); only the clock text updates after.
  if (!el.querySelector('.wait-spin')) {
    el.innerHTML = '<div class="wait-spin"><i class="spin-kaza lg"></i><span class="wait-lbl"></span><span class="wait-clock"></span></div>';
    el.querySelector('.wait-lbl').textContent = t('กำลังคิด…');
    if (!m._t0) m._t0 = Date.now();
    // heartbeat so the clock ticks even while the stream is silent; self-clears once the
    // bubble leaves the waiting state or is replaced by a re-render
    const iv = setInterval(() => {
      if (!document.contains(el) || !el.classList.contains('m-wait')) { clearInterval(iv); return; }
      _waitClockRefresh(el, m);
    }, 1000);
  }
  _waitClockRefresh(el, m);
}
function _waitClockRefresh(el, m){
  const c = el.querySelector('.wait-clock'); if (!c) return;
  const sec = Math.max(0, Math.round((Date.now() - (m._t0 || Date.now())) / 1000));
  c.textContent = sec >= 5 ? (Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0')) : '';
}
function renderLive(m, running){
  if (!liveBubble) return;
  const txt = (m.text && !/^⚠/.test(m.text)) ? _linkify(mdToHtml(chatDisplayText(m.text, running))) : (m.text ? '' : '');
  if (!txt && !m.text) { buildWaitInto(liveBubble, m); return; }
  liveBubble.classList.remove('m-wait');
  liveBubble.innerHTML = thinkBlockHtml(m, false) + txt;
}
function thinkBlockHtml(m, open){
  if (!m.think) return '';
  const d = document.createElement('details'); d.className = 'm-think'; if (open) d.open = true;
  const sm = document.createElement('summary'); sm.textContent = '💭 ' + t('ความคิด'); d.appendChild(sm);
  const pre = document.createElement('div'); pre.className = 'm-think-body'; pre.textContent = m.think.trim(); d.appendChild(pre);
  return d.outerHTML;
}
window.api.onEngineDone(async (payload) => {
  const runId = payload && payload.runId; if (!runId) return;
  const s = sessionById(runId); if (!s) return;
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === 'ai') {
    const shown = cleanChatText(last._acc || '').trim();
    // an empty reply used to persist as a BLANK bubble — the user couldn't tell the engine
    // failed and had to guess (log: msg 72, 2026-08-18). Say it failed, loudly — EXCEPT when
    // the user pressed stop themselves: that's deliberate, so render a calm "หยุดแล้ว" state
    // (partial text kept, no warning) instead of an error that says "try again".
    const failed = payload && payload.code != null && payload.code !== 0;
    const stopped = failed && payload.code === 130 && s._stopReq && (Date.now() - s._stopReq < 120000);
    delete s._stopReq;
    if (stopped) { last.stopped = true; last.text = shown; last._justStopped = true; }   // one-shot "ลมหยุด" decel on next render
    else last.text = shown || t('⚠ engine ไม่ตอบกลับ (คำตอบว่าง') + (failed ? t(' · exit ') + payload.code : '') + t(') — ลองส่งข้อความเดิมอีกครั้ง');
    delete last._acc; delete last._t0;
    // stream died mid note-block (abort/timeout/error): salvage the partial draft instead of
    // letting a half-written note evaporate with the protocol text
    if (failed && typeof salvagePartialNoteBlock === 'function') { try { await salvagePartialNoteBlock(last.text); } catch (_) {} }
  }
  s.running = false;
  persistSessions(); renderTabs();
  if (runId === activeId) renderChat();
  // ---- Kumiko tool lines: file verbs run now; READ/SEARCH turns the reply into an
  // INTERMEDIATE step — fetch the results and let the SAME session answer again (bounded).
  // a user-stopped reply is DONE — half-emitted verbs don't execute, and no tool
  // continuation restarts the engine the user just stopped
  const acts = (window.CoreMarkdown && window.CoreMarkdown.extractActions && !(last && last.stopped))
    ? window.CoreMarkdown.extractActions((last && last.text) || '') : { any: false, needsContinue: false };
  if (last && last.role === 'ai' && acts.any && typeof runKumikoVerbs === 'function') {
    try { await runKumikoVerbs(acts); } catch (_) {}
  }
  if (last && last.role === 'ai' && acts.needsContinue && (s._toolRounds || 0) < 2 && typeof buildToolResults === 'function') {
    s._toolRounds = (s._toolRounds || 0) + 1;
    try {
      const results = await buildToolResults(acts);
      const lastUser = [...s.messages].reverse().find((m) => m.role === 'user');
      s.messages.push({ role: 'ai', text: '', _acc: '', sources: [] });
      s.running = true;
      persistSessions(); renderTabs();
      if (runId === activeId) renderChat();
      const model = 'zai-coding-plan/' + s.model;
      const toolImgs = (window.__toolImages || []).slice(0, 4); window.__toolImages = [];
      window.api.runEngine({ engine: s.engine, model: (s.engine === 'glm' ? model : ''),
        prompt: buildToolContinuationPrompt(lastUser ? lastUser.text : '', results, (acts.chat || '').slice(0, 600)), runId: s.id, images: toolImgs });
      return;   // an "ask" reply never runs the write executors — the NEXT reply acts
    } catch (_) { s.running = false; }
  }
  s._toolRounds = 0;
  window.__aiReadTarget = null;   // implicit section target only lives within one tool round
  window.__toolImages = [];
  // If the AI emitted a note update, open the review automatically (matches the CLI path, where
  // the file-watcher opens it) — the user confirms once instead of pressing "apply" first.
  if (runId === activeId && last && last.role === 'ai' && typeof maybeAutoReviewReply === 'function') {
    try { const p = maybeAutoReviewReply(last.text || ''); if (p && p.catch) p.catch(() => {}); } catch (_) {}
  }
  // ===PDF-CLIP=== commands: paste the named slide pages into the companion note
  if (runId === activeId && last && last.role === 'ai' && typeof maybeClipPdfPages === 'function') {
    try { maybeClipPdfPages(last.text || ''); } catch (_) {}
  }
  // ===NEW-NOTE=== blocks: create the notes the AI was asked to make (and open the first)
  if (runId === activeId && last && last.role === 'ai' && typeof maybeCreateNewNotes === 'function') {
    try { maybeCreateNewNotes(last.text || ''); } catch (_) {}
  }
  // ===KUMIKO-RULE=== proposals: confirm card above the chat input (user accepts → KUMIKO.md)
  if (runId === activeId && last && last.role === 'ai' && typeof maybeProposeKumikoRules === 'function') {
    try { maybeProposeKumikoRules(last.text || ''); } catch (_) {}
  }
  // ===REMEMBER===/===FORGET=== proposals: memory confirm card (user accepts → KUMIKO-MEMORY.md)
  if (runId === activeId && last && last.role === 'ai' && typeof maybeProposeMemories === 'function') {
    try { const mp = maybeProposeMemories(last.text || ''); if (mp && mp.catch) mp.catch(() => {}); } catch (_) {}
  }
});

// Clicking an @-mention or [source:] reference in chat jumps to that note (or PDF).
(function wireRefClicks(){
  const box = document.getElementById('chatMessages');
  if (!box) return;
  box.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('.at-ref');
    if (!a) return;
    const raw = a.dataset.ref || '';
    const plain = raw.split('/').pop().replace(/\.(md|pdf)$/i, '').trim().toLowerCase();
    const noteRel = (window.__wlNoteRel || {})[plain];
    if (noteRel && typeof openNote === 'function') { openNote(noteRel); return; }
    const fam = (window.CoreRag && window.CoreRag.docFamilyKey) ? window.CoreRag.docFamilyKey(raw) : plain;
    const pdfRel = (window.__wlPdfRel || {})[plain] || (window.__wlPdfRel || {})[fam];
    if (pdfRel && typeof openPdf === 'function') openPdf(pdfRel);
  });
})();
