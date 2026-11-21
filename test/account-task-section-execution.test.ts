/** Attribute the shared task statement's database work on a fictional group fixture. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, SQL } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { accountTaskCallerSql, accountTaskStatement, accountTaskStatementSections } from '../core/account-task-bundle';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { leaveType } from '../db/schema';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

afterAll(closeAll);

type Explain = { 'Planning Time': number; 'Execution Time': number };
const modules = { attendance: true, claims: false, performance: true, rewards: true, lifecycle: true };
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

it('measures each signed-in shell task section with live identity and company scope', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  for (const code of ['attendance', 'performance', 'rewards', 'lifecycle']) {
    await setModule(base.tenantId, code, 'active');
  }
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
    select person_id,company_id from employment
    where id=${fixture.activeEmploymentIds[0]}::uuid
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
  const results = [];
  for (const { role, session, companyIds } of actors) {
    const result = await withTenant(session, async tx => {
      await tx.execute(sql`set local jit=off`);
      const sections = accountTaskStatementSections(tx, session, modules, {
        companyIds, personal: false, notices: true,
      });
      const statement = accountTaskStatement(sections, session);
      const [row] = await tx.execute<{ principal: boolean }>(statement);
      expect(row.principal, role).toBe(true);
      const full = await profile(tx, statement, 5);
      const breakdown = [];
      for (const [section, expression] of sections) {
        const timing = await profile(tx, sql`with ${accountTaskCallerSql(session)} select ${expression} as section`, 5);
        breakdown.push({ section, ...timing });
      }
      const performance = sections.find(([name]) => name === 'performance')?.[1];
      expect(performance, role).toBeDefined();
      // Profile the actual SQL fragments used by the live projection. Keep the
      // caller CTE for the assessment's own-employment check.
      const names = ['reviews', 'assessment', 'calibration'] as const;
      const expressions = performance!.queryChunks.filter((chunk): chunk is SQL => chunk instanceof SQL);
      expect(expressions).toHaveLength(names.length);
      const caller = accountTaskCallerSql(session);
      const [original] = await tx.execute<{ value: Record<string, unknown> }>(
        sql`with ${caller} select ${performance!} as value`,
      );
      const performanceOwners = [];
      for (const [index, owner] of names.entries()) {
        const ownerStatement = sql`with ${caller} select ${expressions[index]} as value`;
        const [fragment] = await tx.execute<{ value: unknown }>(ownerStatement);
        expect(fragment.value, owner).toEqual(original.value[owner]);
        performanceOwners.push({ owner, ...await profile(tx, ownerStatement, 5) });
      }
      return { full, breakdown: breakdown.sort((a, b) => b.executionMs - a.executionMs), performanceOwners };
    }, { readOnlySnapshot: true });
    results.push({ role, selectedCompanies: companyIds.length, ...result });
    console.info('ACCOUNT_TASK_SECTION_EXECUTION '+JSON.stringify(results.at(-1)));
  }
  if (process.env.AIHR_FOCUSED_EVIDENCE_DIR) {
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR, 'account-task-section-execution.json'),
      JSON.stringify({ releaseEligible: false, companies: fixture.companyIds.length, employments: 1000,
        pendingLeave: pending.requests, results }, null, 2));
  }
}, 240_000);
