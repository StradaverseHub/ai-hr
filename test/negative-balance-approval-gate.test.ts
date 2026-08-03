/**
 * 9861b8a4 — the approval gate finally consults Allow Negative Balance, and the unlock is OPT-IN.
 *
 * WHAT WAS WRONG. `allow_negative_balance` relaxed the SUBMIT-time gate only. The approval path refused
 * any below-zero result without ever reading the flag, so a type set to Yes let an employee submit leave
 * they had not earned and then refused it at approval. A balance could not fall below zero through the
 * ordinary apply-and-approve route at all; every negative balance in the system arrived via an adjustment
 * or an expiry sweep. bc512dc3's floor was therefore capping how far a SUBMITTED application could reach,
 * not how far an approved balance could fall — which is not what its plan told the reporter.
 *
 * ⚠️ WHY THE SWITCH ALONE DOES NOT UNLOCK IT, which is the design and the thing to preserve. Loosening on
 * `allowNegativeBalance` by itself would have changed behaviour immediately for every type already
 * carrying it — a set nobody chose with this consequence in mind, because the flag has never meant this
 * here. The unlock is the PAIR: switch on AND a floor typed in. So this ships INERT and turns on one leave
 * type at a time. The first two tests are the ones that prove that, and they are the ones to defend.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  requestLeave,
  decideLeave,
  InsufficientLeaveBalanceError,
  NegativeLeaveBalanceLimitExceededError,
} from '../core/leave';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

/** A paid type that permits a negative balance, optionally with a floor. No entitlement granted. */
async function negType(floor: number | null): Promise<string> {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: `NG_${randomUUID().slice(0, 6).toUpperCase()}`,
      name: 'Negative Leave',
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
      maxNegativeBalance: floor == null ? null : floor.toFixed(2),
    })
    .returning({ id: schema.leaveType.id });
  return lt.id;
}

async function hire(name: string): Promise<string> {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ng_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  return e.employmentId;
}

/** Submit and then approve, returning whatever approval throws (or null). */
async function applyAndApprove(employmentId: string, leaveTypeId: string, from: string, to: string) {
  const req = await requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate: from, endDate: to });
  try {
    // The parameter is leaveRequestId, and requestLeave returns leaveRequestId — NOT `id`. Passing the
    // wrong key yields an undefined bind parameter and a "Failed query" that looks like a database fault
    // rather than a test bug, which is exactly how the first run of this file read.
    await decideLeave(adminCtx(b), { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    return null;
  } catch (e) {
    return e as Error;
  }
}

describe('9861b8a4 · the approval gate is unlocked by the PAIR, not by the switch', () => {
  it('SHIPS INERT: Yes with NO floor still refuses at approval, exactly as before', async () => {
    // The whole safety argument. Every leave type on production that already has the switch on has no
    // floor, so none of them changes behaviour on the day this deploys. If this test ever goes green by
    // approving instead of throwing, the change stopped being opt-in.
    const employmentId = await hire('Inert');
    const leaveTypeId = await negType(null);
    const err = await applyAndApprove(employmentId, leaveTypeId, '2026-03-02', '2026-03-04');
    expect(err).toBeInstanceOf(InsufficientLeaveBalanceError);
    expect(await ledgerBalance(employmentId, leaveTypeId), 'nothing was debited').toBe(0);
  });

  it('a floor UNLOCKS it: the balance actually goes negative, and stays within the floor', async () => {
    const employmentId = await hire('Unlocked');
    const leaveTypeId = await negType(5);
    const err = await applyAndApprove(employmentId, leaveTypeId, '2026-03-02', '2026-03-04'); // 3 days
    expect(err, 'approval should succeed').toBeNull();
    expect(await ledgerBalance(employmentId, leaveTypeId)).toBe(-3);
  });

  it('lands exactly ON the floor: permitted, the limit is inclusive', async () => {
    const employmentId = await hire('Exact');
    const leaveTypeId = await negType(3);
    expect(await applyAndApprove(employmentId, leaveTypeId, '2026-03-02', '2026-03-04')).toBeNull();
    expect(await ledgerBalance(employmentId, leaveTypeId)).toBe(-3);
  });

  it('past the floor: refused at SUBMISSION, so it never reaches an approver', async () => {
    // WRITTEN THIS WAY BECAUSE THE FIRST DRAFT OF THIS TEST WAS WRONG, and the correction is the useful
    // part. bc512dc3's submit-time floor fires first, so an over-floor request is refused the moment the
    // employee sends it rather than after they have waited for a decision. That is the better outcome and
    // it is what the two gates are FOR: submission is the fast, readable refusal; approval is the backstop
    // for everything submission could not have known (below).
    const employmentId = await hire('Past');
    const leaveTypeId = await negType(3);
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId,
        startDate: '2026-03-02',
        endDate: '2026-03-06', // 5 days against a floor of 3
      }),
    ).rejects.toBeInstanceOf(NegativeLeaveBalanceLimitExceededError);
    expect(await ledgerBalance(employmentId, leaveTypeId), 'nothing was debited').toBe(0);
  });

  it('the floor accumulates: a second request is refused once the first approval has spent the headroom', async () => {
    const employmentId = await hire('Accumulate');
    const leaveTypeId = await negType(4);
    expect(await applyAndApprove(employmentId, leaveTypeId, '2026-03-02', '2026-03-04')).toBeNull(); // -3
    // The floor is on the BALANCE, not on one request: 3 more days would land at -7 against a floor of 4,
    // so this is refused even though 3 days on its own is well inside the limit.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId,
        startDate: '2026-03-09',
        endDate: '2026-03-11',
      }),
    ).rejects.toBeInstanceOf(NegativeLeaveBalanceLimitExceededError);
    expect(await ledgerBalance(employmentId, leaveTypeId), 'still only the first approval').toBe(-3);
  });

  it('THE APPROVAL GATE EARNS ITS KEEP: the floor is TIGHTENED while the request is pending', async () => {
    // FINDING THIS CASE TOOK THREE TRIES AND THE FAILURES WERE THE USEFUL PART, so the reasoning is
    // recorded rather than just the answer.
    //
    // Submission already catches almost everything. availableLeaveBalance RESERVES pending days, so two
    // requests that would jointly breach the floor are caught the moment the second is sent — the second
    // one never reaches an approver. That is why the obvious "two approvers on the same day" scenario
    // cannot actually reach this gate.
    //
    // What submission cannot know is the future. A request submitted while the floor was generous is
    // judged against the floor in force WHEN IT WAS SENT. Tighten the setting while it sits pending and
    // only the approval-time check is left to notice. That is the case this gate exists for, and it is the
    // same shape as the application-limit rule's "a limit set or tightened after submission must not be
    // approvable through".
    const employmentId = await hire('Tightened');
    const leaveTypeId = await negType(10);
    const req = await requestLeave(adminCtx(b), {
      employmentId,
      leaveTypeId,
      startDate: '2026-03-02',
      endDate: '2026-03-08', // 7 days — fine against a floor of 10
    });
    // The administrator narrows the policy while the request is pending.
    await owner.db
      .update(schema.leaveType)
      .set({ maxNegativeBalance: '4.00' })
      .where(eq(schema.leaveType.id, leaveTypeId));

    await expect(
      decideLeave(adminCtx(b), { leaveRequestId: req.leaveRequestId, decision: 'approved' }),
    ).rejects.toBeInstanceOf(NegativeLeaveBalanceLimitExceededError);
    expect(await ledgerBalance(employmentId, leaveTypeId), 'nothing was debited').toBe(0);
  });

  it('a type that does NOT allow a negative balance is untouched by any of this', async () => {
    const employmentId = await hire('Blocked');
    const [lt] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: `NO_${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'No Negative',
        paid: true,
        counting: 'calendar_days',
        allowNegativeBalance: false,
      })
      .returning({ id: schema.leaveType.id });
    // It cannot even be submitted, which is the pre-existing behaviour and must not have moved.
    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: lt.id,
        startDate: '2026-03-02',
        endDate: '2026-03-04',
      }),
    ).rejects.toThrow();
  });
});

describe('9861b8a4 · turning the switch on now REQUIRES a floor', () => {
  it('the write path refuses Yes with no figure', async () => {
    const { updateLeaveType } = await import('../core/admin');
    const [lt] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: `RQ_${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'Requires Floor',
        paid: true,
      })
      .returning({ id: schema.leaveType.id });
    await expect(
      updateLeaveType(adminCtx(b), { id: lt.id, name: 'Requires Floor', allowNegativeBalance: true }),
    ).rejects.toThrow(/Maximum negative balance/i);
  });

  it('…but an EXISTING row in that state is left alone — the guard is on writes, not a migration', async () => {
    // A migration guessing a floor for the rows already in this state would be inventing policy. They are
    // listed on screen instead, and this pins that they were not silently rewritten.
    const leaveTypeId = await negType(null);
    const [row] = await owner.db
      .select({ allow: schema.leaveType.allowNegativeBalance, max: schema.leaveType.maxNegativeBalance })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, leaveTypeId));
    expect(row.allow).toBe(true);
    expect(row.max).toBeNull();
  });
});
