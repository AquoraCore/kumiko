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

  it('Crepe feature policy: Cursor off (like the note editor) + Toolbar off (2026-08-19)', () => {
    // must disable Cursor...
    expect(pdfSrc).toMatch(/F\.Cursor\s*\|\|\s*'cursor'/);
    // ...and the floating selection toolbar (it overlapped the box and duplicated its own bar)
    expect(pdfSrc).toMatch(/feats\[F\.Toolbar \|\| 'toolbar'\] = false/);
    // ...but must NOT re-introduce the old 8-feature blocklist that broke input rules
    expect(pdfSrc).not.toMatch(/F\.Toolbar,\s*F\.BlockEdit,\s*F\.ImageBlock/);
  });
});

// Formatting toolbar added 2026-08-17: B/I/S, H/•/1./code, link smart-paste,
// alignment cycle (left→center→right, whole-box b.align), and a text-colour palette.
describe('PDF text-box formatting toolbar', () => {
  it('registers the inline-colour and link-paste plugins on the box editor', () => {
    expect(pdfSrc).toContain('c.editor.use(window.MDTColor)');
    expect(pdfSrc).toContain('c.editor.use(window.MDLinkPaste)');
  });
  it('shows the toolbar while editing and hides it on endEdit', () => {
    expect(pdfSrc).toMatch(/tbar\.hidden = false/);
    expect(pdfSrc).toMatch(/tbar\.hidden = true/);
  });
  it('drives commands through window.MDEdit and keeps selection via mousedown', () => {
    expect(pdfSrc).toContain('window.MDEdit.getView');
    expect(pdfSrc).toContain('window.MDEdit.cmd.toggleMark');
    expect(pdfSrc).toContain('window.MDEdit.list.wrapInList');
    // buttons must preventDefault on mousedown or the editor loses its selection
    expect(pdfSrc).toMatch(/addEventListener\('mousedown'.*preventDefault/s);
  });
  it('legacy b.align still renders (feature cut from the bar, data respected)', () => {
    expect(pdfSrc).toContain('_applyAlign');
    expect(pdfSrc).not.toContain("จัดวาง: ซ้าย → กลาง → ขวา");   // the cycle button is gone
  });
  it('per-word colour button is GONE, but legacy {c:} markers still render', () => {
    expect(pdfSrc).not.toContain('window.__tboxSetColor');   // no colour popover in the bar
    expect(pdfSrc).toContain('c.editor.use(window.MDTColor)'); // decoration keeps old boxes readable
  });
  it('scales the box font with the PDF render scale (relative sizing)', () => {
    // native px (b.fontSize) × zoom, so text stays proportional to the page
    expect(pdfSrc).toContain('tboxNativeFont');
    expect(pdfSrc).toMatch(/el\.style\.fontSize = \(tboxNativeFont\(b, scale\) \* \(scale \|\| 1\)\)/);
    // scale must be threaded from render → drawPageTextboxes → makeTboxEl
    expect(pdfSrc).toMatch(/function drawPageTextboxes\(pageNum, layer, cssW, cssH, scale\)/);
    expect(pdfSrc).toMatch(/function makeTboxEl\(b, cssW, cssH, scale\)/);
  });
  it('gives a NEW box a readable default (~15px on screen at the creation zoom)', () => {
    expect(pdfSrc).toContain('TBOX_DEFAULT_PX');
    // stored native size anchored to the wrap's real zoom; last-used size wins when present
    expect(pdfSrc).toMatch(/fontSize: Math\.round\(\(last\.px \|\| TBOX_DEFAULT_PX\) \/ \(sc \|\| 1\)\)/);
    // the post-create redraw must also pass that scale (else the box flashes tiny)
    expect(pdfSrc).toMatch(/drawPageTextboxes\(page, layer, wrap\.clientWidth, wrap\.clientHeight, sc\)/);
    // legacy boxes (no fontSize) fall back to the same readable on-screen default
    expect(pdfSrc).toMatch(/b\.fontSize \|\| \(TBOX_DEFAULT_PX \/ \(scale \|\| 1\)\)/);
  });
  it('EVERY drawPageTextboxes caller passes a scale (else font renders at native/huge size)', () => {
    // the redraw paths lost their scale arg → boxes re-rendered at native px (abnormally large)
    expect(pdfSrc).toContain('wrap.dataset.scale = String(scale)');   // render stamps the scale
    expect(pdfSrc).toContain('function _wrapScale(wrap)');
    expect(pdfSrc).toMatch(/redrawPage[\s\S]*?drawPageTextboxes\([^)]*_wrapScale\(wrap\)\)/);
    expect(pdfSrc).toMatch(/redrawCurrentPages[\s\S]*?drawPageTextboxes\([^)]*_wrapScale\(wrap\)\)/);
  });
  it('a click that finishes an edit does NOT also spawn a new box', () => {
    // _onDocDown (capture on document) nulls _pdfTboxEditing before pdfTextMousedown runs, so a
    // flag carries the "we just finished editing" signal across that same mousedown.
    expect(pdfSrc).toContain('_pdfSuppressCreate');
    expect(pdfSrc).toMatch(/if \(_pdfTboxEditing \|\| _pdfSuppressCreate\) return;/);
    expect(pdfSrc).toMatch(/_pdfSuppressCreate = true;[\s\S]{0,80}endEdit\(\)/);
  });
  it('floats the toolbar OUTSIDE the writing area (flip-below fallback)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/\.pdf-tbox-tbar\s*\{[^}]*position:\s*absolute/);
    expect(css).toContain('.pdf-tbox-tbar.tbar-below');
    expect(pdfSrc).toContain("classList.toggle('tbar-below'");
  });
  it('editor + preview share the note font (var(--font)) at inherited size', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror \{[^}]*font-family:\s*var\(--font\)/);
    expect(css).toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror \{[^}]*font-size:\s*inherit/);
  });
  it('re-anchors crepe hard-coded px so EDIT size == PREVIEW size (typing vs unfocus)', () => {
    // crepe's theme sets .milkdown .ProseMirror p{16px}, h1{42px}… which ignored the box's
    // scaled font — text changed size when focused. We override p/li/blockquote/h4-6 to 1em.
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    const m = css.match(/\.pdf-tbox-content \.milkdown \.ProseMirror p,[\s\S]*?\{\s*font-size:\s*1em;\s*line-height:\s*1\.35;\s*\}/);
    expect(m).toBeTruthy();
    const block = m[0];
    ['ProseMirror p', 'ProseMirror li', 'ProseMirror blockquote', 'ProseMirror h4', 'ProseMirror h5', 'ProseMirror h6']
      .forEach((sel) => expect(block).toContain(sel));
  });
  it('matches line-height + min-height edit↔preview so text does NOT shift on finish typing', () => {
    // crepe's p line-height (~1.6) and the ProseMirror min-height (20px) differed from the
    // preview (1.35 / 16px) → text jumped when the editor closed. Both re-anchored.
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    // line-height re-anchored on the block-element parity rule
    expect(css).toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror p,[\s\S]*?line-height:\s*1\.35;\s*\}/);
    // and the editor root min-height matches the preview container (16px), not 20px
    expect(css).toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror \{[^}]*min-height:\s*16px/);
    expect(css).not.toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror \{[^}]*min-height:\s*20px/);
  });
});

// The bundle-side foundation (build/crepe-entry.js → renderer/vendor/crepe.bundle.js)
const entrySrc2 = fs.readFileSync(path.join(__dirname, '../../build/crepe-entry.js'), 'utf8');
describe('crepe entry exposes the editing primitives the toolbar needs', () => {
  it('exposes window.MDEdit with getView + ProseMirror commands/list', () => {
    expect(entrySrc2).toContain('window.MDEdit');
    expect(entrySrc2).toContain('editorViewCtx');
  });
  it('exposes the tcolor plugin + setter and the linkPaste plugin', () => {
    expect(entrySrc2).toContain('window.MDTColor');
    expect(entrySrc2).toContain('window.__tboxSetColor');
    expect(entrySrc2).toContain('window.MDLinkPaste');
  });
});

// ---- Sticky-note redesign (2026-08-18): themes, select-then-edit, per-box size ----
describe('sticky-note redesign', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');

  it('ONE theme choice sets bg + ink + border (6 themes + hidden legacy white)', () => {
    expect(pdfSrc).toMatch(/TBOX_THEMES = \['yellow', 'pink', 'blue', 'green', 'purple', 'clear'\]/);
    ['yellow', 'pink', 'blue', 'green', 'purple', 'clear', 'white'].forEach((n) =>
      expect(css).toContain('.pdf-tbox.tbox-theme-' + n));
    // themes must win over the dark-mode paper override (equal specificity, later order)
    expect(css).toContain(':root .pdf-tbox.tbox-theme-yellow');
  });

  it('legacy b.bg maps to the nearest theme; unset stays white (old boxes unchanged)', () => {
    expect(pdfSrc).toContain("'#fff7c0': 'yellow'");
    expect(pdfSrc).toContain("'transparent': 'clear'");
    expect(pdfSrc).toMatch(/return 'white';/);
  });

  it('click selects, double-click edits, Esc/outside deselects', () => {
    expect(pdfSrc).toContain('function select()');
    expect(pdfSrc).toContain("content.addEventListener('dblclick'");
    expect(pdfSrc).toMatch(/_onEscSel/);
    // the selecting press also drags the WHOLE box once past the threshold
    expect(pdfSrc).toContain('beginDrag(ev, 4)');
  });

  it('per-box font size stepper, clamped, remembered for the next box', () => {
    expect(pdfSrc).toContain('const _setSize');
    expect(pdfSrc).toMatch(/Math\.max\(6, Math\.min\(60,/);
    expect(pdfSrc).toContain('_tboxRemember({ px:');
    expect(pdfSrc).toContain('_tboxRemember({ theme: name })');
  });

  it('the old scattered surfaces are gone: hover bg-palette, floating del, colour popover', () => {
    expect(pdfSrc).not.toContain('pdf-tbox-palette');
    expect(pdfSrc).not.toContain('pdf-tbox-del');
    expect(pdfSrc).not.toContain('pdf-tbar-cpop');
    expect(css).not.toContain('pdf-tbox-palette');
  });

  it('writing tools are edit-only in the ONE unified bar', () => {
    expect(pdfSrc).toMatch(/_mark\('strong'\), 'edit-only'/);
    expect(css).toContain('.pdf-tbox-tbar .edit-only { display: none; }');
    expect(css).toContain('.pdf-tbox-tbar.is-editing .pdf-tbar-btn.edit-only');
  });
});
describe('head strip removed — the box has no thick top edge', () => {
  it('no pdf-tbox-head element or CSS remains; the grip button is the in-bar drag handle', () => {
    expect(pdfSrc).not.toContain('pdf-tbox-head');
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).not.toContain('pdf-tbox-head');
    expect(pdfSrc).toContain("grip.className = 'pdf-tbar-btn grip'");
    expect(pdfSrc).toMatch(/grip\.addEventListener\('mousedown'[\s\S]{0,120}beginDrag\(ev, 0\)/);
  });
});

// typing == final display: same plugin set as the note editor + live mermaid in the preview
describe('sticky box WYSIWYG parity', () => {
  it('the box editor registers wikilink + callout + mermaid (raw markers no longer show while typing)', () => {
    ['MDWikiLink', 'MDCalloutColor', 'MDMermaid'].forEach((pl) =>
      expect(pdfSrc).toContain('c.editor.use(window.' + pl + ')'));
  });
  it('the preview upgrades mermaid placeholders to live diagrams', () => {
    expect(pdfSrc).toContain("querySelectorAll('pre.md-mermaid-src[data-mmd]')");
    expect(pdfSrc).toMatch(/renderMermaidInto\(d, el2\.dataset\.mmd/);
  });
});

// Locked by the LIVE block-diff harness (2026-08-18): preview and editor rendered the same
// fixture and every block matched on tag/font/line-height/margins/padding/border. These pin the
// CSS that closed the last gaps (lists indented 0 in the editor; blockquote 15px/40px vs 2px/0).
describe('sticky box parity CSS (from the live diff harness)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('editor lists share the preview indent (18px) and margins', () => {
    expect(css).toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror ul,\n\.pdf-tbox-content \.milkdown \.ProseMirror ol \{ padding-left: 18px; margin: 2px 0; \}/);
  });
  it('blockquote has ONE canonical look in both modes (2px margins, 10px pad, 3px rule)', () => {
    expect(css).toMatch(/\.pdf-tbox-content blockquote,\n\.pdf-tbox-content \.milkdown \.ProseMirror blockquote \{\n  margin: 2px 0; padding: 2px 0 2px 10px; border-left: 3px solid var\(--line-strong\);/);
  });
});

// Round 2 of the parity harness — this time measuring GLYPH POSITIONS (x,y of the actual text)
// instead of container geometry, which is what caught the two bugs the first pass missed:
//  1. crepe li = flex + 24px "1." label + 10px gap  ->  "1.        asdf"
//  2. crepe pads every block 4px top+bottom          ->  taller line rhythm while typing
describe('sticky box parity round 2 (glyph-position harness findings)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('crepe list items are flattened to native list-items (label hidden, browser marker)', () => {
    expect(css).toContain('.pdf-tbox-content .milkdown .ProseMirror li.list-item { display: list-item; }');
    expect(css).toContain('.pdf-tbox-content .milkdown .ProseMirror li.list-item > .label-wrapper { display: none; }');
    expect(css).toContain('.pdf-tbox-content .milkdown .ProseMirror li p { margin: 0; }');
  });
  it('crepe block padding is zeroed so the vertical rhythm equals the preview', () => {
    expect(css).toMatch(/\.pdf-tbox-content \.milkdown \.ProseMirror ul, \.pdf-tbox-content \.milkdown \.ProseMirror ol \{ padding-top: 0; padding-bottom: 0; \}/);
  });
});

// 2026-08-18: sticky-box text alignment — user request: pick the HORIZONTAL alignment per box,
// and the text is ALWAYS vertically centred (same in preview and while editing).
describe('sticky box alignment', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');

  it('toolbar has ONE cycling align button (left→center→right) that persists the choice', () => {
    // a single button keeps the bar compact (user request 2026-08-18) — not three buttons
    expect(pdfSrc).toMatch(/ALIGN_ORDER = \['left', 'center', 'right'\]/);
    expect(pdfSrc).toMatch(/b\.align = ALIGN_ORDER\[\(ALIGN_ORDER\.indexOf\(_curAlign\(\)\) \+ 1\) % ALIGN_ORDER\.length\]/);
    expect(pdfSrc).toContain("_tboxRemember({ align: b.align })");   // remembered for the NEXT box
    // the button's icon always shows the CURRENT mode
    expect(pdfSrc).toContain('alignBtn.innerHTML = ALIGN_ICON[cur]');
  });

  it('alignment is applied to the SHARED content element, so preview and editor match', () => {
    // _applyAlign styles .pdf-tbox-content (the same element that hosts Milkdown while editing)
    expect(pdfSrc).toMatch(/content\.style\.textAlign = \(b\.align === 'center' \|\| b\.align === 'right'\) \? b\.align : 'left'/);
    // re-applied after every preview render (innerHTML wipe keeps the inline style, but the
    // call guards the order explicitly)
    expect(pdfSrc).toMatch(/_applyAlign\(\);\n  };\n  _applyAlign\(\);\n  renderPreview\(\);/);
  });

  it('a NEW box inherits the last-used alignment (like theme and font size)', () => {
    expect(pdfSrc).toMatch(/align: \(last\.align === 'center' \|\| last\.align === 'right'\) \? last\.align : 'left'/);
  });

  it('text is vertically centred via auto margins (NOT flex-centering the content children)', () => {
    // margin auto + flex 0 centres the block; a display:flex content would UNCOLLAPSE the
    // 2px block margins (4px gaps) and break the glyph parity locked above
    expect(css).toMatch(/\.pdf-tbox-content \{[^}]*flex: 0 1 auto; margin-top: auto; margin-bottom: auto;/);
    expect(css).not.toMatch(/\.pdf-tbox-content \{[^}]*display: flex/);
  });
});

// SHOJI radii (2026-08-20, user-approved "Option C"): frame = wood (controls, sharp 3px),
// paper = surfaces (soft 9px). The kumiko identity lives in the sharp frame.
describe('shoji radius system', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('tokens exist in both themes; hinoki line tone on the main dividers', () => {
    expect(css).toContain('--r-frame: 3px');
    expect(css).toContain('--r-paper: 9px');
    expect(css).toContain('--line-wood: #b3987a');
    expect(css).toContain('--line-wood: #6a5a47');   // dark
    expect(css).toContain('border-right: 1px solid var(--line-wood)');   // sidebar edge
    expect(css).toContain('#divider { background: var(--line-wood)');
  });
  it('controls are FRAME: buttons, inputs, chips/pills — no capsule pills left on controls', () => {
    expect(css).toMatch(/button\.ghost, button\.solid, button\.danger \{[^}]*var\(--r-frame\)/);
    expect(css).toMatch(/\.modal-card input \{[^}]*var\(--r-frame\)/);
    expect(css).toMatch(/\.status-chip \{[^}]*var\(--r-frame\)/);
    expect(css).toMatch(/\.sg-btn \{[^}]*var\(--r-frame\)/);          // was 999px capsule
    expect(css).toMatch(/\.nn-badge \{[^}]*var\(--r-frame\)/);        // was 999px capsule
  });
  it('surfaces are PAPER: cards, menus, popovers, sticky boxes, chat bubbles (with frame tails)', () => {
    expect(css).toMatch(/\.modal-card \{[^}]*var\(--r-paper\)/);
    expect(css).toMatch(/\.dash-card \{[^}]*var\(--r-paper\)/);
    expect(css).toMatch(/\.nn-pop \{[^}]*var\(--r-paper\)/);
    expect(css).toMatch(/\.pdf-tbox \{[^}]*var\(--r-paper\)/);
    expect(css).toMatch(/\.m \{[^}]*var\(--r-paper\)/);
    expect(css).toContain('border-bottom-left-radius: var(--r-frame)');   // ai bubble tail
    expect(css).toContain('border-bottom-right-radius: var(--r-frame)');  // user bubble tail
  });
  it('true dots stay round', () => {
    expect(css).toMatch(/\.review-dot \{[^}]*border-radius: 50%/);
    expect(css).toMatch(/\.tb-theme \{[^}]*border-radius: 50%/);
  });
});

describe('top-bar system (equal heights + narrow collapse)', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('declares shared row tokens and applies row 1 to all three columns', () => {
    expect(css).toMatch(/--bar-h: 46px; --bar2-h: 40px; --bar-ctl: 28px/);
    expect(css).toMatch(/\.sb-head \{ box-sizing: border-box; height: var\(--bar-h\)/);
    expect(css).toMatch(/#left > \.bar, #right > \.bar \{ box-sizing: border-box; height: var\(--bar-h\)/);
    expect(css).toMatch(/#sessionTabs \{ box-sizing: border-box; height: var\(--bar-h\)/);
  });
  it('applies row 2 to search / pdf toolbar / session head', () => {
    expect(css).toMatch(/\.search-row \{ box-sizing: border-box; height: var\(--bar2-h\)/);
    expect(css).toMatch(/\.pdf-toolbar \{ box-sizing: border-box; height: var\(--bar2-h\)/);
    expect(css).toMatch(/\.session-head \{ box-sizing: border-box; height: var\(--bar2-h\)/);
  });
  it('collapses in steps via container queries and never hides the panel toggles', () => {
    expect(css).toMatch(/#left, #right, #sidebar \{ container-type: inline-size; \}/);
    expect(css).toMatch(/@container \(max-width: 600px\) \{\s*#left > \.bar \.saved-txt \{ display: none; \}/);
    expect(css).toMatch(/@container \(max-width: 420px\) \{[\s\S]{0,300}#saveBtn, #left > \.bar #aiMenuBtn[^}]*\{ display: none; \}/);
    expect(css).toMatch(/\.bar-more \{ display: grid !important; \}/);
    expect(require('fs').readFileSync(require('path').join(__dirname, '../../renderer/renderer.js'), 'utf8')).toMatch(/openBarMenu\(moreBtn, \[\['i-save'/);
    expect(css).not.toMatch(/#sidebarToggle \{ display: none|#aiPanelToggle \{ display: none/);
    // title yields, icons don't
    expect(css).toMatch(/#left > \.bar \.bar-left \{ flex: 1 1 0; min-width: 44px; overflow: hidden; \}/);
    expect(css).toMatch(/#left > \.bar \.bar-right \{ flex: 0 0 auto/);
  });
});

describe('shoji rails (chat divider + sidebar rail)', () => {
  const fs = require('fs'), path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  it('divider is a 1px seam with an 8px invisible hit area and accent glow on hover/drag', () => {
    expect(css).toMatch(/grid-template-columns: var\(--sidebar-w, 232px\) 1fr 1px var\(--term-w, 470px\)/);
    expect(css).toMatch(/#divider::before \{[^}]*left: -4px; right: -4px; cursor: col-resize/);
    expect(css).toMatch(/#divider:hover::after, #app\.resizing\.rs-chat #divider::after \{ opacity: 1; \}/);
  });
  it('sidebar rail exists, sits on the sidebar edge, hides when collapsed', () => {
    expect(html).toMatch(/<div id="sbRail"/);
    expect(css).toMatch(/#sbRail \{ position: absolute;[^}]*left: calc\(var\(--sidebar-w, 232px\) - 4px\); width: 8px/);
    expect(css).toMatch(/#app\.sidebar-collapsed #sbRail \{ display: none; \}/);
  });
  it('both rails: clamp, snap-collapse, double-click reset, per-vault persistence', () => {
    expect(js).toMatch(/RAIL = \{ side: \{ def: 232, min: 180, max: 400, snap: 140 \}, chat: \{ def: 470, min: 320, max: 760 \} \}/);
    expect(js).toMatch(/vsSet\('termW', w\)/);
    expect(js).toMatch(/vsSet\('sidebarW', w\)/);
    expect(js).toMatch(/ev\.clientX < RAIL\.side\.snap/);
    expect(js).toMatch(/dblclick/);
    // --sidebar-w must go on <html>, never inline on #app (would defeat .sidebar-collapsed)
    expect(js).toMatch(/document\.documentElement\.style\.setProperty\('--sidebar-w'/);
    expect(js).not.toMatch(/appEl\.style\.setProperty\('--sidebar-w'/);
  });
});

describe('header tone', () => {
  it('all top strips share --surface (editor bar / pdf toolbar no longer paper-white)', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/#left > \.bar, \.pdf-toolbar, \.view-head, \.sb-head, \.search-row, \.session-tabs, \.session-head \{ background: var\(--surface\); \}/);
  });
});

describe('settings hub — one window, gear opens Appearance', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('popover is gone; gear and theme doorway both open the hub at appearance', () => {
    expect(js).not.toMatch(/function openSettingsMenu/);
    expect(js).toMatch(/_sb\.onclick = \(e\) => \{ e\.preventDefault\(\); openAiSettings\('appearance'\); \}/);
    expect(js).toMatch(/function openThemeStudio\(\)\{ openAiSettings\('appearance'\); \}/);
  });
  it('hub has an appearance panel first with language + theme studio rendered into it', () => {
    expect(js).toMatch(/async function openAiSettings\(tab\)/);
    expect(js).toMatch(/const panelAppearance=_panel\('appearance'\);/);
    expect(js).toMatch(/_navItem\('appearance','crate',t\('การแสดงผล'\)\)/);
    expect(js).toMatch(/buildThemeStudio\(host\)/);
    expect(js).toMatch(/function buildThemeStudio\(body\)/);
    expect(js).toMatch(/seg\(\[\['th','ไทย'\],\['en','English'\]\], uiLang/);
    expect(js).toMatch(/_showPanel\(_panels\[tab\] \? tab : 'appearance'\)/);
    expect(css).toMatch(/#aiSettingsModal \{ width: 780px; max-width: 95vw; \}/);
  });
});

describe('settings hub footer is section-scoped', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('test connection only on provider; save/cancel only on AI+collab; close elsewhere', () => {
    expect(js).toMatch(/FOOT_SAVE=new Set\(\['provider','rag','prompts','collab'\]\)/);
    expect(js).toMatch(/_foot\.classList\.toggle\('foot-provider', key==='provider'\)/);
    expect(css).toMatch(/\.ai-settings-foot \.foot-test, \.ai-settings-foot \.foot-cfg \{ display: none; \}/);
    expect(css).toMatch(/\.ai-settings-foot\.foot-provider \.foot-test \{ display: inline-flex; \}/);
    expect(css).toMatch(/\.ai-settings-foot\.foot-save \.foot-close \{ display: none; \}/);
  });
});

describe('block handle stability (log 2026-08-26)', () => {
  it('no app-side transform on the handle; featureConfigs are merged, not overwritten', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).not.toMatch(/\.milkdown-block-handle \{ gap: 0; transform: translateX/);
    const js = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(js).toMatch(/Object\.assign\(\{\}, _crepeCfg\.featureConfigs, \{ \[window\.Crepe\.Feature\.CodeMirror\]/);
  });
});

describe('block handle: legacy centering hack is gone (nested-indent misplacement)', () => {
  it('installBlockHandleCentering removed — crepe owns handle position; no app-side transform writes', () => {
    const js = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(js).not.toMatch(/function installBlockHandleCentering/);
    expect(js).not.toMatch(/translateX\(' \+ XSHIFT/);
  });
});

describe('block handle: centred on single-line rows + glide animation', () => {
  const fs = require('fs'), path = require('path');
  it('BlockEdit featureConfig overrides getPlacement (left = centred ≤60px, left-start on tall blocks); top/left transition restored', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(js).toMatch(/featureConfigs: \{ 'block-edit': \{ blockHandle: \{/);
    expect(js).toMatch(/r\.height <= 60 \? 'left' : 'left-start'/);
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/transition: top \.16s cubic-bezier\(\.3,\.9,\.4,1\), left \.16s cubic-bezier\(\.3,\.9,\.4,1\), opacity \.12s ease/);
  });
});
