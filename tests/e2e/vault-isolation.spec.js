const { test, expect } = require('@playwright/test');
const { launchApp, teardown, switchVault } = require('./helpers');

// THE most important guarantee: vaults are isolated. This spec boots the app
// through the real registry (vaults.json) instead of the WASHI_TEST_NOTES_DIR
// hook, so the actual resolveNotesDir() + vault:switch path is exercised end to end.
test.describe('vault isolation', () => {
  let ctx;
  test.beforeEach(async () => {
    ctx = await launchApp({
      vaults: [
        { name: 'VaultAlpha', notes: [{ name: 'alpha.md', content: '# alpha' }] },
        { name: 'VaultBeta', notes: [{ name: 'beta.md', content: '# beta' }] },
      ],
    });
  });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: switching from vault A to B shows beta, not alpha', async () => {
    const { page } = ctx;
    await expect(page.locator('#noteList .note-item', { hasText: 'alpha' })).toBeVisible();
    await switchVault(page, 'VaultBeta');
    await expect(page.locator('#noteList .note-item', { hasText: 'beta' })).toBeVisible();
  });

  test('EDGE: after switching to B, alpha is gone', async () => {
    const { page } = ctx;
    await switchVault(page, 'VaultBeta');
    await expect(page.locator('#noteList .note-item', { hasText: 'beta' })).toBeVisible();
    await expect(page.locator('#noteList .note-item', { hasText: 'alpha' })).toHaveCount(0);
  });
});
