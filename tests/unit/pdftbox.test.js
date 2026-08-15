import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// pdf.js is browser code (window/document/Crepe), so it can't be imported into node.
// These are SOURCE guards that lock in two real bugs found on 2026-08-15:
//   1. The text-box opened a Milkdown editor but never placed a caret, so keystrokes
//      went nowhere ("can't type / not a real WYSIWYG"). Fix: focus + collapse a
//      Selection range to the end right after create().
//   2. The box disabled 8 Crepe features, diverging from the note editor. The user
//      wanted it to behave EXACTLY like a note — so it must disable ONLY the Cursor
//      feature, same as renderer.js's loadEditor().
const pdfSrc = fs.readFileSync(path.join(__dirname, '../../renderer/pdf.js'), 'utf8');

describe('PDF text-box is a real WYSIWYG editor (like a note)', () => {
  it('places a caret when the editor opens (else typing does nothing)', () => {
    // the focus helper + an explicit caret-at-end via a collapsed Selection range
    expect(pdfSrc).toContain('_focusEnd');
    expect(pdfSrc).toMatch(/getSelection/);
    expect(pdfSrc).toMatch(/collapse\(false\)/);        // caret to END of content
    expect(pdfSrc).toMatch(/requestAnimationFrame\(_focusEnd\)/); // retry across a frame
  });

  it('uses the SAME Crepe feature policy as the note editor (only Cursor disabled)', () => {
    // must disable Cursor...
    expect(pdfSrc).toMatch(/F\.Cursor\s*\|\|\s*'cursor'/);
    // ...and must NOT re-introduce the old 8-feature blocklist that broke input rules
    expect(pdfSrc).not.toMatch(/F\.Toolbar,\s*F\.BlockEdit,\s*F\.ImageBlock/);
  });
});
