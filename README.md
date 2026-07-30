# Washi (和紙)

A local-first, washi-paper-themed study-notes desktop app — Obsidian × Notion with an embedded AI assistant.

Washi is a desktop note-taking app for macOS that keeps everything as plain Markdown files on your own machine. It pairs a Notion-style WYSIWYG editor with Obsidian-style vaults, wikilinks, and a knowledge graph, and bolts on an optional AI assistant that runs through CLIs you already have on your PATH. The flat, cut-paper aesthetic is inspired by traditional Japanese washi paper, in both light and dark themes.

## Screenshots

> _Add screenshots / a demo GIF here._

## Features

- **WYSIWYG Markdown editor** — Notion-style: slash menu, tables that stay grids, callouts, collapsible headings.
- **`[[wikilinks]]`** — with autocomplete, backlinks, and create-on-click for broken links.
- **Crates (กล่อง)** — folders re-imagined as "crates" with nested drag-and-drop and a crate overview.
- **Tags & properties** — `#tags` plus YAML frontmatter properties (status, tags).
- **Full-text search** across the vault.
- **PDF reader** — highlights, text boxes, and a paired "companion note" per PDF.
- **Databases** — Notion-like, with 6 column types (incl. relations) and 5 views: table / board / calendar / gallery / chart.
- **Dashboards** — customizable per-vault dashboards.
- **Knowledge graph** — a corkboard-and-string view of your notes and links.
- **Flashcards** — spaced repetition with the SM-2 algorithm.
- **AI assistant** — multi-session chat, inline AI edits with per-hunk diff review, auto-linking, TL;DR, quiz generation, and floating side-chats.
- **Trash** — deleted items go to a Trash folder with restore support.
- **Multiple vaults** — Obsidian-style, with fully isolated per-vault data.
- **Thai / English UI toggle.**
- **Washi design** — a flat, cut-paper aesthetic with light and dark themes.

## Requirements

- **macOS** (Apple Silicon / arm64).
- **Node.js 18+** to build from source.
- For **AI features**: the [`opencode`](https://github.com/sst/opencode) CLI (for GLM / Z.ai models, the default engine) and/or the `claude` CLI, installed and logged in.
- AI is **optional** — without the CLIs, the app is a full notes app minus the AI actions.

## Install (prebuilt)

1. Download the `.dmg` from the **Releases** page.
2. Drag **Washi** into **Applications**.

> **macOS Gatekeeper note.** Washi is not yet code-signed or notarized. On first launch, macOS may say it "can't be opened." To get past it:
> - Right-click the app → **Open** (once), and confirm; **or**
> - Run `xattr -cr /Applications/Washi.app` in Terminal.

## Build from source

```bash
git clone <your-repo-url>
cd study-notes-claude
npm install
npm run rebuild        # rebuild node-pty for Electron
npm start              # run in dev
npm run dmg            # or: npm run dist  (build the app)
```

- `npm start` — run in dev.
- `npm run rebuild` — rebuild node-pty for Electron (run after `npm install`).
- `npm run dist` — build an unsigned `.app` into `dist/mac-arm64`.
- `npm run dmg` — build a `.dmg`.

## AI setup

The app spawns **`opencode`** (the default, for GLM / Z.ai models) or **`claude`** from your `PATH`, running in your vault folder.

1. Install and authenticate whichever engine(s) you want (see the **opencode** / **Claude CLI** docs for setup).
2. In the app, pick the engine + model per chat session.

If neither CLI is installed, the app still works as a plain notes app; AI actions just report an error.

## Privacy

- Notes are local Markdown files and **never leave your machine on their own**.
- AI actions send the relevant note text (or your message) to whichever provider you configured (GLM / Z.ai via opencode, or Anthropic via Claude) through that CLI.
- **No analytics, no telemetry.**

## Project layout

```
main.js        # Electron main process: window lifecycle, IPC, file/vault operations
preload.js     # IPC bridge between main and renderer (contextBridge)
renderer/      # UI: index.html, renderer.js, styles.css, vendored Crepe + pdf.js
build/         # app icon assets
notes/         # sample notes seeded into a new vault on first run
```

## Known limitations / roadmap

- Not code-signed yet (planned — enables a smoother Gatekeeper experience).
- **macOS only** for now (Windows / Linux later).
- AI requires an external CLI (opencode or claude).
- Dark-mode editor theming is partial.

## License

MIT — see [LICENSE](LICENSE).
