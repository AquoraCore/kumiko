import { describe, it, expect } from 'vitest';

// Real unit tests arrive in Phase 2 once pure logic is extracted into core/ and
// becomes importable (renderer.js / main.js are not modules yet). For now this
// only proves the vitest runner is wired and green.

function add(a, b) { return a + b; }

describe('vitest smoke', () => {
  it('adds two numbers (happy)', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('handles zero and negatives (edge)', () => {
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});

// 2026-09-03: git-based update notifier — the app is distributed as a clone, so "new version"
// = origin/main ahead of the local repo; every failure must degrade to {behind: 0} silence.
describe('update notifier wiring', () => {
  const fs9 = require('fs'); const path9 = require('path');
  const read9 = (p) => fs9.readFileSync(path9.join(__dirname, '../../', p), 'utf8');
  it('main: update:check walks up from app.asar to the repo, silent on any failure', () => {
    const m = read9('main.js');
    expect(m).toContain("ipcMain.handle('update:check'");
    expect(m).toMatch(/_repoRoot[\s\S]{0,300}\.git/);
    expect((m.match(/return \{ behind: 0 \}/g) || []).length).toBeGreaterThanOrEqual(3);
    expect(m).toMatch(/rev-list', '--count', 'HEAD\.\.origin\/main'/);
  });
  it('renderer: boot + 6h checks, one sticky toast per sha, copyable update command', () => {
    const r = read9('renderer/renderer.js');
    expect(r).toContain('async function checkForUpdate');
    expect(r).toMatch(/kumikoUpdateSeen/);
    expect(r).toMatch(/sticky: true, action: \{ label: t\('ดูรายละเอียด'\)/);
    expect(r).toContain('git pull && npm install --no-audit --no-fund && npm run dist');
    expect(r).toContain('6 * 3600 * 1000');
  });
  it('two-step self-update: background run streams stages, relaunch swaps binaries', () => {
    const m = read9('main.js');
    expect(m).toContain("ipcMain.handle('update:run'");
    expect(m).toMatch(/spawn\('\/bin\/bash', \['-lc'/);
    expect(m).toContain("send({ done: true, ok: ok && code === 0, log })");
    expect(m).toContain("ipcMain.handle('update:relaunch', () => { app.relaunch(); app.quit(); })");
    const r = read9('renderer/renderer.js');
    expect(r).toMatch(/อัปเดตเลย/);
    expect(r).toMatch(/onUpdateProgress\(\(m\) =>/);
    expect(r).toMatch(/sticky: true, action: \{ label: 'Relaunch', fn: \(\) => window\.api\.updateRelaunch\(\)/);
  });
  it('preload + web shim expose updateCheck (web = permanent {behind: 0})', () => {
    expect(read9('preload.js')).toContain("updateCheck: () => ipcRenderer.invoke('update:check')");
    expect(read9('web/api-web.js')).toMatch(/async function updateCheck\(\) \{ return \{ behind: 0 \}; \}/);
  });
});
