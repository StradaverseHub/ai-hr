/**
 * Company context — a company reached only through the user's own employment is labelled as such.
 *
 * Production report (24 Nov 2026): an HR admin assigned to four companies also saw her employer in the
 * company context and read it as an unassigned company she had been given. allowedCompanies keeps the same
 * company SET (payroll, imports and exports intersect against it); each row now says whether a role assignment
 * covers it (`role`) or only the user's employment does (`employment`). Database authority is unchanged and
 * re-proved here: choosing the employer company shows a company-scoped admin nobody else's employment.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type Grant, type SessionContext } from '../db/client';
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { allowedCompanies } from '../core/read';

let b: Base;
beforeAll(async () => { await migrateTestDb(); });
afterAll(async () => { await closeAll(); });
beforeEach(async () => { await resetDb(); b = await seedBase(); });

const company = async (legalName: string, parentCompanyId: string | null = null) =>
  (await owner.db.insert(schema.company).values({ tenantId: b.tenantId, legalName, parentCompanyId }).returning({ id: schema.company.id }))[0].id;

const hire = async (fullName: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `${fullName.toLowerCase().replace(/\W+/g, '.')}@fictional.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** A real login for `personId` holding exactly `grants` as role assignments, so the session matches the database. */
async function login(personId: string, grants: Grant[]): Promise<SessionContext> {
  const [user] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${crypto.randomUUID()}`, personId }).returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values(grants.map(grant => ({ tenantId: b.tenantId, appUserId: user.id, role: grant.role, companyId: grant.companyId })));
  return { tenantId: b.tenantId, userId: user.id, personId, grants, roles: [...new Set(grants.map(grant => grant.role))], entitlements: harnessSnapshot(b.tenantId) };
}

describe('company context access labels', () => {
  it('labels the employer company employment-only beside the companies her roles name', async () => {
    const cement = await company('Fictional Cement Sdn Bhd');
    const concrete = await company('Fictional Concrete Sdn Bhd');
    const { personId } = await hire('Scoped Admin');
    const ctx = await login(personId, [
      { role: 'hr_admin', companyId: cement },
      { role: 'hr_admin', companyId: concrete },
      { role: 'employee', companyId: null },
    ]);

    const rows = await allowedCompanies(ctx);
    expect(rows).toHaveLength(3);
    expect(new Map(rows.map(row => [row.id, row.access]))).toEqual(new Map([[b.companyId, 'employment'], [cement, 'role'], [concrete, 'role']]));

    // The label does not change authority: with the employer company in view she sees her own employment
    // and no colleague's, because no assignment makes her an admin there.
    const colleague = await hire('Employer Colleague');
    const visible = await withTenant(ctx, tx => tx.select({ id: schema.employment.id }).from(schema.employment).where(eq(schema.employment.companyId, b.companyId)));
    expect(visible.map(row => row.id)).not.toContain(colleague.employmentId);
    expect(visible).toHaveLength(1);
  });

  it('treats an employer below an assigned parent company as role-covered', async () => {
    const parent = await company('Fictional Holdings Bhd');
    await owner.db.update(schema.company).set({ parentCompanyId: parent }).where(eq(schema.company.id, b.companyId));
    const { personId } = await hire('Parent Admin');
    const ctx = await login(personId, [{ role: 'hr_admin', companyId: parent }, { role: 'employee', companyId: null }]);

    const access = new Map((await allowedCompanies(ctx)).map(row => [row.id, row.access]));
    expect(access).toEqual(new Map([[parent, 'role'], [b.companyId, 'role']]));
  });

  it('treats every company as role-covered under a group-wide role other than employee', async () => {
    const assigned = await company('Fictional Drymix Sdn Bhd');
    const { personId } = await hire('Wide Partner');
    const ctx = await login(personId, [{ role: 'hr_admin', companyId: assigned }, { role: 'payroll_partner', companyId: null }]);

    const access = new Map((await allowedCompanies(ctx)).map(row => [row.id, row.access]));
    expect(access).toEqual(new Map([[assigned, 'role'], [b.companyId, 'role']]));
  });

  it('labels a plain employee\'s only company employment-only', async () => {
    const { personId } = await hire('Plain Employee');
    const ctx = await login(personId, [{ role: 'employee', companyId: null }]);
    expect(await allowedCompanies(ctx)).toEqual([{ id: b.companyId, name: expect.any(String), access: 'employment' }]);
  });

  it('labels every company role-covered for a group admin', async () => {
    const other = await company('Fictional Second Company Bhd');
    const ctx: SessionContext = { tenantId: b.tenantId, userId: b.adminUserId, grants: [{ role: 'hr_admin', companyId: null }], entitlements: harnessSnapshot(b.tenantId) };
    const access = new Map((await allowedCompanies(ctx)).map(row => [row.id, row.access]));
    expect(access).toEqual(new Map([[b.companyId, 'role'], [other, 'role']]));
  });
});
