/** DIAGNOSTIC ONLY (not for merge): time the server reads behind the early worker-comparison pilot routes at the
 * steady fixture's per-employee claim volume (2,000 pending claims per employee), through the shared read snapshot
 * and through independent transactions. Real DB, fictional fixtures. */
import {randomUUID} from 'node:crypto';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withIndependentTransactions, type SessionContext} from '../db/client';
import {createClaimType, listPendingClaimsPage, pendingClaimTaskSummary} from '../packs/claims/service';
import {hireEmployee, setReportingLine} from '../core/org';
import {readAtAGlance, readDoneForYou, readNeedsYou, readWatching} from '../components/today/reads';
import {readMyPayrollReadiness} from '../core/pre-salary/person-items';
import {todayAudience} from '../lib/today/audience';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx, closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base} from './harness';

const REPORTS = 10;
const CLAIMS_PER_EMPLOYEE = 2000;
let b: Base, manager: SessionContext, employee: SessionContext, hr: SessionContext;
let managerEmploymentId: string, employeeEmploymentId: string;
beforeAll(async () => {
  await migrateTestDb(); await resetDb(); b = await seedBase();
  for (const module of ['claims', 'payroll', 'attendance']) await setModule(b.tenantId, module, 'active');
  const root: SessionContext = {...adminCtx(b), grants: [{role: 'hr_admin', companyId: null}]};
  const hire = (fullName: string) => hireEmployee(root, {person: {fullName, primaryEmail: randomUUID() + '@fixture.test'},
    companyId: b.companyId, departmentId: b.deptA, employmentType: 'full_time', hiredOn: '2020-01-01'});
  const boss = await hire('Fictional Diagnostic Manager');
  const reports = [];
  for (let i = 0; i < REPORTS; i++) reports.push(await hire('Fictional Diagnostic Report ' + String(i).padStart(2, '0')));
  for (const report of reports) await setReportingLine(root, {subordinateEmploymentId: report.employmentId,
    managerEmploymentId: boss.employmentId, lineType: 'administrative', validFrom: '2020-01-01'});
  const type = await createClaimType(root, {code: 'DIAG', name: 'Fictional diagnostic claim', defaultTaxable: false, requiresReceipt: false});
  managerEmploymentId = boss.employmentId; employeeEmploymentId = reports[0].employmentId;
  await owner.db.execute(sql`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
    select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,current_date,'pending',now()-n*interval '1 minute'
    from unnest(${'{' + [boss.employmentId, ...reports.map(r => r.employmentId)].join(',') + '}'}::uuid[]) e(id) cross join generate_series(1,${CLAIMS_PER_EMPLOYEE}::integer) n`);
  await owner.db.execute(sql`analyze claim_request`);
  const managerUser = await createAppUser(b.tenantId, boss.personId, 'manager');
  manager = {...await entitledCtx(b, ['manager', 'employee']), userId: managerUser, personId: boss.personId,
    grants: [{role: 'manager', companyId: b.companyId}, {role: 'employee', companyId: b.companyId}]};
  const employeeUser = await createAppUser(b.tenantId, reports[0].personId, 'employee');
  employee = {...await entitledCtx(b, ['employee']), userId: employeeUser, personId: reports[0].personId,
    grants: [{role: 'employee', companyId: b.companyId}]};
  hr = {...await entitledCtx(b, ['hr_admin']), grants: [{role: 'hr_admin', companyId: null}]};
}, 300_000);
afterAll(closeAll);

async function timed(label: string, read: () => Promise<unknown>) {
  const run = async (mode: string, work: () => Promise<unknown>) => {
    const started = performance.now();
    let outcome = 'ok';
    try { const value = await work(); if (value && typeof value === 'object' && 'failed' in value && (value as {failed?: unknown}).failed) outcome = 'section-failed'; }
    catch (error) { outcome = 'threw:' + String((error as {name?: string})?.name) + ':' + String((error as {code?: string})?.code ?? ''); }
    return {mode, ms: Math.round(performance.now() - started), outcome};
  };
  const shared = await run('shared', read);
  const independent = await run('independent', () => withIndependentTransactions(read));
  console.log('PILOT_DIAG ' + JSON.stringify({label, shared, independent}));
}

describe('pilot route reads at steady per-employee claim volume (diagnostic)', () => {
  it('times the Today, Before payroll and Claims reads for the manager, employee and HR', async () => {
    const today = todayInKualaLumpur(), scopeIds = [b.companyId], locale = 'en';
    for (const [role, ctx, employmentId] of [['manager', manager, managerEmploymentId], ['employee', employee, employeeEmploymentId]] as const) {
      await timed(role + ':needsYou', () => readNeedsYou(ctx, {scopeIds, audience: todayAudience(ctx), today, locale}));
      await timed(role + ':beforePayroll', () => readMyPayrollReadiness(ctx, {employmentId, scopeIds, locale, today, includeApprovals: false}));
      await timed(role + ':payrollReadinessPage', () => readMyPayrollReadiness(ctx, {scopeIds, locale, approvalPreview: true}));
      await timed(role + ':doneForYou', () => readDoneForYou(ctx, {scopeIds, today}));
      await timed(role + ':atAGlance', () => readAtAGlance(ctx, {employmentId, locale, today}));
    }
    await timed('manager:approvalsQueue', () => listPendingClaimsPage(manager));
    await timed('manager:claimTaskSummary', () => pendingClaimTaskSummary(manager, scopeIds));
    await timed('hr:needsYou', () => readNeedsYou(hr, {scopeIds, audience: todayAudience(hr), today, locale}));
    await timed('hr:doneForYou', () => readDoneForYou(hr, {scopeIds, today}));
    await timed('hr:watching', () => readWatching(hr, {scopeIds, today}));
    await timed('hr:claimTaskSummary', () => pendingClaimTaskSummary(hr, scopeIds));
    expect(true).toBe(true);
  }, 600_000);
});
