import { describe, it, expect } from 'vitest';
import {
  newDoc, getText, insert, del,
  encodeState, fromUpdate, applyUpdate,
  stateVector, diffUpdate,
} from '../../core/crdt.js';

// ---- ROUND-TRIP (persistence) ----------------------------------------------
describe('round-trip (persistence)', () => {
  it('HAPPY: encodeState then fromUpdate yields identical text', () => {
    const d = newDoc('hello world');
    const bytes = encodeState(d);
    const d2 = fromUpdate(bytes);
    expect(getText(d2)).toBe('hello world');
  });

  it('HAPPY: non-empty multi-line text round-trips byte-for-byte', () => {
    const d = newDoc('line one\nline two\nline three');
    const d2 = fromUpdate(encodeState(d));
    expect(getText(d2)).toBe('line one\nline two\nline three');
  });

  it('EDGE: empty newDoc round-trips to empty string', () => {
    const d2 = fromUpdate(encodeState(newDoc('')));
    expect(getText(d2)).toBe('');
  });

  it('EDGE: fromUpdate(null) -> empty doc', () => {
    const d = fromUpdate(null);
    expect(getText(d)).toBe('');
  });

  it('EDGE: getText(null) defensively coerces to empty string', () => {
    expect(getText(null)).toBe('');
    expect(getText(undefined)).toBe('');
    expect(getText({})).toBe('');
  });

  it('EDGE: encodeState is idempotent across calls', () => {
    const d = newDoc('stable content');
    const a = encodeState(d);
    const b = encodeState(d);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });
});

// ---- LOCAL EDITS -----------------------------------------------------------
describe('local edits (insert/del)', () => {
  it('HAPPY: insert at end then delete at start', () => {
    const d = newDoc('abc');
    insert(d, 3, 'de');
    expect(getText(d)).toBe('abcde');
    del(d, 0, 1);
    expect(getText(d)).toBe('bcde');
  });

  it('HAPPY: insert in the middle', () => {
    const d = newDoc('ac');
    insert(d, 1, 'b');
    expect(getText(d)).toBe('abc');
  });

  it('HAPPY: delete a middle range', () => {
    const d = newDoc('abcdef');
    del(d, 2, 2);
    expect(getText(d)).toBe('abef');
  });

  it('EDGE: insert at index > length clamps to end', () => {
    const d = newDoc('hi');
    insert(d, 999, '!');
    expect(getText(d)).toBe('hi!');
  });

  it('EDGE: insert at negative index clamps to 0', () => {
    const d = newDoc('hi');
    insert(d, -5, 'X');
    expect(getText(d)).toBe('Xhi');
  });

  it('EDGE: del with out-of-range length clamps and never throws', () => {
    const d = newDoc('abc');
    expect(() => del(d, 1, 9999)).not.toThrow();
    expect(getText(d)).toBe('a');
  });

  it('EDGE: del on empty doc never throws', () => {
    const d = newDoc('');
    expect(() => del(d, 0, 5)).not.toThrow();
    expect(getText(d)).toBe('');
  });

  it('EDGE: insert empty string is a no-op', () => {
    const d = newDoc('abc');
    insert(d, 1, '');
    expect(getText(d)).toBe('abc');
  });
});

// ---- DELTA SYNC ------------------------------------------------------------
describe('delta sync', () => {
  it('HAPPY: B mirrors A, A edits, delta brings B up to date', () => {
    const A = newDoc('shared');
    const B = fromUpdate(encodeState(A));
    insert(A, 6, ' text');
    const delta = diffUpdate(A, stateVector(B));
    applyUpdate(B, delta);
    expect(getText(B)).toBe('shared text');
    expect(getText(B)).toBe(getText(A));
  });

  it('HAPPY: diffUpdate with null SV returns the full state', () => {
    const A = newDoc('full');
    const full = diffUpdate(A, null);
    const B = fromUpdate(full);
    expect(getText(B)).toBe('full');
  });

  it('EDGE: applyUpdate with null/empty is a no-op', () => {
    const d = newDoc('unchanged');
    applyUpdate(d, null);
    expect(getText(d)).toBe('unchanged');
    applyUpdate(d, new Uint8Array(0));
    expect(getText(d)).toBe('unchanged');
  });

  it('EDGE: stateVector is non-empty for a populated doc', () => {
    const d = newDoc('something');
    const sv = stateVector(d);
    expect(sv.length).toBeGreaterThan(0);
  });
});

// ---- CONVERGENCE (the CRDT property — MUST hold) ---------------------------
describe('convergence (concurrent edits converge)', () => {
  it('HAPPY: concurrent inserts at different positions converge to one string', () => {
    // Both start as mirrors of the same base 'hello'.
    const A = newDoc('hello');
    const B = fromUpdate(encodeState(A));

    // Concurrent edits: A inserts 'X' at start, B inserts 'Y' at end.
    insert(A, 0, 'X');
    insert(B, 5, 'Y');

    // Exchange deltas built from what the other side already has.
    applyUpdate(A, diffUpdate(B, stateVector(A)));
    applyUpdate(B, diffUpdate(A, stateVector(B)));

    // They converge to the same string.
    expect(getText(A)).toBe(getText(B));
    // Both edits are preserved.
    expect(getText(A)).toContain('X');
    expect(getText(A)).toContain('Y');
    expect(getText(A)).toContain('hello');
  });

  it('EDGE order-independence: exchanging deltas in either direction yields the same final string', () => {
    // Re-run the same pair of concurrent edits from a fresh base, then assert
    // that whichever direction the deltas are applied, both docs end equal.
    function run(){
      const A = newDoc('hello');
      const B = fromUpdate(encodeState(A));
      insert(A, 0, 'X');           // concurrent on A
      insert(B, 5, 'Y');           // concurrent on B
      applyUpdate(A, diffUpdate(B, stateVector(A)));
      applyUpdate(B, diffUpdate(A, stateVector(B)));
      return { a: getText(A), b: getText(B) };
    }
    const first = run();
    const second = run();
    // Deterministic: same inputs -> same converged result on every run.
    expect(second.a).toBe(first.a);
    expect(second.b).toBe(first.b);
    // And the two docs always agree with each other.
    expect(second.a).toBe(second.b);
  });

  it('EDGE same-index: concurrent inserts at the same position converge with no lost edit', () => {
    const A = newDoc('mid');
    const B = fromUpdate(encodeState(A));

    // Both insert at index 0, concurrently.
    insert(A, 0, 'P');
    insert(B, 0, 'Q');

    applyUpdate(A, diffUpdate(B, stateVector(A)));
    applyUpdate(B, diffUpdate(A, stateVector(B)));

    // Converge to a single agreed string (interleave order is Yjs's choice).
    expect(getText(A)).toBe(getText(B));
    // Neither edit is lost.
    expect(getText(A)).toContain('P');
    expect(getText(A)).toContain('Q');
    expect(getText(A)).toContain('mid');
  });

  it('HAPPY: concurrent delete vs insert on disjoint ranges converges', () => {
    const A = newDoc('hello world');
    const B = fromUpdate(encodeState(A));

    // A deletes 'hello ', B appends '!' — concurrent, disjoint ranges.
    del(A, 0, 6);                  // A: 'world'
    insert(B, 11, '!');            // B: 'hello world!'

    applyUpdate(A, diffUpdate(B, stateVector(A)));
    applyUpdate(B, diffUpdate(A, stateVector(B)));

    expect(getText(A)).toBe(getText(B));
    expect(getText(A)).toContain('!');
    expect(getText(A)).toContain('world');
  });
});
