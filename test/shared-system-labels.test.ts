/**
 * Shared System Labels — multi-company assignment (ADR-0073, feedback d356dec8). Phase 1+2 substrate:
 * the label_company_assignment junction, the is_global "All Companies" flag, the resolver, and the
 * assign/unassign/setGlobal mutations. Mirrors test/system-labels-relocation.test.ts for the admin-ctx /
 * RLS / substrate patterns.
 *
 * Covers:
 *   - Backfill: every existing label has a self-assignment (origin) after migration (implicitly via resolver).
 *   - Flag OFF ⇒ labelIdsForCompany returns ORIGIN-ONLY (byte-identical to today) even when a label is
 *     assigned/global — the phased-rollout safety guarantee.
 *   - Flag ON ⇒ a label assigned or made global surfaces in the target company.
 *   - Assign / unassign mutate the junction and append DomainEvents.
 *   - Data-integrity guard: unassign REFUSES a company that still uses the label via an employee assignment.
 *   - is_global write-gate: a GROUP admin may set it; a company-scoped admin is rejected by the DB trigger.
 *   - companiesForLabel unions origin ∪ junction ∪ (all-tenant when global).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { type SessionContext } from '../db/client';
import { createDepartment, createCostCenter } from '../core/admin';
import {
  assignLabelToCompanies,
  unassignLabelFromCompanies,
  setLabelGlobal,
  labelIdsForCompany,
  companiesForLabel,
  LabelInUseError,
} from '../core/system-labels';

let b: Base;

/** A company-scoped hr_admin (NOT a group admin) — proves the is_global trigger rejects non-group admins. */
async function companyAdminFor(companyId: string): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

/** Turn the shared-labels flag on/off for a company (owner connection bypasses RLS — setup only). */
async function setSharedFlag(companyId: string, on: boolean) {
  await owner.db
    .update(schema.company)
    .set({ sharedSystemLabels: on })
    .where(eq(schema.company.id, companyId));
}

/** A second company in the same tenant, to share INTO. */
async function secondCompany(): Promise<string> {
  const [co] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: 'SSL Co B Sdn Bhd', country: 'MY', currency: 'MYR' })
    .returning({ id: schema.company.id });
  return co.id;
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

describe('Shared System Labels — backfill + flag gating', () => {
  it('backfills a self-assignment (origin) for every newly-created label', async () => {
    const a = adminCtx(b);
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Legal' });
    // The create path does NOT write the junction (backfill is migration-only for pre-existing rows), but
    // the resolver treats origin as implicit, so the origin company always resolves.
    const companies = await companiesForLabel(a, 'department', id);
    expect(companies).toContain(b.companyId);
  });

  it('flag OFF ⇒ labelIdsForCompany is ORIGIN-ONLY even when the label is assigned into the company', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Shared Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });

    // coB has NOT opted in → the assigned label must NOT surface there (byte-identical to today).
    await setSharedFlag(coB, false);
    const idsOff = await labelIdsForCompany(a, 'department', coB);
    expect(idsOff).not.toContain(id);
  });

  it('flag ON ⇒ an assigned label surfaces in the target company', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Shared Dept 2' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });

    await setSharedFlag(coB, true);
    const idsOn = await labelIdsForCompany(a, 'department', coB);
    expect(idsOn).toContain(id);
  });

  it('flag ON ⇒ a GLOBAL label surfaces in every company', async () => {
    const a = adminCtx(b); // adminCtx is group-wide (roles:['hr_admin'], companyId null) → group admin.
    const coB = await secondCompany();
    const { id } = await createCostCenter(a, { companyId: b.companyId, code: 'GLB', name: 'Global CC' });
    await setLabelGlobal(a, { kind: 'cost_center', labelId: id, isGlobal: true });

    await setSharedFlag(coB, true);
    const idsOn = await labelIdsForCompany(a, 'cost_center', coB);
    expect(idsOn).toContain(id);

    // companiesForLabel of a global label = every company in the tenant.
    const cos = await companiesForLabel(a, 'cost_center', id);
    expect(cos).toEqual(expect.arrayContaining([b.companyId, coB]));
  });
});

describe('Shared System Labels — assign / unassign mutations + substrate', () => {
  it('assign then unassign mutates the junction and appends DomainEvents', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Ops' });

    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });
    let rows = await owner.db
      .select()
      .from(schema.labelCompanyAssignment)
      .where(
        and(
          eq(schema.labelCompanyAssignment.labelId, id),
          eq(schema.labelCompanyAssignment.companyId, coB),
        ),
      );
    expect(rows.length).toBe(1);
    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining(['department.created', 'department.companies.assigned']),
    );
    expect((await latestEventPayload(b.tenantId, id, 'department.companies.assigned'))?.companyIds).toEqual([coB]);

    await unassignLabelFromCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });
    rows = await owner.db
      .select()
      .from(schema.labelCompanyAssignment)
      .where(
        and(
          eq(schema.labelCompanyAssignment.labelId, id),
          eq(schema.labelCompanyAssignment.companyId, coB),
        ),
      );
    expect(rows.length).toBe(0);
    expect(await eventTypesFor(b.tenantId, id)).toContain('department.companies.unassigned');
  });

  it('assign is idempotent (re-assigning the same company does not duplicate the junction row)', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Idem' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });
    const rows = await owner.db
      .select()
      .from(schema.labelCompanyAssignment)
      .where(
        and(
          eq(schema.labelCompanyAssignment.labelId, id),
          eq(schema.labelCompanyAssignment.companyId, coB),
        ),
      );
    expect(rows.length).toBe(1);
  });
});

describe('Shared System Labels — data-integrity guard', () => {
  it('unassign REFUSES a company that still uses the label via an active employee assignment', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'InUse' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });

    // Create an employee in coB whose CURRENT assignment points at the (shared) department.
    const [pers] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Guarded Emp', primaryEmail: `g_${randomUUID()}@t.local` })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: pers.id, companyId: coB, hiredOn: '2024-01-01' })
      .returning({ id: schema.employment.id });
    await owner.db.insert(schema.assignment).values({
      tenantId: b.tenantId,
      employmentId: emp.id,
      departmentId: id,
      employmentType: 'full_time',
      status: 'active',
      validFrom: '2024-01-01',
    });

    await expect(
      unassignLabelFromCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] }),
    ).rejects.toBeInstanceOf(LabelInUseError);

    // The junction row is untouched.
    const rows = await owner.db
      .select()
      .from(schema.labelCompanyAssignment)
      .where(
        and(
          eq(schema.labelCompanyAssignment.labelId, id),
          eq(schema.labelCompanyAssignment.companyId, coB),
        ),
      );
    expect(rows.length).toBe(1);
  });
});

describe('Shared System Labels — is_global write-gate (group-admin only)', () => {
  it('a GROUP admin may make a label global', async () => {
    const a = adminCtx(b); // group-wide hr_admin
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'GlobalDept' });
    await setLabelGlobal(a, { kind: 'department', labelId: id, isGlobal: true });
    const [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id));
    expect(row.isGlobal).toBe(true);
    expect(await eventTypesFor(b.tenantId, id)).toContain('department.made.global');
  });

  it('a COMPANY-scoped admin is rejected by the DB trigger when making a label global', async () => {
    const a = adminCtx(b);
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'NotGlobal' });

    const companyAdmin = await companyAdminFor(b.companyId);
    await expect(
      setLabelGlobal(companyAdmin, { kind: 'department', labelId: id, isGlobal: true }),
    ).rejects.toThrow();

    // The flag stayed false.
    const [row] = await owner.db.select().from(schema.department).where(eq(schema.department.id, id));
    expect(row.isGlobal).toBe(false);
  });
});
