const fs = require('fs');
const path = require('path');

// ponytail: basename + .pdf guard — same ceiling as notestore/dbstore (no
// separators, no traversal). Upgrading to a slug lib is YAGNI for personal vaults.
function safeName(name) {
  return (typeof name === 'string'
    && name === path.basename(name)
    && /\.pdf$/i.test(name)
    && !/\.annot\.json$/i.test(name))
    ? name : null;
}

function createPdfStore(rootDir) {
  function dir(userId) {
    return path.join(rootDir, encodeURIComponent(String(userId)), 'pdfs');
  }

  function list(userId) {
    const d = dir(userId);
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const ent of ents) {
      if (!ent.isFile()) continue;
      if (!/\.pdf$/i.test(ent.name)) continue;
      if (/\.annot\.json$/i.test(ent.name)) continue;
      out.push(ent.name);
    }
    out.sort((a, b) => String(a).localeCompare(b));
    return out;
  }

  function read(userId, name) {
    const n = safeName(name);
    if (!n) return null;
    try {
      return fs.readFileSync(path.join(dir(userId), n));
    } catch (_) {
      return null;
    }
  }

  function write(userId, name, buffer) {
    const n0 = safeName(name);
    if (!n0) return null;
    try {
      const d = dir(userId);
      fs.mkdirSync(d, { recursive: true });
      // DEDUP: append " (1)", " (2)"... until the path is free. Mirrors
      // Electron's native dialog copy-into-vault dedup shape.
      let n = n0; let i = 1;
      while (fs.existsSync(path.join(d, n))) {
        const ext = path.extname(n0);
        const stem = n0.slice(0, n0.length - ext.length);
        n = stem + ' (' + i + ')' + ext;
        i++;
      }
      fs.writeFileSync(path.join(d, n), buffer);
      return n;
    } catch (_) {
      return null;
    }
  }

  function rename(userId, from, to) {
    const f = safeName(from);
    if (!f) return { error: 'invalid' };
    // Coerce `to` to a .pdf basename; if caller omitted the extension, append it.
    const t = safeName(/\.pdf$/i.test(String(to || '')) ? to : String(to || '').trim() + '.pdf');
    if (!t) return { error: 'invalid' };
    const d = dir(userId);
    const fp = path.join(d, f);
    const tp = path.join(d, t);
    if (fs.existsSync(tp)) return { error: 'exists' };
    try {
      fs.renameSync(fp, tp);
    } catch (_) {
      return { error: 'failed' };
    }
    // Sidecar follows the file; missing sidecar is fine (not an error).
    try {
      if (fs.existsSync(fp + '.annot.json')) {
        fs.renameSync(fp + '.annot.json', tp + '.annot.json');
      }
    } catch (_) {}
    return { name: t };
  }

  function readAnnots(userId, name) {
    const n = safeName(name);
    if (!n) return { highlights: [] };
    try {
      return JSON.parse(fs.readFileSync(path.join(dir(userId), n + '.annot.json'), 'utf8'))
        || { highlights: [] };
    } catch (_) {
      return { highlights: [] };
    }
  }

  function saveAnnots(userId, name, data) {
    const n = safeName(name);
    if (!n) return false;
    try {
      const d = dir(userId);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, n + '.annot.json'), JSON.stringify(data || { highlights: [] }));
      return true;
    } catch (_) {
      return false;
    }
  }

  return { dir, list, read, write, rename, readAnnots, saveAnnots };
}

module.exports = { createPdfStore, safeName };
