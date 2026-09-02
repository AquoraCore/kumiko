import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

// User-stopped AI replies (2026-08-29). Pressing stop used to render the engine-failure
// warning ("⚠ engine ไม่ตอบกลับ (คำตอบว่าง · exit 130) — ลองส่งข้อความเดิมอีกครั้ง") because
// SIGINT lands as exit 130 — but a deliberate stop is not an error. The renderer now records
// WHO stopped (s._stopReq at the stop button) and renders a calm "หยุดแล้ว" state instead.
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');
const chat = read('renderer/chat.js');
const renderer = read('renderer/renderer.js');
const css = read('renderer/styles.css');
const i18n = read('renderer/i18n.js');

describe('stop is remembered and classified', () => {
  it('the stop button stamps s._stopReq BEFORE aborting the engine', () => {
    expect(renderer).toMatch(/s\._stopReq = Date\.now\(\); window\.api\.stopEngine\(s\.id\)/);
  });
  it('onEngineDone: 130 + _stopReq → stopped (partial text kept, no ⚠); 130 alone stays a failure (timeout)', () => {
    const fn = chat.match(/onEngineDone[\s\S]{0,1600}/)[0];
    expect(fn).toMatch(/payload\.code === 130 && s\._stopReq/);
    expect(fn).toMatch(/if \(stopped\) \{ last\.stopped = true; last\.text = shown; last\._justStopped = true; \}/);
    // the loud warning is the else-branch, so a stop never shows it
    expect(fn).toMatch(/else last\.text = shown \|\| t\('⚠/);
  });
  it('a stopped reply is inert: no verb execution, no tool continuation restarting the engine', () => {
    expect(chat).toMatch(/!\(last && last\.stopped\)[\s\S]{0,120}extractActions/);
  });
});

describe('calm rendering — kazaguruma-at-rest (user-picked design A+B, on a stick)', () => {
  it('renderChat: stick-mounted pinwheel marker; empty stop = whisper bubble with the BIG head', () => {
    expect(chat).toContain("if (emptyStop) b.classList.add('m-stop-empty')");
    expect(chat).toMatch(/kaza-stick' \+ \(emptyStop \? ' lg' : ' sm'\)/);
    expect(chat).toMatch(/spin-kaza kaza-stopped' \+ \(emptyStop \? ' lg' : ' sm'\)/);
    expect(chat).toMatch(/emptyStop \? 'หยุดการตอบแล้ว' : 'หยุดโดยคุณ — ตอบไม่จบ'/);
    // the "ลมหยุด" deceleration plays exactly once: flag consumed on first render
    expect(chat).toMatch(/kaza-stopping'\); delete m\._justStopped/);
  });
  it('styles: frozen muted head + stick pseudo-element + one-shot decel (accent → muted)', () => {
    expect(css).toMatch(/\.m-stop \.spin-kaza\.kaza-stopped \{[^}]*animation: none[^}]*var\(--muted\)/);
    expect(css).toMatch(/\.kaza-stick::after \{[^}]*var\(--muted\)/);
    expect(css).toMatch(/@keyframes kaza-decel[\s\S]{0,220}rotate\(160deg\)/);
    expect(css).toMatch(/prefers-reduced-motion[\s\S]{0,120}kaza-stopping \{ animation: none/);
    expect(css).toMatch(/\.m\.ai\.m-stop-empty \{[^}]*dashed/);
  });
  it('both marker strings have EN translations', () => {
    expect(i18n).toContain("'หยุดการตอบแล้ว': 'Response stopped'");
    expect(i18n).toContain("'หยุดโดยคุณ — ตอบไม่จบ': 'Stopped by you — reply unfinished'");
  });
});
