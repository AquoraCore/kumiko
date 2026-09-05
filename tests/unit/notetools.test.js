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
});
