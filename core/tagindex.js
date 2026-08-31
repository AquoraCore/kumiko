// Tag Index — pure, UMD (Node + browser). ONE structure that both the UI (sidebar tree, filter,
// Tag view, chips, autocomplete) and the AI verbs (LIST-TAGS / NOTES-BY-TAG / SET-TAGS …) read.
// Source of truth stays the note frontmatter (`tags: a, b/c`) — this never touches disk; it
// only derives. Body hashtags (`#tag` in the markdown) are indexed too, marked source 'body'.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./tags.js'));
  else root.CoreTagIndex = factory(root.CoreTags);
})(typeof self !== 'undefined' ? self : this, function (CoreTags) {
  var parseTags = CoreTags.parseTags;
  var HUES = 6;   // one per palette preset (kumiko / sakura / karashi / matcha / ai / fuji)

  function norm(name) { return String(name || '').trim().replace(/^#/, '').replace(/\/+$/, '').replace(/\s*\/\s*/g, '/'); }
  function key(name) { return norm(name).toLowerCase(); }
  function parent(name) { var n = norm(name); var i = n.lastIndexOf('/'); return i < 0 ? '' : n.slice(0, i); }
  function leaf(name) { var n = norm(name); var i = n.lastIndexOf('/'); return i < 0 ? n : n.slice(i + 1); }
  // deterministic hue slot 0..5 from the ROOT of the tag family, so #exam and #exam/midterm share a colour
  function hueOf(name) {
    var n = key(name).split('/')[0]; var h = 0;
    for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
    return h % HUES;
  }

  // #tags written in the body: `#exam/midterm` — not inside code/links/headings, not a URL
  // fragment, not a bare number. Thai letters count as word characters.
  var BODY_RE = /(^|[\s(（\[])#([\p{L}\p{N}_][\p{L}\p{N}_\-\/]*)/gu;
  function bodyTags(markdown) {
    var s = String(markdown || '');
    s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');          // code
    s = s.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\]\([^)]*\)/g, '] ');        // links / urls
    s = s.replace(/^#{1,6}\s.*$/gm, ' ');                                        // headings
    var out = [], seen = {};
    var m; BODY_RE.lastIndex = 0;
    while ((m = BODY_RE.exec(s))) {
      var t = norm(m[2]); if (!t || /^\d+$/.test(t)) continue;
      var k = key(t); if (seen[k]) continue; seen[k] = 1; out.push(t);
    }
    return out;
  }

  // rows = [{ name, tags, body? , status? }] → index
  function build(rows) {
    var tags = {}, byNote = {}, order = [];
    function touch(name, note, source) {
      var k = key(name); if (!k) return;
      if (!tags[k]) { tags[k] = { name: norm(name), key: k, count: 0, notes: [], children: [], hue: hueOf(name), parent: parent(name).toLowerCase(), sources: { front: 0, body: 0 } }; order.push(k); }
      var e = tags[k];
      if (e.notes.indexOf(note) < 0) { e.notes.push(note); e.count++; }
      e.sources[source]++;
      // ancestors exist as nodes even if no note carries them directly
      var p = parent(name);
      if (p) { touch(p, note, source === 'front' ? 'front' : 'body'); }
    }
    (rows || []).forEach(function (r) {
      if (!r || !r.name) return;
      var front = parseTags(r.tags), body = r.body ? bodyTags(r.body) : (r.bodyTags || []);
      var all = [], seen = {};
      front.forEach(function (t) { var k = key(t); if (!seen[k]) { seen[k] = 1; all.push({ name: norm(t), source: 'front' }); } });
      body.forEach(function (t) { var k = key(t); if (!seen[k]) { seen[k] = 1; all.push({ name: norm(t), source: 'body' }); } });
      byNote[r.name] = all;
      all.forEach(function (x) { touch(x.name, r.name, x.source); });
    });
    order.forEach(function (k) { var p = tags[k].parent; if (p && tags[p] && tags[p].children.indexOf(k) < 0) tags[p].children.push(k); });
    Object.keys(tags).forEach(function (k) { tags[k].children.sort(); });
    var roots = order.filter(function (k) { return !tags[k].parent; }).sort();
    var pool = order.map(function (k) { return tags[k].name; }).sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return { tags: tags, byNote: byNote, roots: roots, pool: pool, total: order.length };
  }

  // all keys in a family: the tag + every descendant
  function family(index, name) {
    var k = key(name), out = [], stack = [k];
    while (stack.length) { var c = stack.pop(); if (!index.tags[c] || out.indexOf(c) >= 0) continue; out.push(c); stack = stack.concat(index.tags[c].children); }
    return out;
  }
  // notes carrying ALL of `names` (each matched as a family), sorted
  function filterNotes(index, names, mode) {
    var sets = (names || []).map(function (n) {
      var s = {}; family(index, n).forEach(function (k) { index.tags[k].notes.forEach(function (nt) { s[nt] = 1; }); }); return s;
    });
    if (!sets.length) return [];
    var all = Object.keys(index.byNote).filter(function (nt) {
      return mode === 'or' ? sets.some(function (s) { return s[nt]; }) : sets.every(function (s) { return s[nt]; });
    });
    return all.sort();
  }

  // ---- write plans (the caller writes the files) ----
  // rename `from` → `to` for a note's tag list; renaming a family root moves descendants too
  function renameInList(list, from, to) {
    var f = key(from), t = norm(to);
    return parseTags(list.join(',')).map(function (tg) {
      var k = key(tg);
      if (k === f) return t;
      if (k.indexOf(f + '/') === 0) return t + tg.slice(f.length);
      return tg;
    });
  }
  // Rewrite `#from` (and `#from/…`) written in a markdown BODY → `#to`. Same no-go zones as
  // bodyTags (code, links, headings, urls) are left untouched; word-bounded so #exam never
  // matches #examples. `to` empty = drop the '#', keep the word (sentence stays readable).
  // Returns { text, count }.
  function renameInBody(markdown, from, to) {
    var s = String(markdown || ''), f = key(from), t = norm(to);
    if (!f) return { text: s, count: 0 };
    // protect no-go zones by slicing: we only rewrite OUTSIDE these spans
    var zones = [];
    var push = function (re) { var m; re.lastIndex = 0; while ((m = re.exec(s))) zones.push([m.index, m.index + m[0].length]); };
    push(/```[\s\S]*?```/g); push(/`[^`\n]*`/g); push(/\[\[[^\]]*\]\]/g); push(/\]\([^)]*\)/g); push(/^#{1,6}\s.*$/gm); push(/https?:\/\/\S+/g);
    zones.sort(function (a, b) { return a[0] - b[0]; });
    var inZone = function (i) { for (var z = 0; z < zones.length; z++) { if (i >= zones[z][0] && i < zones[z][1]) return true; } return false; };
    var re = /(^|[\s(（\[])#([\p{L}\p{N}_][\p{L}\p{N}_\-\/]*)/gu, out = '', last = 0, count = 0, m;
    while ((m = re.exec(s))) {
      var at = m.index + m[1].length;              // position of '#'
      var tag = m[2], k = key(tag);
      if (inZone(at) || !(k === f || k.indexOf(f + '/') === 0)) continue;
      var rest = tag.slice(f.length);              // '' or '/child…'
      var repl = t ? '#' + t + rest : tag;         // remove → keep the word without '#'
      out += s.slice(last, at) + repl; last = at + 1 + tag.length; count++;
    }
    out += s.slice(last);
    return { text: out, count: count };
  }
  // rows → [{ name, tags (new serialized) | undefined, body (new markdown) | undefined, bodyHits }]
  // only for notes that change. `to` empty = remove. Rows may carry `body` (markdown without
  // frontmatter); when they do, in-body #tags are rewritten too (opts.body !== false).
  function renamePlan(rows, from, to, opts) {
    var f = key(from), out = [], doBody = !(opts && opts.body === false);
    (rows || []).forEach(function (r) {
      var cur = parseTags(r.tags);
      var hit = cur.some(function (tg) { var k = key(tg); return k === f || k.indexOf(f + '/') === 0; });
      var item = { name: r.name, bodyHits: 0 };
      if (hit) {
        var next = to ? renameInList(cur, from, to) : cur.filter(function (tg) { var k = key(tg); return !(k === f || k.indexOf(f + '/') === 0); });
        item.tags = CoreTags.serializeTags(next);
      }
      if (doBody && typeof r.body === 'string') {
        var rb = renameInBody(r.body, from, to);
        if (rb.count) { item.body = rb.text; item.bodyHits = rb.count; }
      }
      if (item.tags !== undefined || item.bodyHits) out.push(item);
    });
    return out;
  }
  function addTags(list, adds) { return CoreTags.serializeTags(parseTags(list).concat(parseTags(adds))); }
  function removeTags(list, rems) {
    var rm = {}; parseTags(rems).forEach(function (t) { rm[key(t)] = 1; });
    return CoreTags.serializeTags(parseTags(list).filter(function (t) { return !rm[key(t)]; }));
  }
  // compact text summary for the AI prompt: "exam 6 (midterm 3, final 3) · dfd 4 …"
  function summary(index, limit) {
    var lines = index.roots.map(function (k) {
      var e = index.tags[k];
      var kids = e.children.map(function (c) { return leaf(index.tags[c].name) + ' ' + index.tags[c].count; });
      return e.name + ' ' + e.count + (kids.length ? ' (' + kids.join(', ') + ')' : '');
    });
    var s = lines.slice(0, limit || 40).join(' · ');
    if (lines.length > (limit || 40)) s += ' · …อีก ' + (lines.length - (limit || 40));
    return s;
  }

  return { build: build, bodyTags: bodyTags, hueOf: hueOf, parent: parent, leaf: leaf, norm: norm, key: key,
    family: family, filterNotes: filterNotes, renameInList: renameInList, renameInBody: renameInBody, renamePlan: renamePlan,
    addTags: addTags, removeTags: removeTags, summary: summary, HUES: HUES };
});
