import { describe, it, expect } from 'vitest';
import { _lev, _sim } from '../../core/textsim.js';

describe('_lev (happy)', () => {
  it("'cat','cat' === 0", () => {
    expect(_lev('cat', 'cat')).toBe(0);
  });
  it("'cat','bat' === 1", () => {
    expect(_lev('cat', 'bat')).toBe(1);
  });
  it("'','abc' === 3", () => {
    expect(_lev('', 'abc')).toBe(3);
  });
});

describe('_lev (edge)', () => {
  it("'','' === 0", () => {
    expect(_lev('', '')).toBe(0);
  });
});

describe('_sim (happy)', () => {
  it("'nephron','nephron' === 1", () => {
    expect(_sim('nephron', 'nephron')).toBe(1);
  });
  it("'Nephron','nephron' === 1 (case-insensitive)", () => {
    expect(_sim('Nephron', 'nephron')).toBe(1);
  });
  it("'neph','nephron' >= 0.72 (substring boost)", () => {
    expect(_sim('neph', 'nephron')).toBeGreaterThanOrEqual(0.72);
  });
  it("'abc','xyz' is low (< 0.42)", () => {
    expect(_sim('abc', 'xyz')).toBeLessThan(0.42);
  });
});

describe('_sim (edge)', () => {
  it("'','x' === 0", () => {
    expect(_sim('', 'x')).toBe(0);
  });
  it("'x','' === 0", () => {
    expect(_sim('x', '')).toBe(0);
  });
});
