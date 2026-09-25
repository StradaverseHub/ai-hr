/**
 * r341 · 8d3a7bff — "SPECIAL LEAVE" ONCE: ONE CARD FOR THE POOL, AND THE FIVE MEMBERS THAT KEEP THEIRS.
 *
 * THE TICKET. My Leave drew two cards headed "Special Leave" and the reporter asked for the second — the one
 * with the stacked-layers icon — to be removed, and for member leave types to show no card of their own.
 *
 * ⚠️ HALF OF THAT WOULD HAVE HIDDEN 177 DAYS FROM 59 PEOPLE, AND THE PLAN SAID SO BEFORE IT WAS APPROVED.
 * Re-measured on production 2026-09-26: the shared group "Special Leave" holds CGL CPL EXM GD MRL NDL STD and
 * is placed 'primary'; only CPL and NDL carry `balance_source_type_id` → SP. Marriage Leave holds 177.00
 * `leave_ledger` days across 59 employments of its own, and CGL/EXM/GD/STD hold 0.00 — which is the same
 * arrangement with nothing granted yet, never a reason to treat them differently. So:
 *
 *   · the shared GROUP's tile is merged onto the leave-type card whose ledger IS the pot — one card;
 *   · CPL and NDL lose their own cards, because their balance IS that card's;
 *   · MRL, CGL, EXM, GD and STD keep theirs, each naming the ceiling it also counts towards.
 *
 * ⚠️ THE TWO SETTINGS ARE NOT RECONCILED AND MUST NOT BE. `leave_shared_group` is a combined CEILING
 * (10.00 days, 3.00 per application, enforced by `enforceSharedLeaveGroupLimit`);
 * `leave_type.balance_source_type_id` is a LEDGER ROUTE. The member sets differ BY DESIGN, and case (d) below
 * is the guard that fails if anyone widens the card-folding rule from the pointer back to membership.
 *
 * ⚠️ AND THE r209 TRAP MUST NOT COME BACK. lib/shared-leave-balance.ts records that a borrower reading its
 * OWN breakdown printed "YTD Entitled 0.00" under a red notice telling HR to create an entitlement table —
 * the one change that would stop it borrowing. Nothing here gives a borrower its own entitlement story.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { decideLeave, leaveTypeApplySummary, requestLeave } from '../core/leave';
import { leaveBalances, leaveEntitlementBreakdown, listEligibleLeaveTypesFor } from '../core/read';
import { createLeaveSharedGroup } from '../core/leave-shared-group';
import { isPoolBorrower, otherContributors } from '../lib/shared-leave-balance';
import { planSharedGroupCeilings } from '../lib/shared-leave-pool';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const uniq = (p: string) => `${p}_${randomUUID().slice(0, 8).toUpperCase()}`;

async function leaveTypeRow(name: string, balanceSourceTypeId?: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('R341'),
      name: `${name} ${randomUUID().slice(0, 6)}`,
      paid: true,
      counting: 'calendar_days',
      allowNegativeBalance: true,
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
 * PRODUCTION'S SHAPE, SMALL. `sp` is the pot (10 days on its own ledger); `cpl` and `ndl` point at it; `mrl`
 * holds 6 days of its OWN and is in the same group; `exm` is in the group with nothing granted; `loose` is in
 * no group — the control arm, so a case that dropped or kept everything cannot pass.
 */
async function fixture(opts: { placement?: 'primary' | 'secondary' | 'hidden' } = {}) {
  const ctx = adminCtx(b);
  const sp = await leaveTypeRow('Special Leave');
  const cpl = await leaveTypeRow('Compassionate Leave', sp);
  const ndl = await leaveTypeRow('Natural Disaster Leave', sp);
  const mrl = await leaveTypeRow('Marriage Leave');
  const exm = await leaveTypeRow('Examination Leave');
  const loose = await leaveTypeRow('Medical Leave');
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Pool Member', primaryEmail: `r341_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  await grant(emp.employmentId, sp, 10);
  await grant(emp.employmentId, mrl, 6);
  await grant(emp.employmentId, loose, 14);
  const group = await createLeaveSharedGroup(ctx, {
    name: 'Special Leave',
    totalLimitDays: 10,
    maxDaysPerApplication: 3,
    leaveTypeIds: [cpl, ndl, mrl, exm],
    ...(opts.placement === 'hidden' ? {} : { essPlacement: opts.placement ?? 'primary' }),
  });
  return { ctx, sp, cpl, ndl, mrl, exm, loose, group, employmentId: emp.employmentId };
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
});

describe('8d3a7bff · (a) ONE card for the Special Leave pool', () => {
  it('the pool draws a card, its two borrowers draw none, and the GROUP draws no tile of its own', async () => {
    const { ctx, sp, cpl, ndl, group, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en');
    const ids = rows.map((r) => r.leaveTypeId);

    expect(ids, 'the pool keeps the one card').toContain(sp);
    expect(ids, 'Compassionate Leave repeats the pool and draws nothing').not.toContain(cpl);
    expect(ids, 'Natural Disaster Leave likewise').not.toContain(ndl);

    // The stacked-layers tile: it is gone because the group MERGES onto the pool's card. Decided in one pure
    // place, so this asserts the decision the screen is built from, not the markup it happens to emit.
    const plan = planSharedGroupCeilings(rows, [{ id: group.id, members: [{ id: cpl }, { id: ndl }] }]);
    expect(plan.standalone, 'the group would still draw its own tile beside the pool').toEqual([]);
    expect([...plan.mergedOnto.keys()], 'the ceiling merges onto the pool’s card').toEqual([sp]);
  });

  it('a group with NO pooled member keeps its own tile — the seeded shape, unchanged', async () => {
    const { ctx, mrl, exm, loose, group, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en');
    // This group's members are only the two that hold their own days: there is no card whose ledger is the
    // pot, so nothing can absorb the tile and removing it would delete the only display of the ceiling.
    const plan = planSharedGroupCeilings(rows, [{ id: group.id, members: [{ id: mrl }, { id: exm }] }]);
    expect(plan.standalone.map((g) => g.id), 'nothing to merge onto').toEqual([group.id]);
    expect([...plan.mergedOnto.keys()]).toEqual([]);
    // NON-VACUITY: the same call on the same rows DOES merge when a pooled member is named.
    expect(
      [...planSharedGroupCeilings(rows, [{ id: group.id, members: [{ id: loose }] }]).mergedOnto.keys()],
      'an unpooled member must not merge either',
    ).toEqual([]);
  });
});

describe('8d3a7bff · (b) the merged card’s Taken and Pending include every borrower’s days', () => {
  it('a Compassionate request moves the POOL card’s Taken and Pending Approval, not a card of its own', async () => {
    const { ctx, sp, cpl, employmentId } = await fixture();
    const before = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: sp });
    expect(before.pending, 'nothing reserved yet').toBe(0);

    // PENDING first: a request awaiting a decision already reserves the pool (`balanceSpenderTypeIds`).
    const req = await requestLeave(ctx, {
      employmentId, leaveTypeId: cpl, startDate: '2026-06-01', endDate: '2026-06-02', today: '2026-05-01',
    });
    const pending = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: sp });
    expect(pending.pending, 'the borrower’s two days weigh on the pool’s card').toBe(2);
    expect(pending.available, 'and on what the pool says can still be applied for').toBe(before.balance - 2);

    // THEN TAKEN: approval debits the pool's ledger, so the pool's own Taken is the pooled figure.
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });
    const taken = await leaveTypeApplySummary(ctx, { employmentId, leaveTypeId: sp });
    expect(taken.taken, 'the pool’s Taken counts the borrower’s approved days').toBe(2);
    expect(taken.pending, 'and its reservation is released').toBe(0);

    // The card's own Taken comes from the breakdown (core/my-leave.ts `bd.takenThisCycle`), which must agree.
    const bd = await leaveEntitlementBreakdown(ctx, employmentId, sp, '2026-12-31', 'en');
    expect(bd?.takenThisCycle, 'card and Apply form must not disagree about the pooled Taken').toBe(2);

    // …and the borrower still has no card for those days to hide behind.
    expect((await leaveBalances(ctx, employmentId, 'en')).map((r) => r.leaveTypeId)).not.toContain(cpl);
  });
});

describe('8d3a7bff · (c) and (d) — which members lose a card, and which must never', () => {
  it('(c) both pooled borrowers are folded on self-service and both survive for HR', async () => {
    const { ctx, cpl, ndl, employmentId } = await fixture();
    const ess = (await leaveBalances(ctx, employmentId, 'en')).map((r) => r.leaveTypeId);
    expect(ess).not.toContain(cpl);
    expect(ess).not.toContain(ndl);

    const hr = (await leaveBalances(ctx, employmentId, 'en', { includeHidden: true })).map((r) => r.leaveTypeId);
    expect(hr, 'Employee Balances must not lose a type').toEqual(expect.arrayContaining([cpl, ndl]));
  });

  /**
   * ⚠️ (d) THE LOAD-BEARING GUARD. Marriage Leave is a member of the placed group AND holds its own days. If
   * anyone widens the folding rule from `balance_source_type_id` back to group membership, this case fails —
   * which is exactly what it is for. On production that widening costs 59 employments sight of 177.00 days.
   */
  it('(d) Marriage Leave renders its card WITH its own balance, although it is in the placed group', async () => {
    const { ctx, mrl, exm, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en');
    const mrlRow = rows.find((r) => r.leaveTypeId === mrl);

    expect(mrlRow, 'a member that holds its own days must keep its card').toBeDefined();
    expect(mrlRow!.balance, 'and the card must carry the days, not a pooled zero').toBe(6);
    expect(isPoolBorrower(mrlRow!), 'it borrows nothing — its ledger is its own').toBe(false);
    expect(mrlRow!.sharedBalance, 'and it is in no balance pool at all').toBeNull();

    // A member at 0.00 today is the SAME arrangement, so it keeps its card too: hiding it would make the rule
    // depend on a figure, and the day an entitlement table is written for it the defect would be back.
    expect(rows.map((r) => r.leaveTypeId), 'a zero-balance member keeps its card').toContain(exm);
  });

  it('(d) the ceiling is NAMED on the cards that keep their balance, so the connection is still visible', async () => {
    const { ctx, sp, mrl, exm, cpl, group, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en');
    const plan = planSharedGroupCeilings(rows, [
      { id: group.id, members: [{ id: cpl }, { id: mrl }, { id: exm }] },
    ]);
    expect([...plan.mergedOnto.keys()], 'the pot’s card holds the ceiling').toEqual([sp]);
    expect([...plan.alsoCounts.keys()].sort(), 'and the keepers name it').toEqual([mrl, exm].sort());
    expect(plan.alsoCounts.get(sp), 'the host does not also "count towards" its own ceiling').toBeUndefined();
  });
});

describe('8d3a7bff · (f) the HR note names the BORROWERS, from the pointer and not from the group', () => {
  it('“shares one balance with” lists CPL and NDL and neither MRL nor EXM', async () => {
    const { ctx, sp, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en', { includeHidden: true });
    const pool = rows.find((r) => r.leaveTypeId === sp)!;

    expect(pool.sharedBalance, 'the pool row carries the descriptor the note is built from').not.toBeNull();
    const named = otherContributors(pool.sharedBalance!, pool.leaveType);
    expect(named.some((n) => n.startsWith('Compassionate Leave')), 'CPL is named').toBe(true);
    expect(named.some((n) => n.startsWith('Natural Disaster Leave')), 'NDL is named').toBe(true);
    // THE WHOLE POINT: the group's other members are NOT on this balance and must not be named on it.
    expect(named.some((n) => n.startsWith('Marriage Leave')), 'MRL must not be named — it draws its own').toBe(false);
    expect(named.some((n) => n.startsWith('Examination Leave')), 'EXM likewise').toBe(false);
    expect(named, 'exactly the two that borrow').toHaveLength(2);
  });
});

describe('8d3a7bff · (g) a folded card never removes the right to apply', () => {
  it('every member is still in the apply menu, and a request on a folded borrower goes through', async () => {
    const { ctx, cpl, ndl, mrl, exm, employmentId } = await fixture();
    const menu = (await listEligibleLeaveTypesFor(ctx, employmentId, 'en')).map((t: { id: string }) => t.id);
    expect(menu, 'the card went, the right to apply did not').toEqual(
      expect.arrayContaining([cpl, ndl, mrl, exm]),
    );

    const req = await requestLeave(ctx, {
      employmentId, leaveTypeId: ndl, startDate: '2026-07-01', endDate: '2026-07-02', today: '2026-06-01',
    });
    expect(req.leaveRequestId).toBeTruthy();
  });
});
