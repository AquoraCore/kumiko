const { defineConfig } = require('@playwright/test');

// E2E characterization tests drive the real Electron app. Each spec launches the
// app against a FRESH temp vault + temp userData (see tests/e2e/helpers.js) so
// the user's real notes / userData are never touched.
module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
});
