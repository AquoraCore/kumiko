import { describe, it, expect } from 'vitest';
const { planSync, hashContent } = require('../../core/sync');

describe('planSync (happy: new notes on each side push/pull; identical skip)', () => {
  it('pushes local-only, pulls cloud-only, skips identical, sets newBase', () => {
    const base = {};
    const local = { 'a.md': 'A', 'both.md': 'X' };
    const cloud = { 'b.md': 'B', 'both.md': 'X' };
    const p = planSync(base, local, cloud);
    expect(p.pushes.map(x => x.name)).toEqual(['a.md']);
    expect(p.pulls.map(x => x.name)).toEqual(['b.md']);
    expect(p.conflicts).toEqual([]);
    expect(p.newBase['both.md']).toBe(hashContent('X'));
  });
});

describe('planSync (edge: one-sided change push/pull; two-sided conflict)', () => {
  const base = { 'n.md': hashContent('orig') };

  it('local changed, cloud same-as-base -> push', () => {
    const p1 = planSync(base, { 'n.md': 'local-edit' }, { 'n.md': 'orig' });
    expect(p1.pushes[0].content).toBe('local-edit');
    expect(p1.pulls).toEqual([]);
  });

  it('cloud changed, local same -> pull', () => {
    const p2 = planSync(base, { 'n.md': 'orig' }, { 'n.md': 'cloud-edit' });
    expect(p2.pulls[0].content).toBe('cloud-edit');
    expect(p2.pushes).toEqual([]);
  });

  it('both changed differently -> conflict', () => {
    const p3 = planSync(base, { 'n.md': 'L' }, { 'n.md': 'C' });
    expect(p3.conflicts.length).toBe(1);
    expect(p3.conflicts[0]).toEqual({ name: 'n.md', localContent: 'L', cloudContent: 'C' });
  });
});

describe('planSync (edge: deletion NOT propagated in v1 -> re-push/re-pull to keep)', () => {
  const base = { 'x.md': hashContent('v') };

  it('deleted locally, still on cloud unchanged -> re-pull', () => {
    const p = planSync(base, {}, { 'x.md': 'v' });
    expect(p.pulls.map(x => x.name)).toEqual(['x.md']);
  });

  it('deleted on cloud, still local unchanged -> re-push', () => {
    const q = planSync(base, { 'x.md': 'v' }, {});
    expect(q.pushes.map(x => x.name)).toEqual(['x.md']);
  });
});
