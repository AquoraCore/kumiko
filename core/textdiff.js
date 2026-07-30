// Shared core: pure text-diff engine (LCS). UMD: Node (module.exports) + browser (window.CoreTextDiff).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreTextDiff = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // ---- line-diff / merge engine (LCS) ----
  function _lcsOps(a, b){
    const n=a.length, m=b.length;
    const dp=Array.from({length:n+1},()=>new Int32Array(m+1));
    for(let i=n-1;i>=0;i--) for(let j=m-1;j>=0;j--)
      dp[i][j] = a[i]===b[j] ? dp[i+1][j+1]+1 : Math.max(dp[i+1][j], dp[i][j+1]);
    const ops=[]; let i=0,j=0;
    while(i<n&&j<m){
      if(a[i]===b[j]){ ops.push({t:'same',line:a[i]}); i++;j++; }
      else if(dp[i+1][j]>=dp[i][j+1]){ ops.push({t:'del',line:a[i]}); i++; }
      else { ops.push({t:'add',line:b[j]}); j++; }
    }
    while(i<n){ ops.push({t:'del',line:a[i++]}); }
    while(j<m){ ops.push({t:'add',line:b[j++]}); }
    return ops;
  }
  function diffSegments(before, after){
    const ops=_lcsOps(before.split('\n'), after.split('\n'));
    const segs=[]; let cur=null;
    for(const op of ops){
      if(op.t==='same'){
        if(!cur||cur.type!=='same'){ if(cur) segs.push(cur); cur={type:'same',lines:[]}; }
        cur.lines.push(op.line);
      } else {
        if(!cur||cur.type!=='hunk'){ if(cur) segs.push(cur); cur={type:'hunk',del:[],add:[]}; }
        (op.t==='del'?cur.del:cur.add).push(op.line);
      }
    }
    if(cur) segs.push(cur);
    return segs;
  }
  function addLinesFromText(t){ return t==='' ? [] : t.split('\n'); }
  // decisions[hunkIndex] = { accept:bool, addLines:[...] }
  function mergeSegments(segs, decisions){
    const out=[]; let hi=-1;
    for(const s of segs){
      if(s.type==='same'){ for(const l of s.lines) out.push(l); }
      else { hi++; const d=decisions[hi]||{accept:true,addLines:s.add};
        if(d.accept){ for(const l of d.addLines) out.push(l); } else { for(const l of s.del) out.push(l); } }
    }
    return out.join('\n');
  }
  return { _lcsOps: _lcsOps, diffSegments: diffSegments, addLinesFromText: addLinesFromText, mergeSegments: mergeSegments };
});
