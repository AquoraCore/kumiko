const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { launchApp, teardown } = require('./helpers');
const crdt = require('../../core/crdt');

// Phase 6, step 6b: CRDT persistence substrate (main-side). The running app
// does NOT call crdt:load / crdt:save yet; these tests drive the IPC directly
// through the renderer to prove the disk + IPC round-trip works end to end.
test.describe('crdt persistence', () => {
  let ctx;
  test.beforeEach(async () => {
    ctx = await launchApp({ notes: [{ name: 'note1.md', content: 'hello' }] });
  });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: a CRDT blob round-trips through disk + IPC and decodes correctly', async () => {
    const { page, notesDir } = ctx;
    const doc = crdt.newDoc('collab hello');
    const bytes = crdt.encodeState(doc);   // Uint8Array

    await page.evaluate((arr) => window.api.crdtSave('note1.md', new Uint8Array(arr)), Array.from(bytes));

    const back = await page.evaluate(() => window.api.crdtLoad('note1.md').then(u => u ? Array.from(u) : null));
    expect(Array.isArray(back) && back.length > 0).toBe(true);

    const d2 = crdt.fromUpdate(new Uint8Array(back));
    expect(crdt.getText(d2)).toBe('collab hello');

    expect(fs.existsSync(path.join(notesDir, '.washi', 'crdt', 'note1.md.ydoc'))).toBe(true);
  });

  test('EDGE: loading a note with no CRDT sidecar returns null', async () => {
    const { page } = ctx;
    const back = await page.evaluate(() => window.api.crdtLoad('doesnotexist.md'));
    expect(back).toBeNull();
  });
});
