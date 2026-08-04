// DESKTOP sync engine (phase 8.3b, Option B). Renderer-side reconciliation of the
// local vault (window.api IPC — real files) with the cloud vault (fetch to backend).
// Uses the pure core/sync.js planSync. Web build is a no-op: on web, window.api IS
// the cloud shim so "local" already equals cloud — syncing would be pointless.
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
    let pushed=0, pulled=0, conflicts=0;
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
    localStorage.setItem('syncBase:'+vaultId, JSON.stringify(plan.newBase));
    return { ok:true, pushed, pulled, conflicts };
  } catch (e) { return { ok:false, error:String(e && e.message || e) }; }
}
window.syncNow = syncNow;
// auto-sync ~2s after load if logged in (desktop only), then refresh the note list
if (typeof window.KUMIKO_WEB === 'undefined') {
  setTimeout(async () => { try { const r = await syncNow(); if (r.ok && (r.pulled||r.conflicts) && typeof refreshList==='function') await refreshList(); } catch(_){} }, 2000);
}
