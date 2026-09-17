/**
 * 3fb1a611 (r299) · LEAVE CREDIT — THE MONEY ARMS.
 *
 * A Leave Credit is not only leave. Banking a worked day as a credit takes that day's overtime out of payroll
 * (core/payroll.ts EXCLUDE_TOIL_BANKED_DAYS, in BOTH reads of attendance.ot_minutes: the OT prefill and the
 * weekly cross-cycle weighting), and a reversal must put it back. A First-Schedule employee's statutory
 * overtime cash can be traded for time only with the company override AND their own agreement — an HR power
 * must not be a way around that. And a credit that expires unused converts to CASH for such an employee, so
 * what it is valued at matters.
 *
 * Every date is derived from todayInKualaLumpur(): the worked days sit in LAST calendar month, so they are
 * always in the past and always inside one payroll period.
 */
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

describe('HR Add Leave Credit suppresses the worked day’s overtime; a reversal restores it (both payroll reads)', () => {
  it('a credit on a day with overtime takes that overtime out of the prefill AND the cross-cycle weighting', async () => {
    const e = await hire(3000);
    await workRestDay(e.employmentId, D1);
    await workRestDay(e.employmentId, D2);
    await setToilPolicy(ctx, policy());
    await weeklyPayroll();

    // Before save, the form is told there is overtime on the date.
    const preview = await previewLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1 });
    expect(preview).toMatchObject({ workedDayKind: 'rest_day', eligibleDay: true, overtimeMinutes: 480, firstSchedule: true });

    const granted = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId,
      workedDate: D1,
      days: 1,
      reason: 'Worked the stock take, no claim filed',
      firstScheduleConsent: true,
      today: TODAY,
    });
    expect(granted.overtimeSuppressedMinutes).toBe(480);

    const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
    expect(await prefillOvertimeFromAttendance(ctx, { batchId })).toMatchObject({ applied: 1, ineligible: 0 });
    // READ 1 — the prefill monetises D2 only.
    expect(await otAmountOf(batchId, e.employmentId)).toBeCloseTo(ONE_REST_DAY, 2);
    expect(ONE_REST_DAY).not.toBeCloseTo(TWO_REST_DAYS, 2);

    // READ 2 — the weekly schedule carries no OT weight in D1's cycle.
    await generatePayslips(ctx, { batchId });
    const { actual, args, vector } = await scheduleOf(batchId, e.employmentId);
    expect(actual, 'the credited day must carry no OT weight').toEqual(
      disburseNetAcrossCycles({ ...args, otMinutes: vector([D2]) }),
    );
    expect(actual, 'and weighting D1 as well must be a different split, or this proves nothing').not.toEqual(
      disburseNetAcrossCycles({ ...args, otMinutes: vector([D1, D2]) }),
    );
  });

  it('reversing the credit puts the overtime back into the prefill AND the cross-cycle weighting', async () => {
    const e = await hire(3000);
    await workRestDay(e.employmentId, D1);
    await workRestDay(e.employmentId, D2);
    await setToilPolicy(ctx, policy());
    await weeklyPayroll();
    const granted = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId,
      workedDate: D1,
      days: 1,
      reason: 'Entered in error',
      firstScheduleConsent: true,
      today: TODAY,
    });

    const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
    await prefillOvertimeFromAttendance(ctx, { batchId });
    expect(await otAmountOf(batchId, e.employmentId), 'suppressed while the credit stands').toBeCloseTo(ONE_REST_DAY, 2);

    const reversed = await reverseLeaveCredit(ctx, { accrualId: granted.accrualId, reason: 'Entered twice', today: TODAY });
    expect(reversed.overtimeRestoredMinutes).toBe(480);

    await prefillOvertimeFromAttendance(ctx, { batchId });
    // READ 1 — both rest days are paid again.
    expect(await otAmountOf(batchId, e.employmentId)).toBeCloseTo(TWO_REST_DAYS, 2);

    await generatePayslips(ctx, { batchId });
    const { actual, args, vector } = await scheduleOf(batchId, e.employmentId);
    // READ 2 — D1's cycle carries OT weight again.
    expect(actual).toEqual(disburseNetAcrossCycles({ ...args, otMinutes: vector([D1, D2]) }));
    expect(actual).not.toEqual(disburseNetAcrossCycles({ ...args, otMinutes: vector([D2]) }));
  });
});

describe('A reversal never deletes', () => {
  it('the credit row stays, marked reversed, beside an offsetting ledger row — and the day can be credited again', async () => {
    const e = await hire(8000);
    await workRestDay(e.employmentId, D1);
    await setToilPolicy(ctx, policy());
    const granted = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId,
      workedDate: D1,
      days: 1.5,
      reason: 'Wrong amount',
      remarks: 'Should have been one day',
      today: TODAY,
    });
    expect(await balanceOf(e.employmentId)).toBe(1.5);

    const out = await reverseLeaveCredit(ctx, { accrualId: granted.accrualId, reason: 'Wrong amount entered', today: TODAY });

    const rows = await owner.db
      .select()
      .from(schema.toilAccrual)
      .where(eq(schema.toilAccrual.employmentId, e.employmentId))
      .orderBy(asc(schema.toilAccrual.createdAt), asc(schema.toilAccrual.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: granted.accrualId,
      status: 'reversed',
      reversalReason: 'Wrong amount entered',
      reversalLedgerEntryId: out.reversalLedgerEntryId,
      source: 'hr_manual_grant',
      note: 'Wrong amount',
      remarks: 'Should have been one day',
      workedDayKind: 'rest_day',
    });
    expect(rows[0].reversedAt).not.toBeNull();

    const ledger = await owner.db
      .select({ id: schema.leaveLedger.id, entryType: schema.leaveLedger.entryType, days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(and(eq(schema.leaveLedger.employmentId, e.employmentId), eq(schema.leaveLedger.leaveTypeId, await replacementTypeId())))
      .orderBy(asc(schema.leaveLedger.createdAt), asc(schema.leaveLedger.id));
    expect(ledger.map((r) => [r.entryType, Number(r.days)])).toEqual([
      ['in_lieu_accrual', 1.5],
      ['debit', -1.5],
    ]);
    expect(ledger[0].id).toBe(rows[0].ledgerEntryId);
    expect(ledger[1].id).toBe(out.reversalLedgerEntryId);
    expect(await balanceOf(e.employmentId)).toBe(0);

    const events = await owner.db
      .select({ eventType: schema.domainEvent.eventType })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, granted.accrualId))
      .orderBy(asc(schema.domainEvent.sequence));
    expect(events.map((x) => x.eventType)).toEqual(['toil.accrued', 'toil.reversed']);

    // Re-entered with the right amount: the reversed credit no longer occupies the day (migration 0469).
    await grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'Corrected', today: TODAY });
    expect(await balanceOf(e.employmentId)).toBe(1);
    // …but two LIVE credits for one day are still impossible.
    await expect(
      grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'Again', today: TODAY }),
    ).rejects.toThrow(/already been banked/i);
    await expect(
      reverseLeaveCredit(ctx, { accrualId: granted.accrualId, reason: 'twice', today: TODAY }),
    ).rejects.toThrow(/already been reversed/i);
  });

  it('refuses a used, an expired, or a non-admin reversal, naming why', async () => {
    const e = await hire(8000);
    await workRestDay(e.employmentId, D1);
    await workRestDay(e.employmentId, D2);
    await setToilPolicy(ctx, policy());
    const used = await grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'r', today: TODAY });
    // Partly used by Replacement Leave (the consumption tally — see test/r299-leave-credit-cancel.test.ts for the real path).
    await owner.db.update(schema.toilAccrual).set({ daysTaken: '0.50' }).where(eq(schema.toilAccrual.id, used.accrualId));
    await expect(reverseLeaveCredit(ctx, { accrualId: used.accrualId, reason: 'x', today: TODAY })).rejects.toThrow(
      /Cancel the leave that used it first/,
    );

    const expired = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId,
      workedDate: D2,
      days: 1,
      reason: 'r',
      expiresOn: addDays(D2, 1),
      today: TODAY,
    });
    await expect(reverseLeaveCredit(ctx, { accrualId: expired.accrualId, reason: 'x', today: TODAY })).rejects.toThrow(
      new RegExp(`expired on ${addDays(D2, 1)}`),
    );

    const employeeCtx: SessionContext = { ...ctx, roles: ['employee'] };
    await expect(reverseLeaveCredit(employeeCtx, { accrualId: used.accrualId, reason: 'x', today: TODAY })).rejects.toBeInstanceOf(
      ToilSweepForbiddenError,
    );
    const statuses = await owner.db
      .select({ status: schema.toilAccrual.status })
      .from(schema.toilAccrual)
      .where(eq(schema.toilAccrual.employmentId, e.employmentId));
    expect(statuses.every((s) => s.status === 'active'), 'a refusal changes nothing').toBe(true);
  });
});

describe('The First Schedule floor applies to an HR-added credit exactly as to a request', () => {
  it('refuses a First-Schedule employee without the company override, and without their recorded agreement', async () => {
    const e = await hire(3000); // ≤ RM4,000: statutory overtime cash applies
    await workRestDay(e.employmentId, D1);

    await setToilPolicy(ctx, policy({ allowFirstScheduleEligible: false }));
    const noOverride = grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'r', firstScheduleConsent: true, today: TODAY });
    await expect(noOverride).rejects.toBeInstanceOf(ToilNotEligibleError);
    await expect(noOverride).rejects.not.toBeInstanceOf(ToilOrdinaryWorkingDayError);
    await expect(noOverride).rejects.toThrow(/First Schedule/);

    await setToilPolicy(ctx, policy({ allowFirstScheduleEligible: true }));
    await expect(
      grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'r', today: TODAY }),
    ).rejects.toBeInstanceOf(ToilFirstScheduleConsentRequiredError);

    const rows = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, e.employmentId));
    expect(rows, 'nothing was banked by either refusal').toHaveLength(0);

    // With both, it is allowed — and frozen to convert to pay, never lapse.
    const ok = await grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: D1, days: 1, reason: 'r', firstScheduleConsent: true, today: TODAY });
    expect(ok.forcedConvertOnExpiry).toBe(true);
  });

  it('refuses an ordinary working day, a future date, an expiry before the date worked, no reason, and no module', async () => {
    const e = await hire(8000);
    await setToilPolicy(ctx, policy());
    const monday = firstWeekdayOf(1); // no roster, Mon–Fri company working week
    expect((await previewLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: monday })).eligibleDay).toBe(false);
    await expect(
      grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: monday, days: 1, reason: 'r', today: TODAY }),
    ).rejects.toBeInstanceOf(ToilOrdinaryWorkingDayError);

    const saturday = firstWeekdayOf(6);
    await expect(
      grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: addDays(TODAY, 1), days: 1, reason: 'r', today: TODAY }),
    ).rejects.toThrow(/future/);
    await expect(
      grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: saturday, days: 1, reason: 'r', expiresOn: addDays(saturday, -1), today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveCreditError);
    await expect(
      grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: saturday, days: 1, reason: '   ', today: TODAY }),
    ).rejects.toThrow(/reason is required/);

    await setModule(b.tenantId, 'toil', null);
    const off = await entitledCtx(b);
    await expect(
      grantLeaveCredit(off, { employmentId: e.employmentId, workedDate: saturday, days: 1, reason: 'r', today: TODAY }),
    ).rejects.toThrow(/toil module is not enabled/i);
  });

  it('an HR-typed expiry is frozen as typed; an untouched one follows the policy from today', async () => {
    const e = await hire(8000);
    await setToilPolicy(ctx, policy({ expiryDays: 60 }));
    const sat = firstWeekdayOf(6);
    const sun = firstWeekdayOf(7);
    const approvedOn = new Date(`${TODAY}T04:00:00.000Z`);
    const preview = await previewLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: sat, approvedOn });
    expect(preview.defaultExpiresOn).toBe(addDays(TODAY, 60));
    const a = await grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: sat, days: 1, reason: 'r', today: TODAY, approvedOn });
    expect(a.expiresOn).toBe(preview.defaultExpiresOn);
    const typed = addDays(TODAY, 10);
    const c = await grantLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: sun, days: 1, reason: 'r', expiresOn: typed, today: TODAY });
    expect(c.expiresOn).toBe(typed);
  });
});

describe('An OFF-day credit is recorded as an off day and converts on the ORP fallback', () => {
  it('no exact statutory figure is claimed for off-day work', async () => {
    // A default shift whose Saturday is an OFF day (b8aa3466's four-way pattern).
    const shift = await createShift(adminCtx(b), {
      name: 'Day with off Saturday',
      code: 'D_OFFSAT',
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      offPattern: [6],
    });
    const e = await hire(3000);
    await assignDefaultShift(adminCtx(b), { employmentId: e.employmentId, shiftId: shift.id });
    await setToilPolicy(ctx, policy());
    const sat = firstWeekdayOf(6);
    expect((await previewLeaveCredit(ctx, { employmentId: e.employmentId, workedDate: sat })).workedDayKind).toBe('off_day');

    const g = await grantLeaveCredit(ctx, {
      employmentId: e.employmentId,
      workedDate: sat,
      days: 1,
      reason: 'Off-day cover',
      firstScheduleConsent: true,
      expiresOn: addDays(sat, 1),
      today: TODAY,
    });
    const [row] = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, g.accrualId));
    expect(row.workedDayKind).toBe('off_day');
    expect(row.dayType, 'the valuation day type stays unknown for an off day').toBeNull();

    const res = await runToilExpiry(ctx, { today: TODAY });
    expect(res.converted).toBe(1);
    const [ev] = await owner.db
      .select({ payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, g.accrualId), eq(schema.domainEvent.eventType, 'toil.converted')));
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.valuationBasis).toBe('generic_orp');
    expect(String(payload.valuationNote)).toMatch(/^Off day/);
    expect(payload.workedDayKind).toBe('off_day');
    expect(payload.amountOwed).toBeCloseTo(Math.round((3000 / 26) * 100) / 100, 2);
    // The expiry debit is linked to the credit it settled.
    const [settled] = await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id, g.accrualId));
    expect(settled.settledLedgerEntryId).toBe(payload.ledgerEntryId);
  });
});

describe('Row security on the register (migration 0469)', () => {
  it('a non-admin line manager can approve a Leave Credit request; an employee cannot write their own register row', async () => {
    const sub = await hire(8000, 'Subject');
    const mgr = await hire(8000, 'Manager');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: sub.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const uS = await createAppUser(b.tenantId, sub.personId, 'employee');
    const uM = await createAppUser(b.tenantId, mgr.personId, 'manager');
    const subCtx: SessionContext = { tenantId: b.tenantId, userId: uS, personId: sub.personId, roles: ['employee'], entitlements: ctx.entitlements };
    const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: mgr.personId, roles: ['manager'], entitlements: ctx.entitlements };
    await setToilPolicy(ctx, policy({ employeeRequestEnabled: true }));

    const sat = firstWeekdayOf(6);
    const { requestId } = await submitReplacementLeaveRequest(subCtx, {
      employmentId: sub.employmentId,
      unit: 'day',
      lines: [{ workedDate: sat, days: 1 }],
      today: TODAY,
    });
    // Before 0469 this threw "new row violates row-level security policy" on the toil_accrual INSERT.
    const res = await decideReplacementLeaveRequest(mgrCtx, { requestId, decision: 'approved' });
    expect(res.granted).toBe(1);

    const selfWrite = await withTenant(subCtx, (tx) =>
      tx.insert(schema.toilAccrual).values({
        tenantId: b.tenantId,
        employmentId: sub.employmentId,
        workedDate: firstWeekdayOf(7),
        otMinutes: 480,
        daysCredited: '1.00',
        accrualBasis: 'hours_worked',
        expiresOn: TODAY,
      }),
    ).then(
      () => 'written',
      (e: Error & { cause?: { message?: string } }) => `${e.message} ${e.cause?.message ?? ''}`,
    );
    expect(selfWrite).toMatch(/row-level security/);
  });
});
