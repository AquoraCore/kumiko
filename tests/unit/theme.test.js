import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const CT = require('../../core/theme.js');
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

// Custom theme engine (2026-08-20): ONE accent in → the whole family out; kumiko lattice
// patterns generated as data-URIs; presets; normalize() hardens stored objects.
describe('CoreTheme.deriveAccent', () => {
  it('HAPPY: the shipped accent derives to (nearly) the hand-picked family', () => {
    const d = CT.deriveAccent('#bd5540');
    // within a hair of #a2452f / #f7ebe6 / #c96442 — same lightness direction, same hue
    expect(d.accentStrong).toBe('#9f4736');
    expect(d.accentBg).toBe('#f6e7e4');
    expect(d.userBubble).toBe('#c2634f');
    // dark-ground variants brighten instead of darken
    expect(CT.hexToRgb(d.accentDark)[0]).toBeGreaterThan(CT.hexToRgb('#bd5540')[0]);
  });
  it('EDGE: invalid accent falls back to the default without throwing', () => {
    const d = CT.deriveAccent('not-a-color');
    expect(d.accent).toBe('#bd5540');
  });
  it('mix() is a plain linear blend with clamping', () => {
    expect(CT.mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(CT.mix('#ff0000', '#ff0000', 1)).toBe('#ff0000');
  });
});

describe('CoreTheme.patternUri', () => {
  it('HAPPY: every named pattern yields a css url(data:) with the colour and opacity', () => {
    for (const name of CT.PATTERNS.filter((p) => p !== 'none')) {
      const u = CT.patternUri(name, '#3f5c7d', 0.07);
      expect(u.startsWith('url("data:image/svg+xml,')).toBe(true);
      expect(decodeURIComponent(u)).toContain("stroke='#3f5c7d'");
      expect(decodeURIComponent(u)).toContain("stroke-opacity='0.07'");
    }
  });
  it('EDGE: unknown pattern or none → literal none; opacity clamped to [0,1]', () => {
    expect(CT.patternUri('none', '#000', 0.1)).toBe('none');
    expect(CT.patternUri('nope', '#000', 0.1)).toBe('none');
    expect(decodeURIComponent(CT.patternUri('shippou', '#000', 9))).toContain("stroke-opacity='1'");
  });
});

describe('CoreTheme.normalize + presets', () => {
  it('bad fields fall back per-field; good fields survive', () => {
    const n = CT.normalize({ accent: 'x', pattern: 'weird', intensity: 99, radius: 'soft', preset: 'nope' });
    expect(n).toEqual({ preset: 'kumiko', pattern: 'sakuragoshi', intensity: 'faint', radius: 'soft' });   // fallback = new default (2026-09-01)
    expect(CT.normalize({ pattern: 'kagome', intensity: 'mid', radius: 'shoji', preset: 'ai' }))
      .toEqual({ preset: 'ai', pattern: 'kagome', intensity: 'mid', radius: 'shoji' });
    // legacy migration: 'sumi' (dark-as-a-colour) → kumiko; numeric intensity → nearest step
    expect(CT.normalize({ preset: 'sumi', intensity: 0.05 }).preset).toBe('kumiko');
    expect(CT.normalize({ intensity: 0.13 }).intensity).toBe('strong');
    expect(CT.normalize({ intensity: 0 }).intensity).toBe('off');
    // colour comes from the preset only
    expect(CT.accentOf(CT.normalize({ preset: 'fuji' }))).toBe('#7a5c8f');
  });
  it('the palette = six hue presets, each complete; dark is a MODE, not a preset', () => {
    expect(Object.keys(CT.PRESETS)).toEqual(['kumiko', 'sakura', 'karashi', 'matcha', 'ai', 'fuji']);
    for (const k of Object.keys(CT.PRESETS)) {
      const p = CT.PRESETS[k];
      expect(CT.hexToRgb(p.accent)).toBeTruthy();
      expect(CT.PATTERNS).toContain(p.pattern);
      expect(p.palette && p.palette.bg).toBeTruthy();
      expect(p.en).toBeTruthy();   // one-language labels via t()
    }
    expect(CT.PRESETS.sumi).toBeUndefined();
    expect(CT.INTENSITY_ORDER).toEqual(['off', 'faint', 'mid', 'strong']);
  });
});

// wiring guards — theme studio + apply path + dashboard study widgets
describe('theme + dashboard wiring', () => {
  const renderer = read('renderer/renderer.js');
  const dash = read('renderer/dashboard.js');
  const pdf = read('renderer/pdf.js');
  const sidebar = read('renderer/sidebar.js');

  it('applyKumikoTheme sets accent family, radii, and the pattern var; re-applied on dark toggle', () => {
    expect(renderer).toContain('function applyKumikoTheme');
    for (const v of ['--accent', '--accent-strong', '--accent-bg', '--user-bubble', '--r-frame', '--r-paper', '--wa-shippo']) {
      expect(read('core/theme.js')).toContain("o['" + v + "']");
    }
    expect(renderer).toMatch(/function applyTheme\(t\) \{\n  document\.documentElement\.setAttribute\('data-theme', resolveMode\(t\)\);\n  try \{ applyKumikoTheme\(\); \}/);
    // mode axis: light / dark / system
    expect(renderer).toContain('function resolveMode');
    expect(renderer).toMatch(/\[\['light', t\('☀ สว่าง'\)\], \['dark', t\('墨 มืด'\)\], \['system', t\('ตามระบบ'\)\]\]/);
  });
  it('vault override beats the global theme; both stores written by saveKumikoTheme', () => {
    expect(renderer).toMatch(/vsGet\('vaultTheme', null\)[\s\S]{0,200}localStorage\.getItem\('kumikoTheme'\)/);
    expect(renderer).toContain("localStorage.setItem('kumikoTheme', JSON.stringify(th))");
  });
  it('Theme Studio opens from the settings menu with presets/accent/pattern/intensity/radius/per-vault', () => {
    expect(renderer).toContain('function openThemeStudio');
    expect(renderer).toContain("t('การแสดงผล')");   // studio now lives in the Settings hub's Appearance panel
    expect(renderer).toContain("t('ใช้ธีมนี้กับ vault นี้เท่านั้น')");
    expect(renderer).toMatch(/\[\['shoji', t\('โชจิ \(คม\)'\)\], \['soft', t\('นุ่ม \(แบบเดิม\)'\)\]\]/);
  });
  it('core/theme.js is loaded by BOTH shells', () => {
    expect(read('renderer/index.html')).toContain('core/theme.js');
    expect(read('web/index.html')).toContain('core/theme.js');
  });
  it('dashboard: four study widgets + add-menu section + start-on-launch checkbox', () => {
    expect(dash).toContain('function buildStudyCard');
    expect(dash).toMatch(/STUDY_KINDS = \{ reviews:/);
    expect(dash).toContain("w.study ? buildStudyCard(w, i, widgets) : buildDashCard");
    expect(dash).toContain("study: k, span: k === 'captures' ? 2 : 1");
    expect(dash).toContain("vsSet('startDash', startCk.checked)");
    expect(renderer).toContain("if (vsGet('startDash', false) && typeof setMainView === 'function') setMainView('dash')");
  });
  it('study data hooks: capture log, recent PDFs, recent notes (open + review-accept + AI create)', () => {
    expect(pdf).toContain("vsSet('captureLog', log.slice(0, 50))");
    expect(pdf).toContain("vsSet('recentPdfs', rp.slice(0, 5))");
    expect(renderer).toContain('function touchRecentNote');
    expect(sidebar).toContain('touchRecentNote(name)');
    expect(renderer).toMatch(/await window\.api\.saveNote\(name, merged\);\n    try \{ touchRecentNote\(name\); \}/);
    expect(renderer).toMatch(/window\.__flaggedNotes\.add\(final \+ '\.md'\);\n      try \{ touchRecentNote\(final \+ '\.md'\); \}/);
  });
});

// 2026-08-20: paired grounds — every theme carries its own bg/side/hover family, not one
// shared cream. Presets are hand-tuned; a custom accent derives coherent tints.
describe('paired grounds per theme', () => {
  it('every preset has a full light palette (dark derives)', () => {
    for (const k of Object.keys(CT.PRESETS)) {
      const pal = CT.PRESETS[k].palette;
      expect(pal && CT.hexToRgb(pal.bg) && CT.hexToRgb(pal.side) && CT.hexToRgb(pal.hover)).toBeTruthy();
      // ordering: bg lightest, hover deepest (each a further step of the same tint)
      const l = (h) => CT.hexToRgb(h).reduce((a, b) => a + b, 0);
      expect(l(pal.bg)).toBeGreaterThan(l(pal.side));
      expect(l(pal.side)).toBeGreaterThan(l(pal.hover));
    }
    // kumiko's palette IS the shipped default — the default look must not change
    expect(CT.PRESETS.kumiko.palette).toEqual({ bg: '#faf9f6', side: '#f3efe7', hover: '#efece3' });
  });
  it('deriveAccent yields ground tints of the SAME hue for custom accents', () => {
    const d = CT.deriveAccent('#3f5c7d');
    const rgb = CT.hexToRgb(d.bg);
    expect(rgb[2]).toBeGreaterThan(rgb[0]);   // blue accent → blue-leaning ground
    const l = (h) => CT.hexToRgb(h).reduce((a, b) => a + b, 0);
    expect(l(d.bg)).toBeGreaterThan(l(d.side));
    expect(l(d.side)).toBeGreaterThan(l(d.hover));
  });
  it('renderer applies light grounds from the palette and DARK grounds from deriveDark (hue-tinted)', () => {
    const renderer = read('renderer/renderer.js');
    expect(read('core/theme.js')).toContain('var k = deriveDark(accent)');   // inside CoreTheme.tokens
    expect(read('core/theme.js')).toContain("o['--surface'] = sf.surface");
    expect(read('core/theme.js')).toContain("o['--chat-bg'] = pal.side");
    expect(read('core/theme.js')).toContain('var pal = preset.palette');
  });
});

// 2026-08-20 part 2 — "พื้น PDF / เส้นแบ่ง / สีไอคอนยังโทนเดิม": neutrals follow the theme hue.
describe('hue-following neutrals', () => {
  it('deriveNeutrals nudges every shipped base toward the accent hue', () => {
    const n = CT.deriveNeutrals('#3f5c7d');
    for (const k of ['desk', 'line', 'lineStrong', 'muted', 'wood']) expect(CT.hexToRgb(n[k])).toBeTruthy();
    // blue accent → warmth (red minus blue) SHRINKS vs the warm bases (hue moves toward accent)
    const warm = (h) => CT.hexToRgb(h)[0] - CT.hexToRgb(h)[2];
    expect(warm(n.line)).toBeLessThan(warm('#e6e3da'));
    expect(warm(n.muted)).toBeLessThan(warm('#6f6d64'));
    expect(warm(n.desk)).toBeLessThan(warm('#f3f1ea'));
  });
  it('kumiko preset pins the SHIPPED neutrals verbatim (default look never drifts)', () => {
    expect(CT.PRESETS.kumiko.neutrals).toEqual({ desk: '#efe5dc', line: '#e6e3da', lineStrong: '#d3d0c6', muted: '#6f6d64', wood: '#b3987a' });
  });
  it('renderer applies neutrals in light mode and clears them in dark', () => {
    const renderer = read('renderer/renderer.js');
    expect(read('core/theme.js')).toContain("o['--desk'] = neu.desk");
    expect(read('core/theme.js')).toContain("o['--muted'] = neu.muted");
    expect(read('core/theme.js')).toContain("o['--line-wood'] = neu.wood");
    // dark mode sets its own tinted neutrals instead of clearing
    expect(read('core/theme.js')).toContain("o['--muted'] = k.muted");
  });
});


// 2026-08-20 v2 — dark grounds follow the hue; intensity is four named steps; quick row in the gear menu
describe('theme v2: dark derivation + intensity steps + quick row', () => {
  it('deriveDark tints the shipped dark neutrals toward the accent', () => {
    const k = CT.deriveDark('#7d9471');
    for (const key of ['bg', 'surface', 'side', 'hover', 'desk', 'line', 'lineStrong', 'muted', 'wood']) expect(CT.hexToRgb(k[key])).toBeTruthy();
    // green accent → green channel leads red in the tinted dark bg
    const rgb = CT.hexToRgb(k.bg);
    expect(rgb[1]).toBeGreaterThanOrEqual(rgb[0]);
    // still dark
    expect(rgb.reduce((a, b) => a + b, 0)).toBeLessThan(120);
  });
  it('INTENSITY maps the four steps; DEFAULT is faint', () => {
    expect(CT.INTENSITY).toEqual({ off: 0, faint: 0.04, mid: 0.08, strong: 0.14 });
    expect(CT.DEFAULT.intensity).toBe('faint');
  });
  it('gear menu has the quick pattern row and the Studio has no free accent picker', () => {
    const renderer = read('renderer/renderer.js');
    expect(renderer).toContain('function patchKumikoTheme');
    expect(renderer).toMatch(/lab\(t\('ความเข้มลาย'\)\)/);
    const studio = renderer.slice(renderer.indexOf('function buildThemeStudio'), renderer.indexOf('function buildThemeStudio') + 6000);
    expect(studio).not.toContain('ts-swatches');
    expect(studio).not.toContain('ts-hex');
    expect(studio).not.toContain("type = 'range'");
    expect(studio).toContain("t(p.label)");   // one-language labels
  });
});

describe('deriveSurfaces — bars/paper/chat/seam follow the hue', () => {
  const CT = require('../../core/theme.js');
  it('light: surfaces are faint tints of the accent, paper stays near-white', () => {
    const s = CT.deriveSurfaces('#3f5c7d', false);
    expect(s.surface).not.toBe('#ffffff');
    expect(s.sheet).not.toBe('#ffffff');
    expect(s.seam).toMatch(/^rgba\(63,92,125,\.22\)$/);
    // paper lighter than bars, bars lighter than chat ground
    const lum = (h) => { const c = CT.hexToRgb(h); return c[0] + c[1] + c[2]; };
    expect(lum(s.sheet)).toBeGreaterThan(lum(s.surface));
    expect(lum(s.surface)).toBeGreaterThan(lum(s.chat));
    // a blue hue must bias the bars toward blue (b > r), a red hue toward red
    const b = CT.hexToRgb(s.surface); expect(b[2]).toBeGreaterThan(b[0]);
    const r = CT.hexToRgb(CT.deriveSurfaces('#bd5540', false).surface); expect(r[0]).toBeGreaterThan(r[2]);
  });
  it('dark: surfaces stay dark and keep the neutral seam', () => {
    const s = CT.deriveSurfaces('#7d9471', true);
    const c = CT.hexToRgb(s.sheet); expect(c[0] + c[1] + c[2]).toBeLessThan(140);
    expect(s.seam).toBe('rgba(0,0,0,.45)');
  });
  it('renderer applies surfaces in both modes (no pinned --surface)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(require('fs').readFileSync(require('path').join(__dirname, '../../core/theme.js'), 'utf8')).toMatch(/var sf = deriveSurfaces\(accent, dark\)/);
    const core = require('fs').readFileSync(require('path').join(__dirname, '../../core/theme.js'), 'utf8');
    expect(core).toContain("o['--surface'] = sf.surface"); expect(core).toContain("o['--sheet'] = sf.sheet"); expect(core).toContain("o['--cut-seam'] = sf.seam");
    expect(src).not.toMatch(/removeProperty\('--surface'\)/);
  });
});

describe('chat bubbles A+B — paper slips + fainter lattice', () => {
  const CT = require('../../core/theme.js');
  const fs = require('fs'), path = require('path');
  it('chatIntensity steps down one level and never below off', () => {
    expect(CT.chatIntensity('strong')).toBe('mid');
    expect(CT.chatIntensity('mid')).toBe('faint');
    expect(CT.chatIntensity('faint')).toBe('off');
    expect(CT.chatIntensity('off')).toBe('off');
  });
  it('deriveAccent exposes an opaque user slip + ink for both modes', () => {
    const d = CT.deriveAccent('#7a5c8f');
    expect(d.userSoft).toBe(CT.mix('#7a5c8f', '#ffffff', 0.80));
    const ink = CT.hexToRgb(d.userInk); expect(ink[0] + ink[1] + ink[2]).toBeLessThan(300);   // dark ink on a light slip
    const inkD = CT.hexToRgb(d.userInkDark); expect(inkD[0] + inkD[1] + inkD[2]).toBeGreaterThan(450);
  });
  it('renderer + css wire the tokens', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    const core = fs.readFileSync(path.join(__dirname, '../../core/theme.js'), 'utf8');
    expect(core).toMatch(/o\['--wa-shippo-chat'\] = patternUri\(th\.pattern, pc, INTENSITY\[chatIntensity\(th\.intensity\)\]\)/);
    expect(core).toMatch(/o\['--user-soft'\] = dark \? d\.userSoftDark : d\.userSoft/);
    expect(css).toMatch(/\.m\.ai \{ background: var\(--sheet\) !important; border: 1px solid var\(--cut-seam\) !important; box-shadow: var\(--cut\) !important; \}/);
    expect(css).toMatch(/\.m\.user \{ background: var\(--user-soft\); color: var\(--user-ink\); border: 1px solid var\(--accent\)/);
    expect(css).toMatch(/#chatMessages \{ background-image: var\(--wa-shippo-chat\); \}/);
    // paper corners + one sharp tail (must come AFTER the old 3px/5px rule)
    expect(css.lastIndexOf('.m.user { border-radius: var(--r-paper); border-bottom-right-radius: var(--r-frame); }')).toBeGreaterThan(css.indexOf('border-bottom-right-radius: 5px'));
  });
});

describe('deriveIcons — wood + washi semantics follow the hue', () => {
  const CT = require('../../core/theme.js');
  const fs = require('fs'), path = require('path');
  it('purple theme gives purple-leaning wood; green theme green-leaning; kumiko stays near brown', () => {
    const fuji = CT.hexToRgb(CT.deriveIcons('#7a5c8f', false).wood);
    const matcha = CT.hexToRgb(CT.deriveIcons('#7d9471', false).wood);
    expect(fuji[2]).toBeGreaterThan(matcha[2]);      // more blue under purple
    expect(matcha[1]).toBeGreaterThan(fuji[1]);      // more green under matcha
    const k = CT.deriveIcons('#bd5540', false);
    for (const key of ['wood', 'woodStrong', 'ink', 'woodBg', 'sage', 'indigo', 'gold']) expect(CT.hexToRgb(k[key])).toBeTruthy();
    const d = CT.deriveIcons('#7a5c8f', true);
    expect(CT.hexToRgb(d.woodBg)[0] + CT.hexToRgb(d.woodBg)[1] + CT.hexToRgb(d.woodBg)[2]).toBeLessThan(200);
  });
  it('no pinned wood/gold hexes remain in styles.css; renderer sets the tokens', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    const body = css.replace(/--ic-[a-z-]+: #[0-9a-f]{6};/g, '').replace(/--wa-[a-z]+: #[0-9a-f]{6};/g, '');
    expect(body).not.toMatch(/#8a5a2b|#c6a75f|#6f4420|#b9852e|#6b4a1c|#faedcf|#a9792a|#e7d2a0/i);
    const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
    const core = fs.readFileSync(path.join(__dirname, '../../core/theme.js'), 'utf8');
    expect(core).toMatch(/var ic = deriveIcons\(accent, dark\)/);
    for (const t of ['--ic-wood', '--ic-wood-strong', '--ic-ink', '--ic-wood-bg', '--wa-sage', '--wa-indigo', '--wa-gold']) expect(core).toContain(`o['${t}']`);
  });
});

describe('boot: first paint carries the theme; splash until the vault loads', () => {
  const CT = require('../../core/theme.js');
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  it('CoreTheme.tokens is the single token map (renderer uses it; head scripts use it)', () => {
    const tk = CT.tokens({ preset: 'fuji', pattern: 'sayagata', intensity: 'strong', radius: 'shoji' }, false);
    for (const k of ['--accent', '--surface', '--sheet', '--cut-seam', '--ic-wood', '--wa-shippo', '--wa-shippo-chat', '--r-frame']) expect(tk[k]).toBeTruthy();
    expect(CT.tokens(null, true)['--bg']).toMatch(/^#/);           // null theme → DEFAULT, dark grounds
    expect(CT.resolveMode('system', { matches: true })).toBe('dark');
    expect(CT.resolveMode('system', null)).toBe('light');
    const js = read('renderer/renderer.js');
    expect(js).toMatch(/const tk = window\.CoreTheme\.tokens\(currentKumikoTheme\(\), dark\)/);
    for (const f of ['renderer/index.html', 'web/index.html']) {
      const h = read(f);
      expect(h).toMatch(/var tk = CT\.tokens\(th, dark\); for \(var k in tk\) r\.style\.setProperty\(k, tk\[k\]\);/);
      expect(h).toMatch(/<div id="app" class="term-right">/);
      expect(h).toMatch(/<div class="splash-logo"><i style="-webkit-mask-image:url\([^)]*logo-mask\.png/);   // app logo as a mask, dyed by --accent
      expect(h.indexOf('core/theme.js')).toBeLessThan(h.indexOf('<div id="app"'));   // loaded in head, before the body paints
    }
  });
  it('desktop window shows on ready-to-show; splash removed at end of boot with a 6s cap', () => {
    const m = read('main.js');
    expect(m).toMatch(/show: false/);
    expect(m).toMatch(/win\.once\('ready-to-show', \(\) => \{ if \(!process\.env\.WASHI_TEST\) win\.show\(\); \}\)/);
    const js = read('renderer/renderer.js');
    expect(js).toMatch(/setMainView\('dash'\);\n  hideSplash\(\);\n\}\)\(\);/);
    expect(js).toMatch(/setTimeout\(hideSplash, 6000\)/);
  });
});

describe('tiles + logo pipeline (v2: kumiko-sakura, 2026-09-01)', () => {
  const CT = require('../../core/theme.js');
  const fs = require('fs'), path = require('path');
  it('kazaguruma is a selectable pattern (64px cell, blades ~70%, hub dot) and has a Thai name + EN entry', () => {
    expect(CT.PATTERNS).toContain('kazaguruma');
    const u = CT.patternUri('kazaguruma', '#bd5540', 0.08);
    expect(u).toMatch(/^url\(/);
    expect(decodeURIComponent(u)).toContain("width='64'");
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8')).toContain("kazaguruma: '風車 คาซะกุรุมะ'");
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/i18n.js'), 'utf8')).toContain("'風車 คาซะกุรุมะ': '風車 Kazaguruma'");
  });
  it('the 2026-09-01 ref batch: all 21 tiles present, each named in Thai + EN, valid URIs', () => {
    const BATCH = ['sakuragoshi', 'hanaasa', 'yukiwa', 'asanoha6', 'kiku', 'kumo', 'goma', 'shokko6',
      'izutsu', 'hoshi', 'hikari', 'rindo', 'kakuasa', 'sanjubishi', 'tsumiishi', 'hanabishi',
      'mitsukude', 'mikado', 'shokko8', 'fundo', 'senbon'];
    const renderer = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
    const i18n = fs.readFileSync(path.join(__dirname, '../../renderer/i18n.js'), 'utf8');
    const namesBlock = renderer.slice(renderer.indexOf('const PATTERN_NAMES'), renderer.indexOf('const INTENSITY_NAMES'));
    for (const k of BATCH) {
      expect(CT.PATTERNS).toContain(k);
      expect(CT.patternUri(k, '#bd5540', 0.08)).toMatch(/^url\(/);
      const m = namesBlock.match(new RegExp(k + ": '([^']+)'"));
      expect(m, k + ' must have a Thai name').toBeTruthy();
      expect(i18n, k + ' Thai name needs an EN entry').toContain("'" + m[1] + "':");
    }
    // 9 originals + 21 batch = 30 tiles (+ 'none')
    expect(CT.PATTERNS.length).toBe(31);
    // fundo/senbon carry the enriched v2 geometry (nested / double-rail), not the plain v1
    const fundoD = decodeURIComponent(CT.patternUri('fundo', '#000', 0.1));
    expect(fundoD.split('Z').length - 1).toBeGreaterThanOrEqual(3);
    const senbonD = decodeURIComponent(CT.patternUri('senbon', '#000', 0.1));
    expect((senbonD.match(/H/g) || []).length).toBeGreaterThanOrEqual(4);
  });
  it('sakuragoshi is the DEFAULT pattern (kumiko preset + global fallback)', () => {
    expect(CT.PRESETS.kumiko.pattern).toBe('sakuragoshi');
    const norm = CT.normalizeTheme ? CT.normalizeTheme({}) : null;
    if (norm) expect(norm.pattern).toBe('sakuragoshi');
    const src = fs.readFileSync(path.join(__dirname, '../../core/theme.js'), 'utf8');
    expect(src).toContain("var DEFAULT = { preset: 'kumiko', pattern: 'sakuragoshi'");
  });
  it('sakura (logo v2) is a selectable pattern with baked 5-fold petals + Thai/EN names', () => {
    expect(CT.PATTERNS).toContain('sakura');
    const d = CT.TILES ? CT.TILES.sakura.d : '';
    // 5 petal subpaths + the cell frame = 6 closepaths, all coordinates baked (no transforms)
    expect((CT.patternUri('sakura', '#bd5540', 0.08).match(/Z/g) || []).length).toBeGreaterThanOrEqual(6);
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8')).toContain("sakura: '桜 ซากุระคุมิโกะ'");
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/i18n.js'), 'utf8')).toContain("'桜 ซากุระคุมิโกะ': '桜 Kumiko Sakura'");
  });
  it('logo masters are the K2 kumiko-sakura (5-fold rotate of one cleft petal, sumi + cream)', () => {
    const logo = fs.readFileSync(path.join(__dirname, '../../build/kumiko-logo.svg'), 'utf8');
    const mask = fs.readFileSync(path.join(__dirname, '../../build/kumiko-mask.svg'), 'utf8');
    for (const svg of [logo, mask]) {
      expect(svg).toContain('rotate(72 32 32)');
      expect(svg).toContain('rotate(288 32 32)');
      expect(svg).toContain('L32 11.5');   // the cleft tip of the single master petal
    }
    expect(logo).toContain('#2e2b28');   // sumi plaque
    expect(logo).toContain('#e8d9b8');   // cream wood stroke
    expect(mask).toContain('stroke="#fff"');
  });
  it('splash pinwheel spins slowly (masked layer only) and reduced-motion stops it', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/animation: splash-spin 7s linear infinite/);
    expect(css).toMatch(/@keyframes splash-spin/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.splash-logo, \.splash-logo i, \.splash-bar i \{ animation: none; \} \}/);
  });
});
