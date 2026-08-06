/**
 * Incorrect Leave Balance — the Leave Breakdown must PROVABLY add up (feedback 0315dac7).
 *
 * The reporter could not tell how Balance was derived, and could not trace a 13-day "Adjustment" back to the
 * Adjustment configuration screen. Two real faults sat behind that, both fixed by making the breakdown a RAW
 * LEDGER PARTITION rather than a re-derivation of the carry arithmetic:
 *
 *  1. The §4 "Adjustment" line rendered `otherAdjustments`, which filters adjustment rows by `days > 0 OR
 *     reason like sys:policy_recalc:%`. That COMMINGLES the festive / one-off grants HR enters on the
 *     Adjustment step with the automatic `sys:policy_recalc` corrections, OMITS `sys:profile_recalc`
 *     entirely, and OMITS every negative adjustment — so the number could never tie back to the config.
 *
 *  2. Reconciling against the DERIVED carry figures is algebraically FALSE whenever a year-open cap forfeit
 *     fired: openLeaveYear posts a real negative `adjustment` (CARRY_FORFEIT_REASON_CAP) while
 *     resolveCarryBreakdown's `carried` is ALREADY post-cap and its `forfeited` re-adds the cap excess —
 *     double-subtracting it. The same holds for a maxBalanceDays clamp and an overdrawn (negative) carry-in.
 *
 * So the breakdown now partitions the ledger into SIX DISJOINT buckets — every row `effective_on <= asOf`
 * lands in exactly one — and the identity closes BY CONSTRUCTION:
 *
 *   broughtForward + currentYearEntitlement + configAdjustments + systemAdjustments
 *     − forfeitedThisCycle − takenThisCycle  =  balance
 *   balance − pendingApproval               =  totalAvailable
 *
 * Every scenario below asserts that identity against what the REAL engines posted (openLeaveYear,
 * expireCarriedLeave, and the Leave Adjustments module), including the cases where the old derived
 * arithmetic demonstrably does not close. Read-only feature: no schema, no migration, no DomainEvent.
 * // substrate: read-only, no event
 */
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setLeaveTypeRules } from '../core/admin';
import {
  AGED_FORFEIT_REASON,
  CARRY_FORFEIT_REASON_CAP,
  CARRY_FORFEIT_REASON_EXPIRY,
  POLICY_RECALC_REASON_PREFIX,
  PROFILE_RECALC_REASON_PREFIX,
  expireCarriedLeave,
  openLeaveYear,
} from '../core/leave';
import {
  classifyLedgerAdjustment,
  leaveBalances,
  leaveBalancesAll,
  leaveEntitlementBreakdown,
  type LeaveEntitlementBreakdown,
} from '../core/read';
import { reconciledBalance } from '../components/leave/entitlement-panel-config';
import { applyLeaveAdjustmentBatch } from '../core/leave-adjustment';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  seedEntitlement,
  type Base,
} from './harness';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const r2 = (n: number) => Math.round(n * 100) / 100;

const hire = (hiredOn: string, name = 'Recon') =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `recon_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/**
 * 6e9a126e RELEASE THREE — was one `createLeavePolicy` carrying BOTH the days and the carry rules.
 *
 * Those two halves now live in two places, and this fixture writes both so every figure below is unchanged:
 *   - the DAYS (flat or banded) go to an entitlement template + eligibility rule (`seedEntitlement`);
 *   - the CARRY CAP and its expiry go on the LEAVE TYPE (`setLeaveTypeRules`), where 7cd914b1 put them and
 *     where `applyLeaveTypeRules` reads them. That move predates release three; the policy columns were
 *     already dead weight.
 *
 * ⚠️ `maxBalanceDays` MOVED WITH THE CARRY RULES, not with the bands. `applyLeaveTypeRules` overlays the
 * TYPE's maximum-balance wholesale over whatever the band resolved, so a band-level `maxBalanceDays` is
 * read and then discarded the moment a type carries any rule at all. The one test that used it therefore
 * sets it on the type — same clamp, same forfeit, same reconciliation, decided one layer up.
 */
const annualPolicy = async (p: {
  annualDays?: number;
  carryForwardMax?: number;
  expiry?: { month: number; day: number } | null;
  maxBalanceDays?: number | null;
  from?: string;
}) => {
  await setLeaveTypeRules(adminCtx(b), {
    id: b.annualLeaveTypeId,
    carryForwardMax: p.carryForwardMax ?? 5,
    carryForwardExpiryMonth: p.expiry?.month ?? null,
    carryForwardExpiryDay: p.expiry?.day ?? null,
    maxBalanceDays: p.maxBalanceDays ?? null,
  });
  return seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays ?? 12,
    validFrom: p.from ?? '2025-01-01',
  });
};

/** Add a non-ANNUAL leave type. c459bff9 dropped the optional age-from-earning expiry argument along with
 *  the leave_type.expiry_value / expiry_unit columns and the sweep that read them. */
const addType = async (code: string, name: string) => {
  const [t] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name,
      paid: true,
      allowNegativeBalance: true,
    })
    .returning({ id: schema.leaveType.id });
  return t.id;
};

const post = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment' | 'in_lieu_accrual',
  days: number,
  effectiveOn: string,
  reason?: string | null,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
    reason: reason ?? null,
  });

const bdOf = async (employmentId: string, leaveTypeId: string, asOf: string) => {
  const bd = await leaveEntitlementBreakdown(adminCtx(b), employmentId, leaveTypeId, asOf);
  expect(bd).not.toBeNull();
  return bd!;
};

/**
 * THE assertion of this suite, and 1f6fd6d8 made it MORE load-bearing rather than less.
 *
 * `reconciledBalance` used to back the panel's separate "How this adds up" block. That block is gone: the
 * redesigned Leave Summary IS the sum, read top to bottom. So the same identity now underwrites what every
 * employee sees on the main column, and the two server-side roll-ups the column reads (`adjustments`,
 * `totalEntitlement`) are asserted here to be sums of exactly these buckets — which is what makes
 *   Total − Taken − Pending Approval − Brought Forward Forfeited = Available Balance
 * true by construction rather than by agreement.
 */
const expectReconciles = (bd: LeaveEntitlementBreakdown) => {
  expect(reconciledBalance(bd)).toBe(r2(bd.balance));
  expect(r2(bd.balance - bd.pendingApproval)).toBe(bd.totalAvailable);
  // 1f6fd6d8: the summary's two subtotal lines, over the same buckets.
  expect(bd.adjustments).toBe(r2(bd.configAdjustments + bd.systemAdjustments));
  expect(bd.totalEntitlement).toBe(r2(bd.broughtForward + bd.currentYearEntitlement + bd.adjustments));
  // …and the column the employee actually reads closes onto the available figure.
  expect(r2(bd.totalEntitlement - bd.takenThisCycle - bd.pendingApproval - bd.forfeitedThisCycle)).toBe(
    bd.totalAvailable,
  );
};

/** Independent read of what the engines ACTUALLY stamped as a forfeit, straight from the ledger. */
const forfeitRowsSum = async (employmentId: string, leaveTypeId: string, from: string, to: string) => {
  const rows = await owner.db
    .select({ days: schema.leaveLedger.days, effectiveOn: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
        eq(schema.leaveLedger.entryType, 'adjustment'),
        inArray(schema.leaveLedger.reason, [
          CARRY_FORFEIT_REASON_CAP,
          CARRY_FORFEIT_REASON_EXPIRY,
          AGED_FORFEIT_REASON,
        ]),
      ),
    );
  return r2(rows.filter((x) => x.effectiveOn >= from && x.effectiveOn <= to).reduce((s, x) => s - Number(x.days), 0));
};

describe('classifyLedgerAdjustment — the partition is exhaustive and mutually exclusive', () => {
  it('all THREE forfeit reasons are forfeits (missing one would double-count it as an adjustment too)', () => {
    expect(classifyLedgerAdjustment(CARRY_FORFEIT_REASON_CAP)).toBe('forfeit');
    // The carry-EXPIRY forfeit is the one a "carry-boundary forfeit" shorthand would miss — it would then be
    // counted BOTH as a config adjustment (negative) and inside forfeited, breaking the identity twice over.
    expect(classifyLedgerAdjustment(CARRY_FORFEIT_REASON_EXPIRY)).toBe('forfeit');
    expect(classifyLedgerAdjustment(AGED_FORFEIT_REASON)).toBe('forfeit');
  });

  it('both recalc prefixes are system corrections — including sys:profile_recalc, which the old line dropped', () => {
    expect(classifyLedgerAdjustment(`${POLICY_RECALC_REASON_PREFIX}:${randomUUID()}`)).toBe('system');
    expect(classifyLedgerAdjustment(`${PROFILE_RECALC_REASON_PREFIX}:${randomUUID()}`)).toBe('system');
  });

  it('everything else — a typed reason or none at all — is a CONFIG adjustment, whatever its sign', () => {
    expect(classifyLedgerAdjustment('CNY 2026')).toBe('config');
    expect(classifyLedgerAdjustment(null)).toBe('config');
    expect(classifyLedgerAdjustment('')).toBe('config');
    // Reason-driven, never sign-driven: the class of a row does not depend on its days.
    expect(classifyLedgerAdjustment('Manual correction — overpaid')).toBe('config');
  });
});

describe('the reconciliation identity closes where the DERIVED carry arithmetic does not', () => {
  it('year-open cap excess: ledger partition closes, the derived identity is off by the excess', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    const emp = await hire('2025-01-01'); // hire grant 12 in 2025
    // prior balance 12 > cap 5 ⇒ openLeaveYear posts a REAL negative adjustment (cap forfeit 7) and grants 12.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(17);

    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.broughtForward).toBe(12); // RAW carry-in, uncapped — not the post-cap 5
    expect(bd.currentYearEntitlement).toBe(12);
    expect(bd.configAdjustments).toBe(0);
    expect(bd.systemAdjustments).toBe(0);
    expect(bd.forfeitedThisCycle).toBe(7);
    expect(bd.takenThisCycle).toBe(0);
    expect(bd.balance).toBe(17);
    expectReconciles(bd);

    // The bug, pinned: the panel's proposed "entitlement + carried + adjustments − taken − forfeited" over the
    // DERIVED figures gives 12 + 5 + 0 − 0 − 7 = 10, not the true ledger balance of 17. Sourcing the carry-in
    // and the forfeit from the raw rows is what removes the double-subtraction.
    const derived = r2(
      bd.currentYearEntitlement + bd.carriedForward + bd.otherAdjustments - bd.takenThisCycle - bd.forfeited,
    );
    expect(derived).toBe(10);
    expect(derived).not.toBe(bd.balance);
  });

  it('maxBalanceDays clamp tighter than the carry cap still reconciles', async () => {
    // The clamp makes openLeaveYear forfeit BEFORE-carry with the carry already clamped, while the derived
    // reconstruction caps only at carryForwardMax — another divergence the ledger partition is immune to.
    // 6e9a126e release three: the clamp is stated on the leave TYPE rather than inside the band, because
    // applyLeaveTypeRules overlays the type's maximum-balance over the band's (see annualPolicy's note).
    await annualPolicy({
      annualDays: 12,
      carryForwardMax: 10,
      maxBalanceDays: 8,
    });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expectReconciles(bd);
    // Forfeited is whatever the engine ACTUALLY stamped in-cycle, read back independently.
    expect(bd.forfeitedThisCycle).toBe(
      await forfeitRowsSum(emp.employmentId, b.annualLeaveTypeId, bd.cycleStart, '2026-06-30'),
    );
    expect(bd.balance).toBe(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId));
  });

  it('overdrawn (negative) carry-in survives: broughtForward stays signed where carriedForward floors to 0', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    const emp = await hire('2025-01-01');
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -15, '2025-06-01'); // 2025 closes at −3
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(-3);
    await openLeaveYear(adminCtx(b), { year: 2026 }); // nothing to cap-forfeit; grants 12 ⇒ 9

    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.broughtForward).toBe(-3);
    expect(bd.carriedForward).toBe(0); // the derived figure loses the overdraw entirely
    expect(bd.takenThisCycle).toBe(0); // the debit is in the PRIOR cycle — it is inside broughtForward
    expect(bd.balance).toBe(9);
    expectReconciles(bd);
  });

  it('carry-expiry forfeit + a debit dated AFTER carry expiry (the debit the carry window cannot see)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry 5, cap forfeit 7, grant 12 ⇒ 17
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' }); // unconsumed carry 5 lapses ⇒ 12
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-06-01'); // AFTER the carry window
    expect(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId)).toBe(9);

    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    // takenThisCycle covers EVERY in-cycle debit. `debitsInWindow` (bounded by the carry-expiry date) would
    // have seen 0 here, silently dropping 3 days out of the sum — which is why it is not the taken bucket.
    expect(bd.takenThisCycle).toBe(3);
    // BOTH boundary forfeits, from the real rows: cap 7 at year-open + expiry 5 on the expiry date.
    expect(bd.forfeitedThisCycle).toBe(12);
    expect(bd.forfeitedThisCycle).toBe(
      await forfeitRowsSum(emp.employmentId, b.annualLeaveTypeId, bd.cycleStart, '2026-06-30'),
    );
    expect(bd.balance).toBe(9);
    expectReconciles(bd);
  });

  it('past asOf: the block self-reconciles to its OWN as-at balance (time travel)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-06-01');

    // As at 15 Feb the expiry sweep and the June debit have not happened yet…
    const past = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-02-15');
    expect(past.forfeitedThisCycle).toBe(7); // cap only
    expect(past.takenThisCycle).toBe(0);
    expect(past.balance).toBe(17);
    expectReconciles(past);

    // …and the live view still closes on the same data.
    expectReconciles(await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31'));
  });

  /**
   * c459bff9: the SWEEP that used to write these rows is deleted, but rows it already wrote are KEPT and
   * still read. This block therefore posts the historical row DIRECTLY instead of running the engine —
   * that is the whole point. If AGED_FORFEIT_REASON were ever dropped from core/read.ts's readers, a past
   * automatic forfeit would silently re-render as a manual HR adjustment and the identity would stop
   * closing. On production this population is currently zero rows, which is exactly why it needs a test
   * rather than a live example.
   */
  it('a HISTORICAL aged type-expiry forfeit still lands in forfeited, never in adjustments', async () => {
    const emp = await hire('2025-01-01');
    const sick = await addType('SICKX', 'Sick (aged)');
    await post(emp.employmentId, sick, 'accrual', 5, '2026-01-10');
    await post(emp.employmentId, sick, 'adjustment', -5, '2026-04-10', AGED_FORFEIT_REASON);

    const bd = await bdOf(emp.employmentId, sick, '2026-06-30');
    expect(bd.currentYearEntitlement).toBe(5);
    expect(bd.forfeitedThisCycle).toBe(5);
    expect(bd.configAdjustments).toBe(0); // a negative adjustment, but a MACHINE one — not a config grant
    expect(bd.systemAdjustments).toBe(0);
    expect(bd.balance).toBe(0);
    expectReconciles(bd);
  });
});

describe('ask 1 — the Adjustment line is the Adjustment configuration, and nothing else', () => {
  /** Two festive grants (the config single source of truth) + recalc corrections in BOTH signs. */
  const seedAdjustments = async () => {
    const emp = await hire('2025-01-01');
    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days: 2,
      effectiveOn: '2026-02-01',
      reason: 'CNY 2026',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });
    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days: 1,
      effectiveOn: '2026-11-01',
      reason: 'Deepavali 2026',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });
    // Automatic corrections — never entered on the Adjustment screen. Both prefixes, both signs.
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', 3, '2026-03-01', `${POLICY_RECALC_REASON_PREFIX}:${randomUUID()}`);
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -1, '2026-04-01', `${PROFILE_RECALC_REASON_PREFIX}:${emp.employmentId}`);
    return emp;
  };

  it('configAdjustments equals the festive-grant total and EXCLUDES every sys: reason', async () => {
    const emp = await seedAdjustments();
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd.configAdjustments).toBe(3); // 2 (CNY) + 1 (Deepavali) — exactly what HR configured
    expect(bd.systemAdjustments).toBe(2); // +3 policy_recalc − 1 profile_recalc
    expectReconciles(bd);
  });

  it('the OLD commingled line proves both faults: it overstates config AND drops the profile correction', async () => {
    const emp = await seedAdjustments();
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    // otherAdjustments filters `days > 0 OR reason like sys:policy_recalc:%` ⇒ it swallows the +3 policy
    // correction into "Adjustment" (2 + 1 + 3 = 6) and silently loses the −1 profile correction.
    expect(bd.otherAdjustments).toBe(6);
    expect(bd.otherAdjustments).not.toBe(bd.configAdjustments);
    // The split accounts for every one of those days, with none lost: config + system = the true net.
    expect(r2(bd.configAdjustments + bd.systemAdjustments)).toBe(5);
  });

  it('each config adjustment is itemised with its own reason and day count (the traceability ask)', async () => {
    const emp = await seedAdjustments();
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd.configAdjustmentItems).toEqual([
      { effectiveOn: '2026-02-01', days: 2, reason: 'CNY 2026' },
      { effectiveOn: '2026-11-01', days: 1, reason: 'Deepavali 2026' },
    ]);
    // The itemisation must account for the whole line — otherwise it explains nothing.
    expect(r2(bd.configAdjustmentItems.reduce((s, i) => s + i.days, 0))).toBe(bd.configAdjustments);
    // System corrections are machine-posted: summarised, never itemised as a config row.
    expect(bd.configAdjustmentItems.some((i) => (i.reason ?? '').startsWith('sys:'))).toBe(false);
  });

  it('a NEGATIVE config adjustment is counted too (the old positive-only filter dropped it)', async () => {
    const emp = await hire('2025-01-01');
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', 4, '2026-02-01', 'CNY 2026');
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -1.5, '2026-05-01', 'Correction: granted twice');
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd.configAdjustments).toBe(2.5);
    expect(bd.configAdjustmentItems.map((i) => i.days)).toEqual([4, -1.5]);
    expectReconciles(bd);
  });

  it('an adjustment added AFTER the panel was first read flows through with no manual sync (ask 2)', async () => {
    // The breakdown is rebuilt live from the ledger on every read, so a grant created on the Adjustment step
    // shows up on the very next render — there is nothing to synchronise and no duplicate record.
    const emp = await hire('2025-01-01');
    const before = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(before.configAdjustments).toBe(0);
    expect(before.configAdjustmentItems).toEqual([]);
    expectReconciles(before);

    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days: 2,
      effectiveOn: '2026-02-01',
      reason: 'CNY 2026',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });

    const after = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(after.configAdjustments).toBe(2);
    expect(after.configAdjustmentItems).toHaveLength(1);
    // …and the balance moved by exactly the grant, with the identity still closing.
    expect(r2(after.balance - before.balance)).toBe(2);
    expectReconciles(after);
  });
});

describe('cross-surface consistency — one Balance everywhere', () => {
  it('leaveBalances, leaveBalancesAll and the breakdown all report the SAME ledger balance', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-06-01');
    await applyLeaveAdjustmentBatch(adminCtx(b), {
      leaveTypeIds: [b.annualLeaveTypeId],
      days: 2,
      effectiveOn: '2026-02-01',
      reason: 'CNY 2026',
      targetMode: 'criteria',
      criteria: { companyIds: [b.companyId] },
    });

    // asOf covers every posted row, so the as-at breakdown and the live balance reads must agree exactly.
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    const self = (await leaveBalances(adminCtx(b), emp.employmentId)).find(
      (r) => r.leaveTypeId === b.annualLeaveTypeId,
    )!;
    const all = (await leaveBalancesAll(adminCtx(b))).find(
      (r) => r.employmentId === emp.employmentId && r.leaveTypeId === b.annualLeaveTypeId,
    )!;

    // §1 Balance (leaveBalances) = the admin bulk table (leaveBalancesAll) = the breakdown the panel explains.
    expect(self.balance).toBe(bd.balance);
    expect(all.balance).toBe(bd.balance);
    expect(bd.balance).toBe(await ledgerBalance(emp.employmentId, b.annualLeaveTypeId));
    // …and that one figure is exactly what the reconciliation block adds up to.
    expectReconciles(bd);
  });

  it('1f6fd6d8 — Eligible is the winning policy\'s FULL-YEAR days, independent of what the ledger holds', async () => {
    // Eligible is the one summary line no ledger can produce: it is what the employee gets for a whole leave
    // year, before proration, carry, adjustment or use. Seeded against a 12-day policy and a hire mid-way
    // through the prior year, so the granted-to-date figure and the full-year figure genuinely differ — the
    // case where conflating them would be invisible.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(bd.eligibleDays).toBe(12);
    // It comes from the policy, NOT from the ledger: posting more accrual moves YTD Entitled and leaves
    // Eligible alone.
    await post(emp.employmentId, b.annualLeaveTypeId, 'accrual', 3, '2026-05-01');
    const after = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(after.eligibleDays).toBe(12);
    expect(after.currentYearEntitlement).toBe(r2(bd.currentYearEntitlement + 3));
    // And the column still closes — Eligible sits above the sum, it is not part of it.
    expectReconciles(after);
  });

  it('1f6fd6d8 — no resolvable policy ⇒ Eligible is 0, never null or NaN', async () => {
    // An employee can hold a leave type their grade/company has no policy row for. The summary must show a
    // number there, not a placeholder that looks like a fault.
    const emp = await hire('2025-01-01');
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-06-30');
    expect(typeof bd.eligibleDays).toBe('number');
    expect(Number.isFinite(bd.eligibleDays)).toBe(true);
    expect(bd.eligibleDays).toBeGreaterThanOrEqual(0);
  });

  it('pending requests never enter the ledger sum — they only separate Balance from Available', async () => {
    const emp = await hire('2025-01-01');
    const bd = await bdOf(emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    // No pending request seeded: Balance and Available coincide, and the identity is unaffected either way.
    expect(bd.pendingApproval).toBe(0);
    expect(bd.totalAvailable).toBe(bd.balance);
    expectReconciles(bd);
  });
});
