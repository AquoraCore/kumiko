const fs = require('fs');
const path = require('path');

// ponytail: per-user vault registry as a single vaults.json per user. A real DB
// would scale better; a JSON file is enough for one user's handful of vaults.
// Upgrade path: swap _read/_write for a KV/db when concurrency matters.
function createVaultReg(rootDir) {
  function userDir(userId) {
    return path.join(rootDir, encodeURIComponent(String(userId)));
  }
  function regPath(userId) {
    return path.join(userDir(userId), 'vaults.json');
  }
  function newId() {
    return 'v_' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function _read(userId) {
    try {
      return JSON.parse(fs.readFileSync(regPath(userId), 'utf8')) || [];
    } catch (_) {
      return [];
    }
  }
  function _write(userId, arr) {
    try {
      fs.mkdirSync(userDir(userId), { recursive: true });
      fs.writeFileSync(regPath(userId), JSON.stringify(arr));
    } catch (_) {}
  }

  // ENSURES a default vault always exists (created lazily on first read).
  function list(userId) {
    let arr = _read(userId);
    if (arr.length === 0) {
      arr = [{ id: newId(), name: 'บันทึกของฉัน', createdAt: new Date().toISOString() }];
      _write(userId, arr);
    }
    return arr;
  }
  function defaultVaultId(userId) {
    return list(userId)[0].id;
  }
  function has(userId, id) {
    return list(userId).some((v) => v.id === id);
  }
  // validate-or-default
  function resolve(userId, id) {
    return (id && has(userId, id)) ? id : defaultVaultId(userId);
  }
  function create(userId, name) {
    const v = { id: newId(), name: String(name || 'Vault ใหม่'), createdAt: new Date().toISOString() };
    const arr = list(userId);
    arr.push(v);
    _write(userId, arr);
    return v;
  }
  function rename(userId, id, name) {
    const arr = list(userId);
    const v = arr.find((x) => x.id === id);
    if (!v) return { error: 'notfound' };
    v.name = String(name || v.name);
    _write(userId, arr);
    return v;
  }
  function remove(userId, id) {
    let arr = list(userId);
    if (arr.length <= 1) return { error: 'last' }; // never delete the last vault
    if (!arr.some((x) => x.id === id)) return { error: 'notfound' };
    arr = arr.filter((x) => x.id !== id);
    _write(userId, arr);
    try { fs.rmSync(path.join(userDir(userId), encodeURIComponent(String(id))), { recursive: true, force: true }); } catch (_) {}
    return { ok: true };
  }

  return { list, defaultVaultId, has, resolve, create, rename, remove };
}

module.exports = { createVaultReg };
