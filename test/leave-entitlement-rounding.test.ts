/**
 * Rounding Method under Earning Method (feedback b81d3c52).
 *
 * HR can pick, PER LEAVE TYPE (on the earning rule), how a CALCULATED entitlement is tidied before it is
 * credited: No Rounding (as-is), Round Up (next whole day) or Round Down (previous whole day). The chosen
 * method is applied as the FINAL step AFTER the earning calculation — the earning maths itself is
 * untouched — and at the SAME point in EVERY engine, always BEFORE the Maximum Balance clamp:
 *   1. the hire grant (core/org.ts)                       — the reporter's mid-year-joiner example;
 *   2. the year-open grant (openLeaveYear);
 *   3. the earned cumulative (accrueEarnedLeave)          — the named "Accrual Process" surface;
 *   4. the recalc kernel's projection (projectExpectedEntitlement);
 *   5. the admin preview (previewEntitlement).
 * Sites 1-4 write/compare the LEDGER, so every ledger-derived display surface (Leave Summary, YTD Entitled,
 * the Entitlement Calculation Breakdown, the employee leave view, Leave Balance) shows the tidied figure
 * with no display-layer change; site 5 keeps the admin preview from ever disagreeing with a real grant.
 *
 * Invariants under test:
 *  (1) applyRounding is whole-day, defensive, and a pass-through for none/unknown/non-finite;
 *  (2) the preview equals the real grant once rounding is on;
 *  (3) the joiner hire grant rounds, and leaveEntitlementBreakdown (ledger-derived) shows the rounded figure;
 *  (4) earned accrual rounds the CUMULATIVE every period — up builds in whole days, down floors a small
 *      early cumulative to 0 (no row) and then builds;
 *  (5) RECALC ON ROUNDING CHANGE (this ticket, reversing the b81d3c52 forward-only decision): a rounding-only
 *      in-place edit re-figures already-granted balances immediately via an ACCRUAL-class row (so the tidied
 *      value lands ON the entitlement figure), turning rounding off restores the raw figure, and downward
 *      rounding DOES claw back already-credited days (the plan's documented caveat) — signed, surfaced honestly;
 *  (6) LEDGER AGREEMENT: with rounding on, a later days-change reproject posts only the intended delta
 *      (the projection rounds too, so no permanent oscillating rounding delta appears);
 *  (7) back-compat: an absent roundingMethod behaves exactly as before this feature existed;
 *  (8) static-source guard: the dropdown-rendering forms (Earning Method + the multi-scope add form) post the
 *      tri-state marker; the others (Carry Forward, Eligibility) post no marker so the writer preserves it.
 *
 * The persistence round-trip through the server actions lives in leave-rounding-persistence.test.ts
 * (it needs the action-layer module mocks); i18n parity for the five new keys is appended to the
 * hardcoded key array in leave-type-general-substeps.test.ts.
 */
import { and, eq, like } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createLeavePolicy, updateLeavePolicy } from '../core/admin';
import { accrueEarnedLeave, openLeaveYear, projectExpectedEntitlement, POLICY_RECALC_REASON_PREFIX } from '../core/leave';
import {
  applyRounding,
  previewEntitlement,
  resolveGradePolicy,
  type GradePolicyRow,
} from '../core/leave-compute';
import { annualEntitlement } from '../localization/my/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));

let b: Base;
const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Rounder', primaryEmail: `round_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

const policy = (p: { annualDays: number; roundingMethod?: string; method?: string; validFrom?: string }) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays,
    method: p.method,
    roundingMethod: p.roundingMethod,
    validFrom: p.validFrom ?? '2026-01-01',
  });

/** All policy-recalc rows for one employment (owner read — bypasses RLS for assertions). */
const recalcRows = (employmentId: string) =>
  owner.db
    .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType, effectiveOn: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        like(schema.leaveLedger.reason, `${POLICY_RECALC_REASON_PREFIX}:%`),
      ),
    );

/** The stored `accrual` JSONB (owner read — bypasses RLS for assertions). */
const readAccrual = async (policyId: string): Promise<Record<string, unknown>> => {
  const [row] = await owner.db
    .select({ accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.id, policyId));
  return (row?.accrual as Record<string, unknown>) ?? {};
};

/** The policy rows for ANNUAL, in the shape the pure resolvers/preview take. */
const policyRows = async (): Promise<GradePolicyRow[]> => {
  const rows = await owner.db
    .select({ gradeId: schema.leavePolicy.gradeId, companyId: schema.leavePolicy.companyId, accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.leaveTypeId, b.annualLeaveTypeId));
  return rows as GradePolicyRow[];
};

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

// ── (1) Pure helper ───────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · applyRounding — whole-day, defensive', () => {
  it("rounds UP to the next whole day (the request's own worked examples)", () => {
    expect(applyRounding(10.9, 'up')).toBe(11);
    expect(applyRounding(10.5, 'up')).toBe(11);
    expect(applyRounding(10.91, 'up')).toBe(11);
    expect(applyRounding(10.01, 'up')).toBe(11);
  });

  it("rounds DOWN to the previous whole day (the request's own worked examples)", () => {
    expect(applyRounding(10.49, 'down')).toBe(10);
    expect(applyRounding(10.1, 'down')).toBe(10);
    expect(applyRounding(10.9, 'down')).toBe(10);
  });

  it('leaves an already-whole value untouched in every mode (rounding is idempotent)', () => {
    for (const m of ['up', 'down', 'none', undefined]) {
      expect(applyRounding(11, m)).toBe(11);
      expect(applyRounding(0, m)).toBe(0);
    }
    expect(applyRounding(applyRounding(10.9, 'up'), 'up')).toBe(11);
  });

  it('No Rounding (and an absent / unrecognised method) passes the value through EXACTLY', () => {
    expect(applyRounding(10.9, 'none')).toBe(10.9);
    expect(applyRounding(10.9, undefined)).toBe(10.9);
    expect(applyRounding(10.9, null)).toBe(10.9);
    // a stale/garbage JSONB value must never silently round — e.g. the UNRELATED pay-component vocabulary
    expect(applyRounding(10.9, 'nearest')).toBe(10.9);
    expect(applyRounding(10.9, 'half_up')).toBe(10.9);
  });

  it('DEFENSIVE: negatives round in the mathematical direction and non-finite values pass through', () => {
    expect(applyRounding(-10.5, 'up')).toBe(-10);
    expect(applyRounding(-10.5, 'down')).toBe(-11);
    expect(Number.isNaN(applyRounding(Number.NaN, 'up'))).toBe(true);
    expect(applyRounding(Number.POSITIVE_INFINITY, 'up')).toBe(Number.POSITIVE_INFINITY);
    expect(applyRounding(Number.NEGATIVE_INFINITY, 'down')).toBe(Number.NEGATIVE_INFINITY);
    // runs inside cron sweeps over hand-written JSONB — a bad value must never throw
    expect(() => applyRounding(undefined as unknown as number, 'up')).not.toThrow();
  });
});

// ── Resolution ────────────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · resolveGradePolicy — rounding rides the WINNING policy row', () => {
  it('surfaces the winning row\'s roundingMethod and never leaks a rejected row\'s', () => {
    const rows: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 10, roundingMethod: 'down' } },
      { gradeId: null, companyId: null, accrual: { annualDays: 14, roundingMethod: 'up' } },
    ];
    // max-days tiebreak picks the 14-day row ⇒ its 'up' wins; the rejected row's 'down' must NOT leak.
    expect(resolveGradePolicy(rows, null, null, 0)).toMatchObject({ days: 14, roundingMethod: 'up' });
  });

  it('a winning row with NO rounding resolves to undefined even when a rejected row has one', () => {
    const rows: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 10, roundingMethod: 'up' } },
      { gradeId: null, companyId: null, accrual: { annualDays: 14 } },
    ];
    expect(resolveGradePolicy(rows, null, null, 0)!.roundingMethod).toBeUndefined();
  });

  it('DEFENSIVE: a garbage stored value resolves to undefined (⇒ No Rounding), never throws', () => {
    const rows: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 14, roundingMethod: 'nearest' } },
    ];
    expect(resolveGradePolicy(rows, null, null, 0)!.roundingMethod).toBeUndefined();
  });
});

// ── (2) Admin preview ─────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · previewEntitlement — the preview can never disagree with the real grant', () => {
  it('rounds preview.days and matches the ledger grant exactly (fractional resolved days + Round Up)', async () => {
    await policy({ annualDays: 10.9, roundingMethod: 'up' });
    const rows = await policyRows();
    const floor = annualEntitlement(0); // EA-1955 statutory floor for a <2y employee

    const pv = previewEntitlement(rows, null, b.companyId, 0, floor);
    // the RAW inputs stay untouched so the UI can still explain which one won…
    expect(pv.policyDays).toBe(10.9);
    expect(pv.floorDays).toBe(floor);
    // …but the headline figure — what actually gets credited — is tidied.
    expect(pv.days).toBe(11);

    // Hire on 1 Jan ⇒ no pro-ration ⇒ the ledger grant IS the entitlement. It must equal the preview.
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(pv.days);
  });

  it('Round Down previews (and grants) the previous whole day', async () => {
    await policy({ annualDays: 10.9, roundingMethod: 'down' });
    const pv = previewEntitlement(await policyRows(), null, b.companyId, 0, annualEntitlement(0));
    expect(pv.days).toBe(10);
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(pv.days);
  });

  it('BACK-COMPAT: with no rounding configured the preview keeps the exact fraction, as today', async () => {
    await policy({ annualDays: 10.9 });
    const pv = previewEntitlement(await policyRows(), null, b.companyId, 0, annualEntitlement(0));
    expect(pv.days).toBe(10.9);
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(10.9);
  });
});

// ── (3) Hire grant — the reporter's mid-year-joiner example ───────────────────────────────────────────
describe("b81d3c52 · joiner hire grant — the reporter's example, end to end", () => {
  // 20 days a year, joining mid-year: the whole-month pro-ration (UNCHANGED by this feature) produces
  // 20 × 7/12 = 11.67, and the Rounding Method then tidies THAT figure.
  const RAW_JOINER_GRANT = 11.67;

  it('BACK-COMPAT: No Rounding credits the exact calculated fraction', async () => {
    await policy({ annualDays: 20 });
    const emp = await hire('2026-06-15');
    expect(await balance(emp.employmentId)).toBe(RAW_JOINER_GRANT);
  });

  it('Round Up credits a WHOLE-day ledger grant, and the ledger-derived breakdown shows it', async () => {
    await policy({ annualDays: 20, roundingMethod: 'up' });
    const emp = await hire('2026-06-15');
    expect(await balance(emp.employmentId)).toBe(12);

    // Entitlement Calculation Breakdown / YTD Entitled are reconstructed from the LEDGER (core/read.ts) —
    // no display-layer change was made, so they show the rounded figure purely because the credit is rounded.
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd!.currentYearEntitlement).toBe(12);
    expect(bd!.totalAvailable).toBe(12);
    expect(bd!.transactions.map((tx) => tx.days)).toEqual([12]);
  });

  it('Round Down credits the previous whole day', async () => {
    await policy({ annualDays: 20, roundingMethod: 'down' });
    const emp = await hire('2026-06-15');
    expect(await balance(emp.employmentId)).toBe(11);
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd!.currentYearEntitlement).toBe(11);
  });
});

// ── Year-open grant ───────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · openLeaveYear — the fresh grant is rounded, the carry-in is NOT', () => {
  it('rounds the year-open grant up while leaving a fractional carry-over intact', async () => {
    // No carry in year 1 (cap 0) ⇒ the 2027 balance is purely the rounded 2027 grant.
    await policy({ annualDays: 12.4, roundingMethod: 'up', validFrom: '2026-01-01' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(13); // hire grant, rounded

    await openLeaveYear(adminCtx(b), { year: 2027 });
    // carry cap defaults to 0 ⇒ all 13 forfeited, then a fresh rounded grant of 13.
    expect(await balance(emp.employmentId)).toBe(13);
  });

  it('DOCUMENTED CAVEAT: a fractional carry-over plus a whole grant still yields a fractional balance', async () => {
    // The carry-in is deliberately NOT rounded — rounding shapes the ENTITLEMENT, not every balance.
    const created = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12.4,
      carryForwardMax: 20,
      roundingMethod: 'down',
      validFrom: '2026-01-01',
    });
    expect(await readAccrual(created.id)).toMatchObject({ roundingMethod: 'down' });

    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(12); // 12.4 floored

    // Post a fractional manual adjustment so the carry-in itself is fractional.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'adjustment',
      days: '0.50',
      effectiveOn: '2026-07-01',
    });
    expect(await balance(emp.employmentId)).toBe(12.5);

    await openLeaveYear(adminCtx(b), { year: 2027 });
    // carry 12.5 (unrounded, under the 20-day cap) + a floored grant of 12 = 24.5 — a fraction survives.
    expect(await balance(emp.employmentId)).toBe(24.5);
  });
});

// ── (4) Accrual Process ───────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · accrueEarnedLeave — the cumulative is rounded every period', () => {
  it('Round Up shows whole days as they build (each period rounds the CUMULATIVE)', async () => {
    await policy({ annualDays: 14, method: 'earned_monthly', roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(0); // earned ⇒ no hire lump

    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-01-15' }); // 14/12 × 1 = 1.17 ⇒ 2
    expect(await balance(emp.employmentId)).toBe(2);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-02-15' }); // 2.33 ⇒ 3
    expect(await balance(emp.employmentId)).toBe(3);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' }); // 3.50 ⇒ 4
    expect(await balance(emp.employmentId)).toBe(4);
  });

  it('Round Down floors a small early cumulative to 0 (NO ledger row), then builds', async () => {
    // annualDays 8 = the EA floor ⇒ entitlement 8, so 1/12 of it is under a day.
    await policy({ annualDays: 8, method: 'earned_monthly', roundingMethod: 'down' });
    const emp = await hire('2026-01-01');

    const r1 = await accrueEarnedLeave(adminCtx(b), { asOf: '2026-01-15' }); // 0.67 ⇒ 0
    expect(r1.granted).toBe(0); // the toGrant > 0 guard writes NOTHING
    expect(await balance(emp.employmentId)).toBe(0);

    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-02-15' }); // 1.33 ⇒ 1
    expect(await balance(emp.employmentId)).toBe(1);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' }); // 2.00 ⇒ 2
    expect(await balance(emp.employmentId)).toBe(2);
  });

  it('BACK-COMPAT: with no rounding the cumulative keeps its fraction, exactly as today', async () => {
    await policy({ annualDays: 14, method: 'earned_monthly' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' });
    expect(await balance(emp.employmentId)).toBe(3.5);
  });
});

// ── (5) Forward-only ──────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · RECALC ON ROUNDING CHANGE — the configured rule reaches already-earned balances', () => {
  it('a rounding-only in-place edit re-figures already-granted balances via an ACCRUAL-class row', async () => {
    const created = await policy({ annualDays: 12.4 });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(12.4);

    // REVERSING the b81d3c52 forward-only decision (this ticket): flipping the dropdown NOW re-figures every
    // already-earned balance to the rounded value straight away — no manual regeneration. The correction is
    // ACCRUAL-class, so it lands ON the entitlement figure (leaveBalances.accrued / breakdown.cycleAccrual),
    // not beside it as a separate adjustment.
    const res = await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 12.4,
      roundingMethod: 'up',
      validFrom: '2026-01-01',
      asOf: '2026-06-30',
    });
    expect(res).toEqual({ affected: 1, totalDelta: 0.6 });
    expect(await balance(emp.employmentId)).toBe(13); // ceil(12.4)
    expect(await readAccrual(created.id)).toMatchObject({ roundingMethod: 'up' });

    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].entryType).toBe('accrual'); // NOT adjustment — the a2c precedent
    expect(Number(rows[0].days)).toBe(0.6);

    // The breakdown's entitlement line itself reads the rounded figure (accrual-class ⇒ cycleAccrual).
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd!.currentYearEntitlement).toBe(13);
    expect(bd!.otherAdjustments).toBe(0); // the correction is NOT a separate adjustment beside the figure

    // Idempotent: an identical re-save computes delta 0 and posts no second row.
    const again = await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 12.4,
      roundingMethod: 'up',
      validFrom: '2026-01-01',
      asOf: '2026-06-30',
    });
    expect(again).toEqual({ affected: 0, totalDelta: 0 });
    expect((await recalcRows(emp.employmentId)).length).toBe(1);
  });

  it('DOWNWARD-ROUNDING CLAWBACK (the plan caveat): switching to Round Down re-figures the earned balance DOWN', async () => {
    const created = await policy({ annualDays: 14, method: 'earned_monthly', roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' }); // 3.5 ⇒ up ⇒ 4
    expect(await balance(emp.employmentId)).toBe(4);

    // The single change-gate cannot enable up-only: turning rounding DOWN re-figures already-credited days
    // to the floored value (3.5 ⇒ 3). This is deliberate and matches the reporter's request (surfaced under
    // GOOD TO KNOW). The correction is a signed ACCRUAL-class row (−1), so the entitlement line drops too.
    const res = await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 14,
      method: 'earned_monthly',
      roundingMethod: 'down',
      validFrom: '2026-01-01',
      asOf: '2026-03-15',
    });
    expect(res).toEqual({ affected: 1, totalDelta: -1 });
    expect(await balance(emp.employmentId)).toBe(3);
    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(rows[0].entryType).toBe('accrual');
    expect(Number(rows[0].days)).toBe(-1);

    // The cron re-run at the SAME date double-counts nothing: its `already` sum sees the accrual-class
    // correction, so cumulative 3 − already 3 = 0 (the correction is not re-granted).
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' });
    expect(await balance(emp.employmentId)).toBe(3);

    // Only FORWARD periods accrue: at 5 months the floored cumulative is 5, so a +2 top-up lands over 3.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-15' }); // 5.83 ⇒ 5
    expect(await balance(emp.employmentId)).toBe(5);
  });

  it('turning rounding OFF (up ⇒ none) restores the exact earned figure (symmetric)', async () => {
    const created = await policy({ annualDays: 12.4 });
    const emp = await hire('2026-01-01');
    await updateLeavePolicy(adminCtx(b), {
      id: created.id, annualDays: 12.4, roundingMethod: 'up', validFrom: '2026-01-01', asOf: '2026-06-30',
    });
    expect(await balance(emp.employmentId)).toBe(13);

    // No marker vs 'none' clear are both a rounding change up ⇒ none; the reproject restores the raw 12.4.
    const off = await updateLeavePolicy(adminCtx(b), {
      id: created.id, annualDays: 12.4, roundingMethod: 'none', validFrom: '2026-01-01', asOf: '2026-06-30',
    });
    expect(off).toEqual({ affected: 1, totalDelta: -0.6 });
    expect(await balance(emp.employmentId)).toBe(12.4);
    expect('roundingMethod' in (await readAccrual(created.id))).toBe(false);
  });
});

// ── (6) Ledger agreement ──────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · LEDGER AGREEMENT — the projection rounds exactly like the engines', () => {
  it('projectExpectedEntitlement returns the ROUNDED figure on the joiner + full-grant branches', async () => {
    await policy({ annualDays: 20, roundingMethod: 'up' });
    const rows = await policyRows();
    const floor = (code: string, years: number) => (code === 'ANNUAL' ? annualEntitlement(years) : 0);

    const joiner = projectExpectedEntitlement(
      { hiredOn: '2026-06-15', leaveCycle: 'calendar', gradeId: null, companyId: b.companyId },
      'ANNUAL',
      rows,
      floor,
      '2026-12-31',
    );
    expect(joiner!.expected).toBe(12); // 11.67 raw ⇒ rounded up, matching the hire grant

    const existing = projectExpectedEntitlement(
      { hiredOn: '2020-01-01', leaveCycle: 'calendar', gradeId: null, companyId: b.companyId },
      'ANNUAL',
      rows,
      floor,
      '2026-12-31',
    );
    expect(existing!.expected).toBe(20); // already whole — rounding is a no-op, not a drift source
  });

  it('projectExpectedEntitlement rounds the EARNED branch too', async () => {
    await policy({ annualDays: 14, method: 'earned_monthly', roundingMethod: 'up' });
    const proj = projectExpectedEntitlement(
      { hiredOn: '2026-01-01', leaveCycle: 'calendar', gradeId: null, companyId: b.companyId },
      'ANNUAL',
      await policyRows(),
      (code: string, years: number) => (code === 'ANNUAL' ? annualEntitlement(years) : 0),
      '2026-03-15',
    );
    expect(proj!.expected).toBe(4); // 3.5 ⇒ up ⇒ 4 — identical to what accrueEarnedLeave credits
  });

  it('a later days-change reproject posts ONLY the intended delta — no oscillating rounding delta', async () => {
    const created = await policy({ annualDays: 12.4, roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(13); // ceil(12.4)

    // Correct the days upward. The projection rounds (ceil(14.6) = 15) exactly as the engines do, so the
    // delta is the clean +2. Without rounding in the kernel it would be 14.6 − 13 = 1.6 and the ledger
    // would permanently disagree with what a fresh grant produces.
    const up = await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 14.6,
      roundingMethod: 'up',
      validFrom: '2026-01-01',
      asOf: '2026-06-30',
    });
    expect(up).toEqual({ affected: 1, totalDelta: 2 });
    expect(await balance(emp.employmentId)).toBe(15);

    // Idempotent: an identical re-save computes delta 0 and posts nothing (no oscillation).
    const again = await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 14.6,
      roundingMethod: 'up',
      validFrom: '2026-01-01',
      asOf: '2026-06-30',
    });
    expect(again).toEqual({ affected: 0, totalDelta: 0 });
    expect(await balance(emp.employmentId)).toBe(15);
  });
});

// ── (7) Byte-identical No-Rounding storage ────────────────────────────────────────────────────────────
describe('b81d3c52 · storage — a No-Rounding policy stores NOTHING new', () => {
  it('omits the key entirely for none / absent / garbage, and persists only up|down', async () => {
    const absent = await policy({ annualDays: 12 });
    expect('roundingMethod' in (await readAccrual(absent.id))).toBe(false);

    const none = await policy({ annualDays: 12, roundingMethod: 'none', validFrom: '2027-01-01' });
    expect('roundingMethod' in (await readAccrual(none.id))).toBe(false);

    const garbage = await policy({ annualDays: 12, roundingMethod: 'nearest', validFrom: '2028-01-01' });
    expect('roundingMethod' in (await readAccrual(garbage.id))).toBe(false);

    const real = await policy({ annualDays: 12, roundingMethod: 'down', validFrom: '2029-01-01' });
    expect(await readAccrual(real.id)).toMatchObject({ roundingMethod: 'down' });
  });

  it('updateLeavePolicy can clear a stored method back to No Rounding', async () => {
    const created = await policy({ annualDays: 12, roundingMethod: 'up' });
    expect(await readAccrual(created.id)).toMatchObject({ roundingMethod: 'up' });
    await updateLeavePolicy(adminCtx(b), {
      id: created.id,
      annualDays: 12,
      roundingMethod: 'none',
      validFrom: '2026-01-01',
      asOf: '2026-06-30',
    });
    expect('roundingMethod' in (await readAccrual(created.id))).toBe(false);
  });
});

// ── (8) Static source guard ───────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · UI source guard — the dropdown-rendering forms post the tri-state marker; the others preserve', () => {
  const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
  const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
  const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');

  it('EarningMethodForm renders the Rounding Method select AND posts the tri-state marker', () => {
    const form = panelSrc.slice(panelSrc.indexOf('function EarningMethodForm'), panelSrc.indexOf('function CarryPolicyForm'));
    expect(form).toContain("name=\"roundingMethod\"");
    expect(form).toContain("t('subStep.roundingMethodLabel')");
    expect(form).toContain("t('subStep.roundingNone')");
    expect(form).toContain("t('subStep.roundingUp')");
    expect(form).toContain("t('subStep.roundingDown')");
    expect(form).toContain("t('subStep.roundingHelp')");
    // 9816a5ad step 2: the initial value comes from the leave TYPE's own rules, not a policy row.
    //
    // 9f5164d8 made the select CONTROLLED rather than defaultValue'd, and the reason is behavioural, not
    // stylistic: the "Customize decimal thresholds" checkbox and the threshold table only render under
    // 'nearest_half', and the worked example recomputes as the method changes. An uncontrolled select
    // cannot drive either. The SEED is unchanged — `roundingMethodValue(rules.roundingMethod)` is still
    // what the state starts from — so what an administrator sees on load is byte-identical.
    expect(form).toContain("value={rounding}");
    expect(form).toContain('useState<LeaveRoundingMethod>(roundingMethodValue(rules.roundingMethod))');
    // renders the dropdown ⇒ posts the marker so 'none' CLEARS and up/down SET.
    expect(form).toContain('name="roundingMethodRendered"');
  });

  it('CarryPolicyForm posts NO marker and NO hidden roundingMethod input — the writer preserves it', () => {
    const form = panelSrc.slice(panelSrc.indexOf('function CarryPolicyForm'));
    const body = form.slice(0, form.indexOf('</form>'));
    // tri-state (this ticket): the fragile hidden pass-through input is gone; absent marker ⇒ preserve.
    expect(body).not.toContain('name="roundingMethod"');
    expect(body).not.toContain('name="roundingMethodRendered"');
  });

  it('the Eligibility inline EDIT form posts NO marker and NO hidden roundingMethod input either', () => {
    const edit = panelSrc.slice(panelSrc.indexOf("action={updatePolicyAction}"));
    const body = edit.slice(0, edit.indexOf('</form>'));
    expect(body).not.toContain('name="roundingMethod"');
    expect(body).not.toContain('name="roundingMethodRendered"');
  });

  it('the multi-scope ADD form renders the dropdown and posts the marker', () => {
    const add = panelSrc.slice(panelSrc.indexOf('action={createPolicyAction}'));
    const body = add.slice(0, add.indexOf('</form>'));
    expect(body).toContain('name="roundingMethod"');
    expect(body).toContain('name="roundingMethodRendered"');
  });

  it('the Entitlements page populates roundingMethod onto the panel policy', () => {
    expect(pageSrc).toContain('roundingMethod: acc?.roundingMethod');
  });

  it('every action that writes rounding threads the SAME normalized field', () => {
    expect(actionsSrc).toContain('const roundingMethodField =');
    // createLeavePolicyAction + updateLeavePolicyAction read it inline, and 9816a5ad step 2 added a THIRD
    // caller: setLeaveTypeRulesAction, which writes the consolidated rule onto the leave type. The count
    // is pinned so a fourth writer cannot appear with its own ad-hoc normalization — the whole point of
    // the tri-state helper is that 'none' means CLEAR everywhere, identically.
    expect(actionsSrc.match(/roundingMethod: roundingMethodField\(formData\)/g)?.length).toBe(3);
    expect(actionsSrc).toContain('roundingMethod: rounding,');
  });
});
