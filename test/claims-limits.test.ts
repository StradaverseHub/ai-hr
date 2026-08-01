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
import {
  createClaimItem,
  createClaimType,
  deleteClaimType,
  getActiveClaimPolicy,
  listClaimLimits,
  listClaimTypes,
  setClaimPolicy,
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
});
