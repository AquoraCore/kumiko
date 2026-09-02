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
    // logo v2 (2026-09-01): the kumiko-sakura — ONE cleft petal rotated 72°×5 baked into
    // coordinates (data-URI d can't carry transforms); star hole forms itself at the heart
    sakura: { w: 64, h: 64, d: 'M0 0H64V64H0Z M32.0 28.5C27.5 26.0 25.0 21.0 25.0 15.5C25.0 10.5 27.5 7.8 29.8 9.2L32.0 11.5L34.2 9.2C36.5 7.8 39.0 10.5 39.0 15.5C39.0 21.0 36.5 26.0 32.0 28.5Z M35.3 30.9C36.3 25.9 40.3 21.9 45.5 20.2C50.3 18.7 53.6 20.2 53.0 22.9L51.5 25.7L54.4 27.0C56.4 28.8 54.6 32.0 49.9 33.6C44.6 35.3 39.1 34.4 35.3 30.9Z M34.1 34.8C39.2 34.2 44.1 36.8 47.4 41.2C50.3 45.3 49.9 48.9 47.2 49.2L44.0 48.6L43.6 51.7C42.6 54.2 39.0 53.5 36.0 49.5C32.8 45.0 31.9 39.5 34.1 34.8Z M29.9 34.8C32.1 39.5 31.2 45.0 28.0 49.5C25.0 53.5 21.4 54.2 20.4 51.7L20.0 48.6L16.8 49.2C14.1 48.9 13.7 45.3 16.6 41.2C19.9 36.8 24.8 34.2 29.9 34.8Z M28.7 30.9C24.9 34.4 19.4 35.3 14.1 33.6C9.4 32.0 7.6 28.8 9.6 27.0L12.5 25.7L11.0 22.9C10.4 20.2 13.7 18.7 18.5 20.2C23.7 21.9 27.7 25.9 28.7 30.9Z' },
    // ---- 2026-09-01 batch: 21 tiles drawn from the user's refs (hex motif sheet,
    // sakura woodwork photo, Tanihata list 18/18) -- hex/rhombic cells with coords BAKED
    // (data-URI d cannot carry transforms); fundo/senbon are the enriched v2 shapes
    sakuragoshi: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 33.8C18.0 32.3 16.5 29.2 16.5 25.8C16.5 22.7 18.0 21.0 19.4 21.9L20.8 23.3L22.2 21.9C23.6 21.0 25.1 22.7 25.1 25.8C25.1 29.2 23.6 32.3 20.8 33.8Z M22.9 35.3C23.5 32.2 25.9 29.8 29.2 28.7C32.1 27.8 34.2 28.7 33.8 30.3L32.9 32.1L34.7 32.9C35.9 34.0 34.8 36.0 31.9 37.0C28.6 38.0 25.2 37.5 22.9 35.3Z M22.1 37.8C25.2 37.4 28.3 39.0 30.3 41.7C32.1 44.2 31.9 46.5 30.2 46.6L28.3 46.3L28.0 48.2C27.4 49.8 25.1 49.3 23.3 46.8C21.3 44.1 20.7 40.6 22.1 37.8Z M19.5 37.8C20.9 40.6 20.3 44.1 18.3 46.8C16.5 49.3 14.2 49.8 13.6 48.2L13.3 46.3L11.4 46.6C9.7 46.5 9.5 44.2 11.3 41.7C13.3 39.0 16.4 37.4 19.5 37.8Z M18.7 35.3C16.4 37.5 13.0 38.0 9.7 37.0C6.8 36.0 5.7 34.0 6.9 32.9L8.7 32.1L7.8 30.3C7.4 28.7 9.5 27.8 12.4 28.7C15.7 29.8 18.1 32.2 18.7 35.3Z M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 -2.2C-2.8 -3.7 -4.3 -6.8 -4.3 -10.2C-4.3 -13.3 -2.8 -15.0 -1.4 -14.1L0.0 -12.7L1.4 -14.1C2.8 -15.0 4.3 -13.3 4.3 -10.2C4.3 -6.8 2.8 -3.7 0.0 -2.2Z M2.1 -0.7C2.7 -3.8 5.1 -6.2 8.4 -7.3C11.3 -8.2 13.4 -7.3 13.0 -5.7L12.1 -3.9L13.9 -3.1C15.1 -2.0 14.0 0.0 11.1 1.0C7.8 2.0 4.4 1.5 2.1 -0.7Z M1.3 1.8C4.4 1.4 7.5 3.0 9.5 5.7C11.3 8.2 11.1 10.5 9.4 10.6L7.5 10.3L7.2 12.2C6.6 13.8 4.3 13.3 2.5 10.8C0.5 8.1 -0.1 4.6 1.3 1.8Z M-1.3 1.8C0.1 4.6 -0.5 8.1 -2.5 10.8C-4.3 13.3 -6.6 13.8 -7.2 12.2L-7.5 10.3L-9.4 10.6C-11.1 10.5 -11.3 8.2 -9.5 5.7C-7.5 3.0 -4.4 1.4 -1.3 1.8Z M-2.1 -0.7C-4.4 1.5 -7.8 2.0 -11.1 1.0C-14.0 0.0 -15.1 -2.0 -13.9 -3.1L-12.1 -3.9L-13.0 -5.7C-13.4 -7.3 -11.3 -8.2 -8.4 -7.3C-5.1 -6.2 -2.7 -3.8 -2.1 -0.7Z M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 -2.2C38.8 -3.7 37.3 -6.8 37.3 -10.2C37.3 -13.3 38.8 -15.0 40.2 -14.1L41.6 -12.7L43.0 -14.1C44.4 -15.0 45.9 -13.3 45.9 -10.2C45.9 -6.8 44.4 -3.7 41.6 -2.2Z M43.7 -0.7C44.3 -3.8 46.7 -6.2 50.0 -7.3C52.9 -8.2 55.0 -7.3 54.6 -5.7L53.7 -3.9L55.5 -3.1C56.7 -2.0 55.6 0.0 52.7 1.0C49.4 2.0 46.0 1.5 43.7 -0.7Z M42.9 1.8C46.0 1.4 49.1 3.0 51.1 5.7C52.9 8.2 52.7 10.5 51.0 10.6L49.1 10.3L48.8 12.2C48.2 13.8 45.9 13.3 44.1 10.8C42.1 8.1 41.5 4.6 42.9 1.8Z M40.3 1.8C41.7 4.6 41.1 8.1 39.1 10.8C37.3 13.3 35.0 13.8 34.4 12.2L34.1 10.3L32.2 10.6C30.5 10.5 30.3 8.2 32.1 5.7C34.1 3.0 37.2 1.4 40.3 1.8Z M39.5 -0.7C37.2 1.5 33.8 2.0 30.5 1.0C27.6 0.0 26.5 -2.0 27.7 -3.1L29.5 -3.9L28.6 -5.7C28.2 -7.3 30.3 -8.2 33.2 -7.3C36.5 -6.2 38.9 -3.8 39.5 -0.7Z M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 69.8C-2.8 68.3 -4.3 65.2 -4.3 61.8C-4.3 58.7 -2.8 57.0 -1.4 57.9L0.0 59.3L1.4 57.9C2.8 57.0 4.3 58.7 4.3 61.8C4.3 65.2 2.8 68.3 0.0 69.8Z M2.1 71.3C2.7 68.2 5.1 65.8 8.4 64.7C11.3 63.8 13.4 64.7 13.0 66.3L12.1 68.1L13.9 68.9C15.1 70.0 14.0 72.0 11.1 73.0C7.8 74.0 4.4 73.5 2.1 71.3Z M1.3 73.8C4.4 73.4 7.5 75.0 9.5 77.7C11.3 80.2 11.1 82.5 9.4 82.6L7.5 82.3L7.2 84.2C6.6 85.8 4.3 85.3 2.5 82.8C0.5 80.1 -0.1 76.6 1.3 73.8Z M-1.3 73.8C0.1 76.6 -0.5 80.1 -2.5 82.8C-4.3 85.3 -6.6 85.8 -7.2 84.2L-7.5 82.3L-9.4 82.6C-11.1 82.5 -11.3 80.2 -9.5 77.7C-7.5 75.0 -4.4 73.4 -1.3 73.8Z M-2.1 71.3C-4.4 73.5 -7.8 74.0 -11.1 73.0C-14.0 72.0 -15.1 70.0 -13.9 68.9L-12.1 68.1L-13.0 66.3C-13.4 64.7 -11.3 63.8 -8.4 64.7C-5.1 65.8 -2.7 68.2 -2.1 71.3Z M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 69.8C38.8 68.3 37.3 65.2 37.3 61.8C37.3 58.7 38.8 57.0 40.2 57.9L41.6 59.3L43.0 57.9C44.4 57.0 45.9 58.7 45.9 61.8C45.9 65.2 44.4 68.3 41.6 69.8Z M43.7 71.3C44.3 68.2 46.7 65.8 50.0 64.7C52.9 63.8 55.0 64.7 54.6 66.3L53.7 68.1L55.5 68.9C56.7 70.0 55.6 72.0 52.7 73.0C49.4 74.0 46.0 73.5 43.7 71.3Z M42.9 73.8C46.0 73.4 49.1 75.0 51.1 77.7C52.9 80.2 52.7 82.5 51.0 82.6L49.1 82.3L48.8 84.2C48.2 85.8 45.9 85.3 44.1 82.8C42.1 80.1 41.5 76.6 42.9 73.8Z M40.3 73.8C41.7 76.6 41.1 80.1 39.1 82.8C37.3 85.3 35.0 85.8 34.4 84.2L34.1 82.3L32.2 82.6C30.5 82.5 30.3 80.2 32.1 77.7C34.1 75.0 37.2 73.4 40.3 73.8Z M39.5 71.3C37.2 73.5 33.8 74.0 30.5 73.0C27.6 72.0 26.5 70.0 27.7 68.9L29.5 68.1L28.6 66.3C28.2 64.7 30.3 63.8 33.2 64.7C36.5 65.8 38.9 68.2 39.5 71.3Z' },
    hanaasa: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 33.8C18.0 32.3 16.5 29.2 16.5 25.8C16.5 22.7 18.0 21.0 19.4 21.9L20.8 23.3L22.2 21.9C23.6 21.0 25.1 22.7 25.1 25.8C25.1 29.2 23.6 32.3 20.8 33.8Z M22.9 35.3C23.5 32.2 25.9 29.8 29.2 28.7C32.1 27.8 34.2 28.7 33.8 30.3L32.9 32.1L34.7 32.9C35.9 34.0 34.8 36.0 31.9 37.0C28.6 38.0 25.2 37.5 22.9 35.3Z M22.1 37.8C25.2 37.4 28.3 39.0 30.3 41.7C32.1 44.2 31.9 46.5 30.2 46.6L28.3 46.3L28.0 48.2C27.4 49.8 25.1 49.3 23.3 46.8C21.3 44.1 20.7 40.6 22.1 37.8Z M19.5 37.8C20.9 40.6 20.3 44.1 18.3 46.8C16.5 49.3 14.2 49.8 13.6 48.2L13.3 46.3L11.4 46.6C9.7 46.5 9.5 44.2 11.3 41.7C13.3 39.0 16.4 37.4 19.5 37.8Z M18.7 35.3C16.4 37.5 13.0 38.0 9.7 37.0C6.8 36.0 5.7 34.0 6.9 32.9L8.7 32.1L7.8 30.3C7.4 28.7 9.5 27.8 12.4 28.7C15.7 29.8 18.1 32.2 18.7 35.3Z M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 24.0 -20.8 -12.0 20.8 -12.0Z M-20.8 12.0 -0.0 -24.0 20.8 12.0Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 12.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L-0.0 -24.0 M0.0 0.0L20.8 -12.0 M0.0 0.0L20.8 12.0 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 24.0 20.8 -12.0 62.4 -12.0Z M20.8 12.0 41.6 -24.0 62.4 12.0Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 12.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L41.6 -24.0 M41.6 0.0L62.4 -12.0 M41.6 0.0L62.4 12.0 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 96.0 -20.8 60.0 20.8 60.0Z M-20.8 84.0 -0.0 48.0 20.8 84.0Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 84.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L-0.0 48.0 M0.0 72.0L20.8 60.0 M0.0 72.0L20.8 84.0 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 96.0 20.8 60.0 62.4 60.0Z M20.8 84.0 41.6 48.0 62.4 84.0Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 84.0 M41.6 72.0L20.8 60.0 M41.6 72.0L41.6 48.0 M41.6 72.0L62.4 60.0 M41.6 72.0L62.4 84.0' },
    yukiwa: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 36.0L20.8 60.0 M20.8 36.0L0.0 48.0 M20.8 36.0L0.0 24.0 M20.8 36.0L20.8 12.0 M20.8 36.0L41.6 24.0 M20.8 36.0L41.6 48.0 M20.8 49.9L16.0 53.9 M20.8 49.9L25.6 53.9 M8.7 43.0L2.9 40.8 M8.7 43.0L7.7 49.1 M8.7 29.0L7.7 22.9 M8.7 29.0L2.9 31.2 M20.8 22.1L25.6 18.1 M20.8 22.1L16.0 18.1 M32.9 29.0L38.7 31.2 M32.9 29.0L33.9 22.9 M32.9 43.0L33.9 49.1 M32.9 43.0L38.7 40.8 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 12.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L-0.0 -24.0 M0.0 0.0L20.8 -12.0 M0.0 0.0L20.8 12.0 M0.0 13.9L-4.8 17.9 M0.0 13.9L4.8 17.9 M-12.1 7.0L-17.9 4.8 M-12.1 7.0L-13.1 13.1 M-12.1 -7.0L-13.1 -13.1 M-12.1 -7.0L-17.9 -4.8 M-0.0 -13.9L4.8 -17.9 M-0.0 -13.9L-4.8 -17.9 M12.1 -7.0L17.9 -4.8 M12.1 -7.0L13.1 -13.1 M12.1 7.0L13.1 13.1 M12.1 7.0L17.9 4.8 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 12.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L41.6 -24.0 M41.6 0.0L62.4 -12.0 M41.6 0.0L62.4 12.0 M41.6 13.9L36.8 17.9 M41.6 13.9L46.4 17.9 M29.5 7.0L23.7 4.8 M29.5 7.0L28.5 13.1 M29.5 -7.0L28.5 -13.1 M29.5 -7.0L23.7 -4.8 M41.6 -13.9L46.4 -17.9 M41.6 -13.9L36.8 -17.9 M53.7 -7.0L59.5 -4.8 M53.7 -7.0L54.7 -13.1 M53.7 7.0L54.7 13.1 M53.7 7.0L59.5 4.8 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 84.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L-0.0 48.0 M0.0 72.0L20.8 60.0 M0.0 72.0L20.8 84.0 M0.0 85.9L-4.8 89.9 M0.0 85.9L4.8 89.9 M-12.1 79.0L-17.9 76.8 M-12.1 79.0L-13.1 85.1 M-12.1 65.0L-13.1 58.9 M-12.1 65.0L-17.9 67.2 M-0.0 58.1L4.8 54.1 M-0.0 58.1L-4.8 54.1 M12.1 65.0L17.9 67.2 M12.1 65.0L13.1 58.9 M12.1 79.0L13.1 85.1 M12.1 79.0L17.9 76.8 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 84.0 M41.6 72.0L20.8 60.0 M41.6 72.0L41.6 48.0 M41.6 72.0L62.4 60.0 M41.6 72.0L62.4 84.0 M41.6 85.9L36.8 89.9 M41.6 85.9L46.4 89.9 M29.5 79.0L23.7 76.8 M29.5 79.0L28.5 85.1 M29.5 65.0L28.5 58.9 M29.5 65.0L23.7 67.2 M41.6 58.1L46.4 54.1 M41.6 58.1L36.8 54.1 M53.7 65.0L59.5 67.2 M53.7 65.0L54.7 58.9 M53.7 79.0L54.7 85.1 M53.7 79.0L59.5 76.8' },
    asanoha6: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 60.0 0.0 24.0 41.6 24.0Z M0.0 48.0 20.8 12.0 41.6 48.0Z M20.8 36.0L20.8 60.0 M20.8 36.0L0.0 48.0 M20.8 36.0L0.0 24.0 M20.8 36.0L20.8 12.0 M20.8 36.0L41.6 24.0 M20.8 36.0L41.6 48.0 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 24.0 -20.8 -12.0 20.8 -12.0Z M-20.8 12.0 -0.0 -24.0 20.8 12.0Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 12.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L-0.0 -24.0 M0.0 0.0L20.8 -12.0 M0.0 0.0L20.8 12.0 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 24.0 20.8 -12.0 62.4 -12.0Z M20.8 12.0 41.6 -24.0 62.4 12.0Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 12.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L41.6 -24.0 M41.6 0.0L62.4 -12.0 M41.6 0.0L62.4 12.0 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 96.0 -20.8 60.0 20.8 60.0Z M-20.8 84.0 -0.0 48.0 20.8 84.0Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 84.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L-0.0 48.0 M0.0 72.0L20.8 60.0 M0.0 72.0L20.8 84.0 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 96.0 20.8 60.0 62.4 60.0Z M20.8 84.0 41.6 48.0 62.4 84.0Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 84.0 M41.6 72.0L20.8 60.0 M41.6 72.0L41.6 48.0 M41.6 72.0L62.4 60.0 M41.6 72.0L62.4 84.0' },
    kiku: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 41.3 16.2 38.6 16.2 33.4 20.8 30.7 25.4 33.4 25.4 38.6Z M20.8 41.3L20.8 60.0 M16.2 38.6L0.0 48.0 M16.2 33.4L0.0 24.0 M20.8 30.7L20.8 12.0 M25.4 33.4L41.6 24.0 M25.4 38.6L41.6 48.0 M18.2 40.5L10.4 54.0 M15.6 36.0L0.0 36.0 M18.2 31.5L10.4 18.0 M23.4 31.5L31.2 18.0 M26.0 36.0L41.6 36.0 M23.4 40.5L31.2 54.0 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 5.3 -4.6 2.6 -4.6 -2.6 -0.0 -5.3 4.6 -2.6 4.6 2.6Z M0.0 5.3L0.0 24.0 M-4.6 2.6L-20.8 12.0 M-4.6 -2.6L-20.8 -12.0 M-0.0 -5.3L-0.0 -24.0 M4.6 -2.6L20.8 -12.0 M4.6 2.6L20.8 12.0 M-2.6 4.5L-10.4 18.0 M-5.2 -0.0L-20.8 -0.0 M-2.6 -4.5L-10.4 -18.0 M2.6 -4.5L10.4 -18.0 M5.2 -0.0L20.8 -0.0 M2.6 4.5L10.4 18.0 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 5.3 37.0 2.6 37.0 -2.6 41.6 -5.3 46.2 -2.6 46.2 2.6Z M41.6 5.3L41.6 24.0 M37.0 2.6L20.8 12.0 M37.0 -2.6L20.8 -12.0 M41.6 -5.3L41.6 -24.0 M46.2 -2.6L62.4 -12.0 M46.2 2.6L62.4 12.0 M39.0 4.5L31.2 18.0 M36.4 -0.0L20.8 -0.0 M39.0 -4.5L31.2 -18.0 M44.2 -4.5L52.0 -18.0 M46.8 -0.0L62.4 -0.0 M44.2 4.5L52.0 18.0 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 77.3 -4.6 74.6 -4.6 69.4 -0.0 66.7 4.6 69.4 4.6 74.6Z M0.0 77.3L0.0 96.0 M-4.6 74.6L-20.8 84.0 M-4.6 69.4L-20.8 60.0 M-0.0 66.7L-0.0 48.0 M4.6 69.4L20.8 60.0 M4.6 74.6L20.8 84.0 M-2.6 76.5L-10.4 90.0 M-5.2 72.0L-20.8 72.0 M-2.6 67.5L-10.4 54.0 M2.6 67.5L10.4 54.0 M5.2 72.0L20.8 72.0 M2.6 76.5L10.4 90.0 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 77.3 37.0 74.6 37.0 69.4 41.6 66.7 46.2 69.4 46.2 74.6Z M41.6 77.3L41.6 96.0 M37.0 74.6L20.8 84.0 M37.0 69.4L20.8 60.0 M41.6 66.7L41.6 48.0 M46.2 69.4L62.4 60.0 M46.2 74.6L62.4 84.0 M39.0 76.5L31.2 90.0 M36.4 72.0L20.8 72.0 M39.0 67.5L31.2 54.0 M44.2 67.5L52.0 54.0 M46.8 72.0L62.4 72.0 M44.2 76.5L52.0 90.0' },
    kumo: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 50.9 7.9 43.4 7.9 28.6 20.8 21.1 33.7 28.6 33.7 43.4Z M20.8 43.2 14.6 39.6 14.6 32.4 20.8 28.8 27.0 32.4 27.0 39.6Z M20.8 36.0L20.8 60.0 M20.8 36.0L0.0 48.0 M20.8 36.0L0.0 24.0 M20.8 36.0L20.8 12.0 M20.8 36.0L41.6 24.0 M20.8 36.0L41.6 48.0 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 14.9 -12.9 7.4 -12.9 -7.4 -0.0 -14.9 12.9 -7.4 12.9 7.4Z M0.0 7.2 -6.2 3.6 -6.2 -3.6 -0.0 -7.2 6.2 -3.6 6.2 3.6Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 12.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L-0.0 -24.0 M0.0 0.0L20.8 -12.0 M0.0 0.0L20.8 12.0 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 14.9 28.7 7.4 28.7 -7.4 41.6 -14.9 54.5 -7.4 54.5 7.4Z M41.6 7.2 35.4 3.6 35.4 -3.6 41.6 -7.2 47.8 -3.6 47.8 3.6Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 12.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L41.6 -24.0 M41.6 0.0L62.4 -12.0 M41.6 0.0L62.4 12.0 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 86.9 -12.9 79.4 -12.9 64.6 -0.0 57.1 12.9 64.6 12.9 79.4Z M0.0 79.2 -6.2 75.6 -6.2 68.4 -0.0 64.8 6.2 68.4 6.2 75.6Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 84.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L-0.0 48.0 M0.0 72.0L20.8 60.0 M0.0 72.0L20.8 84.0 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 86.9 28.7 79.4 28.7 64.6 41.6 57.1 54.5 64.6 54.5 79.4Z M41.6 79.2 35.4 75.6 35.4 68.4 41.6 64.8 47.8 68.4 47.8 75.6Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 84.0 M41.6 72.0L20.8 60.0 M41.6 72.0L41.6 48.0 M41.6 72.0L62.4 60.0 M41.6 72.0L62.4 84.0' },
    goma: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 36.0L20.8 60.0 M20.8 36.0L0.0 24.0 M20.8 36.0L41.6 24.0 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L20.8 -12.0 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L62.4 -12.0 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L20.8 60.0 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 60.0 M41.6 72.0L62.4 60.0' },
    shokko6: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M12.2 51.0 3.5 36.0 12.2 21.0 29.4 21.0 38.1 36.0 29.4 51.0Z M20.8 42.2 15.4 39.1 15.4 32.9 20.8 29.8 26.2 32.9 26.2 39.1Z M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M-8.6 15.0 -17.3 0.0 -8.6 -15.0 8.6 -15.0 17.3 -0.0 8.6 15.0Z M0.0 6.2 -5.4 3.1 -5.4 -3.1 -0.0 -6.2 5.4 -3.1 5.4 3.1Z M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M33.0 15.0 24.3 0.0 33.0 -15.0 50.2 -15.0 58.9 -0.0 50.2 15.0Z M41.6 6.2 36.2 3.1 36.2 -3.1 41.6 -6.2 47.0 -3.1 47.0 3.1Z M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M-8.6 87.0 -17.3 72.0 -8.6 57.0 8.6 57.0 17.3 72.0 8.6 87.0Z M0.0 78.2 -5.4 75.1 -5.4 68.9 -0.0 65.8 5.4 68.9 5.4 75.1Z M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M33.0 87.0 24.3 72.0 33.0 57.0 50.2 57.0 58.9 72.0 50.2 87.0Z M41.6 78.2 36.2 75.1 36.2 68.9 41.6 65.8 47.0 68.9 47.0 75.1Z' },
    izutsu: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 49.2 9.4 42.6 9.4 29.4 20.8 22.8 32.2 29.4 32.2 42.6Z M20.8 60.0L20.8 49.2 M0.0 48.0L9.4 42.6 M0.0 24.0L9.4 29.4 M20.8 12.0L20.8 22.8 M41.6 24.0L32.2 29.4 M41.6 48.0L32.2 42.6 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 13.2 -11.4 6.6 -11.4 -6.6 -0.0 -13.2 11.4 -6.6 11.4 6.6Z M0.0 24.0L0.0 13.2 M-20.8 12.0L-11.4 6.6 M-20.8 -12.0L-11.4 -6.6 M-0.0 -24.0L-0.0 -13.2 M20.8 -12.0L11.4 -6.6 M20.8 12.0L11.4 6.6 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 13.2 30.2 6.6 30.2 -6.6 41.6 -13.2 53.0 -6.6 53.0 6.6Z M41.6 24.0L41.6 13.2 M20.8 12.0L30.2 6.6 M20.8 -12.0L30.2 -6.6 M41.6 -24.0L41.6 -13.2 M62.4 -12.0L53.0 -6.6 M62.4 12.0L53.0 6.6 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 85.2 -11.4 78.6 -11.4 65.4 -0.0 58.8 11.4 65.4 11.4 78.6Z M0.0 96.0L0.0 85.2 M-20.8 84.0L-11.4 78.6 M-20.8 60.0L-11.4 65.4 M-0.0 48.0L-0.0 58.8 M20.8 60.0L11.4 65.4 M20.8 84.0L11.4 78.6 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 85.2 30.2 78.6 30.2 65.4 41.6 58.8 53.0 65.4 53.0 78.6Z M41.6 96.0L41.6 85.2 M20.8 84.0L30.2 78.6 M20.8 60.0L30.2 65.4 M41.6 48.0L41.6 58.8 M62.4 60.0L53.0 65.4 M62.4 84.0L53.0 78.6' },
    hoshi: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 60.0 0.0 24.0 41.6 24.0Z M0.0 48.0 20.8 12.0 41.6 48.0Z M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 24.0 -20.8 -12.0 20.8 -12.0Z M-20.8 12.0 -0.0 -24.0 20.8 12.0Z M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 24.0 20.8 -12.0 62.4 -12.0Z M20.8 12.0 41.6 -24.0 62.4 12.0Z M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 96.0 -20.8 60.0 20.8 60.0Z M-20.8 84.0 -0.0 48.0 20.8 84.0Z M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 96.0 20.8 60.0 62.4 60.0Z M20.8 84.0 41.6 48.0 62.4 84.0Z' },
    hikari: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 36.0L20.8 60.0 M20.8 36.0L0.0 48.0 M20.8 36.0L0.0 24.0 M20.8 36.0L20.8 12.0 M20.8 36.0L41.6 24.0 M20.8 36.0L41.6 48.0 M20.8 36.0L10.4 54.0 M20.8 36.0L0.0 36.0 M20.8 36.0L10.4 18.0 M20.8 36.0L31.2 18.0 M20.8 36.0L41.6 36.0 M20.8 36.0L31.2 54.0 M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 12.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L-0.0 -24.0 M0.0 0.0L20.8 -12.0 M0.0 0.0L20.8 12.0 M0.0 0.0L-10.4 18.0 M0.0 0.0L-20.8 -0.0 M0.0 0.0L-10.4 -18.0 M0.0 0.0L10.4 -18.0 M0.0 0.0L20.8 -0.0 M0.0 0.0L10.4 18.0 M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 12.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L41.6 -24.0 M41.6 0.0L62.4 -12.0 M41.6 0.0L62.4 12.0 M41.6 0.0L31.2 18.0 M41.6 0.0L20.8 -0.0 M41.6 0.0L31.2 -18.0 M41.6 0.0L52.0 -18.0 M41.6 0.0L62.4 -0.0 M41.6 0.0L52.0 18.0 M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 84.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L-0.0 48.0 M0.0 72.0L20.8 60.0 M0.0 72.0L20.8 84.0 M0.0 72.0L-10.4 90.0 M0.0 72.0L-20.8 72.0 M0.0 72.0L-10.4 54.0 M0.0 72.0L10.4 54.0 M0.0 72.0L20.8 72.0 M0.0 72.0L10.4 90.0 M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 84.0 M41.6 72.0L20.8 60.0 M41.6 72.0L41.6 48.0 M41.6 72.0L62.4 60.0 M41.6 72.0L62.4 84.0 M41.6 72.0L31.2 90.0 M41.6 72.0L20.8 72.0 M41.6 72.0L31.2 54.0 M41.6 72.0L52.0 54.0 M41.6 72.0L62.4 72.0 M41.6 72.0L52.0 90.0' },
    rindo: { w: 41.6, h: 72.0, d: 'M20.8 60.0 0.0 48.0 0.0 24.0 20.8 12.0 41.6 24.0 41.6 48.0Z M20.8 36.0L20.8 60.0 M20.8 36.0L0.0 48.0 M20.8 36.0L0.0 24.0 M20.8 36.0L20.8 12.0 M20.8 36.0L41.6 24.0 M20.8 36.0L41.6 48.0 M10.4 54.0 20.8 48.0 10.4 42.0Z M0.0 36.0 10.4 42.0 10.4 30.0Z M10.4 18.0 10.4 30.0 20.8 24.0Z M31.2 18.0 20.8 24.0 31.2 30.0Z M41.6 36.0 31.2 30.0 31.2 42.0Z M31.2 54.0 31.2 42.0 20.8 48.0Z M0.0 24.0 -20.8 12.0 -20.8 -12.0 -0.0 -24.0 20.8 -12.0 20.8 12.0Z M0.0 0.0L0.0 24.0 M0.0 0.0L-20.8 12.0 M0.0 0.0L-20.8 -12.0 M0.0 0.0L-0.0 -24.0 M0.0 0.0L20.8 -12.0 M0.0 0.0L20.8 12.0 M-10.4 18.0 0.0 12.0 -10.4 6.0Z M-20.8 -0.0 -10.4 6.0 -10.4 -6.0Z M-10.4 -18.0 -10.4 -6.0 -0.0 -12.0Z M10.4 -18.0 -0.0 -12.0 10.4 -6.0Z M20.8 -0.0 10.4 -6.0 10.4 6.0Z M10.4 18.0 10.4 6.0 0.0 12.0Z M41.6 24.0 20.8 12.0 20.8 -12.0 41.6 -24.0 62.4 -12.0 62.4 12.0Z M41.6 0.0L41.6 24.0 M41.6 0.0L20.8 12.0 M41.6 0.0L20.8 -12.0 M41.6 0.0L41.6 -24.0 M41.6 0.0L62.4 -12.0 M41.6 0.0L62.4 12.0 M31.2 18.0 41.6 12.0 31.2 6.0Z M20.8 -0.0 31.2 6.0 31.2 -6.0Z M31.2 -18.0 31.2 -6.0 41.6 -12.0Z M52.0 -18.0 41.6 -12.0 52.0 -6.0Z M62.4 -0.0 52.0 -6.0 52.0 6.0Z M52.0 18.0 52.0 6.0 41.6 12.0Z M0.0 96.0 -20.8 84.0 -20.8 60.0 -0.0 48.0 20.8 60.0 20.8 84.0Z M0.0 72.0L0.0 96.0 M0.0 72.0L-20.8 84.0 M0.0 72.0L-20.8 60.0 M0.0 72.0L-0.0 48.0 M0.0 72.0L20.8 60.0 M0.0 72.0L20.8 84.0 M-10.4 90.0 0.0 84.0 -10.4 78.0Z M-20.8 72.0 -10.4 78.0 -10.4 66.0Z M-10.4 54.0 -10.4 66.0 -0.0 60.0Z M10.4 54.0 -0.0 60.0 10.4 66.0Z M20.8 72.0 10.4 66.0 10.4 78.0Z M10.4 90.0 10.4 78.0 0.0 84.0Z M41.6 96.0 20.8 84.0 20.8 60.0 41.6 48.0 62.4 60.0 62.4 84.0Z M41.6 72.0L41.6 96.0 M41.6 72.0L20.8 84.0 M41.6 72.0L20.8 60.0 M41.6 72.0L41.6 48.0 M41.6 72.0L62.4 60.0 M41.6 72.0L62.4 84.0 M31.2 90.0 41.6 84.0 31.2 78.0Z M20.8 72.0 31.2 78.0 31.2 66.0Z M31.2 54.0 31.2 66.0 41.6 60.0Z M52.0 54.0 41.6 60.0 52.0 66.0Z M62.4 72.0 52.0 66.0 52.0 78.0Z M52.0 90.0 52.0 78.0 41.6 84.0Z' },
    kakuasa: { w: 40, h: 40, d: 'M0 0H40V40H0Z M0 0L40 40 M40 0L0 40 M20 0V40 M0 20H40' },
    sanjubishi: { w: 30, h: 52, d: 'M15.0 0.0L30.0 26.0L15.0 52.0L0.0 26.0Z M15.0 9.9L24.3 26.0L15.0 42.1L5.7 26.0Z M15.0 18.2L19.5 26.0L15.0 33.8L10.5 26.0Z M0 -26.0L15.0 0L0 26.0L-15.0 0Z M0 -16.1L9.3 0L0 16.1L-9.3 0Z M0 -7.8L4.5 0L0 7.8L-4.5 0Z M30 -26.0L45.0 0L30 26.0L15.0 0Z M30 -16.1L39.3 0L30 16.1L20.7 0Z M30 -7.8L34.5 0L30 7.8L25.5 0Z M0 26.0L15.0 52L0 78.0L-15.0 52Z M0 35.9L9.3 52L0 68.1L-9.3 52Z M0 44.2L4.5 52L0 59.8L-4.5 52Z M30 26.0L45.0 52L30 78.0L15.0 52Z M30 35.9L39.3 52L30 68.1L20.7 52Z M30 44.2L34.5 52L30 59.8L25.5 52Z' },
    tsumiishi: { w: 36, h: 24, d: 'M0 0H36 M0 12H36 M0 24H36 M9 0V12 M27 0V12 M0 12V24 M18 12V24 M36 12V24 M0 0V12 M18 0V12' },
    hanabishi: { w: 34, h: 58, d: 'M17.0 0.0L34.0 29.0L17.0 58.0L0.0 29.0Z M0 -29.0L17.0 0L0 29.0L-17.0 0Z M34 -29.0L51.0 0L34 29.0L17.0 0Z M0 29.0L17.0 58L0 87.0L-17.0 58Z M34 29.0L51.0 58L34 87.0L17.0 58Z M17.0 27.5C15.1 26.5 14.1 24.4 14.1 22.1C14.1 20.0 15.1 18.8 16.1 19.4L17.0 20.4L17.9 19.4C18.9 18.8 19.9 20.0 19.9 22.1C19.9 24.4 18.9 26.5 17.0 27.5Z M18.4 28.5C18.8 26.4 20.5 24.8 22.7 24.1C24.7 23.4 26.1 24.1 25.8 25.2L25.2 26.3L26.4 26.9C27.3 27.7 26.5 29.0 24.5 29.7C22.3 30.4 20.0 30.0 18.4 28.5Z M17.9 30.2C20.0 29.9 22.1 31.0 23.5 32.9C24.7 34.6 24.5 36.1 23.4 36.2L22.1 36.0L21.9 37.3C21.4 38.3 19.9 38.0 18.7 36.3C17.3 34.5 17.0 32.1 17.9 30.2Z M16.1 30.2C17.0 32.1 16.7 34.5 15.3 36.3C14.1 38.0 12.6 38.3 12.1 37.3L11.9 36.0L10.6 36.2C9.5 36.1 9.3 34.6 10.5 32.9C11.9 31.0 14.0 29.9 16.1 30.2Z M15.6 28.5C14.0 30.0 11.7 30.4 9.5 29.7C7.5 29.0 6.7 27.7 7.6 26.9L8.8 26.3L8.2 25.2C7.9 24.1 9.3 23.4 11.3 24.1C13.5 24.8 15.2 26.4 15.6 28.5Z' },
    mitsukude: { w: 24, h: 41.6, d: 'M0 0H24 M0 20.8H24 M0 0L24 41.6 M24 0L0 41.6' },
    mikado: { w: 40, h: 40, d: 'M0 0H30V10H0Z M30 0H40V30H30Z M10 30H40V40H10Z M0 10H10V40H0Z M10 10H30V30H10Z M15 15H25V25H15Z' },
    shokko8: { w: 44, h: 44, d: 'M41.4 30.0 30.0 41.4 14.0 41.4 2.6 30.0 2.6 14.0 14.0 2.6 30.0 2.6 41.4 14.0Z M32.7 26.4 26.4 32.7 17.6 32.7 11.3 26.4 11.3 17.6 17.6 11.3 26.4 11.3 32.7 17.6Z M22.0 16.8L27.2 22.0L22.0 27.2L16.8 22.0Z M-2.6 -2.6H2.6V2.6H-2.6Z M41.4 -2.6H46.6V2.6H41.4Z M-2.6 41.4H2.6V46.6H-2.6Z M41.4 41.4H46.6V46.6H41.4Z' },
    fundo: { w: 36, h: 36, d: 'M18.0 0.0Q20.5 15.5 36.0 18.0Q20.5 20.5 18.0 36.0Q15.5 20.5 0.0 18.0Q15.5 15.5 18.0 0.0Z M18.0 6.8Q19.6 16.4 29.2 18.0Q19.6 19.6 18.0 29.2Q16.4 19.6 6.8 18.0Q16.4 16.4 18.0 6.8Z M18.0 12.6Q18.8 17.2 23.4 18.0Q18.8 18.8 18.0 23.4Q17.2 18.8 12.6 18.0Q17.2 17.2 18.0 12.6Z' },
    senbon: { w: 18, h: 54, d: 'M5 0V54 M13 0V54 M0 18H18 M0 22H18 M0 45H18 M0 49H18' },
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
    kumiko:  { label: '組子 คุมิโกะ', en: '組子 Kumiko', accent: '#bd5540', pattern: 'sakuragoshi',
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

  var DEFAULT = { preset: 'kumiko', pattern: 'sakuragoshi', intensity: 'faint', radius: 'shoji' };

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
