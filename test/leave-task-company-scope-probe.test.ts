/** Compare aggregating the exact Leave decisions after evaluating each candidate once. */
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { accountTaskCallerSql } from '../core/account-task-bundle';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { leaveType, reportingLine } from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import { assertAssignedWorkPrincipalTx } from '../core/approvals';
import { pendingLeaveDecisionCandidatesSql, pendingLeaveDecisionTasksBundleSql } from '../packs/leave/service';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase } from './harness';

afterAll(closeAll);

type Explain = { 'Execution Time': number };
const own = sql`cast((select task_caller.own_ids from task_caller) as uuid[])`;
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
async function executionMs(tx: Tx, statement: SQL) {
  const [row] = await tx.execute<{ 'QUERY PLAN': Explain[] }>(
    sql`explain (analyze, timing off, summary, format json) ${statement}`,
  );
  const ms = row['QUERY PLAN'][0]['Execution Time'];
  expect(Number.isFinite(ms)).toBe(true);
  return ms;
}
function once(tx: Tx, session: SessionContext, companyIds?: string[]) {
  const owner = (section: 'leave' | 'cancellations') => sql`jsonb_build_object(
    'defer',coalesce(bool_or(d.decision in ('defer','error')) filter(where d.section=${section}),false),
    'rows',coalesce(jsonb_agg(jsonb_build_object(
      'id',d.id,'employmentId',d.employment_id,'personId',d.person_id,'employee',d.employee,'createdAt',d.created_at
    ) order by d.created_at desc,d.id) filter(where d.section=${section} and d.decision='allow'),'[]'::jsonb)
  )`;
  return sql`with ${accountTaskCallerSql(session)}, decision_once as materialized (
    select decision_candidate.section,decision_candidate.id,decision_candidate.employment_id,
      decision_candidate.person_id,decision_candidate.employee,decision_candidate.created_at,decided.decision
    ${pendingLeaveDecisionCandidatesSql(tx, session, companyIds, own)}
  ) select jsonb_build_object('leave',${owner('leave')},'cancellations',${owner('cancellations')}) as value
  from decision_once d`;
}

it('evaluates each Leave decision once with identical authorized rows and fallback flags', async () => {
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
      const control = sql`with ${accountTaskCallerSql(session)}
        select ${pendingLeaveDecisionTasksBundleSql(tx, session, companyIds, own)} as value`;
      const candidate = once(tx, session, companyIds);
      const [before] = await tx.execute<{ value: ApprovalSection }>(control);
      const [after] = await tx.execute<{ value: ApprovalSection }>(candidate);
      expect(after.value, role).toEqual(before.value);
      if (role === 'delegate own scope') {
        expect(after.value.leave.rows).toContainEqual(expect.objectContaining({ id: named.leave_request_id }));
      }
      if (role === 'delegate excluded scope' || role === 'group empty') {
        expect(after.value.leave.rows).toEqual([]);
      }
      const samples = { control: [] as number[], candidate: [] as number[] };
      for (let run = 0; run < 6; run++) {
        const order = run % 2 === 0 ? ['control', 'candidate'] as const : ['candidate', 'control'] as const;
        for (const arm of order) samples[arm].push(await executionMs(tx, arm === 'control' ? control : candidate));
      }
      return { matchedRows: after.value.leave.rows.length, sampleCount: samples.control.length,
        controlMs: median(samples.control), candidateMs: median(samples.candidate) };
    }, { readOnlySnapshot: true });
    console.info('LEAVE_DECISION_ONCE_PROFILE '+JSON.stringify({ role, ...result }));
  }
}, 240_000);
