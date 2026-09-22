import { describe, it, expect } from 'vitest';
const fs = require('fs'); const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('web/renderer HTML parity — no dead terminal controls ship', () => {
  const web = read('web/index.html'); const desk = read('renderer/index.html');
  const DEAD = ['termPosBtn','claudeBtn','termStopBtn','termRestartBtn','clearBtn','termHideBtn','termToggle','id="terminal"'];
  it('web/index.html has NO dead terminal buttons or #terminal div', () => {
    for (const d of DEAD) expect(web).not.toContain(d);
  });
  it('renderer/index.html likewise has none', () => {
    for (const d of DEAD) expect(desk).not.toContain(d);
  });
  it('BOTH builds expose the working chat toggle (#aiPanelToggle in the editor bar)', () => {
    for (const html of [web, desk]) expect(html).toContain('id="aiPanelToggle"');
  });
});

describe('KUMIKO* root files hidden from lists — same rule on every surface', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  it('desktop walker (main.js walkNotes) uses the root-level KUMIKO prefix rule', () => {
    expect(read('main.js')).toContain("!(base === '' && ent.name.startsWith('KUMIKO'))");
  });
  it('cloud walker (server/notestore.js) uses the same rule', () => {
    expect(read('server/notestore.js')).toContain("!(base === '' && ent.name.startsWith('KUMIKO'))");
  });
  it('web client filter (web/api-web.js) hides root-level KUMIKO* notes too', () => {
    expect(read('web/api-web.js')).toContain("n.indexOf('/') !== -1 || n.indexOf('KUMIKO') !== 0");
  });
});
