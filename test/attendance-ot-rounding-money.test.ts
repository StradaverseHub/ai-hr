/**
 * 7c834696 rev 3 — THE OT ROUNDING FIX, ASSERTED IN RINGGIT.
 *
 * The pure arithmetic lives in test/attendance-stage1-calc.test.ts. This file exists because
 * `attendance.ot_minutes` is MONEY: it is what core/payroll.ts prefillOvertimeFromAttendance monetizes,
 * and a row-shape-only assertion is exactly what let a double-pay bug ship here before. So the whole path
 * runs for real — punch in, punch out, the engine's own rounding, the payroll prefill, a generated payslip
 * — and the assertion is a ringgit figure, not a minute count.
 *
 * THE PRODUCTION SHAPE, reproduced exactly. Rule "A02" (803be8ff-55dd-4615-8602-fc9f65ef5c05), re-read from
 * production 2026-08-11, carries two bands: 1→59 variable 1.50 with rounding OFF, and 60→119 variable 1.50
 * with rounding ON and Round-To 60. Shift AM03 is 09:00–18:00 with a 60-minute break. On 2026-08-05,
 * Eee Lee Yong (100814) clocked 09:00 → 19:30 — 90 minutes past the shift end — and the row stored 120,
 * because rounding to the NEAREST 60 sends 90 upward, past the band's own 119-minute ceiling and past the
 * minutes the employee was at work for. NURUL ALIAH (100815) clocked 09:00 → 19:40, raw 100, stored 120.
 *
 * The figures below are chosen so the difference is a whole number of ringgit that can be read at a glance:
 * a basic of RM2,080 gives ORP = 2080/26 = RM80 and an hourly rate of RM10 (s.60I(1A)), so an hour of
 * workday overtime at 1.5× is RM15. The 19:30 day is therefore RM15 under the shipped rule and would have
 * been RM30 under the rule it replaces — the employer was paying double for that day.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut } from '../core/attendance';
import { createAttendanceRule } from '../core/attendance-rule';
import { assignDefaultShift, createShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

/** 2026-05-05 is a Tuesday (ISO weekday 2) and sits inside the 2026-05 pay period. */
const DAY = '2026-05-05';
const PERIOD = '2026-05';
/** RM2,080 ⇒ ORP 80, hourly 10, one hour of workday OT at 1.5× = RM15. */
const BASIC = 2080;
const ONE_HOUR_OT = 15;

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The legacy comp + payroll_input earnings path is what carries the prefilled OT onto the slip. With
  // typed pay components enabled the slip's overtime would come from the component tables (which this file
  // seeds none of) and the money assertion below would silently read zero rather than fail.
  await setModule(b.tenantId, 'typed_pay_components', null);
});

let icSeq = 0;
const randomIc = () => `9001010${String(10000 + (icSeq += 1)).slice(-5)}`;

/** The production A02 table, both rows, with the first row's rounding OFF exactly as production has it. */
const a02OtRows = () => [
  { fromMinutes: 1, toMinutes: 59, ratePattern: 'variable' as const, rate: 1.5, roundingMode: 'none' as const, roundToMinutes: null },
  { fromMinutes: 60, toMinutes: 119, ratePattern: 'variable' as const, rate: 1.5, roundingMode: 'down' as const, roundToMinutes: 60 },
];

async function ruleWithBands() {
  return createAttendanceRule(adminCtx(b), {
    name: `A02_${randomUUID().slice(0, 6)}`,
    status: 'active',
    // A02's real lateness / early-out settings. Kept faithful so the day's STATUS cannot cloud the OT
    // figure being asserted, and so a future change to the lateness half fails here too.
    lateGracePeriodMinutes: 5,
    lateAfterMinutes: 15,
    lateDeductMinutes: 15,
    includeGraceInLateness: true,
    earlyGracePeriodMinutes: 0,
    earlyAfterMinutes: 15,
    earlyDeductMinutes: 15,
    includeGraceInEarlyOut: true,
    applyToEarlyOt: true,
    otRows: a02OtRows(),
  });
}

/** A whole employee: hired, paid, statutory-profiled, on an AM03-shaped shift bound to the banded rule. */
async function employeeOnBandedShift(email: string) {
  const a = adminCtx(b);
  const rule = await ruleWithBands();
  const shift = await createShift(a, {
    companyId: b.companyId,
    name: `AM03_${randomUUID().slice(0, 6)}`,
    code: `C_${randomUUID().slice(0, 6)}`,
    startTime: '09:00:00',
    endTime: '18:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
    ruleId: rule.id,
  });
  const e = await hireEmployee(a, {
    person: { fullName: 'OT Round', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: BASIC,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  // The IC is uniquely indexed tenant-wide, and this helper is called several times per test.
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: randomIc() });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: shift.id });
  return { a, employmentId: e.employmentId, ruleId: rule.id };
}

const otAmountOf = async (batchId: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.payrollInput)
    .where(eq(schema.payrollInput.batchId, batchId));
  return { amount: Number(row.overtimeAmount), source: row.otSource };
};

describe('7c834696 — OT band rounding floors, and the ringgit follows', () => {
  it("Eee Lee Yong's 19:30 day: 90 raw minutes pay ONE hour, not the two that were stored", async () => {
    const { a, employmentId } = await employeeOnBandedShift(`round90_${randomUUID()}@t.local`);
    await checkIn(a, { employmentId, date: DAY, time: '09:00:00' });
    const out = await checkOut(a, { employmentId, date: DAY, time: '19:30:00' });

    // The minutes first. 630 span − 60 break = 570 worked; 90 minutes past the 18:00 end; the 60→119 band
    // floors that to its own hour. Under round-to-nearest this was 120 — thirty minutes nobody worked.
    expect(out.workedMinutes).toBe(570);
    expect(out.otMinutes).toBe(60);

    // Now the money, through the real statutory prefill.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    const res = await prefillOvertimeFromAttendance(a, { batchId });
    expect(res.applied).toBe(1);
    const prefilled = await otAmountOf(batchId);
    expect(prefilled.source).toBe('attendance');
    expect(prefilled.amount).toBeCloseTo(ONE_HOUR_OT, 2);
    // The whole point, stated as the comparison the reporter will make: the day used to pay double.
    expect(prefilled.amount).toBeCloseTo(2 * ONE_HOUR_OT - ONE_HOUR_OT, 2);

    // And it reaches a generated payslip, not just the input row.
    await generatePayslips(await entitledCtx(b), { batchId });
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(Number(ps.overtimePay)).toBeCloseTo(ONE_HOUR_OT, 2);
    expect((ps.statutory as Record<string, unknown>).otSource).toBe('attendance');
  });

  it("NURUL ALIAH's 19:40 day: 100 raw minutes also pay one hour", async () => {
    const { a, employmentId } = await employeeOnBandedShift(`round100_${randomUUID()}@t.local`);
    await checkIn(a, { employmentId, date: DAY, time: '09:00:00' });
    const out = await checkOut(a, { employmentId, date: DAY, time: '19:40:00' });
    expect(out.otMinutes).toBe(60); // was 120

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await prefillOvertimeFromAttendance(a, { batchId });
    expect((await otAmountOf(batchId)).amount).toBeCloseTo(ONE_HOUR_OT, 2);
  });

  it('every OTHER overtime day on production is byte-identical — the fix is confined to one band', async () => {
    // These are the real 2026-08-04/05/06 clock-outs under A02 that were already correct. Each is asserted
    // through the engine rather than the pure function, so a regression anywhere between the punch and the
    // stored figure fails here. Raw minutes are the difference from the 18:00 shift end.
    const CASES: { out: string; ot: number; why: string }[] = [
      { out: '18:04:00', ot: 4, why: 'Kim Chi 2026-08-06 — band 1, rounding off' },
      { out: '18:15:00', ot: 15, why: 'Irwin Law 2026-08-06' },
      { out: '18:29:00', ot: 29, why: 'Daniel Tan (EMP-0005) 2026-08-05' },
      { out: '18:56:00', ot: 56, why: 'Daniel Tan (EMP-0002) 2026-08-05' },
      { out: '18:59:00', ot: 59, why: 'Mei Ling 2026-08-05 — top of band 1' },
      { out: '19:00:00', ot: 60, why: 'Ismail 2026-08-05 — exactly one hour, already a whole multiple' },
      { out: '20:00:00', ot: 120, why: 'Farah / Elon Musk 2026-08-05 — past the table, nothing rounds' },
      { out: '21:00:00', ot: 180, why: 'Kim Chi 2026-08-05' },
      { out: '22:00:00', ot: 240, why: 'TEST0002 2026-08-06' },
    ];
    for (const c of CASES) {
      const { a, employmentId } = await employeeOnBandedShift(`unchanged_${randomUUID()}@t.local`);
      await checkIn(a, { employmentId, date: DAY, time: '09:00:00' });
      const out = await checkOut(a, { employmentId, date: DAY, time: c.out });
      expect(out.otMinutes, c.why).toBe(c.ot);
    }
  });

  it('a day that ends ON TIME earns nothing, and a short day earns no negative overtime', async () => {
    const { a, employmentId } = await employeeOnBandedShift(`zero_${randomUUID()}@t.local`);
    await checkIn(a, { employmentId, date: DAY, time: '09:00:00' });
    const out = await checkOut(a, { employmentId, date: DAY, time: '17:35:00' });
    expect(out.otMinutes).toBe(0);

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    const res = await prefillOvertimeFromAttendance(a, { batchId });
    // No overtime minutes ⇒ no OT row is applied at all, so nothing is paid.
    expect(res.applied).toBe(0);
  });
});
