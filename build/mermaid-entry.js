// Mermaid bundle — exposes window.mermaid for the Milkdown mermaid plugin + previews.
// Bundled to renderer/vendor/mermaid.bundle.js
import mermaid from 'mermaid';
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'inherit' });
window.mermaid = mermaid;
