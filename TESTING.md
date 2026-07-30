# Testing

A characterization test suite that locks in the app's **current** behavior
*before* the refactor, so later phases can be verified against it. Phase 1 adds
the safety net only — it does **not** change app behavior (the sole app-code
change is the env-guarded `WASHI_TEST_NOTES_DIR` hook in `main.js`).

## Run

```bash
npm install        # installs vitest + @playwright/test (+ playwright browsers on first run)
npm test           # vitest unit tests (tests/unit/**)
npm run test:e2e   # Playwright Electron E2E tests (tests/e2e/**)
npm run test:all   # both
```

> First-time Playwright run may need its browser binaries:
> `npx playwright install` (Electron support ships with `@playwright/test`).
> `node-pty` must be rebuilt for the installed Electron version:
> `npm run rebuild` (already part of normal dev setup).

## Temp-vault isolation guarantee (non-negotiable)

Tests drive the **real** app, which reads and writes notes — so every test runs
against a **fresh temp vault + fresh temp Electron userData**, created under
`os.tmpdir()` and removed in `afterEach`. **No test ever touches
`~/Documents/StudyNotes` or your real Electron userData.**

See `tests/e2e/helpers.js`:

- Each `launchApp()` makes a unique temp notes dir + temp userData dir.
- Single-vault tests set `WASHI_TEST_NOTES_DIR`, which the guarded hook in
  `main.js#resolveNotesDir()` honors to bypass the registry + default seeding.
- `vault-isolation.spec` instead pre-seeds `<tmp-userData>/vaults.json` and
  leaves the env var unset, so the real `resolveNotesDir()` + `vault:switch`
  path is exercised (switching survives a reload).
- `teardown()` closes the app and `rm -rf`s both temp dirs.

## Layers

- **Unit** (`tests/unit/`): runner-wiring smoke test only. Real unit coverage
  lands in **Phase 2** once pure logic is extracted out of `renderer.js` /
  `main.js` into an importable `core/`.
- **E2E** (`tests/e2e/`): Playwright driving the packaged Electron app. Each spec
  has a HAPPY case and at least one EDGE case:
  - `notes.spec.js` — create / open / save; duplicate-name rejection; delete.
  - `crates.spec.js` — create box + nested note; crate overview; empty-state.
  - `search.spec.js` — match + open; no-results.
  - `database.spec.js` — create + sidebar; cell edit persists; empty shell.
  - `vault-isolation.spec.js` — A↔B switch shows the right notes; no leakage.
  - `trash.spec.js` — delete → trash → restore; partial restore.
  - `i18n.spec.js` — Thai↔English label round-trip.
  - `ai.spec.js.todo` — AI/engine flows deferred to a later phase (stubbed engine).
