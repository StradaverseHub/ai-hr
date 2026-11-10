/**
 * c03670cc — a TYPED band rate (for example 1.75) is REPORTING ONLY, asserted in ringgit.
 *
 * The plan's promise: "The OT Rate on a Schedule Group decides which overtime column the hours are reported
 * under on the attendance screens. Overtime pay in payroll is worked out by the payroll overtime settings,
 * and this plan does not change it." core/payroll.ts prefillOvertimeFromAttendance reads only
 * attendance.ot_minutes and day_type and monetizes them through the statutory pack; it never reads a band
 * multiplier. So two employees with the same punches, one on a 1.5 band and one on a 1.75 band, must be paid
 * exactly the same — while the attendance split reports the 1.75 minutes on their own "other rate" line.
 *
 * Same fixture shape as test/attendance-ot-rounding-money.test.ts: RM2,080 basic ⇒ ORP RM80, hourly RM10,
 * one hour of workday overtime at the statutory 1.5× = RM15.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { createAttendanceRule } from '../core/attendance-rule';
import { assignDefaultShift, createShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import { otByRate } from '../core/attendance-derive';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const DAY = '2026-05-05';
const PERIOD = '2026-05';
const BASIC = 2080;
const ONE_HOUR_OT = 15;

let b: Base;
beforeAll(async () => { await migrateTestDb(); });
afterAll(async () => { await closeAll(); });
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'typed_pay_components', null);
});

let icSeq = 0;
const randomIc = () => `9102020${String(10000 + (icSeq += 1)).slice(-5)}`;

async function employeeOnBand(rate: number, email: string) {
  const a = adminCtx(b);
  const rule = await createAttendanceRule(a, {
    name: `Typed rate ${rate} ${randomUUID().slice(0, 6)}`, status: 'active',
    lateGracePeriodMinutes: 0, lateAfterMinutes: 0, lateDeductMinutes: 0, includeGraceInLateness: false,
    earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
    applyToEarlyOt: false,
    otRows: [{ fromMinutes: 1, toMinutes: 0, ratePattern: 'variable', rate, phRate: null, roundingMode: 'none', roundToMinutes: null }],
  });
  const shift = await createShift(a, { companyId: b.companyId, name: `Day ${randomUUID().slice(0, 6)}`, code: `T_${randomUUID().slice(0, 6)}`,
    startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5], ruleId: rule.id });
  const e = await hireEmployee(a, { person: { fullName: 'Typed rate fixture', primaryEmail: email }, companyId: b.companyId,
    departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2026-01-01' });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: randomIc() });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: shift.id });
  return { a, employmentId: e.employmentId, ruleId: rule.id };
}

describe('c03670cc — typed band rates change the reporting column, never the pay', () => {
  it('the rule stores the typed rate exactly as typed', async () => {
    const { ruleId } = await employeeOnBand(1.75, `typed_store_${randomUUID()}@t.local`);
    const [row] = await owner.db.select().from(schema.attendanceRuleOtRow).where(eq(schema.attendanceRuleOtRow.ruleId, ruleId));
    expect(row.rate).toBe('1.75');
    await expect(createAttendanceRule(adminCtx(b), {
      name: `Three decimals ${randomUUID().slice(0, 6)}`, status: 'active', lateGracePeriodMinutes: 0, lateAfterMinutes: 0,
      lateDeductMinutes: 0, includeGraceInLateness: false, earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0,
      earlyDeductMinutes: 0, includeGraceInEarlyOut: false, applyToEarlyOt: false,
      otRows: [{ fromMinutes: 1, toMinutes: 0, ratePattern: 'variable', rate: 1.755, phRate: null, roundingMode: 'none', roundToMinutes: null }],
    }), 'a third decimal is refused, never rounded to 1.76').rejects.toThrow(/two decimal places/);
  });

  it('1.5 and 1.75 bands with the same punches produce the same payroll overtime, reported in different columns', async () => {
    const standard = await employeeOnBand(1.5, `typed_15_${randomUUID()}@t.local`);
    const typed = await employeeOnBand(1.75, `typed_175_${randomUUID()}@t.local`);
    for (const e of [standard, typed]) {
      await checkIn(e.a, { employmentId: e.employmentId, date: DAY, time: '09:00:00' });
      const out = await checkOut(e.a, { employmentId: e.employmentId, date: DAY, time: '19:00:00' });
      expect(out.otMinutes, 'one hour past the 18:00 end').toBe(60);
    }
    const day = async (employmentId: string) => (await owner.db.select().from(schema.attendance)
      .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, DAY))))[0];
    const s = await day(standard.employmentId), t = await day(typed.employmentId);
    expect([s.otMinutes, t.otMinutes]).toEqual([60, 60]);
    expect(s.ot15Minutes).toBe(60);
    // The typed rate's minutes are stored where such minutes have always been stored (ot_flat_minutes), so
    // the six columns still sum to ot_minutes, and the trace records them as the `other` bucket with the rate.
    expect([t.otFlatMinutes, t.ot15Minutes]).toEqual([60, 0]);
    expect(t.calcTrace).toMatchObject({ overtime: { split: { other: 60 } } });
    // The attendance breakdown reports them on their own line, with the typed rate.
    const reported = otByRate({ ...t, formulaOvertime: null }, { separateOtherRate: true });
    expect(reported).toMatchObject({ flat: 0, ot15: 0, other: { minutes: 60, rates: [1.75] } });

    const { batchId } = await createBatch(standard.a, { companyId: b.companyId, payPeriod: PERIOD });
    const res = await prefillOvertimeFromAttendance(standard.a, { batchId });
    expect(res.applied).toBe(2);
    const inputs = await owner.db.select().from(schema.payrollInput).where(eq(schema.payrollInput.batchId, batchId));
    const amount = (employmentId: string) => Number(inputs.find((row) => row.employmentId === employmentId)!.overtimeAmount);
    expect(amount(standard.employmentId)).toBeCloseTo(ONE_HOUR_OT, 2);
    expect(amount(typed.employmentId), 'the typed 1.75 band does not change overtime pay').toBeCloseTo(amount(standard.employmentId), 2);

    await generatePayslips(await entitledCtx(b), { batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    const pay = (employmentId: string) => Number(slips.find((row) => row.employmentId === employmentId)!.overtimePay);
    expect(pay(typed.employmentId)).toBeCloseTo(pay(standard.employmentId), 2);
    expect(pay(typed.employmentId)).toBeCloseTo(ONE_HOUR_OT, 2);
  });
});
