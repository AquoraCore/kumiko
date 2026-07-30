// Shared core: pure string-similarity engine (Levenshtein + normalized similarity). UMD: Node (module.exports) + browser (window.CoreTextSim).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreTextSim = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  function _lev(a, b){
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => i);
    for (let j = 1; j <= n; j++){ let prev = dp[0]; dp[0] = j;
      for (let i = 1; i <= m; i++){ const tmp = dp[i]; dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; } }
    return dp[m];
  }
  function _sim(a, b){
    a = a.toLowerCase().trim(); b = b.toLowerCase().trim(); if (!a || !b) return 0; if (a === b) return 1;
    const d = _lev(a, b); const mx = Math.max(a.length, b.length) || 1; let s = 1 - d / mx;
    if (a.includes(b) || b.includes(a)) s = Math.max(s, 0.72);
    return s;
  }
  return { _lev: _lev, _sim: _sim };
});
