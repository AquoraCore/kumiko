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

describe('planSync (V2.1: deletion propagates via base)', () => {
  it('deleted locally, cloud unchanged-since-base -> delCloud; pulls empty; not in newBase', () => {
    const base = { 'x.md': hashContent('v') };
    const p = planSync(base, {}, { 'x.md': 'v' });
    expect(p.delCloud.map(x => x.name)).toEqual(['x.md']);
    expect(p.pulls).toEqual([]);
    expect(p.newBase['x.md']).toBeUndefined();
  });

  it('deleted on cloud, local unchanged-since-base -> delLocal; pushes empty; not in newBase', () => {
    const base = { 'x.md': hashContent('v') };
    const q = planSync(base, { 'x.md': 'v' }, {});
    expect(q.delLocal.map(x => x.name)).toEqual(['x.md']);
    expect(q.pushes).toEqual([]);
    expect(q.newBase['x.md']).toBeUndefined();
  });

  it('DELETE-vs-EDIT (edit wins): deleted locally, cloud EDITED since base -> pull (resurrect), delCloud empty', () => {
    const p = planSync({ 'x.md': hashContent('v') }, {}, { 'x.md': 'v2-cloud-edit' });
    expect(p.pulls.map(x => x.name)).toEqual(['x.md']);
    expect(p.delCloud).toEqual([]);
  });

  it('EDIT-vs-DELETE (edit wins): local EDITED since base, cloud deleted -> push, delLocal empty', () => {
    const p = planSync({ 'x.md': hashContent('v') }, { 'x.md': 'local-edit' }, {});
    expect(p.pushes.map(x => x.name)).toEqual(['x.md']);
    expect(p.delLocal).toEqual([]);
  });

  it('FIRST-SYNC SAFETY (no base): local-only note with empty base -> push, delCloud empty', () => {
    const p = planSync({}, { 'new.md': 'N' }, {});
    expect(p.pushes.map(x => x.name)).toEqual(['new.md']);
    expect(p.delCloud).toEqual([]);
  });

  it('FIRST-SYNC SAFETY (no base): cloud-only note with empty base -> pull, delLocal empty', () => {
    const p = planSync({}, {}, { 'new.md': 'N' });
    expect(p.pulls.map(x => x.name)).toEqual(['new.md']);
    expect(p.delLocal).toEqual([]);
  });

  it('both deleted (in base, absent both sides) -> nothing anywhere; not in newBase', () => {
    const base = { 'x.md': hashContent('v') };
    const p = planSync(base, {}, {});
    expect(p.pushes).toEqual([]);
    expect(p.pulls).toEqual([]);
    expect(p.delLocal).toEqual([]);
    expect(p.delCloud).toEqual([]);
    expect(p.newBase['x.md']).toBeUndefined();
  });
});
