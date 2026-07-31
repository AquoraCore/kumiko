const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// Per-vault semantic-search opt-in (step 5d-3). The toggle lives directly below
// the ambient-RAG toggle in the AI Settings modal, defaults OFF, and only flips
// the per-vault state.ragSemantic flag — the main-side pipeline gates on it. No
// engine/embed stub is needed: this only exercises the modal UI + persistence.
// Open the AI Settings modal the same way ai-settings.spec.js does.
async function openAiPanel(page) {
  await page.locator('#settingsBtn2').click();
  await page.locator('#aiSettingsMenuItem').click();
  await expect(page.locator('#aiSettingsModal')).toBeVisible();
}

test.describe('semantic search settings (step 5d-3)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: the semantic toggle persists per vault', async () => {
    const { page } = ctx;

    // default OFF → toggle exists and is unchecked.
    await openAiPanel(page);
    await expect(page.locator('#aiSemanticToggle')).toBeVisible();
    await expect(page.locator('#aiSemanticToggle')).not.toBeChecked();

    // opt in + save (vsSet persists state.ragSemantic = true).
    await page.locator('#aiSemanticToggle').check();
    await page.locator('#aiSettingsSave').click();
    await expect(page.locator('#aiSettingsModal')).toHaveCount(0);

    // reopen the same test-vault session → the flag was persisted (vsSet) and
    // re-read (vsGet) on rebuild: toggle now checked.
    await openAiPanel(page);
    await expect(page.locator('#aiSemanticToggle')).toBeChecked();
  });

  test('EDGE: turning semantic on with no Z.ai key shows the warning', async () => {
    const { page } = ctx;

    // a fresh temp vault has no saved key → cfg.hasKey.zai is false.
    await openAiPanel(page);

    // warning hidden while the toggle is off.
    await expect(page.locator('#aiSemanticWarn')).toBeHidden();

    // checking the toggle (onchange) surfaces the inline warning — no save needed.
    await page.locator('#aiSemanticToggle').check();
    await expect(page.locator('#aiSemanticWarn')).toBeVisible();
  });
});
