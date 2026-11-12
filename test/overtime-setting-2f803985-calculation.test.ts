/**
 * 2f803985 (round 2) — the Overtime Setting's calculation, end to end through the ONE duration owner that
 * attendance execution, Payroll replay and TOIL replay all call (packs/attendance/policy-duration.ts), with
 * every worked example from the request. Also the section's save/load contract per field and its
 * conditional fields (lib/schedule-overtime-setting.ts), and the two known-zero outcomes that must not
 * hold Payroll: Manual, and Intersect / Approved Overtime on a day with no overtime request.
 * Pure: no database. The Payroll and TOIL journeys are in overtime-setting-2f803985-payroll.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ATTENDANCE_POLICY_DAY_CLASSES, type AttendanceGroupPolicy, type AttendancePolicyDayClass } from '../lib/attendance-group-policy';
import type { PolicyCalendarProof } from '../lib/attendance-policy-calendar';
import { attendancePolicyLatenessAfterOffset, deriveAttendancePolicyDurationProposal, type PolicyDurationProposalInput } from '../packs/attendance/policy-duration';
import { attendancePolicyPlanNotRequested } from '../packs/attendance/policy-plan-input';
import { attendancePolicyFinancialDurationContract } from '../packs/attendance/policy-financial-contract';
import { defaultScheduleOvertimeSetting, parseScheduleOvertimeSetting, scheduleOvertimeSettingFromPolicy, scheduleOvertimeSettingPolicy, type ScheduleOvertimeSetting } from '../lib/schedule-overtime-setting';

const companyId = '00000000-0000-4000-8000-000000000002';
const pattern = '00000000-0000-4000-8000-000000000001';
const calendar = (date: string, dayClass: AttendancePolicyDayClass = 'normal'): PolicyCalendarProof => ({ state: 'known', date, companyId, dayClass,
  moneyDay: dayClass === 'normal' || dayClass === 'off' ? 'workday' : dayClass === 'rest' ? 'rest_day' : 'holiday', references: [`fictional-calendar:${date}`] });
function policy(over: Partial<AttendanceGroupPolicy['overtime']> = {}): AttendanceGroupPolicy {
  return { version: 1, clock: { pairing: 'auto', minimumIntervalMinutes: 0, lateGraceMinutes: 0, earlyGraceMinutes: 0, skipLatenessIfIncomplete: false },
    overtime: { enabled: true, beforeShift: false, afterShift: true, allowBackdatedWithoutClock: false, splitAtMidnight: false, offsetLateness: false,
      approval: 'auto', autoMethod: 'actual', rounding: { mode: 'none', step: null },
      days: Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key => [key, { minimumMinutes: 0, maximumMinutes: null, patternVersionId: pattern }])) as AttendanceGroupPolicy['overtime']['days'],
      ...over } };
}
/** A 09:00–18:00 day with after-shift overtime from 18:00 (1080). */
function input(over: Partial<PolicyDurationProposalInput> & { overtime?: Partial<AttendanceGroupPolicy['overtime']> } = {}): PolicyDurationProposalInput {
  const { overtime, ...rest } = over;
  const p = policy(overtime);
  return { sourceDate: '2026-11-10', companyId, periodMinutes: 2880, policy: p, workedIntervals: [{ from: 540, to: 1170 }],
    eligibleActualIntervals: [{ from: 1080, to: 1170 }], eligiblePlannedIntervals: null, unpaidIntervals: [], lateOffsetIntervals: null,
    calendar: [calendar('2026-11-10'), calendar('2026-11-11')], method: p.overtime.autoMethod, approval: 'policyAuto',
    allocationByClass: Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key => [key, 'earliest'])) as PolicyDurationProposalInput['allocationByClass'], ...rest };
}
function payable(value: PolicyDurationProposalInput) {
  const result = deriveAttendancePolicyDurationProposal(value);
  if (result.status !== 'calculated') throw Error(`expected a calculated proposal, got ${JSON.stringify(result)}`);
  return result;
}

describe('Auto Overtime Approval Method — the request examples through the shared duration owner', () => {
  it('Intersect Actual and Pre-Approved: approved 120, actual 90, pays 90', () => {
    const r = payable(input({ overtime: { autoMethod: 'intersect' }, method: 'intersect', eligiblePlannedIntervals: [{ from: 1080, to: 1200 }] }));
    expect(r.payableMinutes).toBe(90);
  });
  it('Intersect never pays more than the approved duration when the employee works longer', () => {
    const r = payable(input({ overtime: { autoMethod: 'intersect' }, method: 'intersect', workedIntervals: [{ from: 540, to: 1260 }],
      eligibleActualIntervals: [{ from: 1080, to: 1260 }], eligiblePlannedIntervals: [{ from: 1080, to: 1200 }] }));
    expect(r.payableMinutes).toBe(120);
  });
  it('Actual Hours: actual 120 pays 120 with no approved limit', () => {
    const r = payable(input({ workedIntervals: [{ from: 540, to: 1200 }], eligibleActualIntervals: [{ from: 1080, to: 1200 }] }));
    expect(r.payableMinutes).toBe(120);
  });
  it('Approved Overtime: approved 120, actual 90, pays 120', () => {
    const r = payable(input({ overtime: { autoMethod: 'preApproved' }, method: 'preApproved', eligiblePlannedIntervals: [{ from: 1080, to: 1200 }] }));
    expect(r.payableMinutes).toBe(120);
    expect(r.intervalBasis).toBe('approvedPlan');
  });
});

describe('Offset Overtime by Lateness and Show Lateness Exception After Offset', () => {
  const late20 = [{ from: 540, to: 560 }];
  it('20 minutes late against 60 eligible minutes leaves 40, and the source intervals are untouched', () => {
    const value = input({ overtime: { offsetLateness: true }, workedIntervals: [{ from: 560, to: 1140 }], eligibleActualIntervals: [{ from: 1080, to: 1140 }], lateOffsetIntervals: late20 });
    const before = JSON.stringify(value);
    const r = payable(value);
    expect(r.payableMinutes).toBe(40);
    expect(r.lateOffsetMinutes).toBe(20);
    expect(JSON.stringify(value), 'clocking and lateness evidence are never rewritten').toBe(before);
  });
  it('applies the approval method BEFORE the offset: Intersect 90 of approved 120, then 20 late, pays 70', () => {
    const r = payable(input({ overtime: { autoMethod: 'intersect', offsetLateness: true }, method: 'intersect', workedIntervals: [{ from: 560, to: 1170 }],
      eligiblePlannedIntervals: [{ from: 1080, to: 1200 }], lateOffsetIntervals: late20 }));
    expect(r.selectionSteps.map(step => step.kind)).toEqual(['breaks', 'method', 'lateOffset']);
    expect(r.payableMinutes).toBe(70);
  });
  it('reports the remaining lateness only when Show Lateness Exception After Offset is on', () => {
    // 20 minutes late, 10 eligible: the offset absorbs 10 and 10 minutes of lateness remain.
    const short = { workedIntervals: [{ from: 560, to: 1090 }], eligibleActualIntervals: [{ from: 1080, to: 1090 }], lateOffsetIntervals: late20 };
    const shown = input({ overtime: { offsetLateness: true, showLatenessExceptionAfterOffset: true }, ...short });
    expect(attendancePolicyLatenessAfterOffset(shown.policy, payable(shown))).toEqual({ lateMinutes: 20, offsetMinutes: 10, remainingMinutes: 10 });
    const hidden = input({ overtime: { offsetLateness: true, showLatenessExceptionAfterOffset: false }, ...short });
    expect(attendancePolicyLatenessAfterOffset(hidden.policy, payable(hidden))).toBeNull();
    const absorbed = input({ overtime: { offsetLateness: true, showLatenessExceptionAfterOffset: true }, workedIntervals: [{ from: 560, to: 1140 }], eligibleActualIntervals: [{ from: 1080, to: 1140 }], lateOffsetIntervals: late20 });
    expect(attendancePolicyLatenessAfterOffset(absorbed.policy, payable(absorbed))?.remainingMinutes).toBe(0);
  });
});

describe('Overtime Rounding Method and Overtime Rounding to Minute — applied last', () => {
  it.each([
    [46, 15, 'up', 60], [46, 15, 'down', 45], [61, 30, 'up', 90], [61, 30, 'down', 60], [91, 45, 'up', 135], [91, 45, 'down', 90],
  ] as const)('%i actual minutes, %i-minute interval, round %s, pays %i', (actual, step, mode, expected) => {
    const r = payable(input({ overtime: { rounding: { mode, step } }, workedIntervals: [{ from: 540, to: 1080 + actual }], eligibleActualIntervals: [{ from: 1080, to: 1080 + actual }] }));
    expect(r.payableMinutes).toBe(expected);
  });
  it('rounds after the lateness offset, never the raw clocking duration: 61 − 20 = 41, rounded up to 45', () => {
    const r = payable(input({ overtime: { offsetLateness: true, rounding: { mode: 'up', step: 15 } }, workedIntervals: [{ from: 560, to: 1141 }],
      eligibleActualIntervals: [{ from: 1080, to: 1141 }], lateOffsetIntervals: [{ from: 540, to: 560 }] }));
    expect(r.payableMinutes).toBe(45);
    expect(r.classes[0].steps.at(-1)).toMatchObject({ kind: 'rounding', before: 41, after: 45 });
  });
});

describe('Split Overtime at Midnight — 10-Nov-2026 10:00 PM to 11-Nov-2026 2:00 AM', () => {
  const night = { workedIntervals: [{ from: 1320, to: 1560 }], eligibleActualIntervals: [{ from: 1320, to: 1560 }] };
  it('gives 10-Nov 2 hours and 11-Nov 2 hours of early overtime when enabled', () => {
    const r = payable(input({ overtime: { splitAtMidnight: true }, ...night }));
    expect(r.parts.map(part => ({ date: part.date, minutes: part.allocatedPayableMinutes }))).toEqual([
      { date: '2026-11-10', minutes: 120 }, { date: '2026-11-11', minutes: 120 }]);
    expect(r.payableMinutes).toBe(240);
  });
  it('keeps all 4 hours on 10-Nov when disabled', () => {
    const r = payable(input(night));
    expect(r.parts.map(part => ({ date: part.date, minutes: part.allocatedPayableMinutes }))).toEqual([{ date: '2026-11-10', minutes: 240 }]);
  });
});

describe('known-zero outcomes that must not hold Payroll', () => {
  const identity = { tenantId: '00000000-0000-4000-8000-0000000000aa', companyId, employmentId: '00000000-0000-4000-8000-0000000000bb',
    sourceId: '00000000-0000-4000-8000-0000000000cc', calculationId: '00000000-0000-4000-8000-0000000000dd', date: '2026-11-10' };
  const selected = (p: AttendanceGroupPolicy) => ({ id: '00000000-0000-4000-8000-0000000000ee', companyId, ruleId: '00000000-0000-4000-8000-0000000000ff',
    ordinal: 1, effectiveFrom: '2026-11-01', policy: p, activation: { epoch: 3, actorUserId: identity.employmentId, recordedAt: '2026-10-31T00:00:00.000Z', reason: 'fictional' } });
  it('Manual creates no payable attendance overtime, without needing clocks, a plan or a formula', () => {
    const manual = scheduleOvertimeSettingPolicy({ ...defaultScheduleOvertimeSetting(null), approval: 'manual' }, { previous: null, lateGraceMinutes: 5, earlyGraceMinutes: 0 });
    expect(manual.overtime).toMatchObject({ enabled: false, approval: 'manual' });
    const s = selected(manual);
    const contract = attendancePolicyFinancialDurationContract(identity, { source: { tenantId: identity.tenantId, employmentId: identity.employmentId,
      attendanceId: '00000000-0000-4000-8000-000000000011', date: identity.date }, policyDurationFormulaInput: { authority: 'durationSourceOnly', state: 'disabled', references: [] },
      attendanceGroupPolicy: s, policyExecutionContext: { state: 'policy', employmentId: identity.employmentId, date: identity.date, companyId, selected: s } as never } as never);
    expect(contract).toMatchObject({ state: 'none', reason: 'manualApproval', approvalStatus: 'notRequired', policyRevisionId: s.id });
    // A disabled policy yields zero through the duration owner too, even with clocked overtime.
    expect(payable(input({ policy: manual, approval: 'approved', method: 'actual' })).payableMinutes).toBe(0);
  });
  it('treats a day with no overtime request (or only rejected or cancelled ones) as an empty approved plan', () => {
    const p = policy({ autoMethod: 'intersect' }), s = selected(p);
    const context = { state: 'policy', employmentId: identity.employmentId, date: identity.date, companyId, selected: s } as never;
    const approvals = (requests: { status: string; cancelledAt: string | null; requestedMinutes: number | null }[]) =>
      ({ authority: 'sourceOnly', policyRevisionId: s.id, mode: 'auto', autoMethod: 'intersect', activation: { ...s.activation }, requests }) as never;
    expect(attendancePolicyPlanNotRequested(context, approvals([]), identity.tenantId)).toMatchObject({ state: 'known', intervals: [], references: [] });
    expect(attendancePolicyPlanNotRequested(context, approvals([{ status: 'rejected', cancelledAt: null, requestedMinutes: 60 },
      { status: 'approved', cancelledAt: '2026-11-09T00:00:00.000Z', requestedMinutes: 30 }, { status: 'approved', cancelledAt: null, requestedMinutes: null }]), identity.tenantId)).not.toBeNull();
    expect(attendancePolicyPlanNotRequested(context, approvals([{ status: 'pending', cancelledAt: null, requestedMinutes: 60 }]), identity.tenantId), 'a pending request waits').toBeNull();
    expect(attendancePolicyPlanNotRequested(context, approvals([{ status: 'approved', cancelledAt: null, requestedMinutes: 60 }]), identity.tenantId), 'an approved request needs its receipts').toBeNull();
    expect(payable(input({ overtime: { autoMethod: 'intersect' }, method: 'intersect', eligiblePlannedIntervals: [] })).payableMinutes).toBe(0);
  });
});

describe('Overtime Setting — every field saves and reopens exactly as saved', () => {
  const base = { previous: null, lateGraceMinutes: 7, earlyGraceMinutes: 3 };
  const cases: ScheduleOvertimeSetting[] = [];
  for (const approval of ['manual', 'auto'] as const) for (const autoMethod of ['intersect', 'actual', 'preApproved'] as const)
    for (const roundingMode of ['up', 'down'] as const) for (const roundingStep of [15, 30, 45] as const)
      cases.push({ ...defaultScheduleOvertimeSetting(pattern), approval, autoMethod, roundingMode, roundingStep, beforeShift: roundingStep === 30,
        afterShift: roundingStep !== 45, allowBackdatedWithoutClock: autoMethod === 'actual', splitAtMidnight: roundingMode === 'up',
        offsetLateness: approval === 'auto', showLatenessExceptionAfterOffset: approval === 'auto' && roundingStep === 15,
        patternVersionIds: approval === 'auto' ? defaultScheduleOvertimeSetting(pattern).patternVersionIds : defaultScheduleOvertimeSetting(null).patternVersionIds });
  it.each(cases.map((setting, index) => ({ index, setting })))('round-trips case $index', ({ setting }) => {
    const stored = scheduleOvertimeSettingPolicy(setting, base);
    expect(stored.overtime.enabled).toBe(setting.approval === 'auto');
    expect(stored.clock).toMatchObject({ lateGraceMinutes: 7, earlyGraceMinutes: 3 });
    const reopened = scheduleOvertimeSettingFromPolicy(JSON.parse(JSON.stringify(stored)));
    expect(reopened.unsupportedRounding).toBe(false);
    expect(reopened.setting).toEqual(setting);
  });
  it('carries clock settings and day thresholds forward from the company\'s saved revision', () => {
    const previous = policy(); previous.clock.lateGraceMinutes = 11; previous.overtime.days.rest.minimumMinutes = 30;
    const stored = scheduleOvertimeSettingPolicy(defaultScheduleOvertimeSetting(pattern), { previous, lateGraceMinutes: 0, earlyGraceMinutes: 0 });
    expect(stored.clock.lateGraceMinutes).toBe(11);
    expect(stored.overtime.days.rest.minimumMinutes).toBe(30);
  });
  it('reports a stored rounding the section does not offer instead of silently remapping it', () => {
    const p = policy({ rounding: { mode: 'nearest', step: 10 } });
    expect(scheduleOvertimeSettingFromPolicy(p).unsupportedRounding).toBe(true);
  });
});

describe('Overtime Setting form — conditional fields', () => {
  const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
  const auto = Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key => [`otPattern_${key}`, pattern]));
  const base = { otApproval: 'auto', otAutoMethod: 'intersect', otRoundingMode: 'down', otRoundingStep: '30', ...auto };
  it('drops Show Lateness Exception After Offset when the offset is unticked', () => {
    expect(parseScheduleOvertimeSetting(form({ ...base, otShowLatenessException: 'on' })).showLatenessExceptionAfterOffset).toBe(false);
    expect(parseScheduleOvertimeSetting(form({ ...base, otOffsetLateness: 'on', otShowLatenessException: 'on' })).showLatenessExceptionAfterOffset).toBe(true);
  });
  it('requires an Overtime Pattern for each day type only for Auto', () => {
    expect(() => parseScheduleOvertimeSetting(form({ ...base, otPattern_rest: '' }))).toThrow('Overtime Pattern');
    expect(parseScheduleOvertimeSetting(form({ otApproval: 'manual', otAutoMethod: 'actual', otRoundingMode: 'up', otRoundingStep: '15' })).approval).toBe('manual');
  });
  it('accepts only 15, 30 or 45 minutes and Round Up or Round Down', () => {
    for (const step of ['5', '10', '60', '20']) expect(() => parseScheduleOvertimeSetting(form({ ...base, otRoundingStep: step }))).toThrow('15, 30 or 45');
    expect(() => parseScheduleOvertimeSetting(form({ ...base, otRoundingMode: 'nearest' }))).toThrow('Rounding Method');
  });
  it('reads each checkbox independently', () => {
    const parsed = parseScheduleOvertimeSetting(form({ ...base, otBeforeShift: 'on', otSplitAtMidnight: 'on' }));
    expect(parsed).toMatchObject({ beforeShift: true, afterShift: false, allowBackdatedWithoutClock: false, splitAtMidnight: true, offsetLateness: false });
  });
});

describe('Show Lateness Exception After Offset — the employee exception list', () => {
  it('adds the remaining lateness to the Late In exception only when the recorded marker carries it', async () => {
    const { classifyDay } = await import('../packs/attendance/exceptions');
    const row = { date: '2026-11-10', attendanceId: 'a', status: 'present', context: null, checkInAt: '2026-11-10T09:20:00+08:00', checkOutAt: '2026-11-10T18:10:00+08:00',
      dayType: 'workday' as const, workedMinutes: 530, scheduledMinutes: 540, lateMinutes: 20, earlyOutMinutes: 0, shiftStart: '09:00:00', shiftEnd: '18:00:00', isRosterRest: false };
    const plain = classifyDay(row);
    expect(plain).toMatchObject({ section: 'short', lateMinutes: 20, latenessAfterOffsetMinutes: null });
    const shown = classifyDay({ ...row, calcTrace: { overtimePattern: { status: 'recorded', latenessAfterOffset: { lateMinutes: 20, offsetMinutes: 10, remainingMinutes: 10 } } } });
    expect(shown, 'the original lateness stays; the remainder is added').toMatchObject({ section: 'short', lateMinutes: 20, latenessAfterOffsetMinutes: 10 });
    const refused = classifyDay({ ...row, calcTrace: { overtimePattern: { status: 'refused', latenessAfterOffset: { remainingMinutes: 10 } } } });
    expect(refused?.latenessAfterOffsetMinutes).toBeNull();
  });
});
