import { describe, it, expect } from 'vitest';
import { _lcsOps, diffSegments, addLinesFromText, mergeSegments } from '../../core/textdiff.js';

describe('_lcsOps (happy)', () => {
  it('produces a mix of same/del/add ops in order for arrays with a common subsequence', () => {
    // common subsequence is [a, c]; b vs x diverges
    const ops = _lcsOps(['a','b','c'], ['a','x','c']);
    expect(ops).toEqual([
      { t:'same', line:'a' },
      { t:'del', line:'b' },
      { t:'add', line:'x' },
      { t:'same', line:'c' },
    ]);
  });
});

describe('_lcsOps (edge)', () => {
  it('identical arrays -> all "same"', () => {
    expect(_lcsOps(['a','b'], ['a','b'])).toEqual([
      { t:'same', line:'a' },
      { t:'same', line:'b' },
    ]);
  });

  it('["a"] vs [] -> one "del"', () => {
    expect(_lcsOps(['a'], [])).toEqual([{ t:'del', line:'a' }]);
  });

  it('[] vs ["a"] -> one "add"', () => {
    expect(_lcsOps([], ['a'])).toEqual([{ t:'add', line:'a' }]);
  });

  it('[] vs [] -> []', () => {
    expect(_lcsOps([], [])).toEqual([]);
  });
});

describe('diffSegments (happy)', () => {
  it('one changed line -> a "same" seg then a "hunk" seg (del+add)', () => {
    const segs = diffSegments('a\nb', 'a\nc');
    expect(segs).toEqual([
      { type:'same', lines:['a'] },
      { type:'hunk', del:['b'], add:['c'] },
    ]);
  });
});

describe('diffSegments (edge)', () => {
  it('identical text -> a single "same" segment', () => {
    expect(diffSegments('a\nb', 'a\nb')).toEqual([
      { type:'same', lines:['a','b'] },
    ]);
  });

  it('"" vs "x" -> a hunk', () => {
    const segs = diffSegments('', 'x');
    expect(segs.length).toBe(1);
    expect(segs[0].type).toBe('hunk');
    expect(segs[0].add).toEqual(['x']);
    // NOTE: ''.split('\n') === [''], so del carries an empty-string line, not [].
    expect(segs[0].del).toEqual(['']);
  });
});

describe('addLinesFromText (happy)', () => {
  it('"a\\nb" -> ["a","b"]', () => {
    expect(addLinesFromText('a\nb')).toEqual(['a','b']);
  });
});

describe('addLinesFromText (edge)', () => {
  it('"" -> []', () => {
    expect(addLinesFromText('')).toEqual([]);
  });
});

describe('mergeSegments (happy)', () => {
  const segs = [{ type:'hunk', del:['old'], add:['new'] }];

  it('accept:true with addLines -> uses the add lines', () => {
    expect(mergeSegments(segs, [{ accept:true, addLines:['NEW'] }])).toBe('NEW');
  });

  it('accept:false -> uses the del lines', () => {
    expect(mergeSegments(segs, [{ accept:false, addLines:['NEW'] }])).toBe('old');
  });
});

describe('mergeSegments (edge)', () => {
  it('all-"same" segs -> lines passed through unchanged', () => {
    const segs = [{ type:'same', lines:['a','b'] }];
    expect(mergeSegments(segs, [])).toBe('a\nb');
  });

  it('empty decisions -> default accept (uses each hunk\'s own add)', () => {
    const segs = [{ type:'hunk', del:['old'], add:['new'] }];
    expect(mergeSegments(segs, [])).toBe('new');
  });
});
