/**
 * 2f803985 (round 2) — the Schedule Group Overtime Setting, saved through its own writer and received by
 * Payroll and TOIL, with fictional fixtures in a 71-company group.
 *
 *  · The writer: "All companies" writes one future-dated, append-only revision per company in one
 *    transaction, reopens exactly as saved, refuses stale or backdated saves, and refuses Auto when the chosen
 *    Overtime Pattern is not active for every chosen company.
 *  · Payroll: Auto + Actual Hours with Split Overtime at Midnight, 10:00 PM to 2:00 AM, reaches the draft run
 *    as 2 hours on each date and the payslip carries exactly that money; the same parent cannot also bank TOIL.
 *  · TOIL: the same setting banks the 4 hours as TOIL under the existing credit owner.
 *  · Manual: the clocked overtime stays recorded but Payroll receives no attendance overtime, and the run is
 *    not held. Intersect on a day with no overtime request likewise gives a known zero, not a hold.
 *  · A legacy group's week becomes a dated pattern only when saved; earlier days are not rewritten.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import * as s from '../db/schema';
import { hireEmployee } from '../core/org';
import { assignDefaultShift, createShift } from '../core/roster';
import { setCompensation } from '../core/comp';
import { createAttendanceRule } from '../core/attendance-rule';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { requirePackFor } from '../localization/registry';
import { prepareOvertimeStarter } from '../lib/overtime-pattern-starters';
import { todayInKualaLumpur } from '../lib/hr-date';
import { ATTENDANCE_POLICY_DAY_CLASSES } from '../lib/attendance-group-policy';
import { defaultScheduleOvertimeSetting, type ScheduleOvertimeSetting } from '../lib/schedule-overtime-setting';
import { readPayrollOvertimeCoverageTx } from '../core/payroll-overtime-pattern';
import { accrueToil, setToilPolicy } from '../core/toil';
import { createBatch, createPayComponent, generatePayslips, readPayrollOvertimePatternCashTx, transferOvertimePatternToPayroll } from '../packs/payroll/service';
import { activateOvertimePattern, checkInTx, checkOutTx, ensureStandardRule, getScheduleRotation, readOvertimeCalculationTx, saveOvertimePatternDraft,
  saveScheduleGroupOvertimeSetting, saveScheduleRotation, scheduleGroupOvertimeSetting, validateOvertimePatternActivation } from '../packs/attendance/service';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

let b: Base, ctx: SessionContext;
const day = (offset: number) => new Date(Date.parse(todayInKualaLumpur() + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
const next = (date: string) => new Date(Date.parse(date + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
const REASON = 'Fictional Schedule Group Overtime Setting';

beforeAll(migrateTestDb); afterAll(closeAll);
beforeEach(async () => { await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'attendance', 'active'); ctx = adminCtx(b); });

/** 70 more fictional companies: a 71-company group, as on staging. */
async function group71() {
  await owner.db.insert(s.company).values(Array.from({ length: 70 }, (_, i) => ({ tenantId: b.tenantId, legalName: `Fictional Group ${String(i).padStart(2, '0')} Sdn Bhd` })));
  const ids = (await owner.db.select({ id: s.company.id }).from(s.company).where(eq(s.company.tenantId, b.tenantId))).map(row => row.id);
  expect(ids.length).toBeGreaterThanOrEqual(71);
  return ids;
}
async function clock(employmentId: string, date: string, direction: 'in' | 'out', time: string, captureDate = date) {
  const [capture] = await owner.db.insert(s.attendanceClockCapture).values({ tenantId: b.tenantId, employmentId, attendanceDate: date, direction,
    requestId: randomUUID(), commandDigest: 'a'.repeat(64), serverRecordedAt: new Date(Date.parse(captureDate + 'T' + time + '+08:00')) }).returning();
  return (direction === 'in' ? checkInTx : checkOutTx)(ctx, { employmentId, date, time, clockCaptureId: capture.id, preciseOrder: true });
}
/** An activated, fixed-rate (RM 12/hour × 1.5) fictional Overtime Pattern bound to `companyIds`. */
async function formula(companyIds: string[]) {
  const pack = requirePackFor('MY'), seed = pack.payComponents.defaults.find(row => row.code === pack.payComponents.backfillCodes.overtime)!;
  const earning = await createPayComponent(ctx, { ...seed, code: 'SETTING_OT', name: 'Fictional setting overtime', label: 'Fictional setting overtime' });
  const definition = prepareOvertimeStarter('ot15', 'day', 'earliest'); definition.currency = { code: 'MYR', minorScale: 2 };
  definition.eligibility = { id: 'eligible', type: 'constant', value: true }; definition.rates[0].when = { id: 'rate_eligible', type: 'constant', value: true };
  const tier = definition.rates[0].tiers[0]; tier.mapping = { earningItemId: earning.id, currency: 'MYR' };
  if (tier.payment.method !== 'hourly') throw Error('Retain the standard fixture formula');
  tier.payment.rate = { id: 'fictional_hourly', unit: 'moneyPerHour', type: 'literal', value: '12', currency: 'MYR' };
  const draft = await saveOvertimePatternDraft(ctx, { draft: { code: 'SETTING_' + randomUUID().slice(0, 8), name: 'Fictional setting pattern', creationCompanyId: b.companyId, companyIds, definition } });
  const validation = await validateOvertimePatternActivation(ctx, { versionId: draft.versionId, expectedRevision: draft.revision });
  expect(validation.issues).toEqual([]);
  await activateOvertimePattern(ctx, { versionId: draft.versionId, expectedRevision: draft.revision, validationDigest: validation.validationDigest!, effectiveFrom: day(1) });
  return draft.versionId;
}
const everyDay = (versionId: string | null) => Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key => [key, versionId])) as ScheduleOvertimeSetting['patternVersionIds'];
async function worker(ruleId: string) {
  const hired = await hireEmployee(ctx, { person: { fullName: 'Fictional overtime worker', primaryEmail: randomUUID() + '@fixture.invalid' }, companyId: b.companyId,
    departmentId: b.deptA, employmentType: 'full_time', hiredOn: day(-10) });
  const shift = await createShift(ctx, { code: 'SET_' + randomUUID().slice(0, 6), name: 'Fictional 09:00–18:00', startTime: '09:00', endTime: '18:00', breakMinutes: 0, weeklyPattern: [1, 2, 3, 4, 5, 6, 7], ruleId });
  await assignDefaultShift(ctx, { employmentId: hired.employmentId, shiftId: shift.id });
  await setCompensation(ctx, { employmentId: hired.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: day(-10) });
  await setStatutoryProfileMY(ctx, { personId: hired.personId, icNumber: '900101011234' });
  return hired;
}
/** A source date whose next day is in the same pay period, after the setting's start (tomorrow). */
const sourceDate = () => day(2).slice(0, 7) !== day(3).slice(0, 7) ? day(4) : day(2);
async function financialModules() {
  await setModule(b.tenantId, 'payroll', 'active'); await setModule(b.tenantId, 'toil', 'active'); await setModule(b.tenantId, 'typed_pay_components', null);
  await setSetting(b.tenantId, 'payroll.individual_txn_pay_enabled', false); ctx = await entitledCtx(b);
}

describe('Overtime Setting writer — All companies in a 71-company group', () => {
  it('writes one dated, append-only revision per company in one save, reopens exactly as saved, and refuses stale, backdated or unbound saves', async () => {
    const ids = await group71();
    const rule = await createAttendanceRule(ctx, { name: 'Fictional Warehouse', description: null, status: 'active', lateGracePeriodMinutes: 4, lateAfterMinutes: 0,
      lateDeductMinutes: 0, includeGraceInLateness: false, earlyGracePeriodMinutes: 2, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
      applyToEarlyOt: false, applyDeductions: false, otRows: [] } as never);
    const opened = await scheduleGroupOvertimeSetting(ctx, { ruleId: rule.id });
    expect(opened.companies.map(row => row.id).sort()).toEqual([...ids].sort());
    expect(opened.saved).toBeNull();
    expect(opened.minimumDate).toBe(day(1));
    const manual: ScheduleOvertimeSetting = { ...defaultScheduleOvertimeSetting(null), approval: 'manual', beforeShift: true, splitAtMidnight: true,
      offsetLateness: true, showLatenessExceptionAfterOffset: true, roundingMode: 'up', roundingStep: 45 };
    const saved = await saveScheduleGroupOvertimeSetting(ctx, { ruleId: rule.id, scope: { kind: 'all' }, effectiveFrom: day(1), setting: manual, expectedToken: opened.token, reason: REASON });
    expect(saved.revisions).toHaveLength(ids.length);
    const rows = await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.ruleId, rule.id));
    expect(rows).toHaveLength(ids.length);
    expect(new Set(rows.map(row => row.companyId)).size).toBe(ids.length);
    expect(rows.every(row => row.ordinal === 1 && row.effectiveFrom === day(1) && row.activationEpoch > 0)).toBe(true);
    expect(rows[0].policy.overtime).toMatchObject({ enabled: false, approval: 'manual', beforeShift: true, splitAtMidnight: true, offsetLateness: true,
      showLatenessExceptionAfterOffset: true, rounding: { mode: 'up', step: 45 } });
    expect(rows[0].policy.clock, 'clock grace starts from the group').toMatchObject({ lateGraceMinutes: 4, earlyGraceMinutes: 2 });
    const events = await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId, b.tenantId), eq(s.domainEvent.eventType, 'attendance-rule.policy.scheduled')));
    expect(events).toHaveLength(ids.length);

    const reopened = await scheduleGroupOvertimeSetting(ctx, { ruleId: rule.id });
    expect(reopened.saved).toMatchObject({ setting: manual, effectiveFrom: day(1), differingCompanyIds: [], unsupportedRounding: false });
    expect(reopened.minimumDate).toBe(day(2));
    // The page opened before the save is now stale; a start on or before the saved one is refused.
    await expect(saveScheduleGroupOvertimeSetting(ctx, { ruleId: rule.id, scope: { kind: 'all' }, effectiveFrom: day(3), setting: manual, expectedToken: opened.token, reason: REASON }))
      .rejects.toThrow('changed since this page opened');
    await expect(saveScheduleGroupOvertimeSetting(ctx, { ruleId: rule.id, scope: { kind: 'all' }, effectiveFrom: day(1), setting: manual, expectedToken: reopened.token, reason: REASON }))
      .rejects.toThrow('start date after');
    await expect(saveScheduleGroupOvertimeSetting(ctx, { ruleId: rule.id, scope: { kind: 'all' }, effectiveFrom: day(0), setting: manual, expectedToken: reopened.token, reason: REASON }))
      .rejects.toThrow('future');

    // Auto needs a pattern active for EVERY chosen company: bound to one company only, All companies refuses
    // and nothing is written; that one company alone succeeds, append-only, as ordinal 2.
    const versionId = await formula([b.companyId]);
    const auto: ScheduleOvertimeSetting = { ...defaultScheduleOvertimeSetting(versionId), approval: 'auto', autoMethod: 'intersect' };
    const before = await scheduleGroupOvertimeSetting(ctx, { ruleId: rule.id });
    expect(before.patterns.find(row => row.versionId === versionId)?.companyIds).toEqual([b.companyId]);
    await expect(saveScheduleGroupOvertimeSetting(ctx, { ruleId: rule.id, scope: { kind: 'all' }, effectiveFrom: day(5), setting: auto, expectedToken: before.token, reason: REASON }))
      .rejects.toThrow('not active for every chosen company');
    expect(await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.ruleId, rule.id))).toHaveLength(ids.length);
    await saveScheduleGroupOvertimeSetting(ctx, { ruleId: rule.id, scope: { kind: 'companies', companyIds: [b.companyId] }, effectiveFrom: day(5), setting: auto, expectedToken: before.token, reason: REASON });
    const history = await owner.db.select().from(s.attendanceGroupPolicyRevision).where(and(eq(s.attendanceGroupPolicyRevision.ruleId, rule.id), eq(s.attendanceGroupPolicyRevision.companyId, b.companyId)));
    expect(history.map(row => [row.ordinal, row.effectiveFrom, row.policy.overtime.approval]).sort()).toEqual([[1, day(1), 'manual'], [2, day(5), 'auto']]);
    const mixed = await scheduleGroupOvertimeSetting(ctx, { ruleId: rule.id });
    expect(mixed.saved?.setting.approval).toBe('auto');
    expect(mixed.saved?.differingCompanyIds.length, 'the other 70 companies keep Manual').toBe(ids.length - 1);
  }, 120_000);

  it('turns a legacy group\'s week into a dated pattern only when saved, without rewriting earlier days', async () => {
    const shift = await createShift(ctx, { code: 'LEG_' + randomUUID().slice(0, 6), name: 'Fictional legacy shift', startTime: '09:00', endTime: '18:00', breakMinutes: 0, weeklyPattern: [1, 2, 3, 4, 5] });
    const rule = await createAttendanceRule(ctx, { name: 'Fictional legacy week', description: null, status: 'active', lateGracePeriodMinutes: 0, lateAfterMinutes: 0,
      lateDeductMinutes: 0, includeGraceInLateness: false, earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
      applyToEarlyOt: false, applyDeductions: false, otRows: [], weeklyPattern: [1, 2, 3, 4, 5] } as never);
    const before = await getScheduleRotation(ctx, rule.id);
    expect(before.versions, 'no backfill').toEqual([]);
    const monday = new Date(Date.parse(day(7) + 'T00:00:00Z')); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    await saveScheduleRotation(ctx, { ruleId: rule.id, expectedRevision: before.revision, allowedShiftIds: [shift.id], cycle: { effectiveFrom: day(7),
      anchorDate: monday.toISOString().slice(0, 10), unit: 'week', length: 1,
      days: [1, 2, 3, 4, 5, 6, 7].map(d => d <= 5 ? { kind: 'full' as const, shiftId: shift.id } : { kind: 'rest' as const, shiftId: null }) } });
    const after = await getScheduleRotation(ctx, rule.id);
    expect(after.versions.map(v => v.effectiveFrom)).toEqual([day(7)]);
    const [stored] = await owner.db.select({ weeklyPattern: s.attendanceRule.weeklyPattern }).from(s.attendanceRule).where(eq(s.attendanceRule.id, rule.id));
    expect(stored.weeklyPattern, 'the legacy week stays as the read fallback for earlier days').toEqual([1, 2, 3, 4, 5]);
  });
});

describe('Overtime Setting → Payroll and TOIL (fictional fixtures, 71 companies)', () => {
  async function autoSplitSetting() {
    const ids = await group71();
    await financialModules();
    const ruleId = (await ensureStandardRule(ctx)).id;
    const versionId = await formula(ids);
    const view = await scheduleGroupOvertimeSetting(ctx, { ruleId });
    const setting: ScheduleOvertimeSetting = { ...defaultScheduleOvertimeSetting(versionId), approval: 'auto', autoMethod: 'actual', afterShift: true,
      splitAtMidnight: true, roundingMode: 'down', roundingStep: 15, patternVersionIds: everyDay(versionId) };
    const saved = await saveScheduleGroupOvertimeSetting(ctx, { ruleId, scope: { kind: 'all' }, effectiveFrom: day(1), setting, expectedToken: view.token, reason: REASON });
    expect(saved.revisions).toHaveLength(ids.length);
    return { ruleId, versionId };
  }
  it('Auto · Actual Hours · Split at Midnight: 10:00 PM–2:00 AM reaches the draft run as 2 hours on each date and the payslip pays exactly that', async () => {
    const { ruleId } = await autoSplitSetting();
    const w = await worker(ruleId), date = sourceDate(), p = { employmentId: w.employmentId, date };
    await clock(w.employmentId, date, 'in', '22:00:00');
    await clock(w.employmentId, date, 'out', '02:00:00', next(date));
    const read = await withTenant(ctx, tx => readOvertimeCalculationTx(tx, ctx, p));
    if (!read?.calculation) throw Error('Expected the policy calculation');
    expect(read.calculation).toMatchObject({ bindingKind: 'attendanceGroupPolicy', outcome: 'ready', durationOutcome: 'ready', payableNumerator: '240', transferable: true });
    const parts = await owner.db.select().from(s.attendanceOvertimePolicyPart).where(eq(s.attendanceOvertimePolicyPart.calculationId, read.calculation.id));
    expect(parts.map(part => ({ date: part.calendarDate, minutes: part.allocatedPayableMinutes })).sort((a, b) => a.date.localeCompare(b.date)))
      .toEqual([{ date, minutes: 120 }, { date: next(date), minutes: 120 }]);
    const batch = await createBatch(ctx, { companyId: b.companyId, payPeriod: date.slice(0, 7) });
    // Payroll prefill reads this day as covered; it does not wait on it.
    await withTenant(ctx, tx => readPayrollOvertimeCoverageTx(tx, ctx, { companyId: b.companyId, from: date, to: next(date), employmentIds: [w.employmentId], refuseUnresolved: true, payPeriod: date.slice(0, 7) }));
    const transfer = { ...p, expectedCalculationId: read.calculation.id, expectedSourceRevision: read.source.revision, batchId: batch.batchId, reason: REASON };
    expect((await transferOvertimePatternToPayroll(ctx, transfer)).status).toBe('transferred');
    const cash = await withTenant(ctx, tx => readPayrollOvertimePatternCashTx(tx, ctx, { batchId: batch.batchId }));
    // RM 12 × 1.5 = RM 18 an hour: 2 hours on each date is RM 36.00 each.
    expect(cash.lines.map(row => ({ date: row.date, amount: row.amountMinorUnits }))).toEqual([{ date, amount: '3600' }, { date: next(date), amount: '3600' }]);
    await expect(accrueToil(ctx, { employmentId: w.employmentId, workedDate: date })).rejects.toThrow();
    await generatePayslips(ctx, { batchId: batch.batchId });
    const [slip] = await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId, batch.batchId), eq(s.payslip.employmentId, w.employmentId)));
    expect(slip.overtimePay).toBe('72.00');
    // Original clockings are unchanged.
    const punches = await owner.db.select().from(s.attendancePunch).where(and(eq(s.attendancePunch.employmentId, w.employmentId), sql`voided_at is null`));
    expect(punches).toHaveLength(2);
  }, 180_000);

  it('banks the same setting\'s 4 hours as TOIL under the existing credit owner instead of cash', async () => {
    const { ruleId } = await autoSplitSetting();
    await setToilPolicy(ctx, { companyId: b.companyId, enabled: true, accrualBasis: 'hours_worked', expiryDays: 90, onExpiry: 'convert_to_pay',
      allowFirstScheduleEligible: false, autoAccrueOnApproval: false, carryForwardAtYearEnd: false, employeeRequestEnabled: true,
      extendedHoursEnabled: true, extendedHalfDayMinutes: 60, extendedFullDayMinutes: 120 });
    const w = await worker(ruleId), date = sourceDate();
    await clock(w.employmentId, date, 'in', '22:00:00');
    await clock(w.employmentId, date, 'out', '02:00:00', next(date));
    await accrueToil(ctx, { employmentId: w.employmentId, workedDate: date });
    const [accrual] = await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId, w.employmentId));
    expect(accrual).toMatchObject({ otMinutes: 240, status: 'active' });
    const read = await withTenant(ctx, tx => readOvertimeCalculationTx(tx, ctx, { employmentId: w.employmentId, date }));
    const [claim] = await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId, read!.source.id));
    expect(claim).toMatchObject({ mode: 'toil', toilAccrualId: accrual.id, coverageCalculationId: read!.calculation!.id });
  }, 180_000);

  it('Manual: clocked overtime stays on record, Payroll receives no attendance overtime and the run is not held', async () => {
    const ids = await group71();
    await financialModules();
    const ruleId = (await ensureStandardRule(ctx)).id;
    const view = await scheduleGroupOvertimeSetting(ctx, { ruleId });
    await saveScheduleGroupOvertimeSetting(ctx, { ruleId, scope: { kind: 'all' }, effectiveFrom: day(1), expectedToken: view.token, reason: REASON,
      setting: { ...defaultScheduleOvertimeSetting(null), approval: 'manual', splitAtMidnight: true } });
    expect(await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.ruleId, ruleId))).toHaveLength(ids.length);
    const w = await worker(ruleId), date = sourceDate();
    await clock(w.employmentId, date, 'in', '09:00:00');
    await clock(w.employmentId, date, 'out', '21:00:00');
    const read = await withTenant(ctx, tx => readOvertimeCalculationTx(tx, ctx, { employmentId: w.employmentId, date }));
    expect(read?.calculation).toMatchObject({ bindingKind: 'attendanceGroupPolicy', outcome: 'refused', transferable: false });
    const [dayRow] = await owner.db.select().from(s.attendance).where(and(eq(s.attendance.employmentId, w.employmentId), eq(s.attendance.attendanceDate, date)));
    expect((dayRow.calcTrace as Record<string, { status?: string }>).overtimePattern?.status, 'known zero, not a hold').toBe('recorded');
    const evidence = await owner.db.select().from(s.attendanceOvertimeCalculationEvidence).where(eq(s.attendanceOvertimeCalculationEvidence.calculationId, read!.calculation!.id));
    expect((evidence[0].evidence as Record<string, unknown>).policyFinancialDurationContract).toMatchObject({ state: 'none', reason: 'manualApproval' });
    const batch = await createBatch(ctx, { companyId: b.companyId, payPeriod: date.slice(0, 7) });
    await withTenant(ctx, tx => readPayrollOvertimeCoverageTx(tx, ctx, { companyId: b.companyId, from: date, to: date, employmentIds: [w.employmentId], refuseUnresolved: true, payPeriod: date.slice(0, 7) }));
    await expect(transferOvertimePatternToPayroll(ctx, { employmentId: w.employmentId, date, expectedCalculationId: read!.calculation!.id,
      expectedSourceRevision: read!.source.revision, batchId: batch.batchId, reason: REASON })).rejects.toThrow();
    await generatePayslips(ctx, { batchId: batch.batchId });
    const [slip] = await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId, batch.batchId), eq(s.payslip.employmentId, w.employmentId)));
    expect(slip.overtimePay, 'HR enters Manual overtime by hand in Payroll').toBe('0.00');
    expect(await owner.db.select().from(s.attendancePunch).where(and(eq(s.attendancePunch.employmentId, w.employmentId), sql`voided_at is null`))).toHaveLength(2);
  }, 180_000);

  it('Intersect with no overtime request on the day is a known zero that does not hold Payroll', async () => {
    const ids = await group71();
    await financialModules();
    const ruleId = (await ensureStandardRule(ctx)).id;
    const versionId = await formula(ids);
    const view = await scheduleGroupOvertimeSetting(ctx, { ruleId });
    await saveScheduleGroupOvertimeSetting(ctx, { ruleId, scope: { kind: 'all' }, effectiveFrom: day(1), expectedToken: view.token, reason: REASON,
      setting: { ...defaultScheduleOvertimeSetting(versionId), approval: 'auto', autoMethod: 'intersect' } });
    const w = await worker(ruleId), date = sourceDate();
    await clock(w.employmentId, date, 'in', '09:00:00');
    await clock(w.employmentId, date, 'out', '20:00:00');
    const read = await withTenant(ctx, tx => readOvertimeCalculationTx(tx, ctx, { employmentId: w.employmentId, date }));
    expect(read?.calculation).toMatchObject({ outcome: 'refused', transferable: false, approvalStatus: 'notRequired' });
    const evidence = await owner.db.select().from(s.attendanceOvertimeCalculationEvidence).where(eq(s.attendanceOvertimeCalculationEvidence.calculationId, read!.calculation!.id));
    expect((evidence[0].evidence as Record<string, unknown>).policyFinancialDurationContract).toMatchObject({ state: 'none', reason: 'noPayableOvertime' });
    await withTenant(ctx, tx => readPayrollOvertimeCoverageTx(tx, ctx, { companyId: b.companyId, from: date, to: date, employmentIds: [w.employmentId], refuseUnresolved: true, payPeriod: date.slice(0, 7) }));
  }, 180_000);
});
