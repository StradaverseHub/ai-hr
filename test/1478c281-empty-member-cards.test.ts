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
 * ⚠️ THE r209 TRAP IS NOT RESURRECTED, AND THAT IS A NARROWER CLAIM THAN IT LOOKS — (f). `holdsNothingOfItsOwn`
 * reads the four figures already on the row and NEVER the type's own entitlement table, so it cannot print the
 * WRONG notice, which is what r209's trap was: lib/shared-leave-balance.ts records "YTD Entitled 0.00" under a
 * red instruction to create a table, over days the employee could in fact spend. But the CORRECT notice goes
 * unprinted instead, because it is part of the card and the card is gone. (f) measures exactly that, in the
 * state production is actually in, and pins the two halves of the answer:
 *   · the four folded members carry a 3-day table clamped to 0.00 — `capped_by_max_balance`, a notice-bearing
 *     status — so the card this fold removes was NOT four blank zeros. Folding takes that sentence with it,
 *     and that is the cost of what the reporter approved, recorded rather than implied;
 *   · no card that STILL RENDERS ever loses its notice: the same capped member holding two days by adjustment
 *     keeps its card AND its caption, and a member of a HIDDEN group keeps both as well.
 *
 * ⚠️ AND THE FIXTURE IS PRODUCTION'S STATE, WHICH IT WAS NOT AT FIRST. The first cut raw-inserted seven bare
 * leave types, so its four "empty" members were `no_entitlement_table` — a state the reporter's four are NOT
 * in. Their six Special Leave types carry bands of `{days: 3, maxBalanceDays: 0}`
 * (test/r196-entitlement-not-generated.test.ts:168): the year-open grants the 3, `applyMaxBalance` clamps it
 * to 0.00, and the accrual row is still written. In the bare-type shape the question (f) asks cannot even
 * arise, which is how it went unasked.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { decideLeave, openLeaveYear, requestLeave } from '../core/leave';
import { createEntitlementTemplate } from '../core/entitlement-template';
import { leaveBalances, leaveEntitlementBreakdown, listEligibleLeaveTypesFor } from '../core/read';
import { myLeaveDashboard } from '../core/my-leave';
import { createLeaveSharedGroup } from '../core/leave-shared-group';
import { holdsNothingOfItsOwn, isPoolBorrower } from '../lib/shared-leave-balance';
import { planSharedGroupCeilings } from '../lib/shared-leave-pool';
import { entitlementStatusNeedsNotice } from '../lib/entitlement-status';
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

/** The leave year the fixture opens, and the day the screen is read on. Inside one cycle, deliberately: the
 *  CARD's figures are cycle-scoped even though the row's are the whole ledger. */
const YEAR = 2026;
const TODAY = '2026-09-26';
const ASOF = '2026-12-31';

/**
 * THE REPORTER'S OWN BAND, and the reason this file needs entitlement tables at all: 3 days granted, a
 * Maximum Balance of 0 that clamps them to nothing, and the accrual row written anyway (r196, r209). The row
 * reads 0.00 four times over while `eligibleDays` is 3 and the status is notice-bearing.
 */
const CAPPED_TO_NOTHING = [{ fromYears: 0, toYears: null, days: 3, carryForwardDays: 0, maxBalanceDays: 0 }];

async function table(
  ctx: ReturnType<typeof adminCtx>,
  leaveTypeId: string,
  name: string,
  bands: { fromYears: number; toYears: number | null; days: number; carryForwardDays: number; maxBalanceDays: number | null }[],
) {
  await createEntitlementTemplate(ctx, { leaveTypeId, name, validFrom: `${YEAR}-01-01`, serviceBands: bands });
}

/** An ad-hoc grant, the way HR actually puts a day on one person's type: an ADJUSTMENT row, inside the cycle
 *  the card is read in, so it reaches the card and not only the row. */
async function adjust(employmentId: string, leaveTypeId: string, days: number) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'adjustment',
    days: days.toFixed(2),
    effectiveOn: `${YEAR}-03-01`,
  });
}

/** The card as the employee's own screen builds it — `myLeaveDashboard`, not the raw row, because the notice
 *  and the Entitlement figure come from the BREAKDOWN and only exist at this level. */
async function cards(ctx: ReturnType<typeof adminCtx>, employmentId: string) {
  return (await myLeaveDashboard(ctx, employmentId, { today: TODAY, locale: 'en' })).cards;
}

/**
 * PRODUCTION'S SHAPE, SMALL — all seven members of "Special Leave" IN THE STATE PRODUCTION IS ACTUALLY IN,
 * plus a control arm. Every figure below comes from the leave year being OPENED over a real entitlement table,
 * not from a hand-written ledger row, because the whole question (f) asks is what the table says while the
 * ledger says nothing:
 *   · `sp`   — the pot, a 10-day table (production: SP, 800.00 / 80 employments = 10 each). NOT a group
 *              member, which is production's arrangement: the pointers point INTO it from outside the group;
 *   · `cpl`, `ndl` — `balance_source_type_id` → `sp`, and the capped band. Folded by the POINTER, whatever
 *              they hold;
 *   · `mrl`  — the same 3 days with NO cap, so the year-open really grants them (production: MRL, 177.00
 *              across 59 employments = 3 × 59). Folded by NEITHER reason;
 *   · `cgl`, `exm`, `gd`, `std` — `{days: 3, maxBalanceDays: 0}`: the table grants 3, the cap clamps it to
 *              0.00, the accrual row is written anyway (production: 0.00 each, six types, r196/r209). Folded
 *              by the BALANCE reason — and each card must return the day it is granted a day;
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
  // ⚠️ THIS FIXTURE BUILDS THE CAPPED SHAPE — {days: 3, maxBalanceDays: 0}. It is a real state and the
  // gate must fold it, but it is NOT the reporter's. MEASURED ON PRODUCTION 2026-09-26: CGL, EXM, GD and
  // STD have ZERO entitlement templates and a NULL max_balance_days, so they are not
  // `capped_by_max_balance` — that status needs a table with a cap. The reporter's actual shape is
  // covered by its own case at the end of this file ("the shape the reporter's four are really in"),
  // added after a comment asserting the capped shape turned out never to have been checked.
  for (const t of [cpl, ndl, cgl, exm, gd, std]) await table(ctx, t, 'Special — all staff', CAPPED_TO_NOTHING);
  await table(ctx, mrl, 'Marriage — all staff', [
    { fromYears: 0, toYears: null, days: 3, carryForwardDays: 0, maxBalanceDays: null },
  ]);
  await table(ctx, sp, 'Special Leave — all staff', [
    { fromYears: 0, toYears: null, days: 10, carryForwardDays: 0, maxBalanceDays: null },
  ]);
  await adjust(emp.employmentId, loose, 14);
  const group = await createLeaveSharedGroup(ctx, {
    name: 'Special Leave',
    totalLimitDays: 10,
    maxDaysPerApplication: 3,
    leaveTypeIds: [cpl, ndl, mrl, cgl, exm, gd, std],
    essPlacement: 'primary',
  });
  // ⚠️ THE STEP THE FIRST CUT OF THIS FILE DID NOT HAVE. Without it the four empty members are
  // `no_entitlement_table` and nothing here is production's case.
  await openLeaveYear(ctx, { year: YEAR });
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
    // 3.00, because the year-open granted its uncapped table — production's 177.00 is this figure × 59.
    expect(mrlRow!.balance, 'and the card must carry its own days, not a pooled or folded zero').toBe(3);
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

    await adjust(employmentId, gd, 1);

    const rows = await leaveBalances(ctx, employmentId, 'en');
    const gdRow = rows.find((r) => r.leaveTypeId === gd);
    expect(gdRow, 'and back the moment it holds something — nobody un-hid anything').toBeDefined();
    expect(gdRow!.balance, 'with the granted day on it').toBe(1);
    expect(holdsNothingOfItsOwn(gdRow!), 'the condition that hid it no longer holds').toBe(false);
  });

  it('a PENDING request is enough on its own — the row need not hold a balance', async () => {
    const { ctx, std, employmentId } = await fixture();
    expect(await cardIds(ctx, employmentId), 'hidden while nothing at all is on the row').not.toContain(std);

    // Nothing on the ledger but a 0.00 accrual row: only an undecided request, which `pending` carries. The card must show,
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
    await table(ctx, sp, 'Special Leave — all staff', [
      { fromYears: 0, toYears: null, days: 10, carryForwardDays: 0, maxBalanceDays: null },
    ]);
    await table(ctx, exm, 'Special — all staff', CAPPED_TO_NOTHING);
    // Placement defaults to hidden (migration 0438): the out-of-the-box state, in which nothing folds because
    // the group draws no card to absorb anything — including the empty member, whose card is the only place
    // its (future) days could ever appear.
    await createLeaveSharedGroup(ctx, { name: 'Special Leave', totalLimitDays: 10, leaveTypeIds: [cpl, exm] });
    await openLeaveYear(ctx, { year: YEAR });

    const ids = await cardIds(ctx, emp.employmentId);
    expect(ids, 'the borrower keeps its card: no pooled card exists to absorb it').toContain(cpl);
    expect(ids, 'and so does the empty member').toContain(exm);
    // …AND SO DOES ITS EXPLANATION. The out-of-the-box tenant is the one that still gets the r209 sentence
    // over a 0.00 it cannot otherwise account for, and no part of r343 reaches it.
    const exmCard = (await cards(ctx, emp.employmentId)).find((c) => c.leaveTypeId === exm)!;
    expect(exmCard.entitlementStatus, 'the capped table is what its 0.00 is').toBe('capped_by_max_balance');
    expect(entitlementStatusNeedsNotice(exmCard.entitlementStatus), 'and the caption saying so is printed').toBe(true);
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

describe('1478c281 · (f) WHAT THE FOLDED CARD WAS CARRYING, AND WHAT STILL CARRIES IT', () => {
  /**
   * ⚠️ WHY THIS BLOCK EXISTS, AND IT IS NOT A HAPPY ONE. `holdsNothingOfItsOwn` reads FOUR LEDGER FIGURES. The
   * card is not built from those four — core/my-leave.ts builds it from `leaveEntitlementBreakdown`, so it also
   * prints an ENTITLEMENT row (`eligibleDays`) and the 31e39d74 / r209 ENTITLEMENT-STATUS NOTICE, the one screen
   * element whose entire purpose is to say why a type reads 0.00. A row can therefore be four zeros and still
   * have had a card worth reading. On the reporter's account it IS: `{days: 3, maxBalanceDays: 0}` prints
   * "Entitlement 3.00", "Balance 0.00" and an amber caption.
   *
   * So the fold does not remove a blank card; it removes an explained zero. That is the cost of what the
   * reporter approved in 1478c281, and it is recorded here rather than left for someone to rediscover from a
   * support question. The two cases below are the two halves of the honest answer: what goes, and what never
   * goes.
   */
  it('the four folded members were NOT four blank zeros — a 3-day table and its caption go with the card', async () => {
    const { ctx, cgl, exm, gd, std, mrl, employmentId } = await fixture();

    // What the row says — the four figures the gate reads, and all it reads.
    const rows = await leaveBalances(ctx, employmentId, 'en', { includeHidden: true });
    for (const [id, label] of [[cgl, 'CGL'], [exm, 'EXM'], [gd, 'GD'], [std, 'STD']] as const) {
      const row = rows.find((r) => r.leaveTypeId === id)!;
      expect(holdsNothingOfItsOwn(row), `${label}: the ledger holds nothing, which is why it folds`).toBe(true);

      // …and what the CARD would have said, which is a different and larger thing. If this ever reads
      // `granted`/false, the fold has become cheap and the comment on `holdsNothingOfItsOwn` must change with it.
      const bd = await leaveEntitlementBreakdown(ctx, employmentId, id, ASOF, 'en');
      expect(bd!.eligibleDays, `${label}: the table grants 3 days`).toBe(3);
      expect(bd!.currentYearEntitlement, `${label}: and the Maximum Balance of 0 clamps them to nothing`).toBe(0);
      expect(bd!.entitlementStatus, `${label}: which is the state r209 exists to announce`).toBe('capped_by_max_balance');
      expect(
        entitlementStatusNeedsNotice(bd!.entitlementStatus),
        `${label}: so the card we are folding away carried an explanatory notice, not silence`,
      ).toBe(true);
    }

    // THE CONSEQUENCE, ON THE EMPLOYEE'S OWN SCREEN: no card, so no notice. Stated as a fact about the screen,
    // because "the notice still resolves" is true and beside the point.
    const own = await cards(ctx, employmentId);
    const shown = own.map((c) => c.leaveTypeId);
    for (const [id, label] of [[cgl, 'CGL'], [exm, 'EXM'], [gd, 'GD'], [std, 'STD']] as const) {
      expect(shown, `${label}: folded, and its explanation is folded with it`).not.toContain(id);
    }
    // HR still has both — 994a5287: folding is a self-service display decision, so the misconfiguration this
    // caption reports is still visible to the only people who can fix it.
    expect(rows.map((r) => r.leaveTypeId), 'the type is still on HR screens').toContain(cgl);
    // And the keeper's card is a GRANTED one, so nothing here is claiming Marriage Leave needs a caption.
    const mrlCard = own.find((c) => c.leaveTypeId === mrl)!;
    expect(mrlCard.entitlementStatus, 'the uncapped table really granted its days').toBe('granted');
    expect(entitlementStatusNeedsNotice(mrlCard.entitlementStatus), 'so it has nothing to explain').toBe(false);
  });

  /**
   * ⚠️ THE INVARIANT THIS FIX PASS OWES: THE NOTICE IS NEVER DROPPED FROM A CARD THAT STILL RENDERS. The fold
   * removes whole rows and touches no notice logic, so the caption can only ever leave WITH its card — and the
   * moment a member holds anything of its own, it has both back. A later reader who tries to answer the problem
   * above by folding on "nothing but a caption", or by suppressing the caption for group members instead of the
   * card, breaks this case.
   */
  it('a capped member that holds two days by adjustment keeps its card AND the caption explaining its 0.00', async () => {
    const { ctx, cgl, employmentId } = await fixture();
    expect((await cards(ctx, employmentId)).map((c) => c.leaveTypeId), 'folded while the ledger is empty').not.toContain(cgl);

    // The same `{days: 3, maxBalanceDays: 0}` table, unchanged — only the ledger moves.
    await adjust(employmentId, cgl, 2);

    const card = (await cards(ctx, employmentId)).find((c) => c.leaveTypeId === cgl);
    expect(card, 'two days of its own, so the card is back').toBeDefined();
    expect(card!.balance, 'carrying them').toBe(2);
    expect(card!.entitlement, 'and the table behind them').toBe(3);
    expect(card!.entitlementStatus, 'with the status unchanged by any of this').toBe('capped_by_max_balance');
    expect(
      entitlementStatusNeedsNotice(card!.entitlementStatus),
      'AND THE SENTENCE THAT EXPLAINS WHY 3 GRANTED DAYS ARE WORTH 2 — a rendering card never loses its notice',
    ).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // THE SHAPE THE REPORTER'S FOUR ARE REALLY IN — no table at all
  //
  // Everything above builds `{days: 3, maxBalanceDays: 0}`, because an earlier comment in this round
  // said the reporter's four carried such a table. That was never checked, and it is wrong. MEASURED ON
  // PRODUCTION 2026-09-26: CGL, EXM, GD and STD have ZERO entitlement_template rows and a NULL
  // max_balance_days, so `capped_by_max_balance` is not reachable for them — that status needs a table
  // with a cap. They hold nothing because nothing was ever granted.
  //
  // The gate reads four ledger figures and folds on four zeros, so it folds BOTH shapes — but a fixture
  // that only ever built the wrong one would prove nothing about the employees this item was raised for.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  it("the shape the reporter's four are really in: NO entitlement table, and the card still folds", async () => {
    const ctx = adminCtx(b);
    const bare = await leaveTypeRow('Bare Member');
    const pool = await leaveTypeRow('Bare Pool');
    const emp = await hireEmployee(ctx, {
      person: { fullName: 'Bare Member Holder', primaryEmail: `r343b_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2020-01-01',
    });
    // The POOL gets a table; the MEMBER deliberately gets none — production's shape.
    await table(ctx, pool, 'Bare Pool — all staff', [
      { fromYears: 0, toYears: null, days: 10, carryForwardDays: 0, maxBalanceDays: null },
    ]);
    await createLeaveSharedGroup(ctx, {
      name: 'Bare Special Leave',
      totalLimitDays: 10,
      maxDaysPerApplication: 3,
      leaveTypeIds: [pool, bare],
      essPlacement: 'primary',
    });

    const rows = await leaveBalances(ctx, emp.employmentId, 'en', { includeHidden: true });
    const row = rows.find((r) => r.leaveTypeId === bare);
    // It holds nothing for the reporter's reason — no grant — rather than for the capped-table reason.
    if (row) {
      expect(holdsNothingOfItsOwn(row), 'no table ⇒ nothing accrued, taken, pending or held').toBe(true);
    }
    const bd = await leaveEntitlementBreakdown(ctx, emp.employmentId, bare, ASOF, 'en');
    expect(bd?.eligibleDays ?? 0, 'no table grants nothing — NOT a 3-day table clamped to 0').toBe(0);
    expect(bd?.entitlementStatus, 'and it is not the capped status, which needs a cap to be capped by').not.toBe(
      'capped_by_max_balance',
    );

    // THE POINT: the card folds in this shape too.
    const shown = (await cards(ctx, emp.employmentId)).find((c) => c.leaveTypeId === bare);
    expect(shown, 'a member holding nothing draws no card, whatever the reason it holds nothing').toBeUndefined();
  });
});
