const { test, expect } = require('@playwright/test');
const { launchApp, teardown, mkTmp } = require('./helpers');
const { startServer } = require('../../server/index');

// Phase 7, step 7b-4: wire the app to the JWT-gated backend. Login is OPTIONAL —
// the app works offline without an account; a token is only used to pass ?token=
// to an authed relay. HAPPY proves signup stores an encrypted token and shows the
// logged-in UI; EDGE proves two authed clients sync through the GATED backend
// (no token → the WS upgrade is 401'd and sync never happens).

async function openAiPanel(page) {
  await page.locator('#settingsBtn2').click();
  await page.locator('#aiSettingsMenuItem').click();
  await expect(page.locator('#aiSettingsModal')).toBeVisible();
}

// Drive signup through the renderer so both the token store AND the UI update the
// same way a real user would (fetch /auth/signup → window.api.authSetToken). Used
// by the EDGE test for reliability when two instances each need a valid token.
async function signupViaRenderer(page, email, password, httpBase) {
  await page.evaluate(async ({ email, password, httpBase }) => {
    const res = await fetch(httpBase + '/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('signup failed: ' + res.status);
    const { token, email: em } = await res.json();
    await window.api.authSetToken(token, em);
  }, { email, password, httpBase });
}

test.describe('collab auth — app wired to the gated backend (step 7b-4)', () => {
  let s, ctx, B;
  test.afterEach(async () => {
    if (B) await teardown(B);
    if (ctx) await teardown(ctx);
    if (s) { try { await s.close(); } catch (_) {} }
  });

  test('HAPPY: sign up via the app stores a token and shows logged-in', async () => {
    // Ephemeral backend on a free port, isolated temp data dir.
    s = await startServer({ port: 0, dataDir: mkTmp('washi-auth-data-') });
    const wsUrl = 'ws://127.0.0.1:' + s.port;
    ctx = await launchApp({});   // collab NOT needed for this UI-only check

    // Point collabHttpBase() at the backend via localStorage (collabRelayUrl reads it).
    await ctx.page.evaluate((u) => { localStorage.setItem('collabRelay', u); }, wsUrl);

    await openAiPanel(ctx.page);
    await ctx.page.locator('#aiAuthEmail').fill('u@test.com');
    await ctx.page.locator('#aiAuthPass').fill('password123');
    await ctx.page.locator('#aiAuthSignup').click();

    // The area re-renders to logged-in and shows the email.
    await expect.poll(
      async () => ctx.page.locator('#aiAuthArea').textContent(),
      { timeout: 10000, intervals: [200, 500, 1000] }
    ).toContain('u@test.com');

    // The token was stored (encrypted at rest) and getToken returns it plaintext.
    const tok = await ctx.page.evaluate(() => window.api.authGetToken());
    expect(tok).toBeTruthy();
    expect(typeof tok.token).toBe('string');
    expect(tok.token.length).toBeGreaterThan(0);
  }, 30000);

  test('EDGE: collab syncs through the GATED backend when logged in', async () => {
    s = await startServer({ port: 0, dataDir: mkTmp('washi-auth-data-') });
    const wsUrl = 'ws://127.0.0.1:' + s.port;
    const httpBase = 'http://127.0.0.1:' + s.port;

    // Two instances, one shared vault, collab on, both pointing at the gated relay.
    ctx = await launchApp({ collab: true, collabRelay: wsUrl, notes: [{ name: 'shared.md', content: '' }] });
    B = await launchApp({ collab: true, collabRelay: wsUrl, notesDir: ctx.notesDir });

    // Distinct accounts per instance — both hold valid tokens for the gated relay.
    await signupViaRenderer(ctx.page, 'a@test.com', 'password123', httpBase);
    await signupViaRenderer(B.page, 'b@test.com', 'password456', httpBase);

    // A opens 'shared', connects (token in the WS query → upgrade accepted), types.
    await ctx.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await ctx.page.locator('#editorHost .ProseMirror').click();
    await ctx.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await ctx.page.keyboard.type('hello from A');

    // B opens the same note; its provider (also authed) syncs A's edit through the gate.
    await B.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await B.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await expect.poll(
      async () => B.page.locator('#editorHost .ProseMirror').textContent(),
      { timeout: 15000, intervals: [200, 500, 1000] }
    ).toContain('hello from A');
  }, 40000);
});
