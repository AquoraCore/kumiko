// ---------- AI Chat: multi-session (paper tabs) ----------
function stripAnsi(s){ return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, ''); }
function cleanChatText(s){
  return stripAnsi(s)
    .replace(/Warning: no stdin data received[^\n]*\n?/g, '')
    .replace(/^\s*>\s*build\b.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
}
function chatScroll(){ const m = document.getElementById('chatMessages'); if (m) m.scrollTop = m.scrollHeight; }

const SESSION_ICONS = ['note','task','graph','sparkle','pencil','dash','db','star'];
const SCOPE_LABEL = { note: 'อ้างอิงโน้ตนี้', vault: 'ทั้ง vault', free: 'อิสระ' };
const GLM_MODELS = ['glm-5.2','glm-5.1','glm-5-turbo','glm-4.7','glm-4.5-air'];
let sessions = [];
let activeId = null;
let liveBubble = null;     // ai bubble DOM element of the active session's running turn (else null)

function persistSessions(){
  try {
    const slim = sessions.map((s) => ({ id: s.id, name: s.name, icon: s.icon, engine: s.engine, model: s.model, scope: s.scope,
      messages: s.messages.map((m) => ({ role: m.role, text: m.text })) }));
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
      messages: Array.isArray(s.messages) ? s.messages.map((m) => ({ role: m.role, text: m.text })) : [] }));
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
  const scope = document.createElement('select'); scope.className = 'sh-scope'; scope.title = t('ขอบเขตบริบท');
  ['note','vault','free'].forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = t(SCOPE_LABEL[v]); if (s.scope === v) o.selected = true; scope.appendChild(o); });
  scope.onchange = () => { s.scope = scope.value; persistSessions(); };
  head.appendChild(scope);
  const sp = document.createElement('span'); sp.className = 'sh-sp'; head.appendChild(sp);
  const eng = document.createElement('select'); eng.className = 'sh-eng'; eng.title = 'engine';
  [['glm','GLM'],['claude','Claude']].forEach(([v,l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; if (s.engine === v) o.selected = true; eng.appendChild(o); });
  const mdl = document.createElement('select'); mdl.className = 'sh-mdl'; mdl.title = 'model';
  GLM_MODELS.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; if (s.model === v) o.selected = true; mdl.appendChild(o); });
  mdl.hidden = s.engine !== 'glm';
  eng.onchange = () => { s.engine = eng.value; mdl.hidden = s.engine !== 'glm'; syncEngineFromSession(); persistSessions(); renderTabs(); };
  mdl.onchange = () => { s.model = mdl.value; syncEngineFromSession(); persistSessions(); };
  head.appendChild(eng); head.appendChild(mdl);
  const dots = document.createElement('button'); dots.className = 'sh-dots'; dots.textContent = '⋯'; dots.title = t('จัดการ session');
  dots.onclick = (e) => { e.stopPropagation(); openSessionMenu(dots, s); };
  head.appendChild(dots);
}
function renderChat(){
  const box = document.getElementById('chatMessages'); if (!box) return;
  const s = activeSession(); box.innerHTML = ''; liveBubble = null;
  s.messages.forEach((m, i) => {
    const wrap = document.createElement('div'); wrap.className = 'm-wrap ' + m.role;
    if (m.role === 'ai') { const who = document.createElement('div'); who.className = 'who'; who.textContent = s.engine === 'glm' ? 'GLM' : 'Claude'; wrap.appendChild(who); }
    if (m.role === 'ai' && Array.isArray(m.sources) && m.sources.length > 0) {
      const row = document.createElement('div');
      row.className = 'rag-sources';
      const label = document.createElement('span'); label.className = 'rag-sources-label';
      label.textContent = '📎 ' + t('อ้างอิง') + ' ' + m.sources.length + ' ' + t('โน้ต');
      row.appendChild(label);
      m.sources.forEach((src) => { const pill = document.createElement('span'); pill.className = 'rag-src'; pill.textContent = src; row.appendChild(pill); });
      wrap.appendChild(row);
    }
    const b = document.createElement('div'); b.className = 'm ' + m.role;
    const running = s.running && i === s.messages.length - 1 && m.role === 'ai';
    if (running && !m.text) { b.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>'; liveBubble = b; }
    else if (m.role === 'ai') { b.innerHTML = mdToHtml(m.text); if (running) liveBubble = b; }
    else { b.textContent = m.text; }
    wrap.appendChild(b); box.appendChild(wrap);
  });
  chatScroll();
  if (typeof updateSendButton === 'function') updateSendButton();
}
function renderSessions(){ renderTabs(); renderHead(); renderChat(); }
function switchSession(id){ if (id === activeId) return; activeId = id; syncEngineFromSession(); persistSessions(); renderSessions(); if (typeof updateSendButton === 'function') updateSendButton(); }
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
function beginAiTurn(userText, sources){
  const s = activeSession();
  s.messages.push({ role: 'user', text: userText });
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
  last._acc = (last._acc || '') + stripAnsi(data);
  const shown = cleanChatText(last._acc).trim();
  if (shown) { last.text = shown; if (runId === activeId && liveBubble) { liveBubble.innerHTML = mdToHtml(shown); chatScroll(); } }
});
window.api.onEngineDone((payload) => {
  const runId = payload && payload.runId; if (!runId) return;
  const s = sessionById(runId); if (!s) return;
  const last = s.messages[s.messages.length - 1];
  if (last && last.role === 'ai') { const shown = cleanChatText(last._acc || '').trim(); last.text = shown || t('(เสร็จ · ไม่มีข้อความตอบกลับ)'); delete last._acc; }
  s.running = false;
  persistSessions(); renderTabs();
  if (runId === activeId) renderChat();
});
