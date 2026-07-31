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

  // -------------------------------------------------------------- tokenize
  // Lowercase, then: maximal [a-z0-9] runs (len>=2, non-stopword) as whole tokens;
  // maximal Thai runs (U+0E00-U+0E7F) as CHARACTER BIGRAMS (single char if run len 1).
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
      } else if (m[2]) { // thai run -> character bigrams
        var run = m[2];
        if (run.length === 1) {
          tokens.push(run);
        } else {
          for (var i = 0; i < run.length - 1; i++) {
            tokens.push(run.substring(i, i + 2));
          }
        }
      }
    }
    return tokens;
  }

  // -------------------------------------------------------------- buildIndex
  // docs: [{ id, text }]. Returns { N, avgdl, df, docs:[{id, tf, len}] }.
  function buildIndex(docs) {
    var out = { N: 0, avgdl: 0, df: {}, docs: [] };
    if (!Array.isArray(docs)) return out;
    var sumLen = 0;
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      if (!d || d.id == null || String(d.id) === '') continue;
      var text = typeof d.text === 'string' ? d.text : '';
      var toks = tokenize(text);
      var tf = {};
      var seen = {};
      for (var j = 0; j < toks.length; j++) {
        var t = toks[j];
        tf[t] = (tf[t] || 0) + 1;
        if (!seen[t]) { seen[t] = 1; out.df[t] = (out.df[t] || 0) + 1; }
      }
      var len = toks.length;
      out.docs.push({ id: String(d.id), tf: tf, len: len });
      sumLen += len;
    }
    out.N = out.docs.length;
    out.avgdl = out.N > 0 ? sumLen / out.N : 0;
    return out;
  }

  // -------------------------------------------------------------- rank (BM25)
  // query: raw string. k default 6. Returns [{ id, score }] desc, id asc tie-break, score>0 only.
  function rank(query, index, k) {
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
    rank: rank,
    cosineSim: cosineSim,
    rankByVector: rankByVector,
    fuseRRF: fuseRRF,
    expandByLinks: expandByLinks,
    buildContextBlock: buildContextBlock,
    composeRagPrompt: composeRagPrompt
  };
});
