import { describe, it, expect } from 'vitest';
import { mdToHtml, _mdInline, stripMdFence, extractNoteUpdate, extractPdfClips, pdfClipFailLine, extractNewNotes, extractSectionUpdates, replaceSection, stripNoteBlocks, extractKumikoRules, extractPlanProposals, extractActions, linkifyRefs, historyText, liveActivity, NOTE_OPEN, NOTE_CLOSE } from '../../core/markdown.js';

describe('mdToHtml (happy)', () => {
  it('renders **bold** as <strong>', () => {
    expect(mdToHtml('**bold**')).toContain('<strong>bold</strong>');
  });

  it('renders a bullet list as <ul> with two <li>', () => {
    const out = mdToHtml('- a\n- b');
    expect(out).toContain('<ul>');
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it('renders # Title as an <h1>', () => {
    expect(mdToHtml('# Title')).toContain('<h1>Title</h1>');
  });

  it('renders a GFM table with md-table class, header cell and body cell', () => {
    const out = mdToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
  });
});

describe('_mdInline (happy)', () => {
  it('renders `code` as <code>', () => {
    expect(_mdInline('`code`')).toContain('<code>code</code>');
  });

  it('renders [[Nephron]] as a wikilink span', () => {
    const out = _mdInline('see [[Nephron]]');
    expect(out).toContain('wikilink');
    expect(out).toContain('Nephron');
  });

  it('renders {c:red}word{/c} as a tcolor span and hides the markers', () => {
    const out = _mdInline('a {c:red}word{/c} b');
    expect(out).toContain('<span class="tcolor tcolor-red">');
    expect(out).toContain('word');
    expect(out).not.toContain('{c:');
    expect(out).not.toContain('{/c}');
  });

  it('still applies inline formatting INSIDE a tcolor span', () => {
    const out = _mdInline('{c:blue}**bold**{/c}');
    expect(out).toContain('tcolor-blue');
    expect(out).toContain('<strong>bold</strong>');
  });
});

describe('mdToHtml / _mdInline (edge)', () => {
  it('returns "" for empty input', () => {
    expect(mdToHtml('')).toBe('');
  });

  it('underscored filenames in image urls never get <em> injected (canvas/review 404, 2026-09-08)', () => {
    // "chapter13_69_Accounts_Payable-…" contains _…_ pairs; the emphasis pass used to rewrite
    // the src attribute itself. The <img> tag is parked in a placeholder through formatting.
    const h = mdToHtml('ดู ![สไลด์](assets/chapter13_69_Accounts_Payable-838596-p2.jpg) และ _เอียง_');
    expect(h).toContain('src="assets/chapter13_69_Accounts_Payable-838596-p2.jpg"');
    expect(h).not.toMatch(/src="[^"]*<em>/);
    expect(h).toContain('<em>เอียง</em>');   // emphasis elsewhere still works
  });

  it('returns "" for null input', () => {
    expect(mdToHtml(null)).toBe('');
  });

  it('does NOT turn a pipe line without a separator row into a table', () => {
    const out = mdToHtml('| just | text |');
    expect(out).not.toContain('<table');
  });

  it('escapes raw HTML in mdToHtml', () => {
    const out = mdToHtml('<script>x');
    expect(out).toContain('&lt;');
    expect(out).not.toContain('<script>');
  });

  it('escapes raw HTML in _mdInline', () => {
    expect(_mdInline('<b>')).toContain('&lt;');
  });

  it('stripMdFence unwraps a whole-note ```markdown fence (for "แทนที่ทั้งโน้ต")', () => {
    expect(stripMdFence('```markdown\n# Title\n\nbody\n```')).toBe('# Title\n\nbody');
    expect(stripMdFence('```\n# Title\n```')).toBe('# Title');
    // no fence → returned trimmed, unchanged
    expect(stripMdFence('  # Title\n\nbody  ')).toBe('# Title\n\nbody');
    // a fence that is only PART of the text (inline code block) is NOT stripped
    const partial = 'Here you go:\n\n```js\ncode\n```';
    expect(stripMdFence(partial)).toBe(partial);
    // null/empty safe
    expect(stripMdFence(null)).toBe('');
  });

  it('strips the {!#hex} callout-colour marker (never leaks as literal text)', () => {
    // empty callout — the marker is the ONLY content; must not render as text
    const empty = mdToHtml('> {!#f59e0b} ');
    expect(empty).not.toContain('{!');
    expect(empty).toContain('callout-colored');
    expect(empty).toContain('--callout:#f59e0b');
    // callout with text — marker stripped, text kept, colour applied
    const withText = mdToHtml('> {!#3b82f6} Hello');
    expect(withText).not.toContain('{!');
    expect(withText).toContain('>Hello</blockquote>');
    // a plain blockquote is untouched
    expect(mdToHtml('> normal')).toContain('<blockquote>normal</blockquote>');
  });
});

// ---- extractNoteUpdate: the AI's "this reply IS a note edit" protocol -------------
describe('extractNoteUpdate', () => {
  const wrap = (body, before = 'แก้ให้แล้ว', after = '') =>
    before + '\n' + NOTE_OPEN + '\n' + body + '\n' + NOTE_CLOSE + (after ? '\n' + after : '');

  it('pulls out the note body and keeps the remark in chat', () => {
    const r = extractNoteUpdate(wrap('# Title\n\nnew body'));
    expect(r.body).toBe('# Title\n\nnew body');
    expect(r.chat).toBe('แก้ให้แล้ว');
    expect(r.chat).not.toContain(NOTE_OPEN);
  });

  it('returns body null for an ordinary reply (no markers)', () => {
    const r = extractNoteUpdate('just answering your question');
    expect(r.body).toBeNull();
    expect(r.chat).toBe('just answering your question');
  });

  it('keeps a note that itself contains ``` code fences intact', () => {
    const body = '# Doc\n\n```js\nconst a = 1;\n```\n\ndone';
    expect(extractNoteUpdate(wrap(body)).body).toBe(body);
  });

  it('tolerates a missing closing marker (reply cut short)', () => {
    const r = extractNoteUpdate('ok\n' + NOTE_OPEN + '\n# Partial note');
    expect(r.body).toBe('# Partial note');
  });

  it('treats an empty note block as no update', () => {
    expect(extractNoteUpdate('ok\n' + NOTE_OPEN + '\n\n' + NOTE_CLOSE).body).toBeNull();
  });

  it('is safe on null/empty', () => {
    expect(extractNoteUpdate(null)).toEqual({ body: null, chat: '', name: null });
  });

  it('keeps trailing commentary after the block in chat', () => {
    const r = extractNoteUpdate(wrap('body', 'ก่อน', 'หลัง'));
    expect(r.chat).toContain('ก่อน');
    expect(r.chat).toContain('หลัง');
    expect(r.chat).not.toContain('body');
  });
});

// History is context about the conversation, not a payload channel. Without this, an edit-turn's
// reply (carrying the ENTIRE rewritten note) was replayed verbatim into every following prompt.
describe('historyText', () => {
  it('replaces an emitted note body with a short marker', () => {
    const msg = 'แก้ให้แล้ว\n' + NOTE_OPEN + '\n' + '# Big note line\n'.repeat(200) + NOTE_CLOSE;
    const h = historyText(msg);
    expect(h).toContain('แก้ให้แล้ว');
    expect(h).not.toContain('# Big note line');
    expect(h.length).toBeLessThan(200);
  });
  it('passes ordinary text through, caps very long messages with an ellipsis', () => {
    expect(historyText('hello')).toBe('hello');
    const h = historyText('x'.repeat(5000));
    expect(h.length).toBeLessThanOrEqual(802);
    expect(h.endsWith('…')).toBe(true);
  });
  it('is null-safe', () => {
    expect(historyText(null)).toBe('');
  });
});

// ===PDF-CLIP page=N=== — the AI's "paste this slide into the companion note" command
describe('extractPdfClips', () => {
  it('collects pages and strips the command lines from the chat text', () => {
    const r = extractPdfClips('แปะให้แล้วครับ\n===PDF-CLIP page=12===\n===PDF-CLIP page=3===');
    expect(r.pages).toEqual([12, 3]);
    expect(r.chat).toBe('แปะให้แล้วครับ');
  });
  it('dedupes repeated pages and ignores malformed markers', () => {
    const r = extractPdfClips('===PDF-CLIP page=5===\n===PDF-CLIP page=5===\n===PDF-CLIP page=abc===');
    expect(r.pages).toEqual([5]);
    expect(r.chat).toContain('abc');   // malformed line is left as-is, never silently executed
  });
  it('a marker in the middle of a sentence is NOT a command (line-anchored)', () => {
    const r = extractPdfClips('พิมพ์ ===PDF-CLIP page=9=== แบบนี้');
    expect(r.pages).toEqual([]);
  });
  it('ordinary text passes through untouched', () => {
    expect(extractPdfClips('สวัสดี')).toEqual({ pages: [], chat: 'สวัสดี' });
    expect(extractPdfClips(null)).toEqual({ pages: [], chat: '' });
  });
});

describe('historyText also collapses clip commands', () => {
  it('old markers are not replayed to the model verbatim', () => {
    const h = historyText('เรียบร้อย\n===PDF-CLIP page=7===');
    expect(h).not.toContain('===PDF-CLIP');
    expect(h).toContain('แปะสไลด์หน้า 7');
  });
});

// the failure line pushed into the chat when clips could NOT be resolved (2026-09-25:
// the note used to be silently saved without the image, with only a 3-second toast)
describe('pdfClipFailLine', () => {
  it('no-PDF reason tells the user to open the source PDF first', () => {
    const s = pdfClipFailLine([12, 3], true);
    expect(s).toContain('ยังไม่มีไฟล์ PDF เปิดอยู่');
    expect(s).toContain('เปิดไฟล์ PDF ต้นทางในแอปก่อน');
    expect(s).toContain('3, 12');   // sorted
  });
  it('render-fail reason says the note was saved without the image', () => {
    const s = pdfClipFailLine([7], false);
    expect(s).toContain('เรนเดอร์ไม่ผ่าน');
    expect(s).toContain('โน้ตถูกบันทึกโดยไม่มีภาพ');
    expect(s).toContain('หน้า 7');
  });
  it('empty or non-array pages → empty string (nothing to report)', () => {
    expect(pdfClipFailLine([], true)).toBe('');
    expect(pdfClipFailLine(null, true)).toBe('');
    expect(pdfClipFailLine('12', false)).toBe('');
  });
  it('dedupes + sorts; the list caps at 8 pages with an ellipsis', () => {
    const s = pdfClipFailLine([9, 2, 9, 5, 1, 30, 4, 8, 7, 6, 3], true);
    expect(s).toContain('1, 2, 3, 4, 5, 6, 7, 8, …');
    expect(s).not.toContain('30');   // beyond the cap
  });
  it('non-numeric values are filtered out', () => {
    expect(pdfClipFailLine(['x', {}, undefined, '12'], true)).toContain('12');
    expect(pdfClipFailLine(['x', {}], true)).toBe('');
  });
});

// clickable chat references
describe('linkifyRefs', () => {
  it('turns @[Name] into an at-ref anchor showing JUST the name (no @ prefix)', () => {
    const out = linkifyRefs('ดู @[Nephron] หน่อย');
    expect(out).toContain('<a class="at-ref" data-ref="Nephron">Nephron</a>');
    expect(out).not.toContain('>@Nephron<');
  });
  it('turns [source: Name] citations into anchors too', () => {
    const out = linkifyRefs('ตามที่ [source: BSD Cost] บอก');
    expect(out).toContain('data-ref="BSD Cost"');
    expect(out).toContain('📄 BSD Cost');
  });
  it('escapes quotes in the data attribute and leaves plain text alone', () => {
    expect(linkifyRefs('@[A"B]')).toContain('data-ref="A&quot;B"');
    expect(linkifyRefs('ธรรมดา')).toBe('ธรรมดา');
    expect(linkifyRefs(null)).toBe('');
  });
});

// ===NEW-NOTE name=X=== — the AI's "create a brand-new note" channel. Without it the model
// shoved "สร้างโน้ตใหม่" content into the OPEN note via the only marker it knew.
describe('extractNewNotes', () => {
  it('pulls name + body out and keeps the remark in chat', () => {
    const r = extractNewNotes('สร้างให้แล้ว\n===NEW-NOTE name=สรุปบทที่ 10===\n# สรุป\nเนื้อหา\n' + NOTE_CLOSE + '\nจบครับ');
    expect(r.notes).toEqual([{ name: 'สรุปบทที่ 10', body: '# สรุป\nเนื้อหา' }]);
    expect(r.chat).toContain('สร้างให้แล้ว');
    expect(r.chat).toContain('จบครับ');
    expect(r.chat).not.toContain('NEW-NOTE');
  });
  it('supports several notes in one reply', () => {
    const r = extractNewNotes('===NEW-NOTE name=A===\nbody a\n' + NOTE_CLOSE + '\n===NEW-NOTE name=B===\nbody b\n' + NOTE_CLOSE);
    expect(r.notes.map((n) => n.name)).toEqual(['A', 'B']);
  });
  it('tolerates a missing close (streaming cut) and skips empty bodies', () => {
    expect(extractNewNotes('===NEW-NOTE name=X===\npartial body').notes).toEqual([{ name: 'X', body: 'partial body' }]);
    expect(extractNewNotes('===NEW-NOTE name=X===\n\n' + NOTE_CLOSE).notes).toEqual([]);
  });
  it('ordinary text and null are untouched/safe', () => {
    expect(extractNewNotes('สวัสดี')).toEqual({ notes: [], chat: 'สวัสดี' });
    expect(extractNewNotes(null)).toEqual({ notes: [], chat: '' });
  });
});

describe('historyText collapses new-note blocks', () => {
  it('old blocks are not replayed verbatim', () => {
    const h = historyText('ตกลง\n===NEW-NOTE name=สรุป===\n' + 'เนื้อหายาว\n'.repeat(100) + NOTE_CLOSE);
    expect(h).not.toContain('NEW-NOTE');
    expect(h).toContain('สร้างโน้ตใหม่: สรุป');
    expect(h.length).toBeLessThan(200);
  });
});

// named target: ===UPDATED-NOTE name=X=== edits note X, not whatever is open
describe('extractNoteUpdate with a named target', () => {
  it('captures the name; unnamed stays null (backward compatible)', () => {
    const named = extractNoteUpdate('ok\n===UPDATED-NOTE name=สรุปบท 10===\nbody\n' + NOTE_CLOSE);
    expect(named.name).toBe('สรุปบท 10');
    expect(named.body).toBe('body');
    expect(extractNoteUpdate('ok\n' + NOTE_OPEN + '\nbody\n' + NOTE_CLOSE).name).toBeNull();
  });
});

describe('linkifyRefs with plain @Name (no brackets)', () => {
  it('links known names longest-first and drops the @ from display', () => {
    const out = linkifyRefs('ดู @BSD Cost กับ @Nephron', ['BSD', 'Nephron', 'BSD Cost']);
    expect(out).toContain('data-ref="BSD Cost">BSD Cost</a>');
    expect(out).toContain('data-ref="Nephron">Nephron</a>');
    expect(out).not.toContain('@');
  });
  it('a zero-width-marked mention (picker form) links too, marker dropped', () => {
    const out = linkifyRefs('ดู \u200BNephron นะ', ['Nephron']);
    expect(out).toContain('data-ref="Nephron">Nephron</a>');
    expect(out).not.toContain('\u200B<a');
  });
  it('unknown @text is left alone; no names arg = legacy behaviour only', () => {
    expect(linkifyRefs('@ใครก็ไม่รู้', ['Nephron'])).toBe('@ใครก็ไม่รู้');
    expect(linkifyRefs('@Nephron')).toBe('@Nephron');
  });
});

// Section-level editing — the fix for "แก้หัวข้อ 4 แล้วส่วนอื่นหายหมด": the AI sends ONLY the
// section, the app merges. (Whole-note replace was impossible anyway: P1 context is excerpts.)
describe('replaceSection', () => {
  const body = '# A\nintro\n\n## หัวข้อ 3\nเก่า3\n\n## หัวข้อ 4\nเก่า4\n\n## หัวข้อ 5\nเก่า5';
  it('replaces exactly one section and keeps everything else', () => {
    const out = replaceSection(body, 'หัวข้อ 4', '## หัวข้อ 4\nใหม่');
    expect(out).toContain('เก่า3');
    expect(out).toContain('เก่า5');
    expect(out).toContain('ใหม่');
    expect(out).not.toContain('เก่า4');
  });
  it('matches the heading with or without the # prefix, case-insensitive', () => {
    expect(replaceSection(body, '## หัวข้อ 4', '## หัวข้อ 4\nx')).toContain('x');
  });
  it('a replacement without a heading line keeps the original heading', () => {
    const out = replaceSection(body, 'หัวข้อ 4', 'เนื้อหาล้วน');
    expect(out).toContain('## หัวข้อ 4');
    expect(out).toContain('เนื้อหาล้วน');
  });
  it('a section at the END of the note replaces to EOF', () => {
    const out = replaceSection(body, 'หัวข้อ 5', '## หัวข้อ 5\nจบใหม่');
    expect(out).toContain('จบใหม่');
    expect(out).not.toContain('เก่า5');
  });
  it('unknown heading -> null (caller reports, nothing destroyed)', () => {
    expect(replaceSection(body, 'ไม่มีจริง', 'x')).toBeNull();
  });
  it('nested subsections belong to their parent section', () => {
    const b2 = '## หัวข้อ 4\nเก่า\n\n### 4.1\nลูก\n\n## หัวข้อ 5\nคงไว้';
    const out = replaceSection(b2, 'หัวข้อ 4', '## หัวข้อ 4\nใหม่');
    expect(out).not.toContain('ลูก');     // 4.1 is part of section 4
    expect(out).toContain('คงไว้');
  });
});

describe('extractSectionUpdates', () => {
  it('parses heading + body and strips the block from chat', () => {
    const r = extractSectionUpdates('แก้ให้แล้ว\n===UPDATED-SECTION heading=หัวข้อ 4===\n## หัวข้อ 4\nใหม่\n' + NOTE_CLOSE);
    expect(r.sections).toEqual([{ heading: 'หัวข้อ 4', body: '## หัวข้อ 4\nใหม่', name: null }]);
    expect(r.chat).toBe('แก้ให้แล้ว');
  });
  it('multiple sections in one reply; safe on plain text', () => {
    const r = extractSectionUpdates('===UPDATED-SECTION heading=A===\nx\n' + NOTE_CLOSE + '\n===UPDATED-SECTION heading=B===\ny\n' + NOTE_CLOSE);
    expect(r.sections.map((s2) => s2.heading)).toEqual(['A', 'B']);
    expect(extractSectionUpdates('สวัสดี')).toEqual({ sections: [], chat: 'สวัสดี' });
  });
});

// WYSIWYG parity: what you type in the sticky box must equal what displays after editing.
describe('mdToHtml fenced code + images (edit/display parity)', () => {
  it('renders a fenced block as a code-studio wrap (bar + label + copy), not stray paragraphs', () => {
    const out = mdToHtml('ก่อน\n```js\nconst a = 1;\n```\nหลัง');
    expect(out).toContain('md-codewrap');
    expect(out).toContain('<span class="md-lang">JS</span>');
    expect(out).toContain('<pre class="md-code"><code>');
    expect(out).toContain('<span class="tok-k">const</span>');
    expect(out).not.toContain('<p>```');
  });
  it('mermaid fences emit a placeholder the PDF preview upgrades to a live diagram', () => {
    const out = mdToHtml('```mermaid\ngraph TD\nA-->B\n```');
    expect(out).toContain('md-mermaid-src');
    expect(out).toContain('data-mmd="graph TD');
    expect(out).not.toContain('<p>```');
  });
  it('an unclosed fence still swallows to EOF (no raw ``` leaking)', () => {
    expect(mdToHtml('```\nhalf')).toContain('<code>half</code>');
  });
  it('images render as <img>, escaped', () => {
    const out = _mdInline('![สไลด์](data:image/jpeg;base64,xxx)');
    expect(out).toContain('<img class="md-img" src="data:image/jpeg;base64,xxx" alt="สไลด์">');
  });
});

// 2026-08-18 clip-routing fix: markers INSIDE a note block belong to that note, so the
// standalone-clip executor must see only what's OUTSIDE the blocks. Repro of the real bug:
// the AI put ===PDF-CLIP page=46=== inside UPDATED-NOTE name=OES Process, and the image
// went to the PDF's capture target ("DFD - Data Flow Diagram") instead.
describe('stripNoteBlocks', () => {
  const reply = 'เพิ่มให้แล้วครับ\n\n' +
    '===UPDATED-NOTE name=OES Process===\nbody A\n===PDF-CLIP page=46===\nmore\n===END-NOTE===\n\n' +
    '===NEW-NOTE name=ER Diagram===\n===PDF-CLIP page=47===\nbody B\n===END-NOTE===\n\n' +
    '===PDF-CLIP page=99===\nจบครับ';

  it('HAPPY: removes every note block; standalone content survives', () => {
    const out = stripNoteBlocks(reply);
    expect(out).not.toContain('UPDATED-NOTE');
    expect(out).not.toContain('NEW-NOTE');
    expect(out).not.toContain('body A');
    expect(out).not.toContain('body B');
    expect(out).toContain('เพิ่มให้แล้วครับ');
    expect(out).toContain('จบครับ');
  });

  it('HAPPY: in-block clips disappear, the standalone clip remains for the target executor', () => {
    const pages = extractPdfClips(stripNoteBlocks(reply)).pages;
    expect(pages).toEqual([99]);
  });

  it('EDGE: unclosed block (streaming cut-off) drops to end of text, no crash', () => {
    const out = stripNoteBlocks('hi\n===UPDATED-NOTE===\npartial with no close');
    expect(out).toContain('hi');
    expect(out).not.toContain('partial');
  });

  it('EDGE: UPDATED-SECTION blocks are stripped too; plain text untouched', () => {
    const out = stripNoteBlocks('a\n===UPDATED-SECTION heading=X===\nsec\n===END-NOTE===\nb');
    expect(out.replace(/\s+/g, ' ').trim()).toBe('a b');
    expect(stripNoteBlocks('no blocks here')).toBe('no blocks here');
  });
});

// ===KUMIKO-RULE=== — the AI proposes a standing work rule; user confirms before it lands
// in KUMIKO.md (phase 2 of "ให้ AI เรียนรู้การทำงานของฉัน", 2026-08-18).
describe('extractKumikoRules', () => {
  it('HAPPY: pulls the rule out and keeps the remark in chat', () => {
    const r = extractKumikoRules('รับทราบครับ\n===KUMIKO-RULE===\nห้ามใช้ emoji ในหัวข้อ\n===END-NOTE===\nขอบคุณ');
    expect(r.rules).toEqual(['ห้ามใช้ emoji ในหัวข้อ']);
    expect(r.chat).toContain('รับทราบครับ');
    expect(r.chat).toContain('ขอบคุณ');
    expect(r.chat).not.toContain('KUMIKO-RULE');
  });
  it('HAPPY: multiple blocks, order kept, capped at 5', () => {
    const many = Array.from({ length: 7 }, (_, i) => '===KUMIKO-RULE===\nกติกา ' + i + '\n===END-NOTE===').join('\n');
    const r = extractKumikoRules(many);
    expect(r.rules.length).toBe(5);
    expect(r.rules[0]).toBe('กติกา 0');
  });
  it('EDGE: unclosed block (stream cut) still yields the rule; empty block yields none', () => {
    expect(extractKumikoRules('===KUMIKO-RULE===\nกติกาค้าง').rules).toEqual(['กติกาค้าง']);
    expect(extractKumikoRules('===KUMIKO-RULE===\n\n===END-NOTE===').rules).toEqual([]);
  });
  it('EDGE: a rule longer than 300 chars is truncated; ordinary text untouched', () => {
    const r = extractKumikoRules('===KUMIKO-RULE===\n' + 'x'.repeat(400) + '\n===END-NOTE===');
    expect(r.rules[0].length).toBe(300);
    expect(extractKumikoRules('สวัสดี')).toEqual({ rules: [], chat: 'สวัสดี' });
  });
  it('history collapses the block; stripNoteBlocks removes it (clip lines inside never execute)', () => {
    const msg = 'ok\n===KUMIKO-RULE===\nกติกา\n===END-NOTE===';
    expect(historyText(msg)).toContain('[เสนอกติกาการทำงาน 1 ข้อแล้ว]');
    expect(historyText(msg)).not.toContain('===');
    expect(stripNoteBlocks(msg)).not.toContain('กติกา');
  });
});

// ===VERB key=value=== tool lines (2026-08-19 "Kumiko as a shared tool"): READ/SEARCH are
// ask-verbs (the app fetches and continues the turn); RENAME/DELETE/SET-CAPTURE-TARGET are
// file verbs. One shared grammar, one parser.
describe('extractActions', () => {
  it('HAPPY: parses every verb and strips the lines from chat', () => {
    const r = extractActions([
      'เดี๋ยวขออ่านก่อนครับ',
      '===READ-NOTE name=OES Process===',
      '===SEARCH query=data flow diagram===',
      '===RENAME-NOTE from=Old Note to=New Note===',
      '===DELETE-NOTE name=Junk===',
      '===SET-CAPTURE-TARGET name=DFD===',
    ].join('\n'));
    expect(r.reads).toEqual(['OES Process']);
    expect(r.searches).toEqual(['data flow diagram']);
    expect(r.renames).toEqual([{ from: 'Old Note', to: 'New Note' }]);
    expect(r.deletes).toEqual(['Junk']);
    expect(r.targets).toEqual(['DFD']);
    expect(r.any).toBe(true);
    expect(r.needsContinue).toBe(true);
    expect(r.chat).toBe('เดี๋ยวขออ่านก่อนครับ');
  });
  it('HAPPY: file verbs alone do NOT trigger a continuation round', () => {
    const r = extractActions('===RENAME-NOTE from=A to=B===');
    expect(r.any).toBe(true);
    expect(r.needsContinue).toBe(false);
  });
  it('EDGE: caps — 3 reads, 2 searches; extras dropped', () => {
    const many = Array.from({ length: 5 }, (_, i) => '===READ-NOTE name=N' + i + '===').join('\n') +
      '\n' + Array.from({ length: 4 }, (_, i) => '===SEARCH query=q' + i + '===').join('\n');
    const r = extractActions(many);
    expect(r.reads).toEqual(['N0', 'N1', 'N2']);
    expect(r.searches).toEqual(['q0', 'q1']);
  });
  it('EDGE: mid-sentence markers are NOT commands; malformed args ignored; null-safe', () => {
    expect(extractActions('ลอง ===READ-NOTE name=X=== ดู').any).toBe(false);
    expect(extractActions('===READ-NOTE X===').any).toBe(false);          // missing name=
    expect(extractActions('===RENAME-NOTE from=A===').any).toBe(false);   // missing to=
    expect(extractActions(null).any).toBe(false);
  });
  it('names with spaces and Thai survive; historyText collapses the lines', () => {
    const r = extractActions('===READ-NOTE name=ระบบสารสนเทศ บทที่ 10===');
    expect(r.reads).toEqual(['ระบบสารสนเทศ บทที่ 10']);
    const h = historyText('ok\n===READ-NOTE name=A===\n===SEARCH query=b===');
    expect(h).toContain('[ใช้เครื่องมือ');
    expect(h).not.toContain('===');
  });
  it('G2 grid verbs: CANVAS-PLACE (board=/note=/name=, at=, size=) + CANVAS-ARRANGE parse, ordered, stripped', () => {
    const r = extractActions([
      '===CANVAS-PLACE board=สรุปบท 13 note=OES Process seg=ภาพรวม at=0,2 size=4x3===',
      '===CANVAS-PLACE name=DFD===',
      '===CANVAS-ARRANGE board=สรุปบท 13 mode=hub===',
      '===CANVAS-ARRANGE===',
      'จัดเสร็จ',
    ].join('\n'));
    expect(r.canvasOps).toEqual([
      { op: 'board', name: 'สรุปบท 13' },
      { op: 'place', name: 'OES Process', seg: 'ภาพรวม', at: '0,2', size: '4x3' },
      { op: 'place', name: 'DFD', seg: '', at: '', size: '' },
      { op: 'board', name: 'สรุปบท 13' },
      { op: 'arrange', mode: 'hub' },
      { op: 'arrange', mode: 'grid' },
    ]);
    expect(r.canvasWrites).toBe(6);
    expect(r.chat).toBe('จัดเสร็จ');
  });
  it('G2 edge: malformed place/arrange lines are ignored like the rest of the family', () => {
    const r = extractActions('===CANVAS-PLACE at=0,0===\n===CANVAS-ARRANGE mode=zigzag===\n===CANVAS-PLACE name===');
    expect(r.canvasOps).toEqual([]);   // no name=, unknown mode, bare name -> all dropped
  });
});

// 2026-08-19 named section edits — the AI aimed section edits at named notes with no channel
// for it; the executor silently dropped them (log: "เพิ่มใน Functional Modelling" went nowhere).
describe('extractSectionUpdates name= variant', () => {
  it('HAPPY: parses name + heading; plain heading form keeps name null', () => {
    const r = extractSectionUpdates('===UPDATED-SECTION name=Functional Modelling heading=สรุป===\n## สรุป\nเนื้อหา\n===END-NOTE===');
    expect(r.sections).toEqual([{ heading: 'สรุป', body: '## สรุป\nเนื้อหา', name: 'Functional Modelling' }]);
    const r2 = extractSectionUpdates('===UPDATED-SECTION heading=สรุป===\nx\n===END-NOTE===');
    expect(r2.sections[0].name).toBeNull();
  });
  it('EDGE: heading containing spaces still parses; historyText/stripNoteBlocks handle the name form', () => {
    const r = extractSectionUpdates('===UPDATED-SECTION name=A B heading=หัวข้อ ยาว มาก===\nx\n===END-NOTE===');
    expect(r.sections[0]).toEqual({ heading: 'หัวข้อ ยาว มาก', body: 'x', name: 'A B' });
    const msg = 'ok\n===UPDATED-SECTION name=A heading=B===\nx\n===END-NOTE===';
    expect(historyText(msg)).not.toContain('===');
    expect(stripNoteBlocks(msg)).not.toContain('x');
  });
});

// 2026-08-19: crepe serializes "<<extend>>" as "\<\<extend\>\>"; the preview showed the
// backslashes literally ("มี \ เพิ่มเข้ามา"). CommonMark escapes must render as the character.
describe('backslash escapes render as the character', () => {
  it('HAPPY: \\< \\> sequences show << >> with no backslash', () => {
    const out = mdToHtml('\\<\\<extend\\>\\> -> Use case');
    expect(out).toContain('&lt;&lt;extend&gt;&gt;');
    expect(out).not.toContain('\\');
  });
  it('HAPPY: escaped punctuation (\\* \\[ \\# \\.) unescapes instead of formatting', () => {
    expect(mdToHtml('a \\*not italic\\* b')).toContain('*not italic*');
    expect(mdToHtml('a \\*not italic\\* b')).not.toContain('<em>');
    expect(_mdInline('\\[x\\]')).toBe('[x]');
  });
  it('EDGE: a double backslash collapses to one; normal formatting still works', () => {
    expect(_mdInline('a \\\\ b')).toBe('a \\ b');
    expect(_mdInline('**bold**')).toContain('<strong>bold</strong>');
  });
});

describe('extractActions — tag verbs', () => {
  const CM = require('../../core/markdown.js');
  it('parses ask + write tag verbs, strips them from chat, sets needsContinue for asks only', () => {
    const a = CM.extractActions('ดูก่อน\n===LIST-TAGS===\n===NOTES-BY-TAG tags=exam, dfd===\nโอเค');
    expect(a.listTags).toBe(true); expect(a.notesByTag).toEqual(['exam, dfd']);
    expect(a.needsContinue).toBe(true); expect(a.tagWrites).toBe(0); expect(a.chat).toBe('ดูก่อน\n\nโอเค');
    const w = CM.extractActions('===ADD-TAGS name=A/dfd tags=exam/midterm, dfd===\n===REMOVE-TAGS name=A/dfd tags=old===\n===SET-TAGS name=B tags====\n===RENAME-TAG from=exam to=สอบ===\n===RENAME-TAG from=junk===');
    expect(w.addTags).toEqual([{ name: 'A/dfd', tags: 'exam/midterm, dfd' }]);
    expect(w.removeTags).toEqual([{ name: 'A/dfd', tags: 'old' }]);
    expect(w.setTags).toEqual([{ name: 'B', tags: '' }]);
    expect(w.renameTags).toEqual([{ from: 'exam', to: 'สอบ' }, { from: 'junk', to: '' }]);
    expect(w.needsContinue).toBe(false); expect(w.any).toBe(true); expect(w.tagWrites).toBe(5);
  });
  it('old verbs unchanged', () => {
    const a = CM.extractActions('===READ-NOTE name=X===\n===SET-CAPTURE-TARGET name=Y===');
    expect(a.reads).toEqual(['X']); expect(a.targets).toEqual(['Y']);
  });
});

describe('ensureSlideClips — slide-citing headings always carry the slide', () => {
  const CM = require('../../core/markdown.js');
  it('injects a clip under headings citing (หน้า N)/(p. N)/(page N) that lack any image; skips covered, non-page and out-of-range', () => {
    const r = CM.ensureSlideClips('## A (หน้า 7)\nx\n## B (p. 46)\n===PDF-CLIP page=46===\n## C (page 59)\n![img](data:image/jpeg;base64,x)\n## D\nno page\n## E (หน้า 999)\ny', 100);
    expect(r.added).toBe(1);
    expect(r.body).toContain('## A (หน้า 7)\n\n===PDF-CLIP page=7===');
    expect((r.body.match(/===PDF-CLIP/g) || []).length).toBe(2);
  });
  it('renderer injects via resolvePdfClipMarkers while a PDF is open; prompt states the always-attach default', () => {
    const js = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(js).toMatch(/window\.CoreMarkdown\.ensureSlideClips\(s, pdfDoc\.numPages\)\.body/);
    expect(js).toMatch(/ต้องวาง ===PDF-CLIP page=N=== ไว้ใต้หัวข้อนั้นเสมอโดยไม่ต้องรอให้ขอ/);
  });
});

describe('backslash escapes — full CommonMark set (log 2026-08-25: "\\=" showed its backslash)', () => {
  const CM = require('../../core/markdown.js');
  it('renders the character, never the backslash, for =, @, :, %, ; , / ? ^ $ \'', () => {
    expect(CM.mdToHtml('\\= Credit note')).toBe('<p>= Credit note</p>');
    expect(CM.mdToHtml('ก \\@ ข \\: ค 50\\% \; \\, \\/ \\? \\^ \\$ \\\' จบ')).toBe('<p>ก @ ข : ค 50% ; , / ? ^ $ \' จบ</p>');
    // the escape still PROTECTS formatting characters
    expect(CM.mdToHtml('\\*x\\*')).toBe('<p>*x*</p>');
  });
});

describe('search: PDF-Text shadows surface as the PDF, not as files (log 2026-08-26)', () => {
  const fs = require('fs'), path = require('path');
  it('main + web mark shadow hits {pdf, page}, cap 3/file, never name-match a shadow; renderer opens the PDF at the page', () => {
    for (const f of ['main.js', 'web/api-web.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
      expect(src).toMatch(/isShadow = name\.startsWith\('PDF-Text\/'\)/);
      expect(src).toMatch(/if \(!isShadow && name\.toLowerCase\(\)\.includes\(ql\)\)/);
      expect(src).toMatch(/if \(shadowHits >= 3\) continue;/);
      expect(src).toMatch(/\^## หน้า \(\\d\+\)/);
    }
    const r = fs.readFileSync(path.join(__dirname, '../../renderer/renderer.js'), 'utf8');
    expect(r).toMatch(/hit\.pdf \? '📕 ' \+ hit\.pdf/);
    expect(r).toMatch(/window\.__wikiNav\(rel \+ \(hit\.page \? '#p' \+ hit\.page : ''\)\)/);
  });
});

// 2026-09-13 user bug: the WYSIWYG editor (milkdown/crepe) serializes multi-line paragraphs
// with CommonMark hard breaks ("line\") and &#x20; entities for indentation — mdToHtml showed
// the backslash and the raw entity on every surface (canvas cards, db cells, chat, dashboard).
describe('mdToHtml hard break + space entities (crepe serialization)', () => {
  const SNIPPET = 'i = 0\\\ntemp = self.head\\\nwhile self.next != where:\\\n&#x20; temp = temp.next\\\ntemp = temp.next.next';
  it('HAPPY: the user snippet renders as 5 clean lines, line 4 nbsp-indented', () => {
    const out = mdToHtml(SNIPPET);
    expect(out.match(/<p>/g)).toHaveLength(5);
    expect(out).toContain('<p>i = 0</p>');
    expect(out).toContain('<p>while self.next != where:</p>');
    expect(out).toContain('<p>&nbsp; temp = temp.next</p>');
    expect(out).not.toContain('\\');
    expect(out).not.toContain('#x20');                       // neither raw &#x20; nor &amp;#x20;
    expect((out.match(/&nbsp;/g) || []).length).toBe(1);      // only line 4 is indented
  });
  it('HAPPY: mid-line &#32; and &#X20; (uppercase X) are a plain space; a leading run is one nbsp per entity', () => {
    expect(mdToHtml('a&#32;b&#X20;c')).toBe('<p>a b c</p>');
    expect(mdToHtml('&#X20;&#32;x')).toBe('<p>&nbsp;&nbsp;x</p>');
  });
  it('EDGE: an even trailing run (a\\\\) is an escaped backslash — ONE backslash survives, not a break', () => {
    expect(mdToHtml('a\\\\')).toBe('<p>a\\</p>');
  });
  it('EDGE: inline code keeps every character raw — entities and trailing backslashes', () => {
    expect(_mdInline('`code with &#x20; and trailing \\\\`')).toBe('<code>code with &amp;#x20; and trailing \\\\</code>');
  });
  it('EDGE: fenced code keeps raw line-trailing \\ and &#x20; lines', () => {
    const out = mdToHtml('```\nline\\\n&#x20; indented\n```');
    expect(out).toContain('line\\\n&amp;#x20; indented');
    expect(out).not.toContain('&nbsp;');
  });
  it('SECURITY: only SPACE entities decode — &#x3C;script&#x3E; stays escaped text, never a tag', () => {
    const out = mdToHtml('&#x3C;script&#x3E;');
    expect(out).toContain('&amp;#x3C;script&amp;#x3E;');
    expect(out).not.toContain('<script');
  });
  it('EDGE: an explicitly escaped entity (\\&#x20;) stays literal — backslash escapes win over decoding', () => {
    expect(_mdInline('a \\&#x20; b')).toBe('a &amp;#x20; b');
  });
});

// 2026-09-13 R2 "Code studio" mock: headerless tables, code-fence header bar, light highlight.
describe('headerless GFM tables (R2 code-studio mock, 2026-09-13)', () => {
  it('HAPPY: `| | |` empty header + separator → <table> with NO thead, body rows straight in tbody', () => {
    const out = mdToHtml('| | |\n|---|---|\n| a | b |');
    expect(out).toContain('<table class="md-table">');
    expect(out).not.toContain('<thead');
    expect(out).toContain('<tbody>');
    expect(out).toContain('<td>a</td>');
    expect(out).toContain('<td>b</td>');
  });
  it('HAPPY: `||` (no spaces) works the same', () => {
    const out = mdToHtml('||\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<table');
    expect(out).not.toContain('<thead');
    expect(out).toContain('<td>2</td>');
  });
  it('a normal headered table keeps its thead exactly as before', () => {
    const out = mdToHtml('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(out).toContain('<thead>');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
  });
  it('EDGE: empty first row WITHOUT a separator after it is NOT a table', () => {
    const out = mdToHtml('| | |\n| a | b |');
    expect(out).not.toContain('<table');
  });
});

describe('fenced code: header bar + language label + copy button (R2)', () => {
  it('HAPPY: ```python fence → md-codewrap + codebar + PYTHON label + .md-copy button', () => {
    const out = mdToHtml('```python\nx = 1\n```');
    expect(out).toContain('<div class="md-codewrap">');
    expect(out).toContain('<div class="md-codebar">');
    expect(out).toContain('<span class="md-lang">PYTHON</span>');
    expect(out).toContain('<button type="button" class="md-copy"');
    expect(out).toContain('<pre class="md-code"><code>');
  });
  it('EDGE: no info string → label CODE; mermaid fences stay the old placeholder', () => {
    expect(mdToHtml('```\nx = 1\n```')).toContain('<span class="md-lang">CODE</span>');
    const mm = mdToHtml('```mermaid\ngraph TD\n```');
    expect(mm).toContain('md-mermaid-src');
    expect(mm).not.toContain('md-codewrap');
  });
});

describe('light syntax highlight (pure regex, on ESCAPED text)', () => {
  it('HAPPY: a # Thai comment is one tok-c chunk to end of line', () => {
    const out = mdToHtml('```python\n# คอมเมนต์ไทย ทั้งบรรทัด\nx = 1\n```');
    expect(out).toContain('<span class="tok-c"># คอมเมนต์ไทย ทั้งบรรทัด</span>');
  });
  it('HAPPY: python keyword + number highlighted; // comment and bare string for unknown langs', () => {
    const out = mdToHtml('```python\ndef f():\n    return 42\n```');
    expect(out).toContain('<span class="tok-k">def</span>');
    expect(out).toContain('<span class="tok-k">return</span>');
    expect(out).toContain('<span class="tok-n">42</span>');
    const unk = mdToHtml('```\n// note\ns = "hi" + 7\n```');
    expect(unk).toContain('<span class="tok-c">// note</span>');
    expect(unk).toContain('<span class="tok-s">"hi"</span>');
    expect(unk).toContain('<span class="tok-n">7</span>');
  });
  it('keywords inside strings/comments are never highlighted (parked first)', () => {
    const out = mdToHtml('```python\ns = "def return if"\n# def while\n```');
    expect(out).toContain('tok-s');
    expect(out).not.toContain('tok-k');
  });
  it('SECURITY: <script> in code always renders as escaped text', () => {
    const out = mdToHtml('```html\n<script>alert(1)</script>\n```');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });
  it('escaped entities never feed the passes: &#x20; stays intact inside a fence', () => {
    const out = mdToHtml('```\nv&#x20;= 1\n```');
    expect(out).toContain('&amp;#x20;');
    expect(out).not.toContain('tok-c');   // the `#x20;` tail is NOT a comment
  });
  it('the new highlight code uses no regex lookbehind (Safari < 16.4 cannot even parse it)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../core/markdown.js'), 'utf8');
    expect(src).not.toMatch(/\(\?[<=]/);
  });
});

// Plan Mode (2026-09-22): ===KUMIKO-PLAN=== proposes a multi-step plan (confirm-gated card),
// ===PLAN-STEP n= status= note==== reports step progress mid-run, ===PLAN-DONE summary====
// closes the plan. Plan blocks must never render raw in the bubble.
describe('extractPlanProposals', () => {
  it('HAPPY: parses title + step bullets, strips the block from chat', () => {
    const r = extractPlanProposals('วางแผนให้ก่อนนะ\n===KUMIKO-PLAN title=สรุปวิชา DS===\n- ขั้น 1 รวบรวมโน้ต\n- ขั้น 2 เขียนสรุป\n===END-NOTE===\nเรียบร้อย');
    expect(r.plans).toEqual([{ title: 'สรุปวิชา DS', steps: ['ขั้น 1 รวบรวมโน้ต', 'ขั้น 2 เขียนสรุป'] }]);
    expect(r.chat).toBe('วางแผนให้ก่อนนะ\n\nเรียบร้อย');
  });
  it('EDGE: no END-NOTE → eats the suffix (same as the rule grammar); title keeps spaces', () => {
    const r = extractPlanProposals('===KUMIKO-PLAN title=แผน สรุป ทั้งวิชา===\n- ขั้นเดียว');
    expect(r.plans).toEqual([{ title: 'แผน สรุป ทั้งวิชา', steps: ['ขั้นเดียว'] }]);
    expect(r.chat).toBe('');
  });
  it('EDGE: no proposal → empty; non-bullet body lines ignored; max 1 plan kept', () => {
    expect(extractPlanProposals('ธรรมดา').plans).toEqual([]);
    const r = extractPlanProposals('===KUMIKO-PLAN title=T===\nคำอธิบายไม่ใช่ขั้น\n- ขั้นจริง\n===END-NOTE===\n===KUMIKO-PLAN title=สอง===\n- อีกแผน\n===END-NOTE===');
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0].steps).toEqual(['ขั้นจริง']);
  });
  it('plan blocks are stripped by stripNoteBlocks and collapsed by historyText', () => {
    const msg = 'hi\n===KUMIKO-PLAN title=T===\n- ขั้น\n===END-NOTE===';
    expect(stripNoteBlocks(msg)).not.toContain('ขั้น');
    expect(historyText(msg)).toContain('[เสนอแผนงาน');
    expect(historyText(msg)).not.toContain('===');
  });
});

describe('extractActions — plan verbs', () => {
  it('HAPPY: PLAN-STEP lines land in planSteps in order and are stripped from chat', () => {
    const r = extractActions('กำลังทำ\n===PLAN-STEP n=2 status=done note=ผ่านรีวิว 3 hunks===\n===PLAN-STEP n=3 status=blocked note=ไม่พบไฟล์===\n===PLAN-STEP n=4 status=doing===\nจบรอบ');
    expect(r.planSteps).toEqual([
      { n: 2, status: 'done', note: 'ผ่านรีวิว 3 hunks' },
      { n: 3, status: 'blocked', note: 'ไม่พบไฟล์' },
      { n: 4, status: 'doing', note: '' },
    ]);
    expect(r.chat).toBe('กำลังทำ\n\nจบรอบ');
    expect(r.any).toBe(true);
    expect(r.needsContinue).toBe(false);   // plan verbs never trigger the ask-verb loop
  });
  it('HAPPY: PLAN-DONE captures the summary', () => {
    const r = extractActions('===PLAN-DONE summary=สรุปทุกบทเรียบร้อย===');
    expect(r.planDone).toEqual({ summary: 'สรุปทุกบทเรียบร้อย' });
    expect(r.any).toBe(true);
    expect(r.chat).toBe('');
  });
  it('EDGE: plain text with no verbs → plan fields empty', () => {
    const r = extractActions('คำตอบธรรมดา');
    expect(r.planSteps).toEqual([]);
    expect(r.planDone).toBeNull();
    expect(r.any).toBe(false);
  });
});

// W2 live activity console (2026-09-22): liveActivity reads the RAW streaming buffer and
// reports what the AI is doing right now — rows in first-seen order, an OPEN note block
// becomes `writing` (name + chars) instead of a finished row.
describe('liveActivity', () => {
  it('HAPPY: verbs become rows in first-seen order; READ-NOTE merges into ONE row', () => {
    const r = liveActivity([
      'ขอดูก่อนครับ',
      '===READ-NOTE name=OES Process===',
      '===READ-NOTE name=DFD===',
      '===SEARCH query=data flow===',
      '===ADD-TAGS name=A tags=exam===',
      '===REMOVE-TAGS name=B tags=old===',
      '===CANVAS-PLACE board=X note=Y at=0,2===',
      '===PLAN-STEP n=1 status=done note=รวบรวมแล้ว===',
      '===PLAN-STEP n=2 status=blocked note=ไม่พบไฟล์===',
      'จบรอบ',
    ].join('\n'));
    expect(r.rows.map((x) => x.label)).toEqual([
      'อ่าน: OES Process · DFD',
      'ค้นหา: data flow',
      'แก้แท็ก: 2 รายการ',
      'จัดแคนวาส: 1 รายการ',
      'ขั้น 1 ✓ รวบรวมแล้ว',
      'ขั้น 2 ✗ ไม่พบไฟล์',
    ]);
    expect(r.writing).toBeNull();
  });
  it('HAPPY: an OPEN note block → writing {name, chars}; UPDATED-SECTION falls back to heading', () => {
    const open = liveActivity('โอเค\n===NEW-NOTE name=สรุป บท 3===\n# สรุป\nเนื้อหายังเขียนอยู่');
    expect(open.rows).toEqual([]);
    expect(open.writing.name).toBe('สรุป บท 3');
    expect(open.writing.chars).toBe('# สรุป\nเนื้อหายังเขียนอยู่'.length);
    const sec = liveActivity('===UPDATED-SECTION heading=หัวข้อ 4===\nแก้ครึ่งๆ');
    expect(sec.writing.name).toBe('หัวข้อ 4');
  });
  it('HAPPY: a CLOSED block becomes a finished row; two blocks → two rows in order', () => {
    const r = liveActivity('===UPDATED-NOTE name=X===\nbody\n' + NOTE_CLOSE + '\n===NEW-NOTE name=Y===\nbody2\n' + NOTE_CLOSE);
    expect(r.writing).toBeNull();
    expect(r.rows.map((x) => x.label)).toEqual(['เขียนโน้ต "X" เสร็จ', 'เขียนโน้ต "Y" เสร็จ']);
    // unnamed UPDATED-NOTE (targets the open note) still yields a row, without quotes
    expect(liveActivity('===UPDATED-NOTE===\nb\n' + NOTE_CLOSE).rows[0].label).toBe('เขียนโน้ต เสร็จ');
  });
  it('EDGE: plain text / null → empty rows, null writing', () => {
    expect(liveActivity('คำตอบล้วนๆ ไม่มี verb')).toEqual({ rows: [], writing: null });
    expect(liveActivity('')).toEqual({ rows: [], writing: null });
    expect(liveActivity(null)).toEqual({ rows: [], writing: null });
  });
  it('EDGE: broken verbs are skipped, valid ones still land', () => {
    const r = liveActivity([
      '===READ-NOTE X===',            // no name=
      '===SEARCH query===',           // no value
      '===PLAN-STEP status=done===',  // no n=
      '===CANVAS-WIRE to=Z===',       // no from=
      '===CANVAS-ARRANGE===',         // valid, no-arg form
      '===READ-NOTE name=จริง===',
    ].join('\n'));
    expect(r.rows.map((x) => x.label)).toEqual(['จัดแคนวาส: 1 รายการ', 'อ่าน: จริง']);
  });
  it('passes labels through the supplied translate fn (i18n seam) and uses no lookbehind', () => {
    const r = liveActivity('===READ-NOTE name=A===', (s2) => s2 === 'อ่าน' ? 'Read' : s2);
    expect(r.rows[0].label).toBe('Read: A');
  });
});

// W2 guard: the console must be built ONCE per bubble — an innerHTML rebuild per render
// restarts the spinner's CSS animation (the buildWaitInto lesson, log 2026-08-25).
describe('live activity console guard (W2)', () => {
  it('chat.js creates .act-con only when absent, then updates text nodes', () => {
    const js = require('fs').readFileSync(require('path').join(__dirname, '../../renderer/chat.js'), 'utf8');
    expect(js).toMatch(/if \(!el\.querySelector\('\.act-con'\)\)/);
    expect(js).toMatch(/liveActivity/);          // wired to the core extractor
    expect(js).toMatch(/_actAt/);                // 400ms throttle state, not per-token parses
  });
});
