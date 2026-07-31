const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');
const { startRelay } = require('../../server/relay');

// Phase 6, step 6c-3b: the VISIBLE layer on top of real-time sync — a status
// pill + peer avatars in the editor header. Like collab-sync.spec.js, two
// instances share one vault and one relay. With collab OFF (default) the bar
// stays hidden so the 30 non-collab E2E are unaffected.
test.describe('collab presence bar', () => {
  let relay, A, B;
  test.afterEach(async () => {
    if (B) await teardown(B);
    if (A) await teardown(A);
    if (relay) { try { await relay.close(); } catch (_) {} }
  });

  test('collab bar shows a synced pill and a presence avatar for the peer', async () => {
    relay = await startRelay({ port: 0 });
    const url = 'ws://127.0.0.1:' + relay.port;

    A = await launchApp({ collab: true, collabRelay: url, notes: [{ name: 'shared.md', content: '' }] });
    B = await launchApp({ collab: true, collabRelay: url, notesDir: A.notesDir });

    // Open 'shared' in both and wait for each provider to connect.
    await A.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await A.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await B.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await B.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });

    // On A: the bar is visible, the pill eventually reads synced, and B's presence avatar appears.
    await expect(A.page.locator('#collabBar')).toBeVisible();
    await expect.poll(
      async () => A.page.locator('#collabStatus').getAttribute('class'),
      { timeout: 15000, intervals: [200, 500, 1000] }
    ).toContain('ok');
    await expect.poll(
      async () => A.page.locator('#collabPresence .collab-av').count(),
      { timeout: 15000, intervals: [200, 500, 1000] }
    ).toBeGreaterThanOrEqual(1);
  }, 40000);

  test('with collab OFF, the collab bar stays hidden', async () => {
    A = await launchApp({});
    await A.page.locator('#noteList .note-item').first().click();
    await expect(A.page.locator('#collabBar')).toBeHidden();
  }, 20000);
});
