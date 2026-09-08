import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');
const CC = require('../../core/canvas.js');

// Kumiko Canvas (2026-09-08): boards of note-cards showing FULL chosen sections, wires that
// anchor at the SEGMENT (dashed = live suggestion from [[wikilinks]], solid = confirmed and
// saved), stickies, resize, multi-board via vaultConfig key 'canvas'.

describe('CoreCanvas.parseSections', () => {
  it('splits by headings; intro before the first heading becomes (บทนำ)', () => {
    const s = CC.parseSections('intro line\n\n# หนึ่ง\na\nb\n\n## สอง\nc');
    expect(s.map((x) => x.name)).toEqual([CC.INTRO, 'หนึ่ง', 'สอง']);
    expect(s[1].text).toBe('a\nb');
    expect(s[2].text).toBe('c');
  });
  it('edge: empty note -> no sections; no headings -> single intro; skips headings in fences', () => {
    expect(CC.parseSections('')).toEqual([]);
    expect(CC.parseSections('just text')).toEqual([{ name: CC.INTRO, text: 'just text' }]);
    const s = CC.parseSections('# จริง\n```\n# ในโค้ด\n```\ntail');
    expect(s.length).toBe(1);
    expect(s[0].name).toBe('จริง');
    expect(s[0].text).toContain('# ในโค้ด');
  });
  it('edge: duplicate heading names get numbered so seg refs stay unambiguous', () => {
    const s = CC.parseSections('# ซ้ำ\na\n# ซ้ำ\nb');
    expect(s.map((x) => x.name)).toEqual(['ซ้ำ', 'ซ้ำ (2)']);
  });
  it('edge: YAML frontmatter is metadata, never a (บทนำ) section (real AP-CD note bite)', () => {
    const s = CC.parseSections('---\ntags: บท/13\n---\n# หัว\nเนื้อ');
    expect(s.map((x) => x.name)).toEqual(['หัว']);
    const s2 = CC.parseSections('---\ntags: x\n---\nintro จริง\n# หัว\na');
    expect(s2[0]).toEqual({ name: CC.INTRO, text: 'intro จริง' });
  });
});

describe('CoreCanvas.sectionLinks', () => {
  it('extracts [[target]], strips |label and #page, dedupes', () => {
    expect(CC.sectionLinks('ไป [[B AR CR]] และ [[X/Y|ป้าย]] กับ [[B AR CR#p2]]')).toEqual(['B AR CR', 'X/Y']);
  });
  it('edge: no links / null -> empty', () => {
    expect(CC.sectionLinks('ไม่มี')).toEqual([]);
    expect(CC.sectionLinks(null)).toEqual([]);
  });
});

describe('CoreCanvas.suggestEdges', () => {
  const secs = {
    'A/one.md': [{ name: 's1', text: 'โยง [[two]]' }, { name: 's2', text: 'เฉย ๆ' }],
    'A/two.md': [{ name: 't1', text: 'กลับไป [[one]]' }],
  };
  const cards = [
    { id: 1, type: 'note', rel: 'A/one.md', segs: ['s1', 's2'] },
    { id: 2, type: 'note', rel: 'A/two.md', segs: ['t1'] },
  ];
  const of = (rel) => secs[rel];
  it('wires FROM the linking segment and aims at the target segment that links back', () => {
    const e = CC.suggestEdges(cards, of, []);
    expect(e).toContainEqual({ a: 1, aSeg: 0, b: 2, bSeg: 0, auto: true });
    expect(e).toContainEqual({ a: 2, aSeg: 0, b: 1, bSeg: 0, auto: true });
  });
  it('edge: a confirmed edge covers the pair -> no dashed duplicate (either direction)', () => {
    const e = CC.suggestEdges(cards, of, [{ a: 1, aSeg: 0, b: 2, bSeg: null }]);
    expect(e.some((x) => x.a === 1 && x.aSeg === 0 && x.b === 2)).toBe(false);
    const e2 = CC.suggestEdges(cards, of, [{ a: 2, aSeg: null, b: 1, bSeg: 0 }]);
    expect(e2.some((x) => x.a === 1 && x.aSeg === 0)).toBe(false);   // covered via reversed b/bSeg
  });
  it('edge: link to a note not on the board, self-link, sticky cards -> ignored', () => {
    const cards2 = cards.concat([{ id: 3, type: 'sticky', body: '[[one]]' }]);
    const e = CC.suggestEdges(cards2, (rel) => secs[rel] || [{ name: 'z', text: '[[nowhere]] [[one]]' }], []);
    expect(e.every((x) => x.a !== 3 && x.b !== 3)).toBe(true);
    expect(e.every((x) => x.a !== x.b)).toBe(true);
  });
});

describe('CoreCanvas.normState / normBoard', () => {
  it('null/garbage -> one default board, cur 0', () => {
    const s = CC.normState(null);
    expect(s.boards.length).toBe(1);
    expect(s.cur).toBe(0);
    expect(s.boards[0].cards).toEqual([]);
  });
  it('edge: drops bad cards/edges, clamps w and scale, seq advances past max id', () => {
    const s = CC.normState({
      cur: 9,
      boards: [{
        name: 'b', view: { scale: 99 },
        cards: [
          { id: 5, type: 'note', rel: 'a.md', w: 9999, segs: ['x'] },
          { id: 0, type: 'note', rel: 'zero-id-dropped.md' },
          { type: 'note' },              // no rel -> dropped
          { id: 7, type: 'sticky', body: 'ok', w: 1 },
        ],
        edges: [
          { a: 5, b: 7, aSeg: 0, bSeg: null },
          { a: 5, b: 99 },               // dangling -> dropped
          { a: 5, b: 5 },                // self -> dropped
        ],
      }],
    });
    expect(s.cur).toBe(0);               // out-of-range cur clamped
    const b = s.boards[0];
    expect(b.view.scale).toBe(2.5);
    expect(b.cards.map((c) => c.id)).toEqual([5, 7]);
    expect(b.cards[0].w).toBe(1400);
    expect(b.cards[1].w).toBe(200);
    expect(b.edges).toEqual([{ a: 5, b: 7, aSeg: 0, bSeg: null }]);
    expect(b.seq).toBe(8);
  });
});

describe('Canvas wiring (renderer + view plumbing)', () => {
  it('index.html: canvasView container + core/canvas.js + canvas.js loaded after renderer.js', () => {
    const html = read('renderer/index.html');
    expect(html).toContain('<div id="canvasView" class="main-view"></div>');
    expect(html).toContain('../core/canvas.js');
    expect(html.indexOf('src="canvas.js"')).toBeGreaterThan(html.indexOf('src="renderer.js"'));
  });
  it('renderer.js: setMainView knows canvas (class, render, lastOpen, Esc) + sidebar leaf', () => {
    const r = read('renderer/renderer.js');
    expect(r).toContain("left.classList.toggle('view-canvas', v==='canvas')");
    expect(r).toContain("v==='canvas' && typeof renderCanvas === 'function'");
    expect(r).toMatch(/v==='graph' \|\| v==='canvas' \|\| v==='table'.*vsSet\('lastOpen'/);
    expect(r).toContain("mainView==='canvas'");
    expect(r).toMatch(/sbGroup\('canvas'.*leafView: 'canvas'/);
    // lightbox hover ⛶ / ⌘click zones include the canvas
    expect(r).toMatch(/\['editorWrap', 'chatMessages', 'canvasView'\]/);
  });
  it('canvas.js: boards persist via vaultConfig key canvas; suggestions never stored; media cap constants', () => {
    const c = read('renderer/canvas.js');
    expect(c).toContain("vaultConfigWrite('canvas', KV)");
    expect(c).toContain("vaultConfigRead('canvas')");
    expect(c).toContain('CoreCanvas.suggestEdges(st.cards, kvSectionsSync, st.edges)');
    expect(c).toContain('const KV_BIG_W = 560');
    // confirming a dashed edge stores ONLY the endpoints (no auto flag persisted)
    expect(c).toMatch(/st\.edges\.push\(\{ a: e\.a, b: e\.b, aSeg: e\.aSeg, bSeg: e\.bSeg \}\)/);
    // note edits invalidate the section cache
    expect(c).toMatch(/onNoteChanged[\s\S]{0,200}kvNoteCache\.delete\(name\)/);
    // cursor-anchored zoom
    expect(c).toMatch(/st\.view\.tx = cx - \(cx - st\.view\.tx\) \* \(ns \/ st\.view\.scale\)/);
  });
  it('styles.css: view-canvas shows #canvasView and hides editor chrome; media cap + wide lift', () => {
    const css = read('renderer/styles.css');
    expect(css).toContain('#left.view-canvas #canvasView { display: flex; }');
    expect(css).toMatch(/#left\.view-canvas #editorWrap[\s\S]{0,120}display: none !important/);
    expect(css).toMatch(/\.kv-media \{[^}]*max-height: 340px/);
    expect(css).toMatch(/\.kv-card\.kv-wide \.kv-media \{ max-height: none; \}/);
  });
  it('i18n: canvas strings have EN entries (sidebar leaf + hint)', () => {
    const i = read('renderer/i18n.js');
    expect(i).toContain("'แคนวาส': 'Canvas'");
    expect(i).toMatch(/'ลากหัวการ์ด = ย้าย[^']*': 'Drag header = move/);
  });
});
