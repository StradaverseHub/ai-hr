/**
 * 3fb1a611 (r279) "Leave Credit" — the four things this round built, pinned end to end.
 *
 *   1. CANCELLATION / REVERSAL of an approved replacement leave. `restoreReplacementLeaveTx` is the
 *      inverse of `consumeReplacementLeaveTx` that both cancellation paths in core/leave.ts were refusing
 *      for the want of. Reverse FIFO, days_taken restored, 'taken' → 'active', REFUSED where a lot has
 *      expired since it was spent, and NOT refused where the register never held the credit at all (the
 *      ghost-credit shortfall path).
 *   2. HR MANUAL GRANT that writes BOTH rows, plus its reversal.
 *   3. `toil_policy.replacement_leave_from`, wired — default 'overtime' changes nothing.
 *   4. (the panel's "expiring soon" lives in r279-replacement-expiring-soon.dom.test.tsx — presentation.)
 *
 * THE MONEY GUARD IS A SEPARATE FILE (r279-leave-credit-money.test.ts) and is the one that matters: a
 * `toil_accrual` row suppresses that worked day's OVERTIME PAY in both of core/payroll.ts's reads.
 *
 * DATES ARE DERIVED FROM THE CLOCK, never hardcoded (CLAUDE.md §8). The cancellation flow has a real
 * future gate in it — an employee may only give back a date strictly after today — so a fixed August 2026
 * calendar would rot. `day(n)` is n days from today in Kuala Lumpur; `nextWeekday(n)` walks forward to the
 * next Mon–Fri so a leave request actually counts working days.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
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
import {
  adminCancelLeave,
  decideLeave,
  decideLeaveCancellation,
  LeaveCancellationNotAllowedError,
  requestLeave,
  requestLeaveCancellation,
  todayInKualaLumpur,
} from '../core/leave';
import {
  accrueToil,
  grantToilCreditManually,
  reverseToilCredit,
  setToilPolicy,
  ToilCreditReversalNotAllowedError,
  ToilDisabledError,
  ToilNotEligibleError,
  ToilSweepForbiddenError,
  eligibleDayTypesFor,
  type ToilPolicyInput,
} from '../core/toil';

let b: Base;
let ctx: SessionContext; // a REAL resolved snapshot that carries `toil` — see replacement-leave-controls.test.ts

/** n days from today (KL), as YYYY-MM-DD. Negative = in the past. */
function day(n: number): string {
  return new Date(Date.parse(`${todayInKualaLumpur()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** The first Mon–Fri on or after `day(n)` — a date a working-days leave type actually counts. */
function nextWeekday(n: number): string {
  let d = day(n);
  for (let i = 0; i < 7; i++) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return d;
}

const uniqEmail = () => `r279_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 180, // comfortably beyond every leave date below; the expiry cases set their own
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

async function hire(basic = 5000) {
  const e = await hireEmployee(ctx, {
    person: { fullName: 'Credit Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(ctx, {
    employmentId: e.employmentId,
    basicSalary: basic,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const self: SessionContext = { tenantId: b.tenantId, userId, personId: e.personId, roles: ['employee'] };
  return { ...e, self };
}

/** Work a rostered rest day (480 OT ⇒ 1.0 day on the hours_worked basis) and bank it. */
async function earnRestDayCredit(employmentId: string, workedDate: string, approvedOn: Date) {
  await setRestDay(ctx, { employmentId, shiftDate: workedDate });
  await checkIn(ctx, { employmentId, date: workedDate, time: '08:00:00' });
  await checkOut(ctx, { employmentId, date: workedDate, time: '17:00:00' }); // 540 span − 60 break = 480
  return accrueToil(ctx, { employmentId, workedDate, approvedOn });
}

async function replacementTypeId(): Promise<string> {
  const [row] = await owner.db
    .select({ id: schema.leaveType.id })
    .from(schema.leaveType)
    .where(and(eq(schema.leaveType.tenantId, b.tenantId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return row.id;
}

async function replacementBalance(employmentId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
}

/** Every register row for this employee, oldest expiry first — the FIFO order consumption walks. */
async function lots(employmentId: string) {
  return owner.db
    .select()
    .from(schema.toilAccrual)
    .where(eq(schema.toilAccrual.employmentId, employmentId))
    .orderBy(asc(schema.toilAccrual.expiresOn), asc(schema.toilAccrual.workedDate));
}

/** Submit + approve a REPLACEMENT leave spanning [start, end]; returns the request id. */
async function takeReplacement(employmentId: string, start: string, end = start) {
  const typeId = await replacementTypeId();
  const req = await requestLeave(ctx, { employmentId, leaveTypeId: typeId, startDate: start, endDate: end });
  await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
  return req.leaveRequestId;
}

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

// ══ 1 · CANCELLATION / REVERSAL — the real build ═════════════════════════════════════════════════════

describe('r279 · cancelling an approved replacement leave gives the CREDIT back, not just the day', () => {
  it('adminCancelLeave restores the lot: days_taken back to 0, taken → active, takenByRequestId released', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { accrualId } = await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    expect(await replacementBalance(e.employmentId)).toBe(1);

    const reqId = await takeReplacement(e.employmentId, nextWeekday(10));
    const spent = (await lots(e.employmentId))[0];
    expect(spent.status, 'the approval must really have consumed it, or the restore proves nothing').toBe('taken');
    expect(spent.takenByRequestId).toBe(reqId);
    expect(Number(spent.daysTaken)).toBe(1);
    expect(await replacementBalance(e.employmentId)).toBe(0);

    await adminCancelLeave(ctx, { leaveRequestId: reqId, reason: 'operational' });

    const back = (await lots(e.employmentId))[0];
    expect(back.status).toBe('active');
    expect(Number(back.daysTaken)).toBe(0);
    expect(back.takenByRequestId, 'the link to the cancelled request must be released').toBeNull();
    // The LEDGER and the REGISTER agree again — which is the whole point. A ledger-only restore would
    // read 1 here with a register that still says the credit was spent.
    expect(await replacementBalance(e.employmentId)).toBe(1);
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.restored');
  });

  it('restores in REVERSE FIFO — the lot given back is the one with the most life left', async () => {
    // Two credits: one expiring sooner (worked earlier, approved earlier), one later. Consumption takes
    // the SOONER one first (FIFO by expiry); a reversal must therefore give the SOONER one back last.
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { expiryDays: 120 }));
    await earnRestDayCredit(e.employmentId, day(-40), new Date(`${day(-40)}T02:00:00Z`)); // expires first
    await earnRestDayCredit(e.employmentId, day(-20), new Date(`${day(-20)}T02:00:00Z`)); // expires later
    expect(await replacementBalance(e.employmentId)).toBe(2);

    // Take 2 working days ⇒ both lots consumed, earliest-expiry first.
    const start = nextWeekday(10);
    const end = nextWeekday(11);
    const reqId = await takeReplacement(e.employmentId, start, end);
    expect((await lots(e.employmentId)).map((l) => l.status)).toEqual(['taken', 'taken']);

    // Give back ONE day. Reverse FIFO ⇒ the LATER-expiring lot comes back; the sooner one stays spent.
    const [cancelDate] = [start];
    const gb = await requestLeaveCancellation(e.self, { leaveRequestId: reqId, cancelDates: [cancelDate] });
    await decideLeaveCancellation(ctx, { cancellationRequestId: gb.cancellationRequestId, decision: 'approved' });

    const after = await lots(e.employmentId); // ordered by expiry ASC
    expect(after[0].status, 'the EARLIEST-expiring lot stays spent').toBe('taken');
    expect(after[1].status, 'the LATEST-expiring lot is the one handed back').toBe('active');
    expect(Number(after[1].daysTaken)).toBe(0);
    expect(await replacementBalance(e.employmentId)).toBe(1);
  });

  it('REFUSES, naming the credit and its expiry date, where the lot has expired since it was spent', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { accrualId } = await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    const reqId = await takeReplacement(e.employmentId, nextWeekday(10));

    // Time passes: the credit's frozen expiry falls behind today. The expiry SWEEP is a manual admin
    // action, so "past its date" and "already swept" are routinely different states — this is the first.
    const expired = day(-3);
    await owner.db
      .update(schema.toilAccrual)
      .set({ expiresOn: expired })
      .where(eq(schema.toilAccrual.id, accrualId));

    await expect(adminCancelLeave(ctx, { leaveRequestId: reqId, reason: 'operational' })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
    await expect(adminCancelLeave(ctx, { leaveRequestId: reqId, reason: 'operational' })).rejects.toThrow(
      new RegExp(expired),
    );
    // NOT a silent partial restore: the whole transaction rolled back, so the leave is still approved and
    // the register still says the credit was spent.
    const [row] = await owner.db
      .select({ status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, reqId));
    expect(row.status).toBe('approved');
    expect((await lots(e.employmentId))[0].status).toBe('taken');
  });

  it('refuses an already-SWEPT lot too (converted_to_pay / lapsed), not only one merely past its date', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { accrualId } = await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    const reqId = await takeReplacement(e.employmentId, nextWeekday(10));
    await owner.db
      .update(schema.toilAccrual)
      .set({ status: 'converted_to_pay' })
      .where(eq(schema.toilAccrual.id, accrualId));
    await expect(adminCancelLeave(ctx, { leaveRequestId: reqId, reason: 'x' })).rejects.toThrow(/paid out/i);
  });

  it('the employee’s own give-back REQUEST refuses at ask time, not under the manager’s approval button', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const { accrualId } = await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    const reqId = await takeReplacement(e.employmentId, nextWeekday(10));
    await owner.db
      .update(schema.toilAccrual)
      .set({ expiresOn: day(-2) })
      .where(eq(schema.toilAccrual.id, accrualId));

    await expect(
      requestLeaveCancellation(e.self, { leaveRequestId: reqId, cancelDates: [nextWeekday(10)] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
    // …and nothing was filed, so there is no pending card for a manager to be stuck with.
    const pending = await owner.db
      .select({ id: schema.leaveCancellationRequest.id })
      .from(schema.leaveCancellationRequest)
      .where(eq(schema.leaveCancellationRequest.leaveRequestId, reqId));
    expect(pending).toEqual([]);
  });

  it('a GHOST credit (ledger balance, no register row) still cancels — and says so with a shortfall event', async () => {
    // The pre-0465 state: /admin/leave-config/adjustments posted a REPLACEMENT credit straight to the
    // ledger with nothing behind it. Consumption logs `toil.consumption.shortfall`; the reversal must
    // mirror it exactly — allocate what exists, log, never throw. Refusing here would make every credit
    // banked before the register existed permanently uncancellable.
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId)); // creates the REPLACEMENT type, banks nothing
    const typeId = await replacementTypeId();
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: e.employmentId,
      leaveTypeId: typeId,
      entryType: 'adjustment',
      days: '1.00',
      effectiveOn: day(-30),
    });
    expect(await lots(e.employmentId)).toEqual([]);

    const reqId = await takeReplacement(e.employmentId, nextWeekday(10));
    const out = await adminCancelLeave(ctx, { leaveRequestId: reqId, reason: 'operational' });
    expect(out.restoredDays).toBe(1);
    expect(await replacementBalance(e.employmentId), 'the ledger gave and the ledger takes back').toBe(1);
    // The bookkeeping gap is FLAGGED rather than swallowed — the mirror of toil.consumption.shortfall.
    expect(await eventTypesFor(b.tenantId, reqId)).toContain('toil.restore.shortfall');
  });

  it('a PENDING replacement leave still cancels cleanly — it never consumed the register', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    const typeId = await replacementTypeId();
    const req = await requestLeave(ctx, {
      employmentId: e.employmentId,
      leaveTypeId: typeId,
      startDate: nextWeekday(10),
      endDate: nextWeekday(10),
    });
    const out = await adminCancelLeave(ctx, { leaveRequestId: req.leaveRequestId, reason: 'x' });
    expect(out.restoredDays).toBe(0);
    expect((await lots(e.employmentId))[0].status).toBe('active');
  });
});

// ══ 2 · HR MANUAL GRANT + its reversal ═══════════════════════════════════════════════════════════════

describe('r279 · an HR manual grant writes BOTH rows', () => {
  it('mints a register row AND a ledger credit, with a frozen expiry, a FIFO position and the stated reason', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { expiryDays: 90 }));
    const granted = await grantToilCreditManually(ctx, {
      employmentId: e.employmentId,
      workedDate: day(-30),
      days: 1,
      reason: 'Worked 30 days ago, no claim was ever submitted',
      approvedOn: new Date(`${day(-1)}T02:00:00Z`),
    });
    expect(granted.daysCredited).toBe(1);

    const [lot] = await lots(e.employmentId);
    expect(lot.source).toBe('hr_manual_grant');
    expect(lot.note).toBe('Worked 30 days ago, no claim was ever submitted');
    expect(lot.status).toBe('active');
    // The expiry is FROZEN from the approval instant by the same `resolveExpiry` every other path uses —
    // which is the whole reason this goes through bankToilCreditTx instead of writing its own rows.
    expect(lot.expiresOn).toBe(day(89));
    expect(granted.expiresOn).toBe(day(89));
    // BOTH rows, and the register points INTO the ledger, never the reverse.
    expect(lot.ledgerEntryId).not.toBeNull();
    expect(await replacementBalance(e.employmentId)).toBe(1);
    const [led] = await owner.db
      .select({ entryType: schema.leaveLedger.entryType, days: schema.leaveLedger.days })
      .from(schema.leaveLedger)
      .where(eq(schema.leaveLedger.id, lot.ledgerEntryId!));
    expect(led.entryType).toBe('in_lieu_accrual');
    expect(Number(led.days)).toBe(1);
  });

  it('takes a FIFO position: a granted credit is consumed by expiry order like any other', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId, { expiryDays: 90 }));
    // A granted credit expiring SOONER than an earned one must be spent first.
    await grantToilCreditManually(ctx, {
      employmentId: e.employmentId,
      workedDate: day(-30),
      days: 1,
      reason: 'no claim submitted',
      approvedOn: new Date(`${day(-60)}T02:00:00Z`), // ⇒ expires day(30)
    });
    await earnRestDayCredit(e.employmentId, day(-20), new Date(`${day(-1)}T02:00:00Z`)); // ⇒ expires day(89)
    const before = await lots(e.employmentId);
    expect(before[0].source, 'the granted credit expires first').toBe('hr_manual_grant');

    await takeReplacement(e.employmentId, nextWeekday(10));
    const after = await lots(e.employmentId);
    expect(after[0].status).toBe('taken');
    expect(after[1].status).toBe('active');
  });

  it('is refused for a non-admin, without the module, without a reason, and for a non-positive figure', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const grant = (over: Record<string, unknown> = {}, as: SessionContext = ctx) =>
      grantToilCreditManually(as, {
        employmentId: e.employmentId,
        workedDate: day(-30),
        days: 1,
        reason: 'because',
        ...over,
      });
    await expect(grant({}, e.self)).rejects.toBeInstanceOf(ToilSweepForbiddenError);
    await expect(grant({ reason: '   ' })).rejects.toThrow(/reason is required/i);
    await expect(grant({ days: 0 })).rejects.toThrow(/positive number of days/i);
    await setModule(b.tenantId, 'toil', null);
    await expect(grant({}, await entitledCtx(b))).rejects.toBeInstanceOf(ToilDisabledError);
  });

  it('does NOT override the First-Schedule floor — an HR power is not a way around a statutory one', async () => {
    // At or below the wage ceiling an employee is entitled to overtime CASH. HR granting time instead
    // still needs the company override AND that employee's own recorded consent.
    const e = await hire(3000);
    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: false }));
    await expect(
      grantToilCreditManually(ctx, { employmentId: e.employmentId, workedDate: day(-30), days: 1, reason: 'x' }),
    ).rejects.toBeInstanceOf(ToilNotEligibleError);

    await setToilPolicy(ctx, policy(b.companyId, { allowFirstScheduleEligible: true }));
    await expect(
      grantToilCreditManually(ctx, { employmentId: e.employmentId, workedDate: day(-30), days: 1, reason: 'x' }),
    ).rejects.toThrow(/consent/i);

    const ok = await grantToilCreditManually(ctx, {
      employmentId: e.employmentId,
      workedDate: day(-30),
      days: 1,
      reason: 'x',
      firstScheduleConsent: true,
    });
    // The floor protection travels with the credit: unused time ALWAYS converts to pay, never lapses.
    expect(ok.forcedConvertOnExpiry).toBe(true);
    expect((await lots(e.employmentId))[0].expiryAction).toBe('convert_to_pay');
  });

  it('cannot double-bank a day the register already holds', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    await expect(
      grantToilCreditManually(ctx, { employmentId: e.employmentId, workedDate: day(-30), days: 1, reason: 'x' }),
    ).rejects.toThrow(/already been banked/i);
  });
});

describe('r279 · reversing a hand-minted credit', () => {
  async function granted() {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const g = await grantToilCreditManually(ctx, {
      employmentId: e.employmentId,
      workedDate: day(-30),
      days: 1,
      reason: 'granted in error',
    });
    return { e, accrualId: g.accrualId };
  }

  it('removes the register row, nets the ledger to zero, and keeps the audit', async () => {
    const { e, accrualId } = await granted();
    expect(await replacementBalance(e.employmentId)).toBe(1);

    const out = await reverseToilCredit(ctx, { accrualId, reason: 'granted to the wrong person' });
    expect(out.daysReversed).toBe(1);
    expect(await lots(e.employmentId), 'the row is REMOVED — "reversed" would leave the day unpayable').toEqual([]);
    expect(await replacementBalance(e.employmentId)).toBe(0);
    // domain_event has UPDATE/DELETE REVOKEd from ai_hr_app, so the audit outlives the row it describes.
    const types = await eventTypesFor(b.tenantId, accrualId);
    expect(types).toContain('toil.accrued');
    expect(types).toContain('toil.grant.reversed');
  });

  it('refuses an EARNED credit — those are settled through the expiry run, never removed', async () => {
    const e = await hire();
    await setToilPolicy(ctx, policy(b.companyId));
    const earned = await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
    await expect(reverseToilCredit(ctx, { accrualId: earned.accrualId, reason: 'x' })).rejects.toBeInstanceOf(
      ToilCreditReversalNotAllowedError,
    );
    await expect(reverseToilCredit(ctx, { accrualId: earned.accrualId, reason: 'x' })).rejects.toThrow(
      /granted by hand/i,
    );
  });

  it('refuses a credit that has been used at all, and one that is no longer active', async () => {
    const { e, accrualId } = await granted();
    await owner.db
      .update(schema.toilAccrual)
      .set({ daysTaken: '0.50' })
      .where(eq(schema.toilAccrual.id, accrualId));
    await expect(reverseToilCredit(ctx, { accrualId, reason: 'x' })).rejects.toThrow(/partly used/i);

    await owner.db
      .update(schema.toilAccrual)
      .set({ daysTaken: '0', status: 'lapsed' })
      .where(eq(schema.toilAccrual.id, accrualId));
    await expect(reverseToilCredit(ctx, { accrualId, reason: 'x' })).rejects.toThrow(/expired/i);
    expect((await lots(e.employmentId)).length, 'nothing was removed by a refused reversal').toBe(1);
  });

  it('is admin-only and needs a stated reason', async () => {
    const { e, accrualId } = await granted();
    await expect(reverseToilCredit(e.self, { accrualId, reason: 'x' })).rejects.toBeInstanceOf(
      ToilSweepForbiddenError,
    );
    await expect(reverseToilCredit(ctx, { accrualId, reason: '  ' })).rejects.toThrow(/reason is required/i);
  });
});

// ══ 3 · toil_policy.replacement_leave_from, wired ════════════════════════════════════════════════════

describe('r279 · replacement_leave_from decides which days may earn', () => {
  it('the resolver: the default and every absent policy reproduce today’s rest-day/holiday pair', () => {
    expect([...eligibleDayTypesFor('overtime')].sort()).toEqual(['holiday', 'rest_day']);
    expect([...eligibleDayTypesFor(null)].sort()).toEqual(['holiday', 'rest_day']);
    expect([...eligibleDayTypesFor(undefined)].sort()).toEqual(['holiday', 'rest_day']);
    expect([...eligibleDayTypesFor('working_hours')].sort()).toEqual(['holiday', 'rest_day']);
    expect([...eligibleDayTypesFor('working_hours_and_overtime')].sort()).toEqual([
      'holiday',
      'rest_day',
      'workday',
    ]);
  });

  it('a plain WORKDAY’s overtime is refused under the default, and banked under working_hours_and_overtime', async () => {
    const e = await hire();
    // A Monday with overtime: clock in on the shift and stay late. No setRestDay ⇒ dayType 'workday'.
    const worked = nextWeekday(-10);
    await checkIn(ctx, { employmentId: e.employmentId, date: worked, time: '09:00:00' });
    await checkOut(ctx, { employmentId: e.employmentId, date: worked, time: '20:00:00' });
    const [att] = await owner.db
      .select({ dayType: schema.attendance.dayType, ot: schema.attendance.otMinutes })
      .from(schema.attendance)
      .where(
        and(
          eq(schema.attendance.employmentId, e.employmentId),
          eq(schema.attendance.attendanceDate, worked),
        ),
      );
    expect(att.dayType, 'the fixture must really be a workday, or this proves nothing').toBe('workday');
    expect(Number(att.ot)).toBeGreaterThan(0);

    // DEFAULT ('overtime'): refused, exactly as before this round.
    await setToilPolicy(ctx, policy(b.companyId));
    await expect(accrueToil(ctx, { employmentId: e.employmentId, workedDate: worked })).rejects.toBeInstanceOf(
      ToilNotEligibleError,
    );
    // …and the refusal now names the setting that would admit it.
    await expect(accrueToil(ctx, { employmentId: e.employmentId, workedDate: worked })).rejects.toThrow(
      /Working hours plus overtime/i,
    );

    // OPT IN: the one widening the setting buys.
    await setToilPolicy(ctx, policy(b.companyId, { replacementLeaveFrom: 'working_hours_and_overtime' }));
    const r = await accrueToil(ctx, { employmentId: e.employmentId, workedDate: worked });
    expect(r.daysCredited).toBeGreaterThan(0);
    expect((await lots(e.employmentId))[0].dayType).toBe('workday');
  });

  it('a REST DAY still banks under every one of the three values — nothing narrows', async () => {
    for (const from of ['overtime', 'working_hours', 'working_hours_and_overtime'] as const) {
      const e = await hire();
      await setToilPolicy(ctx, policy(b.companyId, { replacementLeaveFrom: from }));
      const r = await earnRestDayCredit(e.employmentId, day(-30), new Date(`${day(-28)}T02:00:00Z`));
      expect(r.daysCredited, `rest day must bank under ${from}`).toBe(1);
    }
  });
});
