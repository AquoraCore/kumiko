// Fixed-window rate limiter keyed by an arbitrary string (client IP, email, …). Counts
// events per window; hit() increments + reports, check() peeks without counting, reset()
// clears (call on a successful login so a good user is never locked out by past failures).
// In-memory / per-process — right for a single-node home server. Express-free and unit-
// testable via an injectable clock (opts.now). A lazy sweep drops expired keys so the Map
// can't grow without bound under a flood of distinct keys.
function createRateLimiter(opts) {
  opts = opts || {};
  const max = (typeof opts.max === 'number' && opts.max > 0) ? opts.max : 10;
  const windowMs = (typeof opts.windowMs === 'number' && opts.windowMs > 0) ? opts.windowMs : 15 * 60 * 1000;
  const now = opts.now || (() => Date.now());
  const hits = new Map();   // key -> { count, resetAt }
  let lastSweep = 0;
  function sweep(t) { if (t - lastSweep < windowMs) return; lastSweep = t; for (const [k, e] of hits) { if (t >= e.resetAt) hits.delete(k); } }
  function entry(key) {
    const t = now(); sweep(t);
    let e = hits.get(key);
    if (!e || t >= e.resetAt) { e = { count: 0, resetAt: t + windowMs }; hits.set(key, e); }
    return e;
  }
  const report = (e) => ({ limited: e.count >= max, remaining: Math.max(0, max - e.count), retryAfterMs: Math.max(0, e.resetAt - now()) });
  return {
    max, windowMs,
    check(key) { return report(entry(key)); },       // peek, no increment
    hit(key) { const e = entry(key); e.count += 1; return report(e); },
    reset(key) { hits.delete(key); },
    _size() { return hits.size; },
  };
}
module.exports = { createRateLimiter };
