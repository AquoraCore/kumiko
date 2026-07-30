const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// The app reads the vault live on each rag:context call, so notes written into
// ctx.notesDir AFTER launch are picked up. Each test seeds its own vault.
function seed(ctx, name, content) {
  fs.writeFileSync(path.join(ctx.notesDir, name), content, 'utf8');
}

test.describe('rag:context', () => {
  let ctx;
  test.beforeEach(async () => {
    ctx = await launchApp({});
    seed(ctx, 'Nephron.md', 'The nephron filters blood in the kidney and forms urine.');
    seed(ctx, 'Mitochondria.md', 'The mitochondria makes ATP energy for the cell.');
    seed(ctx, 'Kidney.md', 'The kidney contains many nephrons. See [[Nephron]] for detail.');
  });
  test.afterEach(async () => { await teardown(ctx); });

  test('HAPPY: relevant notes are retrieved; irrelevant excluded', async () => {
    const r = await ctx.page.evaluate(() => window.api.ragContext('nephron kidney'));
    expect(typeof r.context).toBe('string');
    expect(r.context.length).toBeGreaterThan(0);
    expect(r.context).toContain('[source: Nephron]');
    expect(r.context).toContain('filters blood');
    expect(r.context).toContain('[source: Kidney]');
    expect(r.context).not.toContain('Mitochondria');
    expect(r.context).not.toContain('ATP');
    expect(r.sources).toContain('Nephron');
  });

  test('EDGE: no lexical match -> empty context, and empty question -> empty context', async () => {
    const none = await ctx.page.evaluate(() => window.api.ragContext('zzzznomatch qqqq'));
    expect(none.context).toBe('');
    expect(none.sources).toEqual([]);
    const empty = await ctx.page.evaluate(() => window.api.ragContext(''));
    expect(empty.context).toBe('');
  });
});
