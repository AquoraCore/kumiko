// Shared core: pure retrieval engine for RAG (tokenize + BM25 rank + link expansion + context + prompt).
// Side-effect-free: no fs/path, no I/O, no timers, no randomness. Caller passes docs IN.
// UMD: Node (module.exports) + browser (window.CoreRag).
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CoreRag = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // small inline English stopword set (kept tiny on purpose)
  var STOP = {
    the: 1, a: 1, an: 1, is: 1, are: 1, was: 1, were: 1, of: 1, to: 1, and: 1, or: 1,
    in: 1, on: 1, for: 1, with: 1, at: 1, by: 1, as: 1, it: 1, this: 1, that: 1, be: 1, from: 1
  };

  // Thai function words. With real word segmentation these dominate every query/doc and match
  // everything ("\u0E2A\u0E23\u0E38\u0E1B\u0E43\u0E2B\u0E49\u0E2B\u0E19\u0E48\u0E2D\u0E22" is mostly function words) \u2014 drop them like the English STOP set.
  var THAI_STOP = {
    '\u0E17\u0E35\u0E48': 1, '\u0E01\u0E32\u0E23': 1, '\u0E02\u0E2D\u0E07': 1, '\u0E43\u0E2B\u0E49': 1, '\u0E44\u0E14\u0E49': 1, '\u0E41\u0E25\u0E30': 1, '\u0E2B\u0E23\u0E37\u0E2D': 1, '\u0E43\u0E19': 1, '\u0E40\u0E1B\u0E47\u0E19': 1,
    '\u0E21\u0E35': 1, '\u0E27\u0E48\u0E32': 1, '\u0E08\u0E32\u0E01': 1, '\u0E01\u0E47': 1, '\u0E08\u0E30': 1, '\u0E44\u0E21\u0E48': 1, '\u0E01\u0E31\u0E1A': 1, '\u0E41\u0E15\u0E48': 1, '\u0E19\u0E35\u0E49': 1,
    '\u0E19\u0E31\u0E49\u0E19': 1, '\u0E2D\u0E22\u0E39\u0E48': 1, '\u0E2D\u0E22\u0E48\u0E32\u0E07': 1, '\u0E15\u0E49\u0E2D\u0E07': 1, '\u0E16\u0E36\u0E07': 1, '\u0E40\u0E1E\u0E37\u0E48\u0E2D': 1, '\u0E40\u0E21\u0E37\u0E48\u0E2D': 1, '\u0E04\u0E37\u0E2D': 1,
    '\u0E42\u0E14\u0E22': 1, '\u0E41\u0E25\u0E49\u0E27': 1, '\u0E22\u0E31\u0E07': 1, '\u0E14\u0E49\u0E27\u0E22': 1, '\u0E2B\u0E19\u0E48\u0E2D\u0E22': 1, '\u0E04\u0E23\u0E31\u0E1A': 1, '\u0E04\u0E48\u0E30': 1, '\u0E19\u0E30': 1
  };
  // Real Thai word segmentation via Intl.Segmenter (ICU \u2014 ships with Node, Electron, and every
  // modern browser). null when unavailable, and tokenize falls back to character bigrams.
  var _thSeg, _thSegReady = false;
  function _thaiWords(run) {
    if (!_thSegReady) {
      _thSegReady = true;
      try { if (typeof Intl !== 'undefined' && Intl.Segmenter) _thSeg = new Intl.Segmenter('th', { granularity: 'word' }); } catch (_) { _thSeg = null; }
    }
    if (!_thSeg) return null;
    try {
      var out = [];
      var it = _thSeg.segment(run)[Symbol.iterator](), n;
      while (!(n = it.next()).done) {
        var seg = n.value;
        if (seg.isWordLike && seg.segment.length >= 2 && !THAI_STOP[seg.segment]) out.push(seg.segment);
      }
      return out;
    } catch (_) { return null; }
  }

  // -------------------------------------------------------------- tokenize
  // Lowercase, then: maximal [a-z0-9] runs (len>=2, non-stopword) as whole tokens; maximal Thai
  // runs as REAL WORDS (Intl.Segmenter, minus THAI_STOP). Character bigrams remain only as the
  // no-ICU fallback \u2014 they matched by accident ("\u0E2A\u0E23\u0E38\u0E1B\u0E43\u0E2B\u0E49\u0E2B\u0E19\u0E48\u0E2D\u0E22" hit unrelated notes via the
  // shared '\u0E23\u0E38'/'\u0E2D\u0E22' pairs), which was the main source of junk injections.
  // Duplicates KEPT (term frequency matters). Everything else is a separator.
  function tokenize(text) {
    var s = typeof text === 'string' ? text : '';
    s = s.toLowerCase();
    var tokens = [];
    var re = /([a-z0-9]+)|([\u0E00-\u0E7F]+)/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) { // latin / digit run
        var w = m[1];
        if (w.length >= 2 && !STOP[w]) tokens.push(w);
      } else if (m[2]) { // thai run
        var run = m[2];
        var words = _thaiWords(run);
        if (words) {
          for (var wi = 0; wi < words.length; wi++) tokens.push(words[wi]);
        } else if (run.length === 1) {
          tokens.push(run);
        } else {
          for (var i = 0; i < run.length - 1; i++) tokens.push(run.substring(i, i + 2));
        }
      }
    }
    return tokens;
  }

  // -------------------------------------------------------------- index building
  // Per-doc term stats. TITLE tokens count DOUBLE — a note's name is its strongest keyword, and
  // until now it wasn't indexed at all: a note titled "DFD - Data Flow Diagram" whose body never
  // repeats "DFD" was simply unfindable by that word.
  function docTf(text, title) {
    var toks = tokenize(typeof text === 'string' ? text : '');
    var titleToks = tokenize(typeof title === 'string' ? title : '');
    for (var i = 0; i < titleToks.length; i++) { toks.push(titleToks[i]); toks.push(titleToks[i]); }
    var tf = {};
    for (var j = 0; j < toks.length; j++) tf[toks[j]] = (tf[toks[j]] || 0) + 1;
    return { tf: tf, len: toks.length };
  }

  // Assemble an index from precomputed per-doc stats — lets callers CACHE docTf per file and skip
  // re-reading + re-tokenizing the whole vault on every single question (incremental indexing).
  function buildIndexFromTf(entries) {
    var out = { N: 0, avgdl: 0, df: {}, docs: [] };
    if (!Array.isArray(entries)) return out;
    var sumLen = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e || e.id == null || String(e.id) === '' || !e.tf) continue;
      for (var term in e.tf) {
        if (Object.prototype.hasOwnProperty.call(e.tf, term)) out.df[term] = (out.df[term] || 0) + 1;
      }
      var len = (typeof e.len === 'number' && isFinite(e.len)) ? e.len : 0;
      out.docs.push({ id: String(e.id), tf: e.tf, len: len });
      sumLen += len;
    }
    out.N = out.docs.length;
    out.avgdl = out.N > 0 ? sumLen / out.N : 0;
    return out;
  }

  // docs: [{ id, text, title? }]. Returns { N, avgdl, df, docs:[{id, tf, len}] }.
  function buildIndex(docs) {
    if (!Array.isArray(docs)) return buildIndexFromTf(null);
    var entries = [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.id == null || String(d.id) === '') continue;
      var s = docTf(d.text, d.title);
      entries.push({ id: String(d.id), tf: s.tf, len: s.len });
    }
    return buildIndexFromTf(entries);
  }

  // -------------------------------------------------------------- rank (BM25)
  // query: raw string. k default 6. Returns [{ id, score }] desc, id asc tie-break, score>0 only.
  // minRatio (optional, 0..1): ADMISSION cut on the raw BM25 spread — keep only docs scoring at
  // least minRatio × the top score. `score > 0` alone admits any single term overlap (Thai
  // char-bigrams collide by accident), which otherwise fills the caller's limit with noise.
  // Applied here, not after RRF: fusion compresses scores to ~1/(k+rank), where a ratio is moot.
  function rank(query, index, k, minRatio) {
    if (!index || index.N === 0) return [];
    var qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    if (typeof k !== 'number' || !isFinite(k) || k <= 0) k = 6;
    var k1 = 1.5, b = 0.75;
    var N = index.N, avgdl = index.avgdl, df = index.df;
    // dedupe query terms
    var qSet = {}, qList = [];
    for (var qi = 0; qi < qTerms.length; qi++) {
      if (!qSet[qTerms[qi]]) { qSet[qTerms[qi]] = 1; qList.push(qTerms[qi]); }
    }
    var results = [];
    for (var di = 0; di < index.docs.length; di++) {
      var doc = index.docs[di];
      var score = 0;
      for (var qj = 0; qj < qList.length; qj++) {
        var term = qList[qj];
        var f = doc.tf[term] || 0;
        if (f === 0) continue;
        var dft = df[term] || 0;
        var idf = Math.log((N - dft + 0.5) / (dft + 0.5) + 1); // always >= 0
        var denom = f + k1 * (1 - b + b * (avgdl > 0 ? doc.len / avgdl : 0));
        score += idf * (f * (k1 + 1)) / denom;
      }
      if (score > 0) results.push({ id: doc.id, score: score });
    }
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    if (typeof minRatio === 'number' && isFinite(minRatio) && minRatio > 0 && results.length) {
      var floorScore = results[0].score * minRatio;
      results = results.filter(function (r) { return r.score >= floorScore; });
    }
    if (results.length > k) results.length = k;
    return results;
  }

  // -------------------------------------------------------------- cosineSim
  // Cosine similarity of two numeric vectors -> [-1,1]. 0 on any invalid input,
  // length mismatch, or zero magnitude (divide-by-zero guard). Non-finite -> 0.
  function cosineSim(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    var sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
    return isFinite(sim) ? sim : 0;
  }

  // -------------------------------------------------------------- rankByVector
  // Rank docs by cosine(queryVec, docVec). Returns [{ id, score }] desc, id asc.
  // No score>0 filter (cosine has no natural zero); docs with wrong-length vec are omitted.
  function rankByVector(queryVec, docVecs, k) {
    if (!Array.isArray(queryVec) || queryVec.length === 0 || !Array.isArray(docVecs) || docVecs.length === 0) return [];
    if (typeof k !== 'number' || !isFinite(k) || k <= 0) k = 6;
    var results = [];
    for (var i = 0; i < docVecs.length; i++) {
      var dv = docVecs[i];
      if (!dv || !Array.isArray(dv.vec) || dv.vec.length !== queryVec.length) continue;
      results.push({ id: String(dv.id), score: cosineSim(queryVec, dv.vec) });
    }
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    if (results.length > k) results.length = k;
    return results;
  }

  // -------------------------------------------------------------- fuseRRF
  // Reciprocal Rank Fusion across ranked lists. score(id) = sum over lists of 1/(k+rank).
  // Items are bare id strings or {id}. null/empty lists and null ids ignored. limit caps output.
  function fuseRRF(lists, opts) {
    if (!Array.isArray(lists)) return [];
    opts = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    var k = (typeof opts.k === 'number' && isFinite(opts.k) && opts.k > 0) ? opts.k : 60;
    var limit = (typeof opts.limit === 'number' && isFinite(opts.limit) && opts.limit > 0) ? opts.limit : 8;
    var scores = {};
    for (var li = 0; li < lists.length; li++) {
      var list = lists[li];
      if (!Array.isArray(list)) continue;
      for (var ri = 0; ri < list.length; ri++) {
        var item = list[ri];
        var id = (item != null && typeof item === 'object') ? item.id : item;
        if (id == null) continue;
        id = String(id);
        scores[id] = (scores[id] || 0) + 1 / (k + ri);
      }
    }
    var results = [];
    for (var key in scores) {
      if (Object.prototype.hasOwnProperty.call(scores, key)) results.push({ id: key, score: scores[key] });
    }
    results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
    if (results.length > limit) results.length = limit;
    return results;
  }

  // -------------------------------------------------------------- tiered RAG fusion
  // Default injection weights (locked 2026-08-17). Two orthogonal axes:
  //  - RELEVANCE: how much a note matches what's being asked/viewed (question + open doc).
  //  - CONNECTION: how strongly it's linked, as a PRIOR (user intent > system guess).
  // final = relevance * (1 + connectionPrior). A pure-connection note (relevance 0) still gets a
  // small floor so a strong link can surface for a vague question — but those are capped
  // (capExplicit) so a heavily-linked note never floods the context. All tunable in Settings.
  var DEFAULT_RAG_WEIGHTS = {
    question: 1.0,    // BM25 on the current question (Q_now) — what you're asking right now
    doc: 0.6,         // BM25 on the OPEN document's key terms (Q_doc) — anchors to what you're viewing
    explicit: 1.0,    // Tier 1 — [[wikilinks]] + backlinks the USER wrote (ground-truth intent)
    mention: 0.8,     // Tier 2 — unlinked mentions: text names an existing note title exactly [phase 2]
    similar: 0.4,     // Tier 3 — semantic similarity: system guess, no explicit signal [phase 4]
    reciprocity: 1.2, // multiplier when a link is two-way (A↔B), i.e. mutually referenced
    capExplicit: 4,   // max connection-ONLY notes (relevance 0) injected — anti-flood
    connFloor: 0.02,  // relevance floor given to a pure-connection note so links can still surface
    // ADMISSION threshold, not a ranking weight: a note must reach this FRACTION of the best
    // relevance score or it's dropped as noise. Without it BM25 admits any term overlap (Thai
    // char-bigrams overlap by accident), so the limit always fills up with weak matches.
    // 0 = admit everything (old behaviour); higher = stricter/fewer.
    minRelevance: 0.25,
    // Context budgets (chars). Over budget -> selectPassages keeps only what matches the question;
    // under budget the doc/note goes whole (the relevance unit has a floor — a screenful-sized note
    // that was ADMITTED for relevance IS the relevant passage; slicing smaller strands sentences).
    p1Budget: 12000,  // the OPEN document (P1)
    noteBudget: 1600, // each supporting note (P2)
    rrfK: 60,         // RRF smoothing constant (higher = flatter rank weighting)
    limit: 8          // max notes returned to the context builder
  };
  function _num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function normalizeRagWeights(w) {
    var s = (w && typeof w === 'object' && !Array.isArray(w)) ? w : {};
    var out = {};
    for (var key in DEFAULT_RAG_WEIGHTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_RAG_WEIGHTS, key)) out[key] = _num(s[key], DEFAULT_RAG_WEIGHTS[key]);
    }
    return out;
  }

  // Weighted Reciprocal Rank Fusion. lists: [{ ids:[...], weight:n }]. score(id) = Σ weight/(k+rank).
  function weightedRRF(lists, k) {
    k = _num(k, 60);
    var scores = {};
    if (!Array.isArray(lists)) return scores;
    for (var li = 0; li < lists.length; li++) {
      var entry = lists[li]; if (!entry || !Array.isArray(entry.ids)) continue;
      var w = _num(entry.weight, 1);
      for (var ri = 0; ri < entry.ids.length; ri++) {
        var id = entry.ids[ri]; if (id == null) continue; id = String(id);
        scores[id] = (scores[id] || 0) + w / (k + ri);
      }
    }
    return scores;
  }

  // Fuse the retrieval channels into one ranked, labelled list.
  // channels: { question:[ids], doc:[ids], explicit:[ids], mention:[ids], similar:[ids], reciprocal:[ids] }
  //   question/doc/similar are RANK-ORDERED; explicit/mention are connection sets (order = proximity).
  // Returns [{ id, score, reason }] where reason ∈ linked|mention|question|doc|similar.
  function fuseRag(channels, weights) {
    var c = (channels && typeof channels === 'object') ? channels : {};
    var w = normalizeRagWeights(weights);
    var q = Array.isArray(c.question) ? c.question.map(String) : [];
    var d = Array.isArray(c.doc) ? c.doc.map(String) : [];
    var explicit = {}, mention = {}, similarSet = {};
    (Array.isArray(c.explicit) ? c.explicit : []).forEach(function (x) { if (x != null) explicit[String(x)] = 1; });
    (Array.isArray(c.mention) ? c.mention : []).forEach(function (x) { if (x != null) mention[String(x)] = 1; });
    (Array.isArray(c.similar) ? c.similar : []).forEach(function (x) { if (x != null) similarSet[String(x)] = 1; });
    var recip = {};
    (Array.isArray(c.reciprocal) ? c.reciprocal : []).forEach(function (x) { if (x != null) recip[String(x)] = 1; });

    // RELEVANCE axis: fuse the question + open-doc BM25 lists.
    var rel = weightedRRF([{ ids: q, weight: w.question }, { ids: d, weight: w.doc }], w.rrfK);
    // include the similar channel as a (weak) relevance signal too, rank-ordered
    var simRRF = weightedRRF([{ ids: Array.isArray(c.similar) ? c.similar : [], weight: w.similar }], w.rrfK);

    // universe = everything that appeared in ANY channel
    var ids = {};
    q.forEach(function (id) { ids[id] = 1; }); d.forEach(function (id) { ids[id] = 1; });
    Object.keys(explicit).forEach(function (id) { ids[id] = 1; });
    Object.keys(mention).forEach(function (id) { ids[id] = 1; });
    Object.keys(similarSet).forEach(function (id) { ids[id] = 1; });

    var rows = [];
    for (var id in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
      var relevance = (rel[id] || 0) + (simRRF[id] || 0);
      // connection prior = strongest tier this note belongs to
      var conn = 0, reason;
      if (explicit[id]) { conn = w.explicit; reason = 'linked'; }
      else if (mention[id]) { conn = w.mention; reason = 'mention'; }
      else if (similarSet[id]) { conn = w.similar; reason = 'similar'; }
      if (conn > 0 && recip[id]) conn *= w.reciprocity;
      // reason for relevance-only notes: question rank beats doc rank
      if (!reason) reason = (q.indexOf(id) >= 0) ? 'question' : (d.indexOf(id) >= 0 ? 'doc' : 'similar');
      // A note with NO relevance to the question may still be injected — but ONLY on the strength
      // of a link the USER made (Tier 1). System-guessed ties (mention = a title happens to appear
      // in the text; similar = embedding proximity) are priors that AMPLIFY relevance, never an
      // admission ticket of their own: an open chapter mentions a dozen titles, and letting those
      // in unconditionally injected the same notes into every single answer, forever.
      var connectionOnly = relevance <= 0 && conn > 0;
      if (connectionOnly && !explicit[id]) continue;
      var score = connectionOnly ? (w.connFloor * conn) : (relevance * (1 + conn));
      if (score <= 0) continue;
      rows.push({ id: id, score: score, reason: reason, connectionOnly: connectionOnly });
    }
    rows.sort(function (a, b) { return (b.score !== a.score) ? b.score - a.score : (a.id < b.id ? -1 : 1); });

    // NOTE: admission by minRelevance happens in rank() on the RAW BM25 scores, NOT here — RRF
    // compresses everything into ~1/(k+rank), so a relative floor on fused scores is meaningless.

    // anti-flood: cap the number of connection-ONLY notes (a strongly-linked doc must not crowd out answers)
    var capN = w.capExplicit, kept = [], connCount = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].connectionOnly) { if (connCount >= capN) continue; connCount++; }
      kept.push({ id: rows[i].id, score: rows[i].score, reason: rows[i].reason });
      if (kept.length >= w.limit) break;
    }
    return kept;
  }

  // One source document can exist in the vault as SEVERAL files: the PDF itself, the extracted
  // `PDF-Text/<name>.md` the indexer writes, and the `<name> · โน้ต.md` companion note. Citing all
  // three is the same document three times. This collapses them to one key so callers can dedupe.
  function docFamilyKey(name) {
    var s = String(name == null ? '' : name).toLowerCase().trim();
    s = s.split('/').pop();                       // drop any folder (e.g. PDF-Text/)
    s = s.replace(/\.(md|pdf)$/, '');
    s = s.replace(/\s*·\s*โน้ต$/, '');            // companion-note suffix
    return s.trim();
  }

  // -------------------------------------------------------------- anchorKind
  // What document is the user ACTUALLY looking at? #left's className carries the active view
  // (setMainView toggles view-* classes; the note editor has none). currentNote/currentPdf are
  // never cleared on view switches, so without this a note opened once kept anchoring every
  // later answer from canvas/dashboard/etc. Decide from the DOM — the shared (desktop+web)
  // source of truth, not a desktop-only variable.
  //   contains 'view-pdf'      -> 'pdf'  (a PDF is on screen)
  //   any other view-*         -> null   (graph/canvas/table/dash/crate/trash/tag — nothing open)
  //   otherwise                -> 'note' (note editor, incl. rules-mode; empty/undefined too —
  //                                        safe default matching the old behaviour)
  function anchorKind(viewClassName) {
    var s = (typeof viewClassName === 'string') ? viewClassName : '';
    var cls = s.split(/\s+/);
    if (cls.indexOf('view-pdf') >= 0) return 'pdf';
    var otherViews = { 'view-graph': 1, 'view-canvas': 1, 'view-table': 1, 'view-dash': 1, 'view-crate': 1, 'view-trash': 1, 'view-tag': 1 };
    for (var i = 0; i < cls.length; i++) if (otherViews[cls[i]]) return null;
    return 'note';
  }

  // -------------------------------------------------------------- passage selection
  // Split a document into retrievable passages. Markdown headings start a new passage (and stay
  // attached to their body, so a passage still says what it is about); anything still oversized is
  // cut further at blank lines. Returns [{ text }] in document order.
  function splitPassages(text, opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var maxLen = _num(opts.maxPassage, 1200);
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var parts = [], buf = [], bufLen = 0;
    function flush() {
      if (!buf.length) return;
      var t = buf.join('\n').trim();
      if (t !== '') parts.push({ text: t });
      buf = []; bufLen = 0;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var isHeading = /^#{1,6}\s/.test(line);
      // a heading always opens a new passage; an oversized passage breaks at a blank line
      if ((isHeading && bufLen > 0) || (bufLen >= maxLen && line.trim() === '')) flush();
      buf.push(line); bufLen += line.length + 1;
    }
    flush();
    return parts;
  }

  // Pick the passages of `text` most relevant to `query`, within `budget` characters, and return
  // them in DOCUMENT order with '…' marking what was left out. The whole point: an open PDF can be
  // hundreds of KB, and neither dumping it nor head-truncating it is right — head-truncation
  // silently throws away the part that actually answers the question.
  //   - fits inside the budget -> returned unchanged (small notes behave exactly as before)
  //   - query matches nothing  -> falls back to the head, so there is always some context
  function selectPassages(text, query, budget, opts) {
    var s = String(text == null ? '' : text);
    budget = _num(budget, 12000);
    if (s.length <= budget) return s;
    var parts = splitPassages(s, opts);
    if (parts.length <= 1) return s.slice(0, budget) + '\n\n…';
    var docs = [];
    for (var i = 0; i < parts.length; i++) docs.push({ id: String(i), text: parts[i].text });
    var ranked = rank(query, buildIndex(docs), parts.length);
    var chosen = {}, used = 0, any = false;
    for (var r = 0; r < ranked.length; r++) {
      var idx = parseInt(ranked[r].id, 10);
      var len = parts[idx].text.length + 2;
      if (used + len > budget) continue;          // skip, keep trying smaller ones
      chosen[idx] = 1; used += len; any = true;
    }
    if (!any) return s.slice(0, budget) + '\n\n…';
    var out = [], prev = -1;
    for (var j = 0; j < parts.length; j++) {
      if (!chosen[j]) continue;
      // '…' wherever passages were dropped — leading, between, and trailing — so the model can
      // tell it is reading excerpts of a longer document rather than the whole thing.
      if (prev < 0 ? j > 0 : j !== prev + 1) out.push('…');
      out.push(parts[j].text);
      prev = j;
    }
    if (prev >= 0 && prev !== parts.length - 1) out.push('…');
    return out.join('\n\n');
  }

  // -------------------------------------------------------------- detectMentions
  // Phase-2 implicit graph (Tier 2): find note TITLES that appear verbatim in `text` but are NOT
  // already [[wikilinked]] — an "unlinked mention". This is the auto/background link layer that
  // connects PDFs (which carry no [[links]]) to notes. Pure + cheap so it runs per-query.
  //  - explicit [[...]] spans are stripped first (those are Tier 1, not Tier 2).
  //  - Latin/mixed titles require word boundaries (no substring-of-a-word false hits).
  //  - Thai/CJK titles fall back to substring (no reliable word boundary); length gate cuts noise.
  //  - titles shorter than minLen are skipped (too common → noisy).
  function detectMentions(text, titles, opts) {
    var s = String(text == null ? '' : text);
    if (!s || !Array.isArray(titles)) return [];
    opts = (opts && typeof opts === 'object') ? opts : {};
    var minLen = _num(opts.minLen, 3);
    var cap = _num(opts.cap, 2000);            // safety bound on titles scanned
    s = s.replace(/\[\[[^\]]*\]\]/g, ' ');     // drop explicit links so they don't count as mentions
    var lower = s.toLowerCase();
    var out = [], seen = {};
    for (var i = 0; i < titles.length && i < cap; i++) {
      if (titles[i] == null) continue;
      var title = String(titles[i]).trim();
      if (title.length < minLen) continue;
      var tl = title.toLowerCase();
      if (seen[tl]) continue;
      var hit = false;
      if (/[a-z0-9]/i.test(title)) {           // latin/mixed → require boundaries
        var idx = lower.indexOf(tl);
        while (idx >= 0) {
          var before = idx === 0 ? '' : lower.charAt(idx - 1);
          var after = (idx + tl.length >= lower.length) ? '' : lower.charAt(idx + tl.length);
          if (!/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after)) { hit = true; break; }
          idx = lower.indexOf(tl, idx + 1);
        }
      } else {                                  // thai/other → substring (boundary unreliable)
        hit = lower.indexOf(tl) >= 0;
      }
      if (hit) { seen[tl] = 1; out.push(title); }
    }
    return out;
  }

  // -------------------------------------------------------------- expandByLinks
  // seedIds first (deduped, in order), then BFS neighbours within `hops` hops.
  function expandByLinks(seedIds, linkGraph, hops) {
    var graph = (linkGraph && typeof linkGraph === 'object' && !Array.isArray(linkGraph)) ? linkGraph : {};
    if (typeof hops !== 'number' || !isFinite(hops)) hops = 1;
    if (hops < 0) hops = 0;
    var visited = {}, result = [];
    if (Array.isArray(seedIds)) {
      for (var i = 0; i < seedIds.length; i++) {
        var id = seedIds[i];
        if (id == null) continue;
        var key = String(id);
        if (!visited[key]) { visited[key] = 1; result.push(key); }
      }
    }
    if (hops === 0) return result;
    var frontier = result.slice();
    for (var h = 0; h < hops; h++) {
      var next = [];
      for (var fi = 0; fi < frontier.length; fi++) {
        var neighbours = graph[frontier[fi]];
        if (!Array.isArray(neighbours)) continue;
        for (var ni = 0; ni < neighbours.length; ni++) {
          var nb = neighbours[ni];
          if (nb == null) continue;
          var nkey = String(nb);
          if (!visited[nkey]) { visited[nkey] = 1; result.push(nkey); next.push(nkey); }
        }
      }
      frontier = next;
    }
    return result;
  }

  // -------------------------------------------------------------- buildContextBlock
  // Assembles notes as "[source: <label>]\n<text>" entries, blank-line separated, within a char budget.
  function buildContextBlock(docs, budgetChars) {
    if (typeof budgetChars !== 'number' || !isFinite(budgetChars) || budgetChars < 0) budgetChars = 6000;
    if (!Array.isArray(docs)) return '';
    var parts = [], used = 0;
    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      if (!doc) continue;
      var rawText = doc.text == null ? '' : String(doc.text);
      var text = rawText.trim();
      if (text === '') continue;
      var label = (doc.name != null && String(doc.name) !== '') ? String(doc.name) : String(doc.id);
      var header = '[source: ' + label + ']\n';
      var sep = parts.length ? '\n\n' : '';
      var fullLen = sep.length + header.length + text.length;
      if (used + fullLen <= budgetChars) {
        parts.push(header + text);
        used += fullLen;
        continue;
      }
      // doesn't fit whole -> HEAD-truncate this entry, then stop
      var remainingForText = budgetChars - used - sep.length - header.length;
      if (remainingForText >= 2) {
        var cut = remainingForText - 2; // room for ' …'
        parts.push(header + text.substring(0, cut) + ' …');
      }
      break;
    }
    return parts.join('\n\n');
  }

  // -------------------------------------------------------------- composeRagPrompt
  // Thai-first instruction template; falls back to the bare question when context is empty.
  function composeRagPrompt(question, contextBlock) {
    var q = typeof question === 'string' ? question : (question == null ? '' : String(question));
    var ctx = typeof contextBlock === 'string' ? contextBlock : '';
    if (ctx.trim() === '') return q;
    return 'คุณคือผู้ช่วยที่ตอบคำถามโดยอ้างอิง โน้ต ในห้องเก็บของผู้ใช้\n' +
      'จงตอบคำถามโดยใช้ข้อมูลจาก โน้ต ด้านล่างนี้\n' +
      'หากใช้ข้อมูลจาก โน้ต ให้ระบุแหล่งที่มาตามป้าย [source: …]\n' +
      'หาก โน้ต ไม่มีคำตอบ ให้บอกผู้ใช้ชัดเจนว่าไม่พบข้อมูลใน โน้ต\n\n' +
      ctx + '\n\n' +
      'คำถาม: ' + q;
  }

  return {
    tokenize: tokenize,
    buildIndex: buildIndex,
    docTf: docTf,
    buildIndexFromTf: buildIndexFromTf,
    rank: rank,
    cosineSim: cosineSim,
    rankByVector: rankByVector,
    fuseRRF: fuseRRF,
    weightedRRF: weightedRRF,
    fuseRag: fuseRag,
    anchorKind: anchorKind,
    detectMentions: detectMentions,
    docFamilyKey: docFamilyKey,
    splitPassages: splitPassages,
    selectPassages: selectPassages,
    normalizeRagWeights: normalizeRagWeights,
    DEFAULT_RAG_WEIGHTS: DEFAULT_RAG_WEIGHTS,
    expandByLinks: expandByLinks,
    buildContextBlock: buildContextBlock,
    composeRagPrompt: composeRagPrompt
  };
});
