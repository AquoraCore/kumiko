import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// Clip snapshot rework (2026-08-25): a capture must be "ภาพของหน้านั้น ณ เวลานั้น" — the
// user's stickies + highlights are BURNED into the clip image instead of being appended as
// text under it. Only highlight COMMENTS (invisible on the page) remain as text.
const src = fs.readFileSync(path.join(__dirname, '../../renderer/pdf.js'), 'utf8');

function extractFn(name) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'));
  if (!m) throw new Error(name + ' not found in pdf.js');
  return eval('(' + m[0] + ')');
}
const _tboxPlainLines = extractFn('_tboxPlainLines');
const _wrapCanvasText = extractFn('_wrapCanvasText');
// width model for the mock canvas: 10px per character
const ctx = { measureText: (s) => ({ width: String(s).length * 10 }) };

describe('_tboxPlainLines — sticky markdown flattened for canvas', () => {
  it('happy: strips markers, keeps bullets as •', () => {
    expect(_tboxPlainLines('# หัวข้อ\n- **สำคัญ** มาก\n`code`')).toEqual(['หัวข้อ', '• สำคัญ มาก', 'code']);
  });
  it('edge: links/wikilinks show their label, images vanish, code fences vanish', () => {
    expect(_tboxPlainLines('[ดู](http://x)\n[[a/b|ป้าย]]\n![img](data:image/png;base64,xx)\n```js\nhidden\n```')).toEqual(['ดู', 'ป้าย']);
  });
  it('edge: markdown backslash-escapes display as the bare character', () => {
    expect(_tboxPlainLines('ใบลดหนี้\n\n\\= Credit note')).toEqual(['ใบลดหนี้', '', '= Credit note']);
    expect(_tboxPlainLines('\\- ไม่ใช่ bullet')).toEqual(['- ไม่ใช่ bullet']);
  });
  it('edge: blank input and surrounding empty lines', () => {
    expect(_tboxPlainLines('')).toEqual([]);
    expect(_tboxPlainLines('\n\nกลาง\n\n')).toEqual(['กลาง']);
  });
});

describe('_wrapCanvasText — wrapping inside the box width', () => {
  it('happy: wraps on spaces', () => {
    expect(_wrapCanvasText(ctx, ['aaa bbb ccc'], 80)).toEqual(['aaa bbb', 'ccc']);
  });
  it('edge: Thai (no spaces) falls back to per-character breaking, never overflows', () => {
    const out = _wrapCanvasText(ctx, ['กขคงจฉชซฌญ'], 40);
    expect(out.every((l) => l.length * 10 <= 40)).toBe(true);
    expect(out.join('')).toBe('กขคงจฉชซฌญ');
  });
  it('edge: preserves deliberate blank lines', () => {
    expect(_wrapCanvasText(ctx, ['a', '', 'b'], 100)).toEqual(['a', '', 'b']);
  });
});

describe('source guards — burn path is wired', () => {
  it('renderPdfClipMarkdown draws annotations onto the canvas before encoding', () => {
    const fn = src.match(/async function renderPdfClipMarkdown[\s\S]*?\n}/)[0];
    expect(fn).toContain('drawPageAnnotsToCanvas(');
    expect(fn.indexOf('drawPageAnnotsToCanvas(')).toBeLessThan(fn.indexOf('toDataURL'));
  });
  it('pageNotesMarkdown no longer repeats text-box content as text', () => {
    const fn = src.match(/function pageNotesMarkdown[\s\S]*?\n}/)[0];
    expect(fn).not.toContain('textboxes');
    expect(fn).toContain('h.note');
  });
  it('canvas theme palette mirrors every sticky theme', () => {
    for (const name of ['yellow', 'pink', 'blue', 'green', 'purple', 'clear', 'white']) {
      expect(src).toMatch(new RegExp('TBOX_CANVAS_THEME = \\{[\\s\\S]*?' + name + ':'));
    }
  });
});
