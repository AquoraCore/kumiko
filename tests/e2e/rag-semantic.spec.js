const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { launchApp, teardown } = require('./helpers');

// NOTE: the stub embedder (WASHI_TEST_EMBED) is a DETERMINISTIC token-frequency
// vector. It exercises the semantic PLUMBING — cache write/read, hybrid fusion,
// graceful fallback — NOT real semantic quality, which only a live model provides.

// The app reads the vault live on each rag:context call, so notes written into
// ctx.notesDir AFTER launch are picked up.
function seed(ctx, name, content) {
  fs.writeFileSync(path.join(ctx.notesDir, name), content, 'utf8');
}

test.describe('rag:semantic', () => {
  test('HAPPY: semantic path builds the embedding cache and returns fused context', async () => {
    const ctx = await launchApp({ stubEmbed: true });
    try {
      seed(ctx, 'Nephron.md', 'The nephron filters blood in the kidney.');
      seed(ctx, 'Mitochondria.md', 'The mitochondria makes ATP energy.');
      const r = await ctx.page.evaluate(() => window.api.ragContext('nephron kidney'));
      expect(typeof r.context).toBe('string');
      expect(r.context.length).toBeGreaterThan(0);
      expect(r.context).toContain('Nephron');
      // The semantic pipeline ran end-to-end and cached embeddings to disk.
      const cachePath = path.join(ctx.notesDir, '.washi', 'embeddings.json');
      expect(fs.existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      expect(cache.model).toBeTruthy();
      expect(cache.notes).toBeTruthy();
      expect(cache.notes['Nephron.md']).toBeTruthy();
      expect(Array.isArray(cache.notes['Nephron.md'].vec)).toBe(true);
    } finally {
      await teardown(ctx);
    }
  });

  test('EDGE: semantic OFF by default writes no embedding cache; lexical still works', async () => {
    const ctx = await launchApp({ stubEmbed: false }); // no WASHI_TEST_EMBED, state.ragSemantic unset -> OFF
    try {
      seed(ctx, 'Nephron.md', 'The nephron filters blood in the kidney.');
      const r = await ctx.page.evaluate(() => window.api.ragContext('nephron kidney'));
      expect(r.context).toContain('Nephron'); // lexical still works
      // Opt-in gate holds: no embedding call, no cache file written.
      expect(fs.existsSync(path.join(ctx.notesDir, '.washi', 'embeddings.json'))).toBe(false);
    } finally {
      await teardown(ctx);
    }
  });
});
