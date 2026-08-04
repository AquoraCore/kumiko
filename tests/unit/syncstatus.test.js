import { describe, it, expect } from 'vitest';
const { syncStatusView, relTime } = require('../../core/syncstatus');

describe('syncStatusView', () => {
  it('syncing/offline/error/idle map to tones', () => {
    expect(syncStatusView({ state:'syncing' }).tone).toBe('busy');
    expect(syncStatusView({ state:'offline' }).tone).toBe('warn');
    expect(syncStatusView({ state:'error' }).tone).toBe('err');
    expect(syncStatusView({ state:'idle' }).label).toBe('');   // hidden
  });
  it('synced shows a relative time', () => {
    const v = syncStatusView({ state:'synced', at:1000, now:1000 + 5*60*1000 });
    expect(v.tone).toBe('ok');
    expect(v.label).toContain('5 นาทีที่แล้ว');
  });
  it('relTime buckets', () => {
    // at must be a real epoch (production passes Date.now(), never 0 — relTime's !at guard
    // treats 0 as "no timestamp"). Use a fixed base + deltas.
    const T = 1_700_000_000_000;
    expect(relTime(T, T + 5000)).toBe('เมื่อสักครู่');              // <10s
    expect(relTime(T, T + 30000)).toBe('30 วินาทีที่แล้ว');
    expect(relTime(T, T + 2*60*1000)).toBe('2 นาทีที่แล้ว');
    expect(relTime(T, T + 3*3600*1000)).toBe('3 ชั่วโมงที่แล้ว');
    expect(relTime(T, T + 2*86400*1000)).toBe('2 วันที่แล้ว');
  });
});
