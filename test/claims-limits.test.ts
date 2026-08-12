/**
 * ccbd0508 — Claim Limits by Job Grade + claim-type delete. Covers grade tiering (grade-match beats
 * null-grade default), per-(type,grade) effective-dated versioning independence, the new limit kinds on
 * the Claim Limits read, and hard-delete of an unused claim type (cascade + event). Back-compat: a
 * pre-existing null-grade policy resolves identically for an ungraded employee.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant } from '../db/client';
import * as schema from '../db/schema';
import { readFileSync } from 'node:fs';
import {
  createClaimItem,
  createClaimType,
  deleteClaimType,
  getActiveClaimPolicy,
  listClaimLimits,
  listClaimTypes,
  setClaimPolicy,
  setMileageRateTable,
  submitClaim,
} from '../core/claims';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, eventTypesFor, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// The kernel judges these dates in MYT (bb4f2265); a fixture built in UTC disagrees with it
// between 00:00 and 08:00 MYT, which is a test that fails only at night.
import { todayInKualaLumpur } from '../lib/hr-date';

async function makeGrade(tenantId: string, code: string, name: string, rank: number): Promise<string> {
  const [g] = await owner.db.insert(schema.jobGrade).values({ tenantId, code, name, rank }).returning({ id: schema.jobGrade.id });
  return g.id;
}

describe('ccbd0508 — claim limits by grade', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('resolves grade-match over the null-grade default; ungraded falls back to default', async () => {
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const mgr = await makeGrade(base.tenantId, 'MGR', 'Manager', 2);
    const { id } = await createClaimType(adminCtx(base), { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    // default (all grades) + an Executive-specific limit.
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-01-01' });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, gradeId: exec, annualBudget: 5000, perClaimCap: 500, effectiveFrom: '2026-01-01' });

    const at = (gradeId: string | null) => withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, id, '2026-06-01', gradeId));
    expect((await at(exec))?.annualBudget).toBe(5000); // grade-match wins
    expect((await at(exec))?.perClaimCap).toBe(500);
    expect((await at(mgr))?.annualBudget).toBe(1000); // no Manager row ⇒ default
    expect((await at(null))?.annualBudget).toBe(1000); // ungraded ⇒ default
  });

  it('versions per (type, grade) independently — changing one grade never closes another', async () => {
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const { id } = await createClaimType(adminCtx(base), { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-01-01' });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, gradeId: exec, annualBudget: 5000, perClaimCap: null, effectiveFrom: '2026-01-01' });
    // A second Executive version supersedes only the Executive row.
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, gradeId: exec, annualBudget: 6000, perClaimCap: null, effectiveFrom: '2026-06-01' });

    const at = (gradeId: string | null, asOf: string) => withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, id, asOf, gradeId));
    expect((await at(exec, '2026-07-01'))?.annualBudget).toBe(6000);
    expect((await at(exec, '2026-03-01'))?.annualBudget).toBe(5000);
    expect((await at(null, '2026-07-01'))?.annualBudget).toBe(1000); // default untouched
  });

  it('round-trips the new limit kinds on the Claim Limits read + event payload', async () => {
    const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
    const { id } = await createClaimType(adminCtx(base), { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(adminCtx(base), {
      claimTypeId: id,
      gradeId: exec,
      annualBudget: 1000,
      perClaimCap: 200,
      monthlyLimit: 300,
      lifetimeLimit: 9000,
      maxClaimsPerYear: 12,
      effectiveFrom: '2026-01-01',
    });
    const limits = await listClaimLimits(adminCtx(base), { asOf: '2026-06-01' });
    const row = limits.find((l) => l.claimTypeId === id && l.gradeId === exec);
    expect(row).toMatchObject({ annualBudget: 1000, perClaimCap: 200, monthlyLimit: 300, lifetimeLimit: 9000, maxClaimsPerYear: 12, gradeName: 'Executive' });
  });

  it('back-compat: a null-grade policy resolves identically for null and an arbitrary grade with no row', async () => {
    const some = await makeGrade(base.tenantId, 'G1', 'Grade 1', 1);
    const { id } = await createClaimType(adminCtx(base), { code: 'MEALS', name: 'Meals', defaultTaxable: false, requiresReceipt: false });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: 2000, perClaimCap: 100, effectiveFrom: '2026-01-01' });
    const at = (gradeId: string | null) => withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, id, '2026-06-01', gradeId));
    expect((await at(null))?.annualBudget).toBe(2000);
    expect((await at(some))?.annualBudget).toBe(2000);
    expect((await at(some))?.perClaimCap).toBe(100);
  });

  it('hard-deletes an UNUSED claim type — cascading items + policies + event', async () => {
    const { id } = await createClaimType(adminCtx(base), { code: 'PHONE', name: 'Phone', defaultTaxable: false, requiresReceipt: false });
    await createClaimItem(adminCtx(base), { claimTypeId: id, code: 'DATA', name: 'Data plan' });
    await setClaimPolicy(adminCtx(base), { claimTypeId: id, annualBudget: 500, perClaimCap: null, effectiveFrom: '2026-01-01' });

    await deleteClaimType(adminCtx(base), id);
    expect((await listClaimTypes(adminCtx(base))).find((t) => t.id === id)).toBeUndefined();
    expect(await eventTypesFor(base.tenantId, id)).toContain('claim-type.deleted');
    const payload = await latestEventPayload(base.tenantId, id, 'claim-type.deleted');
    expect(payload).toMatchObject({ code: 'PHONE', hadItems: 1, hadPolicies: 1 });
    // config rows gone
    const items = await owner.db.select().from(schema.claimItem).where(eq(schema.claimItem.claimTypeId, id));
    expect(items.length).toBe(0);
  });

  it('refuses to delete a claim type that has claim history (archive instead)', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Subject', primaryEmail: 'subject@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const { id } = await createClaimType(a, { code: 'MEDICAL', name: 'Medical', defaultTaxable: false, requiresReceipt: false });
    await submitClaim(a, { employmentId: E.employmentId, claimTypeId: id, amount: 10, incurredOn: todayInKualaLumpur() });
    await expect(deleteClaimType(a, id)).rejects.toThrow(/archive/i);
    expect((await listClaimTypes(a)).find((t) => t.id === id)).toBeDefined(); // still there
  });

  // ══════════ e7eb5d83 rev 5 STEP 1 — rate_config carry-forward: the mileage re-save trap ══════════
  //
  // MEASURED ON PRODUCTION 2026-08-12, before a line of this was written: MILEAGE 001's OPEN policy still
  // carried {"kind":"mileage_flat","ratePerKm":0.7} (valid_to null, created 2026-06-30), and all five
  // claim_mileage_rate rows sat on GRADE 12 (PERMANENT), which has zero employments. So the flat scalar was
  // not a leftover — it was the live pricing path for all 40 employees, and the existing RM70.00 draft is
  // 100 km × 0.70 proving it.
  //
  // Meanwhile the limits screen had stopped offering a rate-per-km field (r186) but its action still POSTed
  // a rate on every save: rateConfigFrom() always returned a config, defaulting to {kind:'receipt'}. The
  // first re-save of the Mileage limit would therefore have written receipt over the scalar and every filer
  // would have met "No mileage rate has been set up for this claim type yet".
  //
  // These tests pin the fix in BOTH directions. Carry-forward that cannot be turned off would be its own
  // bug — an admin who genuinely wants a rate gone must still be able to remove it — so `undefined` and
  // `null` are asserted to mean different things, not merely asserted to be safe.
  describe('rate_config is a TRI-STATE: absent inherits, null clears', () => {
    async function mileageTypeWithFlatRate(rate = 0.7) {
      const a = adminCtx(base);
      const { id } = await createClaimType(a, {
        code: 'MILEAGE',
        name: 'Mileage',
        defaultTaxable: false,
        requiresReceipt: false,
        isMileage: true,
      });
      await setClaimPolicy(a, {
        claimTypeId: id,
        annualBudget: 100,
        perClaimCap: 100,
        effectiveFrom: '2026-01-01',
        rateConfig: { kind: 'mileage_flat', ratePerKm: rate },
      });
      return id;
    }
    const rateAt = (id: string, gradeId: string | null = null, asOf = '2026-06-01') =>
      withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, id, asOf, gradeId));

    it('THE TRAP: a re-save that supplies no rateConfig CARRIES THE RATE FORWARD', async () => {
      const id = await mileageTypeWithFlatRate();
      // Exactly what a limits save looks like once the screen has no rate control on it: money limits
      // only, not one word about rates. Before the fix this wrote {kind:'receipt'}.
      await setClaimPolicy(adminCtx(base), {
        claimTypeId: id,
        annualBudget: 250,
        perClaimCap: 120,
        effectiveFrom: '2026-05-01',
      });
      const p = await rateAt(id);
      expect(p?.annualBudget).toBe(250); // the edit landed …
      expect(p?.rateConfig).toEqual({ kind: 'mileage_flat', ratePerKm: 0.7 }); // … and took nothing with it
    });

    it('and the claim still prices at the old rate after that re-save', async () => {
      // The assertion that actually matters to the 40 employees: not "the column still holds a value" but
      // "a mileage claim filed after the save is still worth what it was worth before it".
      const a = adminCtx(base);
      const E = await hireEmployee(a, {
        person: { fullName: 'Rider', primaryEmail: 'rider@acme.test' },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      const id = await mileageTypeWithFlatRate();
      await setClaimPolicy(a, { claimTypeId: id, annualBudget: 250, perClaimCap: 120, effectiveFrom: '2026-05-01' });
      const claim = await submitClaim(a, {
        employmentId: E.employmentId,
        claimTypeId: id,
        amount: 0,
        quantityKm: 100,
        incurredOn: todayInKualaLumpur(),
      });
      const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
      expect(Number(row.amount)).toBe(70); // 100 × 0.70 — the production draft's own figure
    });

    it('an EXPLICIT null clears the rate — inheritance is not a one-way ratchet', async () => {
      const id = await mileageTypeWithFlatRate();
      await setClaimPolicy(adminCtx(base), {
        claimTypeId: id,
        annualBudget: 250,
        perClaimCap: null,
        effectiveFrom: '2026-05-01',
        rateConfig: null,
      });
      expect((await rateAt(id))?.rateConfig).toBeNull();
    });

    it('an explicit config REPLACES the inherited one', async () => {
      const id = await mileageTypeWithFlatRate();
      await setClaimPolicy(adminCtx(base), {
        claimTypeId: id,
        annualBudget: null,
        perClaimCap: null,
        effectiveFrom: '2026-05-01',
        rateConfig: { kind: 'fixed_allowance', amount: 180 },
      });
      expect((await rateAt(id))?.rateConfig).toEqual({ kind: 'fixed_allowance', amount: 180 });
    });

    it('the event payload records the RESOLVED config, so an inherited rate is not logged as a deletion', async () => {
      const id = await mileageTypeWithFlatRate();
      const { id: versionId } = await setClaimPolicy(adminCtx(base), {
        claimTypeId: id,
        annualBudget: 250,
        perClaimCap: null,
        effectiveFrom: '2026-05-01',
      });
      const payload = await latestEventPayload(base.tenantId, versionId, 'claim-policy.set');
      expect(payload).toMatchObject({ rateConfig: { kind: 'mileage_flat', ratePerKm: 0.7 } });
    });

    it('inheritance is per (type, grade) — a grade row does not inherit the company-wide rate', async () => {
      // The close-and-insert predicate is null-safe on grade, and the read that feeds the inheritance uses
      // the SAME predicate. If it did not, the first per-grade limit ever set on a type would silently
      // acquire the company-wide row's rate, which is a rate nobody chose for that grade.
      const exec = await makeGrade(base.tenantId, 'EXEC', 'Executive', 1);
      const id = await mileageTypeWithFlatRate();
      await setClaimPolicy(adminCtx(base), {
        claimTypeId: id,
        gradeId: exec,
        annualBudget: 500,
        perClaimCap: null,
        effectiveFrom: '2026-05-01',
      });
      const [execRow] = await owner.db
        .select()
        .from(schema.claimPolicy)
        .where(eq(schema.claimPolicy.gradeId, exec));
      expect(execRow.rateConfig).toBeNull(); // nothing to inherit on this tier ⇒ nothing inherited
      expect((await rateAt(id))?.rateConfig).toEqual({ kind: 'mileage_flat', ratePerKm: 0.7 }); // untouched
    });

    it('STEP 1b: the company-wide band seed prices identically to the flat scalar it retires', async () => {
      // What scripts/backfill-mileage-flat-rate.ts writes, asserted as arithmetic rather than as intent:
      // one open band [0 km → ∞] at the same rate is priceMileage's answer to computeClaimAmount's.
      const a = adminCtx(base);
      const E = await hireEmployee(a, {
        person: { fullName: 'Seeded Rider', primaryEmail: 'seededrider@acme.test' },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      const id = await mileageTypeWithFlatRate();
      await setMileageRateTable(a, {
        claimTypeId: id,
        gradeId: null,
        vehicleClass: 'any',
        effectiveFrom: '2026-01-01',
        bands: [{ fromKm: 0, toKm: null, ratePerKm: 0.7 }],
      });
      const claim = await submitClaim(a, {
        employmentId: E.employmentId,
        claimTypeId: id,
        amount: 0,
        quantityKm: 100,
        incurredOn: todayInKualaLumpur(),
      });
      const [row] = await owner.db.select().from(schema.claimRequest).where(eq(schema.claimRequest.id, claim.id));
      expect(Number(row.amount)).toBe(70); // identical to the mileage_flat answer above, to the sen
      // …and now the claim can EXPLAIN itself, which the fallback path never could.
      expect(row.mileageRateApplied).toMatchObject({ source: 'company', gradeId: null });
    });

    it('STEP 1c: the limits action can no longer parse a mileage_flat rate out of a POST', async () => {
      // rateConfigFrom() cannot be imported here — a 'use server' module may only export async functions —
      // so the dead branch is pinned at the source. The screen stopped offering the option in r186; until
      // this step the parser still honoured it, so a hand-rolled POST could write a per-km scalar back onto
      // a claim policy through a screen that has no such field.
      const src = readFileSync(new URL('../app/admin/claims/limits/actions.ts', import.meta.url), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toContain('mileage_flat');
      expect(code).not.toContain('ratePerKm');
    });
  });
});
