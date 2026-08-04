const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createNote } = require('./helpers');

// The editor + chat bars (where #aiPanelToggle / #chatHideBtn live) only mount
// once a note is open — the empty/home state hides them. So open a note first.
test.describe('AI chat show/hide toggle', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); await createNote(ctx.page, 'Toggle Note'); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: #aiPanelToggle collapses the chat, then reopens it', async () => {
    const { page } = ctx;
    const app = page.locator('#app');
    await expect(app).not.toHaveClass(/term-hidden/);      // shown by default
    await page.locator('#aiPanelToggle').click();
    await expect(app).toHaveClass(/term-hidden/);          // collapsed
    await page.locator('#aiPanelToggle').click();
    await expect(app).not.toHaveClass(/term-hidden/);      // reopened
  });

  test('EDGE: hidden state persists across reload', async () => {
    const { page } = ctx;
    await page.locator('#aiPanelToggle').click();
    await expect(page.locator('#app')).toHaveClass(/term-hidden/);
    await page.reload();
    await expect(page.locator('#app')).toHaveClass(/term-hidden/);
  });
});
