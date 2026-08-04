const { test, expect } = require('@playwright/test');
const { launchApp, teardown, mkTmp } = require('./helpers');
const { startServer } = require('../../server/index');

// Phase 8.3c: the definitive proof of desktop <-> cloud SYNC (Option B). One app
// instance against an ephemeral startServer backend (no ALLOWED_EMAILS -> open
// signup). HAPPY proves BOTH directions through window.syncNow():
//   (1) a LOCAL-only note is PUSHED up to the cloud (verified via the backend API),
//   (2) a CLOUD-only note is PULLED down to local (verified via the Electron IPC).
// Mirrors auth-app.spec.js for startServer + mkTmp + collabRelay localStorage +
// the signup-then-authSetToken evaluate; mirrors collab-sync.spec.js for
// launchApp + teardown.
test.describe('desktop <-> cloud sync (Option B)', () => {
  let s, A;
  test.afterEach(async () => {
    if (A) await teardown(A); A = null;
    if (s) { try { await s.close(); } catch (_) {} s = null; }
  });

  test('HAPPY: local note pushes to cloud; cloud note pulls to local', async () => {
    // 1) ephemeral cloud backend (no ALLOWED_EMAILS -> open signup).
    s = await startServer({ port: 0, dataDir: mkTmp('washi-sync-data-') });
    const wsUrl = 'ws://127.0.0.1:' + s.port;
    const httpBase = 'http://127.0.0.1:' + s.port;

    // 2) launch desktop with ONE local note already on disk.
    A = await launchApp({ notes: [{ name: 'LocalNote.md', content: '# local body' }] });
    const page = A.page;

    // 3) point collabHttpBase() at the backend + sign up (stores the cloud token),
    //    exactly like auth-app.spec's signupViaRenderer.
    await page.evaluate((u) => { localStorage.setItem('collabRelay', u); }, wsUrl);
    await page.evaluate(async ({ httpBase }) => {
      const r = await fetch(httpBase + '/auth/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sync@e2e.local', password: 'secret123' }),
      });
      if (!r.ok) throw new Error('signup failed: ' + r.status);
      const { token, email } = await r.json();
      await window.api.authSetToken(token, email);
    }, { httpBase });

    // 4) run sync -> should PUSH LocalNote.md up to the cloud.
    const r1 = await page.evaluate(() => window.syncNow());
    expect(r1.ok).toBe(true);
    expect(r1.pushed).toBeGreaterThanOrEqual(1);

    // 5) verify the cloud now has LocalNote.md (query the backend with the token +
    //    the vault id syncNow chose). The /notes list returns an array of names.
    const cloudHasLocal = await page.evaluate(async ({ httpBase }) => {
      const acc = await window.api.authGetToken(); const tok = acc && acc.token;
      const H = { authorization: 'Bearer ' + tok };
      const vid = (await (await fetch(httpBase + '/vaults', { headers: H })).json()).vaults[0].id;
      const names = (await (await fetch(httpBase + '/notes', { headers: Object.assign({ 'x-vault': vid }, H) })).json()).notes || [];
      return names.includes('LocalNote.md');
    }, { httpBase });
    expect(cloudHasLocal).toBe(true);

    // 6) add a CLOUD-ONLY note, then sync again -> should PULL it to local.
    await page.evaluate(async ({ httpBase }) => {
      const acc = await window.api.authGetToken(); const tok = acc && acc.token;
      const H = { 'content-type': 'application/json', authorization: 'Bearer ' + tok };
      const vid = (await (await fetch(httpBase + '/vaults', { headers: { authorization: 'Bearer ' + tok } })).json()).vaults[0].id;
      await fetch(httpBase + '/notes', {
        method: 'PUT', headers: Object.assign({ 'x-vault': vid }, H),
        body: JSON.stringify({ name: 'CloudNote.md', content: '# from cloud' }),
      });
    }, { httpBase });
    const r2 = await page.evaluate(() => window.syncNow());
    expect(r2.ok).toBe(true);
    expect(r2.pulled).toBeGreaterThanOrEqual(1);

    // 7) verify the desktop's LOCAL vault now has CloudNote.md (via the Electron IPC).
    const localHasCloud = await page.evaluate(async () => {
      const l = await window.api.listNotes();
      return (l.notes || []).includes('CloudNote.md');
    });
    expect(localHasCloud).toBe(true);
  }, 30000);

  // Phase V2.2: proves AFTER-SAVE auto-sync via window.syncSoon (debounced) pushes
  // a brand-new note to the cloud WITHOUT a manual syncNow call. Reuses the same
  // ephemeral-server + signup setup as the HAPPY test above.
  test('AFTERSAVE: window.syncSoon() pushes a newly saved note without manual syncNow', async () => {
    s = await startServer({ port: 0, dataDir: mkTmp('washi-sync-soon-data-') });
    const wsUrl = 'ws://127.0.0.1:' + s.port;
    const httpBase = 'http://127.0.0.1:' + s.port;

    A = await launchApp({ notes: [{ name: 'Seed.md', content: '# seed' }] });
    const page = A.page;

    await page.evaluate((u) => { localStorage.setItem('collabRelay', u); }, wsUrl);
    await page.evaluate(async ({ httpBase }) => {
      const r = await fetch(httpBase + '/auth/signup', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'syncsoon@e2e.local', password: 'secret123' }),
      });
      if (!r.ok) throw new Error('signup failed: ' + r.status);
      const { token, email } = await r.json();
      await window.api.authSetToken(token, email);
    }, { httpBase });

    // establish base via one guarded tick
    await page.evaluate(() => window.syncTick('load'));

    // create + save a brand-new note locally (no manual syncNow)
    await page.evaluate(async () => {
      await window.api.createNote('AutoSaved.md');
      await window.api.saveNote('AutoSaved.md', '# auto');
    });
    // fire the debounced after-save sync (delay=0)
    await page.evaluate(() => window.syncSoon(0));

    // poll the cloud /notes for this vault until 'AutoSaved.md' shows up (<=4s)
    let cloudHas = false;
    for (let i = 0; i < 20; i++) {
      cloudHas = await page.evaluate(async ({ httpBase }) => {
        const acc = await window.api.authGetToken(); const tok = acc && acc.token;
        const H = { authorization: 'Bearer ' + tok };
        const vid = (await (await fetch(httpBase + '/vaults', { headers: H })).json()).vaults[0].id;
        const names = (await (await fetch(httpBase + '/notes', { headers: Object.assign({ 'x-vault': vid }, H) })).json()).notes || [];
        return names.includes('AutoSaved.md');
      }, { httpBase });
      if (cloudHas) break;
      await page.waitForTimeout(200);
    }
    expect(cloudHas).toBe(true);
  }, 30000);
});
