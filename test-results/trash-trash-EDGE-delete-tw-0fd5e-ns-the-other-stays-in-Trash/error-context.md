# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: trash.spec.js >> trash >> EDGE: delete two notes, restore only one → exactly one returns, the other stays in Trash
- Location: tests/e2e/trash.spec.js:23:3

# Error details

```
TimeoutError: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
```

# Test source

```ts
  1   | // Launches the REAL Electron app against an isolated temp vault + temp userData.
  2   | // NON-NEGOTIABLE: every launch creates fresh dirs under os.tmpdir() and teardown()
  3   | // removes them. The user's ~/Documents/StudyNotes and real Electron userData are
  4   | // never read or written by any test.
  5   | const os = require('os');
  6   | const fs = require('fs');
  7   | const path = require('path');
  8   | const { _electron: electron } = require('playwright');
  9   | const { expect } = require('@playwright/test');
  10  | 
  11  | function mkTmp(prefix) {
  12  |   return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  13  | }
  14  | 
  15  | // Write a fixture note (supports "folder/note.md" relative paths) into a vault dir.
  16  | function writeNote(dir, name, content) {
  17  |   const full = path.join(dir, name);
  18  |   fs.mkdirSync(path.dirname(full), { recursive: true });
  19  |   fs.writeFileSync(full, content == null ? '' : String(content), 'utf8');
  20  | }
  21  | 
  22  | // opts:
  23  | //   notes:  [{ name, content }]            single-vault mode (env hook)
  24  | //   vaults: [{ name, notes: [{name,content}] }]  registry mode (supports switching)
  25  | //
  26  | // Single-vault mode sets WASHI_TEST_NOTES_DIR so resolveNotesDir() returns the
  27  | // temp dir directly. Registry mode instead pre-seeds <userData>/vaults.json and
  28  | // leaves the env var UNSET, so the real resolveNotesDir() path drives boot and
  29  | // vault switching survives a reload — that is the behavior vault-isolation.spec
  30  | // needs to characterize.
  31  | async function launchApp(opts) {
  32  |   opts = opts || {};
  33  |   const dirs = [];
  34  |   const userData = mkTmp('washi-ud-');
  35  |   dirs.push(userData);
  36  |   const env = Object.assign({}, process.env);
  37  |   env.WASHI_TEST = '1';
  38  |   if (opts.stubEngine) env.WASHI_TEST_ENGINE = '1';   // chat spec: route engine:run to the canned stub
  39  |   let notesDir;
  40  | 
  41  |   if (Array.isArray(opts.vaults) && opts.vaults.length) {
  42  |     const recents = [];
  43  |     opts.vaults.forEach((v) => {
  44  |       const vdir = mkTmp('washi-vault-');
  45  |       dirs.push(vdir);
  46  |       if (Array.isArray(v.notes)) v.notes.forEach((n) => writeNote(vdir, n.name, n.content));
  47  |       recents.push({ path: vdir, name: v.name || path.basename(vdir) });
  48  |     });
  49  |     notesDir = recents[0].path; // boot on the first vault
  50  |     fs.writeFileSync(
  51  |       path.join(userData, 'vaults.json'),
  52  |       JSON.stringify({ current: notesDir, recents }, null, 2),
  53  |       'utf8'
  54  |     );
  55  |     // Deliberately do NOT set WASHI_TEST_NOTES_DIR: the registry must drive
  56  |     // resolveNotesDir() so a vault switch can take effect after reload.
  57  |   } else {
  58  |     notesDir = mkTmp('washi-notes-');
  59  |     dirs.push(notesDir);
  60  |     if (Array.isArray(opts.notes)) opts.notes.forEach((n) => writeNote(notesDir, n.name, n.content));
  61  |     env.WASHI_TEST_NOTES_DIR = notesDir;
  62  |   }
  63  | 
  64  |   const app = await electron.launch({
  65  |     args: ['.', '--user-data-dir=' + userData],
  66  |     env,
  67  |     cwd: process.cwd(),
  68  |   });
> 69  |   const page = await app.firstWindow();
      |                          ^ TimeoutError: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
  70  |   // Auto-dismiss native alert() dialogs the app may raise (e.g. duplicate-name
  71  |   // rejection). Custom modals (askName / confirmDelete) are DOM-based, unaffected.
  72  |   page.on('dialog', async (d) => { try { await d.accept(); } catch (_) {} });
  73  |   await page.waitForLoadState('domcontentloaded');
  74  |   await page.locator('#noteList').waitFor();
  75  | 
  76  |   return { app, page, notesDir, userData, dirs };
  77  | }
  78  | 
  79  | async function teardown(ctx) {
  80  |   if (!ctx) return;
  81  |   try { if (ctx.app) await ctx.app.close(); } catch (_) {}
  82  |   (ctx.dirs || []).forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
  83  | }
  84  | 
  85  | // ---- UI flow helpers (verified against the REAL app DOM) ----
  86  | // All take the Electron page (ctx.page). Default UI language is Thai, so the
  87  | // footer "+ ใหม่" menu and context-menu labels are Thai strings. The old
  88  | // #newNoteBtn / #newFolderBtn / .sb-gadd buttons are display:none — everything
  89  | // is created through the #newMenuBtn footer menu now.
  90  | 
  91  | // Fill the DOM-based askName() modal (`.modal-card`) and confirm with the
  92  | // `.solid` (ตกลง/OK) button.
  93  | async function fillNameModal(page, name) {
  94  |   await page.locator('.modal-card input').fill(name);
  95  |   await page.locator('.modal-card button.solid').click();
  96  | }
  97  | 
  98  | // Open the footer "+ ใหม่" menu and pick the item whose label matches.
  99  | async function newViaMenu(page, label) {
  100 |   await page.locator('#newMenuBtn').click();
  101 |   await page.locator('.db-menu .db-mi', { hasText: label }).click();
  102 | }
  103 | 
  104 | async function createNote(page, name) {
  105 |   await newViaMenu(page, 'โน้ตใหม่');
  106 |   await fillNameModal(page, name);
  107 |   await expect(page.locator('#noteList .note-item', { hasText: name })).toBeVisible();
  108 | }
  109 | 
  110 | async function createFolder(page, name) {
  111 |   await newViaMenu(page, 'กล่องใหม่');
  112 |   await fillNameModal(page, name);
  113 |   await expect(page.locator('.folder-row', { hasText: name })).toBeVisible();
  114 | }
  115 | 
  116 | // sbNewDb() calls dbCreate({}) — the app assigns a DEFAULT name and auto-opens
  117 | // the table view. It does NOT prompt for a name in this build; the optional
  118 | // modal fill is kept defensively. `name` is currently unused by the app.
  119 | async function createDb(page, name) {
  120 |   await newViaMenu(page, 'ฐานข้อมูลใหม่');
  121 |   // sbNewDb may prompt a name modal — fill it if it appears, otherwise the DB
  122 |   // is created directly and the table auto-opens.
  123 |   if (await page.locator('.modal-card input').count()) await fillNameModal(page, name);
  124 |   await expect(page.locator('table.db')).toBeVisible();
  125 | }
  126 | 
  127 | async function rightClickNote(page, name) {
  128 |   await page.locator('#noteList .note-item', { hasText: name }).click({ button: 'right' });
  129 | }
  130 | 
  131 | // Click an item in whatever `.db-menu` is currently open (note / folder / db
  132 | // context menus all reuse the same `.db-menu` / `.db-mi` markup).
  133 | async function ctxItem(page, label) {
  134 |   await page.locator('.db-menu .db-mi', { hasText: label }).click();
  135 | }
  136 | 
  137 | async function deleteNote(page, name) {
  138 |   await rightClickNote(page, name);
  139 |   await ctxItem(page, 'ลบ');                              // matches "ลบ (ไปถังขยะ)"
  140 |   await page.locator('.modal-card button.danger').click();  // confirmDelete → red ลบ
  141 |   await expect(page.locator('#noteList .note-item', { hasText: name })).toHaveCount(0);
  142 | }
  143 | 
  144 | async function openTrash(page) {
  145 |   await page.locator('#trashBtn2').click();
  146 |   await expect(page.locator('#trashView')).toBeVisible();
  147 | }
  148 | 
  149 | // 'en' or 'th'. setUiLang() reloads the window; wait for #noteList to come back.
  150 | async function switchLanguage(page, lang) {
  151 |   await page.locator('#settingsBtn2').click();
  152 |   const label = lang === 'en' ? 'English' : 'ไทย';
  153 |   await page.locator('.settings-menu button', { hasText: label }).click();
  154 |   await page.locator('#noteList').waitFor();
  155 | }
  156 | 
  157 | // Switch vault via the #vaultChip dropdown; reloads the window.
  158 | // The vault menu shows each vault's DIRECTORY BASENAME (a random temp name),
  159 | // NOT the stored display name, so we can't match `.vm-nm` by `name`. With
  160 | // exactly two test vaults (current + one other), switch by clicking the
  161 | // NON-CURRENT row. `name` is kept in the signature for call-site compatibility.
  162 | // ponytail: name param now unused; re-enable name-based matching if a test
  163 | // ever needs >2 vaults.
  164 | async function switchVault(page, name) {
  165 |   await page.locator('#vaultChip').click();
  166 |   await expect(page.locator('.vault-menu')).toBeVisible();
  167 |   await page.locator('.vault-menu .vm-row:not(.is-current)').first().click();
  168 |   await page.locator('#noteList').waitFor();
  169 | }
```