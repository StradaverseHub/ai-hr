import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import { hireEmployee, setReportingLine } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { assignDefaultShift, createShift, setRestDay } from '../core/roster';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import { createPolicy } from '../core/payroll-policy';
import { disburseNetAcrossCycles } from '../core/payroll-policy-config';
import { overtimePay } from '../localization/my/payroll';
import { todayInKualaLumpur } from '../lib/hr-date';
import { leaveBalance } from '../core/leave';
import {
  grantLeaveCredit,
  LeaveCreditError,
  previewLeaveCredit,
  reverseLeaveCredit,
  runToilExpiry,
  setToilPolicy,
  ToilFirstScheduleConsentRequiredError,
  ToilNotEligibleError,
  ToilOrdinaryWorkingDayError,
  ToilSweepForbiddenError,
  type ToilPolicyInput,
} from '../core/toil';
import { decideReplacementLeaveRequest, submitReplacementLeaveRequest } from '../core/replacement-request';

type Cycle = { seq: number; from: string; to: string; amount: number };

let b: Base;
let ctx: SessionContext;

const TODAY = todayInKualaLumpur();
/** 'YYYY-MM' of the calendar month before `iso`. */
const monthBefore = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const PERIOD = monthBefore(TODAY);
// Days 3 and 24 of one month always fall in different weekly cut-off cycles.
const D1 = `${PERIOD}-03`;
const D2 = `${PERIOD}-24`;
/** The first date in PERIOD with this ISO weekday (1 = Monday … 7 = Sunday). */
const firstWeekdayOf = (isoWeekday: number) => {
  for (let d = 1; d <= 7; d++) {
    const date = `${PERIOD}-${String(d).padStart(2, '0')}`;
    const wd = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    if (wd === isoWeekday) return date;
  }
  throw new Error('unreachable');
};
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const uniqEmail = () => `r299m_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId: b.companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: true,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

async function hire(basic: number, name = 'Credit Worker') {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  return e;
}

/** A rostered rest day, worked 08:00–17:00: 480 minutes, all of it overtime. */
async function workRestDay(employmentId: string, date: string) {
  const a = adminCtx(b);
  await setRestDay(a, { employmentId, shiftDate: date });
  await checkIn(a, { employmentId, date, time: '08:00:00' });
  await checkOut(a, { employmentId, date, time: '17:00:00' });
}

const otAmountOf = async (batchId: string, employmentId: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.payrollInput)
    .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
  return row ? Number(row.overtimeAmount) : 0;
};

/** Weekly payroll for the company, so the second read (cross-cycle weighting) actually runs. */
async function weeklyPayroll() {
  const { id } = await createPolicy(adminCtx(b), {
    companyId: b.companyId,
    name: 'Weekly',
    policyType: 'monthly',
    config: { frequency: 'weekly' },
  });
  await owner.db
    .insert(schema.companyPayrollConfig)
    .values({ tenantId: b.tenantId, companyId: b.companyId, defaultPayrollPolicyId: id });
}

/** Read the generated payslip's weekly schedule and the arguments the pure splitter needs to replay it. */
async function scheduleOf(batchId: string, employmentId: string) {
  const [slip] = await owner.db
    .select()
    .from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  const sched = (slip.statutory as { paymentSchedule?: { frequency: string; cycles: Cycle[] } }).paymentSchedule;
  expect(sched?.frequency, 'the run must really be weekly, or the second read never executed').toBe('weekly');
  const cycles = sched!.cycles;
  const cycleOf = (d: string) => cycles.findIndex((c) => d >= c.from && d <= c.to);
  expect(cycleOf(D1)).toBeGreaterThanOrEqual(0);
  expect(cycleOf(D2), 'the two worked days must land in different cycles').not.toBe(cycleOf(D1));
  const zeros = cycles.map(() => 0);
  const args = {
    net: Number(slip.netPay),
    recurring: Number(slip.basicSalary) + Number(slip.allowance) + Number(slip.bonus),
    overtime: Number(slip.overtimePay),
    unpaid: 0,
    cycleDays: cycles.map(
      (c) => Math.round((Date.parse(`${c.to}T00:00:00Z`) - Date.parse(`${c.from}T00:00:00Z`)) / 86_400_000) + 1,
    ),
    unpaidDays: zeros,
  };
  const vector = (days: string[]) => zeros.map((_, i) => (days.some((d) => cycleOf(d) === i) ? 480 : 0));
  return { actual: cycles.map((c) => c.amount), args, vector };
}

const ONE_REST_DAY = overtimePay({ monthlyWages: 3000, days: [{ dayType: 'rest_day', minutes: 480 }] }).total;
const TWO_REST_DAYS = overtimePay({
  monthlyWages: 3000,
  days: [
    { dayType: 'rest_day', minutes: 480 },
    { dayType: 'rest_day', minutes: 480 },
  ],
}).total;

async function replacementTypeId() {
  const [lt] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return lt.id;
}
const balanceOf = async (employmentId: string) =>
  owner.db.transaction(async (tx) => leaveBalance(tx as never, employmentId, await replacementTypeId()));

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  await setModule(b.tenantId, 'toil', 'active');
  ctx = await entitledCtx(b);
});


/**
 * r299 FIX PASS (hand-fixed after the adversarial verification of build/r299-credit). Each describe pins one
 * money or security defect the verifier measured; each was re-derived red by reverting its fix.
 */

async function mgrSetup(subject: { employmentId: string; personId: string }) {
  const mgr = await hire(8000, 'Manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: mgr.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  const uS = await createAppUser(b.tenantId, subject.personId, 'employee');
  const uM = await createAppUser(b.tenantId, mgr.personId, 'manager');
  const subCtx: SessionContext = { tenantId: b.tenantId, userId: uS, personId: subject.personId, roles: ['employee'], entitlements: ctx.entitlements };
  const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: mgr.personId, roles: ['manager'], entitlements: ctx.entitlements };
  return { subCtx, mgrCtx };
}

const convertedPayload = async (accrualId: string) => {
  const [ev] = await owner.db
    .select({ payload: schema.domainEvent.payload })
    .from(schema.domainEvent)
    .where(and(eq(schema.domainEvent.aggregateId, accrualId), eq(schema.domainEvent.eventType, 'toil.converted')));
  return ev.payload as Record<string, unknown>;
};

describe('fix pass · an expired credit is valued on what is LEFT of it, never on declared or overtime minutes', () => {
  it('a 3-day request credit on one rest day converts at 3 × ORP, not at a statutory figure for 1,440 declared minutes', async () => {
    const e = await hire(3000, 'Requester');
    const { subCtx, mgrCtx } = await mgrSetup(e);
    await setToilPolicy(ctx, policy({ employeeRequestEnabled: true }));
    const sat = firstWeekdayOf(6);
    const { requestId } = await submitReplacementLeaveRequest(subCtx, {
      employmentId: e.employmentId,
      unit: 'day',
      lines: [{ workedDate: sat, days: 3 }],
      firstScheduleConsent: true,
      today: TODAY,
    });
    await decideReplacementLeaveRequest(mgrCtx, { requestId, decision: 'approved' });
    const [row] = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, e.employmentId));
    expect(row.workedDayKind, 'the kind is still resolved and stored for the screens').not.toBeNull();
    expect(row.dayType, 'but it does not drive the valuation').toBeNull();

    const res = await runToilExpiry(ctx, { today: addDays(TODAY, 400) });
    expect(res.converted).toBe(1);
    const payload = await convertedPayload(row.id);
    expect(payload.valuationBasis).toBe('generic_orp');
    expect(payload.amountOwed).toBeCloseTo(Math.round(3 * (3000 / 26) * 100) / 100, 2);
  });

  it('an HR credit of 0.5 day on a rest day with 8 hours of overtime converts at 0.5 × ORP', async () => {
    const e = await hire(3000);
    await workRestDay(e.employmentId, D1);
    await setToilPolicy(ctx, policy());
    const g = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId,
      workedDate: D1,
      days: 0.5,
      reason: 'Half-day cover',
      firstScheduleConsent: true,
      expiresOn: addDays(D1, 1),
      today: TODAY,
    });
    const res = await runToilExpiry(ctx, { today: TODAY });
    expect(res.converted).toBe(1);
    const payload = await convertedPayload(g.accrualId);
    expect(payload.valuationBasis).toBe('generic_orp');
    expect(payload.amountOwed).toBeCloseTo(Math.round(0.5 * (3000 / 26) * 100) / 100, 2);
  });
});

describe('fix pass · HR may not add or reverse a credit once payroll has settled that date’s overtime', () => {
  const settle = (batchId: string) =>
    owner.db.update(schema.payrollBatch).set({ status: 'processed' }).where(eq(schema.payrollBatch.id, batchId));

  it('ADD is refused against a processed run for the month; with no run it goes through', async () => {
    const e = await hire(3000);
    await workRestDay(e.employmentId, D1);
    await setToilPolicy(ctx, policy());
    const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
    await settle(batchId);
    const refused = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'Late claim', firstScheduleConsent: true, today: TODAY,
    }).then(() => null, (err: Error) => err);
    expect(refused).toBeInstanceOf(LeaveCreditError);
    expect(refused!.message).toMatch(/already been processed/);
    expect(await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, e.employmentId))).toHaveLength(0);

    // CONTROL — the same add on a day with NO overtime is not a payroll question and goes through.
    const other = await hire(3000, 'No Overtime');
    const ok = await grantLeaveCredit(ctx, {
      employmentId: other.employmentId, workedDate: firstWeekdayOf(7), days: 1, reason: 'Cover', firstScheduleConsent: true, today: TODAY,
    });
    expect(ok.draftPayrollToRefresh).toBeNull();
  });

  it('REVERSE is refused once a run has been processed without that overtime', async () => {
    const e = await hire(3000);
    await workRestDay(e.employmentId, D1);
    await setToilPolicy(ctx, policy());
    const g = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'Entered in error', firstScheduleConsent: true, today: TODAY,
    });
    const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
    await settle(batchId);
    const refused = await reverseLeaveCredit(ctx, { accrualId: g.accrualId, reason: 'Wrong', today: TODAY }).then(
      () => null,
      (err: Error) => err,
    );
    expect(refused).toBeInstanceOf(LeaveCreditError);
    expect(refused!.message).toMatch(/leave that overtime unpaid/);
    const [row] = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, g.accrualId));
    expect(row.status).toBe('active');
  });

  it('a DRAFT already carrying the overtime allows the add and names the period whose prefill must be re-run', async () => {
    const e = await hire(3000);
    await workRestDay(e.employmentId, D1);
    await workRestDay(e.employmentId, D2);
    await setToilPolicy(ctx, policy());
    const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
    await prefillOvertimeFromAttendance(ctx, { batchId });
    expect(await otAmountOf(batchId, e.employmentId)).toBeCloseTo(TWO_REST_DAYS, 2);
    const g = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'Stock take', firstScheduleConsent: true, today: TODAY,
    });
    expect(g.draftPayrollToRefresh).toBe(PERIOD);
    await prefillOvertimeFromAttendance(ctx, { batchId });
    expect(await otAmountOf(batchId, e.employmentId), 're-running the prefill takes the credited day out').toBeCloseTo(ONE_REST_DAY, 2);
  });
});

describe('fix pass · HR cannot credit themselves', () => {
  it('add, preview and reverse are refused on the caller’s own record', async () => {
    const e = await hire(3000, 'HR Themself');
    await workRestDay(e.employmentId, D1);
    await setToilPolicy(ctx, policy());
    const self: SessionContext = { ...ctx, personId: e.personId };
    const add = await grantLeaveCredit(self, {
      employmentId: e.employmentId, workedDate: D1, days: 366, reason: 'Mine', firstScheduleConsent: true, today: TODAY,
    }).then(() => null, (err: Error) => err);
    expect(add).toBeInstanceOf(ToilSweepForbiddenError);
    expect(add!.message).toMatch(/own record/);
    const preview = await previewLeaveCredit(self, { employmentId: e.employmentId, workedDate: D1 }).then(() => null, (err: Error) => err);
    expect(preview).toBeInstanceOf(ToilSweepForbiddenError);

    const g = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'By another admin', firstScheduleConsent: true, today: TODAY,
    });
    const rev = await reverseLeaveCredit(self, { accrualId: g.accrualId, reason: 'Mine', today: TODAY }).then(() => null, (err: Error) => err);
    expect(rev).toBeInstanceOf(ToilSweepForbiddenError);
    expect(rev!.message).toMatch(/own record/);
  });
});

describe('fix pass · dates', () => {
  it('a date worked before the employee was hired is refused', async () => {
    const e = await hire(3000);
    await setToilPolicy(ctx, policy());
    const refused = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId, workedDate: '2023-12-30', days: 1, reason: 'Before hire', firstScheduleConsent: true, today: TODAY,
    }).then(() => null, (err: Error) => err);
    expect(refused).toBeInstanceOf(LeaveCreditError);
    expect(refused!.message).toMatch(/within this employee's service/);
  });

  it('the default expiry counts from the MALAYSIAN date of the instant, not the UTC date', async () => {
    const e = await hire(3000);
    await setToilPolicy(ctx, policy());
    // 20:00Z on day X is 04:00 on day X+1 in Kuala Lumpur; 01:00Z on day X+1 is 09:00 the same Malaysian day.
    const late = await previewLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, approvedOn: new Date(`${D2}T20:00:00Z`) });
    const nextMorning = await previewLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, approvedOn: new Date(`${addDays(D2, 1)}T01:00:00Z`) });
    expect(late.defaultExpiresOn).not.toBeNull();
    expect(late.defaultExpiresOn).toBe(nextMorning.defaultExpiresOn);
  });
});
