import { describe, it, expect } from 'vitest';
const { tboxClampSize } = require('../../core/tboxsize');

// Regression for the PDF text-box RESIZE handle (makeTboxEl in renderer/pdf.js). The
// drag math lives here so it can be tested without a rendered PDF page. wrap is 800x1000,
// box currently at left=100, top=200, starting size 200x120.
describe('tboxClampSize — PDF text-box resize clamp', () => {
  it('HAPPY: a normal drag grows the box by the pointer delta', () => {
    const { w, h } = tboxClampSize(200, 120, 60, 40, 100, 200, 800, 1000);
    expect(w).toBe(260); // 200 + 60
    expect(h).toBe(160); // 120 + 40
  });

  it('EDGE: never shrinks below the minimums (48 wide, 24 tall)', () => {
    const { w, h } = tboxClampSize(200, 120, -500, -500, 100, 200, 800, 1000);
    expect(w).toBe(48);
    expect(h).toBe(24);
  });

  it('EDGE: never grows past the page edge (wrapW-left / wrapH-top)', () => {
    const { w, h } = tboxClampSize(200, 120, 9999, 9999, 100, 200, 800, 1000);
    expect(w).toBe(700); // 800 - left(100)
    expect(h).toBe(800); // 1000 - top(200)
  });
});
