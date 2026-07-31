const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// Per-vault collab opt-in (step 6c-4). The toggle + relay field live in the AI
// Settings modal below the semantic toggle, default OFF, and only flip the
// per-vault state.collab flag / app-wide collabRelay in localStorage. No relay
// or Y.Doc is needed: this only exercises the modal UI + persistence. Open the
// AI Settings modal the same way rag-settings/semantic-settings specs do.
async function openAiPanel(page) {
  await page.locator('#settingsBtn2').click();
  await page.locator('#aiSettingsMenuItem').click();
  await expect(page.locator('#aiSettingsModal')).toBeVisible();
}

test.describe('collab settings (step 6c-4)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: the collab toggle persists per vault', async () => {
    const { page } = ctx;

    // default OFF → toggle exists and is unchecked; relay shows the default.
    await openAiPanel(page);
    await expect(page.locator('#aiCollabToggle')).toBeVisible();
    await expect(page.locator('#aiCollabToggle')).not.toBeChecked();
    await expect(page.locator('#aiCollabRelay')).toHaveValue('ws://127.0.0.1:1234');

    // opt in + set a custom relay, then save (vsSet persists state.collab = true,
    // localStorage keeps the relay URL).
    await page.locator('#aiCollabToggle').check();
    await page.locator('#aiCollabRelay').fill('ws://127.0.0.1:9999');
    await page.locator('#aiSettingsSave').click();
    await expect(page.locator('#aiSettingsModal')).toHaveCount(0);

    // reopen the same test-vault session → the flag was persisted (vsSet) and
    // re-read (vsGet) on rebuild: toggle now checked, relay URL retained.
    await openAiPanel(page);
    await expect(page.locator('#aiCollabToggle')).toBeChecked();
    await expect(page.locator('#aiCollabRelay')).toHaveValue('ws://127.0.0.1:9999');
  });

  test('EDGE: collab defaults off', async () => {
    const { page } = ctx;

    // a fresh temp vault has collab off → toggle unchecked, and the collab
    // presence bar stays hidden because collabProvider is never started.
    await openAiPanel(page);
    await expect(page.locator('#aiCollabToggle')).not.toBeChecked();
    await expect(page.locator('#collabBar')).toBeHidden();
  });
});
