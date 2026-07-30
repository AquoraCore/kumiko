const { test, expect } = require('@playwright/test');
const { launchApp, teardown, switchLanguage } = require('./helpers');

test.describe('i18n (language round-trip)', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: switch to English → sidebar labels read Notes / Databases / Dashboard', async () => {
    const { page } = ctx;
    await switchLanguage(page, 'en');
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'Notes' })).toBeVisible();
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'Databases' })).toBeVisible();
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'Dashboard' })).toBeVisible();
  });

  test('EDGE: round-trip back to Thai → labels read โน้ต / ฐานข้อมูล / แดชบอร์ด again', async () => {
    const { page } = ctx;
    // go English first, then back to Thai
    await switchLanguage(page, 'en');
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'Notes' })).toBeVisible();
    await switchLanguage(page, 'th');
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'โน้ต' })).toBeVisible();
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'ฐานข้อมูล' })).toBeVisible();
    await expect(page.locator('.sb-group .sb-gnm', { hasText: 'แดชบอร์ด' })).toBeVisible();
  });
});
