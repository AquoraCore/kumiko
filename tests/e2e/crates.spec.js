const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createFolder, fillNameModal, ctxItem } = require('./helpers');

test.describe('crates (folders)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: create a box, add a note inside, open the box → crate card shows the note', async () => {
    const { page } = ctx;
    await createFolder(page, 'ชีวะ');

    // new note inside the box, via the box's right-click context menu
    await page.locator('.folder-row', { hasText: 'ชีวะ' }).click({ button: 'right' });
    await ctxItem(page, 'โน้ตใหม่ในกล่องนี้');
    await fillNameModal(page, 'Cell');

    // open the crate overview by clicking the box name
    await page.locator('.folder-row .folder-nm', { hasText: 'ชีวะ' }).click();
    await expect(page.locator('#crateView')).toBeVisible();
    await expect(page.locator('.crate-card', { hasText: 'Cell' })).toBeVisible();
  });

  test('EDGE: an empty box shows the empty-state ("กล่องนี้ว่าง") without error', async () => {
    const { page } = ctx;
    await createFolder(page, 'ว่าง');
    await page.locator('.folder-row .folder-nm', { hasText: 'ว่าง' }).click();
    await expect(page.locator('#crateView')).toBeVisible();
    await expect(page.locator('#crateView')).toContainText('กล่องนี้ว่าง');
  });
});
