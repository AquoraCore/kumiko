// Pure clamp for PDF text-box resize: keep the box at least a min size AND fully inside
// the page. Extracted so the sizing logic is unit-testable without a rendered PDF/DOM.
// dx/dy = pointer delta from drag start; left/top = the box's current offset in the page;
// wrapW/wrapH = the page-wrap size. Returns clamped PIXEL {w,h}. UMD: Node + browser.
function tboxClampSize(startW, startH, dx, dy, left, top, wrapW, wrapH){
  const w = Math.max(48, Math.min(startW + dx, wrapW - left));
  const h = Math.max(24, Math.min(startH + dy, wrapH - top));
  return { w, h };
}
if (typeof module!=='undefined'&&module.exports) module.exports={tboxClampSize};
if (typeof window!=='undefined') window.CoreTbox={tboxClampSize};
