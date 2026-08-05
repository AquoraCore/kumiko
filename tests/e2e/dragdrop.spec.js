const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createFolder } = require('./helpers');

// Unified pointer-events drag-and-drop (renderer/dragdrop.js). Playwright's
// page.mouse dispatches real pointer events, so this exercises the same
// pointerdown -> pointermove (past threshold) -> pointerup path a user does.
test.describe('pointer drag-and-drop (mouse)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp({ notes: [{ name: 'Movable.md', content: '# m' }] }); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: drag a note onto a folder moves it in', async () => {
    const { page } = ctx;
    await createFolder(page, 'Bin');

    const note = page.locator('.note-item[data-drag-rel="Movable.md"]');
    const folder = page.locator('.folder-row[data-drop-path="Bin"]');
    await expect(note).toBeVisible();
    await expect(folder).toBeVisible();

    const nb = await note.boundingBox();
    const fb = await folder.boundingBox();
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
    await page.mouse.down();
    await page.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2 + 8);   // cross the 6px threshold
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 6 });
    await page.mouse.up();

    // the note now lives at Bin/Movable.md
    await expect(page.locator('.note-item[data-drag-rel="Bin/Movable.md"]')).toHaveCount(1);
  });
});
