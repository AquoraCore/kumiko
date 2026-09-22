const fs = require('fs');
const path = require('path');
const { safeRel } = require('../core/pathutil');

function createNoteStore(rootDir) {
  function vaultDir(userId, vaultId) {
    return path.join(rootDir, encodeURIComponent(String(userId)), encodeURIComponent(String(vaultId)));
  }

  // KUMIKO* root files (rules / memory / worklog / plan notes) are hidden from every
  // list-driven surface (parity with the desktop walker) — root level only; read/write
  // by direct rel still works.
  function walk(dir, base) {
    base = base || '';
    let out = [];
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const rel = base ? base + '/' + ent.name : ent.name;
      if (ent.isDirectory()) out = out.concat(walk(path.join(dir, ent.name), rel));
      else if (ent.name.endsWith('.md') && !(base === '' && ent.name.startsWith('KUMIKO'))) out.push(rel);
    }
    return out;
  }

  function list(userId, vaultId) {
    return walk(vaultDir(userId, vaultId));
  }

  function read(userId, vaultId, name) {
    const rel = safeRel(name);
    if (!rel) return '';
    try {
      return fs.readFileSync(path.join(vaultDir(userId, vaultId), rel), 'utf8');
    } catch (_) {
      return '';
    }
  }

  function write(userId, vaultId, name, content) {
    const rel = safeRel(name);
    if (!rel) return false;
    try {
      const full = path.join(vaultDir(userId, vaultId), rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return true;
    } catch (_) {
      return false;
    }
  }

  function remove(userId, vaultId, name) {
    const rel = safeRel(name);
    if (!rel) return false;
    try {
      const full = path.join(vaultDir(userId, vaultId), rel);
      if (fs.existsSync(full)) fs.unlinkSync(full);
      return true;
    } catch (_) {
      return false;
    }
  }

  return { list, read, write, remove };
}

module.exports = { createNoteStore };
