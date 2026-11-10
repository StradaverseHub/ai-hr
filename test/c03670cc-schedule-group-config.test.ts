/**
 * c03670cc — Schedule Group configuration, the pure halves (no database).
 *
 *  · typed OT / PH band rates: 0 to 99.99, at most two decimals, a third decimal REFUSED (never rounded),
 *    formatted from the decimal's own digits (never float arithmetic), blank PH = the default;
 *  · the "other rate" bucket for Variable rates outside 0 / 1.0 / 1.5 / 2.0 / 3.0, with the sum invariant;
 *  · the breakdown's separation of those minutes out of the stored Flat column, only when trace and
 *    stored columns agree;
 *  · the Attendance tab's clock scope on reopen, and that an untouched form writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { formatOtRate, isValidOtRate, otRateStorageText, otRateText } from '../lib/ot-rate';
import { bucketForRate, effectiveOvertimeRows, otSplitTotal, splitOtMinutes } from '../core/attendance-calc';
import { otByRate, otherRateFromTrace } from '../core/attendance-derive';
import type { ResolvedAttendanceRule, ResolvedOtRow } from '../core/attendance-rule';
import { parseOtRows } from '../app/admin/attendance/schedule/overtime-fields';
import { readScheduleClockPolicyFields } from '../app/admin/attendance/schedule/clock-policy-fields';
import { DEFAULT_ATTENDANCE_CLOCK_POLICY, scheduleClockDisplay, type ClockHistoryRow } from '../lib/schedule-clock-scope';
import type { AttendanceClockPolicy } from '../lib/attendance-clock-policy';

describe('typed band rates', () => {
  it('accepts 0 and decimals up to two places, from 0 to 99.99', () => {
    for (const ok of ['0', '1', '1.0', '1.5', '1.75', '2.0', '3', '3.00', '99.99', ' 1.5 ', 0, 1.5, 1.75, 3])
      expect(isValidOtRate(ok), String(ok)).toBe(true);
  });

  it('refuses a third decimal instead of rounding it, and refuses letters, signs and out-of-range values', () => {
    for (const bad of ['1.755', '1.005', '2.x', 'abc', '', '-1', '+1', '100', '100.00', '1e2', '.5', '1.', '1,5', 1.755, -1, 100, Number.NaN, null, undefined])
      expect(isValidOtRate(bad), String(bad)).toBe(false);
    expect(() => otRateStorageText('1.755')).toThrow(/two decimal places/);
  });

  it('stores two-decimal text by string padding and formats from the stored digits, never float math', () => {
    expect(otRateStorageText('1.5')).toBe('1.50');
    expect(otRateStorageText('2')).toBe('2.00');
    expect(otRateStorageText(1.75)).toBe('1.75');
    expect(otRateStorageText('0')).toBe('0.00');
    expect(formatOtRate('1.50')).toBe('1.5');
    expect(formatOtRate('1.75')).toBe('1.75');
    expect(formatOtRate('2.00')).toBe('2.0');
    expect(formatOtRate('0.00')).toBe('0.0');
    expect(formatOtRate(1.5)).toBe('1.5');
    expect(formatOtRate(2)).toBe('2.0');
    // The float trap the plan names: 0.1 + 0.2 style artefacts never appear, because nothing adds.
    expect(formatOtRate(otRateStorageText(otRateText('1.5')!))).toBe('1.5');
    expect(formatOtRate(null)).toBe('');
  });

  it('the posted-row parser refuses an invalid rate by row instead of storing 0, and keeps blank PH as the default', () => {
    expect(parseOtRows(JSON.stringify([{ fromMinutes: 0, toMinutes: 60, ratePattern: 'variable', rate: '1.75', phRate: '' }]), true))
      .toMatchObject([{ rate: 1.75, phRate: null }]);
    expect(() => parseOtRows(JSON.stringify([{ rate: '1.5' }, { rate: '2.x' }]), true)).toThrow(/row 2: OT Rate/);
    expect(() => parseOtRows(JSON.stringify([{ rate: '1.5', phRate: '3.333' }]), true)).toThrow(/row 1: PH Rate/);
    expect(parseOtRows(JSON.stringify([{ rate: '', phRate: '' }]), true)).toMatchObject([{ rate: null, phRate: null }]);
  });
});

const band = (over: Partial<ResolvedOtRow> = {}): ResolvedOtRow => ({
  fromMinutes: 0, toMinutes: 0, ratePattern: 'variable', rate: 1.5, phRate: null, roundingMode: 'none', roundToMinutes: null, ...over,
});
const rule = (otRows: ResolvedOtRow[]): ResolvedAttendanceRule => ({
  id: 'r', isDefault: false, lateGracePeriodMinutes: 0, earlyGracePeriodMinutes: 0, applyToEarlyOt: false,
  lateAfterMinutes: 0, lateDeductMinutes: 0, includeGraceInLateness: false, earlyAfterMinutes: 0, earlyDeductMinutes: 0,
  includeGraceInEarlyOut: false, applyDeductions: false, deductionsEffectiveFrom: null,
  week: { pattern: null, halfPattern: [], offPattern: [] }, otRows,
});

describe('the "other rate" bucket', () => {
  it('a Variable rate outside the usual columns is its own bucket; Flat stays Flat', () => {
    expect(bucketForRate('variable', 1.75)).toBe('other');
    expect(bucketForRate('variable', 1.5)).toBe('ot15');
    expect(bucketForRate('flat', 1.75)).toBe('flat');
  });

  it('keeps the sum invariant and keeps the six-key shape when no typed rate is used', () => {
    const typed = rule([band({ fromMinutes: 0, toMinutes: 120, rate: 1.5 }), band({ fromMinutes: 121, toMinutes: 0, rate: 1.75 })]);
    const split = splitOtMinutes(200, 'workday', typed);
    expect(split).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 120, ot20: 0, ot30: 0, other: 80 });
    expect(otSplitTotal(split)).toBe(200);
    const usual = splitOtMinutes(200, 'workday', rule([band({ rate: 2 })]));
    expect(usual, 'no `other` key appears for an ordinary rule').toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 0, ot20: 200, ot30: 0 });
    // A zero-minute typed band adds no `other` key either.
    expect(splitOtMinutes(100, 'workday', typed)).toEqual({ flat: 0, ot00: 0, ot10: 0, ot15: 100, ot20: 0, ot30: 0 });
    const effective = effectiveOvertimeRows(200, 'workday', typed);
    expect(effective.total).toBe(200);
    expect(effective.rows.find((row) => row.bucket === 'other')).toMatchObject({ rate: 1.75, effectiveMinutes: 80 });
  });
});

describe('the breakdown reports typed-rate minutes on their own line', () => {
  const trace = (split: Record<string, number>, rows: unknown[] = [{ bucket: 'other', rate: 1.75, effectiveMinutes: 80 }]) =>
    ({ v: 1, overtime: { split, rows } });
  // Stored as the engine stores it: `other` minutes live in ot_flat_minutes (core/attendance.ts otSplitColumns).
  const stored = { formulaOvertime: null, workedMinutes: 600, otMinutes: 200, dayType: 'workday' as const,
    otFlatMinutes: 80, ot00Minutes: 0, ot10Minutes: 0, ot15Minutes: 120, ot20Minutes: 0, ot30Minutes: 0 };

  it('moves them out of Flat with their rate, still summing to the day’s overtime', () => {
    const ot = otByRate({ ...stored, calcTrace: trace({ flat: 0, ot15: 120, other: 80 }) }, { separateOtherRate: true });
    expect(ot).toMatchObject({ flat: 0, ot15: 120, other: { minutes: 80, rates: [1.75] } });
    expect((ot.flat ?? 0) + (ot.ot15 ?? 0) + ot.other!.minutes).toBe(200);
  });

  it('other screens, old traces and disagreeing traces read exactly as before', () => {
    const calcTrace = trace({ flat: 0, ot15: 120, other: 80 });
    expect(otByRate({ ...stored, calcTrace }), 'not asked for ⇒ unchanged').not.toHaveProperty('other');
    expect(otByRate({ ...stored, calcTrace: null }, { separateOtherRate: true })).not.toHaveProperty('other');
    expect(otByRate({ ...stored, calcTrace: trace({ flat: 0, ot15: 100, other: 80 }) }, { separateOtherRate: true }),
      'trace total disagrees with ot_minutes').not.toHaveProperty('other');
    expect(otByRate({ ...stored, otFlatMinutes: 50, ot15Minutes: 150, calcTrace }, { separateOtherRate: true }),
      'stored Flat disagrees with the trace').not.toHaveProperty('other');
    expect(otherRateFromTrace({ v: 2, overtime: { split: { other: 80 } } }), 'unknown trace version').toBeNull();
  });
});

describe('clock scope on reopen and the untouched form', () => {
  const p = (normal: 'auto' | 'firstInLastOut', minimumIntervalMinutes = 0): AttendanceClockPolicy =>
    ({ pairing: { normal, rest: 'auto', off: 'auto', publicHoliday: 'auto' }, minimumIntervalMinutes });
  const rev = (ordinal: number, effectiveFrom: string, policy: AttendanceClockPolicy): ClockHistoryRow => ({ ordinal, effectiveFrom, policy });
  const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';
  const companies = (a: ClockHistoryRow[] = [], b: ClockHistoryRow[] = [], c: ClockHistoryRow[] = []) =>
    [{ id: A, name: 'Example Sdn Bhd', history: a }, { id: B, name: 'Sample Trading', history: b }, { id: C, name: 'Third Co', history: c }];

  it('nothing saved: All Companies with today’s defaults for a group administrator', () => {
    expect(scheduleClockDisplay({ group: [], companies: companies(), canUseAll: true }))
      .toEqual({ scope: { kind: 'all' }, policy: DEFAULT_ATTENDANCE_CLOCK_POLICY, differing: [], token: { group: 0, [A]: 0, [B]: 0, [C]: 0 } });
  });

  it('a group-wide latest save shows All Companies and names companies with their own different settings', () => {
    const shown = scheduleClockDisplay({ group: [rev(1, '2026-11-20', p('firstInLastOut'))],
      companies: companies([rev(1, '2026-11-12', p('auto', 5))], [rev(1, '2026-11-12', p('firstInLastOut'))]), canUseAll: true });
    expect(shown.scope).toEqual({ kind: 'all' });
    expect(shown.policy).toEqual(p('firstInLastOut'));
    expect(shown.differing).toEqual([{ id: A, name: 'Example Sdn Bhd' }]);
    expect(shown.token).toEqual({ group: 1, [A]: 1, [B]: 1, [C]: 0 });
  });

  it('a newer company save shows the companies sharing it, and the differing ones', () => {
    const shown = scheduleClockDisplay({ group: [rev(1, '2026-11-12', p('auto'))],
      companies: companies([rev(1, '2026-11-20', p('firstInLastOut'))], [rev(2, '2026-11-20', p('firstInLastOut'))], [rev(1, '2026-11-15', p('auto', 9))]), canUseAll: true });
    expect(shown.scope).toEqual({ kind: 'companies', companyIds: [A, B] });
    expect(shown.differing).toEqual([{ id: C, name: 'Third Co' }]);
  });

  it('a company-scoped administrator never sees All Companies as a choice', () => {
    const shown = scheduleClockDisplay({ group: [rev(1, '2026-11-20', p('firstInLastOut'))],
      companies: [{ id: A, name: 'Example Sdn Bhd', history: [] }], canUseAll: false });
    expect(shown.scope).toEqual({ kind: 'companies', companyIds: [A] });
    expect(shown.policy).toEqual(p('firstInLastOut'));
  });

  const form = (fields: Record<string, string | string[]>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const value of [v].flat()) f.append(k, value);
    return f;
  };
  const posted = (over: Record<string, string | string[]> = {}) => form({
    clockEditor: '1', clockScope: 'all', clockRevisionToken: JSON.stringify({ group: 0 }),
    clockPairing_normal: 'auto', clockPairing_rest: 'auto', clockPairing_off: 'auto', clockPairing_publicHoliday: 'auto',
    clockMinimumInterval: '0',
    clockBaseline: JSON.stringify({ scope: { kind: 'all' }, policy: DEFAULT_ATTENDANCE_CLOCK_POLICY }), ...over,
  });

  it('an untouched form writes nothing; a changed day type, interval or scope does', () => {
    expect(readScheduleClockPolicyFields(posted())).toBeNull();
    expect(readScheduleClockPolicyFields(form({}))).toBeNull();
    expect(readScheduleClockPolicyFields(posted({ clockPairing_off: 'firstInLastOut' }))?.policy.pairing)
      .toEqual({ normal: 'auto', rest: 'auto', off: 'firstInLastOut', publicHoliday: 'auto' });
    expect(readScheduleClockPolicyFields(posted({ clockMinimumInterval: '3' }))?.policy.minimumIntervalMinutes).toBe(3);
    expect(readScheduleClockPolicyFields(posted({ clockScope: 'companies', clockCompanyIds: [A, B] }))?.scope)
      .toEqual({ kind: 'companies', companyIds: [A, B] });
  });

  it('refuses no company, a bad interval and a missing day type; there is no date or reason field to read', () => {
    expect(() => readScheduleClockPolicyFields(posted({ clockScope: 'companies' }))).toThrow(/at least one company/);
    expect(() => readScheduleClockPolicyFields(posted({ clockMinimumInterval: '4321' }))).toThrow(/whole number/);
    expect(() => readScheduleClockPolicyFields(posted({ clockMinimumInterval: '1.5' }))).toThrow(/whole number/);
    expect(() => readScheduleClockPolicyFields(posted({ clockPairing_rest: 'sometimes' }))).toThrow(/pairing method/);
    const read = readScheduleClockPolicyFields(posted({ clockMinimumInterval: '2', clockEffectiveFrom: '2000-01-01', clockReason: 'typed' }));
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty('effectiveFrom');
    expect(read).not.toHaveProperty('reason');
  });
});
