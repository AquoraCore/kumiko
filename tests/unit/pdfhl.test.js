import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// pdf.js is browser code — these are SOURCE guards for the 2026-08-18 highlight rework:
// the manual crop-to-image feature was REMOVED entirely (user decision: "ตัด feature การ crop
// ทั้งหมดออก") and the drag-a-box tool now creates an AREA HIGHLIGHT directly. Highlight
// comments became a multiline popover, and area highlights are movable/resizable.
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');
const pdfSrc = read('renderer/pdf.js');
const css = read('renderer/styles.css');
const htmlDesktop = read('renderer/index.html');
const htmlWeb = read('web/index.html');
const i18n = read('renderer/i18n.js');

describe('crop feature is fully removed', () => {
  it('no crop functions, mode, or menu remain in pdf.js', () => {
    expect(pdfSrc).not.toContain('pdfCropMode');
    expect(pdfSrc).not.toContain('cropToNote');
    expect(pdfSrc).not.toContain('captureCrop');
    expect(pdfSrc).not.toContain('showCropMenu');
    expect(pdfSrc).not.toContain('appendImageToTarget');
    expect(pdfSrc).not.toContain('pdfCropBtn');
  });
  it('toolbar button became the area-highlight button in BOTH shells', () => {
    for (const html of [htmlDesktop, htmlWeb]) {
      expect(html).not.toContain('pdfCropBtn');
      expect(html).toContain('pdfAreaBtn');
      expect(html).toContain('#i-select');   // not the scissors any more
    }
  });
  it('crop-only i18n strings are gone', () => {
    expect(i18n).not.toContain('ครอปเข้าโน้ต');
    expect(i18n).not.toContain('ครอปไม่ได้ — หน้ายังไม่เรนเดอร์');
  });
  it('AI slide-clip (===PDF-CLIP===) SURVIVES the crop removal', () => {
    expect(pdfSrc).toContain('async function clipPdfPageToTarget');
    expect(pdfSrc).toContain('await appendCaptureToTarget(r.md, r.page)');
  });
});

describe('drag-a-box = area highlight directly (no menu step)', () => {
  it('mouseup goes straight to areaHighlight with the page from the wrap', () => {
    expect(pdfSrc).toContain('function pdfAreaMouseup');
    expect(pdfSrc).toMatch(/areaHighlight\(d\.wrap, d\.rect, \+d\.wrap\.dataset\.page\)/);
  });
  it('tiny accidental drags (<8px) do not create a highlight', () => {
    expect(pdfSrc).toMatch(/if \(!\(w >= 8 && h >= 8\)\) \{ d\.rect\.remove\(\); return; \}/);
  });
  it('area mode and text mode stay mutually exclusive', () => {
    expect(pdfSrc).toContain('if (pdfAreaMode && pdfTextMode) toggleTextMode()');
    expect(pdfSrc).toContain('if (pdfTextMode && pdfAreaMode) toggleAreaMode()');
  });
  it('CSS mode class renamed crop-mode → area-mode (drag passes through text layer + old hls)', () => {
    expect(css).not.toContain('crop-mode');
    expect(css).toContain('.pdf-body.area-mode .pdf-textlayer, .pdf-body.area-mode .pdf-hl { pointer-events: none !important; }');
    expect(css).toContain('.pdf-area-rect');
  });
});

describe('highlight comment = multiline popover (improvement 4)', () => {
  it('editHlComment builds a textarea popover, not a one-line askName dialog', () => {
    expect(pdfSrc).toMatch(/function editHlComment\(hl\)\{/);
    expect(pdfSrc).toContain("createElement('textarea')");
    expect(pdfSrc).toContain('hl-note-pop');
    expect(pdfSrc).not.toMatch(/askName\(t\('คอมเมนต์สำหรับไฮไลต์'\)/);
  });
  it('click-off SAVES (sticky-box feel); Esc discards; ⌘/Ctrl+Enter saves', () => {
    expect(pdfSrc).toMatch(/onOut = \(e\) => \{ if \(!pop\.contains\(e\.target\)\) commit\(\); \}/);
    expect(pdfSrc).toMatch(/e\.key === 'Escape'/);
    expect(pdfSrc).toMatch(/e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)/);
  });
  it('multiline notes are quoted line-by-line in BOTH export paths', () => {
    // hlNoteQuote prefixes every line with "> " (first line gets the em-dash)
    expect(pdfSrc).toMatch(/function hlNoteQuote\(note\)\{/);
    expect(pdfSrc).toMatch(/split\(\/\\r\?\\n\/\)\.map\(\(l, i\) => '> ' \+ \(i === 0 \? '— ' : ''\) \+ l\)/);
    expect((pdfSrc.match(/hlNoteQuote\(h?l?\.note\)/g) || []).length).toBe(2);   // sendHighlightToNote + pageNotesMarkdown
    expect(pdfSrc).not.toContain("'\\n>\\n> — ' +");   // the old single-line concat is gone
  });
  it('panel renders multiline notes (pre-wrap)', () => {
    expect(css).toMatch(/\.pa-main-txt \{[^}]*white-space: pre-wrap/);
  });
});

describe('area highlights are movable + resizable (improvement 5)', () => {
  it('attachAreaEdit wires body-drag = move, corner grip = resize, ONLY for area highlights', () => {
    expect(pdfSrc).toContain('function attachAreaEdit(d, h)');
    expect(pdfSrc).toContain('if (h.area) attachAreaEdit(d, h);');
    expect(pdfSrc).toContain('pdf-hl-grip');
    expect(pdfSrc).toMatch(/start\(e, 'move'\)/);
    expect(pdfSrc).toMatch(/start\(e, 'resize'\)/);
  });
  it('rects stay normalized and clamped to the page (0..1)', () => {
    expect(pdfSrc).toMatch(/r\.x = Math\.max\(0, Math\.min\(r0\.x \+ dx, 1 - r0\.w\)\)/);
    expect(pdfSrc).toMatch(/r\.w = Math\.max\(0\.01, Math\.min\(r0\.w \+ dx, 1 - r0\.x\)\)/);
  });
  it('a real drag saves once and SUPPRESSES the click (else the color bar pops open)', () => {
    expect(pdfSrc).toContain('_hlSuppressClick = true');
    expect(pdfSrc).toMatch(/if \(_hlSuppressClick\) return; showHlBar/);
    // <4px press still counts as a click (threshold identical to the sticky-box drag)
    expect(pdfSrc).toMatch(/<= 4\) return;\n\s*moved = true;/);
  });
  it('grip is hover-only and styled as a corner handle', () => {
    expect(css).toMatch(/\.pdf-hl-grip \{[^}]*nwse-resize/);
    expect(css).toContain('.pdf-hl-area:hover .pdf-hl-grip { opacity: 1; }');
  });
});
