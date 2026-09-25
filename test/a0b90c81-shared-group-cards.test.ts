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
 * ⚠️ UPDATED BY r341 (8d3a7bff), AND THE UPDATE IS A NARROWING RATHER THAN A LOOSENING. The sentence above
 * has always been the rule; the first cut did not implement it — it folded every member of a placed group,
 * so MEMBERSHIP ALONE cost a card. Re-measured on production 2026-09-26: the "Special Leave" group holds
 * seven members and is placed 'primary', while only CPL and NDL carry `balance_source_type_id` → SP. Marriage
 * Leave holds 177.00 days of its OWN across 59 employments and was being folded into a pooled card that does
 * not contain them. So the fixtures below now distinguish the two, and every folding case is keyed on a type
 * that really does draw on a pool. The cases that were here are kept, not relaxed: each one still asserts a
 * pooled member loses its card, and a new case asserts that a member holding its own days does not.
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

async function leaveType(balanceSourceTypeId?: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('SPC'),
      name: uniq('Reason'),
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
      // r341 — the POOLING POINTER, which is what the folding rule is keyed on. Absent ⇒ this type holds its
      // own days, and being in a placed group does not take its card away.
      ...(balanceSourceTypeId ? { balanceSourceTypeId } : {}),
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

/**
 * FOUR ARMS, because the rule this file pins turns on the difference between two of them (r341):
 *   · `ltA` / `ltB` — group members holding 4 and 5 days OF THEIR OWN. Production's Marriage Leave.
 *   · `pool` / `drawA` — a pot holding 6 days and a group member whose `balance_source_type_id` IS that pot.
 *     Production's Special Leave and Compassionate Leave. `drawA` is the one that loses its card.
 *   · `loose` — in no group at all: the control arm, so a case that drops everything cannot pass.
 */
async function fixture() {
  const ctx = adminCtx(b);
  const [ltA, ltB, loose, pool] = [await leaveType(), await leaveType(), await leaveType(), await leaveType()];
  const drawA = await leaveType(pool);
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
  await grant(emp.employmentId, pool, 6);
  return { ctx, ltA, ltB, loose, pool, drawA, employmentId: emp.employmentId };
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
  it('drops the POOLED member’s card from self-service and leaves everything else alone', async () => {
    const { ctx, ltA, ltB, loose, pool, drawA, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB, drawA], essPlacement: 'primary',
    });

    const ids = await cardIds(ctx, employmentId);
    expect(ids, 'a member whose balance IS the pool’s draws no card of its own').not.toContain(drawA);
    // NON-VACUITY: a type in no group is untouched. Without this a gate that dropped every row passes.
    expect(ids, 'an ungrouped type keeps its card').toContain(loose);
    expect(ids, 'the pool itself is where the folded card’s days are read').toContain(pool);
    // r341 — AND THE OTHER HALF OF THE RULE, which the first cut got wrong: membership alone costs nothing.
    expect(ids, 'a member holding its OWN days keeps its card').toContain(ltA);
    expect(ids).toContain(ltB);
  });

  it('a group that is itself HIDDEN folds nothing — its members are the only way to see those days', async () => {
    const { ctx, ltA, drawA, employmentId } = await fixture();
    // Placement defaults to hidden (migration 0438); no update call, so this is the out-of-the-box state.
    // Two members minimum — a group of one is refused by `cleanMemberTypeIds`.
    await createLeaveSharedGroup(ctx, { name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, drawA] });

    const ids = await cardIds(ctx, employmentId);
    expect(ids, 'no pooled card exists to absorb it').toContain(drawA);
    expect(ids, 'and the member holding its own days keeps its card for the other reason too').toContain(ltA);
  });

  it('HR still sees every member type, for every employee', async () => {
    const { ctx, ltA, ltB, drawA, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB, drawA], essPlacement: 'primary',
    });

    const admin = await cardIds(ctx, employmentId, { includeHidden: true, includeArchived: true });
    expect(admin, 'Employee Balances must not lose a type').toEqual(expect.arrayContaining([ltA, ltB, drawA]));
  });
});

describe('a0b90c81 · the three things it must not touch', () => {
  it('THE POOLED FIGURE is identical whether or not the cards are folded', async () => {
    const { ctx, ltA, ltB, drawA, employmentId } = await fixture();
    // The ceiling is deliberately ABOVE what the members hold (4 + 5 + the pool's 6), so this case reads the
    // memberAvailableSum arm of `sharedGroupAvailableDays` rather than the cap — the arm that folding a card
    // could actually move. `drawA` is in here because it is the member this rule folds.
    const g = await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 20, leaveTypeIds: [ltA, ltB, drawA],
    });

    const hiddenGroup = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: '2026-12-31' });
    // ABSOLUTE update, not a patch — every field must be re-sent or the service drops it.
    await updateLeaveSharedGroup(ctx, {
      id: g.id, name: 'Special Leave', totalLimitDays: 20, leaveTypeIds: [ltA, ltB, drawA], essPlacement: 'primary',
    });
    const placedGroup = await sharedLeaveGroupBalances(ctx, employmentId, { asOf: '2026-12-31' });

    expect(placedGroup).toHaveLength(1);
    expect(placedGroup[0].available, 'the members’ fifteen, unchanged by folding one of their cards').toBe(15);
    // And the figure does not move when a member stops drawing a card — the contested requirement.
    if (hiddenGroup.length) expect(placedGroup[0].available).toBe(hiddenGroup[0].available);
  });

  it('APPLYING is unchanged — every reason stays in Request Leave', async () => {
    const { ctx, ltA, ltB, drawA, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB, drawA], essPlacement: 'primary',
    });

    const menu = (await listEligibleLeaveTypesFor(ctx, employmentId, 'en')).map((t: { id: string }) => t.id);
    expect(menu, 'the card went, the right to apply did not').toEqual(
      expect.arrayContaining([ltA, ltB, drawA]),
    );

    // …and it is not merely listed: a request on the FOLDED type still goes through.
    const req = await requestLeave(ctx, {
      employmentId, leaveTypeId: drawA, startDate: '2026-06-01', endDate: '2026-06-02', today: '2026-05-01',
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
    const { ctx, ltA, ltB, drawA, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB, drawA], essPlacement: 'primary',
    });

    await requestLeave(ctx, {
      employmentId, leaveTypeId: drawA, startDate: '2026-06-01', endDate: '2026-06-02', today: '2026-05-01',
    });

    const ids = await cardIds(ctx, employmentId);
    expect(ids, 'the pooled card carries this activity').not.toContain(drawA);
  });

  it('removing a type from the group gives its card straight back', async () => {
    const { ctx, ltA, ltB, drawA, employmentId } = await fixture();
    await createLeaveSharedGroup(ctx, {
      name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [ltA, ltB, drawA], essPlacement: 'primary',
    });
    expect(await cardIds(ctx, employmentId)).not.toContain(drawA);

    await owner.db
      .delete(schema.leaveSharedGroupMember)
      .where(eq(schema.leaveSharedGroupMember.leaveTypeId, drawA));

    expect(await cardIds(ctx, employmentId), 'no longer in a placed group, so it draws its own card again').toContain(
      drawA,
    );
  });
});
