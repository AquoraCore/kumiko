// Launches the REAL Electron app against an isolated temp vault + temp userData.
// NON-NEGOTIABLE: every launch creates fresh dirs under os.tmpdir() and teardown()
// removes them. The user's ~/Documents/StudyNotes and real Electron userData are
// never read or written by any test.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('playwright');
const { expect } = require('@playwright/test');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Write a fixture note (supports "folder/note.md" relative paths) into a vault dir.
function writeNote(dir, name, content) {
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content == null ? '' : String(content), 'utf8');
}

// opts:
//   notes:  [{ name, content }]            single-vault mode (env hook)
//   vaults: [{ name, notes: [{name,content}] }]  registry mode (supports switching)
//
// Single-vault mode sets WASHI_TEST_NOTES_DIR so resolveNotesDir() returns the
// temp dir directly. Registry mode instead pre-seeds <userData>/vaults.json and
// leaves the env var UNSET, so the real resolveNotesDir() path drives boot and
// vault switching survives a reload — that is the behavior vault-isolation.spec
// needs to characterize.
async function launchApp(opts) {
  opts = opts || {};
  const dirs = [];
  const userData = mkTmp('washi-ud-');
  dirs.push(userData);
  const env = Object.assign({}, process.env);
  env.WASHI_TEST = '1';
  if (opts.collab) env.WASHI_TEST_COLLAB = '1';        // phase 6c-2: force the Y.Doc-backed editor on
  if (opts.stubEngine) env.WASHI_TEST_ENGINE = '1';   // chat spec: route engine:run to the canned stub
  if (opts.stubEmbed) env.WASHI_TEST_EMBED = '1';     // semantic spec: deterministic offline embedder (no network)
  let notesDir;

  if (Array.isArray(opts.vaults) && opts.vaults.length) {
    const recents = [];
    opts.vaults.forEach((v) => {
      const vdir = mkTmp('washi-vault-');
      dirs.push(vdir);
      if (Array.isArray(v.notes)) v.notes.forEach((n) => writeNote(vdir, n.name, n.content));
      recents.push({ path: vdir, name: v.name || path.basename(vdir) });
    });
    notesDir = recents[0].path; // boot on the first vault
    fs.writeFileSync(
      path.join(userData, 'vaults.json'),
      JSON.stringify({ current: notesDir, recents }, null, 2),
      'utf8'
    );
    // Deliberately do NOT set WASHI_TEST_NOTES_DIR: the registry must drive
    // resolveNotesDir() so a vault switch can take effect after reload.
  } else {
    notesDir = mkTmp('washi-notes-');
    dirs.push(notesDir);
    if (Array.isArray(opts.notes)) opts.notes.forEach((n) => writeNote(notesDir, n.name, n.content));
    env.WASHI_TEST_NOTES_DIR = notesDir;
  }

  const app = await electron.launch({
    args: ['.', '--user-data-dir=' + userData],
    env,
    cwd: process.cwd(),
  });
  const page = await app.firstWindow();
  // Auto-dismiss native alert() dialogs the app may raise (e.g. duplicate-name
  // rejection). Custom modals (askName / confirmDelete) are DOM-based, unaffected.
  page.on('dialog', async (d) => { try { await d.accept(); } catch (_) {} });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#noteList').waitFor();

  return { app, page, notesDir, userData, dirs };
}

async function teardown(ctx) {
  if (!ctx) return;
  try {
    if (ctx.app) {
      // don't let a hung close() consume the whole worker-teardown budget
      await Promise.race([ ctx.app.close(), new Promise((r) => setTimeout(r, 8000)) ]);
    }
  } catch (_) {}
  // if the Electron process is still alive, hard-kill it so the worker can exit
  try {
    const proc = ctx.app && typeof ctx.app.process === 'function' ? ctx.app.process() : null;
    if (proc && proc.pid) { try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {} }
  } catch (_) {}
  (ctx.dirs || []).forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} });
}

// ---- UI flow helpers (verified against the REAL app DOM) ----
// All take the Electron page (ctx.page). Default UI language is Thai, so the
// footer "+ ใหม่" menu and context-menu labels are Thai strings. The old
// #newNoteBtn / #newFolderBtn / .sb-gadd buttons are display:none — everything
// is created through the #newMenuBtn footer menu now.

// Fill the DOM-based askName() modal (`.modal-card`) and confirm with the
// `.solid` (ตกลง/OK) button.
async function fillNameModal(page, name) {
  await page.locator('.modal-card input').fill(name);
  await page.locator('.modal-card button.solid').click();
}

// Open the footer "+ ใหม่" menu and pick the item whose label matches.
async function newViaMenu(page, label) {
  await page.locator('#newMenuBtn').click();
  await page.locator('.db-menu .db-mi', { hasText: label }).click();
}

async function createNote(page, name) {
  await newViaMenu(page, 'โน้ตใหม่');
  await fillNameModal(page, name);
  await expect(page.locator('#noteList .note-item', { hasText: name })).toBeVisible();
}

async function createFolder(page, name) {
  await newViaMenu(page, 'กล่องใหม่');
  await fillNameModal(page, name);
  await expect(page.locator('.folder-row', { hasText: name })).toBeVisible();
}

// sbNewDb() calls dbCreate({}) — the app assigns a DEFAULT name and auto-opens
// the table view. It does NOT prompt for a name in this build; the optional
// modal fill is kept defensively. `name` is currently unused by the app.
async function createDb(page, name) {
  await newViaMenu(page, 'ฐานข้อมูลใหม่');
  // sbNewDb may prompt a name modal — fill it if it appears, otherwise the DB
  // is created directly and the table auto-opens.
  if (await page.locator('.modal-card input').count()) await fillNameModal(page, name);
  await expect(page.locator('table.db')).toBeVisible();
}

async function rightClickNote(page, name) {
  await page.locator('#noteList .note-item', { hasText: name }).click({ button: 'right' });
}

// Click an item in whatever `.db-menu` is currently open (note / folder / db
// context menus all reuse the same `.db-menu` / `.db-mi` markup).
async function ctxItem(page, label) {
  await page.locator('.db-menu .db-mi', { hasText: label }).click();
}

async function deleteNote(page, name) {
  await rightClickNote(page, name);
  await ctxItem(page, 'ลบ');                              // matches "ลบ (ไปถังขยะ)"
  await page.locator('.modal-card button.danger').click();  // confirmDelete → red ลบ
  await expect(page.locator('#noteList .note-item', { hasText: name })).toHaveCount(0);
}

async function openTrash(page) {
  await page.locator('#trashBtn2').click();
  await expect(page.locator('#trashView')).toBeVisible();
}

// 'en' or 'th'. setUiLang() reloads the window; wait for #noteList to come back.
async function switchLanguage(page, lang) {
  await page.locator('#settingsBtn2').click();
  const label = lang === 'en' ? 'English' : 'ไทย';
  await page.locator('.settings-menu button', { hasText: label }).click();
  await page.locator('#noteList').waitFor();
}

// Switch vault via the #vaultChip dropdown; reloads the window.
// The vault menu shows each vault's DIRECTORY BASENAME (a random temp name),
// NOT the stored display name, so we can't match `.vm-nm` by `name`. With
// exactly two test vaults (current + one other), switch by clicking the
// NON-CURRENT row. `name` is kept in the signature for call-site compatibility.
// ponytail: name param now unused; re-enable name-based matching if a test
// ever needs >2 vaults.
async function switchVault(page, name) {
  await page.locator('#vaultChip').click();
  await expect(page.locator('.vault-menu')).toBeVisible();
  await page.locator('.vault-menu .vm-row:not(.is-current)').first().click();
  await page.locator('#noteList').waitFor();
}

module.exports = {
  launchApp, teardown, writeNote, mkTmp,
  fillNameModal, newViaMenu, createNote, createFolder, createDb,
  rightClickNote, ctxItem, deleteNote, openTrash, switchLanguage, switchVault,
};
