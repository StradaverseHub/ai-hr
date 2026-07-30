/**
 * Add Application Limits Configuration Under Leave Application Rules (feedback c6ffa725, migration 0335).
 *
 * THE PROBLEM THE REPORTER STATED. Entitlement and application eligibility were tightly coupled: every cap
 * on how much leave may be taken worked by checking a BALANCE. Types like Unpaid Leave and Prolonged Illness
 * Leave have no balance by design — their Leave Summary must keep reading 0 available — so a company-defined
 * ceiling on them could not be expressed at all.
 *
 * WHAT IS ASSERTED HERE
 *   §1  Unset is UNLIMITED, which is what every leave type in every existing database means. This is the
 *       section that says the release changes nobody's leave on deploy day.
 *   §2  The reporter's worked example: entitlement 0, 14-day ceiling, applications permitted up to 14 and
 *       refused past it — with the Leave Summary balance still reading 0 throughout.
 *   §3  Enforcement at BOTH submission and approval. Either alone is bypassable, and the approved plan says
 *       so: a submit-only check is walked through by anything already pending when the limit is tightened;
 *       an approval-only check lets an employee file applications that will all be refused later.
 *   §4  The refusal is its OWN class with its OWN payload, and is NOT either of the two shared-pool
 *       refusals it sits alongside. A bare `rejects.toThrow()` passes on any throw — this repo has been
 *       bitten by exactly that twice, so every refusal is asserted by class AND payload AND
 *       `not.toBeInstanceOf` its neighbours.
 *   §5  The UNITS and the WINDOW, pinned by test rather than by comment: "days per leave year" means the
 *       leave year the leave TYPE's own Leave Year Type resolves to, not a hardcoded calendar year.
 *   §6  It changes nothing about entitlement, accrual or the ledger.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  decideLeave,
  leaveYearWindow,
  LeaveYearApplicationLimitExceededError,
  CombinedLeaveLimitExceededError,
  CombinedLeaveApplicationTooLongError,
} from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** A leave type in the reporter's shape: calendar-counted so one calendar day is one leave day and the
 *  arithmetic in the worked example is the arithmetic a reader expects, and negative-balance-allowed so the
 *  submit-time BALANCE gate never stands in for the limit under test. That second flag is what makes this a
 *  type with no entitlement — exactly the Unpaid Leave case. */
async function unpaidLikeType(label = 'UPL'): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq(label),
      name: `${label} ${randomUUID().slice(0, 4)}`,
      paid: false,
      counting: 'calendar_days',
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** A plain ledger credit, mirroring test/shared-leave-group-max-days.test.ts. */
async function grant(employmentId: string, leaveTypeId: string, days: number): Promise<void> {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

/**
 * `grantDays` exists because of a PRE-EXISTING rule this item does not touch and must not be confused with:
 * `allowNegativeBalance` only relaxes the SUBMIT-time balance gate. The APPROVAL path still refuses when
 * `balance - need < 0` (InsufficientLeaveBalanceError, core/leave.ts), so a type with a genuinely empty
 * ledger can be applied for and never approved.
 *
 * That is exactly right for the reporter's Unpaid Leave case at SUBMISSION, which is what §1 and §2 test
 * with no grant at all. The sections that need an approval to actually happen (§3, §6) credit a balance
 * first, so the thing being observed is the new application ceiling and not the old balance gate standing
 * in for it. Every limit under test is far below the granted balance, so the balance never decides an
 * outcome in those sections.
 */
async function fixture(hiredOn = '2020-01-01', grantDays = 0) {
  const ctx = adminCtx(b);
  const leaveTypeId = await unpaidLikeType();
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Unpaid', primaryEmail: `unpaid_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  if (grantDays > 0) await grant(emp.employmentId, leaveTypeId, grantDays);
  return { ctx, leaveTypeId, employmentId: emp.employmentId, typeName: await nameOf(leaveTypeId) };
}

async function nameOf(leaveTypeId: string): Promise<string> {
  const [row] = await owner.db
    .select({ name: schema.leaveType.name })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, leaveTypeId))
    .limit(1);
  return row!.name;
}

/** Set (or clear) the annual application ceiling through the REAL writer, so the tri-state marker and the
 *  validator are exercised rather than an UPDATE that bypasses both. */
async function setLimit(
  ctx: Awaited<ReturnType<typeof fixture>>['ctx'],
  leaveTypeId: string,
  maxDaysPerLeaveYear: number | null,
) {
  await updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), maxDaysPerLeaveYear });
}

const TODAY = '2026-06-01';

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

describe('§1 unset means UNLIMITED — every existing leave type is untouched', () => {
  it('a brand-new leave type stores NULL and refuses nothing', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    const [row] = await owner.db
      .select({ v: schema.leaveType.maxDaysPerLeaveYear })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId))
      .limit(1);
    expect(row!.v).toBeNull();

    // 60 days in one year, in one application and across several. Nothing refuses.
    // (2026 is not a leap year — 1 Jan to 1 Mar inclusive is 31 + 28 + 1 = 60 calendar days.)
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-01-01', endDate: '2026-03-01', today: TODAY }),
    ).resolves.toBeTruthy();
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-07-01', endDate: '2026-07-31', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('a save from a NEIGHBOURING sub-form does not silently impose or clear a limit', async () => {
    const { ctx, leaveTypeId } = await fixture();
    await setLimit(ctx, leaveTypeId, 14);
    // The backdating card's save carries no applicationLimits marker.
    await updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), backdatingLimitDays: 30 });
    const [row] = await owner.db
      .select({ v: schema.leaveType.maxDaysPerLeaveYear })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId))
      .limit(1);
    expect(Number(row!.v)).toBe(14);
  });

  it('clearing the limit restores unlimited', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setLimit(ctx, leaveTypeId, 2);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-03-02', endDate: '2026-03-06', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
    await setLimit(ctx, leaveTypeId, null);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-03-02', endDate: '2026-03-06', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('a zero or negative ceiling is refused at write time — it would block every application', async () => {
    const { ctx, leaveTypeId } = await fixture();
    await expect(setLimit(ctx, leaveTypeId, 0)).rejects.toThrow(/Maximum application per leave year/);
    await expect(setLimit(ctx, leaveTypeId, -5)).rejects.toThrow(/Maximum application per leave year/);
  });
});

describe("§2 the reporter's worked example: Unpaid Leave, entitlement 0, ceiling 14", () => {
  it('the employee may apply up to 14 days and is refused at the 15th, with the balance still 0', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setLimit(ctx, leaveTypeId, 14);

    // No grant of any kind: this type has no entitlement, which is the whole premise.
    expect(await ledgerBalance(employmentId, leaveTypeId)).toBe(0);

    // 10 days, then 4 — 14 of 14 used.
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-02-02', endDate: '2026-02-11', today: TODAY });
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-04-06', endDate: '2026-04-09', today: TODAY });

    // The 15th day is refused.
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-01', today: TODAY });
    await expect(attempt()).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
    await expect(attempt()).rejects.toMatchObject({
      name: 'LeaveYearApplicationLimitExceededError',
      maxDaysPerLeaveYear: 14,
      usedDays: 14,
      requestedDays: 1,
    });

    // And the Leave Summary figure the employee sees is untouched by any of it.
    expect(await ledgerBalance(employmentId, leaveTypeId)).toBe(0);
  });

  it('REFUSAL IS TOTAL, NEVER A TRUNCATION — the application does not silently shrink to fit', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setLimit(ctx, leaveTypeId, 5);
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-02-02', endDate: '2026-02-05', today: TODAY });
    // 4 used, 1 left, 3 asked for. Clipping it to 1 day would approve dates nobody requested.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-03-02', endDate: '2026-03-04', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
    const rows = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.employmentId, employmentId));
    expect(rows.length).toBe(1); // the refused one was never written
  });

  it('PENDING counts, not just approved — a limit cannot be walked through with in-flight requests', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setLimit(ctx, leaveTypeId, 4);
    // Left pending, deliberately.
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-02-02', endDate: '2026-02-05', today: TODAY });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-03-02', endDate: '2026-03-02', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
  });
});

describe('§3 enforced at BOTH submission and approval', () => {
  it('a limit set AFTER submission stops the approval', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture('2020-01-01', 100);
    // No limit yet: a 10-day application goes in cleanly.
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-11',
      today: TODAY,
    });
    // HR then sets a 5-day ceiling. The pending request is now over it, and approving it would put the
    // employee past a limit that exists — which is precisely what an approval-time check is for.
    await setLimit(ctx, leaveTypeId, 5);
    const attempt = () => decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    await expect(attempt()).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
    await expect(attempt()).rejects.toMatchObject({ maxDaysPerLeaveYear: 5, requestedDays: 10 });
  });

  it('the request being approved is counted exactly ONCE, not twice', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture('2020-01-01', 100);
    await setLimit(ctx, leaveTypeId, 10);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-11',
      today: TODAY,
    });
    // Exactly 10 of 10. If the approval path summed the pending row AND added the request's own days again
    // it would see 20 and refuse an approval that is exactly at the ceiling.
    await expect(decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' })).resolves.toBeTruthy();
  });
});

describe('§4 a DISTINCT refusal, asserted against its neighbours', () => {
  it('carries the leave type, the limit, the usage and the leave-year window', async () => {
    const { ctx, leaveTypeId, employmentId, typeName } = await fixture();
    await setLimit(ctx, leaveTypeId, 3);
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-02-02', endDate: '2026-02-04', today: TODAY });
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-03-02', endDate: '2026-03-02', today: TODAY });
    await expect(attempt()).rejects.toMatchObject({
      name: 'LeaveYearApplicationLimitExceededError',
      leaveTypeName: typeName,
      maxDaysPerLeaveYear: 3,
      usedDays: 3,
      requestedDays: 1,
      // The window matters: "you have used 3 of 3 days" is unanswerable without knowing WHICH year.
      yearStart: '2026-01-01',
      yearEnd: '2026-12-31',
    });
  });

  it('is NOT either of the two shared-pool refusals it sits alongside', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setLimit(ctx, leaveTypeId, 1);
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-03-02', endDate: '2026-03-04', today: TODAY });
    await expect(attempt()).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
    // The shared pool caps a GROUP of types on a benefit scheme; this caps ONE type. An employee told the
    // wrong one would go and look at the wrong configuration.
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveLimitExceededError);
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveApplicationTooLongError);
  });
});

describe('§5 the window is the LEAVE YEAR, resolved from the leave type', () => {
  it('a calendar cycle runs 1 Jan to 31 Dec', () => {
    expect(leaveYearWindow('2020-03-15', '2026-06-01', 'calendar')).toEqual({
      start: '2026-01-01',
      end: '2026-12-31',
    });
    // Null / unknown cycles fall back to calendar, exactly as earnedCycleStart already does.
    expect(leaveYearWindow('2020-03-15', '2026-06-01', null)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('an anniversary cycle runs from the hire-month anniversary', () => {
    // Hired in July: as of June 2026 the CURRENT anniversary year began in July 2025.
    expect(leaveYearWindow('2020-07-15', '2026-06-01', 'anniversary')).toEqual({
      start: '2025-07-01',
      end: '2026-06-30',
    });
    // As of August 2026 it has rolled over.
    expect(leaveYearWindow('2020-07-15', '2026-08-01', 'anniversary')).toEqual({
      start: '2026-07-01',
      end: '2027-06-30',
    });
  });

  it('a 29-February window end is normalised rather than becoming an impossible date', () => {
    expect(leaveYearWindow('2020-02-10', '2024-03-01', 'anniversary')).toEqual({
      start: '2024-02-01',
      end: '2025-01-31',
    });
  });

  it('usage in a DIFFERENT leave year does not count against this one', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setLimit(ctx, leaveTypeId, 5);
    // 5 days in 2025 — the whole ceiling, but for the previous leave year.
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2025-02-03', endDate: '2025-02-07', today: '2025-01-02' });
    // 2026 starts clean.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-02-02', endDate: '2026-02-06', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it("the type's own Leave Year Type moves the window, and it is read from the TYPE not from leave_policy", async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture('2020-07-15');
    await setLimit(ctx, leaveTypeId, 5);
    await updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), yearCycleOverride: 'a2a' });

    // Anniversary year as of June 2026 is 2025-07-01 .. 2026-06-30. Spend the ceiling inside it…
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2025-09-01', endDate: '2025-09-05', today: TODAY });
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-05-04', endDate: '2026-05-04', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveYearApplicationLimitExceededError);

    // …and the NEXT anniversary year, which starts in July, is clean again. Under a hardcoded calendar
    // window this application would have been refused, because September 2025 and July 2026 are different
    // calendar years but the May 2026 one above is the same calendar year as the July 2026 one.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-07-06', endDate: '2026-07-10', today: '2026-07-01' }),
    ).resolves.toBeTruthy();
  });
});

describe('§6 it is an APPLICATION rule and touches nothing else', () => {
  it('approving inside the limit still moves the ledger exactly as before', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture('2020-01-01', 100);
    await setLimit(ctx, leaveTypeId, 14);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-04',
      today: TODAY,
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    // Three days debited from the granted 100 — the pre-existing ledger behaviour, unchanged by the
    // ceiling. If the limit had leaked into entitlement, this figure is where it would show.
    expect(await ledgerBalance(employmentId, leaveTypeId)).toBe(97);
  });

  it('setting a limit writes ONLY the limit column', async () => {
    const { ctx, leaveTypeId } = await fixture();
    const before = await owner.db
      .select({
        accrualMethod: schema.leaveType.accrualMethod,
        carryForwardMax: schema.leaveType.carryForwardMax,
        roundingMethod: schema.leaveType.roundingMethod,
        maxBalanceDays: schema.leaveType.maxBalanceDays,
        allowNegativeBalance: schema.leaveType.allowNegativeBalance,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId))
      .limit(1);
    await setLimit(ctx, leaveTypeId, 14);
    const after = await owner.db
      .select({
        accrualMethod: schema.leaveType.accrualMethod,
        carryForwardMax: schema.leaveType.carryForwardMax,
        roundingMethod: schema.leaveType.roundingMethod,
        maxBalanceDays: schema.leaveType.maxBalanceDays,
        allowNegativeBalance: schema.leaveType.allowNegativeBalance,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId))
      .limit(1);
    expect(after[0]).toEqual(before[0]);
  });
});
