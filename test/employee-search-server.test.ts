import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { getEmployeeOption, listEmployeeOptionFacets, listEmployeeOptionsPage, searchEmployeeOptions } from '../core/employee-search';
import { matchEmployees } from '../lib/employee-search';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let base: Base;
beforeAll(migrateTestDb);
beforeEach(async () => { await resetDb(); base = await seedBase(); });
afterAll(closeAll);

async function employees(names: { name: string; code: string | null }[], companyId = base.companyId, tenantId = base.tenantId, departmentId = base.deptA) {
  const records = names.map((entry) => ({ ...entry, id: randomUUID(), personId: randomUUID() }));
  await owner.db.insert(schema.person).values(records.map((row) => ({
    id: row.personId, tenantId, fullName: row.name, primaryEmail: `${row.personId}@fixture.test`,
  })));
  await owner.db.insert(schema.employment).values(records.map((row) => ({
    id: row.id, tenantId, personId: row.personId, companyId,
    employeeCode: row.code, hiredOn: '2020-01-01',
  })));
  await owner.db.insert(schema.assignment).values(records.map((row) => ({
    tenantId, employmentId: row.id, departmentId, employmentType: 'full_time' as const, validFrom: '2020-01-01',
  })));
  return records;
}

const search = (query: string, limit?: number) => searchEmployeeOptions(adminCtx(base), { companyIds: [base.companyId], query, limit });
const manyEmployees = () => employees(Array.from({ length: 64 }, (_, index) => ({
  name: `Employee ${String(index).padStart(3, '0')}`, code: `EMP-${String(index).padStart(4, '0')}`,
})));

describe('bounded employee search over the complete authorized population', () => {
  it('bounds response size and counts the complete authorized population', async () => {
    await manyEmployees();
    expect(await search('Employee')).toHaveLength(8);
    expect(await search('Employee', 4000)).toHaveLength(50);
    const first = await listEmployeeOptionsPage(adminCtx(base), { companyIds: [base.companyId], limit: 25, offset: 0 });
    expect(first.rows).toHaveLength(25);
    expect(first.total).toBe(64);
    const final = await listEmployeeOptionsPage(adminCtx(base), { companyIds: [base.companyId], limit: 25, offset: 50 });
    expect(final.rows).toHaveLength(14);
    expect(final.total).toBe(64);
  });

  it('finds a specific employee beyond both the initial page and the hard response cap', async () => {
    const seeded = await manyEmployees();
    const first = await listEmployeeOptionsPage(adminCtx(base), { companyIds: [base.companyId], limit: 25, offset: 0 });
    const last = seeded[63];
    expect(first.rows.map((row) => row.employmentId)).not.toContain(last.id);
    expect((await search('emp0063')).map((row) => row.employmentId)).toEqual([last.id]);
    expect((await search('Employee 063')).map((row) => row.employmentId)).toEqual([last.id]);
    expect((await getEmployeeOption(adminCtx(base), [base.companyId], last.id))?.employmentId).toBe(last.id);
  });

  it('keeps ranking, code separator folding and literal wildcard characters consistent with existing search', async () => {
    const seeded = await employees([
      { name: 'Aisha 100% Rahman', code: 'EMP-0008' },
      { name: 'Bala Krishnan', code: 'EMP-0081' },
      { name: 'Chan Wei Ming', code: 'CTR_0002' },
      { name: 'Rahman Bin Yusof', code: null },
    ]);
    const ordered = [...seeded].sort((a, b) => a.name.localeCompare(b.name)).map((row) => ({
      employmentId: row.id, name: row.name, employeeCode: row.code,
    }));
    for (const query of ['emp.0008', 'EMP 00', 'rahman', 'wei', 'CTR', '100%', '_', 'missing']) {
      expect((await search(query)).map((row) => row.employmentId), query)
        .toEqual(matchEmployees(ordered, query).map((row) => row.employmentId));
    }
  });

  it('includes leavers by default and applies lifecycle/department filters before limiting', async () => {
    const [ended, active] = await employees([{ name: 'Ended Person', code: 'END' }, { name: 'Active Person', code: 'ACT' }]);
    await owner.db.update(schema.employment).set({ terminatedOn: '2021-01-01' }).where(eq(schema.employment.id, ended.id));
    expect((await search('Ended')).map((row) => row.employmentId)).toEqual([ended.id]);
    const input = { companyIds: [base.companyId], departmentId: base.deptA, limit: 1, offset: 0 };
    expect((await listEmployeeOptionsPage(adminCtx(base), { ...input, status: 'terminated' })).rows.map((row) => row.employmentId)).toEqual([ended.id]);
    expect((await listEmployeeOptionsPage(adminCtx(base), { ...input, status: 'active' })).rows.map((row) => row.employmentId)).toEqual([active.id]);
    expect(await listEmployeeOptionsPage(adminCtx(base), { ...input, departmentId: base.deptB })).toEqual({ rows: [], total: 0 });
  });

  it('enforces active company scope, RLS company grants, tenant isolation and empty scope independently', async () => {
    const [otherCompany] = await owner.db.insert(schema.company).values({ tenantId: base.tenantId, legalName: 'Other Company' }).returning();
    const [otherDept] = await owner.db.insert(schema.department).values({ tenantId: base.tenantId, companyId: otherCompany.id, name: 'Private Department' }).returning();
    const [mine] = await employees([{ name: 'Accessible Employee', code: 'VISIBLE' }]);
    const [hidden] = await employees([{ name: 'Hidden Employee', code: 'SECRET' }], otherCompany.id, base.tenantId, otherDept.id);
    const all = [base.companyId, otherCompany.id];
    // Positive controls: the target exists and a group administrator can reach it.
    expect((await searchEmployeeOptions(adminCtx(base), { companyIds: all, query: 'SECRET' }))[0]?.employmentId).toBe(hidden.id);
    expect(await search('SECRET')).toEqual([]);
    const [user] = await owner.db.insert(schema.appUser).values({ tenantId: base.tenantId, workosUserId: randomUUID() }).returning();
    await owner.db.insert(schema.roleAssignment).values({ tenantId: base.tenantId, appUserId: user.id, companyId: base.companyId, role: 'hr_admin' });
    const restricted = { ...adminCtx(base), userId: user.id, grants: [{ role: 'hr_admin', companyId: base.companyId }] };
    expect(await searchEmployeeOptions(restricted, { companyIds: all, query: 'SECRET' })).toEqual([]);
    expect(await getEmployeeOption(restricted, all, hidden.id)).toBeNull();
    expect((await searchEmployeeOptions(restricted, { companyIds: all, query: 'VISIBLE' }))[0]?.employmentId).toBe(mine.id);
    expect((await listEmployeeOptionsPage(restricted, { companyIds: all, limit: 25, offset: 0 })).total).toBe(1);
    expect((await listEmployeeOptionFacets(restricted, all)).departments).toEqual([{ id: base.deptA, name: 'Finance' }]);
    expect((await listEmployeeOptionFacets(adminCtx(base), all)).departments.map((row) => row.id)).toContain(otherDept.id);
    const otherTenant = await seedBase();
    const [foreign] = await employees([{ name: 'Foreign Employee', code: 'FOREIGN' }], otherTenant.companyId, otherTenant.tenantId, otherTenant.deptA);
    expect(await searchEmployeeOptions(adminCtx(base), { companyIds: [otherTenant.companyId], query: 'FOREIGN' })).toEqual([]);
    expect(await getEmployeeOption(adminCtx(base), [otherTenant.companyId], foreign.id)).toBeNull();
    expect(await searchEmployeeOptions(adminCtx(base), { companyIds: [], query: 'VISIBLE' })).toEqual([]);
    expect(await listEmployeeOptionsPage(adminCtx(base), { companyIds: [], limit: 25, offset: 0 })).toEqual({ rows: [], total: 0 });
    expect(await listEmployeeOptionFacets(adminCtx(base), [])).toEqual({ companies: [], businessUnits: [], departments: [] });
  });

  it('does not return identity data for blank/oversized searches or malformed selected IDs', async () => {
    await employees([{ name: 'Known Employee', code: 'KNOWN' }]);
    expect(await search('   ')).toEqual([]);
    expect(await search('x'.repeat(201))).toEqual([]);
    expect(await getEmployeeOption(adminCtx(base), [base.companyId], 'not-an-id')).toBeNull();
  });
});
