// Mermaid bundle — exposes window.mermaid for the Milkdown mermaid plugin + previews.
// Bundled to renderer/vendor/mermaid.bundle.js
// v11 (was 8.14 via a stale hypermd transitive dep): 8.x could not parse non-Latin labels at all —
// a Thai node like A[เริ่ม] THREW, and mermaid then painted its full-size "Syntax error" graphic.
import mermaid from 'mermaid';
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'neutral',
  fontFamily: 'inherit',
  suppressErrorRendering: true,   // v11: never inject the giant error SVG; we show our own notice
});
window.mermaid = mermaid;
