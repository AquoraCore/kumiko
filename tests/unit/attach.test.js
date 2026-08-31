import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AI = require('../../core/ai.js');
const fs = require('fs'), path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

describe('image attach — capability table + request builder', () => {
  it('vision flags: all Claude models see; only GLM V models see; visionModelFor picks the switch target', () => {
    expect(AI.modelSupportsVision('anthropic', 'claude-opus-4-8')).toBe(true);
    expect(AI.modelSupportsVision('zai-coding', 'glm-5.2')).toBe(false);
    expect(AI.modelSupportsVision('zai-coding', 'glm-4.6v')).toBe(true);
    expect(AI.visionModelFor('zai-coding', 'glm-5.2')).toBe('glm-4.6v');
    expect(AI.visionModelFor('zai', 'glm-4.7')).toBe('glm-4.6v');
    expect(AI.visionModelFor('anthropic', 'claude-sonnet-5')).toBe('claude-sonnet-5');
  });
  it('buildApiRequest maps data URIs to each provider content shape; text-only calls unchanged; caps at 4', () => {
    const img = 'data:image/png;base64,QUJD';
    const a = AI.buildApiRequest('anthropic', 'claude-sonnet-5', 'q', 'k', { images: [img] }).body.messages[0].content;
    expect(a[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    expect(a[1]).toEqual({ type: 'text', text: 'q' });
    const z = AI.buildApiRequest('zai-coding', 'glm-4.6v', 'q', 'k', { images: [img] }).body.messages[0].content;
    expect(z[0]).toEqual({ type: 'image_url', image_url: { url: img } });
    expect(AI.buildApiRequest('zai', 'glm-5.2', 'q', 'k', {}).body.messages[0].content).toBe('q');
    const five = AI.buildApiRequest('zai', 'glm-4.6v', 'q', 'k', { images: [img, img, img, img, img] }).body.messages[0].content;
    expect(five.length).toBe(5);   // 4 images + 1 text
    expect(AI.buildApiRequest('zai', 'glm-4.6v', 'q', 'k', { images: ['http://not-data'] }).body.messages[0].content).toBe('q');
  });
});

describe('image attach — wiring', () => {
  it('main: engine:run takes images, auto-switches to the vision model, CLI gets temp files, vision-model event emitted', () => {
    const m = read('main.js');
    expect(m).toMatch(/engine:run', \(e, \{ engine, model, prompt, runId, images \}\)/);
    expect(m).toMatch(/if \(vm && modelSupportsVision\(aicfg\.provider, vm\)\) \{ apiModel = vm; usedVision = true; \}/);
    expect(m).toMatch(/_imagesToTempFiles\(images\)/);
    expect(m).toMatch(/kind: 'vision-model'/);
    expect(m).toMatch(/ภาพถูกตัดออก/);   // no silent drop when vision is impossible
  });
  it('renderer: attach UI exists in BOTH shells, sendChat passes images, bubbles keep thumbs, READ-NOTE collects images', () => {
    for (const f of ['renderer/index.html', 'web/index.html']) {
      const h = read(f);
      expect(h).toMatch(/id="attachBar"/); expect(h).toMatch(/id="chatAttach"/); expect(h).toMatch(/attach\.js/);
    }
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/runId: s\.id, images: images\.map\(\(im\) => im\.uri\)/);
    expect(r).toMatch(/window\.__toolImages = window\.__toolImages \|\| \[\]\)\.length < 4/);
    const c = read('renderer/chat.js');
    expect(c).toMatch(/um\.thumbs = images\.map\(\(im\) => im\.thumb\)/);
    expect(c).toMatch(/thumbs: m\.thumbs/);   // previews persist
    expect(c).toMatch(/kind === 'vision-model'/);
    expect(c).toMatch(/images: toolImgs/);
    const at = read('renderer/attach.js');
    expect(at).toMatch(/function normalizeImageUri/);
    expect(at).toMatch(/__chatImages\.length >= 4/);
    expect(at).toMatch(/addEventListener\('paste'/);
  });
  it('settings: vision model select (hidden when every model sees), auto-switch + READ-NOTE toggles persisted', () => {
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/every\(\(m\) => m\.vision\)/);
    expect(r).toMatch(/visionModel: \(vRow\.style\.display==='none' \? '' : vSel\.value\), autoVision: avChk\.checked, readNoteImages: rnChk\.checked/);
    expect(read('main.js')).toMatch(/if \('visionModel' in patch\) cfg\.visionModel = patch\.visionModel;/);
  });
  it('web path: images ride /ai/chat and the server auto-switches too', () => {
    expect(read('web/api-web.js')).toMatch(/if \(imgs\.length\) body\.images = imgs;/);
    expect(read('server/index.js')).toMatch(/aiCore\.visionModelFor\(provider, mdl\)/);
  });
});

describe('sticky chat scroll (streaming must not fight the reader)', () => {
  it('chatScroll only follows when stuck; scroll-up unsticks; send/switch/rerender restick or preserve', () => {
    const c = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/chat.js'), 'utf8');
    expect(c).toMatch(/if \(!force && !window\.__chatStick\) return;/);
    expect(c).toMatch(/window\.__chatStick = \(m\.scrollHeight - m\.scrollTop - m\.clientHeight\) < 60;/);
    expect(c).toMatch(/function beginAiTurn\(userText, sources, images\)\{\n  window\.__chatStick = true;/);
    expect(c).toMatch(/const keep = window\.__chatStick \? null : box\.scrollTop;/);
    expect(c).toMatch(/if \(keep != null\) box\.scrollTop = keep; else chatScroll\(true\);/);
  });
});

describe('streaming note-block UX + partial salvage (log 2026-08-24 #3)', () => {
  it('an OPEN block collapses to a live progress line; closed blocks untouched; failed stream salvages the draft', () => {
    const c = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/chat.js'), 'utf8');
    expect(c).toMatch(/function _openBlockProgress\(s\)/);
    expect(c).toMatch(/if \(\/===END-NOTE===\/\.test\(after\)\) return null;/);
    expect(c).toMatch(/const ob = _openBlockProgress\(s\);\n    if \(ob\) return chatDisplayText\(ob\.before, false\) \+ ob\.line;/);
    expect(c).toMatch(/await salvagePartialNoteBlock\(last\.text\)/);
    const r = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(r).toMatch(/async function salvagePartialNoteBlock\(text\)/);
    expect(r).toMatch(/\(ร่างไม่จบ\)/);
    expect(r).toMatch(/if \(body\.length < 200\) return;/);
  });
});

describe('kazaguruma spinner replaces the typing dots', () => {
  const fs = require('fs'), path = require('path');
  it('waiting state is the frameless pinwheel (built once — no per-token animation restart)', () => {
    const chat = fs.readFileSync(path.join(__dirname, '../../renderer/chat.js'), 'utf8');
    expect(chat).toMatch(/function buildWaitInto\(el, m\)/);
    expect(chat).toMatch(/if \(!el\.querySelector\('\.wait-spin'\)\)/);   // spinner node persists across tokens
    expect(chat).not.toMatch(/think-ghost/);   // design A: no ghost reasoning text while waiting
    expect(chat).not.toMatch(/<i><\/i><i><\/i><i><\/i>/);
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8')).toMatch(/chat-typing"><i class="spin-kaza">/);
    const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/\.spin-kaza \{ display: inline-block;[^}]*mask: url\(logo-mask\.png\)/);
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.spin-kaza \{ animation: none; \} \}/);
  });
});

describe('frameless wait (design B) CSS', () => {
  it('m-wait strips the bubble box; ghost text and 34px spinner styled', () => {
    const css = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/styles.css'), 'utf8');
    expect(css).toMatch(/\.m\.ai\.m-wait \{ background: transparent !important; border: none !important; box-shadow: none !important/);
    expect(css).toMatch(/\.think-ghost \{ margin: 8px 0 0 3px; color: var\(--muted\)/);
    expect(css).toMatch(/\.spin-kaza\.lg \{ width: 34px; height: 34px/);
  });
});
