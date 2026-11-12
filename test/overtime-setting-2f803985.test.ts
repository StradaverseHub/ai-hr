/**
 * 2f803985 — the Schedule Group Overtime Setting, checked against the reporter's own worked examples.
 *
 * These are the deterministic pieces the Overtime Setting section drives: the stored policy contract
 * (lib/attendance-group-policy.ts), duration finalisation and rounding (core/attendance-calc.ts), lateness
 * offset (packs/attendance/policy-duration.ts) and the midnight split (packs/attendance/policy-partition.ts).
 * The section's screen and writer are released only with the ADR-0134 execution work; nothing here reaches pay.
 */
import { describe, expect, it } from 'vitest';
import { finalizePolicyOvertimeDuration } from '../core/attendance-calc';
import { ATTENDANCE_POLICY_DAY_CLASSES, validateAttendanceGroupPolicy, type AttendanceGroupPolicy } from '../lib/attendance-group-policy';
import { selectAttendancePolicyCandidate } from '../packs/attendance/policy-duration';
import { partitionAttendancePolicyWork } from '../packs/attendance/policy-partition';

const pattern = '00000000-0000-4000-8000-000000000001';
const companyId = '00000000-0000-4000-8000-000000000002';
const policy = (): AttendanceGroupPolicy => ({
  version: 1,
  clock: { pairing: 'auto', minimumIntervalMinutes: 0, lateGraceMinutes: 0, earlyGraceMinutes: 0, skipLatenessIfIncomplete: true },
  overtime: { enabled: true, beforeShift: true, afterShift: true, allowBackdatedWithoutClock: false, splitAtMidnight: true, offsetLateness: true,
    approval: 'auto', autoMethod: 'intersect', rounding: { mode: 'down', step: 15 },
    days: Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key => [key, { minimumMinutes: 0, maximumMinutes: null, patternVersionId: pattern }])) as AttendanceGroupPolicy['overtime']['days'] },
});
const finalize = (p: AttendanceGroupPolicy['overtime'], minutes: number, limit: number | null = null) =>
  finalizePolicyOvertimeDuration({ policy: p, dayClass: 'normal', approvedEligibleMinutes: minutes, preApprovedLimitMinutes: limit, periodMinutes: 1440 });

describe('Overtime Rounding Method and Overtime Rounding to Minute (the request table)', () => {
  it.each([
    [46, 15, 'up', 60], [46, 15, 'down', 45],
    [61, 30, 'up', 90], [61, 30, 'down', 60],
    [91, 45, 'up', 135], [91, 45, 'down', 90],
  ] as const)('%i minutes at %i minutes rounded %s gives %i', (actual, step, mode, expected) => {
    const p = policy().overtime; p.rounding = { mode, step };
    expect(validateAttendanceGroupPolicy({ ...policy(), overtime: p }, 1440).overtime.rounding).toEqual({ mode, step });
    expect(finalize(p, actual)).toMatchObject({ status: 'known', minutes: expected });
  });
  it('keeps stored 5, 10 and 60 minute steps valid and still refuses other steps', () => {
    for (const step of [5, 10, 60] as const) { const p = policy(); p.overtime.rounding.step = step; expect(validateAttendanceGroupPolicy(p, 1440).overtime.rounding.step).toBe(step); }
    for (const step of [20, 40, 50, 90]) { const p = policy(); p.overtime.rounding.step = step as never; expect(() => validateAttendanceGroupPolicy(p, 1440)).toThrow('45'); }
  });
});

describe('Auto Overtime Approval Method (the request examples)', () => {
  it('Intersect Actual and Pre-Approved pays the lower of approved 120 and actual 90', () => {
    // Intersect selects actual work inside the approved plan; the approved duration is the ceiling.
    expect(finalize({ ...policy().overtime, rounding: { mode: 'none', step: null } }, 90, 120)).toMatchObject({ status: 'known', minutes: 90 });
    expect(finalize({ ...policy().overtime, rounding: { mode: 'none', step: null } }, 150, 120)).toMatchObject({ status: 'known', minutes: 120 });
  });
  it('Actual Hours pays the actual 120 with no approved limit, and Approved Overtime pays the approved 120', () => {
    const none = { ...policy().overtime, rounding: { mode: 'none' as const, step: null } };
    expect(finalize({ ...none, autoMethod: 'actual' }, 120)).toMatchObject({ status: 'known', minutes: 120 });
    expect(finalize({ ...none, autoMethod: 'preApproved' }, 120)).toMatchObject({ status: 'known', minutes: 120 });
  });
});

describe('Offset Overtime by Lateness', () => {
  it('deducts 20 late minutes from 60 eligible minutes, leaving 40, without touching the source intervals', () => {
    const eligible = [{ from: 1080, to: 1140 }], late = [{ from: 540, to: 560 }];
    const before = JSON.stringify({ eligible, late });
    const result = selectAttendancePolicyCandidate({ eligibleIntervals: eligible, unpaidIntervals: [], lateOffsetIntervals: late, offsetLateness: true, periodMinutes: 1440 });
    expect(result.state).toBe('known');
    if (result.state !== 'known') throw Error('expected a known selection');
    expect(result.lateMinutes).toBe(20);
    expect(result.afterOffset.intervals.reduce((sum, row) => sum + row.to - row.from, 0)).toBe(40);
    expect(JSON.stringify({ eligible, late }), 'clocking evidence is never rewritten').toBe(before);
    const off = selectAttendancePolicyCandidate({ eligibleIntervals: eligible, unpaidIntervals: [], lateOffsetIntervals: late, offsetLateness: false, periodMinutes: 1440 });
    expect(off.state === 'known' && off.afterOffset.intervals.reduce((sum, row) => sum + row.to - row.from, 0)).toBe(60);
  });
  it('rounds after the offset, never the raw clocking duration', () => {
    // 60 eligible − 20 late = 40, then rounded up to 45 (not 60 → 60).
    const p = policy().overtime; p.rounding = { mode: 'up', step: 15 };
    expect(finalize(p, 40)).toMatchObject({ status: 'known', minutes: 45 });
  });
  it('Show Lateness Exception After Offset is stored only with the offset on and absent means off', () => {
    const on = policy(); on.overtime.showLatenessExceptionAfterOffset = true;
    expect(validateAttendanceGroupPolicy(on, 1440).overtime.showLatenessExceptionAfterOffset).toBe(true);
    const orphan = policy(); orphan.overtime.offsetLateness = false; orphan.overtime.showLatenessExceptionAfterOffset = true;
    expect(() => validateAttendanceGroupPolicy(orphan, 1440)).toThrow('Offset Overtime by Lateness');
    const offWithout = policy(); offWithout.overtime.offsetLateness = false; offWithout.overtime.showLatenessExceptionAfterOffset = false;
    expect(validateAttendanceGroupPolicy(offWithout, 1440).overtime.showLatenessExceptionAfterOffset).toBe(false);
    const stored = policy();
    expect(validateAttendanceGroupPolicy(stored, 1440), 'a policy stored before the setting existed still validates unchanged').toEqual(stored);
    const implicit = policy(); (implicit.overtime as unknown as Record<string, unknown>).showLatenessExceptionAfterOffset = 'yes';
    expect(() => validateAttendanceGroupPolicy(implicit, 1440)).toThrow();
  });
});

describe('Split Overtime at Midnight (10-Nov-2026 22:00 to 11-Nov-2026 02:00)', () => {
  const proof = (date: string) => ({ date, state: 'known' as const, companyId, dayClass: 'normal' as const, moneyDay: 'workday' as const, references: [`fictional-calendar:${date}`] });
  const input = (splitAtMidnight: boolean) => ({ sourceDate: '2026-11-10', companyId, periodMinutes: 2880, splitAtMidnight,
    intervals: [{ from: 22 * 60, to: 26 * 60 }], calendar: [proof('2026-11-10'), proof('2026-11-11')] });
  it('gives 10-Nov 2 hours and 11-Nov 2 hours of early overtime, keeping the original offsets', () => {
    const result = partitionAttendancePolicyWork(input(true));
    expect(result).toMatchObject({ status: 'ready', minutes: 240, parts: [
      { date: '2026-11-10', minutes: 120, intervals: [{ from: 1320, to: 1440 }] },
      { date: '2026-11-11', minutes: 120, intervals: [{ from: 1440, to: 1560 }] },
    ] });
  });
  it('keeps all four hours on 10-Nov when the split is off', () => {
    expect(partitionAttendancePolicyWork(input(false))).toMatchObject({ status: 'ready', minutes: 240, parts: [{ date: '2026-11-10', minutes: 240 }] });
  });
});
