// Per-user daily quota for the MANAGED AI key — the one billed to the server owner.
// Only requests that fall back to the managed key (the user brought no key of their own)
// count against this; a user using their OWN key is their own cost and is never limited.
// Counts REQUESTS per UTC day per userId, persisted to a small JSON file. limit <= 0 (or
// non-finite) means unlimited.
const fs = require('fs');
const path = require('path');

function createAiQuota(filePath, limit) {
  const cap = (typeof limit === 'number' && isFinite(limit) && limit > 0) ? Math.floor(limit) : Infinity;
  const today = () => new Date().toISOString().slice(0, 10);   // UTC yyyy-mm-dd
  const _read = () => { try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {}; } catch (_) { return {}; } };
  const _write = (o) => { try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, JSON.stringify(o)); } catch (_) {} };
  // today's count for a user (0 if last entry is from a previous day → daily reset)
  const _count = (o, userId) => { const e = o[userId]; return (e && e.date === today()) ? (e.count || 0) : 0; };

  return {
    limit: cap,
    unlimited: cap === Infinity,
    // Would the NEXT managed request be allowed?
    check(userId) {
      const used = _count(_read(), userId);
      return { allowed: used < cap, used, limit: cap, remaining: cap === Infinity ? Infinity : Math.max(0, cap - used) };
    },
    // Count one managed request against the user's day. Returns the new count.
    record(userId) {
      const o = _read();
      const count = _count(o, userId) + 1;
      o[userId] = { date: today(), count };
      _write(o);
      return count;
    },
  };
}

module.exports = { createAiQuota };
