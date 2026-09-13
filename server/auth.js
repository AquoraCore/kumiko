const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ponytail: simple email regex — "something@something.tld", good enough for client-side sanity
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function validateCredentials(email, password) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email)) return { ok: false, error: 'invalid email' };
  if (typeof password !== 'string' || password.length < 8) return { ok: false, error: 'password too short' };
  return { ok: true };
}

function hashPassword(plain) {
  return bcrypt.hashSync(typeof plain === 'string' ? plain : '', 10);
}

function verifyPassword(plain, hash) {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch (_) {
    return false;
  }
}

function signToken(payload, secret, expiresIn) {
  return jwt.sign(payload, secret, { expiresIn: expiresIn || '30d' });
}

function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret);
  } catch (_) {
    return null;
  }
}

// AUTH_SECRET resolution (self-host hardening): env wins; else the persisted
// <dataDir>/.auth-secret keeps sessions alive across restarts; else generate
// one (crypto.randomBytes) and persist it mode 0600. A file that is empty or
// whitespace-only counts as absent and is regenerated over.
function resolveAuthSecret(dataDir) {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.join(dataDir, '.auth-secret');
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8').trim(); } catch (_) {}
  if (existing) return existing;
  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  console.log('[server] AUTH_SECRET not set — generated one and saved it to ' + file);
  return generated;
}

module.exports = {
  normalizeEmail,
  validateCredentials,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  resolveAuthSecret,
};
