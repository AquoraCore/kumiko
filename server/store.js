const fs = require('fs');
const path = require('path');

// ponytail: JSON-file user store — array on disk, lazy load, whole-array write.
// Good enough for a local single-process server; swap for a real DB if concurrency matters.
function createStore(filePath) {
  let users = null;

  function load() {
    if (users) return users;
    try {
      users = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(users)) users = [];
    } catch (_) {
      users = [];
    }
    return users;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
    } catch (_) { /* best-effort */ }
  }

  function findByEmail(email) {
    const em = String(email == null ? '' : email).trim().toLowerCase();
    return load().find((u) => u.email === em) || null;
  }

  function create({ email, passwordHash }) {
    load();
    if (users.some((u) => u.email === email)) return null;
    const count = users.length + 1;
    const user = { id: 'u' + count + '_' + email, email, passwordHash, createdAt: new Date().toISOString() };
    users.push(user);
    save();
    return user;
  }

  function _all() {
    return load();
  }

  return { findByEmail, create, _all };
}

module.exports = { createStore };
