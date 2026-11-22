import { SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, expect, it } from 'vitest';
import { accountTaskCallerSql, accountTaskStatement, accountTaskStatementSections, type AccountTaskRead } from '../core/account-task-bundle';
import { callerOwnEmploymentIdsSql } from '../core/approvals';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { leaveType, person } from '../db/schema';
import { todayInKualaLumpur } from '../lib/hr-date';
import { addHrDays } from '../lib/today/audience';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

afterAll(closeAll);
const dialect = new PgDialect();
const modules = { attendance: true, claims: false, performance: true, rewards: true, lifecycle: false };

function statements(tx: Tx, session: SessionContext, read: AccountTaskRead) {
  const current = accountTaskStatement(accountTaskStatementSections(tx, session, modules, read), session);
  const caller = dialect.sqlToQuery(accountTaskCallerSql(session));
  const matches = current.queryChunks.filter(chunk => chunk instanceof SQL && dialect.sqlToQuery(chunk).sql === caller.sql);
  expect(matches).toHaveLength(1);
  const legacyCaller = sql`task_caller as materialized (select ${callerOwnEmploymentIdsSql(session)} as own_ids)`;
  const legacy = new SQL(current.queryChunks.map(chunk => chunk === matches[0] ? legacyCaller : chunk));
  return { current, legacy, legacyCaller };
}

it('preserves the shared task query across scoped principals and uses the existing person index', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const foreign = await seedBase();
  for (const code of ['attendance', 'performance', 'rewards']) await setModule(base.tenantId, code, 'active');
  const fixture = await buildScaleFixture(base, { employments: 1000, events: 0 });
  expect(fixture.companyIds).toHaveLength(71);
  expect(fixture.employmentIds).toHaveLength(1000);

  const [type] = await owner.db.insert(leaveType).values({
    tenantId: base.tenantId, code: 'TASK_UUID', name: 'Fictional task lookup leave',
  }).returning({ id: leaveType.id });
  const tomorrow = addHrDays(todayInKualaLumpur(), 1);
  const [pending] = await owner.client`
    with requests as (
      insert into leave_request (tenant_id, employment_id, leave_type_id, start_date, end_date, days, status)
      select tenant_id, id, ${type.id}::uuid, ${tomorrow}::date, ${tomorrow}::date, 1, 'pending'
      from employment
      where tenant_id=${base.tenantId}::uuid and employee_code ~ '^FX-[0-9]{4}$' and terminated_on is null
      returning id, tenant_id, employment_id
    ), steps as (
      insert into leave_approval_step (tenant_id, leave_request_id, subject_employment_id, step_index, approver_kind)
      select tenant_id, id, employment_id, 0, 'hr_admin' from requests returning id
    )
    select (select count(*)::int from requests) as requests,(select count(*)::int from steps) as steps
  `;
  expect(pending.requests).toBeGreaterThan(900);
  expect(pending.steps).toBe(pending.requests);

  const [employee] = await owner.client`select person_id, company_id from employment where id=${fixture.activeEmploymentIds[0]}::uuid`;
  const makeActor = async (role: 'employee' | 'manager'): Promise<SessionContext> => ({
    ...fixture.personas.group,
    personId: employee.person_id,
    userId: await createAppUser(base.tenantId, employee.person_id, role),
    roles: [role],
    grants: [{ role, companyId: null }],
  });
  const self = await makeActor('employee');
  const manager = await makeActor('manager');
  const [other] = await owner.db.insert(person).values({
    tenantId: foreign.tenantId, fullName: 'Fictional other tenant', primaryEmail: 'other-tenant@fixture.test',
  }).returning({ id: person.id });
  const cases = [
    { session: fixture.personas.group, companyIds: undefined, personal: true, principal: true },
    { session: fixture.personas.multi, companyIds: fixture.companyIds, personal: false, principal: true },
    { session: fixture.personas.single, companyIds: [fixture.singleCompanyId], personal: false, principal: true },
    { session: fixture.personas.single, companyIds: [], personal: false, principal: true },
    { session: manager, companyIds: [employee.company_id], personal: true, principal: true },
    { session: self, companyIds: [employee.company_id], personal: true, principal: true },
    { session: { ...self, personId: employee.person_id.toUpperCase() }, companyIds: undefined, personal: true },
    { session: { ...self, personId: null }, companyIds: undefined, personal: true },
    { session: { ...self, personId: other.id }, companyIds: [foreign.companyId], personal: true, principal: false },
  ];
  for (const { session, companyIds, personal, principal } of cases) {
    await withTenant(session, async tx => {
      await tx.execute(sql`set local jit=off`);
      const { current, legacy } = statements(tx, session, { companyIds, personal, notices: true });
      const actual = Array.from(await tx.execute(current));
      expect(actual).toEqual(Array.from(await tx.execute(legacy)));
      expect(actual).toHaveLength(1);
      if (principal !== undefined) expect(actual[0]?.principal).toBe(principal);
    }, { readOnlySnapshot: true });
  }

  await withTenant(self, async tx => {
    const { legacyCaller } = statements(tx, self, { personal: true, notices: true });
    const typedPlan = await tx.execute(sql`explain (format json) with ${accountTaskCallerSql(self)} select own_ids from task_caller`);
    const legacyPlan = await tx.execute(sql`explain (format json) with ${legacyCaller} select own_ids from task_caller`);
    expect(JSON.stringify(typedPlan)).toContain('employment_person_idx');
    expect(JSON.stringify(legacyPlan)).not.toContain('employment_person_idx');
  }, { readOnlySnapshot: true });
}, 240_000);
