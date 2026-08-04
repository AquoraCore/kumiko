const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// Opens the settings menu (via #settingsBtn2) and clicks the AI provider item,
// then waits for the AI settings modal to mount. The menu reloads on each open.
async function openAiPanel(page) {
  await page.locator('#settingsBtn2').click();
  await page.locator('#aiSettingsMenuItem').click();
  await expect(page.locator('#aiSettingsModal')).toBeVisible();
}

test.describe('AI provider settings (step 3a-2)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: pick API mode + provider zai + key → save persists mode + hasKey', async () => {
    const { page } = ctx;
    await openAiPanel(page);

    // switch to API mode → api section + key field appear
    await page.locator('.ai-mode-btn[data-mode="api"]').click();
    await expect(page.locator('#aiApiSection')).toBeVisible();
    await expect(page.locator('#aiKeyInput')).toBeVisible();

    // select zai provider, paste a key, save
    await page.locator('#aiProviderSel').selectOption('zai');
    await page.locator('#aiKeyInput').fill('sk-test-123');
    await page.locator('#aiSettingsSave').click();
    await expect(page.locator('#aiSettingsModal')).toHaveCount(0);

    // reopen → mode persisted (api on) and key placeholder shows a key is set
    await openAiPanel(page);
    await expect(page.locator('.ai-mode-btn[data-mode="api"]')).toHaveClass(/on/);
    await expect(page.locator('#aiKeyInput')).toHaveAttribute('placeholder', /ตั้งค่าไว้แล้ว|set/);
  });

  test('EDGE: type a key then Cancel → nothing persists', async () => {
    const { page } = ctx;
    await openAiPanel(page);

    // api is the only real mode now (cli removed in 8.5) → its section is shown by default
    await expect(page.locator('.ai-mode-btn[data-mode="api"]')).toHaveClass(/on/);
    await expect(page.locator('#aiApiSection')).toBeVisible();
    await page.locator('#aiKeyInput').fill('sk-should-not-persist');
    await page.locator('#aiSettingsCancel').click();
    await expect(page.locator('#aiSettingsModal')).toHaveCount(0);

    // reopen → the cancelled key did NOT persist (no "key is set" placeholder)
    await openAiPanel(page);
    await expect(page.locator('#aiKeyInput')).not.toHaveAttribute('placeholder', /ตั้งค่าไว้แล้ว|set/);
  });
});
