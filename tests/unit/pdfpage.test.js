import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// PDF page memory stability (2026-08-25). Reported: "ระบบจำหน้า PDF ไม่เสถียร" when switching
// note ↔ pdf ↔ other pdf. Live CDP trace showed three clobber paths:
//   1. re-showing a hidden pane → browser restores scrollTop to a nearby-but-wrong offset
//      → pdfScrollSync saved that wrong page (20 became 14) before any user action;
//   2. openPdf's same-doc fast path returned without re-anchoring to the saved page;
//   3. during a goto glide / PDF→PDF switch, clamp-to-0 and mid-glide scroll events saved
//      junk pages (v=3 at scrollTop 0) onto the current or NEW pdf.
const src = fs.readFileSync(path.join(__dirname, '../../renderer/pdf.js'), 'utf8');

// pull the pure predicate out of the browser file and eval it standalone
function extractFn(name) {
  const m = src.match(new RegExp('function ' + name + '\\([\\s\\S]*?\\n}'));
  if (!m) throw new Error(name + ' not found in pdf.js');
  return eval('(' + m[0] + ')');
}
const pdfSyncAllowed = extractFn('pdfSyncAllowed');

describe('pdfSyncAllowed — when may a scroll event save the page?', () => {
  const LOADED = 'a/b.pdf';
  it('happy: user scroll on the visible, loaded doc', () => {
    expect(pdfSyncAllowed('pdf', 0, LOADED, LOADED, 36)).toBe(true);
  });
  it('blocked while the pane is not the active view (note/dash open)', () => {
    expect(pdfSyncAllowed('note', 0, LOADED, LOADED, 36)).toBe(false);
    expect(pdfSyncAllowed('dash', 0, LOADED, LOADED, 36)).toBe(false);
  });
  it('blocked while a programmatic goto is mid-glide', () => {
    expect(pdfSyncAllowed('pdf', 1, LOADED, LOADED, 36)).toBe(false);
  });
  it('blocked during a PDF→PDF switch (host still shows the OLD doc)', () => {
    expect(pdfSyncAllowed('pdf', 0, LOADED, 'c/new.pdf', 36)).toBe(false);
  });
  it('blocked when the host has been cleared (no page wraps) or no current pdf', () => {
    expect(pdfSyncAllowed('pdf', 0, LOADED, LOADED, 0)).toBe(false);
    expect(pdfSyncAllowed('pdf', 0, null, null, 36)).toBe(false);
  });
});

describe('source guards for the restore paths', () => {
  it('pdfScrollSync consults pdfSyncAllowed before saving', () => {
    expect(src).toMatch(/function pdfScrollSync[\s\S]{0,400}pdfSyncAllowed\(mainView, pdfRestoring, pdfLoadedName, currentPdf/);
  });
  it('same-doc fast path re-anchors to the REMEMBERED page instead of bare return', () => {
    const fast = src.match(/name === pdfLoadedName && pdfDoc[\s\S]{0,600}?\n {2}\}/);
    expect(fast).toBeTruthy();
    expect(fast[0]).toContain('vsPdfPageGet(name)');
    expect(fast[0]).toContain('pdfGoto(');
  });
  it('pdfScrollToPage suppresses sync during the glide and stamps the destination on settle', () => {
    const fn = src.match(/function pdfScrollToPage[\s\S]*?\n}/)[0];
    expect(fn).toContain('pdfRestoring++');
    expect(fn).toMatch(/settle[\s\S]*pdfRestoring = Math\.max\(0, pdfRestoring - 1\)/);
    expect(fn).toContain('vsPdfPageSet(currentPdf, page)');
    // saves only when the loaded doc is still the current one
    expect(fn).toContain('currentPdf === pdfLoadedName');
  });
});
