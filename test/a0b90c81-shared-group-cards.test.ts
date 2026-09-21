/**
 * a0b90c81 — the six Special Leave reason cards come off My Leave, and the switch that was supposed to do
 * it could not.
 *
 * WHAT WAS PROMISED AND WHY IT WAS REFUSED. An earlier round told the reporter the six member cards would
 * be hidden. They could not be, with the setting that existed: `visible_to_employee = false` hides a
 * type's CARD *and* removes it from Request Leave, because `mayAppearInApplyMenu` excludes any type whose
 * `resolvePlacement(...)` is 'hidden'. One flag, two consequences. Using it would have taken every Special
 * Leave reason out of the apply dropdown — including the per-reason Apply buttons shipped in the same
 * round. That was reported back rather than worked around, and this is the mechanism approved instead:
 *
 *   A LEAVE TYPE WHOSE BALANCE **IS** A PLACED POOL'S DRAWS NO CARD OF ITS OWN.
 *
 * Structural, so it cannot be misconfigured, and it covers a group created next year with nobody setting
 * a switch.
 *
 * ⚠️ THE REPORTER'S CENTRAL REQUIREMENT, WHICH THIS MUST NOT BREAK. 46afcc48 revision 2 exists because
 * they CONTESTED a revision-1 plan in which the group folded its members in: member visibility must not be
 * an input to the pooled figure or to the enforcement verdict. That is the opposite direction from this
 * change and stays true — `sharedLeaveGroupBalances` reads with `includeHidden: true` and this gate is on
 * the same flag, so the summer still sees every member. Both directions are pinned below, because a
 * defect in the contract between a display and an engine is invisible to a unit test of either half.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave } from '../core/leave';
import { leaveBalances, listEligibleLeaveTypesFor } from '../core/read';
import {
  createLeaveSharedGroup,
  sharedLeaveGroupBalances,
  updateLeaveSharedGroup,
} from '../core/leave-shared-group';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
/** leave_type.code is checked against ^[A-Z][A-Z0-9_]{1,31}$ (migration 0031) — underscore, not hyphen. */
const uniq = (p: string) => `${p}_${randomUUID().slice(0, 8).toUpperCase()}`;

async function leaveType(): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('SPC'),
      name: uniq('Reason'),
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

async function grant(employmentId: string, leaveTypeId: string, days: number) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days: days.toFixed(2),
    effectiveOn: '2020-01-01',
  });
}

/** Two pooled reasons holding 4 and 5 days, plus one ORDINARY type that is in no group at all — the
 *  control arm, so a case that drops everything cannot pass. */
async function fixture() {
  const ctx = adminCtx(b);
  const [ltA, ltB, loose] = [await leaveType(), await leaveType(), await leaveType()];
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Pooled', primaryEmail: `a0b_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  await grant(emp.employmentId, ltA, 4);
  await grant(emp.employmentId, ltB, 5);
  await grant(emp.employmentId, loose, 7);
  return { ctx, ltA, ltB, loose, employmentId: emp.employmentId };
}

const cardIds = async (ctx: ReturnType<typeof adminCtx>, employmentId: string, opts = {}) =>
  (await leaveBalances(ctx, employmentId, 'en', opts)).map((r) => r.leaveTypeId);

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

describe('a0b90c81 · a placed pool absorbs its members’ cards', () => {
  it('drops the member cards from self-service and leaves everything else alone', async () => {
    const { ctx, ltA, ltB, loose, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB], essPlacement: 'primary',
    });

    const ids = await cardIds(ctx, employmentId);
    expect(ids, 'the pooled reasons draw no card of their own').not.toContain(ltA);
    expect(ids).not.toContain(ltB);
    // NON-VACUITY: a type in no group is untouched. Without this a gate that dropped every row passes.
    expect(ids, 'an ungrouped type keeps its card').toContain(loose);
  });

  it('a group that is itself HIDDEN folds nothing — its members are the only way to see those days', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    // Placement defaults to hidden (migration 0438); no update call, so this is the out-of-the-box state.
    await createLeaveSharedGroup(ctx, { name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB] });

    const ids = await cardIds(ctx, employmentId);
    expect(ids, 'no pooled card exists to absorb them').toContain(ltA);
    expect(ids).toContain(ltB);
  });

  it('HR still sees every member type, for every employee', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB], essPlacement: 'primary',
    });

    const admin = await cardIds(ctx, employmentId, { includeHidden: true, includeArchived: true });
    expect(admin, 'Employee Balances must not lose a type').toEqual(expect.arrayContaining([ltA, ltB]));
  });
});

describe('a0b90c81 · the three things it must not touch', () => {
  it('THE POOLED FIGURE is identical whether or not the cards are folded', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    const g = await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB],
    });

    const hiddenGroup = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: '2026-12-31' });
    // ABSOLUTE update, not a patch — every field must be re-sent or the service drops it.
    await updateLeaveSharedGroup(ctx, {
      id: g.id, name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB], essPlacement: 'primary',
    });
    const placedGroup = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: '2026-12-31' });

    expect(placedGroup).toHaveLength(1);
    expect(placedGroup[0].available, 'the members’ nine, unchanged by folding their cards').toBe(9);
    // And the figure does not move when the members stop drawing cards — the contested requirement.
    if (hiddenGroup.length) expect(placedGroup[0].available).toBe(hiddenGroup[0].available);
  });

  it('APPLYING is unchanged — every reason stays in Request Leave', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB], essPlacement: 'primary',
    });

    const menu = (await listEligibleLeaveTypesFor(ctx, employmentId, 'en')).map((t: { id: string }) => t.id);
    expect(menu, 'the card went, the right to apply did not').toEqual(expect.arrayContaining([ltA, ltB]));

    // …and it is not merely listed: a request on a folded type still goes through.
    const req = await requestLeave(ctx, {
      employmentId, leaveTypeId: ltA, startDate: '2026-06-01', endDate: '2026-06-02', today: '2026-05-01',
    });
    expect(req.leaveRequestId).toBeTruthy();
  });

  /**
   * THE DECISION, STATED RATHER THAN INHERITED FROM ORDERING. r315 established that activity on a type
   * keeps its card (508d3acd edge case 1). Membership WINS over that here: the pooled card already
   * reflects the activity, because the pool is summed from the member ledgers. If this ever flips, it
   * must be because someone decided to flip it.
   */
  it('activity on a folded member does NOT bring its card back', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB], essPlacement: 'primary',
    });

    await requestLeave(ctx, {
      employmentId, leaveTypeId: ltA, startDate: '2026-06-01', endDate: '2026-06-02', today: '2026-05-01',
    });

    const ids = await cardIds(ctx, employmentId);
    expect(ids, 'the pooled card carries this activity').not.toContain(ltA);
  });

  it('removing a type from the group gives its card straight back', async () => {
    const { ctx, ltA, ltB, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB], essPlacement: 'primary',
    });
    expect(await cardIds(ctx, employmentId)).not.toContain(ltA);

    await owner.db
      .delete(schema.leaveSharedGroupMember)
      .where(eq(schema.leaveSharedGroupMember.leaveTypeId, ltA));

    expect(await cardIds(ctx, employmentId), 'no longer pooled, so it draws its own card again').toContain(ltA);
  });
});
