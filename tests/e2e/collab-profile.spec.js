const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');
const { startRelay } = require('../../server/relay');

// Phase 7, step 7b-1: a LOCAL user profile (name + color) for collab identity.
// The user picks a display name + color in AI Settings; that identity replaces
// the old ephemeral/random pick so peers see a real name on presence avatars.
// No external auth — name/color live in localStorage (collabName / collabColor).
// The HAPPY test drives two instances through one relay + shared vault; the EDGE
// test just checks the field re-reads on modal reopen. Default collab-off
// behavior is untouched (these specs all opt in explicitly).

async function openAiPanel(page) {
  await page.locator('#settingsBtn2').click();
  await page.locator('#aiSettingsMenuItem').click();
  await expect(page.locator('#aiSettingsModal')).toBeVisible();
}

test.describe('collab profile (step 7b-1)', () => {
  let relay, A, B;
  test.afterEach(async () => {
    if (B) await teardown(B);
    if (A) await teardown(A);
    if (relay) { try { await relay.close(); } catch (_) {} }
  });

  test('the profile name persists and appears to a peer', async () => {
    relay = await startRelay({ port: 0 });
    const url = 'ws://127.0.0.1:' + relay.port;

    // Instance A — collab on, points at the relay, seeds an empty shared note.
    A = await launchApp({ collab: true, collabRelay: url, notes: [{ name: 'shared.md', content: '' }] });

    // Set A's profile BEFORE opening the note: collabIdentity() reads collabName
    // when loadEditor wires awareness, so the saved name is what peers receive.
    await openAiPanel(A.page);
    await A.page.locator('#aiProfileName').fill('Alice');
    await A.page.locator('#aiProfileColors .profile-sw').nth(1).click();
    await A.page.locator('#aiSettingsSave').click();
    await expect(A.page.locator('#aiSettingsModal')).toHaveCount(0);

    // Open 'shared', focus the editor, and wait for the provider to connect.
    await A.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await A.page.locator('.ProseMirror').click();
    await A.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });

    // Instance B — same vault (notesDir reuse), collab on, same relay.
    B = await launchApp({ collab: true, collabRelay: url, notesDir: A.notesDir });
    await B.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await B.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });

    // B sees A's chosen name on a presence avatar (title === 'Alice').
    await expect.poll(
      async () => {
        const titles = await B.page.locator('#collabPresence .collab-av')
          .evaluateAll((els) => els.map((e) => e.getAttribute('title')));
        return titles.includes('Alice');
      },
      { timeout: 20000, intervals: [200, 500, 1000] }
    ).toBe(true);
  }, 40000);

  test('the profile persists across reopening settings', async () => {
    A = await launchApp({});

    await openAiPanel(A.page);
    await A.page.locator('#aiProfileName').fill('Bob');
    await A.page.locator('#aiProfileColors .profile-sw').nth(2).click();
    await A.page.locator('#aiSettingsSave').click();
    await expect(A.page.locator('#aiSettingsModal')).toHaveCount(0);

    // Reopen — the name was persisted to localStorage and re-read on rebuild.
    await openAiPanel(A.page);
    await expect(A.page.locator('#aiProfileName')).toHaveValue('Bob');
  }, 20000);
});
