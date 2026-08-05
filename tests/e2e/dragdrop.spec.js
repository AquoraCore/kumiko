const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createFolder } = require('./helpers');

// Unified pointer-events drag-and-drop (renderer/dragdrop.js). Playwright's
// page.mouse dispatches real pointer events, so this exercises the same
// pointerdown -> pointermove (past threshold) -> pointerup path a user does.
test.describe('pointer drag-and-drop (mouse)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp({ notes: [{ name: 'Movable.md', content: '# m' }, { name: 'Doc.pdf', content: '%PDF-1.4 fake' }] }); });
  test.afterEach(async () => { await teardown(ctx); });

  async function dragOnto(page, srcSel, folderPath) {
    const src = page.locator(srcSel);
    const folder = page.locator('.folder-row[data-drop-path="' + folderPath + '"]');
    await expect(src).toBeVisible();
    await expect(folder).toBeVisible();
    const sb = await src.boundingBox();
    const fb = await folder.boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2 + 8);   // cross the 6px threshold
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2, { steps: 6 });
    await page.mouse.up();
  }

  test('HAPPY: drag a note onto a folder moves it in', async () => {
    const { page } = ctx;
    await createFolder(page, 'Bin');
    await dragOnto(page, '.note-item[data-drag-rel="Movable.md"]', 'Bin');
    await expect(page.locator('.note-item[data-drag-rel="Bin/Movable.md"]')).toHaveCount(1);
  });

  test('HAPPY: drag a PDF onto a folder moves it in', async () => {
    const { page } = ctx;
    await createFolder(page, 'Bin');
    await dragOnto(page, '.pdf-item[data-drag-rel="Doc.pdf"]', 'Bin');
    await expect(page.locator('.pdf-item[data-drag-rel="Bin/Doc.pdf"]')).toHaveCount(1);
  });
});
