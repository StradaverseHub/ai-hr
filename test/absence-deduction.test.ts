/**
 * e2632276 — NAME THE ABSENCE DEDUCTION (and make one exist).
 *
 * The reporter asked for an ABSENT pay code. The approved plan declines it, twice over: the deduction they
 * described is already running for unpaid LEAVE, so a pay code would charge a second time; and a
 * `kind='deduction'` pay component is applied AFTER EPF/SOCSO/EIS/PCB, whereas the unpaid deduction is
 * taken BEFORE them, which is the correct treatment. What was genuinely missing is (1) a plain no-show
 * deducting nothing at all, and (2) the amount being invisible — folded into one unnamed "Other
 * deductions" figure with no name and no day count.
 *
 * So this file pins four things:
 *   • THE COUNT (core/absence-days.ts) — what is and is not an absent day, especially the rest-day and
 *     roster rules, which are the difference between a correct payslip and charging someone for a day
 *     their own employer rostered them off.
 *   • THE GATE — off (the shipped default) must be BYTE-IDENTICAL, not merely "close".
 *   • THE PLACEMENT — on, the EPF/SOCSO base drops by the absence amount. That single assertion is the
 *     whole argument against the pay code, so it is asserted rather than described.
 *   • THE PAYSLIP — the two named lines reconcile, with and without the stamp.
 *
 * MAY 2026, and the month is chosen rather than convenient. It is 31 days long (so the default
 * calendar-month divisor is 31 and the arithmetic is checkable by hand), it holds exactly 21 Mon–Fri days
 * and 5 Fridays, and it is safely in the PAST — the helper refuses to bill a day that has not happened
 * yet, so a test written against the current month would silently count only the days elapsed when it ran.
 *
 *   Fri 2026-05-01 · Sat 05-02 · Sun 05-03 · Mon 05-04 … Fri 05-08 · Mon 05-18 · Mon 05-25 · Sun 05-31
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { absentDaysByEmployment } from '../core/absence-days';
import { attendanceForDate, attendanceForEmploymentRange } from '../core/attendance';
import { statusOf } from '../core/attendance-derive';
import { payslipAbsenceLines } from '../core/payslip-absence-lines';
import { cleanPayrollPolicyConfig } from '../core/payroll-policy-config';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips, unpaidDaysByEmployment } from '../core/payroll';
import { assignPolicy, createPolicy } from '../core/payroll-policy';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const PERIOD = '2026-05';
const START = '2026-05-01';
const END = '2026-05-31';
/** The 21 Mon–Fri dates of May 2026, in order. */
const WEEKDAYS = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const iso = `2026-05-${String(d).padStart(2, '0')}`;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(iso);
  }
  return out;
})();

let b: Base;

/** A bare employment (no assignment, no default shift, no roster) hired long before the period. */
async function makeEmp(name: string, hiredOn = '2020-01-01', terminatedOn: string | null = null) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name}_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn, terminatedOn })
    .returning({ id: schema.employment.id });
  return e.id;
}

const addAttendance = (employmentId: string, date: string, status: 'present' | 'absent' | 'late' | 'half_day') =>
  owner.db.insert(schema.attendance).values({
    tenantId: b.tenantId,
    employmentId,
    attendanceDate: date,
    status,
    dayType: 'workday',
    workedMinutes: status === 'absent' ? 0 : 480,
  });

/** Present on every May weekday EXCEPT the ones named. */
async function presentExcept(employmentId: string, except: string[]) {
  for (const d of WEEKDAYS) {
    if (except.includes(d)) continue;
    await addAttendance(employmentId, d, 'present');
  }
}

const addHoliday = (date: string) =>
  owner.db
    .insert(schema.holiday)
    .values({ tenantId: b.tenantId, country: 'MY', holidayDate: date, name: `PH ${date}` });

/** An APPROVED leave request. `paid:false` makes it an UNPAID leave type, which payroll deducts separately. */
async function addLeave(
  employmentId: string,
  from: string,
  to: string,
  o: { paid: boolean; durationType?: 'full_day' | 'half_day_am' | 'hourly'; days?: number },
) {
  // leave_type_code_shape (migration 0031): ^[A-Z][A-Z0-9_]{1,31}$.
  const code = `LT${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code, paid: o.paid })
    .returning({ id: schema.leaveType.id });
  await owner.db.insert(schema.leaveRequest).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: lt.id,
    startDate: from,
    endDate: to,
    days: String(o.days ?? 1),
    durationType: o.durationType ?? 'full_day',
    status: 'approved',
  });
}

async function makeShift(pattern: number[] | null) {
  const code = `S${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const [s] = await owner.db
    .insert(schema.shift)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      code,
      name: code,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: pattern,
    })
    .returning({ id: schema.shift.id });
  return s.id;
}

const absentDays = (ctx: SessionContext, employmentIds: string[], from = START, to = END) =>
  withTenant(ctx, (tx) => absentDaysByEmployment(tx, from, to, employmentIds));

const payslipFor = async (employmentId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
  return ps;
};

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — what counts as an absent day', () => {
  it('the fixture month really does hold 21 weekdays and 5 Fridays', () => {
    expect(WEEKDAYS).toHaveLength(21);
    expect(WEEKDAYS.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 5)).toHaveLength(5);
  });

  it('a bare scheduled working day with no attendance record is counted', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Bare');
    for (const d of ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']) {
      await addAttendance(e, d, 'present');
    }
    // 21 weekdays, 5 attended ⇒ 16 absences.
    expect((await absentDays(a, [e])).get(e)).toBe(16);
  });

  it('a public holiday, a company non-working weekday, and approved FULL-DAY leave are each excluded', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Excluded');
    await addHoliday('2026-05-25'); //                                      Monday — a public holiday
    await addLeave(e, '2026-05-04', '2026-05-05', { paid: true, days: 2 }); // Mon + Tue on approved leave
    // Sat 2026-05-02 / Sun 2026-05-03 are company non-working days and were never candidates.
    expect((await absentDays(a, [e])).get(e)).toBe(18); // 21 − 1 holiday − 2 leave
  });

  it('an attendance row explicitly marked ABSENT is COUNTED (it used to be filed as present)', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Marked');
    for (const d of ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08']) {
      await addAttendance(e, d, 'present');
    }
    expect((await absentDays(a, [e])).get(e)).toBe(16);
    // Re-mark those five days as explicit no-shows. Each day already HAS a row, so the old count skipped
    // every one of them — while the daily and individual screens have always shown them in red.
    await owner.db
      .update(schema.attendance)
      .set({ status: 'absent', workedMinutes: 0 })
      .where(eq(schema.attendance.employmentId, e));
    expect((await absentDays(a, [e])).get(e)).toBe(21);
  });

  it('THE ROSTER WINS — a rostered rest day on a company working day is NOT an absence', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Rostered');
    expect((await absentDays(a, [e])).get(e)).toBe(21); // nothing recorded at all
    // The employer personally rostered this employee to rest on two ordinary weekdays.
    await owner.db.insert(schema.rosterAssignment).values([
      { tenantId: b.tenantId, employmentId: e, shiftDate: '2026-05-04', isRestDay: true },
      { tenantId: b.tenantId, employmentId: e, shiftDate: '2026-05-05', isRestDay: true },
    ]);
    expect((await absentDays(a, [e])).get(e)).toBe(19);
  });

  it('a rostered SHIFT on a company non-working day IS a scheduled day (the roster wins both ways)', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Weekend');
    const shiftId = await makeShift([1, 2, 3, 4, 5]);
    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      shiftDate: '2026-05-02', // a Saturday
      shiftId,
      isRestDay: false,
    });
    expect((await absentDays(a, [e])).get(e)).toBe(22); // 21 weekdays + the rostered Saturday
  });

  it("a weekday excluded by the employee's DEFAULT-SHIFT pattern is not an absence", async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('FourDay');
    const shiftId = await makeShift([1, 2, 3, 4]); // Mon–Thu; no Friday
    await owner.db.update(schema.employment).set({ defaultShiftId: shiftId }).where(eq(schema.employment.id, e));
    expect((await absentDays(a, [e])).get(e)).toBe(16); // 21 − the month's 5 Fridays
  });

  it('dates before hire and after termination are skipped', async () => {
    const a = await entitledCtx(b);
    const joiner = await makeEmp('Joiner', '2026-05-18'); //               starts Monday 18 May
    const leaver = await makeEmp('Leaver', '2020-01-01', '2026-05-08'); // last day Friday 8 May
    const m = await absentDays(a, [joiner, leaver]);
    expect(m.get(joiner)).toBe(WEEKDAYS.filter((d) => d >= '2026-05-18').length); // 10
    expect(m.get(leaver)).toBe(WEEKDAYS.filter((d) => d <= '2026-05-08').length); // 6
  });

  it('never bills a day that has not happened yet', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Future');
    const m = await withTenant(a, (tx) => absentDaysByEmployment(tx, '2099-03-01', '2099-03-31', [e]));
    expect(m.get(e)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// THE BUG THE PLAN PROMISES TO FIX AT THE SAME TIME. Before this, both Records loaders decided "is a
// missing row explained?" from the COMPANY weekday list alone, while the shift column beside it already
// honoured the roster. An employee rostered to rest on a company working day therefore rendered a red
// "Absent" — and under the new deduction that red day would have cost them real money.
describe('e2632276 — the Attendance screens: the roster wins', () => {
  it('daily Records: a rostered rest day on a company working day reads REST, not ABSENT', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('DailyRest');
    const before = (await attendanceForDate(a, '2026-05-04')).find((r) => r.employmentId === e)!;
    expect(before.context).toBeNull();
    expect(statusOf(before)).toBe('absent'); // the wrong red day, as reported

    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      shiftDate: '2026-05-04',
      isRestDay: true,
    });
    const after = (await attendanceForDate(a, '2026-05-04')).find((r) => r.employmentId === e)!;
    expect(after.context).toBe('rest_day');
    expect(after.isRosterRest).toBe(true);
    expect(statusOf(after)).toBe('rest');
  });

  it("daily Records: a default-shift pattern rest day reads OFF, not ABSENT", async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('DailyOff');
    const shiftId = await makeShift([1, 2, 3, 4]); // Mon–Thu; no Friday
    await owner.db.update(schema.employment).set({ defaultShiftId: shiftId }).where(eq(schema.employment.id, e));
    const row = (await attendanceForDate(a, '2026-05-08')).find((r) => r.employmentId === e)!; // a Friday
    expect(row.context).toBe('rest_day');
    expect(row.isRosterRest).toBe(false); // a pattern rest day is OFF, not an explicit rostered rest
    expect(statusOf(row)).toBe('off');
  });

  it('the individual Records range agrees with the daily screen, day for day', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('RangeRest');
    await owner.db.insert(schema.rosterAssignment).values({
      tenantId: b.tenantId,
      employmentId: e,
      shiftDate: '2026-05-04',
      isRestDay: true,
    });
    const rows = await attendanceForEmploymentRange(a, e, '2026-05-04', '2026-05-05');
    expect(rows.map((r) => [r.date, r.context, statusOf(r)])).toEqual([
      ['2026-05-04', 'rest_day', 'rest'],
      ['2026-05-05', null, 'absent'], //  an ordinary unexplained Tuesday is still an absence
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — absence and unpaid leave are disjoint', () => {
  it('an approved FULL-DAY unpaid-leave day is counted by unpaid leave and NOT by absence', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Unpaid');
    await addLeave(e, '2026-05-04', '2026-05-05', { paid: false, days: 2 });
    const unpaid = await withTenant(a, (tx) => unpaidDaysByEmployment(tx, START, END, [e]));
    expect(unpaid.get(e)).toBe(2);
    // 21 weekdays − the 2 unpaid days. No date is in both figures, so the kernel can add them.
    expect((await absentDays(a, [e])).get(e)).toBe(19);
  });

  it('an approved HALF-DAY leave date is never an absence — with a record on the day OR without one', async () => {
    const a = await entitledCtx(b);
    const worked = await makeEmp('HalfWorked');
    const noRecord = await makeEmp('HalfNoRecord');
    for (const e of [worked, noRecord]) {
      await addLeave(e, '2026-05-04', '2026-05-04', { paid: false, durationType: 'half_day_am', days: 0.5 });
    }
    await addAttendance(worked, '2026-05-04', 'half_day');

    const m = await absentDays(a, [worked, noRecord]);
    expect(m.get(worked)).toBe(20); // 21 weekdays − the recorded half day
    // And WITHOUT a clock-in the day is still not an absence. `approvedLeaveDates` does not return
    // partial-day dates, so this is the carve-out that stops the same date being charged 0.5 days of
    // unpaid time off AND a whole day of absence — 1.5 days' pay for half a day off.
    expect(m.get(noRecord)).toBe(20);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — the payroll gate', () => {
  /** A policy with the absence deduction switched on (everything else default). */
  async function switchOn(a: SessionContext, employmentId: string) {
    const { id } = await createPolicy(a, {
      companyId: b.companyId,
      name: `Absence ${randomUUID().slice(0, 8)}`,
      policyType: 'monthly',
      config: { leave: { deductAbsentDays: true } },
    });
    await assignPolicy(a, { employmentId, policyId: id });
  }

  it('the setting is persisted only when TRUE (an untouched policy stays byte-identical)', () => {
    expect(cleanPayrollPolicyConfig({ leave: { deductAbsentDays: false } })).toBeNull();
    expect(cleanPayrollPolicyConfig({ leave: {} })).toBeNull();
    expect(cleanPayrollPolicyConfig({ leave: { deductAbsentDays: true } })).toEqual({
      leave: { deductAbsentDays: true },
    });
  });

  it('OFF (the default) — a month of nothing but absences changes nothing at all', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('GateOff');
    await setCompensation(a, { employmentId: e, basicSalary: 6000, effectiveFrom: '2020-01-01' });
    expect((await absentDays(a, [e])).get(e)).toBe(21); // every scheduled day is an absence

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    const ps = await payslipFor(e);
    expect(Number(ps.otherDeductions)).toBe(0);
    expect(Number(ps.basicSalary)).toBe(6000);
    const st = ps.statutory as Record<string, unknown>;
    expect(st.absent).toBeUndefined();
    expect(st.unpaidLeave).toBeUndefined();
  });

  it('ON — the absence deducts at basic / calendar days and comes off BEFORE the statutory contributions', async () => {
    const a = await entitledCtx(b);
    const off = await makeEmp('StatOff');
    const on = await makeEmp('StatOn');
    for (const e of [off, on]) {
      await setCompensation(a, { employmentId: e, basicSalary: 6000, effectiveFrom: '2020-01-01' });
      await presentExcept(e, ['2026-05-06']); // one Wednesday missing
    }
    expect((await absentDays(a, [on])).get(on)).toBe(1);
    expect((await absentDays(a, [off])).get(off)).toBe(1);
    await switchOn(a, on);

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });

    const psOff = await payslipFor(off);
    const psOn = await payslipFor(on);
    // 6000 / 31 × 1 = 193.5483… → 193.55, rounded ONCE on the amount.
    expect(Number(psOn.otherDeductions)).toBeCloseTo(193.55, 2);
    // The identical employee WITHOUT the setting is untouched — this is the gate.
    expect(Number(psOff.otherDeductions)).toBe(0);
    // PRE-STATUTORY, which is the whole argument against an ABSENT pay code: a pay-code deduction is
    // applied AFTER the statutory calculation, so EPF would have been worked out on the full 6,000.
    const stOn = psOn.statutory as Record<string, number>;
    const stOff = psOff.statutory as Record<string, number>;
    expect(stOn.epfEmployee).toBeLessThan(stOff.epfEmployee);
    expect(stOn.socsoEmployee).toBeLessThanOrEqual(stOff.socsoEmployee);
    // And the stamp that lets the payslip name the line.
    expect((psOn.statutory as { absent?: { days: number; amount: number } }).absent).toEqual({
      days: 1,
      amount: 193.55,
    });
    expect((psOff.statutory as { absent?: unknown }).absent).toBeUndefined();
  });

  it('rounds ONCE, on the amount — the daily rate is not rounded first', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Rounding');
    await setCompensation(a, { employmentId: e, basicSalary: 5000, effectiveFrom: '2020-01-01' });
    await presentExcept(e, ['2026-05-04', '2026-05-05', '2026-05-06']);
    await switchOn(a, e);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    const ps = await payslipFor(e);
    // round2(5000 / 31 × 3) = round2(483.8709…) = 483.87.
    // Rounding the RATE first would give round2(161.29 × 3) = 483.87 as well — but the RATE is 161.2903…,
    // and 161.29 × 3 = 483.87 vs 483.8709…: the two agree here only because both land in the same cent.
    // What this pins is the expression: the divisor is applied to the amount, not per day.
    expect(Number(ps.otherDeductions)).toBeCloseTo(483.87, 2);
    expect((ps.statutory as { absent?: { days: number } }).absent?.days).toBe(3);
  });

  it('a fully-absent month does not produce a negative net', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('AllAbsent');
    await setCompensation(a, { employmentId: e, basicSalary: 6000, effectiveFrom: '2020-01-01' });
    await switchOn(a, e);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    const ps = await payslipFor(e);
    expect(Number(ps.netPay)).toBeGreaterThanOrEqual(0);
    expect(Number(ps.netPay)).toBeCloseTo(Number(ps.grossPay) - Number(ps.totalDeductions), 2);
  });

  it('unpaid leave AND absence appear as two separate named lines that reconcile', async () => {
    const a = await entitledCtx(b);
    const e = await makeEmp('Both');
    await setCompensation(a, { employmentId: e, basicSalary: 6000, effectiveFrom: '2020-01-01' });
    await addLeave(e, '2026-05-04', '2026-05-05', { paid: false, days: 2 }); // 2 unpaid-leave days
    await presentExcept(e, ['2026-05-04', '2026-05-05', '2026-05-06']); //     Wed 06 = the one absence
    await switchOn(a, e);
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    await generatePayslips(a, { batchId });
    const ps = await payslipFor(e);

    const lines = payslipAbsenceLines(ps.statutory, ps.otherDeductions);
    expect(lines.any).toBe(true);
    expect(lines.unpaidLeave).toEqual({ days: 2, amount: 387.1 }); // 6000/31 × 2 = 387.0967… → 387.10
    expect(lines.absent).toEqual({ days: 1, amount: 193.55 }); //     6000/31 × 1 = 193.5483… → 193.55
    // The two named lines are the WHOLE of Other deductions here, so the unnamed residual row disappears
    // — and the section still adds up to what it prints.
    expect(lines.residual).toBe(0);
    expect(lines.showResidual).toBe(false);
    expect(lines.unpaidLeave!.amount + lines.absent!.amount).toBeCloseTo(Number(ps.otherDeductions), 2);
    expect(Number(ps.netPay)).toBeCloseTo(Number(ps.grossPay) - Number(ps.totalDeductions), 2);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — migration 0422 actually ran', () => {
  // Trap #5 in this repo's standing orders: a migration whose journal `when` sits below the deployed
  // watermark is SILENTLY SKIPPED — drizzle does not error. 0422 writes no DDL (the setting is a jsonb
  // key), so nothing else in the suite would notice its absence. This asserts the one artefact it does
  // produce, against a database built by replaying the journal.
  it('stamps the description of payroll_policy.config into the database', async () => {
    const rows = await owner.db.execute(
      sql`select col_description('payroll_policy'::regclass, (
            select ordinal_position from information_schema.columns
            where table_name = 'payroll_policy' and column_name = 'config'
          )::int) as comment`,
    );
    const comment = (rows as unknown as { comment: string | null }[])[0]?.comment ?? '';
    expect(comment).toContain('leave.deductAbsentDays');
    expect(comment).toContain('BEFORE EPF/SOCSO/EIS/PCB');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('e2632276 — the payslip lines are derived from the slip, never from today', () => {
  it('a payslip with NO stamp keeps the single lumped row', () => {
    expect(payslipAbsenceLines({ epfEmployee: 660 }, '250.00')).toEqual({
      unpaidLeave: null,
      absent: null,
      residual: 250,
      showResidual: true,
      any: false,
    });
  });

  it('the residual is what is LEFT of Other deductions, and hides when it nets to zero', () => {
    const stamp = { unpaidLeave: { days: 2, amount: 387.1 }, absent: { days: 1, amount: 193.55 } };
    const exact = payslipAbsenceLines(stamp, '580.65');
    expect(exact.residual).toBe(0);
    expect(exact.showResidual).toBe(false);

    // The same slip plus a keyed manual deduction: the residual row stays and shows only what is left.
    const withOther = payslipAbsenceLines(stamp, '700.65');
    expect(withOther.residual).toBe(120);
    expect(withOther.showResidual).toBe(true);
  });

  it('one half alone still names its line and leaves the other out', () => {
    const only = payslipAbsenceLines({ absent: { days: 1, amount: 193.55 } }, '193.55');
    expect(only.unpaidLeave).toBeNull();
    expect(only.absent).toEqual({ days: 1, amount: 193.55 });
    expect(only.residual).toBe(0);
  });

  it('a zero half prints nothing, and a garbage stamp degrades to the pre-feature path', () => {
    expect(payslipAbsenceLines({ absent: { days: 0, amount: 0 } }, '10.00').any).toBe(false);
    expect(payslipAbsenceLines({ absent: 'nonsense' }, '10.00').any).toBe(false);
    expect(payslipAbsenceLines(null, null).residual).toBe(0);
  });
});
