const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createNote, deleteNote } = require('./helpers');

test.describe('note lifecycle', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: new note appears in sidebar + opens; typing then save shows saved', async () => {
    const { page } = ctx;
    await createNote(page, 'First Note');
    await expect(page.locator('#noteTitle')).toContainText('First Note');

    // type into the Crepe/ProseMirror body, then save → savedTag loses .unsaved
    const editor = page.locator('#editorHost .ProseMirror');
    await editor.click();
    await page.keyboard.type('hello body text');
    await expect(page.locator('#savedTag')).toHaveClass(/unsaved/);
    await page.locator('#saveBtn').click();
    await expect(page.locator('#savedTag')).not.toHaveClass(/unsaved/);
  });

  test('EDGE: duplicate name is rejected (no overwrite); delete removes the note', async () => {
    const { page } = ctx;
    await createNote(page, 'Dup');
    await expect(page.locator('#noteList .note-item', { hasText: 'Dup' })).toHaveCount(1);

    // create the same name again → app rejects via alert() (auto-dismissed);
    // still exactly one entry (no crash, no silent overwrite)
    await createNote(page, 'Dup');
    await expect(page.locator('#noteList .note-item', { hasText: 'Dup' })).toHaveCount(1);

    // delete via right-click context menu → it disappears from the sidebar
    await deleteNote(page, 'Dup');
    await expect(page.locator('#noteList .note-item', { hasText: 'Dup' })).toHaveCount(0);
  });
});
