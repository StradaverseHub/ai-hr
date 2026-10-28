/**
 * WP-B2 — the Leaders screen roster read (getLeaderRoster) against real RLS as ai_hr_app.
 *
 * Pins the facts the first version got wrong without a database: a correlated subquery inside a
 * single-table drizzle selection binds a bare column to the inner table, which made every company look
 * unit-less (no business group ever shown) and every department null. Also pins whose people each viewer
 * reads and the write-capability hints.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { createCompany, createDepartment } from '../core/admin';
import { hireEmployee } from '../core/org';
import * as perf from '../packs/performance/service';
import { closeAll, createAppUser, entitledCtx, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { todayInKualaLumpur } from '../lib/hr-date';

const year = Number(todayInKualaLumpur().slice(0, 4));
type Hired = { employmentId: string; personId: string };
let b: Base, a: SessionContext, holding: string, other: string, deptX: string;
let current: Hired, ended: Hired, xPerson: Hired, partnerPerson: Hired, unitAdminPerson: Hired, plainPerson: Hired;

const hire = (name: string, companyId: string, departmentId: string): Promise<Hired> =>
  hireEmployee(a, { person: { fullName: name, primaryEmail: `${randomUUID()}@leader-roster.test` }, companyId, departmentId, employmentType: 'full_time', hiredOn: `${year - 2}-01-01` });
async function scoped(person: Hired, role: 'hr_admin' | 'performance_partner', companyId: string): Promise<SessionContext> {
  const [u] = await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId: person.personId }).returning({ id: schema.appUser.id });
  await owner.db.insert(schema.roleAssignment).values({ tenantId: b.tenantId, appUserId: u.id, companyId, role });
  return { tenantId: b.tenantId, userId: u.id, personId: person.personId, roles: [role], grants: [{ role, companyId }], entitlements: a.entitlements };
}
async function plain(person: Hired): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, person.personId, 'employee');
  return { tenantId: b.tenantId, userId, personId: person.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }], entitlements: a.entitlements };
}

beforeEach(async () => {
  await resetDb(); b = await seedBase();
  await setModule(b.tenantId, 'performance', 'active');
  a = await entitledCtx(b);
  ({ id: holding } = await createCompany(a, { legalName: 'Roster Holding Bhd' }));
  await owner.db.update(schema.company).set({ parentCompanyId: holding }).where(eq(schema.company.id, b.companyId));
  ({ id: other } = await createCompany(a, { legalName: 'Roster Other Sdn Bhd' }));
  ({ id: deptX } = await createDepartment(a, { companyId: other, name: 'Roster other dept' }));
  current = await hire('Roster current', b.companyId, b.deptA);
  ended = await hire('Roster ended', b.companyId, b.deptB);
  // The only assignment ends today (valid_to is exclusive), so nothing is live today.
  await owner.db.update(schema.assignment).set({ validTo: todayInKualaLumpur() }).where(eq(schema.assignment.employmentId, ended.employmentId));
  xPerson = await hire('Roster other unit', other, deptX);
  partnerPerson = await hire('Roster partner', b.companyId, b.deptA);
  unitAdminPerson = await hire('Roster unit admin', b.companyId, b.deptA);
  plainPerson = await hire('Roster plain', b.companyId, b.deptA);
});
afterAll(closeAll);

describe('getLeaderRoster', () => {
  it('flags a parent company with units as a business group node and its unit as not one', async () => {
    const r = await perf.getLeaderRoster(a);
    const byId = new Map(r.companies.map((c) => [c.id, c]));
    expect(byId.get(holding)?.isGroupNode).toBe(true);
    expect(byId.get(b.companyId)?.isGroupNode).toBe(false);
    expect(byId.get(b.companyId)?.parentCompanyId).toBe(holding);
    expect(byId.get(other)?.isGroupNode).toBe(false);
  });

  it("returns a person's current department id and name, and nothing for an ended assignment", async () => {
    const [dept] = await owner.db.select({ name: schema.department.name }).from(schema.department).where(eq(schema.department.id, b.deptA));
    expect(dept?.name, 'fixture department has a name').toBeTruthy();
    const r = await perf.getLeaderRoster(a);
    const row = r.people.find((p) => p.employmentId === current.employmentId);
    expect(row).toMatchObject({ companyId: b.companyId, departmentId: b.deptA, departmentName: dept.name, name: 'Roster current' });
    const x = r.people.find((p) => p.employmentId === xPerson.employmentId);
    expect(x).toMatchObject({ companyId: other, departmentId: deptX, departmentName: 'Roster other dept' });
    const gone = r.people.find((p) => p.employmentId === ended.employmentId);
    expect(gone, 'the employment itself is still live').toBeDefined();
    expect(gone).toMatchObject({ departmentId: null, departmentName: null });
  });

  it('gives a viewer without OneHR administration no people and no companies', async () => {
    const r = await perf.getLeaderRoster(await plain(plainPerson));
    expect(r.people).toEqual([]);
    expect(r.companies).toEqual([]);
    expect(r).toMatchObject({ canWriteHod: false, canWriteGroupChief: false });
  });

  it("shows a company administrator their company's people and none of another company's", async () => {
    const r = await perf.getLeaderRoster(await scoped(unitAdminPerson, 'hr_admin', b.companyId));
    const ids = r.people.map((p) => p.employmentId);
    expect(ids).toContain(current.employmentId);
    expect(ids).not.toContain(xPerson.employmentId);
    expect(r.people.every((p) => p.companyId === b.companyId)).toBe(true);
    expect(r.companies.map((c) => c.id)).not.toContain(other);
  });

  it('capabilities: the tenant administrator may write everything; the performance partner writes nothing', async () => {
    const admin = await perf.getLeaderRoster(a);
    expect(admin).toMatchObject({ canWriteHod: true, canWriteGroupChief: true });
    expect(admin.companies.length).toBeGreaterThanOrEqual(3);
    expect(admin.companies.every((c) => c.canWriteBuCeo && c.canWriteBgCeo)).toBe(true);
    const partner = await perf.getLeaderRoster(await scoped(partnerPerson, 'performance_partner', b.companyId));
    expect(partner.people.map((p) => p.employmentId), 'the partner reads their company').toContain(current.employmentId);
    expect(partner).toMatchObject({ canWriteHod: false, canWriteGroupChief: false });
    expect(partner.companies.length).toBeGreaterThan(0);
    expect(partner.companies.every((c) => !c.canWriteBuCeo && !c.canWriteBgCeo)).toBe(true);
  });
});
