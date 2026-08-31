// Kumiko theme engine — PURE functions (node-testable, shared desktop/web).
// One accent in → the whole derived family out; kumiko lattice patterns as data-URIs.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CoreTheme = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function _clamp(x) { return Math.max(0, Math.min(255, Math.round(x))); }
  function hexToRgb(h) {
    var s = String(h || '').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(function (v) { return _clamp(v).toString(16).padStart(2, '0'); }).join('');
  }
  // linear mix toward another colour: mix('#bd5540', '#ffffff', .88) → very light tint
  function mix(hex, toward, t) {
    var a = hexToRgb(hex), b = hexToRgb(toward);
    if (!a || !b) return hex;
    return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }

  // The full family from ONE accent — matches the hand-picked ratios of the shipped palette
  // (#bd5540 → strong #a2452f, bg #f7ebe6, bubble #c96442) so the default derives to itself
  // within a hair. Dark variants brighten instead of darken.
  function deriveAccent(accent) {
    if (!hexToRgb(accent)) accent = '#bd5540';
    return {
      accent: accent,
      accentStrong: mix(accent, '#000000', 0.16),
      accentBg: mix(accent, '#ffffff', 0.86),
      userBubble: mix(accent, '#ffffff', 0.08),
      // user bubble as a tinted slip (opaque enough to sit ON the patterned ground) + its ink
      userSoft: mix(accent, '#ffffff', 0.80),
      userSoftDark: mix(accent, '#000000', 0.58),
      userInk: mix(accent, '#000000', 0.55),
      userInkDark: mix(accent, '#ffffff', 0.62),
      accentDark: mix(accent, '#ffffff', 0.18),        // accent shown on dark ground
      accentStrongDark: mix(accent, '#ffffff', 0.30),
      accentBgDark: mix(accent, '#000000', 0.72),
      // paired GROUNDS for a custom accent — faint tints of the same hue, so a custom theme
      // gets a coherent bg/side/hover family instead of the default cream under a foreign accent
      bg: mix(accent, '#ffffff', 0.958),
      side: mix(accent, '#ffffff', 0.905),
      hover: mix(accent, '#ffffff', 0.875),
    };
  }

  // NEUTRALS that follow the theme hue ("พื้น PDF, เส้นแบ่ง, สีไอคอนยังโทนเดิม" feedback):
  // the shipped warm-grey bases nudged toward the accent, so dividers, muted icon/text tone,
  // the PDF desk, and the hinoki wood line all sit in the SAME temperature as the theme.
  function deriveNeutrals(accent) {
    if (!hexToRgb(accent)) accent = '#bd5540';
    return {
      desk: mix('#f3f1ea', accent, 0.08),         // PDF viewer / crate ground — carries the hue visibly
      line: mix('#e6e3da', accent, 0.09),
      lineStrong: mix('#d3d0c6', accent, 0.11),
      muted: mix('#6f6d64', accent, 0.14),        // icons + secondary text
      wood: mix('#b3987a', accent, 0.30),         // main structural dividers
    };
  }

  // DARK grounds tinted by the theme hue — the second axis. Same recipe as the light side:
  // the shipped dark neutrals nudged 6–12% toward the accent. Kumiko (default) reproduces the
  // shipped dark palette exactly because its accent IS the hue those neutrals were tuned on.
  function deriveDark(accent) {
    if (!hexToRgb(accent)) accent = '#bd5540';
    return {
      bg: mix('#1a1917', accent, 0.06),
      surface: mix('#232220', accent, 0.05),
      side: mix('#201d19', accent, 0.07),
      hover: mix('#2a2723', accent, 0.08),
      desk: mix('#1b1815', accent, 0.06),
      line: mix('#35332f', accent, 0.10),
      lineStrong: mix('#45423d', accent, 0.10),
      muted: mix('#9a978e', accent, 0.12),
      wood: mix('#6a5a47', accent, 0.30),
    };
  }

  // SURFACES — the bars, paper and seams. These used to be pinned (#ffffff bars on a tinted
  // ground read as "unaligned"); now every surface is a faint tint of the hue so bars, sidebar
  // header/footer, note paper and chat ground sit in ONE family. Tints are deliberately small:
  // the paper must still read as paper, the bars only a breath warmer than it.
  function deriveSurfaces(accent, dark) {
    if (!hexToRgb(accent)) accent = '#bd5540';
    var c = hexToRgb(accent);
    if (dark) {
      return {
        surface: mix('#232220', accent, 0.05),     // bars
        sheet: mix('#242220', accent, 0.05),       // note paper
        chat: mix('#221f1b', accent, 0.07),        // chat ground
        seam: 'rgba(0,0,0,.45)',
      };
    }
    return {
      surface: mix('#fcfcfb', accent, 0.045),      // bars — a breath off white, toward the hue
      sheet: mix('#ffffff', accent, 0.012),        // note paper — almost white, same hue
      chat: mix('#f5f4f1', accent, 0.08),          // chat ground — sits with the sidebar
      seam: 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',.22)',   // cut seams carry the hue too
    };
  }

  // ICON + SEMANTIC COLOURS — the last pinned family. Wood (crates / PDFs / folders) and the
  // three washi semantics (sage = database, indigo = note/graph, gold = companion slip) were tuned
  // on the Kumiko vermilion; each is now pulled toward the theme hue so a purple or green theme
  // gets purple-wood / green-wood icons instead of a foreign brown. Shapes still tell them apart.
  function deriveIcons(accent, dark) {
    if (!hexToRgb(accent)) accent = '#bd5540';
    if (dark) {
      return {
        wood: mix('#c6a75f', accent, 0.35),
        woodStrong: mix('#e2c98a', accent, 0.30),
        ink: mix('#e7d2a0', accent, 0.30),          // companion-note text
        woodBg: mix('#3b2f16', accent, 0.30),        // companion active ground
        sage: mix('#86a07a', accent, 0.30),
        indigo: mix('#6f8fb0', accent, 0.30),
        gold: mix('#c6a75f', accent, 0.35),
      };
    }
    return {
      wood: mix('#8a5a2b', accent, 0.35),
      woodStrong: mix('#6f4420', accent, 0.35),
      ink: mix('#6b4a1c', accent, 0.35),
      woodBg: mix('#faedcf', accent, 0.18),
      sage: mix('#7d9471', accent, 0.30),
      indigo: mix('#3f5c7d', accent, 0.30),
      gold: mix('#bd9a4e', accent, 0.35),
    };
  }

  // chat ground carries the pattern ONE step fainter than the sidebar: dense text needs the
  // lattice to step back further than a list does. off stays off.
  function chatIntensity(step) {
    var i = INTENSITY_ORDER.indexOf(step);
    if (i <= 0) return INTENSITY_ORDER[0];
    return INTENSITY_ORDER[i - 1];
  }

  // ---- kumiko lattice tiles (stroke-only; colour + opacity injected) --------------------
  var TILES = {
    shippou: { w: 24, h: 24, d: 'M0 0m-12 0a12 12 0 1 0 24 0a12 12 0 1 0 -24 0M24 0m-12 0a12 12 0 1 0 24 0a12 12 0 1 0 -24 0M0 24m-12 0a12 12 0 1 0 24 0a12 12 0 1 0 -24 0M24 24m-12 0a12 12 0 1 0 24 0a12 12 0 1 0 -24 0M12 12m-12 0a12 12 0 1 0 24 0a12 12 0 1 0 -24 0' },
    asanoha: { w: 40, h: 46.2, d: 'M20 0L40 11.55L40 34.65L20 46.2L0 34.65L0 11.55Z M20 0V46.2M0 11.55L40 34.65M40 11.55L0 34.65 M20 23.1L20 0M20 23.1L40 11.55M20 23.1L40 34.65M20 23.1L20 46.2M20 23.1L0 34.65M20 23.1L0 11.55' },
    kagome: { w: 36, h: 62.4, d: 'M0 15.6L36 15.6M0 46.8L36 46.8M-9 0L27 62.4M9 0L45 62.4M27 0L-9 62.4M45 0L9 62.4' },
    kikko: { w: 42, h: 24.2, d: 'M10.5 0L31.5 0L42 12.1L31.5 24.2L10.5 24.2L0 12.1Z M31.5 0L21 12.1L31.5 24.2M0 12.1L21 12.1' },
    sayagata: { w: 40, h: 40, d: 'M0 10H20V30H40M10 0V20H30V40M0 30H10M30 0V10M10 40V30M40 20H30' },
    masu: { w: 36, h: 36, d: 'M0 0H36V36H0Z M6 6H30V30H6Z M0 18H6M30 18H36M18 0V6M18 30V36' },
    seigaiha: { w: 40, h: 20, d: 'M20 20m-18 0a18 18 0 1 1 36 0M20 20m-12 0a12 12 0 1 1 24 0M20 20m-6 0a6 6 0 1 1 12 0M0 10m-18 0a18 18 0 1 1 36 0M40 10m-18 0a18 18 0 1 1 36 0' },
    // 風車 — four blades at ~70% of the cell (the proportion the user picked), matches the app icon
    kazaguruma: { w: 64, h: 64, d: 'M0 0H64V64H0Z M32 32L32 5 51 16Z M32 32L59 32 48 51Z M32 32L32 59 13 48Z M32 32L5 32 16 13Z M32 32m-3.2 0a3.2 3.2 0 1 0 6.4 0a3.2 3.2 0 1 0 -6.4 0' },
  };
  var PATTERNS = ['none'].concat(Object.keys(TILES));

  // CSS url("data:image/svg+xml,…") for a tile, or 'none'. Colour is any hex; opacity 0–1.
  function patternUri(name, colorHex, opacity) {
    var tile = TILES[name];
    if (!tile) return 'none';
    var op = Math.max(0, Math.min(1, Number(opacity) || 0));
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + tile.w + "' height='" + tile.h + "'>" +
      "<path d='" + tile.d + "' fill='none' stroke='" + colorHex + "' stroke-opacity='" + op + "' stroke-width='1'/></svg>";
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  // ---- presets = THE palette (6 hues). Colour is chosen here only — no free accent picker.
  // Each carries hand-tuned light grounds; dark grounds derive (deriveDark). Mode (light/dark)
  // is a separate axis, so every hue works in both.
  var PRESETS = {
    kumiko:  { label: '組子 คุมิโกะ', en: '組子 Kumiko', accent: '#bd5540', pattern: 'shippou',
      palette: { bg: '#faf9f6', side: '#f3efe7', hover: '#efece3' },
      neutrals: { desk: '#efe5dc', line: '#e6e3da', lineStrong: '#d3d0c6', muted: '#6f6d64', wood: '#b3987a' } },
    sakura:  { label: '桜 ซากุระ', en: '桜 Sakura', accent: '#c26e7a', pattern: 'asanoha',
      palette: { bg: '#fbf7f6', side: '#f7eceb', hover: '#f3e3e1' } },
    karashi: { label: '芥子 คาราชิ', en: '芥子 Karashi', accent: '#b08a3a', pattern: 'kikko',
      palette: { bg: '#fbf9f3', side: '#f6f1e2', hover: '#f0e9d4' } },
    matcha:  { label: '抹茶 มัทฉะ', en: '抹茶 Matcha', accent: '#7d9471', pattern: 'seigaiha',
      palette: { bg: '#f8faf5', side: '#eef3e9', hover: '#e7eee0' } },
    ai:      { label: '藍 อาอิ', en: '藍 Ai', accent: '#3f5c7d', pattern: 'kagome',
      palette: { bg: '#f7f9fb', side: '#eaeff4', hover: '#e2e9f0' } },
    fuji:    { label: '藤 ฟุจิ', en: '藤 Fuji', accent: '#7a5c8f', pattern: 'sayagata',
      palette: { bg: '#f9f7fb', side: '#f0ecf4', hover: '#e9e3ef' } },
  };
  // pattern intensity: four named steps instead of a slider
  var INTENSITY = { off: 0, faint: 0.04, mid: 0.08, strong: 0.14 };
  var INTENSITY_ORDER = ['off', 'faint', 'mid', 'strong'];

  var DEFAULT = { preset: 'kumiko', pattern: 'shippou', intensity: 'faint', radius: 'shoji' };

  // Normalize a stored theme object. Legacy shapes are migrated: preset 'sumi' (was "dark as
  // a colour") → kumiko; numeric intensity → nearest named step; stray accents are dropped
  // (colour comes from the preset only).
  function normalize(th) {
    th = th || {};
    var preset = PRESETS[th.preset] ? th.preset : DEFAULT.preset;
    var inten = th.intensity;
    if (typeof inten === 'number') {
      var best = 'faint', bd = 9;
      INTENSITY_ORDER.forEach(function (k) { var d = Math.abs(INTENSITY[k] - inten); if (d < bd) { bd = d; best = k; } });
      inten = best;
    }
    if (INTENSITY_ORDER.indexOf(inten) < 0) inten = DEFAULT.intensity;
    return {
      preset: preset,
      pattern: PATTERNS.indexOf(th.pattern) >= 0 ? th.pattern : DEFAULT.pattern,
      intensity: inten,
      radius: th.radius === 'soft' ? 'soft' : 'shoji',
    };
  }
  // the accent a normalized theme resolves to (never stored)
  function accentOf(th) { return PRESETS[th.preset] ? PRESETS[th.preset].accent : PRESETS.kumiko.accent; }

  // FULL CSS token map for a theme in a mode. Used by renderer applyKumikoTheme AND by the
  // synchronous boot script in index.html <head>, so the very first paint already has the
  // user's hue (no vermilion/cream flash before JS runs).
  function tokens(th, dark) {
    th = normalize(th);
    var accent = accentOf(th);
    var d = deriveAccent(accent), preset = PRESETS[th.preset] || PRESETS[DEFAULT.preset];
    var o = {};
    o['--accent'] = dark ? d.accentDark : d.accent;
    o['--accent-strong'] = dark ? d.accentStrongDark : d.accentStrong;
    o['--accent-bg'] = dark ? d.accentBgDark : d.accentBg;
    o['--user-bubble'] = d.userBubble;
    o['--user-soft'] = dark ? d.userSoftDark : d.userSoft;
    o['--user-ink'] = dark ? d.userInkDark : d.userInk;
    if (dark) {
      var k = deriveDark(accent);
      o['--bg'] = k.bg; o['--side'] = k.side; o['--chat-bg'] = k.side; o['--hover'] = k.hover; o['--desk'] = k.desk;
      o['--line'] = k.line; o['--line-strong'] = k.lineStrong; o['--muted'] = k.muted; o['--line-wood'] = k.wood;
    } else {
      var pal = preset.palette, neu = preset.neutrals || deriveNeutrals(accent);
      o['--bg'] = pal.bg; o['--side'] = pal.side; o['--chat-bg'] = pal.side; o['--hover'] = pal.hover;
      o['--desk'] = neu.desk; o['--line'] = neu.line; o['--line-strong'] = neu.lineStrong; o['--muted'] = neu.muted; o['--line-wood'] = neu.wood;
    }
    var sf = deriveSurfaces(accent, dark);
    o['--surface'] = sf.surface; o['--sheet'] = sf.sheet; o['--paper'] = sf.sheet; o['--chat'] = sf.chat; o['--cut-seam'] = sf.seam;
    var ic = deriveIcons(accent, dark);
    o['--ic-wood'] = ic.wood; o['--ic-wood-strong'] = ic.woodStrong; o['--ic-ink'] = ic.ink; o['--ic-wood-bg'] = ic.woodBg;
    o['--wa-sage'] = ic.sage; o['--wa-indigo'] = ic.indigo; o['--wa-gold'] = ic.gold;
    o['--r-frame'] = th.radius === 'soft' ? '7px' : '3px';
    o['--r-paper'] = th.radius === 'soft' ? '12px' : '9px';
    var pc = dark ? d.accentDark : accent;
    o['--wa-shippo'] = patternUri(th.pattern, pc, INTENSITY[th.intensity]);
    o['--wa-shippo-chat'] = patternUri(th.pattern, pc, INTENSITY[chatIntensity(th.intensity)]);
    return o;
  }
  // mode string → 'light' | 'dark' (system follows the OS when matchMedia is available)
  function resolveMode(mode, mql) {
    if (mode === 'dark') return 'dark';
    if (mode === 'system') return (mql && mql.matches) ? 'dark' : 'light';
    return 'light';
  }

  return { tokens: tokens, resolveMode: resolveMode, hexToRgb: hexToRgb, rgbToHex: rgbToHex, mix: mix, deriveAccent: deriveAccent, deriveNeutrals: deriveNeutrals, deriveDark: deriveDark, deriveSurfaces: deriveSurfaces, deriveIcons: deriveIcons, chatIntensity: chatIntensity,
    patternUri: patternUri, PATTERNS: PATTERNS, PRESETS: PRESETS, INTENSITY: INTENSITY, INTENSITY_ORDER: INTENSITY_ORDER,
    DEFAULT: DEFAULT, normalize: normalize, accentOf: accentOf };
});
