import { describe, it, expect } from 'vitest';

// Real unit tests arrive in Phase 2 once pure logic is extracted into core/ and
// becomes importable (renderer.js / main.js are not modules yet). For now this
// only proves the vitest runner is wired and green.

function add(a, b) { return a + b; }

describe('vitest smoke', () => {
  it('adds two numbers (happy)', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('handles zero and negatives (edge)', () => {
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});
