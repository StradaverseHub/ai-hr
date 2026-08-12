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
  ClaimError,
  createClaimItem,
  createClaimType,
  decideClaim,
  deleteClaimType,
  getActiveClaimPolicy,
  getEmployeeClaimTypes,
  listClaimItemLimits,
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

  // ══════════ e7eb5d83 rev 5 STEP 2 — SUB-CLAIM LIMITS (0435: claim_policy.claim_item_id) ══════════
  //
  // MEDICAL 001 is the claim TYPE; MEDICAL 002 (Outpatient) and MEDICAL 003 (Inpatient) are its claim_item
  // rows — the SECOND level, which has existed since the module shipped. Revision 4 refused this as "a
  // third group/claim/sub-claim level" and that was our error. What was genuinely missing was a place to
  // PUT a sub-claim's limit; what already worked, and must keep working, is that spending on a sub-claim
  // comes out of its parent's pot.
  describe('sub-claim limits sit BESIDE the type limit, never instead of it', () => {
    const on = () => todayInKualaLumpur();

    async function medicalWithItems(p: { typeAnnual: number | null; outpatientAnnual?: number | null }) {
      const a = adminCtx(base);
      const { id: typeId } = await createClaimType(a, {
        code: 'MEDICAL',
        name: 'Medical',
        defaultTaxable: false,
        requiresReceipt: false,
      });
      const out = await createClaimItem(a, { claimTypeId: typeId, code: 'MEDICAL 002', name: 'Outpatient' });
      const inp = await createClaimItem(a, { claimTypeId: typeId, code: 'MEDICAL 003', name: 'Inpatient' });
      if (p.typeAnnual != null) {
        await setClaimPolicy(a, { claimTypeId: typeId, annualBudget: p.typeAnnual, perClaimCap: null, effectiveFrom: '2026-01-01' });
      }
      if (p.outpatientAnnual != null) {
        await setClaimPolicy(a, {
          claimTypeId: typeId,
          claimItemId: out.id,
          annualBudget: p.outpatientAnnual,
          perClaimCap: null,
          effectiveFrom: '2026-01-01',
        });
      }
      const E = await hireEmployee(a, {
        person: { fullName: `Claimant ${Math.random().toString(36).slice(2, 8)}`, primaryEmail: `c${Math.random().toString(36).slice(2, 8)}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
      return { a, typeId, out, inp, employmentId: E.employmentId };
    }

    it('THE HAZARD: setting a sub-claim limit does not close the TYPE\'s policy version', async () => {
      // The one that destroys data rather than merely mis-reading. setClaimPolicy's close-and-insert
      // predicate has to compare (type, grade, item) THREE ways null-safe; with only two arms, saving
      // Outpatient's limit closes MEDICAL 001's own open version and the type's RM2,000 stops existing.
      const { a, typeId, out } = await medicalWithItems({ typeAnnual: 2000 });
      await setClaimPolicy(a, { claimTypeId: typeId, claimItemId: out.id, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-05-01' });

      const openTypeRows = await owner.db
        .select()
        .from(schema.claimPolicy)
        .where(eq(schema.claimPolicy.claimTypeId, typeId));
      const openType = openTypeRows.filter((r) => r.claimItemId == null && r.validTo == null);
      expect(openType.length).toBe(1); // still exactly one open TYPE version …
      expect(Number(openType[0].annualBudget)).toBe(2000); // … and it still holds its own number
    });

    it('getActiveClaimPolicy never returns an item row for a type-level read', async () => {
      // Resolution takes the latest valid_from within a tier, so an item row saved LATER than the type's
      // would outrank it — silently, with the sub-claim's smaller number applying to every claim.
      const { typeId, out } = await medicalWithItems({ typeAnnual: 2000 });
      await setClaimPolicy(adminCtx(base), {
        claimTypeId: typeId,
        claimItemId: out.id,
        annualBudget: 1,
        perClaimCap: 1,
        effectiveFrom: '2026-12-31', // deliberately the newest version in the table
      });
      const typeLevel = await withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, typeId, '2026-12-31', null));
      expect(typeLevel?.annualBudget).toBe(2000);
      expect(typeLevel?.claimItemId).toBeNull();
      // …and the item-level read gets the item row, not the type's.
      const itemLevel = await withTenant(adminCtx(base), (tx) => getActiveClaimPolicy(tx, typeId, '2026-12-31', null, out.id));
      expect(itemLevel?.annualBudget).toBe(1);
      expect(itemLevel?.claimItemId).toBe(out.id);
    });

    it('listClaimLimits stays type-level — an item row never appears as the type\'s limit', async () => {
      const { typeId, out } = await medicalWithItems({ typeAnnual: 2000 });
      await setClaimPolicy(adminCtx(base), { claimTypeId: typeId, claimItemId: out.id, annualBudget: 1, perClaimCap: null, effectiveFrom: '2026-12-31' });
      const rows = (await listClaimLimits(adminCtx(base), { asOf: '2026-12-31' })).filter((r) => r.claimTypeId === typeId);
      expect(rows.length).toBe(1);
      expect(rows[0].annualBudget).toBe(2000);
      // The sub-claim's own row is readable, just not from there.
      const items = (await listClaimItemLimits(adminCtx(base), { asOf: '2026-12-31' })).filter((r) => r.claimTypeId === typeId);
      expect(items).toMatchObject([{ claimItemId: out.id, annualBudget: 1 }]);
    });

    it('a SUB-CLAIM limit refuses at submit while the TYPE limit still has room', async () => {
      const { a, typeId, out, employmentId } = await medicalWithItems({ typeAnnual: 2000, outpatientAnnual: 300 });
      await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 250, incurredOn: on() });
      const err = await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 100, incurredOn: on() }).catch((e) => e);
      expect(err).toBeInstanceOf(ClaimError); // the identity, not merely "it threw"
      expect(err.message).toMatch(/Outpatient/); // the message NAMES the sub-claim, not the type
      expect(err.message).toMatch(/300/);
    });

    it('the TYPE limit refuses even when the sub-claim has room', async () => {
      const { a, typeId, out, inp, employmentId } = await medicalWithItems({ typeAnnual: 400, outpatientAnnual: 5000 });
      await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: inp.id, amount: 350, incurredOn: on() });
      const err = await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 100, incurredOn: on() }).catch((e) => e);
      expect(err).toBeInstanceOf(ClaimError);
      expect(err.message).toMatch(/this claim type/); // the TYPE's message wins when both could bite
      expect(err.message).not.toMatch(/Outpatient/);
    });

    it('spend on one sub-claim reduces the parent and its own pot, but NOT a sibling\'s', async () => {
      // The half the reporter says already works (parent deduction) and the half that is new (sub-pots),
      // asserted in one place so a future change cannot trade one for the other.
      const a = adminCtx(base);
      const { typeId, out, inp, employmentId } = await medicalWithItems({ typeAnnual: 2000, outpatientAnnual: 1000 });
      await setClaimPolicy(a, { claimTypeId: typeId, claimItemId: inp.id, annualBudget: 1000, perClaimCap: null, effectiveFrom: '2026-01-01' });
      await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 600, incurredOn: on() });

      const [type] = await getEmployeeClaimTypes(a, employmentId).then((ts) => ts.filter((t) => t.id === typeId));
      expect(type.balance.usedThisYear).toBe(600); // the PARENT pot was spent …
      expect(type.balance.remainingThisYear).toBe(1400);
      const outB = type.balance.items.find((i) => i.claimItemId === out.id);
      const inpB = type.balance.items.find((i) => i.claimItemId === inp.id);
      expect(outB).toMatchObject({ usedThisYear: 600, remainingThisYear: 400 }); // … and Outpatient's own …
      expect(inpB).toMatchObject({ usedThisYear: 0, remainingThisYear: 1000 }); // … but Inpatient's is untouched
    });

    it('the approve-time re-check mirrors the sub-claim limit too', async () => {
      // Submit reserves against PENDING, approval settles against SETTLED. A sub-limit checked only on the
      // way in can be exceeded by the order approvals are granted in — the type's re-check has always
      // existed for exactly this, and the sub-claim's has to exist for the same reason.
      const a = adminCtx(base);
      const { typeId, out, employmentId } = await medicalWithItems({ typeAnnual: 5000, outpatientAnnual: 500 });
      const first = await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 400, incurredOn: on() });
      // Widen the sub-limit so a SECOND claim can be filed, then narrow it back before deciding: the
      // approve path must re-read the policy rather than trust the submit that let the claim in.
      await setClaimPolicy(a, { claimTypeId: typeId, claimItemId: out.id, annualBudget: 5000, perClaimCap: null, effectiveFrom: '2026-01-01' });
      const second = await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 400, incurredOn: on() });
      await setClaimPolicy(a, { claimTypeId: typeId, claimItemId: out.id, annualBudget: 500, perClaimCap: null, effectiveFrom: '2026-01-01' });

      await decideClaim(a, { claimRequestId: first.id, decision: 'approve' });
      const err = await decideClaim(a, { claimRequestId: second.id, decision: 'approve' }).catch((e) => e);
      expect(err).toBeInstanceOf(ClaimError);
      expect(err.message).toMatch(/Outpatient/);
    });

    it('a sub-claim limit cannot be filed against a claim type the sub-claim does not belong to', async () => {
      // The foreign key proves the item EXISTS, not that it is an item of THIS type — a policy row pointing
      // at another type's item is a limit no claim could ever match, so the service refuses it outright.
      const a = adminCtx(base);
      const { out } = await medicalWithItems({ typeAnnual: 100 });
      const { id: otherType } = await createClaimType(a, { code: 'TRAVEL', name: 'Travel', defaultTaxable: false, requiresReceipt: false });
      const err = await setClaimPolicy(a, {
        claimTypeId: otherType,
        claimItemId: out.id,
        annualBudget: 100,
        perClaimCap: null,
        effectiveFrom: '2026-01-01',
      }).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/does not belong to this claim type/);
    });

    it('a sub-claim with no limit of its own is unlimited IN ITSELF and still bounded by its type', async () => {
      // The default every sub-claim starts on, and the one that must not change: before this round every
      // claim_policy row was a type row, so "no item row" has to keep meaning exactly what it meant.
      const a = adminCtx(base);
      const { typeId, out, employmentId } = await medicalWithItems({ typeAnnual: 500 });
      await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 500, incurredOn: on() });
      const err = await submitClaim(a, { employmentId, claimTypeId: typeId, claimItemId: out.id, amount: 1, incurredOn: on() }).catch((e) => e);
      expect(err).toBeInstanceOf(ClaimError);
      expect(err.message).toMatch(/this claim type/); // refused by the TYPE, the only limit there is
    });
  });
});
