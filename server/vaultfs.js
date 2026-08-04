const fs = require('fs');
const path = require('path');
const { safeRel } = require('../core/pathutil');

// Per-vault folders + trash, mirroring the Electron handlers in main.js.
// Reuses the SAME per-vault dir as notestore (<rootDir>/<encodedUserId>/<encodedVaultId>),
// so folderCreate/Delete/Rename operate on the dirs that listNotes derives
// note folders from, and .trash sits next to notes but is dot-hidden.
function createVaultFs(rootDir) {
  function vaultDir(userId, vaultId) {
    return path.join(rootDir, encodeURIComponent(String(userId)), encodeURIComponent(String(vaultId)));
  }
  function trashDir(userId, vaultId) {
    return path.join(vaultDir(userId, vaultId), '.trash');
  }
  function manifestPath(userId, vaultId) {
    return path.join(trashDir(userId, vaultId), 'manifest.json');
  }
  function readManifest(userId, vaultId) {
    try { return JSON.parse(fs.readFileSync(manifestPath(userId, vaultId), 'utf8')) || []; }
    catch (_) { return []; }
  }
  function writeManifest(userId, vaultId, arr) {
    try {
      fs.mkdirSync(trashDir(userId, vaultId), { recursive: true });
      fs.writeFileSync(manifestPath(userId, vaultId), JSON.stringify(arr));
    } catch (_) {}
  }
  function newId() {
    return 't_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  // ---- folders ----
  // ALL directory rel-paths under userDir (recursive), INCLUDING EMPTY ones,
  // skipping dot-dirs (so .trash is excluded). Matches Electron note:list shape.
  function folderList(userId, vaultId) {
    const root = vaultDir(userId, vaultId);
    const out = [];
    const walk = (dir, base) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of ents) {
        if (ent.name.startsWith('.')) continue;
        if (!ent.isDirectory()) continue;
        const rel = base ? base + '/' + ent.name : ent.name;
        // Hide the top-level reserved pdfstore dir (lives at <vaultId>/pdfs);
        // nested folders literally named "pdfs" deeper down are kept.
        if (!base && rel === 'pdfs') continue;
        out.push(rel);
        walk(path.join(dir, ent.name), rel);
      }
    };
    walk(root, '');
    return out.sort();
  }

  function folderCreate(userId, vaultId, name) {
    const rel = safeRel(name);
    if (!rel) return { error: 'invalid' };
    const p = path.join(vaultDir(userId, vaultId), rel);
    if (fs.existsSync(p)) return { error: 'exists' };
    try {
      fs.mkdirSync(p, { recursive: true });
      return { name: rel };
    } catch (_) {
      return { error: 'failed' };
    }
  }

  function folderRename(userId, vaultId, from, to) {
    const relFrom = safeRel(from);
    const relTo = safeRel(to);
    if (!relFrom || !relTo) return { error: 'invalid' };
    const fromP = path.join(vaultDir(userId, vaultId), relFrom);
    const toP = path.join(vaultDir(userId, vaultId), relTo);
    if (fs.existsSync(toP)) return { error: 'exists' };
    try {
      fs.mkdirSync(path.dirname(toP), { recursive: true });
      fs.renameSync(fromP, toP);
      return { name: relTo };
    } catch (_) {
      return { error: 'failed' };
    }
  }

  function folderDelete(userId, vaultId, name) {
    const rel = safeRel(name);
    if (!rel) return { error: 'invalid' };
    const src = path.join(vaultDir(userId, vaultId), rel);
    if (!fs.existsSync(src)) return { error: 'failed' };
    const id = newId();
    const trashedName = id;
    try {
      fs.mkdirSync(trashDir(userId, vaultId), { recursive: true });
      fs.renameSync(src, path.join(trashDir(userId, vaultId), trashedName));
    } catch (_) {
      return { error: 'failed' };
    }
    const arr = readManifest(userId, vaultId);
    arr.push({
      id, type: 'folder',
      name: rel.split('/').pop(),
      origPath: rel,
      deletedAt: new Date().toISOString(),
      trashedName,
    });
    writeManifest(userId, vaultId, arr);
    return { ok: true };
  }

  // ---- trash ----
  // Soft-delete a note: moves the file into .trash, records a manifest entry.
  // Mirrors Electron note:delete (never hard-unlinks). {ok:false} on any miss/fail.
  function noteTrash(userId, vaultId, name) {
    const rel = safeRel(name);
    if (!rel) return { ok: false };
    const src = path.join(vaultDir(userId, vaultId), rel);
    if (!fs.existsSync(src)) return { ok: false };
    const id = newId();
    const trashedName = id;
    try {
      fs.mkdirSync(trashDir(userId, vaultId), { recursive: true });
      fs.renameSync(src, path.join(trashDir(userId, vaultId), trashedName));
    } catch (_) {
      return { ok: false };
    }
    const arr = readManifest(userId, vaultId);
    arr.push({
      id, type: 'note',
      name: rel.split('/').pop(),
      origPath: rel,
      deletedAt: new Date().toISOString(),
      trashedName,
    });
    writeManifest(userId, vaultId, arr);
    return { ok: true };
  }

  function trashList(userId, vaultId) {
    const td = trashDir(userId, vaultId);
    const arr = readManifest(userId, vaultId);
    const out = [];
    for (const ent of arr || []) {
      if (!ent || !ent.trashedName) continue;
      if (!fs.existsSync(path.join(td, ent.trashedName))) continue;
      out.push({
        id: ent.id,
        type: ent.type,
        name: ent.name,
        origPath: ent.origPath,
        deletedAt: ent.deletedAt,
      });
    }
    out.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
    return out;
  }

  function trashRestore(userId, vaultId, id) {
    const arr = readManifest(userId, vaultId);
    const idx = arr.findIndex((e) => e && e.id === id);
    if (idx < 0) return { error: 'notfound' };
    const ent = arr[idx];
    const tp = path.join(trashDir(userId, vaultId), ent.trashedName);
    if (!fs.existsSync(tp)) {
      arr.splice(idx, 1);
      writeManifest(userId, vaultId, arr);
      return { error: 'gone' };
    }
    const dest = path.join(vaultDir(userId, vaultId), ent.origPath);
    if (fs.existsSync(dest)) return { error: 'exists' };
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(tp, dest);
    } catch (_) {
      return { error: 'failed' };
    }
    arr.splice(idx, 1);
    writeManifest(userId, vaultId, arr);
    return { ok: true };
  }

  function trashDeleteForever(userId, vaultId, id) {
    const arr = readManifest(userId, vaultId);
    const idx = arr.findIndex((e) => e && e.id === id);
    if (idx < 0) return { ok: true };
    const ent = arr[idx];
    try {
      fs.rmSync(path.join(trashDir(userId, vaultId), ent.trashedName), { recursive: true, force: true });
    } catch (_) {}
    arr.splice(idx, 1);
    writeManifest(userId, vaultId, arr);
    return { ok: true };
  }

  function trashEmpty(userId, vaultId) {
    try {
      fs.rmSync(trashDir(userId, vaultId), { recursive: true, force: true });
    } catch (_) {}
    writeManifest(userId, vaultId, []);
    return { ok: true };
  }

  return {
    folderList, folderCreate, folderRename, folderDelete,
    noteTrash, trashList, trashRestore, trashDeleteForever, trashEmpty,
  };
}

module.exports = { createVaultFs };
