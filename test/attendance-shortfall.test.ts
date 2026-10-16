import { describe, expect, it } from 'vitest';
import { recordedAllowanceAttendanceFacts, type RecordedAllowanceAttendance } from '../core/attendance-shortfall';
import type { ApprovedAllowanceLeavePiece } from '../packs/leave/service';

const trace = (schedule: Record<string, unknown> = {}) => ({
  v: 1, schedule: { dayType: 'workday', scheduledMinutes: 480, normalMinutesOverride: null,
    fixedClockApplicable: true, fullDayNormalMinutes: 480, ...schedule }, punch: {},
});
const record = (over: Partial<RecordedAllowanceAttendance> = {}): RecordedAllowanceAttendance => ({
  checkInAt: '2026-10-01T05:00:00Z', checkOutAt: '2026-10-01T09:00:00Z',
  workedMinutes: 240, otMinutes: 0, underMinutes: 240, lateMinutes: 240, earlyOutMinutes: 0,
  calcTrace: trace(), ...over,
});
const piece = (over: Partial<ApprovedAllowanceLeavePiece> = {}): ApprovedAllowanceLeavePiece => ({
  typeId: 'approved-type', paid: true, days: 0.5, requestIds: ['approved-request'],
  session: 'AM', minutes: null, ...over,
});
const read = (row: RecordedAllowanceAttendance | null, leave: ApprovedAllowanceLeavePiece[] | null = []) =>
  recordedAllowanceAttendanceFacts({ record: row, approvedLeave: leave });

describe('recorded allowance Attendance facts', () => {
  it('excuses AM leave before completed PM work using the recorded full-day unit', () => {
    const raw = record();
    const before = JSON.stringify(raw);
    const facts = read(raw, [piece()]);
    expect(facts).toMatchObject({ shortMinutes: 0, recordedUnderMinutes: 240,
      recordedNormalMinutes: 480, fullDayNormalMinutes: 480, leaveMinutes: 240,
      lateMinutes: 240, incomplete: false,
      sources: { shortfall: 'recorded-attendance-and-approved-leave' },
      reasons: { shortfall: 'approved-partial-leave-adjustment' } });
    expect(JSON.stringify(raw)).toBe(before); // Explaining does not repair persisted attendance.
  });

  it('uses exact hourly minutes, never the rounded leave day fraction', () => {
    const facts = read(record({ underMinutes: 10 }), [piece({ session: 'hourly', days: 0.13, minutes: 7.8 })]);
    expect(facts.leaveMinutes).toBe(7.8);
    expect(facts.shortMinutes).toBeCloseTo(2.2, 10);
    expect(read(record(), [piece({ session: 'hourly', days: 0.13, minutes: null })]))
      .toMatchObject({ shortMinutes: null, reasons: { shortfall: 'approved-leave-minutes-unavailable' } });
  });

  it('does not halve a partial leave allowance again on an already half-day target', () => {
    const facts = read(record({ calcTrace: trace({ scheduledMinutes: 240 }), underMinutes: 240, workedMinutes: 0 }), [piece()]);
    expect(facts).toMatchObject({ recordedNormalMinutes: 240, fullDayNormalMinutes: 480, leaveMinutes: 240, shortMinutes: 0 });
  });

  it('uses the recorded override for full-day approved leave, including a half working date', () => {
    const facts = read(record({ calcTrace: trace({ normalMinutesOverride: 210, scheduledMinutes: 240 }), underMinutes: 210 }),
      [piece({ session: 'full_day', days: 0.5 })]);
    expect(facts).toMatchObject({ recordedNormalMinutes: 210, leaveMinutes: 210, shortMinutes: 0,
      reasons: { shortfall: 'approved-full-day-leave' } });
  });

  it('adds non-overlapping AM and PM fractions supplied by the Leave owner and floors shortfall at zero', () => {
    expect(read(record(), [piece(), piece({ session: 'PM', requestIds: ['pm-request'] })]))
      .toMatchObject({ leaveMinutes: 480, shortMinutes: 0 });
  });

  it('does not infer a full-day unit from a date target, elapsed punches, or worked minutes', () => {
    const facts = read(record({ calcTrace: trace({ fullDayNormalMinutes: undefined }) }), [piece()]);
    expect(facts).toMatchObject({ fullDayNormalMinutes: null, shortMinutes: null,
      reasons: { shortfall: 'recorded-full-day-basis-unavailable' } });
  });

  it('leaves incomplete clocks unknown without erasing already measured lateness', () => {
    expect(read(record({ checkOutAt: null, workedMinutes: null, otMinutes: null, underMinutes: null }), [piece()]))
      .toMatchObject({ shortMinutes: null, incomplete: true, lateMinutes: 240,
        reasons: { shortfall: 'incomplete-clocks' } });
    expect(read(record({ checkInAt: null }))).toMatchObject({ incomplete: true, shortMinutes: null });
  });

  it('keeps a missing measurement unknown even when both punch timestamps exist', () => {
    expect(read(record({ underMinutes: null }))).toMatchObject({ shortMinutes: null,
      reasons: { shortfall: 'shortfall-not-recorded' } });
    expect(read(record({ workedMinutes: null }))).toMatchObject({ incomplete: true, shortMinutes: null });
  });

  it('preserves legacy raw measurements without guessing applicability from a current schedule', () => {
    const facts = read(record({ calcTrace: null, lateMinutes: 30, earlyOutMinutes: 0 }));
    expect(facts).toMatchObject({ fixedClockApplicable: null, lateMinutes: 30, earlyOutMinutes: 0, shortMinutes: 240,
      reasons: { applicability: 'fixed-clock-applicability-not-recorded' } });
    expect(read(record({ calcTrace: null, lateMinutes: null, earlyOutMinutes: null })))
      .toMatchObject({ fixedClockApplicable: null, lateMinutes: null, earlyOutMinutes: null });
    expect(read(record({ calcTrace: null }), [piece()])).toMatchObject({ shortMinutes: null });
    // Exact hourly leave needs no guessed day-unit conversion on a legacy row.
    expect(read(record({ calcTrace: null, underMinutes: 20 }), [piece({ session: 'hourly', minutes: 15 })]))
      .toMatchObject({ shortMinutes: 5, leaveMinutes: 15 });
    expect(read(record({ calcTrace: null }), [piece({ session: 'full_day', days: 1 })]))
      .toMatchObject({ shortMinutes: null, reasons: { shortfall: 'recorded-normal-target-unavailable' } });
  });

  it('rejects unrecognized trace versions rather than adopting their apparent schedule', () => {
    expect(read(record({ calcTrace: { ...trace(), v: 2 } }), [piece()]))
      .toMatchObject({ fixedClockApplicable: null, recordedNormalMinutes: null, fullDayNormalMinutes: null, shortMinutes: null });
  });

  it('keeps known zero shortfall when approved leave allocation or its minute basis is unknown', () => {
    for (const leave of [null, [piece()], [piece({ session: 'hourly', minutes: null })]]) {
      expect(read(record({ underMinutes: 0, calcTrace: null }), leave))
        .toMatchObject({ shortMinutes: 0, reasons: { shortfall: 'recorded-zero-shortfall' } });
    }
  });

  it('does not count the entire deficit when the Leave owner reports overlapping or ambiguous leave', () => {
    expect(read(record(), null)).toMatchObject({ shortMinutes: null, leaveMinutes: null,
      reasons: { shortfall: 'approved-leave-allocation-unknown' } });
  });

  it('retains recorded fixed-clock measurements after a live shift is edited to Full Flexi', () => {
    const raw = record({ lateMinutes: 30, underMinutes: 0 });
    const liveShift = { fixedClockApplicable: true };
    const before = read(raw);
    liveShift.fixedClockApplicable = false;
    expect(read(raw)).toEqual(before); // Reader has no live-shift input or lookup.
    expect(before).toMatchObject({ fixedClockApplicable: true, lateMinutes: 30 });
  });

  it('preserves raw zero/positive values even in contradictory recorded applicability evidence', () => {
    expect(read(record({ calcTrace: trace({ fixedClockApplicable: false }), lateMinutes: 30, earlyOutMinutes: 0 })))
      .toMatchObject({ fixedClockApplicable: false, lateMinutes: 30, earlyOutMinutes: 0 });
    expect(read(record({ calcTrace: trace({ fixedClockApplicable: false }), lateMinutes: null, earlyOutMinutes: null })))
      .toMatchObject({ fixedClockApplicable: false, lateMinutes: 0, earlyOutMinutes: 0,
        recordedLateMinutes: null, recordedEarlyOutMinutes: null });
  });

  it('does not manufacture an attended or incomplete event for a missing row', () => {
    expect(read(null)).toMatchObject({ incomplete: false, shortMinutes: null, lateMinutes: null,
      reasons: { shortfall: 'attendance-not-recorded' } });
  });

  it('does not mistake a damaged trace day type for an explicit rest day', () => {
    expect(read(record({ calcTrace: trace({ dayType: undefined }), underMinutes: null })))
      .toMatchObject({ shortMinutes: null, recordedNormalMinutes: null });
  });

  it('uses recorded non-workday evidence without a current calendar lookup', () => {
    expect(read(record({ calcTrace: trace({ dayType: 'rest_day' }), underMinutes: null })))
      .toMatchObject({ shortMinutes: 0, recordedNormalMinutes: 0, reasons: { shortfall: 'recorded-non-workday' } });
  });
});
