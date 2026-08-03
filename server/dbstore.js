const fs = require('fs');
const path = require('path');

// ponytail: /^[a-zA-Z0-9_-]+$/ id guard — same ceiling as the rest of the per-user
// stores (no path separators, no traversal). Upgrade to a slug lib if ids ever
// need unicode; the seeded db_<base36> ids are ascii-only today.
function safeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
}

function createDbStore(rootDir) {
  function dbDir(userId) {
    return path.join(rootDir, encodeURIComponent(String(userId)), 'databases');
  }

  function list(userId) {
    const dir = dbDir(userId);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      try {
        const db = JSON.parse(fs.readFileSync(path.join(dir, ent.name), 'utf8'));
        if (!db || !db.id) continue;
        out.push({
          id: db.id,
          name: db.name,
          icon: db.icon || '',
          cols: (db.columns || []).length,
          rows: (db.rows || []).length,
        });
      } catch (_) { /* malformed file -> skip */ }
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  }

  function read(userId, id) {
    const sid = safeId(id);
    if (!sid) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(dbDir(userId), sid + '.json'), 'utf8')) || null;
    } catch (_) {
      return null;
    }
  }

  function write(userId, db) {
    if (!db || !db.id) return false;
    const sid = safeId(db.id);
    if (!sid) return false;
    try {
      const full = path.join(dbDir(userId), sid + '.json');
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(db, null, 2));
      return true;
    } catch (_) {
      return false;
    }
  }

  function remove(userId, id) {
    const sid = safeId(id);
    if (!sid) return false;
    try {
      const full = path.join(dbDir(userId), sid + '.json');
      if (fs.existsSync(full)) fs.unlinkSync(full);
      return true;
    } catch (_) {
      return false;
    }
  }

  return { dbDir, list, read, write, remove };
}

module.exports = { createDbStore };
