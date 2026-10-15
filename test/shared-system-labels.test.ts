/** System Labels compatibility consumers use the canonical explicit Criteria owner (ADR0122). */
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
import {
  createDepartment,
  createCostCenter,
  bulkSaveLabels,
  setCompanySharedLabels,
  LabelBulkError,
} from '../core/admin';
import { listDepartments } from '../core/read';
import {
  assignLabelToCompanies,
  unassignLabelFromCompanies,
  setLabelGlobal,
  labelIdsForCompany,
  labelIdsForCompanies,
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

describe('System Labels — explicit origin backfill and retired flag independence', () => {
  it('backfills a self-assignment (origin) for every newly-created label', async () => {
    const a = adminCtx(b);
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Legal' });
    // The database seeds the explicit origin assignment for new scoped labels.
    const companies = await companiesForLabel(a, 'department', id);
    expect(companies).toContain(b.companyId);
  });

  it('retired flag OFF cannot hide a label explicitly assigned to the company', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Shared Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });

    // Existing flag data remains intact but no longer changes per-code availability.
    await setSharedFlag(coB, false);
    const idsOff = await labelIdsForCompany(a, 'department', coB);
    expect(idsOff).toContain(id);
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
      expect.arrayContaining(['department.created', 'department.criteria.changed']),
    );
    expect((await latestEventPayload(b.tenantId, id, 'department.criteria.changed'))?.companyIds).toEqual(expect.arrayContaining([b.companyId,coB]));

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
    expect(await eventTypesFor(b.tenantId, id)).toContain('department.criteria.changed');
    expect((await latestEventPayload(b.tenantId,id,'department.criteria.changed'))?.companyIds).toEqual([b.companyId]);
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
    expect(await eventTypesFor(b.tenantId, id)).toContain('department.criteria.changed');
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

describe('Shared System Labels — Build 1: consumers read through the resolver (62de487d)', () => {
  it('flag ON ⇒ a shared department surfaces in listDepartments for the target company', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Resolver Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });

    // Both legacy flag states resolve the same saved Criteria.
    await setSharedFlag(coB, false);
    const off = await listDepartments(a, { companyIds: [coB] });
    expect(off.map((d) => d.id)).toContain(id);

    // Flag ON for coB → it now appears in coB's dropdown list.
    await setSharedFlag(coB, true);
    const on = await listDepartments(a, { companyIds: [coB] });
    expect(on.map((d) => d.id)).toContain(id);
  });

  it('flag ON ⇒ a GLOBAL department surfaces in listDepartments for every opted-in company', async () => {
    const a = adminCtx(b); // group admin
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Global Dept L' });
    await setLabelGlobal(a, { kind: 'department', labelId: id, isGlobal: true });
    await setSharedFlag(coB, true);
    const on = await listDepartments(a, { companyIds: [coB] });
    expect(on.map((d) => d.id)).toContain(id);
  });

  it('labelIdsForCompanies batches origin ∪ shared-in across a company set', async () => {
    const a = adminCtx(b);
    const coB = await secondCompany();
    const { id } = await createDepartment(a, { companyId: b.companyId, name: 'Batched Dept' });
    await assignLabelToCompanies(a, { kind: 'department', labelId: id, companyIds: [coB] });
    await setSharedFlag(coB, true);
    const ids = await labelIdsForCompanies(a, 'department', [b.companyId, coB]);
    expect(ids).toContain(id);
  });
});

describe('Shared System Labels — Build 2: bulkSaveLabels + company flag (62de487d)', () => {
  it('creates + updates commit atomically, each with its own DomainEvent', async () => {
    const a = adminCtx(b);
    const existing = await createDepartment(a, { companyId: b.companyId, name: 'Bulk Existing' });
    const res = await bulkSaveLabels(a, 'department', {
      creates: [{ key: 'n1', companyId: b.companyId, name: 'Bulk New A' }],
      updates: [{ key: 'u1', id: existing.id, name: 'Bulk Existing Renamed' }],
    });
    expect(res.created).toBe(1);
    expect(res.updated).toBe(1);
    expect(await eventTypesFor(b.tenantId, existing.id)).toContain('department.updated');
    const [renamed] = await owner.db
      .select()
      .from(schema.department)
      .where(eq(schema.department.id, existing.id));
    expect(renamed.name).toBe('Bulk Existing Renamed');
  });

  it('one invalid row aborts the WHOLE save (atomic rollback) and returns row-indexed errors', async () => {
    const a = adminCtx(b);
    await createCostCenter(a, { companyId: b.companyId, code: 'DUPCC', name: 'Existing CC' });
    // Two creates: one valid, one that duplicates DUPCC → the whole transaction must roll back.
    await expect(
      bulkSaveLabels(a, 'cost_center', {
        creates: [
          { key: 'ok', companyId: b.companyId, code: 'FRESHCC', name: 'Fresh' },
          { key: 'bad', companyId: b.companyId, code: 'DUPCC', name: 'Clash' },
        ],
        updates: [],
      }),
    ).rejects.toBeInstanceOf(LabelBulkError);
    // Nothing was created — the valid row rolled back too.
    const rows = await owner.db
      .select()
      .from(schema.costCenter)
      .where(and(eq(schema.costCenter.tenantId, b.tenantId), eq(schema.costCenter.code, 'FRESHCC')));
    expect(rows.length).toBe(0);
  });

  it('missing mandatory field is reported as a row error (no partial save)', async () => {
    const a = adminCtx(b);
    try {
      await bulkSaveLabels(a, 'department', {
        creates: [{ key: 'blank', companyId: b.companyId, name: '   ' }],
        updates: [],
      });
      throw new Error('expected LabelBulkError');
    } catch (e) {
      expect(e).toBeInstanceOf(LabelBulkError);
      expect((e as LabelBulkError).rowErrors[0]?.key).toBe('blank');
    }
  });

  it('retired sharing mutation refuses without changing flag data or creating an event', async () => {
    const a = adminCtx(b);
    const before=await eventTypesFor(b.tenantId,b.companyId);
    await expect(setCompanySharedLabels(a, { companyId: b.companyId, enabled: true })).rejects.toThrow('sharing is automatic');
    const [co] = await owner.db.select().from(schema.company).where(eq(schema.company.id, b.companyId));
    expect(co.sharedSystemLabels).toBe(false);
    expect(await eventTypesFor(b.tenantId,b.companyId)).toEqual(before);
  });
});
