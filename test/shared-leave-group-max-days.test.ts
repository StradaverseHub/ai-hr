/**
 * Shared Leave Group — the PER-APPLICATION day cap (r82a, feedback 1ef1cf95, migration 0327).
 *
 * The reporter's rule has two halves and they are NOT the same rule:
 *
 *   "Seven leave types — CGL, CPL, NDL, EXM, GD, MRL, STD — share one combined 10-day annual entitlement,
 *    AND each application is capped at 3 consecutive days regardless of which type is chosen.
 *    Marriage 3 approved + Compassionate 2 + Examination 3 = 8 of 10 used, leaving 2 for any of the seven."
 *
 * The shared 10-day pool already shipped (migration 0220, covered by test/combined-leave-limit.test.ts —
 * nothing here re-tests it). What 0327 adds is the second half, and the point of this file is that the two
 * halves refuse DIFFERENTLY:
 *
 *   - a 3-day application when only 2 pool days remain  → CombinedLeaveLimitExceededError  ("year spent")
 *   - a 4-day application with the whole 10 days intact → CombinedLeaveApplicationTooLongError ("too long")
 *
 * An employee told the wrong one would fix the wrong thing about their application, so both are asserted BY
 * CLASS and by payload, and each is asserted NOT to be the other. `rejects.toThrow()` alone is not enough:
 * it passes on any throw, including the other refusal.
 *
 * UNITS. "Consecutive days" is read as CALENDAR days spanned by the application, as the approved plan
 * states. The Friday→Monday test below is the one that pins it: 2 working days, 4 calendar days, refused by
 * a cap of 3. If the reporter comes back and says working days, that test is the one that flips, and
 * applicationSpanDays() in core/leave.ts is the only production code that moves.
 *
 * Harness notes follow test/combined-leave-limit.test.ts: requests and approvals run as adminCtx (the cap is
 * a data rule with no admin bypass), and leave types are allowNegativeBalance so the balance gates stay out
 * of the way of the cap under test.
 *
 * 6e9a126e RELEASE THREE — the fixtures used to create a benefit_scheme and pin the employee to it, from
 * back when a shared group was owned by a scheme. r88/1ef1cf95 already moved groups to TENANT level and
 * nothing here has read the scheme since; migration 0405 drops the table, so those lines went. Every
 * assertion below is untouched: the per-application cap and the pool total both resolve from
 * leave_shared_group / leave_shared_group_member, which is what these cases always measured.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  decideLeave,
  CombinedLeaveLimitExceededError,
  CombinedLeaveApplicationTooLongError,
} from '../core/leave';
// r88/1ef1cf95 — shared groups are no longer owned by a benefit scheme, so their CRUD moved out of
// core/benefit-scheme.ts into its own tenant-level module.
import {
  createLeaveSharedGroup,
  updateLeaveSharedGroup,
  listLeaveSharedGroups,
} from '../core/leave-shared-group';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

function uniq(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8).toUpperCase()}`;
}

/** A leave type in the reporter's shape: calendar-counted (1 calendar day == 1 leave day, so the pool
 *  arithmetic in the worked example is the arithmetic the reader expects) and negative-balance-allowed so
 *  the submit-time balance gate never stands in for the cap. */
async function leaveType(label: string, counting: 'calendar_days' | 'working_days' = 'calendar_days'): Promise<string> {
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

/** The reporter's own configuration: an employee and their SEVEN special-leave types. Named after the
 *  codes in the request (Caregiver, Compassionate, Natural Disaster, Examination, Graduation, Marriage,
 *  Study) so the worked example below reads the way they wrote it. */
async function fixture() {
  const ctx = adminCtx(b);
  const types = {
    CGL: await leaveType('CGL'),
    CPL: await leaveType('CPL'),
    NDL: await leaveType('NDL'),
    EXM: await leaveType('EXM'),
    GD: await leaveType('GD'),
    MRL: await leaveType('MRL'),
    STD: await leaveType('STD'),
  };
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Special', primaryEmail: `special_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  for (const id of Object.values(types)) await grant(emp.employmentId, id, 50);
  return { ctx, types, employmentId: emp.employmentId };
}

/** The Special Leave Group exactly as the plan describes it: the seven types, 10 days a year, 3 per
 *  application. `maxDaysPerApplication: null` gives the same group WITHOUT the new cap — i.e. every group
 *  that exists in a database today. */
async function specialLeaveGroup(
  ctx: Awaited<ReturnType<typeof fixture>>['ctx'],
  types: Record<string, string>,
  maxDaysPerApplication: number | null,
) {
  return createLeaveSharedGroup(ctx, {
    name: 'Special Leave Group',
    totalLimitDays: 10,
    maxDaysPerApplication,
    leaveTypeIds: Object.values(types),
  });
}

// All spans sit in one calendar year — the pool's cycle window. 2026-06-01 is a Monday.
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

describe("1ef1cf95 · the reporter's worked example, end to end", () => {
  it('Marriage 3 approved + Compassionate 2 + Examination 3 = 8 of 10, leaving 2 for any of the seven', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);

    // Marriage 3 — APPROVED, so the pool is charged through the approval path as well as the submit one.
    const mrl = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: types.MRL,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: TODAY,
    });
    await decideLeave(ctx, { leaveRequestId: mrl.leaveRequestId, decision: 'approved' });
    // Compassionate 2, Examination 3 — pending counts against the pool the same as approved.
    await requestLeave(ctx, { employmentId, leaveTypeId: types.CPL, startDate: '2026-07-06', endDate: '2026-07-07', today: TODAY });
    await requestLeave(ctx, { employmentId, leaveTypeId: types.EXM, startDate: '2026-08-03', endDate: '2026-08-05', today: TODAY });

    // 8 of 10 used. The remaining 2 are available to ANY of the seven — here, Caregiver.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.CGL, startDate: '2026-09-07', endDate: '2026-09-08', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('REFUSAL 1 (the pool): a 4th application for 3 days is refused because only 2 days remain', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);
    const mrl = await requestLeave(ctx, { employmentId, leaveTypeId: types.MRL, startDate: '2026-06-01', endDate: '2026-06-03', today: TODAY });
    await decideLeave(ctx, { leaveRequestId: mrl.leaveRequestId, decision: 'approved' });
    await requestLeave(ctx, { employmentId, leaveTypeId: types.CPL, startDate: '2026-07-06', endDate: '2026-07-07', today: TODAY });
    await requestLeave(ctx, { employmentId, leaveTypeId: types.EXM, startDate: '2026-08-03', endDate: '2026-08-05', today: TODAY });

    // 3 calendar days is WITHIN the 3-day per-application cap, so the cap has nothing to say. What refuses
    // it is the pool: 8 + 3 = 11 > 10.
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId: types.GD, startDate: '2026-09-07', endDate: '2026-09-09', today: TODAY });
    await expect(attempt()).rejects.toThrow(CombinedLeaveLimitExceededError);
    await expect(attempt()).rejects.toMatchObject({
      name: 'CombinedLeaveLimitExceededError',
      poolName: 'Special Leave Group',
      totalLimitDays: 10,
    });
    // …and it is NOT the other refusal. Both are thrown from the same guard; only the class distinguishes
    // "your year is spent" from "this application is too long".
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveApplicationTooLongError);
  });

  it('REFUSAL 2 (the cap): a single 4-day application is refused with all 10 pool days available', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);

    // Nothing has been taken: the entire 10-day pool is free. The application is still refused, because
    // 4 calendar days exceeds the group's 3-days-per-application cap.
    const attempt = () =>
      requestLeave(ctx, { employmentId, leaveTypeId: types.STD, startDate: '2026-06-01', endDate: '2026-06-04', today: TODAY });
    await expect(attempt()).rejects.toThrow(CombinedLeaveApplicationTooLongError);
    await expect(attempt()).rejects.toMatchObject({
      name: 'CombinedLeaveApplicationTooLongError',
      poolName: 'Special Leave Group',
      maxDaysPerApplication: 3,
      requestedSpanDays: 4,
    });
    await expect(attempt()).rejects.not.toBeInstanceOf(CombinedLeaveLimitExceededError);

    // Proof the pool really was untouched — the same type, one day shorter, goes straight through.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.STD, startDate: '2026-06-01', endDate: '2026-06-03', today: TODAY }),
    ).resolves.toBeTruthy();
  });

  it('the cap applies to every member type, not just the one it was set from', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);
    for (const [label, id] of Object.entries(types)) {
      await expect(
        requestLeave(ctx, { employmentId, leaveTypeId: id, startDate: '2026-06-01', endDate: '2026-06-04', today: TODAY }),
        `4 days of ${label} must be refused by the cap`,
      ).rejects.toThrow(CombinedLeaveApplicationTooLongError);
    }
  });
});

describe('1ef1cf95 · the cap measures CALENDAR days (the documented reading of "consecutive")', () => {
  it('exactly at the cap passes; one day over is refused (boundary)', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.NDL, startDate: '2026-06-01', endDate: '2026-06-03', today: TODAY }),
    ).resolves.toBeTruthy();
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.CGL, startDate: '2026-07-06', endDate: '2026-07-09', today: TODAY }),
    ).rejects.toThrow(CombinedLeaveApplicationTooLongError);
  });

  it('Friday→Monday is FOUR days to the cap even though it charges two working days', async () => {
    // THE test that pins the interpretation. 2026-06-05 Fri … 2026-06-08 Mon: a working_days leave type
    // charges 2 days (the weekend is free), but the application still SPANS 4 calendar days, and the plan
    // says the cap counts calendar days. If the reporter meant working days, this assertion is the one that
    // flips — and applicationSpanDays() in core/leave.ts is the only production code that changes with it.
    const ctx = adminCtx(b);
    const wdA = await leaveType('WDA', 'working_days');
    const wdB = await leaveType('WDB', 'working_days');
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Weekend', primaryEmail: `weekend_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    await grant(emp.employmentId, wdA, 50);
    await grant(emp.employmentId, wdB, 50);
    await createLeaveSharedGroup(ctx, {
      name: 'Weekend group',
      totalLimitDays: 10,
      maxDaysPerApplication: 3,
      leaveTypeIds: [wdA, wdB],
    });
    await expect(
      requestLeave(ctx, { employmentId: emp.employmentId, leaveTypeId: wdA, startDate: '2026-06-05', endDate: '2026-06-08', today: TODAY }),
    ).rejects.toMatchObject({ name: 'CombinedLeaveApplicationTooLongError', requestedSpanDays: 4 });
  });
});

describe('1ef1cf95 · a group with no cap behaves exactly as it did before 0327', () => {
  it('a null cap lets a long application through, and the shared pool still refuses an over-total one', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, null);
    // 6 days in ONE application — refused outright by a 3-day cap, but this group sets none.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.MRL, startDate: '2026-06-01', endDate: '2026-06-06', today: TODAY }),
    ).resolves.toBeTruthy();
    // The shared 10-day total is untouched by 0327 and still fires: 6 + 5 = 11 > 10.
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.CPL, startDate: '2026-07-06', endDate: '2026-07-10', today: TODAY }),
    ).rejects.toThrow(CombinedLeaveLimitExceededError);
  });

  it('a leave type in NO group is never capped', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);
    const outsider = await leaveType('OUT');
    await grant(employmentId, outsider, 50);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: outsider, startDate: '2026-06-01', endDate: '2026-06-10', today: TODAY }),
    ).resolves.toBeTruthy();
  });
});

describe('1ef1cf95 · the cap is enforced on the APPROVAL path too', () => {
  it('a cap introduced after submission blocks the approval instead of letting it through', async () => {
    const { ctx, types, employmentId } = await fixture();
    const pool = await specialLeaveGroup(ctx, types, null);
    // Submitted while the group had no cap — 4 days, accepted.
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: types.EXM,
      startDate: '2026-06-01',
      endDate: '2026-06-04',
      today: TODAY,
    });
    // HR then sets the 3-day cap. The pending 4-day request must not sail through approval.
    await updateLeaveSharedGroup(ctx, {
      id: pool.id,
      name: 'Special Leave Group',
      totalLimitDays: 10,
      maxDaysPerApplication: 3,
      leaveTypeIds: Object.values(types),
    });
    await expect(
      decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' }),
    ).rejects.toMatchObject({ name: 'CombinedLeaveApplicationTooLongError', maxDaysPerApplication: 3, requestedSpanDays: 4 });
  });

  it('an application within the cap still approves (the approval check is not a blanket refusal)', async () => {
    const { ctx, types, employmentId } = await fixture();
    await specialLeaveGroup(ctx, types, 3);
    const req = await requestLeave(ctx, {
      employmentId,
      leaveTypeId: types.EXM,
      startDate: '2026-06-01',
      endDate: '2026-06-03',
      today: TODAY,
    });
    await expect(
      decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' }),
    ).resolves.toMatchObject({ status: 'approved' });
  });
});

describe('1ef1cf95 · configuring the cap', () => {
  it('create → list round-trips the cap; it is null when never set', async () => {
    const { ctx, types } = await fixture();
    await specialLeaveGroup(ctx, types, 3);
    const [row] = await listLeaveSharedGroups(ctx);
    expect(row).toMatchObject({ name: 'Special Leave Group', totalLimitDays: 10, maxDaysPerApplication: 3 });
  });

  it('update sets and CLEARS the cap (it is an absolute set, not a patch)', async () => {
    const { ctx, types } = await fixture();
    const pool = await specialLeaveGroup(ctx, types, null);
    const ids = Object.values(types);
    let [row] = await listLeaveSharedGroups(ctx);
    expect(row.maxDaysPerApplication).toBeNull();
    await updateLeaveSharedGroup(ctx, { id: pool.id, name: 'Special Leave Group', totalLimitDays: 10, maxDaysPerApplication: 3, leaveTypeIds: ids });
    [row] = await listLeaveSharedGroups(ctx);
    expect(row.maxDaysPerApplication).toBe(3);
    // Omitting the field CLEARS it — the reason every form that posts this action carries it.
    await updateLeaveSharedGroup(ctx, { id: pool.id, name: 'Special Leave Group', totalLimitDays: 10, leaveTypeIds: ids });
    [row] = await listLeaveSharedGroups(ctx);
    expect(row.maxDaysPerApplication).toBeNull();
  });

  // r88/1ef1cf95 — was "the drag/button create path (groupSchemeLeaveTypes) carries the cap too".
  // That second create path is GONE: groups moved off benefit schemes, and with them the drag-to-group
  // entrypoint. The assertion's real subject was "EVERY way of creating a group carries the cap", and
  // the way to keep that honest now is to pin that there is exactly ONE creator — so there is no second
  // path that could forget. Kept rather than deleted, because "only one way in" is the stronger claim.
  it('there is exactly ONE create path, and it carries the cap', async () => {
    const { ctx, types, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Grouped in the UI',
      totalLimitDays: 10,
      maxDaysPerApplication: 3,
      leaveTypeIds: [types.MRL, types.CPL],
    });
    const [row] = await listLeaveSharedGroups(ctx);
    expect(row.maxDaysPerApplication).toBe(3);
    await expect(
      requestLeave(ctx, { employmentId, leaveTypeId: types.MRL, startDate: '2026-06-01', endDate: '2026-06-04', today: TODAY }),
    ).rejects.toThrow(CombinedLeaveApplicationTooLongError);

    // No surviving second creator: core/leave-shared-group.ts is the only module that inserts a group,
    // and core/benefit-scheme.ts must not have grown one back.
    const schemeSrc = readFileSync(new URL('../core/benefit-scheme.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(schemeSrc).not.toMatch(/insert\(\s*leaveSharedGroup\s*\)/);
  });

  it('rejects a zero, negative or absurd cap rather than storing a group nobody can apply to', async () => {
    const { ctx, types } = await fixture();
    const ids = Object.values(types);
    for (const bad of [0, -1]) {
      await expect(
        createLeaveSharedGroup(ctx, { name: 'Bad', totalLimitDays: 10, maxDaysPerApplication: bad, leaveTypeIds: ids }),
      ).rejects.toThrow(/greater than zero/i);
    }
    await expect(
      createLeaveSharedGroup(ctx, { name: 'Huge', totalLimitDays: 10, maxDaysPerApplication: 1000, leaveTypeIds: ids }),
    ).rejects.toThrow(/too large/i);
  });

  it('the DB refuses a non-positive cap even when the validator is bypassed (the CHECK carried forward into 0342)', async () => {
    // Defence in depth: the named CHECK is the guarantee an importer or a hand-written UPDATE cannot store
    // a cap that would refuse every application. Asserted through the driver error, not the ORM wrapper.
    const { ctx, types } = await fixture();
    const pool = await specialLeaveGroup(ctx, types, 3);
    const attempt = owner.db.execute(
      sql`update leave_shared_group set max_days_per_application = 0 where id = ${pool.id}`,
    );
    // Drizzle wraps the driver error (DrizzleQueryError), so the SQLSTATE and the constraint name live on
    // `.cause` — asserting on the wrapper would pass on ANY failed query, including a typo in the SQL above.
    await expect(attempt).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'leave_shared_group_max_days_check' },
    });
  });
});
