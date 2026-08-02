const fs = require('fs');
const path = require('path');
const { safeRel } = require('../core/pathutil');

function createNoteStore(rootDir) {
  function userDir(userId) {
    return path.join(rootDir, encodeURIComponent(String(userId)));
  }

  function walk(dir, base) {
    base = base || '';
    let out = [];
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const ent of ents) {
      if (ent.name.startsWith('.')) continue;
      const rel = base ? base + '/' + ent.name : ent.name;
      if (ent.isDirectory()) out = out.concat(walk(path.join(dir, ent.name), rel));
      else if (ent.name.endsWith('.md')) out.push(rel);
    }
    return out;
  }

  function list(userId) {
    return walk(userDir(userId));
  }

  function read(userId, name) {
    const rel = safeRel(name);
    if (!rel) return '';
    try {
      return fs.readFileSync(path.join(userDir(userId), rel), 'utf8');
    } catch (_) {
      return '';
    }
  }

  function write(userId, name, content) {
    const rel = safeRel(name);
    if (!rel) return false;
    try {
      const full = path.join(userDir(userId), rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return true;
    } catch (_) {
      return false;
    }
  }

  function remove(userId, name) {
    const rel = safeRel(name);
    if (!rel) return false;
    try {
      const full = path.join(userDir(userId), rel);
      if (fs.existsSync(full)) fs.unlinkSync(full);
      return true;
    } catch (_) {
      return false;
    }
  }

  return { userDir, list, read, write, remove };
}

module.exports = { createNoteStore };
