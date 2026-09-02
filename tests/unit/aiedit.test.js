import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');

// "Let the AI edit this note" feature (select text → action button → AI edits the file →
// chokidar watcher → per-hunk accept/edit/discard review). It silently vanished once because
// the CLI spawn lost its cwd, so the AI ran in the app dir, never found the note, edited
// nothing, and the watcher never fired. These guards keep every link of that chain intact.
describe('AI note-edit + accept-review chain', () => {
  const main = read('main.js');
  const renderer = read('renderer/renderer.js');

  it('spawns the CLI with cwd = NOTES_DIR so it can open the note by {file} name', () => {
    // the regression that broke the feature: spawn without cwd
    expect(main).toMatch(/spawn\(bin, inv\.args, \{[^}]*cwd:\s*NOTES_DIR[^}]*\}\)/);
  });

  it('action-bar prompts tell the AI to edit the file by name ({file})', () => {
    expect(renderer).toContain('{file}');
    expect(renderer).toMatch(/fillPrompt\(btn\.dataset\.act, sel, currentNote\)/);
    // runEngineAction flushes the editor to disk first (so the AI edits the latest), then runs
    const rea = renderer.slice(renderer.indexOf('async function runEngineAction'), renderer.indexOf('async function runEngineAction') + 700);
    expect(rea).toContain('await save()');
    expect(rea).toContain('window.api.runEngine(');
  });

  it('the chokidar watcher reviews the OPEN file and flags everything else', () => {
    expect(main).toContain("chokidar.watch(NOTES_DIR");
    expect(main).toContain("win.webContents.send('note:changed'");
    expect(main).toMatch(/const isOpen = openFilePath && path\.resolve\(p\) === path\.resolve\(openFilePath\)/);
  });

  it('the renderer opens the per-hunk accept review when the file changes', () => {
    expect(renderer).toContain('window.api.onNoteChanged');
    expect(renderer).toContain('openDiffReview(currentNote');
  });
});

// "แทนที่ทั้งโน้ต" (Apply-to-note): mode-agnostic AI note editing — a button on each AI reply
// applies it as the WHOLE note via the SAME review card. Works in API/cloud mode (which can't
// edit files) because it operates on the reply text + the app's own saveNote path.
describe('Apply-to-note (แทนที่ทั้งโน้ต) works in every engine mode', () => {
  const renderer = read('renderer/renderer.js');
  const chat = read('renderer/chat.js');

  it('opens the review AUTOMATICALLY on turn end — no apply button to press first', () => {
    expect(chat).toContain('maybeAutoReviewReply');
    // the old friction button is gone: the AI editing must feel like the CLI path
    expect(chat).not.toContain("'m-apply'");
  });

  it('tells the AI it CAN edit (else it truthfully answers "I cannot edit files")', () => {
    expect(renderer).toContain('function noteEditCapabilityPrompt');
    expect(renderer).toContain('ห้ามตอบว่าคุณแก้ไฟล์ไม่ได้');
    expect(renderer).toContain('noteEditCapabilityPrompt()');
    expect(renderer).toContain('window.CoreMarkdown.NOTE_OPEN');
  });

  it('auto path never interrupts with alerts, and never stacks on an open review', () => {
    expect(renderer).toContain('applyReplyToNote(r.body, { silent: true })');
    expect(renderer).toMatch(/maybeAutoReviewReply[\s\S]{0,400}if \(suggestActive\) return;/);
  });

  it('hides the emitted note body from the chat bubble', () => {
    expect(chat).toContain('function chatDisplayText');
    expect(chat).toContain('mdToHtml(chatDisplayText(');
  });

  it('applyReplyToNote preserves frontmatter and routes through the review card', () => {
    const fn = renderer.slice(renderer.indexOf('function applyReplyToNote'), renderer.indexOf('function applyReplyToNote') + 1000);
    expect(fn).toContain('stripMdFence');                       // unwrap a ```markdown fence
    expect(fn).toContain('serializeFrontmatter(currentAttrs'); // keep status/tags
    expect(fn).toContain('openDiffReview(currentNote');         // user reviews before applying
  });
});

// Regression 2026-08-18: hiding the streamed note body froze the chat bubble on one short line
// for the whole write — the AI looked like it "worked a long time then died".
describe('a streaming note-edit shows progress instead of freezing', () => {
  const chat = read('renderer/chat.js');
  const renderer = read('renderer/renderer.js');

  it('chatDisplayText takes a streaming flag and reports the growing body', () => {
    expect(chat).toContain('function chatDisplayText(s, streaming)');
    expect(chat).toContain('if (streaming) return head');
    expect(chat).toContain('r.body.length');
  });

  it('both render paths pass the streaming state', () => {
    expect(chat).toContain('chatDisplayText(m.text, running)');       // live token stream (renderLive)
    expect(chat).toContain('chatDisplayText(m.text, running)');   // re-render while running
  });

  it('the OPEN document is injected as RELEVANT PASSAGES, not whole and not head-truncated', () => {
    expect(renderer).toContain('p1Budget');   // tunable budget, not a hardcoded cap
    expect(renderer).toContain('window.CoreRag.selectPassages');   // relevance, not slice()
    // both P1 injection points (open note + open PDF) must pass the QUESTION so passages can rank
    expect((renderer.match(/\+ _clipP1\(body, question\)/g) || []).length).toBe(2);
  });
});

// 2026-08-18 batch: wikilink wrap, quote-to-chat, @-mentions, red review-dots.
describe('editor + chat interaction features', () => {
  const entry = read('build/crepe-entry.js');
  const renderer = read('renderer/renderer.js');
  const sidebar = read('renderer/sidebar.js');
  const main2 = read('main.js');

  it('select + [ wraps the selection as a [[wikilink]] (Obsidian-style)', () => {
    expect(entry).toContain('handleTextInput(view, from, to, text)');
    expect(entry).toMatch(/insertText\('\[\[' \+ sel \+ '\]\]', from, to\)/);
    // never fires on an empty selection or when brackets are already present
    expect(entry).toContain("if (text !== '[' || from === to) return false;");
  });

  it('the toolbar sparkle button quotes the selection into the chat input', () => {
    expect(renderer).toContain('function quoteToChat');
    expect(renderer).toContain("['sparkle', 'อ้างอิงข้อความนี้ในแชต AI'");
    expect(renderer).not.toContain("'อธิบายด้วย AI'");
  });

  it('@-mention: autocomplete over vault notes, parsed and injected as TOP priority', () => {
    expect(renderer).toContain('function parseAtRefs');
    expect(renderer).toContain("buildPriorityContext(msg, parseAtRefs(msg))");
    expect(renderer).toContain('อ้างอิงโดยผู้ใช้ — @');
    // with the menu open, Enter confirms the pick instead of sending the message
    expect(renderer).toMatch(/if \(e\.key === 'Enter' && !e\.shiftKey\) \{ e\.preventDefault\(\); _atPick\(\); return; \}/);
    expect(sidebar).toContain('window.__wlNoteRel');
  });

  it('AI edits to NON-open notes get flagged (red dot), gated to engine activity', () => {
    expect(main2).toContain("win.webContents.send('note:flagged'");
    expect(main2).toContain('_lastEngineExit');
    expect(main2).toMatch(/engineProcs\.size > 0 \|\| Date\.now\(\) - _lastEngineExit < 10000/);
    expect(renderer).toContain('window.__flaggedNotes = new _PSet()');
    expect(sidebar).toContain("dot.className = 'review-dot'");
    // opening the note clears the flag
    expect(sidebar).toMatch(/__flaggedNotes\.delete\(name\)/);
  });
});

// ===PDF-CLIP=== end-to-end wiring: capability told to the AI, executed on turn end,
// rendered offscreen (works for unrendered pages), hidden from the chat bubble.
describe('AI slide-clip (===PDF-CLIP===) chain', () => {
  const renderer2 = read('renderer/renderer.js');
  const chat2 = read('renderer/chat.js');
  const pdf2 = read('renderer/pdf.js');

  it('the AI is told about the clip capability only while a PDF is open', () => {
    expect(renderer2).toContain('function pdfClipCapabilityPrompt');
    expect(renderer2).toMatch(/pdfClipCapabilityPrompt\(\)\{\n  if \(!\(typeof currentPdf === 'string' && currentPdf\)\) return '';/);
    // wired into BOTH prompt branches + the tool-continuation prompt (2026-08-19)
    expect((renderer2.match(/noteEditCapabilityPrompt\(\) \+ pdfClipCapabilityPrompt\(\)/g) || []).length).toBe(3);
  });

  it('commands run on turn end and each page renders OFFSCREEN', () => {
    expect(chat2).toContain('maybeClipPdfPages(last.text');
    expect(renderer2).toContain('function maybeClipPdfPages');
    expect(pdf2).toContain('async function renderPdfClipMarkdown');
    expect(pdf2).toContain("toDataURL('image/jpeg'");
    // the standalone-clip path appends via appendCaptureToTarget (page notes + attribution)
    expect(pdf2).toContain('await appendCaptureToTarget(r.md, r.page)');
    // manual crop-to-image was REMOVED (2026-08-18) — the drag tool is area-highlight only now
    expect(pdf2).not.toContain('appendImageToTarget');
    expect(pdf2).not.toContain('captureCrop');
  });

  // 2026-08-18 routing fix ("แนบรูปแล้วเข้าโน้ต DFD เสมอ"): a clip marker INSIDE a note block
  // goes into THAT note at the marker's position; only standalone markers go to the target.
  it('in-block clips resolve into the note body; the executor only sees standalone clips', () => {
    // standalone executor scopes its parse to the text OUTSIDE note blocks
    expect(renderer2).toMatch(/stripNoteBlocks\(text\)/);
    // in-block markers are replaced by the rendered image + attribution in EVERY apply path
    expect(renderer2).toContain('async function resolvePdfClipMarkers');
    expect(renderer2).toContain('r.body = await resolvePdfClipMarkers(r.body)');           // open + named notes
    expect(renderer2).toContain('await resolvePdfClipMarkers(sec.body)');                  // section edits
    expect(renderer2).toContain('await resolvePdfClipMarkers(n.body)');                    // new notes
    // a failed render REMOVES the marker line — protocol text must never leak into a note
    expect(renderer2).toMatch(/lines\[i\] = rep;/);
    // the AI is told placement matters
    expect(renderer2).toContain('ตำแหน่งของบรรทัดนี้สำคัญ');
  });

  it('capture toasts NAME the destination and offer "เปลี่ยนโน้ต" (target was invisible + unchangeable)', () => {
    expect(pdf2).toContain('function captureTargetLabel');
    expect(renderer2).toContain("label: t('เปลี่ยนโน้ต')");
    expect(pdf2).toContain("label: t('เปลี่ยนโน้ต')");
    // PDF right-click menu re-opens the picker any time
    expect(pdf2).toContain('โน้ตเป้าหมาย (ที่เก็บไฮไลต์/สไลด์)…');
  });

  it('an empty engine reply becomes a visible failure line, not a blank bubble', () => {
    expect(chat2).toContain('engine ไม่ตอบกลับ');
    // legacy empty bubbles saved by older builds are repaired at load
    expect(chat2).toMatch(/m\.role === 'ai' && !\(m\.text \|\| ''\)\.trim\(\)/);
  });

  it('prompt: the latest user instruction overrides older ones in history', () => {
    expect(renderer2).toContain('ยึดคำสั่งล่าสุดของผู้ใช้เป็นหลัก');
  });

  it('command lines are hidden from the chat bubble, replaced by a human line', () => {
    expect(chat2).toContain('extractPdfClips(s)');
    expect(chat2).toContain('แปะสไลด์หน้า');
  });
});

// @-references are clickable + the @-menu is keyboard-navigable (↑↓, Tab/Enter, Esc)
describe('clickable refs + @-menu keyboard', () => {
  const chat3 = read('renderer/chat.js');
  const renderer3 = read('renderer/renderer.js');
  const sidebar3 = read('renderer/sidebar.js');

  it('all three bubble render paths pass through linkifyRefs', () => {
    expect(chat3).toContain('_linkify(mdToHtml(chatDisplayText(m.text, running)))');
    expect(chat3).toContain('_linkify(mdToHtml(chatDisplayText(m.text, running)))');
    expect(chat3).toContain('_linkify(window.CoreMarkdown._mdEsc(m.text))');   // user bubble, escaped first
  });

  it('clicking a ref navigates: note first, PDF fallback', () => {
    expect(chat3).toContain("closest('.at-ref')");
    expect(chat3).toContain('openNote(noteRel)');
    expect(chat3).toContain('openPdf(pdfRel)');
    expect(sidebar3).toContain('window.__wlPdfRel');
  });

  it('the @-menu supports ArrowUp/ArrowDown, Tab + Enter confirm, Esc close', () => {
    expect(renderer3).toContain("e.key === 'ArrowDown' || e.key === 'ArrowUp'");
    expect(renderer3).toMatch(/if \(e\.key === 'Tab'\) \{ e\.preventDefault\(\); _atPick\(\); return; \}/);
    expect(renderer3).toContain("if (e.key === 'Escape')");
    expect(renderer3).toContain('function _atMove(dir)');
    // wrap-around navigation
    expect(renderer3).toContain('(i + dir + items.length) % items.length');
  });
});

// The AI can CREATE notes, not only edit the open one (user: "บอกให้สร้างหน้าใหม่ แต่ AI ยัดใส่หน้าที่เปิด")
describe('AI new-note (===NEW-NOTE===) chain', () => {
  const renderer4 = read('renderer/renderer.js');
  const chat4 = read('renderer/chat.js');

  it('the capability prompt offers CREATE always, and forbids stuffing the open note', () => {
    expect(renderer4).toContain('===NEW-NOTE name=โฟลเดอร์/ชื่อโน้ต===');   // folder-aware since 2026-08-19
    expect(renderer4).toContain('ห้ามยัดเนื้อหาลงโน้ตที่เปิดอยู่');
    // create is always offered; only the open-note line inside the edit rules is gated
    expect(renderer4).toContain('return create + edit;');
    expect(renderer4).toMatch(/currentNote \? '- เขียนโน้ตที่เปิดอยู่ใหม่ทั้งฉบับ/);   // whole-file line, still gated on an open note
  });

  it('executor creates uniquified notes WITHOUT switching the view (red dot marks them)', () => {
    expect(renderer4).toContain('function maybeCreateNewNotes');
    // uniquified against REL paths (per-folder) since folder-aware creation, 2026-08-19
    expect(renderer4).toMatch(/while \(existing\.has\(\(final \+ '\.md'\)\.toLowerCase\(\)\)\) final = base \+ ' ' \+ \(i\+\+\)/);
    expect(renderer4).toContain('refreshList(firstRel, { keepView: true })');
    expect(renderer4).toMatch(/__flaggedNotes\.add\(final \+ '\.md'\)/);
    expect(chat4).toContain('maybeCreateNewNotes(last.text');
  });

  it('the bubble shows a created line instead of the raw block', () => {
    expect(chat4).toContain('extractNewNotes(s)');
    expect(chat4).toContain('สร้างโน้ตใหม่');
  });
});

// Companion note cancelled (2026-08-18, user decision): captures go to a user-chosen TARGET
// topic note instead — "1 โน้ต = 1 เรื่อง", with a source-attribution line per capture.
describe('capture-target replaces the companion note', () => {
  const pdf3 = read('renderer/pdf.js');
  const sidebar3 = read('renderer/sidebar.js');

  it('target is sticky per PDF, with the legacy companion as the initial fallback', () => {
    expect(pdf3).toContain('function captureTargetRel');
    expect(pdf3).toContain('pdfAnnots.captureTarget || pdfAnnots.companion');
    expect(pdf3).toContain('function setCaptureTarget');
  });

  it('no capture invents a destination — missing target opens the picker instead', () => {
    expect(pdf3).toContain('function requireCaptureTarget');
    expect(pdf3).toContain('openCaptureTargetMenu(null)');   // contextual, no toolbar button
    expect(pdf3).not.toContain('pdfNoteBtn');                 // the old companion button is gone
    expect(read('renderer/index.html')).not.toContain('pdfNoteBtn');
    // every capture path funnels through the ONE attributed append
    expect(pdf3).toContain('async function appendCaptureToTarget');
    expect((pdf3.match(/appendCaptureToTarget\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('captures carry a JUMP-BACK attribution link, not per-source page headings', () => {
    expect(pdf3).toContain("[[' + currentPdf + '#p' + page");
    expect(pdf3).not.toContain("'### หน้า '");
  });

  it('the picker can create a new topic note in place (1 เรื่อง 1 โน้ต)', () => {
    expect(pdf3).toContain('สร้างโน้ตใหม่: ');
  });

  it('auto-creation and sidebar pairing are gone; legacy notes become ordinary notes', () => {
    expect(pdf3).not.toContain('ensureCompanionNote');
    expect(sidebar3).not.toContain('โน้ตของเล่มนี้');
    expect(sidebar3).not.toContain('companionOf');
    expect(sidebar3).not.toContain('has-companion');
  });
});

// @[Name] shows as a hyperlink WHILE TYPING (transparent-text + backdrop technique), and every
// trace of the cancelled companion note is gone from UI strings and logic.
describe('live @-hyperlink in the chat input + companion sweep', () => {
  const renderer5 = read('renderer/renderer.js');
  const pdf5 = read('renderer/pdf.js');

  it('backdrop renders the SAME characters (color-only styling keeps the caret aligned)', () => {
    expect(renderer5).toContain('function renderChatInputHl');
    // same chars: @[ + name + ] all rendered, never substituted
    expect(renderer5).toContain('<span class="tok-br">@[</span><span class="tok-nm">$1</span><span class="tok-br">]</span>');
    expect(read('renderer/index.html')).toContain('chatInputHl');
    expect(read('web/index.html')).toContain('chatInputHl');
    const css = read('renderer/styles.css');
    expect(css).toContain('caret-color: var(--text)');
    expect(css).toMatch(/\.chat-input textarea \{[^}]*color: transparent/);
  });

  it('no companion-note wording or logic remains anywhere the user or AI can see', () => {
    // the only allowed mention is the prompt line telling the AI the feature is GONE
    const strip = (x) => x.replace(/หมายเหตุ: ระบบไม่มี "โน้ตคู่หู"[^\n]*/g, '');
    expect(strip(renderer5)).not.toContain('คู่หู');
    expect(pdf5).not.toContain('คู่หู');
    expect(pdf5).not.toContain('companionNoteName');
    expect(read('renderer/chat.js')).not.toContain('คู่หู');
    // moving a PDF no longer drags a companion note along
    expect(pdf5).not.toMatch(/movePdf[\s\S]{0,400}renameNote/);
  });
});

// Plain @Name mentions + named-note editing (fixes: "@[] ยังครอบอยู่", "text ซ้อนหลัง enter",
// and "AI แก้แต่โน้ตที่เปิด ทั้งที่บอกให้แก้โน้ตอื่น")
describe('plain @Name + named-note UPDATED channel', () => {
  const renderer6 = read('renderer/renderer.js');
  const chat6 = read('renderer/chat.js');

  it('picker inserts @Name (no brackets) and parseAtRefs matches known names longest-first', () => {
    expect(renderer6).toContain("'\\u200B' + name + ' ' + after");   // zero-width marker: no visible @, no gap
    expect(renderer6).toMatch(/sort\(\(a, b\) => b\.length - a\.length\)/);
    expect(renderer6).toContain("s.split('@' + n).join(' ')");   // masked so @BSD Cost never re-matches @BSD
  });

  it('sending clears the input highlight backdrop (no ghost text over the placeholder)', () => {
    const sc = renderer6.slice(renderer6.indexOf('async function sendChat'), renderer6.indexOf('async function sendChat') + 600);
    expect(sc).toContain("chatInput.dispatchEvent(new Event('input'))");
  });

  it('the AI is told: an open note is NOT a reason to edit it, and how to target by name', () => {
    expect(renderer6).toContain('การที่โน้ตหนึ่งถูกเปิดอยู่ ไม่ใช่เหตุผลให้แก้มัน');
    expect(renderer6).toContain('===UPDATED-NOTE name=ชื่อโน้ต===');
  });

  it('a named target NEVER yanks the view: proposal staged + red dot, review opens on YOUR open', () => {
    expect(renderer6).toContain('async function maybeAutoReviewReply');
    expect(renderer6).toContain('window.__pendingReviews.set(rel, r.body)');
    expect(renderer6).toMatch(/if \(rel === currentNote\) \{ applyReplyToNote\(r\.body, \{ silent: true \}\); return; \}/);
    // no open-switching refresh in the named path — keepView only
    expect(renderer6).not.toMatch(/if \(r\.name\) \{[\s\S]{0,900}refreshList\(rel\);/);
    const sb = read('renderer/sidebar.js');
    expect(sb).toContain('window.__pendingReviews.get(name)');
    expect(sb).toContain("applyReplyToNote(_pending, { silent: true, baseRaw: content })");
    expect(sb).toContain('opts && opts.keepView');
    expect(chat6).toContain('p.catch(() => {})');
    expect(chat6).toContain('window.CoreMarkdown.linkifyRefs(h, window.__wlNoteNames || [])');
  });
});

// AI clips carry the page's own notes, and the attribution jumps back into the PDF
describe('clip: notes ride along + jump-back attribution', () => {
  const pdf7 = read('renderer/pdf.js');
  const renderer7 = read('renderer/renderer.js');
  const entry7 = read('build/crepe-entry.js');

  it('an AI page-clip BURNS the annotations into the image; only hl comments ride as text', () => {
    // 2026-08-25 rework: stickies + highlight fills are drawn onto the clip canvas
    // (drawPageAnnotsToCanvas) — pageNotesMarkdown now carries ONLY highlight comments,
    // which aren't visible on the page itself.
    expect(pdf7).toContain('function pageNotesMarkdown');
    expect(pdf7).toMatch(/pageNotesMarkdown\(n\)/);
    expect(pdf7).toMatch(/drawPageAnnotsToCanvas\(canvas\.getContext\('2d'\), n/);
    const notesFn = pdf7.match(/function pageNotesMarkdown[\s\S]*?\n}/)[0];
    expect(notesFn).toContain('h.note');
    expect(notesFn).not.toContain('textboxes');
  });

  it('attribution is a wikilink back to the exact PDF page', () => {
    expect(pdf7).toContain("'\\n' + markdown + '\\n\\n[[' + currentPdf + '#p' + page");
    expect(renderer7).toMatch(/match\(\/\^\(\.\+\\\.pdf\)#p\(\\d\+\)\$\/i\)/);
    expect(renderer7).toMatch(/openPdf\(rel\)/);
    expect(renderer7).toMatch(/pdfGoto\(page\)/);
  });

  it('the editor shows only the alias of [[target|alias]] (syntax hidden until caret enters)', () => {
    expect(entry7).toContain("const pipe = m[0].indexOf('|')");
    expect(entry7).toContain('pipe >= 0 ? from + pipe + 1 : from + 2');
  });
});

// "แก้หัวข้อ 4 แล้วที่เหลือหายหมด" — section channel + excerpt rule + mass-delete warning
describe('section-level edits (partial changes never wipe the note)', () => {
  const renderer8 = read('renderer/renderer.js');
  const chat8 = read('renderer/chat.js');
  it('section blocks are merged into the FULL body before the review opens', () => {
    expect(renderer8).toContain('extractSectionUpdates');
    // secBody = the section with in-block ===PDF-CLIP=== markers already resolved (2026-08-18)
    expect(renderer8).toContain('window.CoreMarkdown.replaceSection(body, sec.heading, secBody)');
    // 2026-08-19: unknown heading no longer errors — the section is APPENDED (review-gated)
    expect(renderer8).toMatch(/merged == null\) \? \(body\.replace\(\/\\s\*\$\/, ''\) \+ '\\n\\n' \+ secBody/);
  });
  it('the AI is told: partial edits use UPDATED-SECTION; "…" context forbids whole-file replace', () => {
    expect(renderer8).toContain('===UPDATED-SECTION heading=ชื่อหัวข้อ===');
    expect(renderer8).toContain('ห้ามส่งทั้งไฟล์');
    expect(renderer8).toContain('ฉบับตัดตอน ห้ามใช้ช่องทางทั้งไฟล์');
  });
  it('a whole-note replace that halves the note shows a loud warning in the review bar', () => {
    expect(renderer8).toContain('เนื้อหาหายไปมาก — ตรวจก่อนรับ');
  });
  it('bubble shows "แก้หัวข้อ: X" instead of the raw block', () => {
    expect(chat8).toContain('extractSectionUpdates(s)');
    expect(chat8).toContain('แก้หัวข้อ');
  });
});

// mermaid in the code-block picker + @ fully hidden in the input
describe('mermaid language entry + invisible @', () => {
  it('the bundle exposes a language list with mermaid FIRST, wired into both editors', () => {
    const entry8 = read('build/crepe-entry.js');
    expect(entry8).toContain("name: 'mermaid'");
    expect(entry8).toContain('window.MDCodeLangs = [mermaidCodeLang, ...cmLanguages]');
    expect(read('renderer/renderer.js')).toContain('languages: window.MDCodeLangs');
    expect(read('renderer/pdf.js')).toContain('languages: window.MDCodeLangs');
  });
  it('picked mentions carry a zero-width marker (no gap); a typed @ shows faded', () => {
    expect(read('renderer/styles.css')).toMatch(/#chatInputHl \.tok-at \{ color: var\(--accent\); opacity: \.5; \}/);
    const r = read('renderer/renderer.js');
    expect(r).toContain("s.includes('\\u200B' + n)");   // parse the picked form
  });
});

// KUMIKO.md — the user's standing work rules (2026-08-18, both phases shipped together).
// Phase 1: a per-vault KUMIKO.md note is injected into EVERY chat prompt with an explicit
// hierarchy (latest message > rules > history). Phase 2: the AI proposes rules via
// ===KUMIKO-RULE===, a confirm card gates every write, and per-hunk review outcomes are fed
// back into the next prompt (discards happen outside the chat, so the AI never saw them).
describe('KUMIKO.md standing rules', () => {
  const rendererK = read('renderer/renderer.js');
  const chatK = read('renderer/chat.js');

  it('phase 1: KUMIKO.md is read per send, capped, and injected into BOTH prompt branches', () => {
    expect(rendererK).toContain('async function kumikoRulesPrompt');
    expect(rendererK).toContain("readNote('KUMIKO.md')");
    expect(rendererK).toMatch(/s\.length > 2000/);
    expect(rendererK).toContain('ข้อความล่าสุดของผู้ใช้ > กติกานี้ > บทสนทนาก่อนหน้า');
    // wired: rules + review feedback lead both the context and no-context prompts
    expect(rendererK).toContain('const rules = await kumikoRulesPrompt()');
    expect((rendererK.match(/rules \+ mem \+ reviewFb/g) || []).length).toBe(2);   // 2026-08-25: memory layer rides next to the rules
  });

  it('phase 2: the AI is told to PROPOSE rules (sparingly) via ===KUMIKO-RULE===', () => {
    expect(rendererK).toContain('function kumikoLearnPrompt');
    expect(rendererK).toContain('===KUMIKO-RULE===');
    expect(rendererK).toContain('ห้ามใช้พร่ำเพรื่อ');
    expect((rendererK.match(/kumikoLearnPrompt\(\)/g) || []).length).toBeGreaterThanOrEqual(3);   // def + 2 branches
  });

  it('phase 2: proposals go through a confirm card — accept appends, skip discards', () => {
    expect(chatK).toContain('maybeProposeKumikoRules(last.text');
    expect(rendererK).toContain('function openKumikoRuleConfirm');
    // only the accept button writes; the card itself never auto-saves
    expect(rendererK).toMatch(/ok\.onclick = async \(\) => \{[^}]*appendKumikoRule\(r\)/);
    expect(rendererK).toContain('async function appendKumikoRule');
    expect(rendererK).toContain('## กติกาที่เรียนรู้');
    // bubble shows a human line instead of the raw block
    expect(chatK).toContain('เสนอกติกาใหม่ — ยืนยันที่การ์ดด้านล่าง');
  });

  it('phase 2: per-hunk review outcomes are recorded and injected ONCE into the next prompt', () => {
    expect(rendererK).toContain('const recordOutcome = (force)');
    expect(rendererK).toContain("vsSet('aiReviewOutcome', { acc, rej, edited");
    // all three finish paths record
    expect(rendererK).toContain('recordOutcome(null); finish(');
    expect(rendererK).toContain('recordOutcome(true); finish(');
    expect(rendererK).toContain('recordOutcome(false); finish(');
    // one-shot: cleared as soon as it is read
    expect(rendererK).toMatch(/function reviewOutcomeLine\(\)\{[\s\S]*?vsSet\('aiReviewOutcome', null\)/);
    // pure feedback (accepts only) is NOT worth a prompt line
    expect(rendererK).toMatch(/\(o\.rej \|\| 0\) \+ \(o\.edited \|\| 0\)/);
  });
});

// "Kumiko as a shared tool" (2026-08-19): the AI gets READ/SEARCH (bounded agentic loop) and
// file verbs; behavioural rules moved OUT of hardcoded prompts into a user-owned default
// KUMIKO.md. Freedom = broad capability × everything visible and undoable — the review layer
// stays; the "ห้าม" prompt shrinks.
describe('Kumiko tools (read/search loop + file verbs)', () => {
  const rendererT = read('renderer/renderer.js');
  const chatT = read('renderer/chat.js');

  it('the tools prompt documents every verb and lists the vault note names', () => {
    expect(rendererT).toContain('function kumikoToolsPrompt');
    for (const v of ['===READ-NOTE name=', '===SEARCH query=', '===RENAME-NOTE from=', '===DELETE-NOTE name=', '===SET-CAPTURE-TARGET name=']) {
      expect(rendererT).toContain(v);
    }
    expect(rendererT).toContain('โน้ตทั้งหมดใน vault: ');
    // wired into both prompt branches AND the continuation prompt
    expect((rendererT.match(/kumikoToolsPrompt\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('READ/SEARCH replies continue the SAME session with real content, bounded to 2 rounds', () => {
    expect(chatT).toMatch(/acts\.needsContinue && \(s\._toolRounds \|\| 0\) < 2/);
    expect(chatT).toContain('buildToolResults(acts)');
    expect(chatT).toContain('buildToolContinuationPrompt(');
    // an "ask" reply skips the write executors (the NEXT reply acts)
    expect(chatT).toMatch(/return;\s*\/\/ an "ask" reply never runs the write executors/);
    // a fresh user message resets the budget; a final reply resets it too
    expect(rendererT).toContain('s._toolRounds = 0;   // fresh user message');
    expect(chatT).toContain('s._toolRounds = 0;');
  });

  it('read results are capped and search rides the existing tiered RAG', () => {
    expect(rendererT).toMatch(/body\.length > 6000/);
    expect(rendererT).toMatch(/buildToolResults[\s\S]{0,2600}ragContext\(q/);
  });

  it('file verbs: rename keeps the folder, delete confirms ONCE and goes to trash', () => {
    expect(rendererT).toContain('async function runKumikoVerbs');
    expect(rendererT).toMatch(/if \(!\/\\\/\/\.test\(to\) && \/\\\/\/\.test\(from\)\)/);   // keep folder unless a path was given
    expect(rendererT).toMatch(/confirmDelete\(t\('AI ขอลบโน้ต "'\)/);
    expect(rendererT).toContain('await window.api.deleteNote(rel)');
    expect(rendererT).toMatch(/runKumikoVerbs[\s\S]{0,2200}setCaptureTarget\(rel\)/);
  });

  it('behavioural rules now live in a USER-OWNED default KUMIKO.md, seeded once', () => {
    expect(rendererT).toContain('const DEFAULT_KUMIKO');
    for (const rule of ['ยึดคำสั่งล่าสุดของผู้ใช้เป็นหลัก', 'ไม่ใช่เหตุผลให้แก้มัน', 'ห้ามใช้พร่ำเพรื่อ', 'ใช้ READ-NOTE/SEARCH ก่อน']) {
      const i = rendererT.indexOf('const DEFAULT_KUMIKO');
      expect(rendererT.slice(i, i + 1400)).toContain(rule);
    }
    // the hardcoded prompts no longer carry the moved habits (mechanics only)
    const nep = rendererT.slice(rendererT.indexOf('function noteEditCapabilityPrompt'), rendererT.indexOf('function noteEditCapabilityPrompt') + 2600);
    expect(nep).not.toContain('ยึดคำสั่งล่าสุดของผู้ใช้เป็นหลัก');
    expect(nep).not.toContain('ไม่ใช่เหตุผลให้แก้มัน');
    // seeded once per vault; a user-deleted file is respected
    expect(rendererT).toContain("vsGet('kumikoSeeded', false)");
    expect(rendererT).toContain('await ensureKumikoSeed()');
    // companion-note prompt line fully gone
    expect(rendererT).not.toContain('คู่หู');
  });

  it('the bubble shows human action lines instead of raw markers', () => {
    expect(chatT).toContain("bits.push('🔎 ' + t('อ่าน')");
    expect(chatT).toContain("bits.push('🗑 ' + t('ขอลบ')");
  });
});


// 2026-08-19 log investigation ("ทำไม AI ถึงมีพฤติกรรมแบบนั้น") — three real failures:
// 1. A hidden window stalls pdf.js rendering forever; the unbounded await inside the in-note
//    clip resolution swallowed a whole NEW-NOTE (the save never ran).
// 2. Section edits aimed at a named note were silently dropped (no name= channel).
// 3. KUMIKO.md sat in the note list (user: "อยากให้ KUMIKO.md ไม่ถูกเห็น").
describe('2026-08-19 log fixes', () => {
  const mainL = read('main.js');
  const pdfL = read('renderer/pdf.js');
  const rendererL = read('renderer/renderer.js');
  const webL = read('web/api-web.js');

  it('the window never throttles rAF (pdf.js renders finish while hidden)', () => {
    expect(mainL).toContain('backgroundThrottling: false');
  });

  it('clip renders carry a HARD timeout — a stall degrades to note-without-image, never no-note', () => {
    expect(pdfL).toMatch(/Promise\.race\(\[task\.promise[\s\S]{0,80}setTimeout/);
    expect(pdfL).toContain("return { ok: false, error: 'render-timeout' }");
    // and the in-note resolver TELLS the user instead of failing silently
    expect(rendererL).toContain('ไม่สำเร็จ — บันทึกโน้ตโดยไม่มีภาพ');
  });

  it('named section edits reach ANY note: staged as a deferred review, never dropped', () => {
    expect(rendererL).toMatch(/rel = _resolveNoteRel\(sec\.name\)/);
    expect(rendererL).toMatch(/groups\.get\(rel\)\.push\(sec\)/);
    // non-open target → pendingReviews + red dot (same governance as named whole-note edits)
    expect(rendererL).toMatch(/window\.__pendingReviews\.set\(rel, body\);\n\s*window\.__flaggedNotes\.add\(rel\)/);
    // no open note + no name → a visible toast, not a silent return
    expect(rendererL).toContain('orphanSecs.push(sec)');   // v2: stranded sections go to the picker card, not a toast drop
    // the AI is told about the name= variant
    expect(rendererL).toContain('===UPDATED-SECTION name=ชื่อโน้ต heading=ชื่อหัวข้อ===');
  });

  it('KUMIKO.md is hidden from every list on BOTH platforms, with a Settings doorway', () => {
    expect(mainL).toMatch(/ent\.name\.endsWith\('\.md'\) && rel !== 'KUMIKO\.md'/);
    expect(webL).toMatch(/filter\(function \(n\) \{ return n !== 'KUMIKO\.md' && n !== 'KUMIKO-MEMORY\.md'; \}\)/);
    expect(rendererL).toContain("kmBtn.textContent=t('เปิดแก้')");
  });
});

// 2026-08-19 part 2 — the ACTUAL "แปลก" from the log: the AI edited KUMIKO.md through the
// note channels (bypassing rule governance), and new notes always dropped at the vault root.
describe('KUMIKO.md write-protection + folder-aware creation', () => {
  const rendererF = read('renderer/renderer.js');
  const mainF = read('main.js');

  it('every AI write channel refuses KUMIKO.md — the confirm card is the only door', () => {
    expect(rendererF).toContain('function _aiProtectedName');
    // named whole-note, named/open section, new-note, rename(from+to), delete, capture-target
    expect((rendererF.match(/_aiProtectedName\(/g) || []).length).toBeGreaterThanOrEqual(8);
    expect(rendererF).toContain("if (_aiProtectedName(r.name)) { _aiProtectToast(); return; }");
    expect(rendererF).toContain('if (_aiProtectedName(currentNote)) { _aiProtectToast(); return; }');
    // and the AI is told the one hard rule
    expect(rendererF).toContain('ข้อห้าม: KUMIKO.md แก้ผ่านบล็อก KUMIKO-RULE และ KUMIKO-MEMORY.md แก้ผ่าน REMEMBER/FORGET เท่านั้น');
  });

  it('AI NEW-NOTE is folder-aware: path names allowed, bare names land in the CURRENT folder', () => {
    expect(rendererF).toContain('function currentFolder');
    expect(rendererF).toContain('function _noteRelFromName');
    expect(rendererF).toMatch(/if \(segs\.length === 1\) \{ const f = currentFolder\(\)/);
    // uniquified against REL paths (per-folder), not global basenames
    expect(rendererF).toMatch(/Object\.values\(window\.__wlNoteRel \|\| \{\}\)/);
    // the missing-target branch of a NAMED edit creates folder-aware too
    expect(rendererF).toMatch(/const base = _noteRelFromName\(r\.name\)/);
    // the AI sees the folder list + current folder, and the protocol allows a path
    expect(rendererF).toContain('===NEW-NOTE name=โฟลเดอร์/ชื่อโน้ต===');
    expect(rendererF).toContain('function _folderListLine');
    expect(rendererF).toContain('โฟลเดอร์ที่เปิดอยู่ตอนนี้: ');
    // saveNote must be able to materialise a brand-new folder
    expect(mainF).toMatch(/note:save[\s\S]{0,200}mkdirSync\(path\.dirname\(p\), \{ recursive: true \}\)/);
  });

  it('the + button opens the quick-create popover ("Option B") at the current level', () => {
    expect(rendererF).toContain('function openNewNotePopover');
    expect(rendererF).toContain("onclick = () => openNewNotePopover(document.getElementById('newNoteBtn'))");
    // the REAL visible + button is #newMenuBtn (a multi-type menu) — its "โน้ตใหม่" item must
    // open the popover anchored THERE, and a hidden/0×0 anchor falls back to the visible button
    expect(rendererF).toContain("[t('โน้ตใหม่'), () => openNewNotePopover(anchor)]");
    expect(rendererF).toMatch(/r\.width === 0 && r\.height === 0/);
    const fn = rendererF.slice(rendererF.indexOf('function openNewNotePopover'), rendererF.indexOf('function openNewNotePopover') + 7000);
    // current box is preselected; Enter creates there; explicit "กล่อง/ชื่อ" path wins
    expect(fn).toContain("let box = (typeof currentFolder === 'function') ? currentFolder() : ''");
    // 2026-08-25: "กล่อง/ชื่อ" still wins, but only for boxes that EXIST — an unknown prefix
    // means the "/" was part of the title (resolveTypedName swaps it for ⁄)
    expect(fn).toMatch(/resolveTypedName\(n0, window\.__wlFolders \|\| \[\]\)/);
    expect(fn).toMatch(/rs\.dir \? rs\.dir \+ '\/' \+ rs\.name : \(box \? box \+ '\/' \+ rs\.name : rs\.name\)/);
    // crate metaphor: chip + every switcher row use the app's crate icon
    expect((fn.match(/icoSvg\('crate'/g) || []).length).toBeGreaterThanOrEqual(2);
    // level badge + root + new-box row, per the approved design
    expect(fn).toContain("badge: t('ระดับที่เปิดอยู่')");
    expect(fn).toContain("t('Vault (ระดับบนสุด)')");
    expect(fn).toContain("t('กล่องใหม่…')");
    // Esc closes, opens upward when out of room
    expect(fn).toMatch(/e\.key === 'Escape'/);
    expect(fn).toContain('top = Math.max(8, r.top - ph - 6)');
  });
});

// 2026-08-19: PDF-Text/ (auto-extracted shadow text of every PDF — RAG machinery) is hidden
// from the surfaces the USER navigates, but must STAY in the RAG walkers or the AI goes
// blind on PDF content.
describe('PDF-Text is hidden from the user, visible to RAG', () => {
  const sidebarP = read('renderer/sidebar.js');
  const mainP = read('main.js');
  const webP = read('web/api-web.js');

  it('sidebar tree + box lists filter it; name maps stay intact for the AI', () => {
    expect(sidebarP).toMatch(/treeNotes = notes\.filter\(\(n\) => !n\.startsWith\('PDF-Text\/'\)\)/);
    expect(sidebarP).toContain("f !== 'PDF-Text'");
    expect(sidebarP).toContain('buildNoteTree(treeNotes, treeFolders, pdfs)');
    expect(sidebarP).toContain('window.__wlFolders = treeFolders.slice()');
    // the note-name maps are still built from the FULL list (READ-NOTE can reach PDF text)
    expect(sidebarP).toMatch(/window\.__wlNoteNames = \[\.\.\.new Set\(notes\.map/);
  });

  it('both graphs exclude the shadow notes', () => {
    expect(mainP).toMatch(/walkNotes\(NOTES_DIR\)\.filter\(\(f\) => !f\.startsWith\('PDF-Text\/'\)\)/);
    expect(webP).toMatch(/graphData[\s\S]{0,220}PDF-Text/);
  });

  it('the RAG walker does NOT filter PDF-Text (only KUMIKO.md is walker-hidden)', () => {
    const walk = mainP.slice(mainP.indexOf('function walkNotes'), mainP.indexOf('function walkNotes') + 900);
    expect(walk).not.toContain('PDF-Text');
    expect(walk).toContain("rel !== 'KUMIKO.md'");
  });
});

// 2026-08-19: create-alignment extends beyond notes — boxes and PDF imports also land at the
// level the user is working in. Databases/boards stay as-is (separate sections, no box tree).
describe('aligned creation: box mode + PDF import', () => {
  const rendererA = read('renderer/renderer.js');
  const mainA = read('main.js');
  const preloadA = read('preload.js');

  it('the same popover creates BOXES (kind=box): folderCreate at the selected level', () => {
    expect(rendererA).toContain("kind = kind === 'box' ? 'box' : 'note'");
    expect(rendererA).toContain('await window.api.folderCreate(target)');
    expect(rendererA).toContain("[t('กล่องใหม่'), () => openNewNotePopover(anchor, 'box')]");
    // box mode drops the redundant "กล่องใหม่…" row
    expect(rendererA).toMatch(/if \(kind !== 'box'\) mkRow\(t\('กล่องใหม่…'\)/);
  });

  it('PDF import lands in the current box on desktop; web stays flat by design', () => {
    expect(rendererA).toMatch(/window\.api\.importPdf\(\(typeof currentFolder === 'function'\) \? currentFolder\(\) : ''\)/);
    expect(preloadA).toContain("importPdf: (dir) => ipcRenderer.invoke('pdf:import', { dir: dir || '' })");
    expect(mainA).toMatch(/pdf:import[\s\S]{0,700}safeRel\(String\(\(payload && payload\.dir\) \|\| ''\)\)/);
    expect(mainA).toMatch(/return \{ name: \(dir \? dir \+ '\/' : ''\) \+ path\.basename\(dest\) \}/);
  });
});

describe('KUMIKO.md rules desk (distinct editing surface)', () => {
  const fs = require('fs'), path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  const sb = fs.readFileSync(path.join(__dirname, '../../renderer/sidebar.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('opening the rules file switches the editor into rules-mode with the header; leaving clears it', () => {
    expect(html).toMatch(/<div id="rulesHead" class="rules-head" hidden>/);
    // isRulesNote is now kumiko-only (KUMIKO-MEMORY.md shares _aiProtectedName but must NOT open the rules desk)
    expect(js).toMatch(/function isRulesNote\(name\)\{ return !!name && String\(name\)/);
    expect(sb).toMatch(/applyRulesMode\(name\)/);
    expect(js).toMatch(/if \(v!=='note'\) left\.classList\.remove\('rules-mode'\)/);
  });
  it('budget meter uses the same 2,000-char cap as the prompt injection', () => {
    expect(js).toMatch(/const RULES_BUDGET = 2000;/);
    expect(js).toMatch(/if \(s\.length > 2000\) s = s\.slice\(0, 2000\)/);
    expect(js).toMatch(/updateRulesMeter\(\);\n  \}\)\);/);   // hooked into the editor change stream
  });
  it('rules mode hides note-only chrome (title, props, backlinks, AI tools)', () => {
    expect(css).toMatch(/#left\.rules-mode #noteTitle, #left\.rules-mode #propsBar, #left\.rules-mode #backlinks, #left\.rules-mode #autolinkBar,\n#left\.rules-mode #aiMenuBtn, #left\.rules-mode #barMoreBtn \{ display: none !important; \}/);
  });
});

describe('prompt variables registry + prompts page', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('PROMPT_VARS is the single source: term/line/file/folder/today, fillPrompt substitutes all of them', () => {
    for (const k of ['term', 'line', 'file', 'folder', 'today']) expect(js).toMatch(new RegExp("\\{ key: '" + k + "'"));
    expect(js).toMatch(/PROMPT_VARS\.forEach\(\(v\) => \{ out = out\.split\('\{' \+ v\.key \+ '\}'\)\.join\(vals\[v\.key\] \|\| ''\); \}\);/);
    expect(js).toMatch(/function unknownPromptVars\(tpl\)/);
  });
  it('page: rules card, legend from PROMPT_VARS, per-card insert/reset/preview, no old modal', () => {
    expect(js).toMatch(/PROMPT_VARS\.forEach\(\(v\)=>\{\s*const chip=document\.createElement\('span'\); chip\.className='pt-var v-'\+v\.key/);
    expect(js).toMatch(/prev\.querySelector\('\.pt-pl'\)\.textContent=t\('จะส่งเป็น'\)/);
    expect(js).toMatch(/mini\.onclick=\(\)=>\{ ta\.value=DEFAULT_PROMPTS\[key\]; refresh\(\); \}/);
    expect(js).not.toMatch(/function openSettings\(\)/);
    expect(css).toMatch(/\.pt-var\.v-bad\s+\{[^}]*text-decoration: underline wavy/);
  });
});

describe('renderer scripts parse', () => {
  it('every renderer/*.js file is syntactically valid (a bad i18n entry once took t() down)', () => {
    const fs = require('fs'), path = require('path'), vm = require('vm');
    const dir = path.join(__dirname, '../../renderer');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      expect(() => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f })).not.toThrow();
    }
  });
});

describe('Z.ai Coding Plan provider is selectable; 429/1113 surfaces an actionable hint', () => {
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  const AI = require('../../core/ai.js');
  it('settings exposes zai-coding; key is shared between the two Z.ai endpoints', () => {
    expect(read('renderer/renderer.js')).toMatch(/\['zai-coding','Z\.ai Coding Plan \(GLM\)/);
    const v = AI.aiConfigView({ keys: { 'zai-coding': 'enc' } });
    expect(v.hasKey.zai).toBe(true); expect(v.hasKey['zai-coding']).toBe(true);
    expect(AI.setConfigKey({ keys: {} }, 'zai-coding', 'x').keys['zai-coding']).toBe('x');
    expect(AI.buildApiRequest('zai-coding', 'glm-5.2', 'hi', 'k').url).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
    const m = read('main.js');
    expect(m).toMatch(/const alt = provider === 'zai-coding' \? 'zai' : provider === 'zai' \? 'zai-coding' : null;/);
  });
  it('runApiProvider + testConnection read the error body and attach the hint', () => {
    const m = read('main.js');
    expect(m).toMatch(/function apiErrorHint\(provider, status, bodyText\)/);
    expect(m).toMatch(/if \(provider === 'zai' && \/1113\|balance\|resource package\/i\.test\(msg\)\) hint = ' → คีย์นี้น่าจะเป็น Z\.ai Coding Plan/);
    expect(m).toMatch(/emit\('\\r\\n\[API error ' \+ res\.status \+ '\]' \+ apiErrorHint\(provider, res\.status, bt\)/);
    expect(m).toMatch(/hint: res\.ok \? '' : apiErrorHint\(aicfg\.provider, res\.status, bt\)\.trim\(\)/);
  });
});

describe('name-less section edits with no open note (log 2026-08-24)', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  it('layer 1: READ-NOTE target becomes the implicit section target; cleared on each user send', () => {
    expect(js).toMatch(/if \(!window\.__aiReadTarget\) window\.__aiReadTarget = rel;/);
    expect(js).toMatch(/\} else if \(window\.__aiReadTarget\) \{\n          rel = window\.__aiReadTarget;/);
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/chat.js'), 'utf8')).toMatch(/window\.__aiReadTarget = null;/);
  });
  it('layer 2: prompt says name= is mandatory when the target note is not open', () => {
    expect(js).toMatch(/ถ้าโน้ตเป้าหมายไม่ได้เปิดอยู่ \(เช่น ผู้ใช้กำลังดู PDF\) ต้องใส่ name=ชื่อโน้ต เสมอ/);
  });
  it('layer 3: stranded sections open a target-picker card instead of a toast drop', () => {
    expect(js).toMatch(/orphanSecs\.push\(sec\)/);
    expect(js).toMatch(/if \(orphanSecs\.length\) openOrphanSectionCard\(orphanSecs\)/);
    expect(js).toMatch(/function openOrphanSectionCard\(secs\)/);
    expect(js).toMatch(/window\.__pendingReviews\.set\(rel, body\)/);
    expect(js).not.toMatch(/ไม่มีโน้ตเปิดอยู่ — AI ต้องระบุชื่อโน้ตที่จะแก้/);
  });
});

describe('NEW-NOTE name collision + continuation intent (log 2026-08-24 #2)', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  it('NEW-NOTE naming an existing note stages a review of that note instead of spawning "… 2"', () => {
    expect(js).toMatch(/if \(existing\.has\(\(base \+ '\.md'\)\.toLowerCase\(\)\)\) \{/);
    expect(js).toMatch(/มีโน้ตชื่อนี้อยู่แล้ว — AI เสนอเขียนทับ /);
    // uniquify still exists for genuinely-new names
    expect(js).toMatch(/while \(existing\.has\(\(final \+ '\.md'\)\.toLowerCase\(\)\)\) final = base \+ ' ' \+ \(i\+\+\);/);
  });
  it('tool continuation carries the AI own promise + a no-echo rule', () => {
    expect(js).toMatch(/function buildToolContinuationPrompt\(userMsg, results, ownPlan\)/);
    expect(js).toMatch(/สิ่งที่คุณบอกผู้ใช้ไว้ก่อนใช้เครื่องมือ/);
    expect(js).toMatch(/ห้ามคัดลอกเนื้อหาที่อ่านมาส่งกลับโดยไม่แก้/);
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/chat.js'), 'utf8')).toMatch(/\(acts\.chat \|\| ''\)\.slice\(0, 600\)/);
  });
});

describe('deferred review diffs raw-vs-raw (whole-sheet false diff, log 2026-08-24)', () => {
  const fs = require('fs'), path = require('path');
  it('openNote hands the just-read raw content to applyReplyToNote; applyReplyToNote prefers it over the editor serialization', () => {
    const sb = fs.readFileSync(path.join(__dirname, '../../renderer/sidebar.js'), 'utf8');
    expect(sb).toMatch(/applyReplyToNote\(_pending, \{ silent: true, baseRaw: content \}\)/);
    expect(sb.indexOf('baseRaw: content')).toBeGreaterThan(sb.indexOf('const content = await window.api.openNote(name)'));
    const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(js).toMatch(/const before = \(opts && opts\.baseRaw != null\) \? String\(opts\.baseRaw\) : getFullMarkdown\(\);/);
  });
});

describe('AI review state persists + NEW-NOTE gets an accept step (log 2026-08-25)', () => {
  const fs = require('fs'), path = require('path');
  const js = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  it('flags / pendings / proposals persist to vault state on every mutation and hydrate at boot', () => {
    expect(js).toMatch(/function persistAiReview\(\)/);
    expect(js).toMatch(/vsSet\('aiReviewState', \{/);
    expect(js).toMatch(/class _PSet extends Set \{ add\(v\)\{ super\.add\(v\); persistAiReview\(\);/);
    expect(js).toMatch(/window\.__flaggedNotes = new _PSet\(\);/);
    expect(js).toMatch(/window\.__pendingReviews = new _PMap\(\);/);
    expect(js).toMatch(/\(_st\.pending \|\| \[\]\)\.forEach/);
    // size guard: at most 6 pendings, 2MB each
    expect(js).toMatch(/String\(v\)\.slice\(0, 2000000\)\]\)\.slice\(0, 6\)/);
  });
  it('a NEW-NOTE is a proposal: keep/discard bar on open, discard goes to trash', () => {
    expect(js).toMatch(/window\.__newNoteProposals\.add\(final \+ '\.md'\)/);
    expect(js).toMatch(/function maybeShowNewNoteProposal\(rel\)/);
    expect(js).toMatch(/await window\.api\.deleteNote\(rel\);/);
    expect(fs.readFileSync(path.join(__dirname, '../../renderer/sidebar.js'), 'utf8')).toMatch(/maybeShowNewNoteProposal\(name\)/);
  });
});

describe('review dot bubbles up to collapsed folder rows', () => {
  it('makeFolderRow shows a dot when a flagged note hides inside a collapsed crate', () => {
    const sb = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/sidebar.js'), 'utf8');
    expect(sb).toMatch(/if \(collapsed && window\.__flaggedNotes && \[\.\.\.window\.__flaggedNotes\]\.some\(\(n\) => n\.startsWith\(node\.path \+ '\/'\)\)\)/);
  });
});

// 2026-09-01: the file-watcher review flag must NEVER fire for PDF-Text/ shadow notes — the
// background indexer rewrites them constantly, and overlapping a chat run false-flagged them
// as AI edits (4 stale review flags found in the wild).
describe('watcher flag exempts PDF-Text shadow notes', () => {
  it('main.js returns before the engine-activity flag check for PDF-Text/', () => {
    const fs2 = require('fs'); const path2 = require('path');
    const main = fs2.readFileSync(path2.join(__dirname, '../../main.js'), 'utf8');
    const i = main.indexOf("rel.startsWith('PDF-Text/')");
    const j = main.indexOf("note:flagged");
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });
});

// 2026-09-02: a NEW-NOTE created while the user is elsewhere must offer a one-click path to
// its review — a toast with "เปิดรีวิว" (jump → เก็บ/ทิ้ง banner), and the chat's 🆕 line shows
// BASE names so linkifyRefs makes them clickable.
describe('new-note notification carries a jump-to-review button', () => {
  const fs3 = require('fs'); const path3 = require('path');
  const read3 = (p) => fs3.readFileSync(path3.join(__dirname, '../../', p), 'utf8');
  it('creation toast: STICKY (stays until pressed) + เปิดรีวิว action opening the first new note', () => {
    const r = read3('renderer/renderer.js');
    expect(r).toMatch(/firstRel && currentNote !== firstRel[\s\S]{0,300}เปิดรีวิว[\s\S]{0,60}openNote\(firstRel\)/);
    expect(r).toMatch(/AI สร้างโน้ตใหม่: /);
    expect((r.match(/sticky: true, action: \{ label: t\('เปิดรีวิว'\)/g) || []).length).toBe(2);
    // the overwrite-proposal toast got the same button
    expect(r).toMatch(/เสนอเขียนทับ[\s\S]{0,200}เปิดรีวิว[\s\S]{0,60}openNote\(rel0\)/);
  });
  it('pdfToast: sticky = no auto-expiry + ✕ dismiss; chat 🆕 line uses base names (linkifiable)', () => {
    const pj = read3('renderer/pdf.js');
    expect(pj).toContain("(opts && opts.life) ||");
    expect(pj).toMatch(/opts\.sticky[\s\S]{0,300}toast-x/);
    expect(pj).toMatch(/\} else \{\n    setTimeout\(kill, life\);\n  \}/);
    expect(read3('renderer/chat.js')).toMatch(/สร้างโน้ตใหม่'\) \+ ': ' \+ nn\.notes\.map\(\(x\) => String\(x\.name \|\| ''\)\.split\('\/'\)\.pop\(\)\)/);
    const i18n = read3('renderer/i18n.js');
    expect(i18n).toContain("'เปิดรีวิว': 'Open review'");
    expect(i18n).toContain("'AI สร้างโน้ตใหม่: '");
  });
});

// 2026-09-02: the เก็บ/ทิ้ง banner shows WHICH note it's judging and each button's shortcut
// (⌘↩ keep · ⌘⇧⌫ discard — shift required: bare ⌘⌫ is macOS delete-to-line-start in the
// live editor right behind the banner). Same banner, no redesign.
describe('new-note banner: note name + keyboard shortcuts', () => {
  const fs4 = require('fs'); const path4 = require('path');
  const r = fs4.readFileSync(path4.join(__dirname, '../../renderer/renderer.js'), 'utf8');
  const css4 = fs4.readFileSync(path4.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('shows the base note name inline', () => {
    expect(r).toMatch(/nn-name'\)\.textContent = rel\.replace\(\/\\\.md\$\/i, ''\)\.split\('\/'\)\.pop\(\)/);
  });
  it('keyboard: ⌘↩ keeps, ⌘⇧⌫ discards, listener self-unbinds when the banner is gone', () => {
    expect(r).toMatch(/e\.key === 'Enter'\) \{ e\.preventDefault\(\); keep\.onclick\(\)/);
    expect(r).toMatch(/e\.key === 'Backspace' && e\.shiftKey\) \{ e\.preventDefault\(\); drop\.onclick\(\)/);
    expect(r).toMatch(/if \(!document\.body\.contains\(bar\)\) \{ document\.removeEventListener\('keydown', onKey, true\)/);
    expect((r.match(/unbind\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(r).toContain("k.textContent = '⌘↩'");
    expect(r).toContain("k.textContent = '⌘⇧⌫'");
  });
  it('kbd chips styled inside the existing banner', () => {
    expect(css4).toMatch(/\.nn-propose kbd \{[^}]*currentColor/);
  });
});

// 2026-09-03: the orphan-section card ("เนื้อหา 14 หัวข้อแต่ไม่รู้ลงโน้ตไหน") grew WIDER than
// the chat pane (the target <select> carries up to 200 note names — its intrinsic width won)
// and its heading list had no height cap. Fits-the-pane guards:
describe('orphan-section card stays inside the chat pane', () => {
  const fs5 = require('fs'); const path5 = require('path');
  const css5 = fs5.readFileSync(path5.join(__dirname, '../../renderer/styles.css'), 'utf8');
  it('kr-confirm capped to pane width; row wraps; list scrolls; select can shrink', () => {
    expect(css5).toMatch(/\.kr-confirm \{[^}]*max-width: calc\(100% - 20px\)[^}]*box-sizing: border-box/);
    expect(css5).toMatch(/\.kr-row \{[^}]*flex-wrap: wrap/);
    expect(css5).toMatch(/\.orph-list \{[^}]*max-height: 132px[^}]*overflow-y: auto/);
    expect(css5).toMatch(/\.orph-sel \{[^}]*flex: 1 1 160px[^}]*max-width: 100%/);
  });
});
