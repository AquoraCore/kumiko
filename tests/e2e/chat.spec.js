const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

test.describe('chat (stubbed engine)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp({ stubEngine: true }); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: sending a message streams the stubbed reply into an AI bubble', async () => {
    const { page } = ctx;
    await page.locator('#chatInput').fill('hello');
    await page.locator('#chatSend').click();
    await expect(page.locator('.m.ai').last()).toContainText('Stubbed', { timeout: 5000 });
  });

  test('EDGE: while running the send button becomes a stop button; clicking it aborts the run', async () => {
    const { page } = ctx;
    await page.locator('#chatInput').fill('long task');
    await page.locator('#chatSend').click();
    // send button flips to stop (.is-stop) during the ~600ms stubbed run
    await expect(page.locator('#chatSend.is-stop')).toBeVisible({ timeout: 3000 });
    await page.locator('#chatSend').click();                     // stop
    // after abort, the stop state clears (button returns to send)
    await expect(page.locator('#chatSend.is-stop')).toHaveCount(0, { timeout: 5000 });
  });
});
