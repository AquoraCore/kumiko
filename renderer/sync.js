// DESKTOP sync engine (phase 8.3b, Option B). Renderer-side reconciliation of the
// local vault (window.api IPC — real files) with the cloud vault (fetch to backend).
// Uses the pure core/sync.js planSync. Web build is a no-op: on web, window.api IS
// the cloud shim so "local" already equals cloud — syncing would be pointless.
// v2.2: background auto-sync (initial + 60s interval + after-save debounce) with a
// concurrency guard + a status chip. syncNow() body is unchanged; syncTick wraps it.
let _syncing = false, _syncState = { state:'idle', at:0 };
let _soonT = null;
function _now(){ return (window.__NOW__ || Date.now()); }
function applySyncChip(){
  const chip = document.getElementById('syncChip');
  if (!chip) return;
  if (typeof window.KUMIKO_WEB !== 'undefined'){ chip.hidden = true; return; }
  const v = window.CoreSyncStatus.syncStatusView({ state:_syncState.state, at:_syncState.at, now:_now() });
  if (!v.label){ chip.hidden = true; return; }
  chip.hidden = false; chip.textContent = v.label; chip.title = v.title; chip.className = 'sync-chip ' + v.tone;
}
async function syncNow() {
  if (typeof window.KUMIKO_WEB !== 'undefined') return { ok:false, error:'web' };
  try {
    const acc = await window.api.authGetToken();
    const token = acc && acc.token;
    if (!token) return { ok:false, error:'not-logged-in' };
    const base = collabHttpBase();
    const H = (extra) => Object.assign({ 'content-type':'application/json', authorization:'Bearer '+token }, extra||{});
    // 1) pick a cloud vault to sync with (v1: the default/first). Remember it per app install.
    let vaultId = localStorage.getItem('syncCloudVault') || '';
    const vres = await fetch(base + '/vaults', { headers: H() });
    if (!vres.ok) return { ok:false, error:'vaults-'+vres.status };
    const vaults = (await vres.json()).vaults || [];
    if (!vaults.length) return { ok:false, error:'no-vault' };
    if (!vaultId || !vaults.some(v=>v.id===vaultId)) { vaultId = vaults[0].id; localStorage.setItem('syncCloudVault', vaultId); }
    const VH = (extra) => H(Object.assign({ 'x-vault': vaultId }, extra||{}));
    // 2) build cloudMap { name -> content }
    const cnames = ((await (await fetch(base + '/notes', { headers: VH() })).json()).notes) || [];
    const cloud = {};
    for (const n of cnames) {
      const r = await fetch(base + '/notes/content?name=' + encodeURIComponent(n), { headers: VH() });
      cloud[n] = r.ok ? (((await r.json()).content) || '') : '';
    }
    // 3) build localMap via the Electron IPC (real local files)
    const ll = await window.api.listNotes();
    const lnames = (ll && ll.notes) || [];
    const local = {};
    for (const n of lnames) local[n] = await window.api.readNote(n);
    // 4) plan
    const baseState = JSON.parse(localStorage.getItem('syncBase:'+vaultId) || '{}');
    const plan = window.CoreSync.planSync(baseState, local, cloud);
    // 5) apply
    let pushed=0, pulled=0, conflicts=0, deletedLocal=0, deletedCloud=0;
    for (const p of plan.pushes) { await fetch(base + '/notes', { method:'PUT', headers:VH(), body: JSON.stringify({ name:p.name, content:p.content }) }); pushed++; }
    for (const p of plan.pulls)  { await window.api.saveNote(p.name, p.content); pulled++; }
    for (const c of plan.conflicts) {
      // keep local as canonical (push it up); save cloud version as a conflict copy on BOTH sides
      await fetch(base + '/notes', { method:'PUT', headers:VH(), body: JSON.stringify({ name:c.name, content:c.localContent }) });
      const cname = c.name.replace(/\.md$/i,'') + ' (conflict ' + Date.now().toString(36) + ').md';
      await window.api.saveNote(cname, c.cloudContent);
      await fetch(base + '/notes', { method:'PUT', headers:VH(), body: JSON.stringify({ name:cname, content:c.cloudContent }) });
      plan.newBase[cname] = window.CoreSync.hashContent(c.cloudContent);
      conflicts++;
    }
    for (const d of plan.delCloud)  { await fetch(base + '/notes?name=' + encodeURIComponent(d.name), { method:'DELETE', headers:VH() }); deletedCloud++; }
    for (const d of plan.delLocal)  { await window.api.deleteNote(d.name); deletedLocal++; }
    localStorage.setItem('syncBase:'+vaultId, JSON.stringify(plan.newBase));
    return { ok:true, pushed, pulled, conflicts, deletedLocal, deletedCloud };
  } catch (e) { return { ok:false, error:String(e && e.message || e) }; }
}
window.syncNow = syncNow;
// Guarded wrapper the schedulers call. Keeps syncNow's contract intact and updates
// the chip + state. Reason is for traceability only ('load' | 'interval' | 'save' | 'online').
async function syncTick(reason){
  if (typeof window.KUMIKO_WEB !== 'undefined') return { ok:false, error:'web' };
  if (_syncing) return { ok:false, error:'busy' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false){
    _syncState = { state:'offline', at:_syncState.at }; applySyncChip();
    return { ok:false, error:'offline' };
  }
  _syncing = true; _syncState = { state:'syncing', at:_syncState.at }; applySyncChip();
  let r;
  try { r = await syncNow(); } finally { _syncing = false; }
  if (r && r.ok){
    _syncState = { state:'synced', at:_now() };
  } else if (r && r.error === 'not-logged-in'){
    _syncState = { state:'idle', at:_syncState.at };
  } else {
    _syncState = { state:'error', at:_syncState.at };
  }
  applySyncChip();
  if (r && r.ok && (r.pulled || r.conflicts || r.deletedLocal) && typeof refreshList === 'function'){
    try { await refreshList(); } catch(_){}
  }
  return r;
}
window.syncTick = syncTick;
// Debounced after-save sync. Coalesces rapid Ctrl-S presses into one sync.
window.syncSoon = function(delay){
  if (typeof window.KUMIKO_WEB !== 'undefined') return;
  clearTimeout(_soonT);
  _soonT = setTimeout(() => syncTick('save'), delay == null ? 2500 : delay);
};
// v2.2 background auto-sync (desktop only): initial @2s, periodic @60s,
// online/offline hooks, and an initial chip paint (hidden while idle).
if (typeof window.KUMIKO_WEB === 'undefined') {
  setTimeout(() => syncTick('load'), 2000);
  setInterval(() => syncTick('interval'), 60000);
  if (typeof window !== 'undefined' && window.addEventListener){
    window.addEventListener('online',  () => { applySyncChip(); syncTick('online'); });
    window.addEventListener('offline', () => { _syncState = { state:'offline', at:_syncState.at }; applySyncChip(); });
  }
  setTimeout(applySyncChip, 0);
}
