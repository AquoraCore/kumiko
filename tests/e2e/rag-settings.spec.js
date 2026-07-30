const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// Per-vault ambient-RAG on/off (step 5c-2). The toggle lives in the AI Settings
// modal, defaults ON, and when OFF sendChat skips retrieval entirely (no chip).
// Open the AI Settings modal the same way ai-settings.spec.js does.
async function openAiPanel(page) {
  await page.locator('#settingsBtn2').click();
  await page.locator('#aiSettingsMenuItem').click();
  await expect(page.locator('#aiSettingsModal')).toBeVisible();
}

test.describe('ambient RAG settings (stubbed engine + seeded note)', () => {
  let ctx;
  test.beforeEach(async () => {
    ctx = await launchApp({ stubEngine: true, notes: [
      { name: 'Nephron.md', content: 'The nephron filters blood in the kidney and forms urine.' },
    ] });
  });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: disabling ambient RAG stops the referenced-notes chip', async () => {
    const { page } = ctx;

    // 1. default ON → a matched send shows the chip (sanity).
    await page.locator('#chatInput').fill('explain the nephron');
    await page.locator('#chatSend').click();
    await expect(page.locator('.m.ai').last()).toContainText('Stubbed', { timeout: 5000 });
    await expect(page.locator('.rag-sources')).toBeVisible({ timeout: 5000 });

    // 2. open AI Settings, uncheck the per-vault ambient-RAG toggle, save.
    await openAiPanel(page);
    await expect(page.locator('#aiRagToggle')).toBeChecked();
    await page.locator('#aiRagToggle').uncheck();
    await page.locator('#aiSettingsSave').click();
    await expect(page.locator('#aiSettingsModal')).toHaveCount(0);

    // 3. same message again → chat still works (Stubbed streams on the NEW turn)
    //    but the new AI turn has NO referenced-notes chip. renderChat re-renders
    //    every message, so the earlier chip (from stored sources) re-appears —
    //    scope the "no chip" check to the LAST ai wrap to avoid a false failure.
    await page.locator('#chatInput').fill('explain the nephron');
    await page.locator('#chatSend').click();
    await expect(page.locator('.m.ai').last()).toContainText('Stubbed', { timeout: 5000 });
    await expect(page.locator('.m-wrap.ai').last().locator('.rag-sources')).toHaveCount(0, { timeout: 5000 });
  });

  test('EDGE: the RAG off state persists per vault', async () => {
    const { page } = ctx;

    // default ON, then disable + save.
    await openAiPanel(page);
    await expect(page.locator('#aiRagToggle')).toBeChecked();
    await page.locator('#aiRagToggle').uncheck();
    await page.locator('#aiSettingsSave').click();
    await expect(page.locator('#aiSettingsModal')).toHaveCount(0);

    // reopen the modal in the same test-vault session → the per-vault flag was
    // persisted (vsSet) and re-read (vsGet) on rebuild: toggle still unchecked.
    await openAiPanel(page);
    await expect(page.locator('#aiRagToggle')).not.toBeChecked();
  });
});
