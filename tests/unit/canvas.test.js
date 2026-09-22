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

describe('AI canvas verbs — extractActions parsing', () => {
  const CM = require('../../core/markdown.js');
  it('parses the whole verb family, ordered, and strips them from chat', () => {
    const ac = CM.extractActions(
      'จัดให้ครับ\n' +
      '===CANVAS-BOARD name=สรุป BSS===\n' +
      '===CANVAS-ADD name=B AR CR segs=หัวข้อ A | หัวข้อ B w=640===\n' +
      '===CANVAS-ADD name=OES Process===\n' +
      '===CANVAS-WIRE from=B AR CR fromseg=หัวข้อ A to=OES Process===\n' +
      '===CANVAS-UNWIRE from=B AR CR to=OES Process===\n' +
      '===CANVAS-REMOVE name=OES Process seg=หัวข้อแรก===\n' +
      '===CANVAS-STICKY text=ออกสอบชัวร์===\nเสร็จแล้ว');
    expect(ac.canvasOps.map((o) => o.op)).toEqual(['board', 'add', 'add', 'wire', 'unwire', 'remove', 'sticky']);
    expect(ac.canvasOps[1]).toEqual({ op: 'add', name: 'B AR CR', segs: ['หัวข้อ A', 'หัวข้อ B'], w: 640 });
    expect(ac.canvasOps[2].segs).toEqual([]);
    expect(ac.canvasOps[3]).toEqual({ op: 'wire', from: 'B AR CR', fromSeg: 'หัวข้อ A', to: 'OES Process', toSeg: '' });
    expect(ac.canvasWrites).toBe(7);
    expect(ac.any).toBe(true);
    expect(ac.chat).toBe('จัดให้ครับ\n\nเสร็จแล้ว');
  });
  it('CANVAS-LIST is an ask verb (needsContinue), and edge: malformed lines are ignored', () => {
    const ac = CM.extractActions('===CANVAS-LIST===\n===CANVAS-ADD segs=x===\n===CANVAS-WIRE from=a===');
    expect(ac.canvasList).toBe(true);
    expect(ac.needsContinue).toBe(true);
    expect(ac.canvasOps).toEqual([]);   // both write lines malformed -> dropped
  });
});

describe('CoreCanvas.applyVerbOps', () => {
  const mkCtx = () => ({
    resolveNote: (nm) => ({ 'B AR CR': 'A/B AR CR.md', 'OES Process': 'A/OES Process.md' }[nm] || null),
    sectionsOf: (rel) => rel === 'A/B AR CR.md'
      ? [{ name: 'ภาพใหญ่', text: 'x' }, { name: 'Lapping', text: 'y' }]
      : [{ name: 'ขั้นตอน', text: 'z' }],
  });
  it('happy path: board -> add (named + default segs + w) -> wire by seg name -> sticky', () => {
    const st = CC.normState(null);
    const r = CC.applyVerbOps(st, [
      { op: 'board', name: 'สรุป BSS' },
      { op: 'add', name: 'B AR CR', segs: ['ภาพใหญ่', 'Lapping'], w: 640 },
      { op: 'add', name: 'OES Process', segs: [], w: 0 },
      { op: 'wire', from: 'B AR CR', fromSeg: 'Lapping', to: 'OES Process', toSeg: '' },
      { op: 'sticky', text: 'จำ!' },
    ], mkCtx());
    expect(r.errors).toEqual([]);
    expect(st.boards.length).toBe(2);            // default board + created one
    const b = st.boards[st.cur];
    expect(b.name).toBe('สรุป BSS');
    expect(b.cards.length).toBe(3);
    expect(b.cards[0].w).toBe(640);
    expect(b.cards[1].segs).toEqual(['ขั้นตอน']);   // default = first section
    expect(b.edges).toEqual([{ a: b.cards[0].id, aSeg: 1, b: b.cards[1].id, bSeg: null }]);
  });
  it('AI-clipped names: unique section-name prefix/substring resolves (GLM board 2026-09-08)', () => {
    const st = CC.normState(null);
    const ctx = {
      resolveNote: (nm) => nm === 'OES Process' ? 'A/OES Process.md' : null,
      sectionsOf: () => [
        { name: '1. ภาพรวมกระบวนการ', text: '' },
        { name: '2. หน่วยงานที่เกี่ยวข้อง (6 หน่วย)', text: '' },
        { name: '3. ลำดับการทำงาน (9 ขั้นตอน)', text: '' },
      ],
    };
    const r = CC.applyVerbOps(st, [
      { op: 'add', name: 'OES Process', segs: ['2. หน่วยงานที่เกี่ยวข้อง', 'ลำดับการทำงาน'] },
    ], ctx);
    expect(r.errors).toEqual([]);
    expect(st.boards[0].cards[0].segs).toEqual(['2. หน่วยงานที่เกี่ยวข้อง (6 หน่วย)', '3. ลำดับการทำงาน (9 ขั้นตอน)']);
  });
  it('edge: ambiguous clipped seg name (matches 2 sections) errors instead of guessing', () => {
    const st = CC.normState(null);
    const ctx = {
      resolveNote: () => 'A/x.md',
      sectionsOf: () => [{ name: 'Level 1 DFD', text: '' }, { name: 'Level 1 DFD รายละเอียด', text: '' }],
    };
    const r = CC.applyVerbOps(st, [{ op: 'add', name: 'x', segs: ['Level 1'] }], ctx);
    expect(r.errors.length).toBe(1);
    expect(st.boards[0].cards[0].segs).toEqual(['Level 1 DFD']);   // fallback = first section (prefix hit is ambiguous)
  });
  it('edge: unknown note, bad seg names, wire to card not on board -> errors not crashes', () => {
    const st = CC.normState(null);
    const r = CC.applyVerbOps(st, [
      { op: 'add', name: 'ไม่มีจริง', segs: [] },
      { op: 'add', name: 'B AR CR', segs: ['ผิดชื่อ'] },
      { op: 'wire', from: 'B AR CR', fromSeg: '', to: 'OES Process', toSeg: '' },
    ], mkCtx());
    expect(r.errors.length).toBe(3);
    const b = st.boards[st.cur];
    expect(b.cards.length).toBe(1);
    expect(b.cards[0].segs).toEqual(['ภาพใหญ่']);   // bad seg name -> falls back to first section
    expect(b.edges).toEqual([]);
  });
  it('edge: re-add merges segs; remove seg remaps edge indexes; remove card drops its edges', () => {
    const st = CC.normState(null), ctx = mkCtx();
    CC.applyVerbOps(st, [
      { op: 'add', name: 'B AR CR', segs: ['ภาพใหญ่'] },
      { op: 'add', name: 'B AR CR', segs: ['Lapping'] },     // merge, not duplicate card
      { op: 'add', name: 'OES Process', segs: [] },
      { op: 'wire', from: 'B AR CR', fromSeg: 'Lapping', to: 'OES Process', toSeg: '' },
    ], ctx);
    let b = st.boards[st.cur];
    expect(b.cards.length).toBe(2);
    expect(b.cards[0].segs).toEqual(['ภาพใหญ่', 'Lapping']);
    CC.applyVerbOps(st, [{ op: 'remove', name: 'B AR CR', seg: 'ภาพใหญ่' }], ctx);
    expect(b.edges[0].aSeg).toBe(0);              // Lapping shifted 1 -> 0, edge follows
    CC.applyVerbOps(st, [{ op: 'remove', name: 'OES Process', seg: '' }], ctx);
    expect(b.cards.length).toBe(1);
    expect(b.edges).toEqual([]);
  });
});

describe('Canvas wiring (renderer + view plumbing)', () => {
  it('index.html: canvasView container + core/canvas.js + canvas.js loaded after renderer.js', () => {
    const html = read('renderer/index.html');
    expect(html).toContain('<div id="canvasView" class="main-view"></div>');
    expect(html).toContain('../core/canvas.js');
    expect(html.indexOf('src="canvas.js"')).toBeGreaterThan(html.indexOf('src="renderer.js"'));
  });
  it('web/index.html loads canvas too (parity miss 2026-09-12: web canvas view rendered blank)', () => {
    const w = read('web/index.html');
    expect(w).toContain('/core/canvas.js?v=__ASSET_VERSION__');
    expect(w).toContain('/renderer/canvas.js?v=__ASSET_VERSION__');
    expect(w).toContain('<div id="canvasView" class="main-view"></div>');
    expect(w.indexOf('/renderer/canvas.js')).toBeGreaterThan(w.indexOf('/renderer/renderer.js'));
  });
  it('renderer.js: setMainView knows canvas (class, render, lastOpen, Esc) + sidebar leaf', () => {
    const r = read('renderer/renderer.js');
    expect(r).toContain("left.classList.toggle('view-canvas', v==='canvas')");
    expect(r).toContain("v==='canvas' && typeof renderCanvas === 'function'");
    expect(r).toMatch(/v==='graph' \|\| v==='canvas' \|\| v==='table'.*vsSet\('lastOpen'/);
    expect(r).toContain("mainView==='canvas'");
    // sidebar = board LIST group like dashboards (＋ on the header, rows open boards) —
    // the old single leaf + in-canvas board <select> are gone (user 2026-09-15)
    expect(r).toMatch(/sbGroup\('canvas'.*addLabel.*kvNewBoardFlow/s);
    expect(r).toContain('function renderSbKvList(');
    expect(r).toContain('kvOpenBoard(i)');
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
  it('AI pipeline: verbs execute via runKumikoVerbs, CANVAS-LIST feeds buildToolResults, prompt documents them', () => {
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/acts\.canvasOps \|\| \[\]\)\.length && typeof kvApplyAiOps === 'function'/);
    expect(r).toMatch(/acts\.canvasList && typeof kvCanvasToolResult === 'function'/);
    expect(r).toContain('===CANVAS-ADD name=ชื่อโน้ต segs=');
    const c = read('renderer/canvas.js');
    expect(c).toContain('async function kvApplyAiOps(');
    expect(c).toContain("action: { label: t('เปิดแคนวาส'), fn: () => setMainView('canvas') }");
    const ch = read('renderer/chat.js');
    expect(ch).toContain("t('จัดแคนวาส')");
  });
  it('i18n: canvas strings have EN entries (sidebar leaf + hint)', () => {
    const i = read('renderer/i18n.js');
    expect(i).toContain("'แคนวาส': 'Canvas'");
    expect(i).toMatch(/'ลากหัวการ์ด = ย้าย[^']*': 'Drag header = move/);
  });
});

describe('auto-arrange (2026-09-09: tall cards overlapped the fixed-stride guess)', () => {
  it('applyVerbOps reports addedIds so the renderer can re-place ONLY new cards later', () => {
    const st = CC.normState(null);
    const ctx = { resolveNote: () => 'A/x.md', sectionsOf: () => [{ name: 's', text: '' }] };
    const r = CC.applyVerbOps(st, [
      { op: 'add', name: 'x', segs: [] },
      { op: 'sticky', text: 'y' },
      { op: 'add', name: 'x', segs: [] },   // merge into existing card -> NOT re-added
    ], ctx);
    expect(r.addedIds.length).toBe(2);
    expect(r.addedIds).toEqual(st.boards[st.cur].cards.map((c) => c.id));
  });
  it('renderer: shelf layout from measured heights + toolbar button + post-AI re-place', () => {
    const c = read('renderer/canvas.js');
    expect(c).toContain('function kvAutoArrange(ids)');
    expect(c).toMatch(/n \? n\.offsetHeight : 220/);                      // REAL heights, not a stride guess
    expect(c).toMatch(/others\.map\(\(c\) => c\.y \+ hOf\(c\)\)/);        // id-list mode stacks below existing content
    expect(c).toMatch(/kvArr'\)\.onclick = \(\) => \{ kvGridSuckIn\(null\); kvArrangeSettled\(null, 'grid'\); \}/);   // ⊞ = grid (G2)
    expect(c).toMatch(/sig !== prev && tries\+\+ < 12/);   // re-runs until heights settle (late mermaid growth)
  });
});

describe('hub layout (2026-09-09: overview card centred, details flank it)', () => {
  it('renderer: kvHubArrange picks the most-wired card as hub, balances left/right by height', () => {
    const c = read('renderer/canvas.js');
    expect(c).toContain('function kvHubArrange()');
    expect(c).toMatch(/\(deg\[b\.id\] \|\| 0\) - \(deg\[a\.id\] \|\| 0\)\) \|\| \(b\.w - a\.w\)/);   // degree, tie-break width
    expect(c).toMatch(/leftH <= rightH/);                                                            // height-balanced columns
    expect(c).toMatch(/linkedToHub\(b\) - linkedToHub\(a\)/);                                        // hub-wired cards sit nearest
    expect(c).toContain("getElementById('kvHub').onclick = () => kvArrangeSettled(null, true)");
    expect(c).toMatch(/mode === 'grid' \? kvGridArrange\(\) : \(mode \? kvHubArrange\(\) : kvAutoArrange\(ids\)\)/);   // settle loop covers all modes
    expect(c).toMatch(/!host \|\| !host\.offsetParent/);   // hidden view measures 0 — wait, don't arrange garbage
  });
});

describe('grid verbs (G2, 2026-09-22): place + arrange + normBoard at/span', () => {
  const mkCtx2 = () => ({
    resolveNote: (nm) => ({ 'DFD': 'A/DFD.md', 'AP-CD': 'A/AP-CD.md' }[nm] || null),
    sectionsOf: (rel) => rel === 'A/DFD.md'
      ? [{ name: 'Level 0', text: 'x' }, { name: 'Level 1', text: 'y' }]
      : [{ name: 'Process', text: 'z' }],
  });
  it('place: creates a card with at/span, width follows the span exactly (rule 1)', () => {
    const st = CC.normState(null);
    const r = CC.applyVerbOps(st, [{ op: 'place', name: 'DFD', seg: 'Level 1', at: '2,1', size: '4x3' }], mkCtx2());
    expect(r.errors).toEqual([]);
    const c = st.boards[0].cards[0];
    expect(c.at).toEqual({ c: 2, r: 1 });
    expect(c.span).toEqual({ w: 4, h: 3 });
    expect(c.w).toBe(4 * 84 + 3 * 14);            // spanToPx — no 200px floor on grid cards
    expect(c.x).toBe(20 + 2 * 98); expect(c.y).toBe(20 + 98);
    expect(c.segs).toEqual(['Level 1']);
    expect(r.addedIds).toEqual([c.id]);
  });
  it('place: existing card -> moved (seg added if missing), never duplicated', () => {
    const st = CC.normState(null), ctx = mkCtx2();
    CC.applyVerbOps(st, [{ op: 'place', name: 'DFD', at: '0,0', size: '2x2' }], ctx);
    const id0 = st.boards[0].cards[0].id;
    const r = CC.applyVerbOps(st, [{ op: 'place', name: 'DFD', seg: 'Level 1', at: '3,0', size: '2x1' }], ctx);
    expect(r.errors).toEqual([]);
    expect(r.addedIds).toEqual([]);
    const b = st.boards[0];
    expect(b.cards.length).toBe(1);
    expect(b.cards[0].id).toBe(id0);
    expect(b.cards[0].at).toEqual({ c: 3, r: 0 });
    expect(b.cards[0].span).toEqual({ w: 2, h: 1 });
    expect(b.cards[0].segs).toEqual(['Level 0', 'Level 1']);   // first place defaulted, second added its seg
  });
  it('place: no at -> firstFit free top-left; no size -> default 2x1', () => {
    const st = CC.normState(null), ctx = mkCtx2();
    CC.applyVerbOps(st, [{ op: 'place', name: 'DFD', at: '0,0', size: '4x1' }], ctx);   // occupies cols 0-3
    CC.applyVerbOps(st, [{ op: 'place', name: 'AP-CD' }], ctx);                          // no at, no size
    const b = st.boards[0];
    expect(b.cards[1].at).toEqual({ c: 4, r: 0 });   // first free slot right of the 4-wide card
    expect(b.cards[1].span).toEqual({ w: 2, h: 1 });
  });
  it('place: unparseable at/size -> per-item errors, nothing placed', () => {
    const st = CC.normState(null), ctx = mkCtx2();
    const r = CC.applyVerbOps(st, [
      { op: 'place', name: 'DFD', at: 'left,top', size: '4x3' },
      { op: 'place', name: 'DFD', at: '0,0', size: 'big' },
      { op: 'place', name: 'ไม่มีโน้ตนี้', at: '0,0' },
    ], ctx);
    expect(r.errors.length).toBe(3);
    expect(st.boards[0].cards.length).toBe(0);
  });
  it('arrange: sets the board flag (grid default, hub on demand)', () => {
    const st = CC.normState(null);
    CC.applyVerbOps(st, [{ op: 'arrange', mode: '' }], mkCtx2());
    expect(st.boards[0].needsArrange).toBe('grid');
    CC.applyVerbOps(st, [{ op: 'arrange', mode: 'hub' }], mkCtx2());
    expect(st.boards[0].needsArrange).toBe('hub');
  });
  it('normBoard: keeps at/span, derives w from span; old free cards pass through untouched', () => {
    const s = CC.normState({ boards: [{
      name: 'b', cards: [
        { id: 1, type: 'note', rel: 'a.md', x: 111, y: 222, w: 999, segs: ['x'], at: { c: 2, r: 3 }, span: { w: 3, h: 2 } },
        { id: 2, type: 'note', rel: 'b.md', x: 5, y: 6, w: 300, segs: ['y'], at: 'junk', span: null },
        { id: 3, type: 'sticky', body: 'ok', x: 7, y: 8, w: 200 },
      ],
    }] });
    const cs = s.boards[0].cards;
    expect(cs[0].at).toEqual({ c: 2, r: 3 });
    expect(cs[0].span).toEqual({ w: 3, h: 2 });
    expect(cs[0].w).toBe(3 * 84 + 2 * 14);   // span wins over the stored w
    expect(cs[1].at).toBeUndefined();        // garbage at -> free card
    expect(cs[1].w).toBe(300);
    expect(cs[2].at).toBeUndefined();        // sticky untouched
  });
});

describe('grid arrange wiring (renderer, G2)', () => {
  it('canvas.js: kvGridArrange/kvGridSuckIn/kvSnapCard + needsArrange + drop snap + prompt + script include', () => {
    const c = read('renderer/canvas.js');
    expect(c).toContain('function kvGridArrange()');
    expect(c).toContain('window.CoreCanvasGrid');
    expect(c).toMatch(/G\.layoutGrid\(/);
    expect(c).toContain('function kvGridSuckIn(ids)');
    expect(c).toContain('function kvSnapCard(c)');
    expect(c).toMatch(/G\.pxToCell\(c\.x, c\.y\)/);
    expect(c).toMatch(/G\.spanFromPx\(c\.w, kvHOf\(c\) \|\| 180\)/);
    expect(c).toMatch(/st\.needsArrange[\s\S]{0,200}kvArrangeSettled\(null, mode\)/);   // flag consumed at paint
    expect(c).toMatch(/batchPlaced[\s\S]{0,220}needsArrange = 'grid'/);                 // auto grid after place/add
    expect(c).toContain("world.classList.add('kv-griding')");
    expect(read('renderer/renderer.js')).toContain('===CANVAS-PLACE board=');
    expect(read('renderer/index.html')).toContain('../core/canvasgrid.js');
    expect(read('web/index.html')).toContain('/core/canvasgrid.js?v=__ASSET_VERSION__');
    expect(read('renderer/styles.css')).toMatch(/kv-griding[^}]*98px 98px/);
  });
});
