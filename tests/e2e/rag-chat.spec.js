const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// Ambient RAG: sendChat always pulls in relevant notes; a matched note shows a
// referenced-notes chip above the AI bubble, a no-match send behaves like normal chat.
test.describe('ambient RAG (stubbed engine + seeded note)', () => {
  let ctx;
  test.beforeEach(async () => {
    ctx = await launchApp({ stubEngine: true, notes: [
      { name: 'Nephron.md', content: 'The nephron filters blood in the kidney and forms urine.' },
    ] });
  });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: a message that matches a note shows the referenced-notes chip', async () => {
    const { page } = ctx;
    await page.locator('#chatInput').fill('explain the nephron');
    await page.locator('#chatSend').click();
    await expect(page.locator('.m.ai').last()).toContainText('Stubbed', { timeout: 5000 });
    await expect(page.locator('.rag-sources')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.rag-sources .rag-src', { hasText: 'Nephron' })).toBeVisible();
  });

  test('EDGE: a message that matches nothing shows NO chip but still chats normally', async () => {
    const { page } = ctx;
    await page.locator('#chatInput').fill('zzzznomatch qqqq');
    await page.locator('#chatSend').click();
    await expect(page.locator('.m.ai').last()).toContainText('Stubbed', { timeout: 5000 });
    await expect(page.locator('.rag-sources')).toHaveCount(0, { timeout: 5000 });
  });
});
