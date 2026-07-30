import { describe, it, expect } from 'vitest';
import { safeRel, baseName, vaultName } from '../../core/pathutil.js';

describe('safeRel', () => {
  it('passes a simple relative filename (happy)', () => {
    expect(safeRel('a.md')).toBe('a.md');
  });

  it('passes a nested relative path (happy)', () => {
    expect(safeRel('folder/b.md')).toBe('folder/b.md');
  });

  it('normalizes backslashes to forward slashes (happy)', () => {
    expect(safeRel('a\\b.md')).toBe('a/b.md');
  });

  it('returns null for empty string (edge)', () => {
    expect(safeRel('')).toBeNull();
  });

  it('returns null for null (edge)', () => {
    expect(safeRel(null)).toBeNull();
  });

  it('blocks a leading-parent ../x traversal (edge)', () => {
    expect(safeRel('../x')).toBeNull();
  });

  // NOTE: the spec listed 'a/../b' -> null, but the VERBATIM function runs
  // path.normalize() first, which collapses 'a/../b' -> 'b' before the '/../'
  // guard can fire. Behavior must stay identical, so the test locks in 'b'.
  it('normalizes a/../b to b (edge — verbatim behavior, NOT null)', () => {
    expect(safeRel('a/../b')).toBe('b');
  });

  // NOTE: the spec listed '/abs/x' (absolute) -> null, but the VERBATIM function
  // strips leading slashes (.replace(/^\/+/, '')) BEFORE the path.isAbsolute()
  // check, so a unix-absolute path becomes relative and is returned as 'abs/x'.
  it('strips the leading slash of /abs/x -> abs/x (edge — verbatim behavior, NOT null)', () => {
    expect(safeRel('/abs/x')).toBe('abs/x');
  });
});

describe('baseName', () => {
  it('strips a trailing .md from a nested path (happy)', () => {
    expect(baseName('x/y.md')).toBe('y');
  });

  it('strips a trailing .md from a flat filename (happy)', () => {
    expect(baseName('z.md')).toBe('z');
  });

  it('leaves a name without .md untouched (edge)', () => {
    expect(baseName('no-ext')).toBe('no-ext');
  });

  it('returns the last segment for a deep path (edge)', () => {
    expect(baseName('deep/a/b.md')).toBe('b');
  });
});

describe('vaultName', () => {
  it('returns the last segment of a full path (happy)', () => {
    expect(vaultName('/Users/x/Vault')).toBe('Vault');
  });

  it('ignores a trailing slash (edge)', () => {
    expect(vaultName('/Users/x/Vault/')).toBe('Vault');
  });

  it('returns the sole segment for a single-segment input (edge)', () => {
    expect(vaultName('Vault')).toBe('Vault');
  });
});
