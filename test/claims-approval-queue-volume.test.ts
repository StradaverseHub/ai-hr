/** The Claims approvals queue at the steady performance fixture's volume (2,000 pending claims per
 * employee, worker comparison 20261110): a manager with ten reports sees 22,000 pending claims. The
 * approval subject depends only on the claim's employment, so the queue must resolve it once per
 * employment, not once per claim row; the per-row form held the manager's /approvals document past the
 * driver's 90 s request deadline. Row set, count, sort and selection stay exactly the base inbox's.
 * Real DB, fictional fixtures. */
import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {createClaimType, listPendingClaimsPage, listPendingClaimSelection} from '../packs/claims/service';
import {hireEmployee, setReportingLine} from '../core/org';
import {adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base} from './harness';

const REPORTS = 10;
const CLAIMS_PER_EMPLOYEE = 2000;
/** Generous against CI noise; the per-row subject form takes many times longer at this volume. */
const QUEUE_READ_BOUND_MS = 15_000;

let b: Base, ctx: SessionContext, managerEmploymentId: string, reportIds: string[];
beforeAll(async () => {
  await migrateTestDb(); await resetDb(); b = await seedBase(); await setModule(b.tenantId, 'claims', 'active');
  const root: SessionContext = {...adminCtx(b), grants: [{role: 'hr_admin', companyId: null}]};
  const hire = (fullName: string) => hireEmployee(root, {person: {fullName, primaryEmail: randomUUID() + '@fixture.test'},
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01'});
  const manager = await hire('Fictional Volume Manager');
  const reports = [];
  for (let i = 0; i < REPORTS; i++) reports.push(await hire('Fictional Volume Report ' + String(i).padStart(2, '0')));
  for (const report of reports) await setReportingLine(root, {subordinateEmploymentId: report.employmentId,
    managerEmploymentId: manager.employmentId, lineType: 'administrative', validFrom: '2020-01-01'});
  const type = await createClaimType(root, {code: 'VOLUME', name: 'Fictional volume claim', defaultTaxable: false, requiresReceipt: false});
  managerEmploymentId = manager.employmentId; reportIds = reports.map(report => report.employmentId);
  // The steady fixture's shape: every claim pending, one per minute per employee, tied across employees.
  await owner.db.execute(sql`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
    select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,'2026-01-02'::date,'pending',timestamptz '2026-01-03 00:00:00+00'-n*interval '1 minute'
    from unnest(${'{' + [managerEmploymentId, ...reportIds].join(',') + '}'}::uuid[]) e(id) cross join generate_series(1,${CLAIMS_PER_EMPLOYEE}::integer) n`);
  await owner.db.execute(sql`analyze claim_request`);
  const userId = await createAppUser(b.tenantId, manager.personId, 'manager');
  ctx = {...await entitledCtx(b, ['manager']), userId, personId: manager.personId, grants: [{role: 'manager', companyId: null}]};
}, 180_000);
afterAll(closeAll);

/** Independent expectation from the owner role: the manager's own and reports' pending claims, newest
 * first, request id breaking ties (the inbox's latest-first order). */
async function expectedIds(employmentIds: string[]) {
  const rows = await owner.db.execute<{id: string}>(sql`select id::text from claim_request
    where tenant_id=${b.tenantId}::uuid and status='pending' and employment_id = any(${'{' + employmentIds.join(',') + '}'}::uuid[])
    order by created_at desc, id::text collate "C"`);
  return rows.map(row => row.id);
}

describe('claims approvals queue at the steady fixture volume', () => {
  it('pages the manager queue within the bound, with the exact base count and order', async () => {
    const expected = await expectedIds([managerEmploymentId, ...reportIds]);
    expect(expected).toHaveLength((REPORTS + 1) * CLAIMS_PER_EMPLOYEE);
    const started = performance.now();
    const first = await listPendingClaimsPage(ctx);
    const elapsed = Math.round(performance.now() - started);
    expect(elapsed, `manager queue page read took ${elapsed} ms`).toBeLessThan(QUEUE_READ_BOUND_MS);
    expect(first.page.total).toBe(expected.length);
    expect(first.rows.map(row => row.id)).toEqual(expected.slice(0, 25));
    const second = await listPendingClaimsPage(ctx, {page: '1'});
    expect(second.rows.map(row => row.id)).toEqual(expected.slice(25, 50));
  }, 300_000);

  it('captures the selectable claims (all but the manager\'s own) within the bound', async () => {
    const expected = (await expectedIds(reportIds)).sort();
    const started = performance.now();
    const ids = await listPendingClaimSelection(ctx);
    const elapsed = Math.round(performance.now() - started);
    expect(elapsed, `manager queue selection took ${elapsed} ms`).toBeLessThan(QUEUE_READ_BOUND_MS);
    expect(ids).toEqual(expected);
  }, 300_000);
});
