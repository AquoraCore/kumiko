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

// Log a SECOND instance into an EXISTING account (signup would 409 on the dup email).
// Used to authenticate two instances as the SAME user (one person, two devices).
async function loginViaRenderer(page, email, password, httpBase) {
  await page.evaluate(async ({ email, password, httpBase }) => {
    const res = await fetch(httpBase + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error('login failed: ' + res.status);
    const { token, email: em } = await res.json();
    await window.api.authSetToken(token, em || email);
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

  test('EDGE: SAME-user collab syncs through the GATED backend (web<->desktop share the per-user room)', async () => {
    s = await startServer({ port: 0, dataDir: mkTmp('washi-auth-data-') });
    const wsUrl = 'ws://127.0.0.1:' + s.port;
    const httpBase = 'http://127.0.0.1:' + s.port;

    // Two instances, one shared vault, collab on, both pointing at the gated relay.
    ctx = await launchApp({ collab: true, collabRelay: wsUrl, notes: [{ name: 'shared.md', content: '' }] });
    B = await launchApp({ collab: true, collabRelay: wsUrl, notesDir: ctx.notesDir });

    // SAME account on both (one person, two devices) → same per-user room (V2.3 scopes
    // the collab room by email: <email>::<note>). A signs up; B logs into that account.
    await signupViaRenderer(ctx.page, 'me@test.com', 'password123', httpBase);
    await loginViaRenderer(B.page, 'me@test.com', 'password123', httpBase);

    // A opens 'shared', connects (token in the WS query → upgrade accepted), types.
    await ctx.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await ctx.page.locator('#editorHost .ProseMirror').click();
    await ctx.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await ctx.page.keyboard.type('hello from A');

    // B opens the same note; its provider (same user → same room) syncs A's edit.
    await B.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await B.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await expect.poll(
      async () => B.page.locator('#editorHost .ProseMirror').textContent(),
      { timeout: 15000, intervals: [200, 500, 1000] }
    ).toContain('hello from A');
  }, 40000);

  // Guards the V2.3 fix (core/collabroom.js): before scoping, two DIFFERENT users with a
  // same-named note shared ONE room = cross-user live-edit leak. Now they must NOT sync.
  test('EDGE: DIFFERENT users do NOT share a collab room (per-user isolation, V2.3)', async () => {
    s = await startServer({ port: 0, dataDir: mkTmp('washi-auth-iso-') });
    const wsUrl = 'ws://127.0.0.1:' + s.port;
    const httpBase = 'http://127.0.0.1:' + s.port;

    ctx = await launchApp({ collab: true, collabRelay: wsUrl, notes: [{ name: 'shared.md', content: '' }] });
    B = await launchApp({ collab: true, collabRelay: wsUrl, notesDir: ctx.notesDir });

    // Distinct accounts → distinct per-user rooms for the same note name.
    await signupViaRenderer(ctx.page, 'a@test.com', 'password123', httpBase);
    await signupViaRenderer(B.page, 'b@test.com', 'password456', httpBase);

    await ctx.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await ctx.page.locator('#editorHost .ProseMirror').click();
    await ctx.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    await ctx.page.keyboard.type('secret from A');

    await B.page.locator('#noteList .note-item', { hasText: 'shared' }).click();
    await B.page.waitForSelector('[data-collab="connected"]', { timeout: 10000 });
    // Give the relay ample time to (not) deliver — B must NEVER receive A's text.
    await B.page.waitForTimeout(3000);
    const bText = await B.page.locator('#editorHost .ProseMirror').textContent();
    expect(bText || '').not.toContain('secret from A');
  }, 40000);
});
