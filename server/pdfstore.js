const fs = require('fs');
const path = require('path');
const { safeRel } = require('../core/pathutil');

// ponytail: rel-path guard over core/pathutil.safeRel — allows subfolders
// (e.g. "Box/a.pdf"), blocks traversal/absolute, keeps .pdf + non-sidecar.
// Ceiling: same as notestore/dbstore safeRel; no slug lib for personal vaults.
function safePdfRel(name) {
  const rel = safeRel(name);
  if (!rel) return null;
  if (!/\.pdf$/i.test(rel)) return null;
  if (/\.annot\.json$/i.test(rel)) return null;
  return rel;
}

function createPdfStore(rootDir) {
  function dir(userId, vaultId) {
    return path.join(rootDir, encodeURIComponent(String(userId)), encodeURIComponent(String(vaultId)), 'pdfs');
  }

  function list(userId, vaultId) {
    const root = dir(userId, vaultId);
    const out = [];
    const walk = (d, base) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        const rel = base ? base + '/' + ent.name : ent.name;
        if (ent.isDirectory()) { walk(path.join(d, ent.name), rel); continue; }
        if (!ent.isFile()) continue;
        if (!/\.pdf$/i.test(ent.name)) continue;
        if (/\.annot\.json$/i.test(ent.name)) continue;
        out.push(rel);
      }
    };
    walk(root, '');
    out.sort((a, b) => String(a).localeCompare(b));
    return out;
  }

  function read(userId, vaultId, name) {
    const rel = safePdfRel(name);
    if (!rel) return null;
    try {
      return fs.readFileSync(path.join(dir(userId, vaultId), rel));
    } catch (_) {
      return null;
    }
  }

  function write(userId, vaultId, name, buffer) {
    const rel0 = safePdfRel(name);
    if (!rel0) return null;
    try {
      const root = dir(userId, vaultId);
      fs.mkdirSync(path.join(root, path.dirname(rel0)), { recursive: true });
      const ext = path.extname(rel0);
      const stem = rel0.slice(0, rel0.length - ext.length);
      let rel = rel0; let i = 1;
      while (fs.existsSync(path.join(root, rel))) {
        rel = stem + ' (' + i + ')' + ext;
        i++;
      }
      fs.writeFileSync(path.join(root, rel), buffer);
      return rel;
    } catch (_) {
      return null;
    }
  }

  function rename(userId, vaultId, from, to) {
    const f = safePdfRel(from);
    if (!f) return { error: 'invalid' };
    const tRaw = /\.pdf$/i.test(String(to || '')) ? to : String(to || '').trim() + '.pdf';
    const t = safePdfRel(tRaw);
    if (!t) return { error: 'invalid' };
    const root = dir(userId, vaultId);
    const fp = path.join(root, f);
    const tp = path.join(root, t);
    if (fs.existsSync(tp)) return { error: 'exists' };
    try {
      fs.mkdirSync(path.dirname(tp), { recursive: true });
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

  function readAnnots(userId, vaultId, name) {
    const rel = safePdfRel(name);
    if (!rel) return { highlights: [] };
    try {
      return JSON.parse(fs.readFileSync(path.join(dir(userId, vaultId), rel + '.annot.json'), 'utf8'))
        || { highlights: [] };
    } catch (_) {
      return { highlights: [] };
    }
  }

  function saveAnnots(userId, vaultId, name, data) {
    const rel = safePdfRel(name);
    if (!rel) return false;
    try {
      const d = dir(userId, vaultId);
      const sidecar = path.join(d, rel + '.annot.json');
      fs.mkdirSync(path.dirname(sidecar), { recursive: true });
      fs.writeFileSync(sidecar, JSON.stringify(data || { highlights: [] }));
      return true;
    } catch (_) {
      return false;
    }
  }

  return { dir, list, read, write, rename, readAnnots, saveAnnots };
}

module.exports = { createPdfStore, safePdfRel };
