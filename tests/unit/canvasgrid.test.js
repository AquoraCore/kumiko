import { describe, it, expect } from 'vitest';
const G = require('../../core/canvasgrid.js');

// Square grid (G2, 2026-09-22): CELL=84 GAP=14 PAD=20 PITCH=98. Pure cell<->px math +
// layoutGrid (occupancy + gravity + vertical centring) + firstFit — no DOM anywhere.

describe('canvasgrid constants + cellToPx', () => {
  it('rule 1: width is EXACT cells — w cells -> w*84 + (w-1)*14, origin at PAD', () => {
    expect(G.PITCH).toBe(98);
    expect(G.cellToPx({ c: 0, r: 0 }, { w: 1, h: 1 })).toEqual({ x: 20, y: 20, w: 84, h: 84 });
    expect(G.cellToPx({ c: 2, r: 1 }, { w: 3, h: 2 })).toEqual({ x: 20 + 2 * 98, y: 20 + 98, w: 3 * 84 + 2 * 14, h: 2 * 84 + 14 });
    expect(G.cellToPx({ w: 2, h: 1 }, { w: 4, h: 3 }).w).toBe(4 * 84 + 3 * 14);
  });
});

describe('pxToCell / spanFromPx round-trip', () => {
  it('px -> nearest cell (never negative), round-trips through cellToPx centres', () => {
    expect(G.pxToCell(20, 20)).toEqual({ c: 0, r: 0 });
    expect(G.pxToCell(-500, -500)).toEqual({ c: 0, r: 0 });
    expect(G.pxToCell(20 + 48, 20)).toEqual({ c: 0, r: 0 });      // just under half-pitch
    expect(G.pxToCell(20 + 50, 20)).toEqual({ c: 1, r: 0 });      // just over (49 is exact half)
    const at = { c: 3, r: 2 }, size = { w: 2, h: 2 };
    const p = G.cellToPx(at, size);
    expect(G.pxToCell(p.x + 5, p.y + 5)).toEqual(at);   // drop near the card's corner snaps home
    expect(G.pxToCell(p.x + 98 + 42, p.y + 5)).toEqual({ c: 4, r: 2 });   // second cell's centre
  });
  it('spanFromPx: nearest span, at least 1', () => {
    expect(G.spanFromPx(84, 84)).toEqual({ w: 1, h: 1 });
    expect(G.spanFromPx(182, 182)).toEqual({ w: 2, h: 2 });       // 2 cells incl. inner gutter
    expect(G.spanFromPx(0, -5)).toEqual({ w: 1, h: 1 });
    expect(G.spanFromPx(280, 183)).toEqual({ w: 3, h: 2 });       // NEAREST span, not ceil (rowsNeeded ceil's)
  });
});

describe('rowsNeeded (height is a MINIMUM — rule 2)', () => {
  it('exact cell fit -> 1; 1px over -> 2; gutter between rows counted', () => {
    expect(G.rowsNeeded(84)).toBe(1);
    expect(G.rowsNeeded(85)).toBe(2);
    expect(G.rowsNeeded(182)).toBe(2);      // 84+14+84
    expect(G.rowsNeeded(183)).toBe(3);
    expect(G.rowsNeeded(0)).toBe(1);
  });
});

// independent occupancy re-check: no two result boxes may share a cell
function assertNoOverlap(layout) {
  const seen = new Set();
  for (const id of Object.keys(layout)) {
    const L = layout[id];
    for (let c = L.c; c < L.c + L.wCells; c++)
      for (let r = L.r; r < L.r + L.hCells; r++) {
        const k = c + ',' + r;
        expect(seen.has(k), 'cell ' + k + ' double-booked').toBe(false);
        seen.add(k);
      }
  }
}

describe('layoutGrid', () => {
  it('grows rows to the measured height (never cuts content) and keeps order stable', () => {
    const lay = G.layoutGrid([
      { id: 'a', c: 0, r: 0, w: 2, h: 1, measuredH: 84 },
      { id: 'b', c: 0, r: 1, w: 2, h: 1, measuredH: 500 },   // needs 6 rows
      { id: 'c', c: 0, r: 1, w: 2, h: 1, measuredH: 84 },    // same slot as b -> gravity
    ]);
    assertNoOverlap(lay);
    expect(lay.a.hCells).toBe(1);
    expect(lay.b.hCells).toBe(6);                 // ceil((500+14)/98)
    expect(lay.c.r).toBe(lay.b.r + 6);            // pushed BELOW b's grown block
    expect(lay.c.hCells).toBe(1);
    expect(lay.b.x).toBe(20); expect(lay.b.wPx).toBe(2 * 84 + 14);
    expect(lay.b.allocHPx).toBe(6 * 84 + 5 * 14);
  });
  it('gravity pushes DOWN only (same column, never sideways)', () => {
    const lay = G.layoutGrid([
      { id: 'a', c: 1, r: 0, w: 2, h: 1, measuredH: 84 },
      { id: 'b', c: 1, r: 0, w: 2, h: 1, measuredH: 84 },   // same c: tie -> id order, b under a
      { id: 'd', c: 3, r: 0, w: 2, h: 1, measuredH: 84 },   // different column: untouched
    ]);
    assertNoOverlap(lay);
    expect(lay.a.c).toBe(1); expect(lay.a.r).toBe(0);
    expect(lay.b.c).toBe(1); expect(lay.b.r).toBe(1);       // same column, row down
    expect(lay.d.c).toBe(3); expect(lay.d.r).toBe(0);
  });
  it('rule 3: short content is vertically CENTRED in its reserved block (centerDy >= 0)', () => {
    const lay = G.layoutGrid([{ id: 'a', c: 0, r: 0, w: 1, h: 1, measuredH: 40 }]);
    expect(lay.a.hCells).toBe(1);
    expect(lay.a.allocHPx).toBe(84);
    expect(lay.a.centerDy).toBe(22);              // floor((84-40)/2)
    const lay2 = G.layoutGrid([{ id: 'a', c: 0, r: 0, w: 1, h: 1, measuredH: 84 }]);
    expect(lay2.a.centerDy).toBe(0);              // exact fit -> flush
    const lay3 = G.layoutGrid([{ id: 'a', c: 0, r: 0, w: 1, h: 2, measuredH: 84 }]);  // min 2 rows, content 1
    expect(lay3.a.centerDy).toBe(Math.floor((182 - 84) / 2));
  });
  it('edge: deterministic (r, then c, then id) and input NEVER mutated', () => {
    const items = [
      { id: 9, c: 0, r: 2, w: 1, h: 1, measuredH: 10 },
      { id: 2, c: 5, r: 0, w: 1, h: 1, measuredH: 10 },
      { id: 7, c: 1, r: 0, w: 1, h: 1, measuredH: 10 },
    ];
    const snap = JSON.stringify(items);
    const l1 = JSON.stringify(G.layoutGrid(items));
    const l2 = JSON.stringify(G.layoutGrid(items.slice().reverse()));
    expect(l1).toBe(l2);                          // order-in -> order-out identical
    expect(JSON.stringify(items)).toBe(snap);     // untouched
    const lay = G.layoutGrid(items);
    assertNoOverlap(lay);
    expect([lay[2].r, lay[7].r, lay[9].r]).toEqual([0, 0, 2]);
  });
  it('edge: measuredH missing -> hCells stays at the stated minimum', () => {
    const lay = G.layoutGrid([{ id: 'a', c: 0, r: 0, w: 2, h: 3 }]);
    expect(lay.a.hCells).toBe(3);
    expect(lay.a.centerDy).toBe(0);
    expect(G.layoutGrid([])).toEqual({});
    expect(G.layoutGrid(null)).toEqual({});
  });
});

describe('firstFit', () => {
  it('scans top-left first and SKIPS occupied cells', () => {
    expect(G.firstFit([], { w: 2, h: 1 }, 8)).toEqual({ c: 0, r: 0 });
    expect(G.firstFit([{ c: 0, r: 0, w: 8, h: 1 }], { w: 2, h: 1 }, 8)).toEqual({ c: 0, r: 1 });  // row full
    expect(G.firstFit([{ c: 0, r: 0, w: 2, h: 2 }, { c: 2, r: 0, w: 2, h: 2 }], { w: 2, h: 1 }, 8))
      .toEqual({ c: 4, r: 0 });                                                                    // gap to the right
    expect(G.firstFit([{ c: 0, r: 0, w: 2, h: 1 }], { w: 2, h: 1 }, 8)).toEqual({ c: 2, r: 0 });   // beside
    expect(G.firstFit([{ c: 7, r: 0, w: 1, h: 1 }], { w: 2, h: 1 }, 8)).toEqual({ c: 0, r: 0 });   // far corner doesn't block col 0
  });
  it('edge: a card wider than maxCols clamps to the board width', () => {
    expect(G.firstFit([], { w: 10, h: 1 }, 8)).toEqual({ c: 0, r: 0 });
  });
});

describe('adoptFreeCards (grid always-on)', () => {
  it('happy: free cards keep their approximate position — px -> cell, span from width, h min 1', () => {
    const p = G.cellToPx({ c: 2, r: 0 }, { w: 1, h: 1 });
    const m = G.adoptFreeCards([
      { id: 'a', x: p.x, y: p.y, w: 84 },            // lands on c:2 r:0
      { id: 'b', x: 20, y: 20 + 98, w: 84 + 98 },    // c:0 r:1, 2 cells wide
    ]);
    expect(m.a).toEqual({ at: { c: 2, r: 0 }, span: { w: 1, h: 1 } });
    expect(m.b).toEqual({ at: { c: 0, r: 1 }, span: { w: 2, h: 1 } });
  });
  it('collision with a PLACED card -> free takes the next firstFit slot', () => {
    const m = G.adoptFreeCards([
      { id: 'f', x: 0, y: 0, w: 84, at: { c: 0, r: 0 }, span: { w: 2, h: 1 } },
      { id: 'q', x: 20, y: 20, w: 84 },               // natural (0,0) is taken (2 wide)
    ]);
    expect(m.q.at).toEqual({ c: 2, r: 0 });
    expect(m.f).toBeUndefined();                      // placed cards are never re-adopted
  });
  it('collision BETWEEN adoptees -> later card (sorted y then x) is the one that moves', () => {
    const m = G.adoptFreeCards([
      { id: 'late', x: 20, y: 30, w: 84 },            // bigger y -> processed later
      { id: 'early', x: 25, y: 20, w: 84 },           // smaller y -> keeps the natural cell
    ]);
    expect(m.early.at).toEqual({ c: 0, r: 0 });
    expect(m.late.at).toEqual({ c: 1, r: 0 });        // firstFit beside it
  });
  it('edge: negative px clamps to 0,0 · no free cards -> {} · input NEVER mutated', () => {
    const cards = [
      { id: 'n', x: -500, y: -500, w: 84 },
      { id: 'z', x: 9, y: 9, w: 84, at: { c: 3, r: 3 }, span: { w: 1, h: 1 } },
    ];
    const snap = JSON.stringify(cards);
    const m = G.adoptFreeCards(cards);
    expect(m.n.at).toEqual({ c: 0, r: 0 });
    expect(m.z).toBeUndefined();
    expect(JSON.stringify(cards)).toBe(snap);
    expect(G.adoptFreeCards([cards[1]])).toEqual({});
    expect(G.adoptFreeCards([])).toEqual({});
  });
});

describe('bgFor (world background tracks the view)', () => {
  it('dots anchored at the cell origin (PAD + tx/ty), one PITCH tile scaled by view.scale', () => {
    expect(G.bgFor({ tx: 0, ty: 0, scale: 1 })).toEqual({ position: '20px 20px', size: '98px 98px' });
    expect(G.bgFor({ tx: -120.5, ty: 40, scale: 2 })).toEqual({ position: '-100.5px 60px', size: '196px 196px' });
    expect(G.bgFor(null)).toEqual({ position: '20px 20px', size: '98px 98px' });   // safe defaults
  });
});
