import { describe, it, expect } from 'vitest';
const CP = require('../../core/plan.js');

// Plan Mode (2026-09-22): the plan is a real markdown note "KUMIKO-PLAN — <title>.md";
// core/plan.js is the pure grammar — parse/serialize round-trip, immutable step updates,
// progress counting, and the bounded round budget for the auto-continue loop.

describe('CorePlan parse/serialize round-trip', () => {
  it('HAPPY: all 4 statuses + notes survive a round trip', () => {
    const md = '# สรุปวิชา DS\n\n- [ ] ยังไม่ทำ\n- [>] กำลังทำ — เริ่มแล้ว\n- [x] เสร็จ — ผ่านรีวิว 3 hunks\n- [!] ติดขัด — ไม่พบไฟล์\n';
    const plan = CP.parsePlan(md);
    expect(plan.title).toBe('สรุปวิชา DS');
    expect(plan.steps).toEqual([
      { text: 'ยังไม่ทำ', status: 'todo', note: '' },
      { text: 'กำลังทำ', status: 'doing', note: 'เริ่มแล้ว' },
      { text: 'เสร็จ', status: 'done', note: 'ผ่านรีวิว 3 hunks' },
      { text: 'ติดขัด', status: 'blocked', note: 'ไม่พบไฟล์' },
    ]);
    expect(CP.parsePlan(CP.serializePlan(plan))).toEqual(plan);
  });
  it('HAPPY: round-trips a note-less plan and a title-less plan', () => {
    const a = CP.parsePlan('- [ ] ขั้นเดียว ไม่มีโน้ต\n');
    expect(a.title).toBe('');
    expect(a.steps[0]).toEqual({ text: 'ขั้นเดียว ไม่มีโน้ต', status: 'todo', note: '' });
    expect(CP.parsePlan(CP.serializePlan(a))).toEqual(a);
    const b = CP.parsePlan('# แผนเปล่า ไม่มีขั้น\n\nเฉย ๆ');
    expect(b.steps).toEqual([]);
    expect(CP.parsePlan(CP.serializePlan(b))).toEqual(b);
  });
  it('EDGE: uppercase [X] is done; garbage/prose lines between checkboxes are skipped', () => {
    const md = '# t\n\n- [X] ตัวใหญ่\nprose line\nrandom\n- [ ] ถัดไป\n';
    const plan = CP.parsePlan(md);
    expect(plan.steps.map((s) => s.status)).toEqual(['done', 'todo']);
    expect(plan.steps.map((s) => s.text)).toEqual(['ตัวใหญ่', 'ถัดไป']);
  });
  it('EDGE: step text containing an em dash splits the note at the LAST " — "', () => {
    const plan = CP.parsePlan('- [x] สรุปบท 5 — Sorting — ครบ 3 หัวข้อ');
    expect(plan.steps[0].text).toBe('สรุปบท 5 — Sorting');
    expect(plan.steps[0].note).toBe('ครบ 3 หัวข้อ');
  });
});

describe('CorePlan applyStepUpdate', () => {
  const base = CP.parsePlan('# แผน\n\n- [x] เสร็จแล้ว\n- [ ] ขั้นสอง\n- [ ] ขั้นสาม\n');
  it('HAPPY: marks doing/done/blocked with a note, without mutating the original', () => {
    const doing = CP.applyStepUpdate(base, 2, 'doing');
    expect(doing).not.toBe(base);
    expect(doing.steps[1].status).toBe('doing');
    expect(base.steps[1].status).toBe('todo');            // original untouched
    const done = CP.applyStepUpdate(doing, 2, 'done', 'ผ่าน');
    expect(done.steps[1]).toEqual({ text: 'ขั้นสอง', status: 'done', note: 'ผ่าน' });   // done replaces the doing state
    const blocked = CP.applyStepUpdate(base, 3, 'blocked', 'ติดอะไร');
    expect(blocked.steps[2].status).toBe('blocked');
  });
  it('HAPPY: setting doing keeps OTHER unfinished doing steps as they were', () => {
    const two = CP.parsePlan('# แผน\n\n- [>] กำลังทำหนึ่ง\n- [ ] สอง\n');
    const next = CP.applyStepUpdate(two, 2, 'doing');
    expect(next.steps[0].status).toBe('doing');           // kept
    expect(next.steps[1].status).toBe('doing');
  });
  it('HAPPY: omitted note keeps the existing note', () => {
    const noted = CP.parsePlan('- [>] ขั้น — กลางคัน\n');
    const next = CP.applyStepUpdate(noted, 1, 'done');
    expect(next.steps[1 - 1].note).toBe('กลางคัน');
  });
  it('EDGE: unknown status or n out of range returns the SAME plan object', () => {
    expect(CP.applyStepUpdate(base, 2, 'bogus')).toBe(base);
    expect(CP.applyStepUpdate(base, 0, 'done')).toBe(base);
    expect(CP.applyStepUpdate(base, 4, 'done')).toBe(base);
    expect(CP.applyStepUpdate(base, -1, 'done')).toBe(base);
  });
});

describe('CorePlan planProgress', () => {
  it('HAPPY: counts done/total/blocked; doing = 1-based index of the FIRST doing step', () => {
    const plan = CP.parsePlan('# แผน\n\n- [x] หนึ่ง\n- [>] สอง\n- [>] สาม\n- [ ] สี่\n- [!] ห้า\n');
    expect(CP.planProgress(plan)).toEqual({ done: 1, total: 5, blocked: 1, doing: 2 });
  });
  it('EDGE: no doing step → doing 0; empty plan → zeros', () => {
    expect(CP.planProgress(CP.parsePlan('- [x] เดียว')).doing).toBe(0);
    expect(CP.planProgress(CP.parsePlan(''))).toEqual({ done: 0, total: 0, blocked: 0, doing: 0 });
  });
});

describe('CorePlan planAllowContinue', () => {
  it('HAPPY: rounds 0 and 1 are free; later rounds require progress; the cap always cuts', () => {
    expect(CP.planAllowContinue({ round: 0, progressed: false })).toBe(true);
    expect(CP.planAllowContinue({ round: 1, progressed: false })).toBe(true);
    expect(CP.planAllowContinue({ round: 5, progressed: true })).toBe(true);
    expect(CP.planAllowContinue({ round: 5, progressed: false })).toBe(false);
    expect(CP.planAllowContinue({ round: 11, cap: 12, progressed: true })).toBe(true);
    expect(CP.planAllowContinue({ round: 12, cap: 12, progressed: true })).toBe(false);
    expect(CP.planAllowContinue({ round: 20, progressed: true })).toBe(false);   // default cap = PLAN_ROUND_CAP
  });
  it('the default cap is 12', () => {
    expect(CP.PLAN_ROUND_CAP).toBe(12);
  });
});

describe('CorePlan planStallAction (stall verdict: continue | nudge | pause)', () => {
  it('HAPPY: free rounds continue; progress continues even when already nudged', () => {
    expect(CP.planStallAction({ round: 0, progressed: false })).toBe('continue');
    expect(CP.planStallAction({ round: 1, progressed: false })).toBe('continue');
    expect(CP.planStallAction({ round: 5, progressed: true, nudged: true })).toBe('continue');   // progressed beats nudged
  });
  it('HAPPY: first stall past the free rounds nudges; a second stall pauses', () => {
    expect(CP.planStallAction({ round: 2, progressed: false, nudged: false })).toBe('nudge');
    expect(CP.planStallAction({ round: 3, progressed: false, nudged: false })).toBe('nudge');
    expect(CP.planStallAction({ round: 3, progressed: false, nudged: true })).toBe('pause');     // nudged already → never nudge twice
  });
  it('EDGE: the cap beats everything — even real progress', () => {
    expect(CP.planStallAction({ round: 12, cap: 12, progressed: true })).toBe('pause');
    expect(CP.planStallAction({ round: 12, cap: 12, progressed: false, nudged: false })).toBe('pause');
    expect(CP.planStallAction({ round: 20, progressed: true })).toBe('pause');   // default cap = 12
  });
  it('EDGE: round 0 nudged=true still continues (free round beats nudged); empty input is a free round', () => {
    expect(CP.planStallAction({ round: 0, nudged: true })).toBe('continue');
    expect(CP.planStallAction({})).toBe('continue');
  });
  it('REGRESSION (live 2026-09-23): nudged + still no progress → pause, so the nudge itself can never loop', () => {
    expect(CP.planStallAction({ round: 4, progressed: false, nudged: true })).toBe('pause');
  });
});

describe('CorePlan planLogEntry (worklog entry)', () => {
  const plan = CP.parsePlan('# สรุปวิชา DS\n\n- [x] อ่านบท 5 — ลิงก์ [[Sorting]]\n- [x] ทำแบบฝึกหัด\n- [ ] สรุปลงโน้ต\n');
  it('HAPPY: header + done/total + minutes + summary, every step line kept verbatim (wikilinks intact)', () => {
    const t1 = Date.now(), t0 = t1 - 25 * 60000;
    const e = CP.planLogEntry(plan, { date: '2026-09-22', summary: 'จบบท 5', startedAt: t0, endedAt: t1 });
    expect(e).toBe('## 2026-09-22 · สรุปวิชา DS\n\n' +
      '✓ 2/3 ขั้น · ใช้เวลา 25 นาที — จบบท 5\n' +
      '- [x] อ่านบท 5 — ลิงก์ [[Sorting]]\n' +
      '- [x] ทำแบบฝึกหัด\n' +
      '- [ ] สรุปลงโน้ต\n');
  });
  it('EDGE: no summary → no dash tail; no times → no minutes part', () => {
    const e = CP.planLogEntry(plan, { date: '2026-09-22' });
    expect(e).toContain('✓ 2/3 ขั้น\n');
    expect(e).not.toContain('ใช้เวลา');
    expect(e.split('\n')[2]).toBe('✓ 2/3 ขั้น');   // headline carries no " — summary" tail
    expect(e).toContain('- [ ] สรุปลงโน้ต\n');
  });
  it('EDGE: a plan with blocked steps logs them as [ ]/[!] as they really are', () => {
    const blocked = CP.parsePlan('# แผนติดขัด\n\n- [x] อ่านแล้ว\n- [!] ติดขัด — ไม่พบไฟล์\n- [ ] ยังไม่ทำ\n');
    const e = CP.planLogEntry(blocked, { date: '2026-09-22', summary: 'เลิกกลางคัน' });
    expect(e).toContain('✓ 1/3 ขั้น — เลิกกลางคัน\n');
    expect(e).toContain('- [!] ติดขัด — ไม่พบไฟล์\n');
    expect(e).toContain('- [ ] ยังไม่ทำ\n');
  });
});

describe('CorePlan planLogPrepend (newest entry under the worklog header)', () => {
  const HEAD = '# KUMIKO-LOG\n\nสมุดบันทึกงานที่ AI ทำตามแผน\n\n';
  it('HAPPY: new entry lands between the header and the previous entry', () => {
    const cur = HEAD + '## 2026-09-20 · เก่า\n\n✓ 1/1 ขั้น — เก่า\n';
    const out = CP.planLogPrepend(cur, '## 2026-09-22 · ใหม่\n\n✓ 1/1 ขั้น\n');
    expect(out.indexOf('# KUMIKO-LOG')).toBeLessThan(out.indexOf('## 2026-09-22'));
    expect(out.indexOf('## 2026-09-22')).toBeLessThan(out.indexOf('## 2026-09-20'));
    expect(out.startsWith(HEAD)).toBe(true);
    expect(out).toContain('## 2026-09-20');   // the old entry survives below
  });
  it('EDGE: empty/absent worklog → the entry alone; headerless file → entry on top', () => {
    expect(CP.planLogPrepend('', '## a\n')).toBe('## a\n');
    expect(CP.planLogPrepend(null, '## a\n')).toBe('## a\n');
    expect(CP.planLogPrepend('no header shape\n', '## a\n')).toBe('## a\n\nno header shape\n');
  });
});

describe('plan loop guards — the 1s respawn loop can never come back (live bug 2026-09-22)', () => {
  const fs = require('fs'); const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  const fnSrc = (f, name) => { const r = read(f); const i = r.indexOf('function ' + name); return r.slice(i); };
  it('engine failure while a plan is active pauses the plan instead of refiring (happy)', () => {
    const chat = read('renderer/chat.js');
    expect(chat).toMatch(/_failed = payload && payload\.code != null && payload\.code !== 0/);
    expect(chat).toMatch(/if \(_failed\) \{\s*\n\s*s\.plan\.active = false/);
  });
  it('the stall gate counts the PLAN round counter, never the resettable tool counter (edge)', () => {
    const r = read('renderer/renderer.js');
    // 2026-09-23: the boolean gate became planStallAction — the guard intent is unchanged
    expect(r).toMatch(/planStallAction\(\{ round: \(s\.plan\.rounds \|\| 0\)/);
    expect(r).not.toMatch(/planStallAction\(\{ round: s\._toolRounds/);
    expect(r).not.toMatch(/planAllowContinue\(\{ round: s\._toolRounds/);
    expect(r).toMatch(/s\.plan\.rounds = \(s\.plan\.rounds \|\| 0\) \+ 1/);
  });
});

describe('plan stall fix — nudge once, then pause without looking like an error (live bug 2026-09-23)', () => {
  const fs = require('fs'); const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
  const fnSrc = (r, name) => r.slice(r.indexOf('async function ' + name));
  it('planContinueRound routes through planStallAction, not the old boolean gate', () => {
    const fn = fnSrc(read('renderer/renderer.js'), 'planContinueRound');
    expect(fn).toMatch(/planStallAction\(\{ round: \(s\.plan\.rounds \|\| 0\)/);
    expect(fn).not.toContain('planAllowContinue');
  });
  it('the nudge branch arms s.plan._nudged = true and carries the tick instruction', () => {
    const fn = fnSrc(read('renderer/renderer.js'), 'planContinueRound');
    expect(fn).toMatch(/s\.plan\._nudged = true/);
    expect(fn).toMatch(/status=done note=สรุป===/);
    expect(fn).toMatch(/ห้ามเรียก READ-NOTE ซ้ำ/);
  });
  it('the pause message reads as a pause, not an error: ▶ ทำต่อ present, bare "ไม่มีความคืบหน้า" gone', () => {
    const fn = fnSrc(read('renderer/renderer.js'), 'planContinueRound');
    expect(fn).toContain('▶ ทำต่อ');
    expect(fn).not.toContain('ไม่มีความคืบหน้า');
  });
  it('planStatusBlock tells the model to tick the current doing step immediately', () => {
    const r = read('renderer/renderer.js');
    const fn = r.slice(r.indexOf('async function planStatusBlock'), r.indexOf('async function planRoundPrompt'));
    expect(fn).toContain('status=done=== ทันที');
    expect(fn).toContain('ห้ามทำขั้นที่เสร็จแล้วซ้ำ');
  });
  it('a progressing round resets the nudge flag (fresh nudge budget each time work moves)', () => {
    const fn = fnSrc(read('renderer/renderer.js'), 'planContinueRound');
    expect(fn).toMatch(/s\.plan\._nudged = false/);
  });
  it('the nudge round rides the same round counter via firePlanRound — nudges are bounded by the cap too', () => {
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/s\.plan\.rounds = \(s\.plan\.rounds \|\| 0\) \+ 1/);
  });
  it('turn read-memory: reads are tracked and fed to the continuation prompt with a no-reread order', () => {
    const r = read('renderer/renderer.js');
    expect(r).toMatch(/window\.__turnReads = window\.__turnReads \|\| \[\]\)\.push/);
    expect(r).toContain('ไฟล์ที่อ่านแล้วในงานนี้ (เนื้อหาอยู่ด้านบน ห้ามขออ่านซ้ำ): ');
    const chat = read('renderer/chat.js');
    expect(chat).toMatch(/window\.__turnReads = \[\]/);   // reset at end of turn…
    expect(r).toMatch(/window\.__turnReads = \[\]/);      // …and again on a fresh user message
  });
});
