/** Compare the exact Leave decision query with subject scope applied inside its native owner. */
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

type Explain = { 'Planning Time': number; 'Execution Time': number };
const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function profile(tx: Tx, statement: SQL, samples: number) {
  const plans: Explain[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const [row] = await tx.execute<{ 'QUERY PLAN': Explain[] }>(
      sql`explain (analyze, timing off, summary, format json) ${statement}`,
    );
    const plan = row['QUERY PLAN'][0];
    expect(Number.isFinite(plan['Planning Time']) && Number.isFinite(plan['Execution Time'])).toBe(true);
    plans.push(plan);
  }
  return {
    samples,
    planningMs: median(plans.map(plan => plan['Planning Time'])),
    executionMs: median(plans.map(plan => plan['Execution Time'])),
  };
}

it('scopes Leave subjects before authorization while preserving the live decisions', async () => {
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
  async function measure() {
    const results = [];
    for (const { role, session, companyIds } of cases) {
      results.push(await withTenant(session, async tx => {
        await assertAssignedWorkPrincipalTx(tx, session);
        await tx.execute(sql`select set_config('aihr_fixture.leave_company_ids',
          ${companyIds ? '{' + companyIds.join(',') + '}' : ''},true), set_config('jit','off',true)`);
        const statement = sql`with ${accountTaskCallerSql(session)}
          select ${pendingLeaveDecisionTasksBundleSql(tx, session, companyIds)} as value`;
        const [row] = await tx.execute<{ value: ApprovalSection }>(statement);
        return { role, value: row.value, ...await profile(tx, statement, 5) };
      }, { readOnlySnapshot: true }));
    }
    return results;
  }
  const readDefinition = async () => (await owner.client<{ definition: string; source: string }[]>`
    select pg_get_functiondef(oid) as definition, prosrc as source from pg_proc
    where oid='app.delegated_approval_subjects(uuid[],text,text)'::regprocedure
  `)[0];
  const original = await readDefinition();
  const guard = 'WHERE e.tenant_id=app.current_tenant_id() AND e.id=ANY(subject_ids)';
  expect(original.source.split(guard)).toHaveLength(2);
  // Add only the selected company predicate inside the existing native subject
  // owner. The outer list filter, delegation, RLS and step checks still run.
  const replacement = original.definition.replace(guard, guard + `
    AND (wanted_module <> 'leave' OR wanted_task <> 'leave.application'
      OR nullif(current_setting('aihr_fixture.leave_company_ids',true),'') IS NULL
      OR e.company_id=ANY(nullif(current_setting('aihr_fixture.leave_company_ids',true),'')::uuid[]))`);
  const baseline = await measure();
  try {
    await owner.client.unsafe(replacement);
    expect((await readDefinition()).source).not.toBe(original.source);
    const candidate = await measure();
    expect(candidate.map(row => row.value)).toEqual(baseline.map(row => row.value));
    expect(candidate.find(row => row.role === 'delegate own scope')?.value.leave.rows)
      .toContainEqual(expect.objectContaining({ id: named.leave_request_id }));
    expect(candidate.find(row => row.role === 'delegate excluded scope')?.value.leave.rows).toEqual([]);
    expect(candidate.find(row => row.role === 'group empty')?.value.leave.rows).toEqual([]);
    console.info('LEAVE_APPROVAL_SCOPE_PROFILE ' + JSON.stringify(candidate.map(({ role, executionMs, value }, index) => ({
      role, controlMs: baseline[index].executionMs, candidateMs: executionMs, matchedRows: value.leave.rows.length,
    }))));
  } finally {
    await owner.client.unsafe(original.definition);
    expect((await readDefinition()).definition).toBe(original.definition);
  }
}, 240_000);
