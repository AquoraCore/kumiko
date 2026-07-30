const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createNote, deleteNote, openTrash } = require('./helpers');

test.describe('trash', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: delete a note → trash lists it → restore returns it to the sidebar', async () => {
    const { page } = ctx;
    await createNote(page, 't1');
    await deleteNote(page, 't1');

    await openTrash(page);
    const row = page.locator('#trashView .trash-row', { hasText: 't1' });
    await expect(row).toBeVisible();

    // restore → note returns to the sidebar
    await row.locator('.trash-restore').click();
    await expect(page.locator('#noteList .note-item', { hasText: 't1' })).toBeVisible();
  });

  test('EDGE: delete two notes, restore only one → exactly one returns, the other stays in Trash', async () => {
    const { page } = ctx;
    // distinct multi-char names: short names ('a'/'b') collide with random
    // temp-dir path text in the trash row.
    await createNote(page, 'trash-alpha');
    await createNote(page, 'trash-beta');
    await deleteNote(page, 'trash-alpha');
    await deleteNote(page, 'trash-beta');

    await openTrash(page);

    // restore ONLY trash-alpha via the restore button scoped to its row
    await page.locator('.trash-row', { hasText: 'trash-alpha' }).locator('.trash-restore').click();
    await expect(page.locator('#noteList .note-item', { hasText: 'trash-alpha' })).toBeVisible();
    // Restoring navigates the main view away from Trash, so #trashView is now
    // hidden — re-open the trash view before asserting the remaining row.
    await openTrash(page);
    await expect(page.locator('#trashView .trash-row', { hasText: 'trash-beta' })).toBeVisible();
    await expect(page.locator('#trashView .trash-row')).toHaveCount(1);
  });
});
