// Pure 3-way reconcile for Option-B sync (files stay files, like Obsidian/Dropbox).
// No IO here — main.js does fetch/read/write. UMD: Node (module.exports) + browser (window.CoreSync).
function hashContent(s){ let h=5381; s=String(s==null?'':s); for(let i=0;i<s.length;i++){ h=((h<<5)+h+s.charCodeAt(i))>>>0; } return h.toString(36); }

function planSync(base, local, cloud){
  base = base || {};
  local = local || {};
  cloud = cloud || {};
  const pushes = [], pulls = [], conflicts = [], delLocal = [], delCloud = [], newBase = {};
  const seen = Object.create(null);
  for (const k in base) seen[k] = 1;
  for (const k in local) seen[k] = 1;
  for (const k in cloud) seen[k] = 1;
  for (const name in seen){
    const L = Object.prototype.hasOwnProperty.call(local, name) ? local[name] : undefined;
    const C = Object.prototype.hasOwnProperty.call(cloud, name) ? cloud[name] : undefined;
    const b = base[name];
    const inBase = Object.prototype.hasOwnProperty.call(base, name);
    const lh = L===undefined ? undefined : hashContent(L);
    const ch = C===undefined ? undefined : hashContent(C);
    if (L!==undefined && C!==undefined){
      if (lh === ch){ newBase[name]=lh; }
      else {
        const lChanged = lh !== b, cChanged = ch !== b;
        if (lChanged && !cChanged){ pushes.push({name,content:L}); newBase[name]=lh; }
        else if (cChanged && !lChanged){ pulls.push({name,content:C}); newBase[name]=ch; }
        else { conflicts.push({ name, localContent:L, cloudContent:C }); newBase[name]=lh; }
      }
    } else if (L!==undefined && C===undefined){
      // present local, absent cloud: delete-propagation (V2.1, base-driven).
      if (inBase && lh === b) { delLocal.push({ name }); }           // local UNCHANGED since base, cloud deleted it -> delete local
      else { pushes.push({ name, content: L }); newBase[name]=lh; }  // brand-new local, OR local edited after cloud delete (edit wins) -> push
    } else if (L===undefined && C!==undefined){
      // absent local, present cloud: delete-propagation (V2.1, base-driven).
      if (inBase && ch === b) { delCloud.push({ name }); }           // cloud UNCHANGED since base, local deleted it -> delete cloud
      else { pulls.push({ name, content: C }); newBase[name]=ch; }   // brand-new cloud, OR cloud edited after local delete (edit wins) -> pull
    }
    // both undefined: only in base -> drop from newBase (skip)
  }
  return { pushes, pulls, conflicts, delLocal, delCloud, newBase };
}

if (typeof module!=='undefined'&&module.exports) module.exports={hashContent,planSync};
if (typeof window!=='undefined') window.CoreSync={hashContent,planSync};
