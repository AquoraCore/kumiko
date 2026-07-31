// ---------- Per-vault state (stored in <vault>/.washi/state.json, NOT localStorage) ----------
// Read SYNC at boot; written ASYNC (debounced) via vaultConfigWrite('state', VS).
const VS_MIG_KEYS = ['aiSessions','dashboards','dashWidgets','curDashId','dashSeq','collapsedFolders','sbSecCollapsed','lastNote','lastOpen','lastPdf','taskDbId'];
function lsJson(k, dflt){ try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return (v == null) ? dflt : v; } catch (_) { return dflt; } }
function lsInt(k, dflt){ const n = parseInt(localStorage.getItem(k) || '', 10); return isNaN(n) ? dflt : n; }
function lsPdfPages(){ const out = {}; for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k && k.indexOf('pdfPage:') === 0){ const pg = parseInt(localStorage.getItem(k) || '1', 10); if (!isNaN(pg) && pg > 0) out[k.slice('pdfPage:'.length)] = pg; } } return out; }
function lsHasOldKeys(){ for (const k of VS_MIG_KEYS){ if (localStorage.getItem(k) !== null) return true; } for (let i = 0; i < localStorage.length; i++){ const k = localStorage.key(i); if (k && k.indexOf('pdfPage:') === 0) return true; } return false; }

let VS = window.api.vaultStateReadSync();
if (VS == null) {
  if (!localStorage.getItem('washiStateMigrated') && lsHasOldKeys()) {
    // First upgrade: adopt the existing GLOBAL state into THIS (the current/default) vault.
    VS = {
      aiSessions: lsJson('aiSessions', null),
      dashboards: lsJson('dashboards', null),
      dashWidgets: lsJson('dashWidgets', []),
      curDashId: localStorage.getItem('curDashId'),
      dashSeq: lsInt('dashSeq', 1),
      collapsedFolders: lsJson('collapsedFolders', []),
      sbSecCollapsed: lsJson('sbSecCollapsed', []),
      lastNote: localStorage.getItem('lastNote'),
      lastOpen: lsJson('lastOpen', null),
      lastPdf: localStorage.getItem('lastPdf'),
      taskDbId: localStorage.getItem('taskDbId') || '',
      pdfPages: lsPdfPages(),
    };
    try { window.api.vaultConfigWrite('state', VS); } catch (_) {}
    localStorage.setItem('washiStateMigrated', '1');
    VS_MIG_KEYS.forEach((k) => localStorage.removeItem(k));   // remove migrated per-vault keys (global prefs untouched)
    for (let i = localStorage.length - 1; i >= 0; i--){ const k = localStorage.key(i); if (k && k.indexOf('pdfPage:') === 0) localStorage.removeItem(k); }
  } else {
    VS = {};   // fresh/other vault → start clean, NO global-state bleed
  }
}

let _vsTimer = null;
function vsSaveDebounced(){
  if (_vsTimer) clearTimeout(_vsTimer);
  _vsTimer = setTimeout(() => { _vsTimer = null; try { window.api.vaultConfigWrite('state', VS); } catch (_) {} }, 250);
}
function vsGet(k, dflt){ return (VS && VS[k] !== undefined && VS[k] !== null) ? VS[k] : dflt; }
function vsSet(k, v){ if (!VS) VS = {}; VS[k] = v; vsSaveDebounced(); }
function vsPdfPageGet(rel){ return (VS && VS.pdfPages) ? VS.pdfPages[rel] : undefined; }
function vsPdfPageSet(rel, v){ if (!VS) VS = {}; if (!VS.pdfPages) VS.pdfPages = {}; VS.pdfPages[rel] = v; vsSaveDebounced(); }
function vsPdfPageRename(oldRel, newRel){ if (!VS || !VS.pdfPages || VS.pdfPages[oldRel] == null) return; VS.pdfPages[newRel] = VS.pdfPages[oldRel]; delete VS.pdfPages[oldRel]; vsSaveDebounced(); }
function vsPdfPageDelete(rel){ if (!VS || !VS.pdfPages || VS.pdfPages[rel] == null) return; delete VS.pdfPages[rel]; vsSaveDebounced(); }
