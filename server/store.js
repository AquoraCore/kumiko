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

  function findByGoogleId(googleId) {
    const gid = String(googleId == null ? '' : googleId);
    if (!gid) return null;
    return load().find((u) => u.googleId === gid) || null;
  }

  // passwordHash + googleId both optional now (Google users have no password).
  function create({ email, passwordHash, googleId }) {
    load();
    if (users.some((u) => u.email === email)) return null;
    const count = users.length + 1;
    const user = {
      id: 'u' + count + '_' + email,
      email,
      createdAt: new Date().toISOString(),
    };
    if (passwordHash != null) user.passwordHash = passwordHash;
    if (googleId != null) user.googleId = googleId;
    users.push(user);
    save();
    return user;
  }

  // find-or-create-and-link: by googleId first, then LINK to an existing email account,
  // otherwise create a fresh Google-only user. Persists on the link + create paths.
  function findOrCreateGoogle(googleId, email) {
    const byG = findByGoogleId(googleId);
    if (byG) return byG;
    const em = String(email == null ? '' : email).trim().toLowerCase();
    const byE = load().find((u) => u.email === em) || null;
    if (byE) {
      byE.googleId = googleId;
      save();
      return byE;
    }
    return create({ email: em, googleId });
  }

  function _all() {
    return load();
  }

  return { findByEmail, findByGoogleId, create, findOrCreateGoogle, _all };
}

module.exports = { createStore };
