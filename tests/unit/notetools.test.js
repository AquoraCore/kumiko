import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

// 2026-09-05 batch (user picked 1/2/3/7/8): note-image assets, send-bubble-to-note,
// resend-failed, version history, collapsible slide images.
describe('note version history (7)', () => {
  const main = read('main.js');
  it('snapshots the outgoing version inside note:save, rate-limited, capped, PDF-Text exempt', () => {
    expect(main).toContain('const SNAP_GAP = 10 * 60 * 1000, SNAP_KEEP = 20');
    expect(main).toMatch(/maybeSnapshotNote\(payload\.name\);\s+\/\/ keep the outgoing version/);
    expect(main).toMatch(/maybeSnapshotNote[\s\S]{0,200}startsWith\('PDF-Text\/'\)\) return/);
    expect(main).toContain("ipcMain.handle('history:list'");
    expect(main).toContain("ipcMain.handle('history:snap'");
    // history:read validates ts shape (no path smuggling via the filename)
    expect(main).toMatch(/history:read[\s\S]{0,200}\/\^\\d\+\$\/\.test\(String\(ts\)\)/);
  });
  it('renderer: menu entry + restore snapshots the CURRENT state first', () => {
    const r = read('renderer/renderer.js');
    expect(r).toContain("t('ประวัติเวอร์ชัน'), () => openHistoryModal(rel)");
    expect(r).toMatch(/historySnap\(rel\);\s+\/\/ current state becomes a snapshot before the swap/);
  });
});

describe('note image assets (1)', () => {
  const main = read('main.js');
  const r = read('renderer/renderer.js');
  it('asset:save sanitizes names, asset:read only serves assets/ rels', () => {
    expect(main).toMatch(/asset:save[\s\S]{0,600}#\(\)\\\[\\\]\]\/g/);   // parens+brackets+spaces sanitized — ](…) breaks on ")" 
    expect(main).toMatch(/asset:read[\s\S]{0,200}startsWith\('assets\/'\)\) return null/);
  });
  it('src fixup covers the DIFF REVIEW too (assets imgs resolved against the app bundle broke there)', () => {
    expect(r).toMatch(/_fixupEditorImgs[\s\S]{0,400}getElementById\('editorWrap'\)/);
    // review hunks resolve assets INLINE (no doomed relative fetch before the observer runs)
    expect(r).toContain('function mdToHtmlAssets');
    expect((r.match(/mdToHtmlAssets\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });
  it('DOM-only src fixup (markdown keeps portable rels) + web/desktop resolver split', () => {
    expect(r).toContain('function resolveAssetSrc');
    expect(r).toMatch(/KUMIKO_WEB\) return \(window\.api\.assetUrl/);
    expect(r).toMatch(/'file:\/\/' \+ encodeURI\(window\.__vaultBase/);
    // serialization safety: PM writes markdown from node attrs, so only im.src is touched
    expect(r).toContain('im.dataset.kzRel = src; im.src = resolveAssetSrc(src)');
  });
  it('PDF clips write assets with a data-URI fallback; READ-NOTE attaches asset images to vision', () => {
    expect(read('renderer/pdf.js')).toMatch(/saveAsset && await window\.api\.saveAsset[\s\S]{0,120}if \(r2 && r2\.rel\) ref = r2\.rel/);
    expect(r).toMatch(/assetRels\.push\(rel2\)/);
    expect(r).toMatch(/readAsset && await window\.api\.readAsset\(ar\)/);
    expect(read('renderer/attach.js')).toMatch(/assets\\\/\[\^\)\\s\]\+/);
  });
  it('asset:prune removes only UNREFERENCED files (walks every .md for ](assets/…) refs)', () => {
    const m2 = read('main.js');
    expect(m2).toContain("ipcMain.handle('asset:prune'");
    expect(m2).toMatch(/referenced\.has\(f\)\) \{ try \{ fs\.unlinkSync/);
    expect(m2).toMatch(/asset:prune[\s\S]{0,900}endsWith\('\.md'\)/);
  });
  it('migration: per-note history snapshot BEFORE the rewrite; assets/ hidden from the tree', () => {
    expect(r).toMatch(/migrateImagesToAssets[\s\S]{0,1600}historySnap\(rel\); \} catch \(_\) \{\}\n      await window\.api\.saveNote\(rel, out\)/);
    expect(read('renderer/sidebar.js')).toContain("!n.startsWith('assets/')");
  });
});

describe('chat bubble actions (2 + 3)', () => {
  const chat = read('renderer/chat.js');
  it('ส่งเข้าโน้ต appends through the SAME review gate (current note or pending+flag)', () => {
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/sendBubbleToNote[\s\S]{0,700}applyReplyToNote\(merged, \{ silent: true, baseRaw: raw \}\)/);
    expect(r).toMatch(/sendBubbleToNote[\s\S]{0,900}__pendingReviews\.set\(rel, merged\)/);
    expect(chat).toContain('openNotePicker(nb, (rel) => sendBubbleToNote(m, rel))');
    // only real answers get the button — failures/stops get resend instead
    expect(chat).toMatch(/if \(!failed && \(m\.text \|\| ''\)\.trim\(\)/);
  });
  it('ส่งใหม่ shows on failed/stopped bubbles and re-sends the SAME user text (pair removed)', () => {
    expect(chat).toMatch(/if \(failed \|\| m\.stopped\)/);
    expect(chat).toMatch(/function resendFrom[\s\S]{0,400}s\.messages\.splice\(ui\)/);
    expect(chat).toMatch(/resendFrom[\s\S]{0,600}sendChat\(\)/);
  });
  it('stopped/think flags now survive persistence (marker no longer vanishes on reload)', () => {
    expect(chat).toContain('stopped: m.stopped || undefined');
  });
});

describe('collapsible slide images (8)', () => {
  it('big images (natural > 360px) collapse; click toggles; CSS is token-based', () => {
    const r = read('renderer/renderer.js');
    expect(r).toContain('im.naturalHeight > 360');
    expect(r).toMatch(/classList\.contains\('kz-clip'\)\) im\.classList\.toggle\('kz-open'\)/);
    const css = read('renderer/styles.css');
    expect(css).toMatch(/\.milkdown img\.kz-clip \{[^}]*height: 96px !important[^}]*zoom-in/);
    expect(css).toMatch(/\.milkdown img\.kz-clip\.kz-open \{[^}]*height: auto !important/);
  });
  it('kz-clip also wins inside crepe milkdown-image-block (min-height:100px would beat height)', () => {
    // regression: crepe upgrades own-paragraph images to <milkdown-image-block> whose img has
    // min-height:100px + fit-content wrapper + inline height from the resize handle — the clip
    // rules must override all three or slide clips render full-size and wreck the note layout
    const css = read('renderer/styles.css');
    expect(css).toMatch(/\.milkdown \.milkdown-image-block > \.image-wrapper img\.kz-clip \{[^}]*min-height: 0 !important/);
    expect(css).toMatch(/\.milkdown \.milkdown-image-block > \.image-wrapper:has\(img\.kz-clip\) \{[^}]*width: 100%/);
    expect(css).toMatch(/\.milkdown \.milkdown-image-block > \.image-wrapper img\.kz-clip\.kz-open \{[^}]*height: auto !important/);
    expect(css).toMatch(/:not\(:has\(img\.kz-open\)\) > \.image-resize-handle \{ display: none/);
    // crepe's inline node view (img.image-inline) sizes to intrinsic aspect — force full-width strip
    expect(css).toMatch(/\.milkdown img\.image-inline\.kz-clip \{ width: 100% !important; max-width: 560px !important/);
    expect(css).toMatch(/\.milkdown img\.image-inline\.kz-clip\.kz-open \{ width: auto !important/);
    // inline-flex span wrapper shrink-wraps, making img width:100% circular → widen the wrapper
    expect(css).toMatch(/\.milkdown \.milkdown-image-inline:has\(> img\.kz-clip\) \{ width: 100%; max-width: 560px/);
    expect(css).toMatch(/\.milkdown \.milkdown-image-inline:has\(> img\.kz-open\) \{ width: auto/);
  });
});

// 2026-09-05: opening from SEARCH now reveals the item in the sidebar — ancestors expanded,
// row scrolled to centre, brief pulse. Notes AND pdf search hits.
describe('search reveals the opened item in the sidebar', () => {
  const sb = read('renderer/sidebar.js');
  const r = read('renderer/renderer.js');
  it('revealInSidebar expands every collapsed ancestor then scrolls + pulses', () => {
    expect(sb).toContain('function revealInSidebar');
    expect(sb).toMatch(/collapsedFolders\.delete\(p\); changed = true/);
    expect(sb).toMatch(/if \(changed\) \{ persistCollapsed\(\); renderTree\(\); \}/);
    expect(sb).toContain("scrollIntoView({ block: 'center', behavior: 'smooth' })");
    expect(sb).toMatch(/CSS\.escape/);   // rels can contain quotes/anything
  });
  it('both search-hit kinds route through it', () => {
    expect(r).toMatch(/openNote\(hit\.name\);\s+if \(typeof revealInSidebar === 'function'\) revealInSidebar\(hit\.name, 'note'\)/);
    expect(r).toMatch(/revealInSidebar\(rel, 'pdf'\)/);
    expect(read('renderer/styles.css')).toMatch(/reveal-pulse/);
  });
});

// 2026-09-05: chat [source:]/@ refs from the model are messy — "Name หน้า 17", several names
// in one bracket. The exact-match click resolver silently did nothing; resolveRefTarget now
// picks the first resolvable segment, extracts the page, and misses produce a toast.
describe('chat ref click resolution', () => {
  const CM = require('../../core/markdown.js');
  const notes = { 'b ar cr': 'N/B AR CR.md' };
  const pdfs = { 'org chaert context': 'P/Org Chaert Context.pdf' };
  it('happy: page suffix → pdf target with page; bare name → note first', () => {
    expect(CM.resolveRefTarget('Org Chaert Context หน้า 17', notes, pdfs, null)).toEqual({ kind: 'pdf', rel: 'P/Org Chaert Context.pdf', page: 17 });
    expect(CM.resolveRefTarget('B AR CR', notes, pdfs, null)).toEqual({ kind: 'note', rel: 'N/B AR CR.md' });
  });
  it('edge: composite lists fall through to the first RESOLVABLE segment; ranges take the first page', () => {
    expect(CM.resolveRefTarget('ไม่มีจริง, Org Chaert Context หน้า 14–17', notes, pdfs, null)).toEqual({ kind: 'pdf', rel: 'P/Org Chaert Context.pdf', page: 14 });
  });
  it('edge: a PDF beats its own PDF-Text shadow note (raw extract is never the destination)', () => {
    const shadow = { 'org chaert context': 'PDF-Text/Org Chaert Context.md' };
    expect(CM.resolveRefTarget('Org Chaert Context หน้า 17', shadow, pdfs, null)).toEqual({ kind: 'pdf', rel: 'P/Org Chaert Context.pdf', page: 17 });
    // ...but with no pdf candidate, the shadow is still better than nothing
    expect(CM.resolveRefTarget('Org Chaert Context', shadow, {}, null)).toEqual({ kind: 'note', rel: 'PDF-Text/Org Chaert Context.md' });
  });
  it('edge: unresolvable/empty → null (UI toasts instead of silence)', () => {
    expect(CM.resolveRefTarget('ไม่มีจริง', notes, pdfs, null)).toBe(null);
    expect(CM.resolveRefTarget('', notes, pdfs, null)).toBe(null);
  });
  it('chat wiring: resolver + page nav + sidebar reveal + miss toast', () => {
    const chat2 = read('renderer/chat.js');
    expect(chat2).toContain('window.CoreMarkdown.resolveRefTarget(raw');
    expect(chat2).toMatch(/__wikiNav\(hit\.rel \+ '#p' \+ hit\.page\)/);
    expect(chat2).toContain("revealInSidebar(hit.rel, 'pdf')");
    expect(chat2).toContain('หาโน้ต/เอกสารของลิงก์นี้ไม่เจอ');
  });
});

// 2026-09-08: double-click any image / mermaid diagram → fullscreen lightbox with zoom + pan.
describe('fullscreen lightbox for images + diagrams', () => {
  const r = read('renderer/renderer.js');
  const css = read('renderer/styles.css');
  it('opens via hover ⛶ button or ⌘/Ctrl+click — NEVER plain/double click (click = edit)', () => {
    expect(r).toContain('function openLightbox');
    expect(r).toMatch(/\['editorWrap', 'chatMessages'\]\.forEach/);   // review images get ⛶ too
    expect(r).toContain("btn.id = 'kzZoomBtn'");
    expect(r).toMatch(/if \(!\(e\.metaKey \|\| e\.ctrlKey\)\) return;/);
    expect(r).not.toMatch(/addEventListener\('dblclick'[\s\S]{0,120}openLightbox/);
    expect(r).toMatch(/closest\('\.md-mermaid-render, \.milkdown \.mermaid, pre\.mermaid'\)/);
    expect(r).toContain("c.setAttribute('preserveAspectRatio', 'xMidYMid meet')");
    // crepe's add-caption bubble collided with the ⛶ button — permanently hidden
    expect(read('renderer/styles.css')).toMatch(/\.image-wrapper \.operation \{ display: none !important/);
  });
  it('two-finger scroll PANS, pinch/⌘-scroll ZOOMS (clamped 0.2–8), dblclick resets, Esc/✕/backdrop close', () => {
    expect(r).toMatch(/if \(e\.ctrlKey \|\| e\.metaKey\) \{\n      scale = Math\.min\(8, Math\.max\(0\.2, scale \* Math\.exp/);
    expect(r).toMatch(/tx -= e\.deltaX; ty -= e\.deltaY;/);
    expect(r).toMatch(/scale = 1; tx = 0; ty = 0; apply\(\)/);
    expect(r).toMatch(/e\.key === 'Escape'[\s\S]{0,60}close\(\)/);
    expect(r).toMatch(/if \(e\.target === ov\) close\(\)/);
    expect(css).toMatch(/#kzLightbox \{[^}]*z-index: 12000/);
  });
});
