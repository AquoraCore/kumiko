import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const M = require('../../core/memory.js');
const MD = require('../../core/markdown.js');

// Memory layer (2026-08-25): per-vault fact store in KUMIKO-MEMORY.md. Profile (ผู้ใช้) cards
// inject on every question; the rest are scored against the question; >90-day cards fade out
// of injection; all AI writes go through REMEMBER/FORGET confirm cards.

describe('CoreMemory parse/serialize', () => {
  const md = M.serialize([
    { type: 'user', text: 'ชอบสรุปเป็นตาราง', ts: '2026-08-18' },
    { type: 'subject', text: 'สอบ 12 ก.ย. เน้นบท 10-11', ts: '2026-08-25' },
    { type: 'ref', text: 'เล่มหลักคือ chapter11', ts: '2026-08-24' },
  ]);
  it('happy: round-trips cards with type sections and date stamps', () => {
    const cards = M.parse(md, '2026-08-25');
    expect(cards.length).toBe(3);
    const subj = cards.find((c) => c.type === 'subject');
    expect(subj.text).toBe('สอบ 12 ก.ย. เน้นบท 10-11');
    expect(subj.ts).toBe('2026-08-25');
    expect(cards.find((c) => c.type === 'user').ts).toBe('2026-08-18');
  });
  it('edge: a hand-added line without a stamp gets today, unknown heading falls back to วิชา', () => {
    const cards = M.parse('## อะไรก็ไม่รู้\n\n- จดเอง\n', '2026-08-25');
    expect(cards).toEqual([expect.objectContaining({ type: 'subject', text: 'จดเอง', ts: '2026-08-25' })]);
  });
  it('edge: empty file, blank lines, and multiline text flattening', () => {
    expect(M.parse('', '2026-08-25')).toEqual([]);
    const one = M.addCard([], 'user', 'บรรทัด\nที่สอง', '2026-08-25');
    expect(one[0].text).toBe('บรรทัด ที่สอง');
  });
  it('normType accepts Thai and English, defaults to subject', () => {
    expect(M.normType('ผู้ใช้')).toBe('user');
    expect(M.normType('ref')).toBe('ref');
    expect(M.normType('งง')).toBe('subject');
  });
});

describe('CoreMemory select — what gets injected', () => {
  const NOW = Date.parse('2026-08-25T12:00:00Z');
  const cards = [
    { id: 'a', type: 'user', text: 'ชอบสรุปเป็นตาราง', ts: '2026-08-18' },
    { id: 'b', type: 'subject', text: 'สอบกลางภาค 12 กันยายน เน้นบท Billing AR', ts: '2026-08-25' },
    { id: 'c', type: 'ref', text: 'เล่มหลักของ Billing คือ chapter11', ts: '2026-08-24' },
    { id: 'd', type: 'subject', text: 'ควิซบท 8 วันศุกร์', ts: '2026-05-01' },   // 116 days → faded
    { id: 'e', type: 'state', text: 'เรื่องที่ไม่เกี่ยวเลยสักนิด xyz', ts: '2026-08-25' },
  ];
  it('happy: profile always in, relevant cards match the question, faded excluded', () => {
    const s = M.select(cards, 'ช่วยสรุปเรื่อง Billing ก่อนสอบกลางภาค', { now: NOW });
    expect(s.profile.map((c) => c.id)).toEqual(['a']);
    const relIds = s.relevant.map((c) => c.id);
    expect(relIds).toContain('b');
    expect(relIds).not.toContain('d');   // faded
    expect(s.total).toBe(4);             // live cards only
  });
  it('edge: budget caps injection', () => {
    const s = M.select(cards, 'Billing สอบกลางภาค', { now: NOW, budget: 20 });
    expect(s.chars).toBeLessThanOrEqual(20);
  });
  it('edge: empty query injects profile only', () => {
    const s = M.select(cards, '', { now: NOW });
    expect(s.profile.length).toBe(1);
    expect(s.relevant.length).toBe(0);
  });
  it('promptBlock formats the two lines and returns injected ids', () => {
    const pb = M.promptBlock(cards, 'สรุป Billing ก่อนสอบกลางภาค', { now: NOW });
    expect(pb.text).toContain('[ความจำ · โปรไฟล์]');
    expect(pb.text).toContain('[ความจำ · เกี่ยวกับคำถามนี้');
    expect(pb.ids).toContain('a');
  });
  it('edge: no cards at all → empty prompt', () => {
    expect(M.promptBlock([], 'x', {}).text).toBe('');
  });
});

// 2026-09-26: the block header must scope the memory to the tab's subject — a cross-subject
// card ("โจทย์ Business" from CRAFT) hit by bigram relevance in another subject's tab was
// answered as if it belonged there. The fix is prompt-level only; scoring is untouched.
describe('CoreMemory promptBlock — tab scoping header', () => {
  const NOW = Date.parse('2026-09-26T12:00:00Z');
  const cards = [
    { id: 'a', type: 'user', text: 'ชอบสรุปเป็นตาราง', ts: '2026-09-01' },
    { id: 'b', type: 'state', text: 'วิชา CRAFT: โจทย์ Business ชุด 3 ยังไม่ทำ', ts: '2026-09-20' },
  ];
  it('happy: with tabName the header names the tab and warns about other subjects', () => {
    const pb = M.promptBlock(cards, 'ขอตัวอย่างโจทย์ Business ฝึกเขียนหน่อย', { now: NOW, tabName: 'BUS SW REQ ANAL' });
    expect(pb.text).toContain('แท็บสนทนานี้คือ "BUS SW REQ ANAL"');
    expect(pb.text).toContain('ความจำรวมทุกวิชา/ทุกเรื่องใน vault');
    expect(pb.text).toContain('ใบที่เป็นของวิชา/เรื่องอื่นให้เพิกเฉย');
    expect(pb.text).toContain('ห้ามทึกทักว่าสถานะงาน/โจทย์ของวิชาอื่นเป็นของแท็บนี้');
  });
  it('happy: without tabName the tab sentence is gone but the cross-subject warning stays', () => {
    const pb = M.promptBlock(cards, 'ขอตัวอย่างโจทย์ Business ฝึกเขียนหน่อย', { now: NOW });
    expect(pb.text).not.toContain('แท็บสนทนานี้คือ');
    expect(pb.text).toContain('ใบที่เป็นของวิชา/เรื่องอื่นให้เพิกเฉย');
  });
  it('edge: tabName is trimmed and capped at 60 chars', () => {
    const long = '  ' + 'x'.repeat(80) + '  ';
    const pb = M.promptBlock(cards, 'x', { now: NOW, tabName: long });
    const m = pb.text.match(/แท็บสนทนานี้คือ "([^"]*)"/);
    expect(m && m[1]).toBe('x'.repeat(60));
  });
  it('edge: empty / whitespace / non-string tabName → treated as absent', () => {
    for (const bad of ['', '   ', null, 42]) {
      const pb = M.promptBlock(cards, 'x', { now: NOW, tabName: bad });
      expect(pb.text).not.toContain('แท็บสนทนานี้คือ');
    }
  });
  it('tabName never changes the selection: ids and sel are identical', () => {
    const noTab = M.promptBlock(cards, 'ขอตัวอย่างโจทย์ Business', { now: NOW });
    const withTab = M.promptBlock(cards, 'ขอตัวอย่างโจทย์ Business', { now: NOW, tabName: 'BUS SW REQ ANAL' });
    expect(withTab.ids).toEqual(noTab.ids);
    expect(withTab.sel.profile.map((c) => c.id)).toEqual(noTab.sel.profile.map((c) => c.id));
    expect(withTab.sel.relevant.map((c) => c.id)).toEqual(noTab.sel.relevant.map((c) => c.id));
  });
});

describe('CoreMemory detectType — auto classification', () => {
  it('happy: one clear example per type', () => {
    expect(M.detectType('ชอบสรุปเป็นตารางเทียบ มีตัวอย่างตัวเลข')).toBe('user');
    expect(M.detectType('สอบกลางภาค 12 ก.ย. เน้นบท 10-11')).toBe('subject');
    expect(M.detectType('เล่มหลักของวิชานี้คือ chapter11.pdf')).toBe('ref');
    expect(M.detectType('อ่านถึงหน้า 20 แล้ว ยังไม่สรุป Credit note')).toBe('state');
  });
  it('edge: course cues beat user cues — "อาจารย์ให้ส่งงาน..." must stay in-vault (not global)', () => {
    expect(M.detectType('อาจารย์ให้ส่งงานทาง MyCourseVille เท่านั้น')).toBe('subject');
    expect(M.detectType('อาจารย์ชอบออกข้อสอบจากสไลด์ท้ายบท')).toBe('subject');
  });
  it('edge: state cues beat ref cues ("อ่านถึง...chapter11")', () => {
    expect(M.detectType('อ่านถึงหน้า 20 ของ chapter11')).toBe('state');
  });
  it('edge: no cue at all falls back to วิชา (in-vault — the safe default)', () => {
    expect(M.detectType('ข้อความกลาง ๆ')).toBe('subject');
    expect(M.detectType('')).toBe('subject');
  });
  it('normTypeOr: explicit valid type wins; missing/unknown detects from text', () => {
    expect(M.normTypeOr('ผู้ใช้', 'สอบพรุ่งนี้')).toBe('user');
    expect(M.normTypeOr('', 'ชอบตอบสั้น ๆ')).toBe('user');
    expect(M.normTypeOr('งง?', 'เล่มหลักคือ chapter11.pdf')).toBe('ref');
  });
});

describe('CoreMemory profileExtra — the cross-vault global profile', () => {
  const NOW = Date.parse('2026-08-29T12:00:00Z');
  const globalCards = [{ id: 'g1', type: 'user', text: 'ตอบเป็นภาษาไทยเสมอ', ts: '2025-01-01', g: true }];
  const vaultCards = [
    { id: 'v1', type: 'user', text: 'วิชานี้ขอสั้น ๆ', ts: '2026-08-29' },
    { id: 'v2', type: 'subject', text: 'สอบ Billing 12 ก.ย.', ts: '2026-08-29' },
  ];
  it('happy: global cards inject first as profile and NEVER fade (ts 600+ days old)', () => {
    const s = M.select(vaultCards, 'Billing', { now: NOW, profileExtra: globalCards });
    expect(s.profile.map((c) => c.id)).toEqual(['g1', 'v1']);   // global first, vault user after
    expect(s.relevant.map((c) => c.id)).toEqual(['v2']);
  });
  it('edge: budget spends on the global profile before vault cards', () => {
    const s = M.select(vaultCards, 'Billing', { now: NOW, profileExtra: globalCards, budget: globalCards[0].text.length + 1 });
    expect(s.profile.map((c) => c.id)).toEqual(['g1']);
    expect(s.relevant).toEqual([]);
  });
  it('edge: no vault cards at all still yields a profile-only block with the global ids', () => {
    const pb = M.promptBlock([], 'อะไรก็ได้', { now: NOW, profileExtra: globalCards });
    expect(pb.text).toContain('[ความจำ · โปรไฟล์] ตอบเป็นภาษาไทยเสมอ');
    expect(pb.ids).toEqual(['g1']);
  });
});

describe('CoreMemory processing — upsert (dedupe-replace) + organize (age groups)', () => {
  const NOW = Date.parse('2026-08-29T12:00:00Z');
  it('happy: a near-duplicate REPLACES the old card (newest wins), a distinct one stacks', () => {
    let cards = M.addCard([], 'subject', 'สอบกลางภาค 12 ก.ย. เน้นบท 10-11 (Sales, Billing/AR)', '2026-08-20');
    const r = M.upsertCard(cards, 'subject', 'สอบกลางภาค เลื่อนเป็น 19 ก.ย. เน้นบท 10-11 (Sales, Billing/AR)', '2026-08-29');
    expect(r.added).toBe(true);
    expect(r.replaced && r.replaced.text).toContain('12 ก.ย.');
    expect(r.cards.length).toBe(1);
    expect(r.cards[0].text).toContain('19 ก.ย.');
    const r2 = M.upsertCard(r.cards, 'subject', 'ควิซบท 3 ศุกร์หน้า', '2026-08-29');
    expect(r2.replaced).toBe(null);
    expect(r2.cards.length).toBe(2);
  });
  it('edge: exact duplicate is a no-op; different TYPE never replaces; empty text no-op', () => {
    const cards = M.addCard([], 'subject', 'สอบ 12 ก.ย.', '2026-08-20');
    expect(M.upsertCard(cards, 'subject', 'สอบ 12 ก.ย.', '2026-08-29').added).toBe(false);
    const r = M.upsertCard(cards, 'state', 'สอบ 12 ก.ย.', '2026-08-29');
    expect(r.replaced).toBe(null);
    expect(r.cards.length).toBe(2);
    expect(M.upsertCard(cards, 'subject', '  ', '2026-08-29').added).toBe(false);
  });
  it('organize groups by age (fresh ≤14d · recent · old >90d) with global first, newest first', () => {
    const g = M.organize([
      { id: 'g', type: 'user', text: 'โปรไฟล์', ts: '2025-01-01', g: true },   // old ts but global → never "old"
      { id: 'f', type: 'subject', text: 'ใหม่', ts: '2026-08-28' },
      { id: 'r', type: 'ref', text: 'กลางเทอม', ts: '2026-07-01' },
      { id: 'o', type: 'subject', text: 'นานแล้ว', ts: '2026-05-01' },
    ], NOW);
    expect(g.global.map((c) => c.id)).toEqual(['g']);
    expect(g.fresh.map((c) => c.id)).toEqual(['f']);
    expect(g.recent.map((c) => c.id)).toEqual(['r']);
    expect(g.old.map((c) => c.id)).toEqual(['o']);
  });
  it('edge: organize with empty input and undated cards (age 0 → fresh)', () => {
    expect(M.organize([], NOW)).toEqual({ global: [], fresh: [], recent: [], old: [] });
    expect(M.organize([{ id: 'x', type: 'subject', text: 'ไม่มีวันที่', ts: '' }], NOW).fresh.length).toBe(1);
  });
});

describe('CoreMemory card ops', () => {
  it('addCard dedupes identical (type,text) and caps at 300 chars', () => {
    let cards = M.addCard([], 'subject', 'a'.repeat(500), '2026-08-25');
    expect(cards[0].text.length).toBe(300);
    expect(M.addCard(cards, 'subject', 'a'.repeat(500), '2026-08-25').length).toBe(1);
  });
  it('findByText matches by case-insensitive substring; removeCard removes by id', () => {
    const cards = M.addCard([], 'ref', 'เล่มหลักคือ Chapter11', '2026-08-25');
    const hit = M.findByText(cards, 'chapter11');
    expect(hit).toBeTruthy();
    expect(M.removeCard(cards, hit.id)).toEqual([]);
    expect(M.findByText(cards, 'ไม่มี')).toBe(null);
  });
});

describe('===REMEMBER===/===FORGET=== extraction (CoreMarkdown)', () => {
  it('happy: block with type + single-line forget, chat text cleaned', () => {
    const r = MD.extractMemories('ได้ครับ\n\n===REMEMBER type=วิชา===\nสอบ 12 ก.ย.\n===END-NOTE===\n\n===FORGET text=ควิซบท 8===\n\nสรุปแล้วนะ');
    expect(r.memories).toEqual([{ type: 'วิชา', text: 'สอบ 12 ก.ย.' }]);
    expect(r.forgets).toEqual(['ควิซบท 8']);
    expect(r.chat).toBe('ได้ครับ\n\nสรุปแล้วนะ');
  });
  it('edge: REMEMBER without type, unclosed block, empty body dropped', () => {
    expect(MD.extractMemories('===REMEMBER===\nจำนี่\n===END-NOTE===').memories).toEqual([{ type: '', text: 'จำนี่' }]);
    expect(MD.extractMemories('===REMEMBER type=x===\nยังไม่จบ').memories).toEqual([{ type: 'x', text: 'ยังไม่จบ' }]);
    expect(MD.extractMemories('===REMEMBER===\n\n===END-NOTE===').memories).toEqual([]);
  });
  it('historyText compresses memory proposals into a bracket note', () => {
    const h = MD.historyText('โอเค\n===REMEMBER type=วิชา===\nสอบ 12 ก.ย.\n===END-NOTE===');
    expect(h).toContain('[เสนอความจำ 1 ใบแล้ว]');
    expect(h).not.toContain('===REMEMBER');
  });
});

describe('wiring guards', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../../', p), 'utf8');
  it('sendChat injects memory + the learn prompt (both prompt branches)', () => {
    const r = read('renderer/renderer.js');
    expect(r).toContain('await kumikoMemoryPrompt(msg, s.name || \'\')');
    expect((r.match(/rules \+ mem \+ reviewFb/g) || []).length).toBe(2);
    expect((r.match(/kumikoMemoryLearnPrompt\(\)/g) || []).length).toBeGreaterThanOrEqual(2);
  });
  it('sendChat states the tab subject in BOTH branches (tabLine before rules)', () => {
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/const tabLine = \(s && s\.name\) \?\n?\s*\('หัวข้อของแท็บสนทนานี้: "' \+ s\.name \+ '"\\n'\) : '';/);
    expect((r.match(/tabLine \+ rules \+ mem/g) || []).length).toBe(2);
  });
  it('memsys passes tabName through to promptBlock; learn prompt demands subject context', () => {
    const ms = read('renderer/memsys.js');
    expect(ms).toContain('async function kumikoMemoryPrompt(query, tabName)');
    expect(ms).toMatch(/promptBlock\(cards, query \|\| '', \{ now: Date\.now\(\), profileExtra: gcards, tabName: tabName \}\)/);
    expect(ms).toContain('ทุกใบความจำต้องระบุวิชา/บริบทของมันในข้อความเสมอ');
    expect(ms).toContain('ใบที่ไม่ระบุวิชาจะถูกฉีดข้ามแท็บแล้วทำให้ตอบผิดวิชา');
  });
  it('chat wires the confirm card + display scrub + 🧠 desk button', () => {
    const c = read('renderer/chat.js');
    expect(c).toContain('maybeProposeMemories(last.text');
    expect(c).toContain('extractMemories(s)');
    expect(c).toContain('openMemoryDesk');
  });
  it('KUMIKO-MEMORY.md is hidden from lists in BOTH shells and AI-write-protected', () => {
    // 2026-09-22: hidden via the root-level KUMIKO* prefix rule (with KUMIKO-LOG/PLAN files)
    expect(read('main.js')).toContain("ent.name.startsWith('KUMIKO')");
    expect(read('web/api-web.js')).toContain("n.indexOf('KUMIKO') !== 0");
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/_aiProtectedName[\s\S]{0,200}'kumiko-memory'/);
    // rules desk must NOT open for the memory file
    expect(r).toMatch(/function isRulesNote[^\n]*'kumiko'/);
  });
  it('global profile plumbing exists end-to-end (desktop IPC · server · web shim)', () => {
    const pre = read('preload.js');
    expect(pre).toContain("readGlobalMemory: () => ipcRenderer.invoke('memory:global:read')");
    expect(pre).toContain("saveGlobalMemory: (content) => ipcRenderer.invoke('memory:global:save', content)");
    const m = read('main.js');
    expect(m).toContain("ipcMain.handle('memory:global:read'");
    expect(m).toMatch(/globalMemFile[\s\S]{0,120}userData[\s\S]{0,60}KUMIKO-GLOBAL\.md/);
    const srv = read('server/index.js');
    expect(srv).toContain("app.get('/memory/global', requireAuth");
    expect(srv).toContain("app.put('/memory/global', requireAuth");
    expect(srv).toMatch(/gmemPath[\s\S]{0,160}encodeURIComponent\(String\(uid\)\), 'KUMIKO-GLOBAL\.md'/);
    const shim = read('web/api-web.js');
    expect(shim).toContain('async function readGlobalMemory');
    expect(shim).toContain("req('PUT', '/memory/global'");
    expect(shim).toContain('readGlobalMemory, saveGlobalMemory,');
  });
  it('memsys: always-auto typing, global routing, upsert dedupe, view-only desk', () => {
    const ms = read('renderer/memsys.js');
    // saves auto-classify (normTypeOr) and go through upsertCard so near-dups replace
    expect(ms).toContain('async function memSaveRouted');
    expect(ms).toMatch(/normTypeOr\(type, text\)/);
    expect((ms.match(/upsertCard\(/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(ms).toContain('profileExtra: gcards');
    // chip: type ALWAYS detected from the text (AI's type= parsed but not trusted), no <select>
    expect(ms).toContain('detectType(m.text)');
    expect(ms).not.toContain('mem-c-type');
    // re-classifies after "แก้ก่อนจำ"
    expect(ms).toMatch(/แก้ก่อนจำ[\s\S]{0,700}detectType\(it\.text\)/);
    // desk is VIEW-ONLY: grouped via organize(), no add-row/edit/delete/keep controls
    expect(ms).toContain('window.CoreMemory.organize(cards, now)');
    for (const gone of ['mem-add', 'mem-ib', 'mem-keep', 'mem-drop', 'mem-edit-inp', 'confirmDelete']) {
      expect(ms).not.toContain(gone);
    }
    // ...but keeps a doorway to hand-edit the raw file
    expect(ms).toContain('openNote(MEMORY_FILE)');
  });
  it('both shells load core/memory.js and memsys.js', () => {
    expect(read('renderer/index.html')).toContain('core/memory.js');
    expect(read('renderer/index.html')).toContain('memsys.js');
    expect(read('web/index.html')).toContain('/core/memory.js');
    expect(read('web/index.html')).toContain('/renderer/memsys.js');
  });
});
