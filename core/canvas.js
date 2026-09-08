// Kumiko Canvas — pure board/section logic (UMD, Node + browser). A board = cards (a note
// showing the FULL text of its CHOSEN sections, or a sticky) + CONFIRMED edges. Suggestion
// edges are never stored: they are recomputed from the [[wikilinks]] inside each chosen
// section on every paint, so they can never go stale — confirming one merely copies it into
// board.edges. Boards persist as one JSON blob via vault config (key 'canvas').
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CoreCanvas = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  var INTRO = '(บทนำ)';

  // Split a note into heading sections. Text before the first heading becomes INTRO (only
  // kept when non-empty). Headings inside code fences don't split. Duplicate heading names
  // get " (2)", " (3)"… so seg references stay unambiguous.
  function parseSections(md) {
    var src = String(md == null ? '' : md).replace(/\r\n/g, '\n');
    src = src.replace(/^---\n[\s\S]*?\n---\n?/, '');   // YAML frontmatter is metadata, not a section
    var lines = src.split('\n');
    var out = [], seen = {}, cur = { name: INTRO, text: [] }, inFence = false;
    var push = function () {
      var t = cur.text.join('\n').trim();
      if (cur.name === INTRO && !t) return;
      var name = cur.name, n = 2;
      while (seen[name]) name = cur.name + ' (' + (n++) + ')';
      seen[name] = 1;
      out.push({ name: name, text: t });
    };
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\s*(```|~~~)/.test(ln)) inFence = !inFence;
      var m = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(ln);
      if (m) { push(); cur = { name: m[2].trim(), text: [] }; }
      else cur.text.push(ln);
    }
    push();
    return out;
  }

  function sectionByName(sections, name) {
    for (var i = 0; i < (sections || []).length; i++) if (sections[i].name === name) return sections[i];
    return null;
  }

  // [[target]] / [[target|label]] / [[target#p2]] -> target (page/label stripped)
  function sectionLinks(text) {
    var out = [], re = /\[\[([^\]|#]+)(?:[^\]]*)\]\]/g, m;
    var s = String(text == null ? '' : text);
    while ((m = re.exec(s))) { var t = m[1].trim(); if (t && out.indexOf(t) < 0) out.push(t); }
    return out;
  }

  function titleOfRel(rel) {
    var base = String(rel == null ? '' : rel).split('/').pop() || '';
    return base.replace(/\.[^.]+$/, '');
  }

  // A confirmed edge already covers this (a,aSeg)->(b) pair (either direction)?
  function covered(edges, a, aSeg, b) {
    for (var i = 0; i < (edges || []).length; i++) {
      var e = edges[i];
      if (e.auto) continue;
      if ((e.a === a && e.aSeg === aSeg && e.b === b) || (e.b === a && e.bSeg === aSeg && e.a === b)) return true;
    }
    return false;
  }

  // Suggestion edges: every chosen section containing [[X]] proposes a dashed wire from THAT
  // segment to the card whose note is X (matched by title or rel suffix). Aims at the target
  // card's segment that links back when one exists. Pairs already covered by a confirmed
  // edge are skipped so dashed never overlaps solid.
  function suggestEdges(cards, sectionsOf, confirmedEdges) {
    var out = [], notes = [];
    (cards || []).forEach(function (c) {
      if (c.type === 'sticky' || !c.rel) return;
      notes.push({ card: c, title: titleOfRel(c.rel).toLowerCase(), rel: String(c.rel).replace(/\.[^.]+$/, '').toLowerCase() });
    });
    var find = function (target) {
      var t = String(target).toLowerCase().replace(/\.md$/, '');
      for (var i = 0; i < notes.length; i++) {
        if (notes[i].title === t || notes[i].rel === t || notes[i].rel.slice(-(t.length + 1)) === '/' + t) return notes[i].card;
      }
      return null;
    };
    notes.forEach(function (n) {
      var c = n.card, secs = sectionsOf(c.rel) || [];
      (c.segs || []).forEach(function (name, si) {
        var sec = sectionByName(secs, name); if (!sec) return;
        sectionLinks(sec.text).forEach(function (target) {
          var tc = find(target);
          if (!tc || tc.id === c.id) return;
          if (covered(confirmedEdges, c.id, si, tc.id)) return;
          for (var i = 0; i < out.length; i++) if (out[i].a === c.id && out[i].aSeg === si && out[i].b === tc.id) return;
          var bSeg = null, tsecs = sectionsOf(tc.rel) || [], back = titleOfRel(c.rel).toLowerCase();
          (tc.segs || []).forEach(function (tn, ti) {
            if (bSeg != null) return;
            var ts = sectionByName(tsecs, tn);
            if (ts && sectionLinks(ts.text).some(function (x) { return x.toLowerCase() === back; })) bSeg = ti;
          });
          out.push({ a: c.id, aSeg: si, b: tc.id, bSeg: bSeg, auto: true });
        });
      });
    });
    return out;
  }

  function newBoard(name) {
    return { name: String(name || 'บอร์ดใหม่'), view: { tx: 40, ty: 30, scale: 1 }, cards: [], edges: [], seq: 1 };
  }

  // Never trust stored JSON: coerce every board/card/edge back into shape (bad rows dropped).
  function normBoard(raw) {
    var b = (raw && typeof raw === 'object') ? raw : {};
    var out = newBoard(b.name);
    var v = b.view || {};
    out.view = { tx: +v.tx || 40, ty: +v.ty || 30, scale: Math.min(2.5, Math.max(0.3, +v.scale || 1)) };
    out.seq = Math.max(1, Math.floor(+b.seq || 1));
    (Array.isArray(b.cards) ? b.cards : []).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var id = Math.floor(+c.id); if (!(id > 0)) return;
      var type = c.type === 'sticky' ? 'sticky' : 'note';
      if (type === 'note' && !c.rel) return;
      out.cards.push({
        id: id, type: type, rel: type === 'note' ? String(c.rel) : undefined,
        x: +c.x || 0, y: +c.y || 0, w: Math.min(1400, Math.max(200, +c.w || (type === 'sticky' ? 200 : 264))),
        segs: type === 'note' ? (Array.isArray(c.segs) ? c.segs.map(String) : []) : undefined,
        body: type === 'sticky' ? String(c.body || '') : undefined,
      });
      out.seq = Math.max(out.seq, id + 1);
    });
    var ids = {}; out.cards.forEach(function (c) { ids[c.id] = 1; });
    (Array.isArray(b.edges) ? b.edges : []).forEach(function (e) {
      if (!e || !ids[e.a] || !ids[e.b] || e.a === e.b) return;
      out.edges.push({ a: e.a, b: e.b, aSeg: e.aSeg == null ? null : Math.floor(+e.aSeg), bSeg: e.bSeg == null ? null : Math.floor(+e.bSeg) });
    });
    return out;
  }

  function normState(raw) {
    var s = (raw && typeof raw === 'object') ? raw : {};
    var boards = (Array.isArray(s.boards) ? s.boards : []).map(normBoard);
    if (!boards.length) boards = [newBoard('บอร์ดแรก')];
    var cur = Math.floor(+s.cur || 0);
    if (!(cur >= 0 && cur < boards.length)) cur = 0;
    return { boards: boards, cur: cur };
  }

  // ---- AI verb ops (===CANVAS-*=== lines, parsed by CoreMarkdown.extractActions) ----------
  // Applies an ORDERED op list to the state in place (op 'board' redirects the ops after it).
  // ctx = { resolveNote(nameOrTitle) -> rel|null, sectionsOf(rel) -> sections[] } — the caller
  // resolves names and supplies content; this stays pure/deterministic for tests.
  // Returns { applied: [thai strings], errors: [thai strings] }.
  function applyVerbOps(state, ops, ctx) {
    var applied = [], errors = [], addedIds = [];
    var board = state.boards[state.cur];
    var findCard = function (rel) {
      for (var i = 0; i < board.cards.length; i++) if (board.cards[i].rel === rel) return board.cards[i];
      return null;
    };
    // AI-written names are often clipped ("2. หน่วยงานที่เกี่ยวข้อง" vs the real
    // "…(6 หน่วย)") — accept a UNIQUE prefix, then a UNIQUE substring, before failing.
    var pickName = function (names, want) {
      if (names.indexOf(want) >= 0) return want;
      var w = String(want).toLowerCase(), st = [], hs = [];
      names.forEach(function (n) {
        var l = n.toLowerCase();
        if (l.indexOf(w) === 0) st.push(n); else if (l.indexOf(w) >= 0) hs.push(n);
      });
      if (st.length === 1) return st[0];
      if (!st.length && hs.length === 1) return hs[0];
      return null;
    };
    var segIdx = function (card, name) {
      if (!name) return null;
      var hit = pickName(card.segs || [], name);
      return hit == null ? -1 : (card.segs || []).indexOf(hit);
    };
    // flow layout: place each new card after the previous one, wrapping by real widths so a
    // wide (w=640) diagram card never sits under its neighbour
    var nextPos = function () {
      if (!board.cards.length) return { x: 60, y: 60 };
      var last = board.cards[board.cards.length - 1];
      var x = last.x + last.w + 40, y = last.y;
      if (x > 1100) { x = 60; y += 360; }
      return { x: x, y: y };
    };
    (ops || []).forEach(function (o) {
      if (o.op === 'board') {
        var i = state.boards.findIndex(function (b) { return b.name.trim().toLowerCase() === o.name.trim().toLowerCase(); });
        if (i < 0) { state.boards.push(newBoard(o.name)); i = state.boards.length - 1; applied.push('สร้างบอร์ด "' + o.name + '"'); }
        state.cur = i; board = state.boards[i];
        applied.push('ใช้บอร์ด "' + board.name + '"');
        return;
      }
      if (o.op === 'sticky') {
        var p0 = nextPos();
        var sid = board.seq++;
        board.cards.push({ id: sid, type: 'sticky', body: o.text, x: p0.x, y: p0.y, w: 200 });
        addedIds.push(sid);
        applied.push('แปะสติกกี้');
        return;
      }
      if (o.op === 'add' || o.op === 'remove') {
        var rel = ctx.resolveNote(o.name);
        if (!rel) { errors.push('ไม่พบโน้ต "' + o.name + '"'); return; }
        if (o.op === 'add') {
          var secs = ctx.sectionsOf(rel) || [];
          if (!secs.length) { errors.push('โน้ต "' + o.name + '" ไม่มีเนื้อหาให้วาง'); return; }
          var names = secs.map(function (s) { return s.name; });
          var want = [], bad = [];
          (o.segs || []).forEach(function (s) {
            var hit = pickName(names, s);
            if (hit && want.indexOf(hit) < 0) want.push(hit); else if (!hit) bad.push(s);
          });
          bad.forEach(function (s) { errors.push('ไม่พบหัวข้อ "' + s + '" ในโน้ต "' + o.name + '"'); });
          var card = findCard(rel);
          if (!card) {
            if (!want.length) want = [secs[0].name];
            var p = nextPos();
            card = { id: board.seq++, type: 'note', rel: rel, x: p.x, y: p.y,
              w: Math.min(1400, Math.max(200, o.w || 264)), segs: want };
            board.cards.push(card);
            addedIds.push(card.id);
            applied.push('วาง "' + titleOfRel(rel) + '" (' + want.length + ' ท่อน)');
          } else {
            var added = 0;
            want.forEach(function (s) { if (card.segs.indexOf(s) < 0) { card.segs.push(s); added++; } });
            if (o.w) card.w = Math.min(1400, Math.max(200, o.w));
            applied.push('เพิ่ม ' + added + ' ท่อนใน "' + titleOfRel(rel) + '"');
          }
        } else {
          var card2 = findCard(rel);
          if (!card2) { errors.push('"' + o.name + '" ไม่ได้อยู่บนบอร์ด'); return; }
          if (o.seg) {
            var si = segIdx(card2, o.seg);
            if (si == null || si < 0) { errors.push('ไม่พบท่อน "' + o.seg + '" บนการ์ด "' + o.name + '"'); return; }
            card2.segs.splice(si, 1);
            board.edges = board.edges.filter(function (e) { return !((e.a === card2.id && e.aSeg === si) || (e.b === card2.id && e.bSeg === si)); });
            board.edges.forEach(function (e) {
              if (e.a === card2.id && e.aSeg != null && e.aSeg > si) e.aSeg--;
              if (e.b === card2.id && e.bSeg != null && e.bSeg > si) e.bSeg--;
            });
            applied.push('เอาท่อน "' + o.seg + '" ออกจาก "' + titleOfRel(rel) + '"');
          } else {
            board.cards = board.cards.filter(function (c) { return c.id !== card2.id; });
            board.edges = board.edges.filter(function (e) { return e.a !== card2.id && e.b !== card2.id; });
            applied.push('เอา "' + titleOfRel(rel) + '" ออกจากบอร์ด');
          }
        }
        return;
      }
      if (o.op === 'wire' || o.op === 'unwire') {
        var ra = ctx.resolveNote(o.from), rb = ctx.resolveNote(o.to);
        var ca = ra && findCard(ra), cb = rb && findCard(rb);
        if (!ca || !cb) { errors.push('โยงไม่ได้ — "' + (!ca ? o.from : o.to) + '" ไม่ได้อยู่บนบอร์ด'); return; }
        if (o.op === 'unwire') {
          var before = board.edges.length;
          board.edges = board.edges.filter(function (e) { return !((e.a === ca.id && e.b === cb.id) || (e.a === cb.id && e.b === ca.id)); });
          applied.push('ตัดเส้น "' + titleOfRel(ra) + '" ↔ "' + titleOfRel(rb) + '" (' + (before - board.edges.length) + ' เส้น)');
          return;
        }
        var ai = segIdx(ca, o.fromSeg), bi = segIdx(cb, o.toSeg);
        if (ai === -1) { errors.push('ไม่พบท่อน "' + o.fromSeg + '" บนการ์ด "' + o.from + '"'); return; }
        if (bi === -1) { errors.push('ไม่พบท่อน "' + o.toSeg + '" บนการ์ด "' + o.to + '"'); return; }
        var dup = board.edges.some(function (e) { return e.a === ca.id && e.b === cb.id && e.aSeg === ai && e.bSeg === bi; });
        if (!dup) board.edges.push({ a: ca.id, aSeg: ai, b: cb.id, bSeg: bi });
        applied.push('โยง "' + titleOfRel(ra) + '" → "' + titleOfRel(rb) + '"');
        return;
      }
    });
    return { applied: applied, errors: errors, addedIds: addedIds };
  }

  return {
    INTRO: INTRO,
    parseSections: parseSections, sectionByName: sectionByName, sectionLinks: sectionLinks,
    titleOfRel: titleOfRel, covered: covered, suggestEdges: suggestEdges,
    newBoard: newBoard, normBoard: normBoard, normState: normState, applyVerbOps: applyVerbOps,
  };
});
