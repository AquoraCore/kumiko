import { describe, it, expect } from 'vitest';
import {
  tokenize,
  buildIndex,
  rank,
  cosineSim,
  rankByVector,
  fuseRRF,
  expandByLinks,
  buildContextBlock,
  composeRagPrompt,
} from '../../core/rag.js';

// -------------------------------------------------------------- tokenize
describe('tokenize (happy)', () => {
  it('lowercases and splits English words, dropping stopwords', () => {
    const toks = tokenize('The Nephron filters blood');
    expect(toks).toContain('nephron');
    expect(toks).toContain('filters');
    expect(toks).toContain('blood');
    expect(toks).not.toContain('the');
  });

  it('emits Thai character bigrams and no raw space', () => {
    const toks = tokenize('หน่วยไต กรองเลือด');
    const thaiBigrams = toks.filter((t) => /^[\u0E00-\u0E7F]{2}$/.test(t));
    expect(thaiBigrams.length).toBeGreaterThan(0);
    expect(toks).not.toContain(' ');
  });
});

describe('tokenize (edge)', () => {
  it('returns [] for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('returns [] for null/undefined', () => {
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
  });

  it('returns [] when all tokens are too short or stopwords', () => {
    expect(tokenize('a I of')).toEqual([]);
  });
});

// -------------------------------------------------------------- buildIndex + rank
describe('buildIndex + rank (happy)', () => {
  const index = buildIndex([
    { id: 'd1', text: 'nephron filters blood in the kidney' },
    { id: 'd2', text: 'the mitochondria makes atp energy' },
    { id: 'd3', text: 'kidney nephron glomerulus filtration' },
  ]);

  it('ranks docs sharing query terms, excludes unrelated docs', () => {
    const r = rank('nephron kidney', index, 3);
    const ids = r.map((x) => x.id);
    expect(ids).toContain('d1');
    expect(ids).toContain('d3');
    expect(ids).not.toContain('d2');
  });

  it('returns results sorted by score desc with every score > 0', () => {
    const r = rank('nephron kidney', index, 3);
    for (let i = 0; i < r.length; i++) expect(r[i].score).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) {
      const prev = r[i - 1].score, cur = r[i].score;
      // score desc; on tie, id asc
      if (prev !== cur) expect(prev).toBeGreaterThan(cur);
      else expect(r[i - 1].id <= r[i].id).toBe(true);
    }
  });
});

describe('buildIndex + rank (edge)', () => {
  it('buildIndex([]) returns N:0 and does not throw', () => {
    const empty = buildIndex([]);
    expect(empty.N).toBe(0);
    expect(empty.avgdl).toBe(0);
    expect(empty.df).toEqual({});
    expect(empty.docs).toEqual([]);
  });

  it('rank on empty index returns []', () => {
    expect(rank('nephron', buildIndex([]), 3)).toEqual([]);
  });

  it('rank on empty query returns []', () => {
    const index = buildIndex([{ id: 'd1', text: 'nephron filters blood' }]);
    expect(rank('', index, 3)).toEqual([]);
  });

  it('rank on stopword-only query returns []', () => {
    const index = buildIndex([{ id: 'd1', text: 'nephron filters blood' }]);
    expect(rank('the of and', index, 3)).toEqual([]);
  });

  it('a doc with no text is indexed with len 0 and never matches', () => {
    const index = buildIndex([{ id: 'x' }]);
    const d = index.docs.find((doc) => doc.id === 'x');
    expect(d.len).toBe(0);
    expect(rank('anything', index, 3)).toEqual([]);
  });
});

// -------------------------------------------------------------- expandByLinks
describe('expandByLinks (happy)', () => {
  const graph = { a: ['b'], b: ['c'] };

  it('1 hop returns seed + immediate neighbours', () => {
    expect(expandByLinks(['a'], graph, 1)).toEqual(['a', 'b']);
  });

  it('2 hops reaches further neighbours in BFS order', () => {
    expect(expandByLinks(['a'], graph, 2)).toEqual(['a', 'b', 'c']);
  });
});

describe('expandByLinks (edge)', () => {
  it('hops 0 returns only deduped seeds', () => {
    expect(expandByLinks(['a'], { a: ['b'] }, 0)).toEqual(['a']);
  });

  it('terminates on a cycle', () => {
    const cycle = { a: ['b'], b: ['a'] };
    expect(expandByLinks(['a'], cycle, 2)).toEqual(['a', 'b']);
  });

  it('unknown seed with empty graph returns just the seed', () => {
    expect(expandByLinks(['z'], {}, 1)).toEqual(['z']);
  });

  it('dedupes duplicate seeds', () => {
    expect(expandByLinks(['a', 'a'], { a: ['b'] }, 1)).toEqual(['a', 'b']);
  });
});

// -------------------------------------------------------------- buildContextBlock
describe('buildContextBlock (happy)', () => {
  it('formats an entry with [source: name] and its text', () => {
    const out = buildContextBlock([{ id: 'N', name: 'Nephron', text: 'filters blood' }], 6000);
    expect(out).toContain('[source: Nephron]');
    expect(out).toContain('filters blood');
  });
});

describe('buildContextBlock (edge)', () => {
  it('returns "" for empty input', () => {
    expect(buildContextBlock([], 6000)).toBe('');
  });

  it('truncates text exceeding budget and ends with " …"', () => {
    const out = buildContextBlock([{ id: 'X', text: 'this is a longer piece of text' }], 20);
    expect(out.endsWith(' …')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });

  it('skips entries with empty text', () => {
    const out = buildContextBlock([{ id: 'A', text: '' }, { id: 'B', text: 'kept' }], 6000);
    expect(out).toContain('kept');
    expect(out).not.toContain('[source: A]');
  });
});

// -------------------------------------------------------------- composeRagPrompt
describe('composeRagPrompt (happy)', () => {
  it('embeds question, context, โน้ต and [source: guidance', () => {
    const p = composeRagPrompt('What is a nephron?', '[source: Nephron]\nfilters blood');
    expect(p).toContain('What is a nephron?');
    expect(p).toContain('filters blood');
    expect(p).toContain('โน้ต');
    expect(p).toContain('[source:');
  });
});

describe('composeRagPrompt (edge)', () => {
  it('returns the question unchanged when context is empty', () => {
    expect(composeRagPrompt('hello', '')).toBe('hello');
  });

  it('returns the question unchanged when context is whitespace', () => {
    expect(composeRagPrompt('hello', '   ')).toBe('hello');
  });
});

// -------------------------------------------------------------- cosineSim
describe('cosineSim (happy)', () => {
  it('returns 1 for identical direction', () => {
    expect(cosineSim([1, 0], [1, 0])).toBe(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
  });

  it('returns -1 for opposite direction', () => {
    expect(cosineSim([1, 0], [-1, 0])).toBe(-1);
  });

  it('returns ~1 for same direction, different magnitude', () => {
    expect(cosineSim([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });
});

describe('cosineSim (edge)', () => {
  it('returns 0 for zero-magnitude vector', () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });

  it('returns 0 for length mismatch', () => {
    expect(cosineSim([1, 2], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for null input', () => {
    expect(cosineSim(null, [1])).toBe(0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSim([], [])).toBe(0);
  });
});

// -------------------------------------------------------------- rankByVector
describe('rankByVector (happy)', () => {
  const docVecs = [
    { id: 'a', vec: [1, 0] },
    { id: 'b', vec: [0, 1] },
    { id: 'c', vec: [0.9, 0.1] },
  ];

  it('ranks by cosine similarity: a, then c, then b for query [1,0]', () => {
    const r = rankByVector([1, 0], docVecs, 3);
    expect(r.map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });

  it('returns a numeric score on each result', () => {
    const r = rankByVector([1, 0], docVecs, 3);
    for (const x of r) expect(typeof x.score).toBe('number');
  });

  it('respects k', () => {
    expect(rankByVector([1, 0], docVecs, 2).length).toBe(2);
  });
});

describe('rankByVector (edge)', () => {
  it('returns [] for empty docVecs', () => {
    expect(rankByVector([1, 0], [], 3)).toEqual([]);
  });

  it('returns [] for invalid queryVec', () => {
    expect(rankByVector(null, [{ id: 'a', vec: [1, 0] }], 3)).toEqual([]);
  });

  it('omits a docVec with a wrong-length vec without throwing', () => {
    const r = rankByVector([1, 0], [
      { id: 'a', vec: [1, 0] },
      { id: 'bad', vec: [1, 0, 0] },
    ], 3);
    expect(r.map((x) => x.id)).toEqual(['a']);
  });
});

// -------------------------------------------------------------- fuseRRF
describe('fuseRRF (happy)', () => {
  it('fuses two ranked lists; ids in both lists outrank single-list ids', () => {
    const r = fuseRRF([['a', 'b', 'c'], ['b', 'a', 'd']]);
    const ids = r.map((x) => x.id);
    // 'a' and 'b' appear in both lists -> above 'c'/'d'
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('d'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('d'));
  });

  it('returns unique ids sorted by fused score desc', () => {
    const r = fuseRRF([['a', 'b', 'c'], ['b', 'a', 'd']]);
    const ids = r.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < r.length; i++) {
      const prev = r[i - 1].score, cur = r[i].score;
      if (prev !== cur) expect(prev).toBeGreaterThan(cur);
      else expect(r[i - 1].id <= r[i].id).toBe(true);
    }
  });

  it('accepts object items {id} as well as bare strings; b in both lists ranks first', () => {
    const r = fuseRRF([[{ id: 'a' }, { id: 'b' }], ['b']]);
    expect(r[0].id).toBe('b');
  });
});

describe('fuseRRF (edge)', () => {
  it('returns [] for empty input', () => {
    expect(fuseRRF([])).toEqual([]);
  });

  it('returns [] for a single empty list', () => {
    expect(fuseRRF([[]])).toEqual([]);
  });

  it('dedupes an id repeated across lists; score = 2/(k+0)', () => {
    const r = fuseRRF([['a'], ['a']]);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('a');
    expect(r[0].score).toBeCloseTo(2 / 60, 10);
  });

  it('respects opts.limit', () => {
    const r = fuseRRF([['a', 'b', 'c', 'd']], { limit: 1 });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('a');
  });
});
