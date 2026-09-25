import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

// CLI temp images must live INSIDE the vault (cwd of the spawned CLI) and be handed
// back as relative paths — non-interactive CLIs refuse to read outside cwd without
// a permission prompt (reproduced 2026-09-25, claude -p --permission-mode acceptEdits).
describe('CLI temp images — inside the vault, relative path', () => {
  it('_imagesToTempFiles writes to NOTES_DIR/.washi/tmp (recursive mkdir), no os.tmpdir()', () => {
    const m = read('main.js');
    const fn = m.slice(m.indexOf('function _imagesToTempFiles'), m.indexOf('function _imagesToTempFiles') + 1200);
    expect(fn).toContain('path.join(NOTES_DIR, \'.washi\', \'tmp\')');
    expect(fn).toContain('mkdirSync(dir, { recursive: true })');
    expect(fn).not.toContain('os.tmpdir()');
    expect(fn).toContain('kumiko-img-');   // filename unchanged
    expect(fn).toContain('path.relative(NOTES_DIR, f)');   // returns RELATIVE
  });
  it('sweeps kumiko-img-* files older than 1 hour on every call', () => {
    const fn = read('main.js').split('function _imagesToTempFiles')[1].split('\n}');
    const body = fn[0];
    expect(body).toContain('3600000');
    expect(body).toContain('startsWith(\'kumiko-img-\')');
    expect(body).toMatch(/unlinkSync\(fp\)/);
  });
  it('walker and watcher already hide .washi (dot-dirs skipped, non-.md ignored)', () => {
    const m = read('main.js');
    expect(m).toMatch(/ent\.name\.startsWith\('\.'\)/);                 // sidebar walker skips dot-dirs
    expect(m).toMatch(/rel\.startsWith\('\.washi\/'\)/);                // AI-edit watcher ignores .washi
  });
});
