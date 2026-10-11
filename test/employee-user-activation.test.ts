import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { listEmployeeActivationCandidates } from '../core/employee-user-activation';
import * as schema from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);
const hire = (name = 'Pending employee', email = 'pending@example.test') => hireEmployee(adminCtx(base), {
  person: { fullName: name, primaryEmail: email }, companyId: base.companyId, departmentId: base.deptA,
  employmentType: 'full_time', hiredOn: todayInKualaLumpur(),
});
const candidates = () => listEmployeeActivationCandidates(adminCtx(base));
describe('automatic employee activation directory', () => {
  it('a committed hire appears immediately without creating a login, grant, invitation or provider identity', async () => {
    const beforeUsers = await owner.db.select().from(schema.appUser);
    const beforeGrants = await owner.db.select().from(schema.roleAssignment);
    const e = await hire();
    expect(await candidates()).toEqual([expect.objectContaining({ id: e.personId, name: 'Pending employee', email: 'pending@example.test' })]);
    expect(await candidates()).toHaveLength(1);
    expect(await owner.db.select().from(schema.appUser)).toEqual(beforeUsers);
    expect(await owner.db.select().from(schema.roleAssignment)).toEqual(beforeGrants);
    expect(await owner.db.select().from(schema.appInvitation)).toHaveLength(0);
    expect(await owner.db.select().from(schema.appExternalIdentity)).toHaveLength(0);
  });
  it('uses person identity: multiple employments yield one candidate, shared emails yield separate people', async () => {
    const e = await hire();
    await hireEmployee(adminCtx(base), { person: { id: e.personId }, companyId: base.companyId, departmentId: base.deptB,
      employmentType: 'part_time', hiredOn: todayInKualaLumpur() });
    expect(await candidates()).toHaveLength(1);
    const other = await hire('Another employee');
    expect((await candidates()).map(p => p.id).sort()).toEqual([e.personId, other.personId].sort());
  });
  it('an existing login, including an archived or unactivated placeholder login, suppresses new activation', async () => {
    const e = await hire();
    const [user] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, personId: e.personId, workosUserId: `seed:${randomUUID()}` }).returning();
    expect(await candidates()).toEqual([]);
    await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, user.id));
    await hireEmployee(adminCtx(base), { person: { id: e.personId }, companyId: base.companyId, departmentId: base.deptB,
      employmentType: 'part_time', hiredOn: todayInKualaLumpur() });
    expect(await candidates()).toEqual([]);
  });
  it('requires a non-ended employment; another live employment or a rehire restores eligibility only without a login', async () => {
    const e = await hire();
    const yesterday = new Date(`${todayInKualaLumpur()}T12:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await owner.db.update(schema.employment).set({ terminatedOn: yesterday.toISOString().slice(0, 10) }).where(eq(schema.employment.id, e.employmentId));
    expect(await candidates()).toEqual([]);
    await hireEmployee(adminCtx(base), { person: { id: e.personId }, companyId: base.companyId, departmentId: base.deptB,
      employmentType: 'part_time', hiredOn: todayInKualaLumpur() });
    expect((await candidates()).map(p => p.id)).toEqual([e.personId]);
    await owner.db.update(schema.employment).set({ blacklistedAt: todayInKualaLumpur() }).where(eq(schema.employment.personId, e.personId));
    expect(await candidates()).toEqual([]);
  });
  it('does not list people without employment, cross-tenant employees, or expose the roster to delegated admins/employees', async () => {
    await owner.db.insert(schema.person).values({ tenantId: base.tenantId, fullName: 'Not an employee', primaryEmail: 'person@example.test' });
    await hire();
    const foreign = await seedBase();
    await hireEmployee(adminCtx(foreign), { person: { fullName: 'Foreign', primaryEmail: 'foreign@example.test' }, companyId: foreign.companyId,
      departmentId: foreign.deptA, employmentType: 'full_time', hiredOn: todayInKualaLumpur() });
    expect((await candidates()).map(p => p.name)).toEqual(['Pending employee']);
    for (const grants of [[{ role: 'employee', companyId: null }], [{ role: 'hr_admin', companyId: base.companyId }], [{ role: 'operator', companyId: null }]]) {
      await expect(listEmployeeActivationCandidates({ ...adminCtx(base), grants })).rejects.toThrow(/group administrator/);
    }
  });
});
