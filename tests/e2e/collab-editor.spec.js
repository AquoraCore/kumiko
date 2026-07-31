const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createNote } = require('./helpers');

// Phase 6, step 6c-2: a Yjs Y.Doc is bound to the Crepe editor (collab flag ON,
// offline single-user). The collab-backed editor must load, show content, and
// round-trip edits through the normal save path exactly like the default editor.
test.describe('collab editor (Y.Doc-backed)', () => {
  let ctx;
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: with collab enabled, the editor loads and edits/persist normally (Y.Doc-backed)', async () => {
    ctx = await launchApp({ collab: true });
    const { page } = ctx;
    await createNote(page, 'Collab Note');

    // type into the ProseMirror surface, then save
    const editor = page.locator('#editorHost .ProseMirror');
    await editor.click();
    await page.keyboard.type('hello from collab');
    await page.locator('#saveBtn').click();

    // reopen the note (sidebar click → openNote re-reads from disk) and assert the
    // typed text persisted through the normal save path
    await page.locator('#noteList .note-item', { hasText: 'Collab Note' }).click();
    await expect(page.locator('#editorHost')).toContainText('hello from collab');
  });

  test('EDGE: collab-enabled editor still shows an opened note\'s existing content', async () => {
    // a note with pre-existing content (applyTemplate must seed the Y.Doc from it)
    ctx = await launchApp({ collab: true, notes: [{ name: 'seeded.md', content: 'seeded body content' }] });
    const { page } = ctx;
    await page.locator('#noteList .note-item', { hasText: 'seeded' }).click();
    await expect(page.locator('#editorHost')).toContainText('seeded body content');
  });
});
