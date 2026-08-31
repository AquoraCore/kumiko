import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

// Bug 2026-08-18: a note with a Thai mermaid diagram filled the page with giant
// "Syntax error in graph" bombs. Root cause was NOT our code — mermaid 8.14 (pulled in
// transitively by a stale `hypermd` dep) cannot parse non-Latin labels at all: `A[เริ่ม]`
// threw, and mermaid then drew its own page-sized error SVG into <body>. Since decorations()
// re-runs on every keystroke, typing stacked one bomb per character.
describe('mermaid renders Thai and never draws page-sized errors', () => {
  it('is pinned to v11 as a DIRECT dependency (8.x cannot parse Thai)', () => {
    const pkg = JSON.parse(read('package.json'));
    const dep = (pkg.dependencies && pkg.dependencies.mermaid) || '';
    expect(dep).toBeTruthy();
    expect(dep).toMatch(/1[1-9]/);          // v11+
    const installed = JSON.parse(read('node_modules/mermaid/package.json')).version;
    expect(parseInt(installed.split('.')[0], 10)).toBeGreaterThanOrEqual(11);
  });

  it('initialises with suppressErrorRendering so mermaid never injects its own error graphic', () => {
    const entry = read('build/mermaid-entry.js');
    expect(entry).toContain('suppressErrorRendering: true');
    expect(entry).toContain('startOnLoad: false');
  });

  it('uses the v11 promise API and shows a SMALL notice when a diagram is invalid', () => {
    const src = read('build/crepe-entry.js');
    expect(src).toMatch(/const r = mm\.render\(id, code\)/);   // no callback arg (v8 style)
    expect(src).toContain('await r');
    expect(src).toContain('md-mermaid-err');
    expect(src).toContain('_mmSweepOrphans');                   // clears anything left in <body>
  });

  it('caps the rendered diagram so it can never stretch the page', () => {
    const css = read('renderer/styles.css');
    expect(css).toMatch(/\.md-mermaid-render \{[^}]*max-height:\s*70vh/);
  });
});

// Requested with the fix: show the diagram, not the source; click the diagram to edit it.
describe('mermaid is diagram-first, click to edit', () => {
  const src = read('build/crepe-entry.js');
  it('hides the ```mermaid source unless the caret is inside the block', () => {
    expect(src).toContain('md-mm-src-hidden');
    expect(src).toMatch(/const editing = sel\.from >= pos && sel\.to <= end/);
    expect(src).toMatch(/if \(!editing\) decos\.push\(Decoration\.node\(pos, end/);
  });
  it('clicking the diagram puts the caret in the source (flips to edit mode)', () => {
    expect(src).toContain('TextSelection.create');
    expect(src).toContain('คลิกเพื่อแก้ไขแผนภาพ');
  });
  it('styles the two states distinctly', () => {
    const css = read('renderer/styles.css');
    expect(css).toContain('.md-mermaid-render:not(.is-editing)');
    expect(css).toContain('.md-mermaid-render.is-editing');
  });
});

// The .wl-hide CSS shipped long ago but NOTHING ever applied the class — so [[brackets]]
// were always visible, for every link (not just ones with parentheses in the title).
describe('wikilink brackets hide until the caret enters the link', () => {
  const src = read('build/crepe-entry.js');
  it('applies wl-hide to the [[ and ]] when the selection is outside', () => {
    expect(src).toContain("class: 'wl-hide'");
    expect(src).toMatch(/const inside = sel\.from <= to && sel\.to >= from/);
    expect(src).toMatch(/if \(!inside\)/);
  });
  it('the hide style it depends on still exists', () => {
    expect(read('renderer/styles.css')).toContain('.wl-hide');
  });
});
