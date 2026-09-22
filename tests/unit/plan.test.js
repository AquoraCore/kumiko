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
