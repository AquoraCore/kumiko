const { test, expect } = require('@playwright/test');
const { launchApp, teardown, createDb } = require('./helpers');

test.describe('databases', () => {
  let ctx;
  test.beforeEach(async () => { ctx = await launchApp(); });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: create a DB → appears in sidebar; open → table renders; text cell persists', async () => {
    const { page } = ctx;
    // A fresh vault AUTO-SEEDS a sample DB, so the sidebar already has ≥1
    // .sb-leaf-db before create. createDb() ignores the name arg and makes a
    // DB named 'ฐานข้อมูลใหม่'.
    await createDb(page);
    const leaf = page.locator('.sb-leaf-db', { hasText: 'ฐานข้อมูลใหม่' });
    await expect(leaf).toBeVisible();

    // re-open from the sidebar leaf (re-reads from disk) → table still renders
    await leaf.click();
    await expect(page.locator('#tableView table.db')).toBeVisible();

    // edit the first text cell → value persists
    await page.locator('.db-cell').first().click();
    const input = page.locator('.db-input').first();
    await input.fill('Persistent Value');
    await input.press('Enter');
    await expect(page.locator('table.db .db-val', { hasText: 'Persistent Value' })).toBeVisible();
  });

  test('EDGE: a brand-new database renders its table shell without error', async () => {
    const { page } = ctx;
    await createDb(page);
    await expect(page.locator('#tableView table.db')).toBeVisible();
    // a fresh DB ships one default row
    await expect(page.locator('table.db tbody tr')).not.toHaveCount(0);
  });
});
