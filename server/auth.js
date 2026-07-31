const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

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

module.exports = {
  normalizeEmail,
  validateCredentials,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
};
