/**
 * Restructure Service-Based Leave Entitlements by Company and Grade.
 *
 * The Service Based Entitlements sub-step is a company-driven, by-grade table backed by the SAME leave_policy
 * store. saveServiceEntitlement writes one grade's three service-band figures for a company, and the FIRST
 * save for a company materialises the whole company scope so the ADR-0066 short-circuit can't silently drop
 * the untouched grades to zero.
 *
 * These are the load-bearing correctness assertions the plan requires:
 *  - after editing ONE grade for a company, employees on that company's OTHER grades resolve IDENTICALLY
 *    (proves the seeding neutralises ADR-0066), and a grade with a grade-specific group policy keeps its
 *    own days (faithful full-accrual copy, not a days-only downgrade to the group default);
 *  - a flat grade stays FLAT when its equal tiers are re-saved (no spurious band shape); a graded edit
 *    writes the fixed 0–2 / 2–5 / 5+ three-band shape;
 *  - annualDays is always set (never 0/undefined) — the EA floor / legacy resolution path stays fed;
 *  - an existing exact-scope row edits IN PLACE (no duplicate active dated version);
 *  - an untouched grade's already-granted balance does NOT move (seeded copies reproject to zero delta).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade, createLeavePolicy, saveServiceEntitlement } from '../core/admin';
import { resolveGradePolicy, type GradePolicyRow } from '../core/leave';
import {
  adminCtx,
  closeAll,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
const uniqEmail = () => `sbe_${randomUUID().slice(0, 8)}@t.local`;
const YEAR = new Date().getUTCFullYear();

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

/** All ACTIVE policy rows for the base ANNUAL type, in the shape resolveGradePolicy consumes. */
async function activeRows(): Promise<GradePolicyRow[]> {
  const rows = await owner.db
    .select({
      gradeId: schema.leavePolicy.gradeId,
      companyId: schema.leavePolicy.companyId,
      accrual: schema.leavePolicy.accrual,
    })
    .from(schema.leavePolicy)
    .where(
      and(
        eq(schema.leavePolicy.tenantId, b.tenantId),
        eq(schema.leavePolicy.leaveTypeId, b.annualLeaveTypeId),
        isNull(schema.leavePolicy.validTo),
      ),
    );
  return rows.map((r) => ({ gradeId: r.gradeId, companyId: r.companyId, accrual: r.accrual }));
}

/** The single active leave_policy row for an exact (company, grade) scope, or null. */
async function scopeRow(companyId: string, gradeId: string | null) {
  const rows = await owner.db
    .select({ accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(
      and(
        eq(schema.leavePolicy.tenantId, b.tenantId),
        eq(schema.leavePolicy.leaveTypeId, b.annualLeaveTypeId),
        eq(schema.leavePolicy.companyId, companyId),
        gradeId == null ? isNull(schema.leavePolicy.gradeId) : eq(schema.leavePolicy.gradeId, gradeId),
        isNull(schema.leavePolicy.validTo),
      ),
    );
  return rows;
}

describe('saveServiceEntitlement — first-save seeding neutralises the ADR-0066 short-circuit', () => {
  it('materialises the whole company scope; untouched grades resolve IDENTICALLY', async () => {
    const ctx = adminCtx(b);
    const gA = await createJobGrade(ctx, { code: 'GA', name: 'Grade A', rank: 1 });
    const gB = await createJobGrade(ctx, { code: 'GB', name: 'Grade B', rank: 2 });
    const gC = await createJobGrade(ctx, { code: 'GC', name: 'Grade C', rank: 3 });
    // Group defaults: a flat 16-day default for all grades, and a grade-specific 20-day default for gB.
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      method: 'grant_on_hire_prorated',
      validFrom: '2020-01-01',
    });
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 20,
      gradeId: gB.id,
      method: 'grant_on_hire_prorated',
      validFrom: '2020-01-01',
    });

    // Baseline resolution for this company (no company rows yet ⇒ group tier).
    const before = await activeRows();
    expect(resolveGradePolicy(before, gA.id, b.companyId, 0)?.days).toBe(16);
    expect(resolveGradePolicy(before, gB.id, b.companyId, 0)?.days).toBe(20);
    expect(resolveGradePolicy(before, gC.id, b.companyId, 0)?.days).toBe(16);

    // First save: edit ONLY grade A.
    await saveServiceEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      companyId: b.companyId,
      gradeId: gA.id,
      under2: 10,
      mid: 12,
      over: 14,
      asOf: `${YEAR}-06-01`,
    });

    const after = await activeRows();
    // The whole company scope is now materialised: a company+grade row for every active grade + a company
    // null-grade default (so the company tier alone resolves every grade).
    for (const gid of [gA.id, gB.id, gC.id]) {
      expect((await scopeRow(b.companyId, gid)).length, `company+grade row for ${gid}`).toBe(1);
    }
    expect((await scopeRow(b.companyId, null)).length, 'company null-grade default').toBe(1);

    // The untouched grades resolve IDENTICALLY — B keeps its own 20 (faithful copy, not the 16 group
    // default), C keeps 16 via the seeded company null-grade default.
    expect(resolveGradePolicy(after, gB.id, b.companyId, 0)?.days).toBe(20);
    expect(resolveGradePolicy(after, gC.id, b.companyId, 0)?.days).toBe(16);
    // The edited grade resolves to the new per-band figures.
    expect(resolveGradePolicy(after, gA.id, b.companyId, 1)?.days).toBe(10);
    expect(resolveGradePolicy(after, gA.id, b.companyId, 3)?.days).toBe(12);
    expect(resolveGradePolicy(after, gA.id, b.companyId, 6)?.days).toBe(14);

    // Faithful FULL copy: gB's seeded row carries its own annualDays (20), never a days-only downgrade.
    const bRow = await scopeRow(b.companyId, gB.id);
    expect((bRow[0].accrual as { annualDays?: number }).annualDays).toBe(20);
  });

  it('a graded edit writes the fixed 0–2 / 2–5 / 5+ three-band shape with annualDays set to the 5+ tier', async () => {
    const ctx = adminCtx(b);
    const gA = await createJobGrade(ctx, { code: 'GA', name: 'Grade A', rank: 1 });
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      method: 'grant_on_hire_prorated',
      validFrom: '2020-01-01',
    });
    await saveServiceEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      companyId: b.companyId,
      gradeId: gA.id,
      under2: 10,
      mid: 12,
      over: 14,
      asOf: `${YEAR}-06-01`,
    });
    const [row] = await scopeRow(b.companyId, gA.id);
    const acc = row.accrual as { annualDays?: number; serviceBands?: { fromYears: number; toYears: number | null; days: number }[] };
    // annualDays is mandatory + load-bearing — always set, here to the 5+ tier (14), never 0/undefined.
    expect(acc.annualDays).toBe(14);
    expect(acc.serviceBands).toEqual([
      { fromYears: 0, toYears: 2, days: 10 },
      { fromYears: 2, toYears: 5, days: 12 },
      { fromYears: 5, toYears: null, days: 14 },
    ]);
  });

  it('equal tiers on a FLAT grade stay flat (no bands); an existing exact-scope row edits IN PLACE', async () => {
    const ctx = adminCtx(b);
    const gA = await createJobGrade(ctx, { code: 'GA', name: 'Grade A', rank: 1 });
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      method: 'grant_on_hire_prorated',
      validFrom: '2020-01-01',
    });
    // First save seeds the company scope (gA copy is flat 16) then sets gA to a flat 18.
    await saveServiceEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      companyId: b.companyId,
      gradeId: gA.id,
      under2: 18,
      mid: 18,
      over: 18,
      asOf: `${YEAR}-06-01`,
    });
    let [row] = await scopeRow(b.companyId, gA.id);
    let acc = row.accrual as { annualDays?: number; serviceBands?: unknown };
    expect(acc.annualDays).toBe(18);
    expect(acc.serviceBands).toBeUndefined(); // stayed flat — no spurious band shape

    // A SECOND save of the same grade must edit in place — no new active dated version.
    await saveServiceEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      companyId: b.companyId,
      gradeId: gA.id,
      under2: 19,
      mid: 19,
      over: 19,
      asOf: `${YEAR}-06-02`,
    });
    const rows = await scopeRow(b.companyId, gA.id);
    expect(rows.length, 'still exactly one active company+grade row (edited in place)').toBe(1);
    [row] = rows;
    acc = row.accrual as { annualDays?: number; serviceBands?: unknown };
    expect(acc.annualDays).toBe(19);
    expect(acc.serviceBands).toBeUndefined();
  });

  it("editing one grade leaves an untouched grade's already-granted balance unchanged", async () => {
    const ctx = adminCtx(b);
    const gA = await createJobGrade(ctx, { code: 'GA', name: 'Grade A', rank: 1 });
    const gC = await createJobGrade(ctx, { code: 'GC', name: 'Grade C', rank: 3 });
    await createLeavePolicy(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 16,
      method: 'grant_on_hire_prorated',
      validFrom: '2020-01-01',
    });
    // An employee on the UNTOUCHED grade C, granted their ANNUAL entitlement on hire.
    const empC = await hireEmployee(ctx, {
      person: { fullName: 'C Person', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: `${YEAR}-01-01`,
      employeeCode: `SBE-${randomUUID().slice(0, 6)}`,
      gradeId: gC.id,
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    const balBefore = await ledgerBalance(empC.employmentId, b.annualLeaveTypeId);

    const recalc = await saveServiceEntitlement(ctx, {
      leaveTypeId: b.annualLeaveTypeId,
      companyId: b.companyId,
      gradeId: gA.id,
      under2: 5,
      mid: 5,
      over: 5,
      asOf: `${YEAR}-06-01`,
    });
    // The save reports a numeric blast radius (the edited grade's recalc), and grade C — untouched — is
    // byte-identical: the seeded copy resolves to the same 16 days, so no compensating ledger row is posted.
    expect(typeof recalc.affected).toBe('number');
    const balAfter = await ledgerBalance(empC.employmentId, b.annualLeaveTypeId);
    expect(balAfter).toBe(balBefore);
  });
});
