// Square canvas grid (G2, 2026-09-22): the AI places cards in CELL units, this module turns
// cells into pixels. Overlap is impossible BY STRUCTURE — layoutGrid grows each card's row
// span to fit its real rendered height and pushes lower cards down (gravity). Pure (no DOM):
// measured heights arrive as inputs, so tests never touch the renderer.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.CoreCanvasGrid = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CELL = 84, GAP = 14, PAD = 20;
  var PITCH = CELL + GAP;

  // span (cells) -> px size; width is EXACT per rule 1 (w*CELL + inner gutters)
  function spanToPx(n) { return n * CELL + (n - 1) * GAP; }

  // at {c,r} + size {w,h} (cells) -> top-left px + px size
  function cellToPx(at, size) {
    var c = Math.max(0, Math.floor(+at.c || 0)), r = Math.max(0, Math.floor(+at.r || 0));
    var w = Math.max(1, Math.floor(+size.w || 1)), h = Math.max(1, Math.floor(+size.h || 1));
    return { x: PAD + c * PITCH, y: PAD + r * PITCH, w: spanToPx(w), h: spanToPx(h) };
  }

  // any px point -> nearest cell (never negative) — the drop snap
  function pxToCell(x, y) {
    return { c: Math.max(0, Math.round(((+x || 0) - PAD) / PITCH)), r: Math.max(0, Math.round(((+y || 0) - PAD) / PITCH)) };
  }

  // px size -> nearest span (at least 1 cell each way)
  function spanFromPx(w, h) {
    return { w: Math.max(1, Math.round(((+w || 0) + GAP) / PITCH)), h: Math.max(1, Math.round(((+h || 0) + GAP) / PITCH)) };
  }

  // rows needed so n*CELL + (n-1)*GAP >= hPx (gutter included), at least 1
  function rowsNeeded(hPx) { return Math.max(1, Math.ceil(((+hPx || 0) + GAP) / PITCH)); }

  function rectsOverlap(a, b) {
    return a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
  }

  // The heart: items [{id, c, r, w, h, measuredH}] -> map id -> final cell box + px geometry.
  // hCells = max(min h, rows needed by the REAL rendered height) — content is never cut.
  // Cards are placed in (r, c, id) order; a card landing on a placed one is pushed DOWN in
  // its own column (gravity) until free. Vertical centre offset (rule 3) is centerDy.
  // Deterministic; never mutates the input.
  function layoutGrid(items) {
    var list = (Array.isArray(items) ? items : []).map(function (it) {
      return {
        id: it.id, c: Math.max(0, Math.floor(+it.c || 0)), r: Math.max(0, Math.floor(+it.r || 0)),
        w: Math.max(1, Math.floor(+it.w || 1)), h: Math.max(1, Math.floor(+it.h || 1)),
        measuredH: Math.max(0, +it.measuredH || 0),
      };
    }).sort(function (a, b) { return (a.r - b.r) || (a.c - b.c) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var placed = [], out = {};
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      it.hCells = Math.max(it.h, rowsNeeded(it.measuredH));
      var box = { c: it.c, r: it.r, w: it.w, h: it.hCells };
      while (true) {
        var hit = false;
        for (var j = 0; j < placed.length; j++) if (rectsOverlap(box, placed[j])) { hit = true; break; }
        if (!hit) break;
        box.r++;   // gravity: same column, never sideways
      }
      placed.push(box);
      var allocHPx = spanToPx(box.h);
      out[it.id] = {
        c: box.c, r: box.r, wCells: box.w, hCells: box.h,
        x: PAD + box.c * PITCH, y: PAD + box.r * PITCH, wPx: spanToPx(box.w),
        allocHPx: allocHPx,
        // no measurement yet -> flush top (centring an unknown height would guess)
        centerDy: it.measuredH > 0 ? Math.max(0, Math.floor((allocHPx - it.measuredH) / 2)) : 0,
      };
    }
    return out;
  }

  // First free top-left {c,r} for a w×h card scanning columns 0..maxCols-w, rows upward.
  // occupied = [{c,r,w,h}] cell boxes. Width clamps into maxCols.
  function firstFit(occupied, size, maxCols) {
    var w = Math.max(1, Math.floor(+size.w || 1)), h = Math.max(1, Math.floor(+size.h || 1));
    var cols = Math.max(w, Math.floor(+maxCols || w));
    var occ = (Array.isArray(occupied) ? occupied : []).map(function (o) {
      return { c: Math.max(0, Math.floor(+o.c || 0)), r: Math.max(0, Math.floor(+o.r || 0)), w: Math.max(1, Math.floor(+o.w || 1)), h: Math.max(1, Math.floor(+o.h || 1)) };
    });
    for (var r = 0; r < 500; r++) {
      for (var c = 0; c + w <= cols; c++) {
        var box = { c: c, r: r, w: w, h: h }, hit = false;
        for (var j = 0; j < occ.length; j++) if (rectsOverlap(box, occ[j])) { hit = true; break; }
        if (!hit) return { c: c, r: r };
      }
    }
    return { c: 0, r: 0 };   // ponytail: 500 rows of 8 cols is ~3400 cells; beyond that just stack at origin
  }

  // Grid always-on (user 2026-09-22): free cards (no `at`) join the grid AT their current
  // position — px -> nearest cell, span from the px width, h minimum 1 (layout stretches to
  // the real height later). A natural cell colliding with a placed card or an earlier adoptee
  // hands the LATER card (sorted by y then x) to firstFit. Returns map id -> {at, span} for
  // the ADOPTED cards only; never mutates. Passing no `at` for everyone = pure px->cell map
  // (the hub layout reuses it to land its result on cells).
  function adoptFreeCards(cards) {
    var occ = [], free = [];
    (Array.isArray(cards) ? cards : []).forEach(function (c) {
      if (!c) return;
      if (c.at) {
        var sp = c.span || spanFromPx(c.w, 0);
        occ.push({ c: Math.max(0, Math.floor(+c.at.c || 0)), r: Math.max(0, Math.floor(+c.at.r || 0)),
          w: Math.max(1, Math.floor(+sp.w || 1)), h: Math.max(1, Math.floor(+sp.h || 1)) });
      } else free.push(c);
    });
    var out = {};
    free.slice().sort(function (a, b) { return ((+a.y || 0) - (+b.y || 0)) || ((+a.x || 0) - (+b.x || 0)); })
      .forEach(function (c) {
        var span = { w: spanFromPx(c.w, 0).w, h: 1 };
        var at = pxToCell(+c.x || 0, +c.y || 0);
        var box = { c: at.c, r: at.r, w: span.w, h: span.h };
        var hit = false;
        for (var j = 0; j < occ.length; j++) if (rectsOverlap(box, occ[j])) { hit = true; break; }
        if (hit) at = firstFit(occ, span, 8);
        out[c.id] = { at: { c: at.c, r: at.r }, span: { w: span.w, h: span.h } };
        occ.push({ c: at.c, r: at.r, w: span.w, h: span.h });
      });
    return out;
  }

  // World background follows the pan/zoom view: the 1-PITCH dot tile is positioned so dots
  // sit on REAL cell corners (PAD origin) and scaled by the view — pure string math.
  function bgFor(view) {
    var tx = +((view && view.tx) || 0), ty = +((view && view.ty) || 0), s = +((view && view.scale) || 1);
    return { position: (PAD + tx) + 'px ' + (PAD + ty) + 'px', size: (PITCH * s) + 'px ' + (PITCH * s) + 'px' };
  }

  return {
    CELL: CELL, GAP: GAP, PAD: PAD, PITCH: PITCH,
    cellToPx: cellToPx, pxToCell: pxToCell, spanFromPx: spanFromPx, rowsNeeded: rowsNeeded,
    spanToPx: spanToPx, layoutGrid: layoutGrid, firstFit: firstFit,
    adoptFreeCards: adoptFreeCards, bgFor: bgFor,
  };
});
