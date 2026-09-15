/**
 * 3fb1a611 (r279) · THE MONEY GUARD. Real payroll numbers, end to end, five times over one worked day.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE BEHAVIOUR TESTS. A `toil_accrual` row does not merely record a
 * leave credit: it SUPPRESSES that worked day's overtime pay. `EXCLUDE_TOIL_BANKED_DAYS`
 * (core/payroll.ts:501) is applied at :2588 (the OT prefill) and :3635 (the weekly/bi-weekly cross-cycle
 * weighting) and it is UNCONDITIONAL — not behind the `toil` module flag, by deliberate decision in
 * ADR-0077 slice 3, so that a lapsed entitlement can never re-monetise a day that was already banked. So
 * every path this round adds that CREATES or REMOVES a register row moves cash:
 *
 *   · an HR manual grant on a worked date stops that day being payable;
 *   · reversing that grant makes it payable again;
 *   · and — the one that is easy to get wrong — consuming the credit as leave, and then CANCELLING that
 *     leave, must leave the suppression exactly where it was, because the credit still exists either way.
 *
 * Nothing here greps source. Each measurement drives `prefillOvertimeFromAttendance` against a fresh draft
 * batch and reads the ringgit figure out of `payroll_input`, then deletes the batch so the next
 * measurement is independent (the prefill returns early when it finds no eligible OT rows, so a reused
 * batch would keep a stale amount and the guard would pass for the wrong reason).
 *
 * The employee is paid RM3,000 — at or below the First Schedule wage ceiling — because `overtimePay`
 * returns `eligible: false` above it and would monetise nothing at all, which is the vacuous version of
 * this test. Banking for such an employee therefore also needs the company override and their own recorded
 * consent, which is the statutory floor doing its job and is asserted in r279-leave-credit.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { createBatch, deleteDraftBatch, prefillOvertimeFromAttendance } from '../core/payroll';
import { adminCancelLeave, decideLeave, requestLeave, todayInKualaLumpur } from '../core/leave';
import { grantToilCreditManually, reverseToilCredit, setToilPolicy, type ToilPolicyInput } from '../core/toil';

let b: Base;
let ctx: SessionContext;
let employmentId: string;

/** n days from today (KL). Derived from the clock — never a hardcoded calendar (CLAUDE.md §8). */
function day(n: number): string {
  return new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
function nextWeekday(n: number): string {
  let d = day(n);
  for (let i = 0; i < 7; i++) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return d;
}
/** A worked day comfortably in the past, and the calendar month the payroll run for it covers. */
const WORKED = day(-40);
const PAY_PERIOD = WORKED.slice(0, 7);

const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId: b.companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 180,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: true, // ≤ ceiling employee: the override, plus per-election consent below
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

/**
 * THE MEASUREMENT. One fresh draft batch, one prefill, read the ringgit, drop the batch.
 *
 * `prefillOvertimeFromAttendance` returns early (`applied: 0`) when the exclusion leaves it no OT rows,
 * WITHOUT resetting an existing `payroll_input` row to zero — so re-prefilling into the same batch would
 * report the previous run's cash and this guard would never see the suppression. A fresh batch each time
 * is what makes the four readings independent facts rather than one reading repeated.
 */
async function overtimeCashForTheWorkedDay(): Promise<number> {
  const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PAY_PERIOD });
  try {
    await prefillOvertimeFromAttendance(ctx, { batchId });
    const [row] = await owner.db
      .select({ ot: schema.payrollInput.overtimeAmount })
      .from(schema.payrollInput)
      .where(
        and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)),
      );
    return Number(row?.ot ?? 0);
  } finally {
    await deleteDraftBatch(ctx, { batchId });
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const registerRows = () =>
  owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId));

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
  const e = await hireEmployee(ctx, {
    person: { fullName: 'Money Worker', primaryEmail: `r279m_${Math.random().toString(36).slice(2)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  employmentId = e.employmentId;
  // RM3,000 — inside the First Schedule, so the statutory OT figure below is a real, non-zero number.
  await setCompensation(ctx, { employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setToilPolicy(ctx, policy());
  // One rostered rest day, worked 08:00–17:00 ⇒ 540 span − 60 break = 480 overtime minutes.
  await setRestDay(ctx, { employmentId, shiftDate: WORKED });
  await checkIn(ctx, { employmentId, date: WORKED, time: '08:00:00' });
  await checkOut(ctx, { employmentId, date: WORKED, time: '17:00:00' });
});

describe('r279 MONEY · a credit suppresses the worked day’s overtime pay, and a reversal gives it back', () => {
  it('OT before a credit → after an HR grant → after the leave is taken → after it is cancelled → after the grant is reversed', async () => {
    // ── 0 · BEFORE. The day is payable: a real statutory rest-day figure, computed by the pack. ────────
    const before = await overtimeCashForTheWorkedDay();
    expect(before, 'the fixture must actually monetise the rest day, or every figure below is vacuous').toBeGreaterThan(0);
    // THE FIGURE, NOT JUST "NON-ZERO". EA s.60(3): work on a rest day for MORE than half but not more
    // than the employee's normal hours is one day's ORP. 480 minutes is a full normal day, so there is no
    // excess-hours leg: 3,000 / 26 = RM115.3846… ⇒ RM115.38. If the seeded overtime ruleset ever moves,
    // this guard is supposed to shout rather than quietly re-baseline.
    expect(before, 'EA s.60(3): one day ORP = 3000 / 26').toBe(115.38);

    // ── 1 · AFTER THE HR GRANT. The register row exists ⇒ the day stops being payable, in the same
    //        transaction that created the leave credit. Cash XOR time in lieu, never both. ─────────────
    const granted = await grantToilCreditManually(ctx, {
      employmentId,
      workedDate: WORKED,
      days: 1,
      reason: 'Worked the rest day, no claim was ever submitted',
      firstScheduleConsent: true,
    });
    expect(granted.daysCredited).toBe(1);
    // The service SAYS SO rather than leaving it implicit — the screen granting the credit shows this.
    expect(granted.overtimeSuppressedForDate).toBe(WORKED);
    expect(granted.overtimeSuppressedMinutes).toBe(480);
    const afterGrant = await overtimeCashForTheWorkedDay();
    expect(afterGrant, 'a granted credit must take the day out of the overtime prefill entirely').toBe(0);

    // ── 2 · AFTER THE CREDIT IS SPENT AS LEAVE. Spending it does not un-bank the worked day, so the
    //        suppression must NOT move. This is the reading most likely to be got wrong by a reversal
    //        that reasons about the leave instead of about the register. ───────────────────────────────
    const [typeRow] = await owner.db
      .select({ id: schema.leaveType.id })
      .from(schema.leaveType)
      .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
    const leaveDate = nextWeekday(10);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: typeRow.id,
      startDate: leaveDate,
      endDate: leaveDate,
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    expect((await registerRows())[0].status).toBe('taken');
    const afterTaken = await overtimeCashForTheWorkedDay();
    expect(afterTaken, 'spending the credit does not make the worked day payable again').toBe(0);

    // ── 3 · AFTER THE LEAVE IS CANCELLED. The credit comes back to the register (status 'active',
    //        days_taken 0) and the day is STILL not payable, because the credit still exists. A
    //        cancellation that re-exposed the cash here would pay the day AND hold the credit. ─────────
    await adminCancelLeave(ctx, { leaveRequestId: req.leaveRequestId, reason: 'operational' });
    const restored = (await registerRows())[0];
    expect(restored.status).toBe('active');
    expect(Number(restored.daysTaken)).toBe(0);
    const afterCancel = await overtimeCashForTheWorkedDay();
    expect(afterCancel, 'the credit is back, so the day stays banked rather than payable').toBe(0);

    // ── 4 · AFTER THE GRANT ITSELF IS REVERSED. Now there is no credit, so the day is payable again —
    //        at exactly the figure it started at, to the sen. ────────────────────────────────────────
    const reversal = await reverseToilCredit(ctx, {
      accrualId: granted.accrualId,
      reason: 'granted against the wrong employee',
    });
    expect(reversal.overtimeRestoredForDate).toBe(WORKED);
    expect(reversal.overtimeRestoredMinutes).toBe(480);
    // THE MONEY ASSERTION FIRST, deliberately. It is the one that has to be load-bearing: a reversal that
    // gave the balance back but left the register row would still pass a row-shape check taken before it.
    const afterReversal = await overtimeCashForTheWorkedDay();
    expect(afterReversal, 'the reversal must give back the SAME cash the grant took away').toBe(before);
    expect(afterReversal).toBe(115.38);
    expect(await registerRows(), 'and the register row is gone, not merely flagged').toEqual([]);
  });

  it('the suppression is not switchable: revoking the `toil` module does not re-monetise a banked day', async () => {
    // The direction ADR-0077 slice 3 fixed, re-asserted for the HR-GRANT path specifically. If the
    // exclusion ever moves back inside a module branch, a company whose add-on lapses would pay cash for
    // days it already handed out as leave.
    await grantToilCreditManually(ctx, {
      employmentId,
      workedDate: WORKED,
      days: 1,
      reason: 'no claim submitted',
      firstScheduleConsent: true,
    });
    await setModule(b.tenantId, 'toil', null);
    const revoked = await entitledCtx(b);
    const saved = ctx;
    ctx = revoked;
    try {
      expect(await overtimeCashForTheWorkedDay()).toBe(0);
    } finally {
      ctx = saved;
    }
  });

  it('a workday banked under working_hours_and_overtime loses its overtime cash too — the setting moves money', async () => {
    // The one widening `replacement_leave_from` buys. Asserted with a number rather than argued: opting
    // in means an ordinary working day's overtime stops being prefilled as cash, which is what "banked
    // instead of paid" means and is the same trade a rest day already makes.
    const workday = nextWeekday(-20);
    await checkIn(ctx, { employmentId, date: workday, time: '09:00:00' });
    await checkOut(ctx, { employmentId, date: workday, time: '20:00:00' });
    const [att] = await owner.db
      .select({ dayType: schema.attendance.dayType, ot: schema.attendance.otMinutes })
      .from(schema.attendance)
      .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, workday)));
    expect(att.dayType).toBe('workday');
    expect(Number(att.ot)).toBeGreaterThan(0);

    // Both days are in the same calendar month as WORKED only by luck, so measure against the workday's
    // own period and read the whole employee figure — the rest day is untouched in this case.
    const period = workday.slice(0, 7);
    const measure = async () => {
      const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: period });
      try {
        await prefillOvertimeFromAttendance(ctx, { batchId });
        const [row] = await owner.db
          .select({ ot: schema.payrollInput.overtimeAmount })
          .from(schema.payrollInput)
          .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
        return Number(row?.ot ?? 0);
      } finally {
        await deleteDraftBatch(ctx, { batchId });
      }
    };
    const withWorkdayOt = await measure();
    // The rest day (RM115.38, above) plus this workday's own overtime: 3,000 / 26 / 8 = RM14.42 an hour,
    // × 1.5 under EA s.60A(3)(a) = RM21.63, × 2 hours ⇒ RM43.26. Both days fall in the same calendar
    // month, so one prefill reads both.
    expect(withWorkdayOt).toBe(158.64);

    await setToilPolicy(ctx, policy({ replacementLeaveFrom: 'working_hours_and_overtime' }));
    await grantToilCreditManually(ctx, {
      employmentId,
      workedDate: workday,
      days: 0.5,
      reason: 'banked the late evening',
      firstScheduleConsent: true,
    });
    const afterBanking = await measure();
    // Exactly the rest day's RM115.38 is left: the workday's RM43.26 has become leave instead of cash.
    expect(afterBanking, 'banking the workday must remove its overtime cash').toBe(115.38);
    expect(round2(withWorkdayOt - afterBanking), 'and the difference is that workday’s own OT').toBe(43.26);
  });
});
