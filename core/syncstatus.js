// Pure status view for the sync chip. Maps a sync state + timestamp to a chip
// label/tone. No DOM, no IO. UMD: Node (module.exports) + browser (window.CoreSyncStatus).
function relTime(at, now){
  if (!at || !now || now < at) return '';
  const s = Math.floor((now - at)/1000);
  if (s < 10) return 'เมื่อสักครู่';
  if (s < 60) return s + ' วินาทีที่แล้ว';
  const m = Math.floor(s/60); if (m < 60) return m + ' นาทีที่แล้ว';
  const h = Math.floor(m/60); if (h < 24) return h + ' ชั่วโมงที่แล้ว';
  return Math.floor(h/24) + ' วันที่แล้ว';
}
function syncStatusView(s){
  s = s || {};
  const state = s.state || 'idle';
  const now = s.now || 0, at = s.at || 0;
  if (state === 'syncing') return { tone:'busy', label:'กำลังซิงก์…', title:'กำลังซิงก์กับคลาวด์' };
  if (state === 'offline') return { tone:'warn', label:'ออฟไลน์', title:'ยังไม่ได้ซิงก์ — ออฟไลน์' };
  if (state === 'error')   return { tone:'err',  label:'ซิงก์ไม่สำเร็จ', title:'ซิงก์ไม่สำเร็จ — จะลองใหม่' };
  if (state === 'synced'){
    const rel = relTime(at, now);
    return { tone:'ok', label:'ซิงก์แล้ว' + (rel ? ' · ' + rel : ''), title:'ซิงก์กับคลาวด์แล้ว' };
  }
  return { tone:'idle', label:'', title:'' }; // idle -> chip hidden by caller
}
if (typeof module!=='undefined'&&module.exports) module.exports={syncStatusView,relTime};
if (typeof window!=='undefined') window.CoreSyncStatus={syncStatusView,relTime};
