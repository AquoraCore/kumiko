const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

test.describe('search', () => {
  let ctx;
  test.beforeEach(async () => {
    ctx = await launchApp({
      notes: [
        { name: 'ไต.md', content: '# ไต' },
        { name: 'หัวใจ.md', content: '# หัวใจ' },
      ],
    });
  });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: a matching query lists the note; clicking it opens it', async () => {
    const { page } = ctx;
    await page.locator('#searchInput').fill('ไต');
    const result = page.locator('.search-results .sr-item', { hasText: 'ไต' }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.locator('#noteTitle')).toContainText('ไต');
  });

  test('EDGE: a query matching nothing → no results, app stays usable', async () => {
    const { page } = ctx;
    await page.locator('#searchInput').fill('zzzzz');
    await expect(page.locator('.search-results .sr-item')).toHaveCount(0);
    await expect(page.locator('#searchInput')).toBeVisible();
  });
});
