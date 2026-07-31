const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');
const { startRelay } = require('../../server/relay');

// Phase 6, step 6c-3a: the definitive proof of collab — TWO app instances share ONE
// vault and one y-websocket relay; an edit typed in instance A appears in instance B.
// Still gated on collabEnabled() (default OFF); the relay is started ephemeral here so
// both apps point at the same ws port. If the relay were unreachable the editor would
// keep working offline (the provider just retries) — that path is covered by collab-editor.
test.describe('collab sync over the relay (two instances)', () => {
  let relay, A, B;
  test.afterEach(async () => {
    if (B) await teardown(B);
    if (A) await teardown(A);
    if (relay) { try { await relay.close(); } catch (_) {} }
  });

  test('an edit in instance A appears in instance B over the relay', async () => {
    relay = await startRelay({ port: 0 });
    const url = 'ws://127.0.0.1:' + relay.port;

    // One vault shared by both instances. 'shared.md' is pre-seeded (empty) so each app
    // lists it on launch: the file watcher only fires on 'change', not 'add', so a note
    // created in A after launch would not surface in B's sidebar without a reload.
    // Both apps point their WebsocketProvider at the same ephemeral relay.
    A = await launchApp({ collab: true, collabRelay: url, notes: [{ name: 'shared.md', content: '' }] });
    B = await launchApp({ collab: true, collabRelay: url, notesDir: A.notesDir });

    // A opens 'shared' and types — wait for its provider to connect to the relay first.
    await A.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await A.page.locator('#editorHost .ProseMirror').click();
    await A.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await A.page.keyboard.type('hello from A');

    // B opens the same note; its provider syncs A's edit over the relay.
    await B.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await B.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await expect.poll(
      async () => B.page.locator('#editorHost .ProseMirror').textContent(),
      { timeout: 15000, intervals: [200, 500, 1000] }
    ).toContain('hello from A');
  }, 40000);
});
