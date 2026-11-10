/** The paged Claims approvals queue must return exactly the base inbox row set (listPendingClaims):
 * no company-switcher narrowing, same sort, same selection. Real DB, fictional fixtures. */
import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import type {SessionContext} from '../db/client';
import {claimRequest} from '../db/schema';
import {createCompany, createDepartment} from '../core/admin';
import {hireEmployee, setReportingLine} from '../core/org';
import {createClaimType, listPendingClaims, listPendingClaimsPage, listPendingClaimSelection} from '../packs/claims/service';
import {APPROVAL_SORTS, sortApprovalRows} from '../lib/approvals-sort';
import {adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base} from './harness';

let b: Base, root: SessionContext;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'claims', 'active');
  root = {...adminCtx(b), grants: [{role: 'hr_admin', companyId: null}]};
});

async function groupFixture() {
  const other = await createCompany(root, {legalName: 'Fictional Sister Company', country: 'MY', currency: 'MYR'});
  const otherDept = await createDepartment(root, {companyId: other.id, name: 'Fictional Sister Department'});
  const hire = (fullName: string, companyId: string, departmentId: string) => hireEmployee(root, {
    person: {fullName, primaryEmail: randomUUID() + '@fixture.test'}, companyId, departmentId,
    employmentType: 'full_time', hiredOn: '2020-01-01'});
  const manager = await hire('Fictional Group Manager', b.companyId, b.deptA);
  const home = await hire('Fictional Home Report', b.companyId, b.deptA);
  const sister = await hire('Fictional Sister Report', other.id, otherDept.id);
  for (const report of [home, sister]) await setReportingLine(root, {subordinateEmploymentId: report.employmentId,
    managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2020-01-01'});
  const type = await createClaimType(root, {code: 'GROUP', name: 'Fictional group claim', defaultTaxable: false, requiresReceipt: false});
  // 27 pending claims across both companies (two pages of 25), with distinct and tied submission times.
  const rows = Array.from({length: 27}, (_, i) => ({id: randomUUID(), tenantId: b.tenantId,
    employmentId: (i % 2 ? sister : home).employmentId, claimTypeId: type.id, amount: '1.00', incurredOn: '2026-01-02',
    status: 'pending' as const, createdAt: new Date(Date.UTC(2026, 0, 3, 0, Math.floor(i / 3)))}));
  await owner.db.insert(claimRequest).values([...rows, {...rows[0], id: randomUUID(), status: 'draft' as const}]);
  const sisterIds = rows.filter(row => row.employmentId === sister.employmentId).map(row => row.id);
  return {other, manager, home, sister, sisterIds};
}

async function pagedIds(ctx: SessionContext, sort?: (typeof APPROVAL_SORTS)[number]) {
  const first = await listPendingClaimsPage(ctx, {sort});
  const second = await listPendingClaimsPage(ctx, {sort, page: '1'});
  expect(second.page.total).toBe(first.page.total);
  return {total: first.page.total, ids: [...first.rows, ...second.rows].map(row => row.id)};
}

describe('claims approvals queue keeps the base row set', () => {
  it('shows an HR admin every decidable claim across group companies, in the base sort, with matching count and selection', async () => {
    const {sisterIds} = await groupFixture();
    const base = await listPendingClaims(root);
    expect(base).toHaveLength(27);
    for (const sort of APPROVAL_SORTS) {
      const expected = sortApprovalRows(base, sort, {id: r => r.id, name: r => r.claimantName, createdAt: r => r.createdAt}).map(r => r.id);
      const paged = await pagedIds(root, sort);
      expect(paged.total).toBe(27);
      expect(paged.ids).toEqual(expected);
    }
    expect((await pagedIds(root)).ids).toEqual(expect.arrayContaining(sisterIds));
    expect(await listPendingClaimSelection(root)).toEqual(base.map(r => r.id).sort());
  });

  it('keeps the manager queue equal to the base inbox across group companies, with no company filter', async () => {
    const {manager} = await groupFixture();
    const userId = await createAppUser(b.tenantId, manager.personId, 'manager');
    const ctx: SessionContext = {...await entitledCtx(b, ['manager']), userId, personId: manager.personId, grants: [{role: 'manager', companyId: null}]};
    const base = (await listPendingClaims(ctx)).map(r => r.id);
    // Request RLS, not a company switcher, decides the manager's cross-company reach; the page only pages it.
    expect(base.length).toBeGreaterThan(0);
    const paged = await pagedIds(ctx);
    expect(paged.total).toBe(base.length);
    expect(paged.ids.slice().sort()).toEqual(base.slice().sort());
    expect(await listPendingClaimSelection(ctx)).toEqual(base.slice().sort());
  });
});
