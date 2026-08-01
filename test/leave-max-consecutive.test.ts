/**
 * Maximum Consecutive Leave, per leave type (feedback c6ffa725 REVISION 2, migration 0343).
 *
 * WHY THERE IS A REVISION 2. c6ffa725 asked for TWO limits and r86a shipped one. What shipped is
 * `leave_type.max_days_per_leave_year` — "how much of this type in a YEAR" — and the reporter was told the
 * item was done. What did not ship is this: "Maximum Consecutive Leave", the limit on ONE application, with
 * the Unlimited / Limited choice and the Calendar Days / Working Days unit. The reporter came back and said
 * so, correctly. test/leave-application-limit.test.ts covers the year half; nothing here re-tests it.
 *
 * WHAT IS ASSERTED HERE
 *   §1  Unlimited is the state of every leave type today, and it refuses nothing.
 *   §2  Calendar Days: the span, weekends and holidays counted. Boundary pinned (at the cap passes, one
 *       over is refused).
 *   §3  Working Days: only the days actually charged. THE SAME Friday→Monday application is 4 to a calendar
 *       cap and 2 to a working one — the whole reason the reporter asked for the unit.
 *   §4  Enforced at BOTH submission and approval. Either alone is bypassable: a cap set or tightened after
 *       an application is filed must not be approvable through.
 *   §5  THE COMPOSITION with the Shared Leave Group's own per-application cap. Two caps may apply to one
 *       application; the STRICTER binds, it is resolved in one place, and the refusal NAMES which one. Both
 *       refusals asserted BY CLASS AND PAYLOAD, and each asserted NOT to be the other — an employee told
 *       the wrong limit goes and changes the wrong screen. A bare rejects.toThrow() passes on any throw and
 *       this repo has been bitten by exactly that.
 *   §6  bindingApplicationLengthLimit as a pure function: MIN in the same unit, smallest-slack across
 *       units, and the tie-break.
 *   §7  The pair is all-or-nothing, and the year limit is untouched.
 *
 * Harness notes follow test/shared-leave-group-max-days.test.ts: requests and approvals run as adminCtx
 * (the cap is a data rule with no admin bypass) and leave types are allowNegativeBalance so the submit-time
 * balance gate never stands in for the cap under test.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  decideLeave,
  bindingApplicationLengthLimit,
  LeaveTypeApplicationTooLongError,
  LeaveYearApplicationLimitExceededError,
  CombinedLeaveApplicationTooLongError,
  CombinedLeaveLimitExceededError,
  type ApplicationLengthLimit,
} from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { createLeaveSharedGroup } from '../core/leave-shared-group';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** A leave type with the given counting mode, negative-balance-allowed so the submit-time balance gate
 *  never stands in for the cap under test. `counting` is what makes §3 different from §2. */
async function leaveTypeOf(label: string, counting: 'calendar_days' | 'working_days'): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq(label),
      name: `${label} ${randomUUID().slice(0, 4)}`,
      paid: true,
      counting,
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function nameOf(leaveTypeId: string): Promise<string> {
  const [row] = await owner.db
    .select({ name: schema.leaveType.name })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, leaveTypeId))
    .limit(1);
  return row!.name;
}

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

/** Set (or clear) the cap through the REAL writer, so the tri-state marker and the validator are exercised
 *  rather than an UPDATE that bypasses both. */
async function setCap(
  ctx: ReturnType<typeof adminCtx>,
  leaveTypeId: string,
  maxConsecutiveDays: number | null,
  maxConsecutiveUnit: 'calendar_days' | 'working_days' | null,
) {
  await updateLeaveType(ctx, {
    id: leaveTypeId,
    name: await nameOf(leaveTypeId),
    maxConsecutiveDays,
    maxConsecutiveUnit,
  });
}

async function fixture(counting: 'calendar_days' | 'working_days' = 'calendar_days', grantDays = 50) {
  const ctx = adminCtx(b);
  const leaveTypeId = await leaveTypeOf('MCL', counting);
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Consecutive', primaryEmail: `mcl_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  if (grantDays > 0) await grant(emp.employmentId, leaveTypeId, grantDays);
  return { ctx, leaveTypeId, employmentId: emp.employmentId };
}

// 2026-06-01 is a Monday; 2026-06-05 is a Friday and 2026-06-08 the Monday after it.
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

describe('§1 Unlimited is what every leave type means today', () => {
  it('a brand-new leave type stores NULL for BOTH columns and refuses nothing', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    const [row] = await owner.db
      .select({ days: schema.leaveType.maxConsecutiveDays, unit: schema.leaveType.maxConsecutiveUnit })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId))
      .limit(1);
    expect(row!.days).toBeNull();
    expect(row!.unit).toBeNull();

    // Ten days in one application, with no cap anywhere. This is the section that says the release changes
    // nobody's leave on deploy day.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-10', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('setting a cap and clearing it again returns the type to Unlimited', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-05', today: TODAY }),
    ).rejects.toThrow(LeaveTypeApplicationTooLongError);
    // Unlimited posts an empty maximum, which clears BOTH columns.
    await setCap(ctx, leaveTypeId, null, null);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-07-06', endDate: '2026-07-10', today: TODAY }),
    ).resolves.toBeTruthy();
  });
});

describe('§2 Calendar Days counts every day the application spans', () => {
  it('exactly at the cap passes; one day over is refused, by class AND payload', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');

    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-03', today: TODAY }),
    ).resolves.toBeTruthy();

    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-07-06', endDate: '2026-07-09', today: TODAY });
    await expect(attempt()).rejects.toThrow(LeaveTypeApplicationTooLongError);
    await expect(attempt()).rejects.toMatchObject({
      name: 'LeaveTypeApplicationTooLongError',
      leaveTypeName: await nameOf(leaveTypeId),
      maxConsecutiveDays: 3,
      unit: 'calendar_days',
      requestedSpanDays: 4,
    });
    // NOT the shared-group refusal: there is no group here at all, and the employee must be sent to the
    // leave type's own configuration rather than to a group that is not refusing them.
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveApplicationTooLongError);
    await expect(attempt()).rejects.not.toBeInstanceOf(LeaveYearApplicationLimitExceededError);
  });

  it('a weekend inside the span still counts — that is what "calendar" means', async () => {
    // Friday → Monday on a CALENDAR-counted type: 4 days charged and 4 days spanned. A 3-day calendar cap
    // refuses it.
    const { ctx, leaveTypeId, employmentId } = await fixture('calendar_days');
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-05', endDate: '2026-06-08', today: TODAY }),
    ).rejects.toMatchObject({ name: 'LeaveTypeApplicationTooLongError', requestedSpanDays: 4 });
  });
});

describe('§3 Working Days counts only the days actually charged', () => {
  it('THE test the reporter asked for: Friday→Monday is 2 working days, not 4', async () => {
    // A working-days type charges 2 for Fri→Mon (the weekend is free). Under a 3-day WORKING cap that is
    // permitted; under a 3-day CALENDAR cap the identical application is refused. The same number, two
    // rules — which is exactly why the unit had to be a choice.
    const { ctx, leaveTypeId, employmentId } = await fixture('working_days');
    await setCap(ctx, leaveTypeId, 3, 'working_days');
    const ok = await requestLeave(ctx, {
      employmentId,
      leaveTypeId,
      startDate: '2026-06-05',
      endDate: '2026-06-08',
      today: TODAY,
    });
    // Pin the assumption the whole section rests on rather than trusting it: this really is a 2-day charge
    // over a 4-day span.
    expect(ok.days).toBe(2);

    // Same type, same dates, cap re-read as calendar days ⇒ refused at 4.
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-07-03', endDate: '2026-07-06', today: TODAY }),
    ).rejects.toMatchObject({
      name: 'LeaveTypeApplicationTooLongError',
      unit: 'calendar_days',
      requestedSpanDays: 4,
    });
  });

  it('a working-days cap still refuses when the CHARGED days exceed it', async () => {
    // Not a cap that never fires: Mon→Fri charges 5 working days and a 3-day working cap refuses it. The
    // payload reports the charged figure, not the span (both are 5 here only because no weekend is
    // involved — the test above is the one that separates them).
    const { ctx, leaveTypeId, employmentId } = await fixture('working_days');
    await setCap(ctx, leaveTypeId, 3, 'working_days');
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-05', today: TODAY }),
    ).rejects.toMatchObject({
      name: 'LeaveTypeApplicationTooLongError',
      unit: 'working_days',
      maxConsecutiveDays: 3,
      requestedSpanDays: 5,
    });
  });
});

describe('§4 enforced at BOTH submission and approval', () => {
  it('a cap SET AFTER an application was filed refuses it at approval', async () => {
    // The bypass this section exists to close: submit under no cap, then have it approved after HR sets
    // one. A submit-only check would let the whole pending backlog through.
    const { ctx, leaveTypeId, employmentId } = await fixture();
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId,
      startDate: '2026-06-01',
      endDate: '2026-06-05',
      today: TODAY,
    });
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    const attempt = () => decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    await expect(attempt()).rejects.toThrow(LeaveTypeApplicationTooLongError);
    await expect(attempt()).rejects.toMatchObject({ maxConsecutiveDays: 3, requestedSpanDays: 5 });
  });

  it('a request within the cap still approves', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: TODAY,
    });
    await expect(decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' })).resolves.toBeTruthy();
  });
});

describe('§5 two caps, ONE composition — the stricter binds and the refusal names it', () => {
  /** A shared group containing the type, with its own per-application cap. */
  async function group(
    ctx: ReturnType<typeof adminCtx>,
    leaveTypeId: string,
    maxDaysPerApplication: number | null,
  ): Promise<{ name: string }> {
    const name = `Special Leave Group ${randomUUID().slice(0, 6)}`;
    // A group needs at least two member types to be a SHARING mechanism at all (core/leave-shared-group.ts
    // refuses one), so a second, otherwise-unused type joins it. Nothing in this section applies for it.
    await createLeaveSharedGroup(ctx, {
      name,
      totalLimitDays: 100,
      maxDaysPerApplication,
      leaveTypeIds: [leaveTypeId, await leaveTypeOf('SIB', 'calendar_days')],
    });
    return { name };
  }

  it('the LEAVE TYPE binds when it is the stricter of the two', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await group(ctx, leaveTypeId, 5);
    await setCap(ctx, leaveTypeId, 2, 'calendar_days');

    // 4 days: inside the group's 5, outside the type's 2. The type refuses, and says so.
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-04', today: TODAY });
    await expect(attempt()).rejects.toThrow(LeaveTypeApplicationTooLongError);
    await expect(attempt()).rejects.toMatchObject({
      name: 'LeaveTypeApplicationTooLongError',
      leaveTypeName: await nameOf(leaveTypeId),
      maxConsecutiveDays: 2,
      requestedSpanDays: 4,
    });
    // NOT the group's refusal. Handing the employee "Special Leave Group allows at most 5" would send them
    // to a screen whose rule they have not broken.
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveApplicationTooLongError);
  });

  it('the SHARED GROUP binds when IT is the stricter of the two', async () => {
    const { ctx, leaveTypeId, employmentId } = await fixture();
    const g = await group(ctx, leaveTypeId, 2);
    await setCap(ctx, leaveTypeId, 5, 'calendar_days');

    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-04', today: TODAY });
    await expect(attempt()).rejects.toThrow(CombinedLeaveApplicationTooLongError);
    await expect(attempt()).rejects.toMatchObject({
      name: 'CombinedLeaveApplicationTooLongError',
      poolName: g.name,
      maxDaysPerApplication: 2,
      requestedSpanDays: 4,
    });
    // …and NOT the leave type's, which is the mirror image of the assertion above. The two refusals are
    // fixed in different screens, so which one is thrown is load-bearing information.
    await expect(attempt()).rejects.not.toBeInstanceOf(LeaveTypeApplicationTooLongError);
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveLimitExceededError);
  });

  it('a type cap can only TIGHTEN — an application inside both caps still passes', async () => {
    // The promise made in the approved plan: the stricter-wins rule can never silently increase anyone's
    // allowance. 2 days is inside the group's 5 and inside the type's 3.
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await group(ctx, leaveTypeId, 5);
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-02', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('the group cap still fires on its own for a type with no cap of its own', async () => {
    // Nothing about r90b moves the r82a rule. A member type that sets no cap is refused by the group
    // exactly as before, with the same class and the same payload.
    const { ctx, leaveTypeId, employmentId } = await fixture();
    const g = await group(ctx, leaveTypeId, 3);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-04', today: TODAY }),
    ).rejects.toMatchObject({
      name: 'CombinedLeaveApplicationTooLongError',
      poolName: g.name,
      maxDaysPerApplication: 3,
      requestedSpanDays: 4,
    });
  });
});

describe('§6 the composition itself, as a pure function', () => {
  const cal = (scope: 'leave_type' | 'shared_group', cap: number, measured: number): ApplicationLengthLimit => ({
    scope,
    name: scope,
    cap,
    unit: 'calendar_days',
    measured,
  });

  it('nothing configured, or nothing breached, binds nothing', () => {
    expect(bindingApplicationLengthLimit([])).toBeNull();
    expect(bindingApplicationLengthLimit([cal('leave_type', 5, 4), cal('shared_group', 5, 4)])).toBeNull();
    // Exactly at the cap is INSIDE it — the boundary the DB rows and §2 both use.
    expect(bindingApplicationLengthLimit([cal('leave_type', 4, 4)])).toBeNull();
  });

  it('in the same unit it is literally MIN(typeCap, groupCap)', () => {
    // Both measure the same application, so smallest-slack reduces to smallest cap — the rule stated in the
    // approved plan, and the reason this is a composition rather than two rules racing.
    expect(bindingApplicationLengthLimit([cal('leave_type', 2, 4), cal('shared_group', 3, 4)])?.scope).toBe('leave_type');
    expect(bindingApplicationLengthLimit([cal('leave_type', 3, 4), cal('shared_group', 2, 4)])?.scope).toBe(
      'shared_group',
    );
    // Only one breached ⇒ that one binds, whatever the other's number is.
    expect(bindingApplicationLengthLimit([cal('leave_type', 9, 4), cal('shared_group', 3, 4)])?.scope).toBe(
      'shared_group',
    );
  });

  it('across units it is the smallest SLACK, because bare numbers are not commensurable', () => {
    // A working-days cap of 1 against 2 charged days (slack −1) is stricter than a calendar cap of 3
    // against 4 spanned days (slack −1)… tie, so the narrower scope wins; make the type genuinely tighter
    // and it must win outright.
    const typeWorking: ApplicationLengthLimit = {
      scope: 'leave_type',
      name: 'type',
      cap: 1,
      unit: 'working_days',
      measured: 4,
    };
    expect(bindingApplicationLengthLimit([typeWorking, cal('shared_group', 3, 4)])?.scope).toBe('leave_type');
    // …and the other way round: a group cap far below its measurement outranks a barely-breached type cap.
    const typeBarely: ApplicationLengthLimit = { ...typeWorking, cap: 3, measured: 4 };
    expect(bindingApplicationLengthLimit([typeBarely, cal('shared_group', 1, 4)])?.scope).toBe('shared_group');
  });

  it('an exact tie goes to the leave type, the narrower scope', () => {
    // The employee is told about the rule attached to the type they actually chose. Deterministic: the same
    // input must never refuse with two different messages on two different days.
    const bound = bindingApplicationLengthLimit([cal('shared_group', 2, 4), cal('leave_type', 2, 4)]);
    expect(bound?.scope).toBe('leave_type');
  });
});

describe('§7 the pair is all-or-nothing, and the YEAR limit is a different rule', () => {
  it('a maximum with no unit is refused by the writer', async () => {
    const { ctx, leaveTypeId } = await fixture();
    // Asserted by MESSAGE, not by a bare rejects.toThrow(): updateLeaveType throws for a dozen reasons and
    // a bare assertion would pass on any of them.
    await expect(
      updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), maxConsecutiveDays: 3 }),
    ).rejects.toThrow(/both a maximum and a unit/);
    await expect(
      updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), maxConsecutiveUnit: 'working_days' }),
    ).rejects.toThrow(/both a maximum and a unit/);
  });

  it('a zero or negative maximum is refused — it would refuse every application of the type', async () => {
    const { ctx, leaveTypeId } = await fixture();
    await expect(
      setCap(ctx, leaveTypeId, 0, 'calendar_days'),
    ).rejects.toThrow(/greater than 0/);
  });

  it('the two limits are independent: setting one leaves the other alone', async () => {
    // The tri-state that matters. r86a's card and this one sit side by side; a shared marker would make
    // saving one silently clear the other, which is the "my setting didn't save" report this area has
    // already had twice.
    const { ctx, leaveTypeId } = await fixture();
    await updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), maxDaysPerLeaveYear: 14 });
    await setCap(ctx, leaveTypeId, 3, 'working_days');
    const [row] = await owner.db
      .select({
        year: schema.leaveType.maxDaysPerLeaveYear,
        days: schema.leaveType.maxConsecutiveDays,
        unit: schema.leaveType.maxConsecutiveUnit,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId))
      .limit(1);
    expect(Number(row!.year)).toBe(14);
    expect(Number(row!.days)).toBe(3);
    expect(row!.unit).toBe('working_days');
  });

  it('the year limit refuses with ITS OWN class, not this one', async () => {
    // "How much in a year" and "how much in one go" are different questions and must not be answered with
    // the same sentence. 3 applications of 2 days each is 6 > 5 for the year, while every one of them is
    // inside a 3-day consecutive cap.
    const { ctx, leaveTypeId, employmentId } = await fixture();
    await updateLeaveType(ctx, { id: leaveTypeId, name: await nameOf(leaveTypeId), maxDaysPerLeaveYear: 5 });
    await setCap(ctx, leaveTypeId, 3, 'calendar_days');
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-06-01', endDate: '2026-06-02', today: TODAY });
    await requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-07-06', endDate: '2026-07-07', today: TODAY });
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId, startDate: '2026-08-03', endDate: '2026-08-04', today: TODAY });
    await expect(attempt()).rejects.toThrow(LeaveYearApplicationLimitExceededError);
    await expect(attempt()).rejects.not.toBeInstanceOf(LeaveTypeApplicationTooLongError);
  });
});
