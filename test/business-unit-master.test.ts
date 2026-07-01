/**
 * ADR-0068 — Business Unit master: CRUD + integrity, the DomainEvent substrate, and the RLS split that is
 * the point of the design decision — read is TENANT-WIDE (so non-admin JOIN paths on department.business_
 * unit_id resolve), WRITE is admin-for-company only (job_grade/payroll_policy precedent, NOT location's
 * admin-only FOR ALL). Includes the GRANT regression guard (RLS enabled + missing grant = silent fail-closed,
 * the MEMORY "Test DB Recovery" failure mode): a real ai_hr_app admin can read AND write.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import { DuplicateError } from '../core/admin';
import {
  createBusinessUnit,
  updateBusinessUnit,
  archiveBusinessUnit,
  listBusinessUnits,
  createCompany,
} from '../core/admin';
import { type SessionContext } from '../db/client';

let b: Base;

/** A company-scoped hr_admin SessionContext (carries the grant so authz + RLS see it), as a real app role. */
async function adminFor(companyId: string | null): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId, role: 'hr_admin' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'hr_admin', companyId }] };
}

/** A non-admin (employee) SessionContext — used to prove the tenant-wide READ path works for non-admins. */
async function employeeCtx(): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, grants: [{ role: 'employee', companyId: null }] };
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

describe('business unit master (ADR-0068)', () => {
  it('creates + lists + archives; a flat, company-scoped catalog', async () => {
    const a = adminCtx(b);
    const { id } = await createBusinessUnit(a, { companyId: b.companyId, code: 'RET', name: 'Retail' });
    const [row] = await owner.db.select().from(schema.businessUnit).where(eq(schema.businessUnit.id, id));
    expect(row.code).toBe('RET');
    expect(row.name).toBe('Retail');
    expect(row.companyId).toBe(b.companyId);
    expect(row.archivedAt).toBeNull();

    await updateBusinessUnit(a, { id, code: 'RET', name: 'Retail Ops' });
    const [u] = await owner.db.select().from(schema.businessUnit).where(eq(schema.businessUnit.id, id));
    expect(u.name).toBe('Retail Ops');

    // default list hides archived; includeArchived shows it; archive frees the code.
    await archiveBusinessUnit(a, { id, archived: true });
    expect((await listBusinessUnits(a, { companyIds: [b.companyId] })).map((x) => x.id)).not.toContain(id);
    expect(
      (await listBusinessUnits(a, { companyIds: [b.companyId], includeArchived: true })).map((x) => x.id),
    ).toContain(id);
  });

  it('rejects blank code/name and enforces per-company code uniqueness among non-archived rows', async () => {
    const a = adminCtx(b);
    await expect(createBusinessUnit(a, { companyId: b.companyId, code: '  ', name: 'X' })).rejects.toThrow(/code is required/);
    await expect(createBusinessUnit(a, { companyId: b.companyId, code: 'X', name: '  ' })).rejects.toThrow(/name is required/);

    const { id } = await createBusinessUnit(a, { companyId: b.companyId, code: 'DUP', name: 'One' });
    // A duplicate code in the SAME company (case-insensitive) → DuplicateError.
    await expect(createBusinessUnit(a, { companyId: b.companyId, code: 'dup', name: 'Two' })).rejects.toBeInstanceOf(DuplicateError);

    // Archiving frees the code — a new row can reuse it.
    await archiveBusinessUnit(a, { id, archived: true });
    const { id: id2 } = await createBusinessUnit(a, { companyId: b.companyId, code: 'DUP', name: 'Two' });
    expect(id2).toBeTruthy();

    // A different company may reuse the code (per-company uniqueness).
    const { id: coB } = await createCompany(a, { legalName: 'BU Co B Sdn Bhd' });
    const { id: id3 } = await createBusinessUnit(a, { companyId: coB, code: 'DUP', name: 'B Dup' });
    expect(id3).toBeTruthy();
  });

  it('appends business-unit.created / updated / archived / unarchived events (substrate)', async () => {
    const a = adminCtx(b);
    const { id } = await createBusinessUnit(a, { companyId: b.companyId, code: 'EV', name: 'Ev' });
    await updateBusinessUnit(a, { id, code: 'EV', name: 'Ev2' });
    await archiveBusinessUnit(a, { id, archived: true });
    await archiveBusinessUnit(a, { id, archived: false });
    const types = await eventTypesFor(b.tenantId, id);
    expect(types).toEqual(
      expect.arrayContaining([
        'business-unit.created',
        'business-unit.updated',
        'business-unit.archived',
        'business-unit.unarchived',
      ]),
    );
  });

  it('GRANT regression: a real ai_hr_app admin can INSERT…RETURNING, read, and update (not fail-closed)', async () => {
    // Run entirely as the non-owner app role so RLS + grants are exercised (owner.db bypasses RLS).
    const adminA = await adminFor(b.companyId);
    const { id } = await createBusinessUnit(adminA, { companyId: b.companyId, code: 'GR', name: 'Grant' });
    expect(id).toBeTruthy(); // RETURNING succeeded under the app role (grant present)
    const seen = await listBusinessUnits(adminA, { companyIds: [b.companyId] });
    expect(seen.map((x) => x.id)).toContain(id);
    await updateBusinessUnit(adminA, { id, code: 'GR', name: 'Granted' });
    const after = await listBusinessUnits(adminA, { companyIds: [b.companyId] });
    expect(after.find((x) => x.id === id)?.name).toBe('Granted');
  });

  it('RLS: read is TENANT-WIDE (a non-admin employee can SELECT BUs), but WRITE is admin-for-company only', async () => {
    const a = adminCtx(b);
    const { id: bu } = await createBusinessUnit(a, { companyId: b.companyId, code: 'TW', name: 'TenantWide' });

    // Tenant-wide read: a plain employee (no admin grant) can still SEE the BU — the whole point of the
    // read-side RLS decision (department.business_unit_id JOIN paths run under non-admin sessions).
    const emp = await employeeCtx();
    const seenByEmployee = await listBusinessUnits(emp, { companyIds: [b.companyId] });
    expect(seenByEmployee.map((x) => x.id)).toContain(bu);

    // Write scoping: an admin scoped to ANOTHER company cannot create a BU under company A, and cannot
    // update A's BU (the WITH CHECK / is_admin_for guard). Create company B + its admin.
    const { id: coB } = await createCompany(a, { legalName: 'BU Write Co B Sdn Bhd' });
    const adminB = await adminFor(coB);
    await expect(createBusinessUnit(adminB, { companyId: b.companyId, code: 'X', name: 'X' })).rejects.toThrow();
    // Update by the wrong-company admin: the row IS visible (tenant-wide read) but the UPDATE is blocked
    // by RLS WITH CHECK, so the write does not persist. Assert the name is unchanged after the attempt.
    await updateBusinessUnit(adminB, { id: bu, code: 'TW', name: 'Hacked' }).catch(() => {});
    const [row] = await owner.db.select().from(schema.businessUnit).where(eq(schema.businessUnit.id, bu));
    expect(row.name).toBe('TenantWide');
  });

  it('inUse reflects a department linking to the BU', async () => {
    const a = adminCtx(b);
    const { id: bu } = await createBusinessUnit(a, { companyId: b.companyId, code: 'IU', name: 'InUse' });
    // No department links it yet.
    expect((await listBusinessUnits(a, { companyIds: [b.companyId] })).find((x) => x.id === bu)?.inUse).toBe(false);
    // Link a department (owner.db direct, bypassing RLS, is fine for the fixture).
    await owner.db
      .update(schema.department)
      .set({ businessUnitId: bu })
      .where(and(eq(schema.department.id, b.deptA), sql`true`));
    expect((await listBusinessUnits(a, { companyIds: [b.companyId] })).find((x) => x.id === bu)?.inUse).toBe(true);
  });
});
