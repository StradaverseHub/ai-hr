/**
 * r343 · 1478c281 — A SPECIAL LEAVE MEMBER THAT HOLDS NOTHING OF ITS OWN DRAWS NO CARD.
 *
 * THE CORRECTION THIS PINS. Item 8d3a7bff asked for FEWER cards in the Special Leave area. r341 narrowed the
 * a0b90c81 fold from "every member of a placed group" to "every member whose balance IS the pool's", which was
 * right and load-bearing: before it, Marriage Leave was folded into a pooled card that does not contain its
 * days, so 177.00 days were invisible to 59 employments. But the same narrowing made FIVE cards APPEAR where
 * there had been none — Marriage (the point) plus Caregiver, Examination, Graduation and Study, each reading
 * 0.00. We raised that against ourselves and the reporter approved the fix: keep Marriage's 177 days, drop the
 * four empty ones.
 *
 * THE RULE, IN ONE GATE (core/read.ts, the a0b90c81 block): a member of a PLACED shared group is folded when
 *   · `isPoolBorrower(r)` — its balance IS the pool's, so its card would repeat the pool's card; OR
 *   · `holdsNothingOfItsOwn(r)` — `accrued`, `taken`, `pending` and `balance` are each 0.00, so its card would
 *     say nothing at all.
 *
 * ⚠️ THE TWO REASONS ARE ASSERTED SEPARATELY, in (d) below, and that separation is the point of this file.
 * They overlap on production — CPL and NDL satisfy both today — and a later reader who collapses them into one
 * condition breaks one of the two: `&&` puts the borrowers' cards back the moment a day is filed under them,
 * and dropping the pointer half puts a duplicate of the pool's card beside the pool's card.
 *
 * ⚠️ AND THE CARD COMES BACK BY ITSELF, (c). The condition reads the LEDGER, not a list of type names and not
 * a switch, so the day one of the four is granted a day its card returns carrying that day. A rule needing
 * somebody to remember to un-hide a type would be a worse bug than the one it fixes.
 *
 * ⚠️ mayAppearInApplyMenu IS UNTOUCHED, (e). A hidden card never removes the right to apply — that
 * distinction is the whole of item a0b90c81, it survived r341 and it survives this. Note that (e) is a
 * NO-CHANGE guard: it was green before this change and is green after, which is exactly what it claims.
 *
 * ⚠️ THE r209 TRAP IS NOT RESURRECTED. `holdsNothingOfItsOwn` reads the four figures already on the row and
 * NEVER the type's own entitlement table; lib/shared-leave-balance.ts records what happened when a display
 * decision consulted a borrower's own entitlement story — "YTD Entitled 0.00" under a red notice telling HR
 * to create a table, which is the one change that would end the borrowing. Nothing here asks that question.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { decideLeave, requestLeave } from '../core/leave';
import { leaveBalances, listEligibleLeaveTypesFor } from '../core/read';
import { createLeaveSharedGroup } from '../core/leave-shared-group';
import { holdsNothingOfItsOwn, isPoolBorrower } from '../lib/shared-leave-balance';
import { planSharedGroupCeilings } from '../lib/shared-leave-pool';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
/** leave_type.code is checked against ^[A-Z][A-Z0-9_]{1,31}$ (migration 0031) — underscore, not hyphen. */
const uniq = (p: string) => `${p}_${randomUUID().slice(0, 8).toUpperCase()}`;

async function leaveTypeRow(name: string, balanceSourceTypeId?: string): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: uniq('R343'),
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
 * PRODUCTION'S SHAPE, SMALL — all seven members of "Special Leave" plus a control arm:
 *   · `sp`   — the pot, 10 days on its own ledger (production: SP, 800.00 / 80 employments);
 *   · `cpl`, `ndl` — `balance_source_type_id` → `sp`. Folded by the POINTER, whatever they hold;
 *   · `mrl`  — a member holding 6 days OF ITS OWN (production: MRL, 177.00 / 59). Folded by NEITHER reason;
 *   · `cgl`, `exm`, `gd`, `std` — members with nothing granted at all (production: 0.00 each). Folded by the
 *     BALANCE reason, and each one's card must return the day it is granted a day;
 *   · `loose` — in no group, 14 days: the control arm, so a gate that dropped everything cannot pass.
 */
async function fixture() {
  const ctx = adminCtx(b);
  const sp = await leaveTypeRow('Special Leave');
  const cpl = await leaveTypeRow('Compassionate Leave', sp);
  const ndl = await leaveTypeRow('Natural Disaster Leave', sp);
  const mrl = await leaveTypeRow('Marriage Leave');
  const cgl = await leaveTypeRow('Caregiver Leave');
  const exm = await leaveTypeRow('Examination Leave');
  const gd = await leaveTypeRow('Graduation Leave');
  const std = await leaveTypeRow('Study Leave');
  const loose = await leaveTypeRow('Medical Leave');
  const emp = await hireEmployee(ctx, {
    person: { fullName: 'Special Member', primaryEmail: `r343_${randomUUID().slice(0, 8)}@t.local` },
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
    leaveTypeIds: [cpl, ndl, mrl, cgl, exm, gd, std],
    essPlacement: 'primary',
  });
  return { ctx, sp, cpl, ndl, mrl, cgl, exm, gd, std, loose, group, employmentId: emp.employmentId };
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

describe('1478c281 · (a) Marriage Leave keeps its card AND its days', () => {
  /**
   * ⚠️ THE LOAD-BEARING CASE. On production this is 59 employments and 177.00 days they can actually spend.
   * It fails if anyone widens the fold back to group membership (the pre-r341 rule) and it fails if the new
   * zero-balance condition is written as "member of a placed group" rather than as a question about the ledger.
   */
  it('a member that holds its own days draws a card carrying them', async () => {
    const { ctx, mrl, loose, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en');
    const mrlRow = rows.find((r) => r.leaveTypeId === mrl);

    expect(mrlRow, 'Marriage Leave is in the placed group and must still draw its card').toBeDefined();
    expect(mrlRow!.balance, 'and the card must carry its own days, not a pooled or folded zero').toBe(6);
    expect(holdsNothingOfItsOwn(mrlRow!), 'it holds something, so the new condition does not touch it').toBe(false);
    expect(isPoolBorrower(mrlRow!), 'and it borrows nothing — its ledger is its own').toBe(false);
    // CONTROL ARM: a type in no group at all is untouched, so a gate that dropped every row cannot pass here.
    expect(rows.map((r) => r.leaveTypeId), 'an ungrouped type keeps its card').toContain(loose);
  });

  it('the pool still draws the one merged card, and the ceiling still lands on it', async () => {
    const { ctx, sp, mrl, cpl, ndl, group, employmentId } = await fixture();
    const rows = await leaveBalances(ctx, employmentId, 'en');
    expect(rows.map((r) => r.leaveTypeId), 'the pot keeps the card the group merges onto').toContain(sp);
    const plan = planSharedGroupCeilings(rows, [
      { id: group.id, members: [{ id: cpl }, { id: ndl }, { id: mrl }] },
    ]);
    expect([...plan.mergedOnto.keys()], 'one card for the pool').toEqual([sp]);
    expect(plan.standalone, 'and no stacked-layers tile beside it').toEqual([]);
    // Only cards that SURVIVED can name the ceiling — which is now Marriage Leave and nothing else.
    expect([...plan.alsoCounts.keys()], 'the one keeper names the ceiling it counts towards').toEqual([mrl]);
  });
});

describe('1478c281 · (b) the four empty members draw no card', () => {
  it('Caregiver, Examination, Graduation and Study are gone from self-service, and HR still sees all seven', async () => {
    const { ctx, cgl, exm, gd, std, cpl, ndl, mrl, employmentId } = await fixture();
    const ess = await cardIds(ctx, employmentId);

    expect(ess, 'Caregiver holds nothing of its own').not.toContain(cgl);
    expect(ess, 'Examination likewise').not.toContain(exm);
    expect(ess, 'Graduation likewise').not.toContain(gd);
    expect(ess, 'Study likewise').not.toContain(std);

    // 994a5287 / a0b90c81: folding is a SELF-SERVICE display decision and never removes a type from HR.
    const hr = await cardIds(ctx, employmentId, { includeHidden: true });
    expect(hr, 'Employee Balances must not lose a member type').toEqual(
      expect.arrayContaining([cpl, ndl, mrl, cgl, exm, gd, std]),
    );
  });
});

describe('1478c281 · (c) the card comes back by itself', () => {
  /**
   * The whole reason the condition reads the ledger rather than a list of names. Both halves are in ONE case
   * on purpose: "it reappears" is vacuous on its own, because a card that was never hidden also reappears.
   */
  it('granting one day to a hidden member puts its card back, carrying that day', async () => {
    const { ctx, gd, employmentId } = await fixture();
    expect(await cardIds(ctx, employmentId), 'hidden while it holds nothing').not.toContain(gd);

    await grant(employmentId, gd, 1);

    const rows = await leaveBalances(ctx, employmentId, 'en');
    const gdRow = rows.find((r) => r.leaveTypeId === gd);
    expect(gdRow, 'and back the moment it holds something — nobody un-hid anything').toBeDefined();
    expect(gdRow!.balance, 'with the granted day on it').toBe(1);
    expect(holdsNothingOfItsOwn(gdRow!), 'the condition that hid it no longer holds').toBe(false);
  });

  it('a PENDING request is enough on its own — the row need not hold a balance', async () => {
    const { ctx, std, employmentId } = await fixture();
    expect(await cardIds(ctx, employmentId), 'hidden while nothing at all is on the row').not.toContain(std);

    // No entitlement, no accrual: only an undecided request, which `pending` carries. The card must show,
    // or the employee has applied for something with nowhere on screen to see it — the defect the
    // pending-only tail exists for (core/read.ts), and folding must not undo it.
    await requestLeave(ctx, {
      employmentId, leaveTypeId: std, startDate: '2026-09-01', endDate: '2026-09-02', today: '2026-08-01',
    });

    const row = (await leaveBalances(ctx, employmentId, 'en')).find((r) => r.leaveTypeId === std);
    expect(row, 'a pending request is something held, so the card is back').toBeDefined();
    expect(row!.pending, 'and it is the pending days that brought it back').toBe(2);
    expect(row!.balance, 'while the balance is still nothing').toBe(0);
  });
});

describe('1478c281 · (d) TWO REASONS, ASSERTED SEPARATELY', () => {
  /**
   * ⚠️ DO NOT MERGE THESE TWO CASES. On production CPL and NDL satisfy both conditions at once, so a single
   * "they are not there" assertion would pass for either reason and a later reader could delete one of them
   * without a test noticing. Each case below arranges for exactly ONE of the two reasons to hold.
   */
  it('CPL is folded for the POINTER reason ALONE — it holds filed days, so the balance reason is false', async () => {
    const { ctx, cpl, employmentId } = await fixture();

    // Two days filed under CPL and approved. The debit lands on the POOL's ledger (`resolveBalanceSourceTypeId`)
    // but `taken` is FILED-TYPE attributed (690d4400), so CPL's own row holds something.
    const req = await requestLeave(ctx, {
      employmentId, leaveTypeId: cpl, startDate: '2026-06-01', endDate: '2026-06-02', today: '2026-05-01',
    });
    await decideLeave(ctx, { leaveRequestId: req.leaveRequestId, decision: 'approved' });

    const cplRow = (await leaveBalances(ctx, employmentId, 'en', { includeHidden: true })).find(
      (r) => r.leaveTypeId === cpl,
    )!;
    expect(cplRow.taken, 'the days are on its own row').toBe(2);
    expect(holdsNothingOfItsOwn(cplRow), 'so the BALANCE reason does NOT apply to it').toBe(false);
    expect(isPoolBorrower(cplRow), 'the POINTER reason is the one that applies').toBe(true);
    expect(await cardIds(ctx, employmentId), 'and it is folded on that reason alone').not.toContain(cpl);
  });

  it('EXM is folded for the BALANCE reason ALONE — it borrows from nobody', async () => {
    const { ctx, exm, employmentId } = await fixture();
    const exmRow = (await leaveBalances(ctx, employmentId, 'en', { includeHidden: true })).find(
      (r) => r.leaveTypeId === exm,
    )!;
    expect(isPoolBorrower(exmRow), 'the POINTER reason does NOT apply — its ledger is its own').toBe(false);
    expect(exmRow.sharedBalance, 'it is in no balance pool at all').toBeNull();
    expect(holdsNothingOfItsOwn(exmRow), 'the BALANCE reason is the one that applies').toBe(true);
    expect(await cardIds(ctx, employmentId), 'and it is folded on that reason alone').not.toContain(exm);
  });

  it('NDL satisfies both at once, which is why the two above exist', async () => {
    const { ctx, ndl, employmentId } = await fixture();
    const ndlRow = (await leaveBalances(ctx, employmentId, 'en', { includeHidden: true })).find(
      (r) => r.leaveTypeId === ndl,
    )!;
    expect(isPoolBorrower(ndlRow)).toBe(true);
    expect(holdsNothingOfItsOwn(ndlRow)).toBe(true);
    expect(await cardIds(ctx, employmentId), 'folded — but this case cannot say which reason did it').not.toContain(ndl);
  });

  it('a member of a HIDDEN group keeps its card for NEITHER reason — placement is the outer gate', async () => {
    const ctx = adminCtx(b);
    const sp = await leaveTypeRow('Special Leave');
    const cpl = await leaveTypeRow('Compassionate Leave', sp);
    const exm = await leaveTypeRow('Examination Leave');
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Hidden Group', primaryEmail: `r343h_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    await grant(emp.employmentId, sp, 10);
    // Placement defaults to hidden (migration 0438): the out-of-the-box state, in which nothing folds because
    // the group draws no card to absorb anything — including the empty member, whose card is the only place
    // its (future) days could ever appear.
    await createLeaveSharedGroup(ctx, { name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [cpl, exm] });

    const ids = await cardIds(ctx, emp.employmentId);
    expect(ids, 'the borrower keeps its card: no pooled card exists to absorb it').toContain(cpl);
    expect(ids, 'and so does the empty member').toContain(exm);
  });
});

describe('1478c281 · (e) a hidden card never removes the right to apply', () => {
  it('all seven members stay in Request Leave, and a request on an EMPTY hidden member goes through', async () => {
    const { ctx, cpl, ndl, mrl, cgl, exm, gd, std, employmentId } = await fixture();
    const menu = (await listEligibleLeaveTypesFor(ctx, employmentId, 'en')).map((t: { id: string }) => t.id);
    expect(menu, 'the card went, the right to apply did not').toEqual(
      expect.arrayContaining([cpl, ndl, mrl, cgl, exm, gd, std]),
    );

    // …and it is not merely listed: applying for one of the four whose card this change removed still works.
    const req = await requestLeave(ctx, {
      employmentId, leaveTypeId: gd, startDate: '2026-08-03', endDate: '2026-08-04', today: '2026-07-01',
    });
    expect(req.leaveRequestId, 'Graduation Leave has no card and is still applicable for').toBeTruthy();
  });
});
