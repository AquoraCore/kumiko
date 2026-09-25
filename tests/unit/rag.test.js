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

  it('segments Thai into real words (no accidental cross-syllable bigrams)', () => {
    const toks = tokenize('หน่วยไต กรองเลือด');
    expect(toks.some((t) => /^[\u0E00-\u0E7F]{2,}$/.test(t))).toBe(true);
    expect(toks).toContain('เลือด');       // a real word, not a char pair
    expect(toks).not.toContain('งเ');      // the old bigram junk across syllables
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

// ---- P1/P2 double-injection guard (bug fixed 2026-08-17) --------------------
// The OPEN document is injected as P1 by buildPriorityContext. Ambient RAG (P2) must
// EXCLUDE it so its body is never injected a second time. These lock the `exclude`
// plumbing across the desktop chain (renderer → preload → main IPC → buildVaultContext),
// which can't be imported into node (electron / browser globals).
const _fs = require('fs');
const _path = require('path');
const _read = (p) => _fs.readFileSync(_path.join(__dirname, '../../', p), 'utf8');
describe('RAG excludes the open doc (no P1/P2 double-injection)', () => {
  it('renderer passes the open-doc basename in exclude + anchors on it', () => {
    const s = _read('renderer/renderer.js');
    expect(s).toContain('exclude, openName, docQuery, outlinks, mentions, weights: ragWeights()');
    expect(s).toMatch(/exclude\.push\(nm\)/);
    expect(s).toMatch(/exclude\.push\(base\)/);
  });
  it('preload forwards opts (incl. exclude) through the rag:context IPC', () => {
    expect(_read('preload.js')).toContain("invoke('rag:context', { question, opts: opts || {} })");
  });
  it('main buildVaultContext filters excluded basenames out of the index', () => {
    const s = _read('main.js');
    expect(s).toMatch(/async function buildVaultContext\(question, opts\)/);
    expect(s).toContain('excludeSet');
    expect(s).toMatch(/excludeSet\.has\(baseName\(rel\)\.toLowerCase\(\)\)/);
  });
});

// ---- Tiered weighted fusion (Phase 1, weights locked 2026-08-17) --------------
import { weightedRRF, fuseRag, normalizeRagWeights, DEFAULT_RAG_WEIGHTS } from '../../core/rag.js';

describe('normalizeRagWeights', () => {
  it('fills every default and overrides only provided keys', () => {
    const w = normalizeRagWeights({ explicit: 2.0, junk: 'x' });
    expect(w.explicit).toBe(2.0);
    expect(w.question).toBe(DEFAULT_RAG_WEIGHTS.question);
    expect(w).not.toHaveProperty('junk');
  });
  it('ignores non-numbers, keeps defaults', () => {
    expect(normalizeRagWeights({ doc: 'nope' }).doc).toBe(DEFAULT_RAG_WEIGHTS.doc);
    expect(normalizeRagWeights(null).question).toBe(1.0);
  });
});

describe('weightedRRF', () => {
  it('weights each list independently; rank 0 scores weight/(k+0)', () => {
    const s = weightedRRF([{ ids: ['a'], weight: 2 }, { ids: ['a'], weight: 1 }], 60);
    expect(s.a).toBeCloseTo(2 / 60 + 1 / 60, 10);
  });
});

describe('fuseRag — connection is a PRIOR that amplifies relevance, never overrides', () => {
  it('an ON-TOPIC linked note beats an OFF-TOPIC linked note (the core goal)', () => {
    const out = fuseRag({
      question: ['OnTopic'],            // relevant to the question
      doc: [],
      explicit: ['OnTopic', 'OffTopic'] // both are user-linked
    });
    const on = out.find((r) => r.id === 'OnTopic');
    const off = out.find((r) => r.id === 'OffTopic');
    expect(on.score).toBeGreaterThan(off.score);          // relevance breaks the tie
    expect(on.reason).toBe('linked');
  });

  it('explicit (tier1) outranks similar (tier3) at the same relevance', () => {
    const out = fuseRag({ question: ['X', 'Y'], explicit: ['X'], similar: ['Y'] });
    const x = out.find((r) => r.id === 'X'), y = out.find((r) => r.id === 'Y');
    // X and Y are both question hits, but X carries the tier-1 prior
    expect(x.score).toBeGreaterThan(y.score);
    expect(x.reason).toBe('linked');
  });

  it('reciprocal (two-way) links score higher than one-way', () => {
    const one = fuseRag({ question: ['A'], explicit: ['A'] });
    const two = fuseRag({ question: ['A'], explicit: ['A'], reciprocal: ['A'] });
    expect(two[0].score).toBeGreaterThan(one[0].score);
  });

  it('caps connection-ONLY notes (anti-flood) but keeps relevant ones', () => {
    // 10 linked notes, none relevant to the question → only capExplicit(4) survive
    const linked = Array.from({ length: 10 }, (_, i) => 'L' + i);
    const out = fuseRag({ question: [], doc: [], explicit: linked }, { capExplicit: 4 });
    expect(out.length).toBe(4);
    out.forEach((r) => expect(r.reason).toBe('linked'));
  });

  it('a relevant-but-unlinked note still surfaces (recall not lost)', () => {
    const out = fuseRag({ question: ['Fresh'], explicit: [] });
    expect(out.find((r) => r.id === 'Fresh')).toBeTruthy();
    expect(out.find((r) => r.id === 'Fresh').reason).toBe('question');
  });

  it('respects the limit', () => {
    const q = Array.from({ length: 20 }, (_, i) => 'Q' + i);
    expect(fuseRag({ question: q }, { limit: 5 }).length).toBe(5);
  });
});

// ---- Phase-1 channel wiring + weight-config UI (source guards) ----------------
describe('Phase-1 tiered RAG is wired end-to-end', () => {
  const R = (p) => require('fs').readFileSync(require('path').join(__dirname, '../../', p), 'utf8');
  it('renderer extracts open-doc signals (outlinks + docQuery) and passes weights', () => {
    const s = R('renderer/renderer.js');
    expect(s).toContain('function _docSignals');
    expect(s).toMatch(/outlinks/);
    expect(s).toContain('weights: ragWeights()');
    expect(s).toContain("reason: 'open'");
  });
  it('main buildVaultContext builds the 4 channels and calls fuseRag', () => {
    const s = R('main.js');
    expect(s).toContain('CoreRag.fuseRag');
    ['questionIds', 'docIds', 'explicitIds', 'reciprocalIds', 'backlinkIds'].forEach((v) => expect(s).toContain(v));
  });
  it('web ragContext mirrors the channels via _rag.fuseRag', () => {
    const s = R('web/api-web.js');
    expect(s).toContain('_rag.fuseRag');
    expect(s).toContain('backlinkIds');
    expect(s).toContain('reciprocalIds');
  });
  it('settings expose every weight as a live-tunable field with a hint + reset', () => {
    const s = R('renderer/renderer.js');
    expect(s).toContain('RAG_W_FIELDS');
    ['question', 'doc', 'explicit', 'mention', 'similar', 'reciprocity', 'capExplicit', 'limit']
      .forEach((k) => expect(s).toContain("'" + k + "'"));
    expect(s).toContain("vsSet('ragWeights'");
    expect(s).toContain('คืนค่าเริ่มต้น');   // reset button
  });
  it('the source-pill row is gone from the chat UI (removed on request)', () => {
    const s = R('renderer/chat.js');
    expect(s).not.toContain('rag-sources');
    expect(s).not.toContain('rag-src-');
    expect(R('renderer/styles.css')).not.toContain('.rag-src');
    // the retrieval side still RETURNS reasons — only the rendering was dropped
    expect(R('renderer/renderer.js')).toContain("reason: 'open'");
  });
});

// ---- detectMentions (Phase 2 — unlinked title mentions) -----------------------
import { detectMentions } from '../../core/rag.js';

describe('detectMentions', () => {
  it('finds a note title that appears verbatim (word boundary)', () => {
    expect(detectMentions('the Nephron filters blood', ['Nephron', 'Mitochondria'])).toEqual(['Nephron']);
  });
  it('is case-insensitive', () => {
    expect(detectMentions('about the nephron', ['Nephron'])).toEqual(['Nephron']);
  });
  it('does NOT match a title that is only part of a larger word', () => {
    expect(detectMentions('nephrons and atpase', ['Nephron', 'ATP'])).toEqual([]);
  });
  it('ignores titles already inside [[wikilinks]] (those are Tier 1, not mentions)', () => {
    expect(detectMentions('see [[Nephron]] here', ['Nephron'])).toEqual([]);
  });
  it('skips titles shorter than minLen', () => {
    expect(detectMentions('ไต and go', ['ไต', 'go'])).toEqual([]);   // both < 3
  });
  it('matches Thai titles by substring (no reliable word boundary)', () => {
    expect(detectMentions('เรื่องหน่วยไตของฉัน', ['หน่วยไต'])).toEqual(['หน่วยไต']);
  });
  it('dedupes and is safe on empty/null', () => {
    expect(detectMentions('Nephron Nephron', ['Nephron'])).toEqual(['Nephron']);
    expect(detectMentions(null, ['x'])).toEqual([]);
    expect(detectMentions('x', null)).toEqual([]);
  });
});

describe('fuseRag — mention (Tier 2) sits between explicit and question-only', () => {
  it('a mention outranks a plain question hit but ranks below an explicit link', () => {
    const out = fuseRag({ question: ['L', 'M', 'Q'], explicit: ['L'], mention: ['M'] });
    const score = (id) => out.find((r) => r.id === id).score;
    expect(score('L')).toBeGreaterThan(score('M'));  // explicit(1.0) > mention(0.8)
    expect(score('M')).toBeGreaterThan(score('Q'));  // mention prior > no connection
    expect(out.find((r) => r.id === 'M').reason).toBe('mention');
  });
});

describe('Phase-2 mention channel is wired end-to-end', () => {
  const R = (p) => require('fs').readFileSync(require('path').join(__dirname, '../../', p), 'utf8');
  it('renderer detects mentions in the open doc and passes them', () => {
    const s = R('renderer/renderer.js');
    expect(s).toContain('window.CoreRag.detectMentions');
    expect(s).toContain('mentions, weights: ragWeights()');
  });
  it('main + web resolve mentions + reverse-detect, into the fuseRag mention channel', () => {
    ['main.js', 'web/api-web.js'].forEach((f) => {
      const s = R(f);
      expect(s).toContain('mentionIds');
      expect(s).toContain('detectMentions(d.text, [opts.openName])');
      expect(s).toContain('mention: mentionIds');
    });
  });
});

// ---- admission threshold + one-document-one-citation --------------------------
import { docFamilyKey } from '../../core/rag.js';

describe('minRelevance — admission, not ranking (weights order; this one excludes)', () => {
  const corpus = buildIndex([
    { id: 'strong', text: 'nephron nephron nephron kidney filtration glomerulus' },
    { id: 'weak',   text: 'a long unrelated note about cooking that merely says kidney once' },
    { id: 'none',   text: 'mitochondria atp energy' },
  ]);

  it('keeps the strong match and drops the barely-overlapping one', () => {
    const all = rank('nephron kidney', corpus, 8);            // no floor -> both admitted
    expect(all.map((r) => r.id)).toContain('weak');
    const cut = rank('nephron kidney', corpus, 8, 0.25);      // floor -> noise removed
    expect(cut.map((r) => r.id)).toContain('strong');
    expect(cut.map((r) => r.id)).not.toContain('weak');
  });

  it('always keeps the top hit (a floor can never empty a non-empty result)', () => {
    const r = rank('nephron kidney', corpus, 8, 0.99);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].id).toBe('strong');
  });

  it('omitted / 0 ratio preserves the old admit-everything behaviour', () => {
    expect(rank('nephron kidney', corpus, 8, 0).length).toBe(rank('nephron kidney', corpus, 8).length);
  });

  it('connection-only notes are unaffected (they never go through BM25)', () => {
    const out = fuseRag({ question: [], explicit: ['L'] });
    expect(out.find((r) => r.id === 'L').reason).toBe('linked');
  });
});

describe('docFamilyKey — one document cited once', () => {
  it('collapses the pdf, its PDF-Text extract and its companion note', () => {
    const k = docFamilyKey('chapter10.pdf');
    expect(docFamilyKey('PDF-Text/chapter10.md')).toBe(k);
    expect(docFamilyKey('chapter10 · โน้ต.md')).toBe(k);
    expect(docFamilyKey('chapter10')).toBe(k);
  });
  it('keeps genuinely different documents apart', () => {
    expect(docFamilyKey('chapter10.pdf')).not.toBe(docFamilyKey('chapter11.pdf'));
  });
  it('is safe on null/empty', () => {
    expect(docFamilyKey(null)).toBe('');
  });
});

describe('backends dedupe by document family (incl. against the open doc)', () => {
  const R = (p) => require('fs').readFileSync(require('path').join(__dirname, '../../', p), 'utf8');
  it('main + web collapse same-document artifacts and seed with exclude', () => {
    ['main.js', 'web/api-web.js'].forEach((f) => {
      const s = R(f);
      expect(s).toContain('famSeen');
      expect(s).toContain('docFamilyKey');
    });
  });
  it('minRelevance is exposed in Settings like the other weights', () => {
    const s = R('renderer/renderer.js');
    expect(s).toContain("'minRelevance'");
    expect(s).toContain('เกณฑ์ผ่านขั้นต่ำ');
  });
});

// Bug 2026-08-18: after the relevance floor cleared the 💬 question hits, the SAME notes came
// straight back as 🔗 "mention" — because connection-only admission ignored relevance entirely.
// An open chapter mentions a dozen note titles, so those were injected into EVERY answer forever.
describe('only YOUR links may surface without matching the question', () => {
  it('a mention with no relevance to the question is NOT injected', () => {
    const out = fuseRag({ question: [], doc: [], mention: ['DFD', 'ระบบสารสนเทศ'] });
    expect(out).toEqual([]);
  });

  it('similar is a RELEVANCE channel (cosine vs the question), so it may surface on its own', () => {
    // unlike `mention`, the similar list is ranked against the question — it carries relevance
    const out = fuseRag({ question: [], similar: ['Whatever'] });
    expect(out.map((r) => r.id)).toEqual(['Whatever']);
    expect(out[0].reason).toBe('similar');
  });

  it('but an EXPLICIT link still surfaces on a vague question (user intent is evidence)', () => {
    const out = fuseRag({ question: [], explicit: ['MyLink'] });
    expect(out.map((r) => r.id)).toEqual(['MyLink']);
    expect(out[0].reason).toBe('linked');
  });

  it('a mention that IS relevant still gets its Tier-2 boost', () => {
    const out = fuseRag({ question: ['A', 'B'], mention: ['B'] });
    const a = out.find((r) => r.id === 'A'), b = out.find((r) => r.id === 'B');
    expect(b).toBeTruthy();
    expect(b.reason).toBe('mention');
    expect(b.score).toBeGreaterThan(a.score);   // boosted above the plain question hit
  });

  it('capExplicit 0 means nothing surfaces without matching the question', () => {
    expect(fuseRag({ question: [], explicit: ['L'] }, { capExplicit: 0 })).toEqual([]);
  });
});

// The OPEN document (P1) must be injected as the RELEVANT PARTS, not the whole thing and not the
// first N characters — head-truncation throws away the passage that answers the question.
import { splitPassages, selectPassages } from '../../core/rag.js';

describe('splitPassages', () => {
  it('starts a new passage at each markdown heading, keeping the heading with its body', () => {
    const p = splitPassages('# A\nbody a\n\n# B\nbody b');
    expect(p).toHaveLength(2);
    expect(p[0].text).toContain('# A');
    expect(p[0].text).toContain('body a');
    expect(p[1].text).toContain('# B');
  });
  it('is safe on empty input', () => {
    expect(splitPassages('')).toEqual([]);
  });
});

describe('selectPassages — keep what matches, in document order', () => {
  // the answer sits at the END, exactly where head-truncation would lose it
  const doc = [
    '# Intro\n' + 'filler about nothing in particular. '.repeat(60),
    '# Middle\n' + 'more unrelated padding text here. '.repeat(60),
    '# Shipping\nthe carrier receives the shipping notice and the goods',
  ].join('\n\n');

  it('returns the doc unchanged when it already fits the budget', () => {
    expect(selectPassages('short doc', 'anything', 10000)).toBe('short doc');
  });

  it('keeps the RELEVANT tail that head-truncation would have thrown away', () => {
    const out = selectPassages(doc, 'carrier shipping notice', 900);
    expect(out).toContain('carrier receives the shipping notice');
    expect(out.length).toBeLessThanOrEqual(900 + 40);
    // prove the naive approach would have failed
    expect(doc.slice(0, 900)).not.toContain('carrier receives the shipping notice');
  });

  it('marks elided regions so the model knows there are gaps', () => {
    expect(selectPassages(doc, 'carrier shipping notice', 900)).toContain('…');
  });

  it('falls back to the head when the query matches nothing (never empty context)', () => {
    const out = selectPassages(doc, 'zzzznomatch qqqq', 500);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Intro');
  });

  it('works with Thai queries', () => {
    const thai = ['# บทนำ\n' + 'ข้อความทั่วไป '.repeat(80), '# การจัดส่ง\nผู้ขนส่งรับสินค้าและใบแจ้ง'].join('\n\n');
    expect(selectPassages(thai, 'ผู้ขนส่ง', 400)).toContain('ผู้ขนส่งรับสินค้า');
  });
});

// "inject เฉพาะเรื่องที่เกี่ยวข้อง" applies EVERYWHERE, not only to long open docs.
describe('relevant-only injection across the whole prompt', () => {
  const R = (f) => require('fs').readFileSync(require('path').join(__dirname, '../../', f), 'utf8');
  it('P2 supporting notes are passage-selected per note (no whole-note dumps)', () => {
    ['main.js', 'web/api-web.js'].forEach((f) => {
      expect(R(f)).toMatch(/selectPassages\(d\.text, question, W\.noteBudget\)/);
    });
  });
  it('the question LEADS the prompt and is restated at the end (not a bottom history line)', () => {
    const s = R('renderer/renderer.js');
    expect(s).toContain("'คำถามล่าสุดของผู้ใช้: ' + msg");
    expect(s).toContain("'ตอบคำถามนี้: ' + msg");
    expect(s).toContain('บทสนทนาก่อนหน้า:');
  });
  it('history goes through historyText (no full note bodies, capped)', () => {
    expect(R('renderer/renderer.js')).toContain('window.CoreMarkdown.historyText');
  });
  it('both budgets are tunable weights with sane defaults', () => {
    expect(DEFAULT_RAG_WEIGHTS.p1Budget).toBe(12000);
    expect(DEFAULT_RAG_WEIGHTS.noteBudget).toBe(1600);
    const s = R('renderer/renderer.js');
    expect(s).toContain("'p1Budget'");
    expect(s).toContain("'noteBudget'");
  });
});

// ---- search quality: Thai words + stopwords + title indexing + incremental index ----
import { docTf, buildIndexFromTf } from '../../core/rag.js';

describe('Thai tokenization quality (the #1 source of junk injections)', () => {
  it('drops Thai function words and keeps content words', () => {
    const toks = tokenize('สรุปให้หน่อย');
    expect(toks).toContain('สรุป');
    expect(toks).not.toContain('ให้');
    expect(toks).not.toContain('หน่อย');
    expect(toks).not.toContain('รุ');      // the bigram that used to collide with unrelated notes
  });
  it('a vague Thai ask no longer matches an unrelated note', () => {
    const idx = buildIndex([
      { id: 'A', text: 'ประวัติศาสตร์กรุงศรีอยุธยา' },   // used to hit via shared \'รุ\'/\'อย\' pairs
      { id: 'B', text: 'สรุปการทดลอง และสรุปผล' },
    ]);
    const ids = rank('สรุปให้หน่อย', idx, 5).map((r) => r.id);
    expect(ids).not.toContain('A');
    expect(ids).toContain('B');
  });
});

describe('title indexing', () => {
  it('finds a note by its TITLE even when the body never repeats the word', () => {
    const idx = buildIndex([
      { id: 'dfd', title: 'DFD - Data Flow Diagram', text: 'แผนภาพการไหลของข้อมูลในระบบ' },
      { id: 'x', title: 'Other', text: 'unrelated body' },
    ]);
    expect(rank('dfd', idx, 3).map((r) => r.id)).toContain('dfd');
  });
});

describe('buildIndexFromTf — cached per-doc stats assemble the identical index', () => {
  it('matches buildIndex output exactly', () => {
    const docs = [{ id: 'a', text: 'nephron filters blood' }, { id: 'b', text: 'atp energy' }];
    const viaCache = buildIndexFromTf(docs.map((d) => Object.assign({ id: d.id }, docTf(d.text))));
    expect(viaCache).toEqual(buildIndex(docs));
  });
});

describe('incremental index + corpus cache wiring', () => {
  const R = (f) => require('fs').readFileSync(require('path').join(__dirname, '../../', f), 'utf8');
  it('main.js re-indexes only files whose signature changed', () => {
    const s = R('main.js');
    expect(s).toContain('_ragIndexCache');
    expect(s).toContain('st.mtimeMs');
    expect(s).toContain('CoreRag.docTf(text, baseName(rel))');
    expect(s).toContain('CoreRag.buildIndexFromTf(docs)');
  });
  it('web caches the fetched corpus briefly and busts it on every mutation', () => {
    const s = R('web/api-web.js');
    expect(s).toContain('_allNotesCache');
    expect((s.match(/_bustNotes\(\)/g) || []).length).toBeGreaterThanOrEqual(4);   // def + 3 mutators
    expect(s).toContain("title: _baseName(n.name)");
  });
});

// ---- anchorKind: "open" = what the user is LOOKING AT (stale-anchor fix 2026-09-25) ----
// currentNote/currentPdf are never cleared on view switches, so a note opened once kept
// injecting [ความสำคัญสูงสุด] + anchoring RAG from every other view. anchorKind maps the
// #left DOM class to the visible document kind.
import { anchorKind } from '../../core/rag.js';

describe('anchorKind (happy)', () => {
  it('note editor (no view-* class) -> note, incl. rules-mode', () => {
    expect(anchorKind('')).toBe('note');
    expect(anchorKind('rules-mode')).toBe('note');
  });
  it('view-pdf -> pdf', () => {
    expect(anchorKind('view-pdf')).toBe('pdf');
  });
  it('other view-* -> null (no visible document)', () => {
    ['view-graph', 'view-canvas', 'view-table', 'view-dash', 'view-crate', 'view-trash', 'view-tag']
      .forEach((c) => expect(anchorKind(c)).toBe(null));
  });
});

describe('anchorKind (edge)', () => {
  it('mixed classes: view-pdf wins over everything else', () => {
    expect(anchorKind('view-canvas rules-mode view-pdf')).toBe('pdf');
  });
  it('mixed classes: another view alongside junk -> null', () => {
    expect(anchorKind('view-canvas rules-mode')).toBe(null);
  });
  it('empty / undefined -> note (safe default matching old behaviour)', () => {
    expect(anchorKind('')).toBe('note');
    expect(anchorKind(undefined)).toBe('note');
    expect(anchorKind(null)).toBe('note');
  });
  it('does not match a class that merely contains the token as a substring', () => {
    expect(anchorKind('xview-pdf')).toBe('note');
    expect(anchorKind('view-canvas2')).toBe('note');
  });
  it('extra whitespace between classes is fine', () => {
    expect(anchorKind('  view-canvas   rules-mode  ')).toBe(null);
  });
});

describe('buildPriorityContext gates P1 on the VISIBLE view (source scan)', () => {
  const R = (f) => require('fs').readFileSync(require('path').join(__dirname, '../../', f), 'utf8');
  it('decides the anchor from the #left DOM class via CoreRag.anchorKind (web parity)', () => {
    const s = R('renderer/renderer.js');
    expect(s).toContain('window.CoreRag.anchorKind');
    expect(s).toContain("document.getElementById('left')");
    expect(s).toContain("lf ? lf.className : ''");
  });
  it('P1 note block is gated by kind === note', () => {
    expect(R('renderer/renderer.js')).toMatch(/kind === 'note' && currentNote/);
  });
  it('P1 pdf block is gated by kind === pdf (PDF must be actually shown)', () => {
    expect(R('renderer/renderer.js')).toMatch(/kind === 'pdf' && typeof currentPdf === 'string' && currentPdf/);
  });
  it('ragAmbient path untouched — ambient RAG still always runs', () => {
    expect(R('renderer/renderer.js')).toContain("if (vsGet('ragAmbient', true))");
    expect(R('renderer/renderer.js')).toContain('exclude, openName, docQuery, outlinks, mentions, weights: ragWeights()');
  });
  it('over-cite fix: the prompt header forbids citing unrelated context', () => {
    expect(R('renderer/renderer.js')).toContain('ห้ามอ้างถึงหรือดึงเนื้อหาจากมัน');
  });
  it('anchorKind is exported from core (Node + window.CoreRag UMD)', () => {
    expect(typeof anchorKind).toBe('function');
  });
});
