<p align="center">
  <img src="renderer/logo.png" width="96" alt="Kumiko logo">
</p>

<h1 align="center">Kumiko (組子)</h1>

<p align="center">
  A local-first study-notes app — Markdown notes × PDF reading × an AI that actually edits your notes.<br>
  <em>Built Thai-first 🇹🇭 · works fully in English too.</em>
</p>

<p align="center">
  <a href="https://aquoracore.com/kumiko"><strong>aquoracore.com/kumiko</strong></a> · a product of <a href="https://aquoracore.com">Aquora</a>
</p>

---

![Notes with a live diagram and the AI side chat](docs/screenshots/editor.png)

## Features

- **WYSIWYG Markdown notes** — Notion-style editing: slash menu, tables, colored callouts, `[[wikilinks]]` with backlinks, nested colored tags, full-vault search
- **Databases, dashboards, graph, flashcards** — databases with 6 column types and 5 views (table / board / calendar / gallery / chart), per-vault dashboards, a link graph, and SM-2 spaced repetition
- **A real PDF reader** — highlight and place sticky notes on lecture slides, capture any page as an image *with your annotations burned in* straight into a note, and it remembers where you left off
- **An AI that edits, not just chats** — creates notes, edits them through a per-hunk review UI (you accept / tweak / discard every change), tags your vault, arranges Canvas boards, searches everything with tiered RAG, and keeps a per-vault memory plus a cross-vault profile. Runs on the CLI subscriptions you already have (**Claude Code**, **OpenCode + GLM**, or **Gemini CLI**) or a plain API key
- **Kumiko Canvas** — a summary board: pull full *sections* of notes onto cards, drag and resize them, wire sections together (suggested wires grow automatically from the `[[wikilinks]]` already in your content), keep multiple boards, or just ask the AI to arrange one
- **Plain files, forever** — every note is a `.md` file and every image a real file in your own folder, with automatic version history. No account, no cloud lock-in
- **30 authentic kumiko patterns** — background themes drawn from Japanese woodwork lattices (asanoha, sakura-goshi, shippō, …), light and dark
- **Self-hostable web server** *(experimental)* — the same UI from a browser or phone · [self-hosting guide](docs/SELF-HOSTING.md)
- Thai ⇄ English UI toggle · multiple isolated vaults · restorable trash

![Kumiko Canvas — an exam-prep board](docs/screenshots/canvas.png)

## Install (macOS, Apple Silicon)

[**Download the DMG**](https://github.com/AquoraCore/kumiko/releases/latest/download/Kumiko-mac-arm64.dmg), open it, and drag **Kumiko** into Applications. The app isn't notarized yet — on first launch use **right-click → Open**, or:

```bash
xattr -dr com.apple.quarantine /Applications/Kumiko.app
```

Or build from source (Node.js 20+):

```bash
git clone https://github.com/AquoraCore/kumiko.git
cd kumiko
npm install
npm run dist
open dist/mac-arm64/Kumiko.app
```

Later updates are one click from inside the app (Settings → About).

**AI modes** (pick one in Settings — without any of them Kumiko is still a complete notes + PDF app):

| Mode | You need |
|---|---|
| CLI (recommended) | [Claude Code](https://claude.com/claude-code), [OpenCode](https://opencode.ai) + GLM Coding Plan, or [Gemini CLI](https://github.com/google-gemini/gemini-cli) (free with a Google account), already logged in |
| API key | An Anthropic / OpenAI-compatible key, entered in the app |
| Managed | A self-hosted Kumiko server that holds the key for its users |

## ภาษาไทย (ย่อ)

Kumiko คือแอปจดโน้ตสำหรับคนเรียนหนังสือที่คิดเป็นภาษาไทยตั้งแต่แรก — โน้ต Markdown แบบ WYSIWYG พร้อม `[[wikilink]]`/แท็ก/ฐานข้อมูล/flashcards, ตัวอ่าน PDF ที่แคปสไลด์พร้อมเผาไฮไลต์และโน้ตลงภาพได้, และ AI ที่**แก้โน้ตให้จริงผ่านหน้ารีวิวทีละท่อน** (ใช้ Claude Code / OpenCode CLI ที่มีอยู่แล้ว หรือ API key), Kumiko Canvas บอร์ดสรุปที่หยิบท่อนโน้ตมาวางเป็นการ์ดแล้วเส้นเชื่อมงอกเองจากลิงก์ในเนื้อหา — ทุกอย่างเป็นไฟล์ `.md` ในเครื่องคุณเอง มีประวัติเวอร์ชันอัตโนมัติ ไม่ต้องล็อกอิน

ติดตั้ง: โหลด zip จากหน้า [Releases](https://github.com/AquoraCore/kumiko/releases) → ลากไป Applications → เปิดครั้งแรกให้คลิกขวา → Open (แอปยังไม่ได้ notarize)

## Development

```bash
npm test          # vitest — 800+ unit tests
npm start         # run unpackaged (dev)
npm run server    # self-hosted web server (PORT, DATA_DIR, AUTH_SECRET)
```

Just want to try the server? One command, no build: `docker run -d -p 4321:4321 -v ./kumiko-data:/data ghcr.io/aquoracore/kumiko` → http://localhost:4321 — see [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md).

## License

[AGPL-3.0](LICENSE) — free to use, modify, and self-host; if you distribute a modified version **or run one as a network service**, you must share your changes under the same license. Interested in a commercial license or managed hosting? Open an issue to get in touch.
