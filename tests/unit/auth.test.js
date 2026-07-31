import { describe, it, expect } from 'vitest';
const {
  normalizeEmail,
  validateCredentials,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
} = require('../../server/auth');

describe('normalizeEmail', () => {
  it('trims + lowercases a valid email', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });
  it('returns "" for null', () => {
    expect(normalizeEmail(null)).toBe('');
  });
  it('returns "" for a number', () => {
    expect(normalizeEmail(42)).toBe('');
  });
});

describe('validateCredentials', () => {
  it('ok:true for valid email + password (>=8)', () => {
    expect(validateCredentials('a@b.com', 'password123').ok).toBe(true);
  });
  it('ok:false for non-email', () => {
    expect(validateCredentials('notanemail', 'password123').ok).toBe(false);
  });
  it('ok:false for too-short password', () => {
    expect(validateCredentials('a@b.com', 'short').ok).toBe(false);
  });
  it('ok:false for empty strings', () => {
    expect(validateCredentials('', '').ok).toBe(false);
  });
  it('ok:false for null/null', () => {
    expect(validateCredentials(null, null).ok).toBe(false);
  });
});

describe('hashPassword / verifyPassword', () => {
  const h = hashPassword('secret123');

  it('verify matches the original password', () => {
    expect(verifyPassword('secret123', h)).toBe(true);
  });
  it('hash is not stored in plaintext', () => {
    expect(h).not.toBe('secret123');
  });
  it('hash starts with bcrypt marker $2', () => {
    expect(h.startsWith('$2')).toBe(true);
  });
  it('wrong password returns false', () => {
    expect(verifyPassword('wrongpw', h)).toBe(false);
  });
  it('malformed hash returns false (no throw)', () => {
    expect(verifyPassword('secret123', 'not-a-hash')).toBe(false);
  });
});

describe('signToken / verifyToken', () => {
  const t = signToken({ sub: 'u1', email: 'a@b.com' }, 'topsecret');

  it('round-trips payload fields', () => {
    const p = verifyToken(t, 'topsecret');
    expect(p.sub).toBe('u1');
    expect(p.email).toBe('a@b.com');
  });
  it('wrong secret returns null', () => {
    expect(verifyToken(t, 'WRONGSECRET')).toBe(null);
  });
  it('garbage token returns null', () => {
    expect(verifyToken('garbage.token.here', 'topsecret')).toBe(null);
  });
  it('null token returns null', () => {
    expect(verifyToken(null, 'topsecret')).toBe(null);
  });
  it('already-expired token returns null', () => {
    const expired = signToken({ sub: 'u1' }, 's', '-1s');
    expect(verifyToken(expired, 's')).toBe(null);
  });
});
