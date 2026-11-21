/** Attribute work in the unchanged Leave decision query on the fictional group fixture. */
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { accountTaskCallerSql } from '../core/account-task-bundle';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { leaveType, reportingLine } from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { assertAssignedWorkPrincipalTx } from '../core/approvals';
import { pendingLeaveDecisionTasksBundleSql } from '../packs/leave/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase } from './harness';

afterAll(closeAll);

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Function Name'?: string;
  'Subplan Name'?: string;
  'Actual Total Time'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};
type Explain = { Plan: PlanNode; 'Planning Time': number; 'Execution Time': number };
const relations = new Set(['leave_request','leave_approval_step','leave_cancellation_request',
  'leave_cancellation_step','employment','person','reporting_line','role_assignment']);
const functions = new Set(['delegated_approval_subjects','delegated_approval_subject',
  'visible_employment_ids','can_decide_via_delegation']);
const subplans = new Set(['CTE headers','CTE subject_rows','CTE distinct_subjects']);

async function profile(tx: Tx, statement: SQL) {
  const [row] = await tx.execute<{ 'QUERY PLAN': Explain[] }>(
    sql`explain (analyze, timing on, summary, format json) ${statement}`,
  );
  const plan = row['QUERY PLAN'][0];
  expect(Number.isFinite(plan['Planning Time']) && Number.isFinite(plan['Execution Time'])).toBe(true);
  const details = [];
  const pending = [plan.Plan];
  while (pending.length) {
    const node = pending.pop()!;
    pending.push(...(node.Plans ?? []));
    // PostgreSQL reports actual time and rows per loop. Times here include child nodes.
    const loops = node['Actual Loops'] ?? 0;
    const relation = node['Relation Name'] ?? '';
    const routine = node['Function Name'] ?? '';
    const subplan = node['Subplan Name'] ?? '';
    details.push({
      kind: node['Node Type'],
      ...(relations.has(relation) && { relation }),
      ...(functions.has(routine) && { routine }),
      ...(subplans.has(subplan) && { subplan }),
      loops,
      rows: Math.round((node['Actual Rows'] ?? 0) * loops),
      removedRows: Math.round((node['Rows Removed by Filter'] ?? 0) * loops),
      inclusiveMs: Math.round((node['Actual Total Time'] ?? 0) * loops * 1000) / 1000,
    });
  }
  return {
    planningMs: plan['Planning Time'],
    executionMs: plan['Execution Time'],
    owners: details.filter(node => node.relation || node.routine || node.subplan)
      .sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 15),
    leading: details.sort((a, b) => b.inclusiveMs - a.inclusiveMs).slice(0, 8),
  };
}

it('attributes native execution time while retaining the expected delegated Leave decision', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);

  const [type] = await owner.db.insert(leaveType).values({
    tenantId: base.tenantId, code: 'PERF_TASK_PROFILE', name: 'Fictional task profile leave',
  }).returning({ id: leaveType.id });
  const [pending] = await owner.client`
    with requests as (
      insert into leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days, status)
      select tenant_id, id, ${type.id}::uuid, current_date + 1, current_date + 1, 1, 'pending'
      from employment
      where tenant_id=${base.tenantId}::uuid and employee_code ~ '^FX-[0-9]{4}$' and terminated_on is null
      returning id, tenant_id, employment_id
    ), steps as (
      insert into leave_approval_step (tenant_id, leave_request_id, subject_employment_id, step_index, approver_kind)
      select tenant_id,id,employment_id,0,'hr_admin' from requests
      returning id
    )
    select (select count(*)::int from requests) as requests,(select count(*)::int from steps) as steps
  `;
  expect(pending.requests).toBeGreaterThan(900);
  expect(pending.steps).toBe(pending.requests);
  await owner.client`analyze public.leave_request, public.leave_approval_step`;
  const [employee] = await owner.client`
    select id,person_id,company_id from employment
    where tenant_id=${base.tenantId}::uuid and company_id=${base.companyId}::uuid
      and employee_code ~ '^FX-[0-9]{4}$' and terminated_on is null
    order by employee_code limit 1
  `;
  const employeeContext: SessionContext = {
    ...fixture.personas.group,
    personId: employee.person_id,
    userId: await createAppUser(base.tenantId, employee.person_id, 'employee'),
    roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }],
  };
  const actors = [
    { role: 'group HR', session: fixture.personas.group, companyIds: fixture.companyIds },
    { role: 'company HR', session: fixture.personas.single, companyIds: [fixture.singleCompanyId] },
    { role: 'employee', session: employeeContext, companyIds: [employee.company_id] },
  ];
  const admin = fixture.personas.group;
  const hire = (label: string) => hireEmployee(admin, {
    person: { fullName: label, primaryEmail: label.toLowerCase().replaceAll(' ', '-') + '@fixture.invalid' },
    companyId: base.companyId, departmentId: base.deptA, employmentType: 'full_time', hiredOn: '2020-01-01',
  });
  const manager = await hire('Fictional Leave Scope Manager');
  const delegate = await hire('Fictional Leave Scope Delegate');
  const target = employee.id;
  await setReportingLine(admin, {
    subordinateEmploymentId: target, managerEmploymentId: manager.employmentId,
    lineType: 'administrative', validFrom: '2020-01-01',
  });
  await owner.db.insert(reportingLine).values({
    tenantId: base.tenantId, subordinateEmploymentId: manager.employmentId,
    managerEmploymentId: delegate.employmentId, lineType: 'delegate',
    validFrom: '2020-01-01', scopeCompanyId: base.companyId,
  });
  const [named] = await owner.client`
    update leave_approval_step set approver_kind='specific_employee',
      approver_employment_id=${delegate.employmentId}::uuid
    where tenant_id=${base.tenantId}::uuid and subject_employment_id=${target}::uuid
    returning leave_request_id
  `;
  expect(named?.leave_request_id).toBeTypeOf('string');
  const delegateSession: SessionContext = {
    ...employeeContext, personId: delegate.personId,
    userId: await createAppUser(base.tenantId, delegate.personId, 'employee'),
  };
  const cases = [
    ...actors.map(actor => ({ ...actor, companyIds: [...actor.companyIds] })),
    { role: 'group unscoped', session: admin, companyIds: undefined },
    { role: 'group empty', session: admin, companyIds: [] },
    { role: 'delegate own scope', session: delegateSession, companyIds: [base.companyId] },
    { role: 'delegate excluded scope', session: delegateSession, companyIds: [fixture.singleCompanyId] },
  ];
  expect(fixture.singleCompanyId).not.toBe(base.companyId);
  type ApprovalSection = { leave: { defer: boolean; rows: { id: string }[] } };
  for (const { role, session, companyIds } of cases) {
    const result = await withTenant(session, async tx => {
      await assertAssignedWorkPrincipalTx(tx, session);
      await tx.execute(sql`set local jit=off`);
      const statement = sql`with ${accountTaskCallerSql(session)}
        select ${pendingLeaveDecisionTasksBundleSql(tx, session, companyIds)} as value`;
      const [row] = await tx.execute<{ value: ApprovalSection }>(statement);
      if (role === 'delegate own scope') {
        expect(row.value.leave.rows).toContainEqual(expect.objectContaining({ id: named.leave_request_id }));
      }
      if (role === 'delegate excluded scope' || role === 'group empty') {
        expect(row.value.leave.rows).toEqual([]);
      }
      return { matchedRows: row.value.leave.rows.length, ...await profile(tx, statement) };
    }, { readOnlySnapshot: true });
    console.info('LEAVE_APPROVAL_PLAN_PROFILE ' + JSON.stringify({ role, ...result }));
  }
}, 240_000);
