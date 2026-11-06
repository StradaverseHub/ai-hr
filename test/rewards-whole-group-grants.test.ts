import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { appUser, businessUnit, company, domainEvent, employment } from '../db/schema';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { createApprovedRewardUnit } from './rewards-setup-fixture';
import { pgSqlState } from '../lib/db-error';
import { listRewardUnits } from '../packs/rewards/service';
import { closeAll, createAppUser, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base: Base;
let admin: SessionContext;
let reviewer: SessionContext;
let employmentId: string;

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  await setModule(base.tenantId, 'rewards', 'active');
  admin = await entitledCtx(base);
  const hired = await hireEmployee(admin, {
    companyId: base.companyId,
    departmentId: base.deptA,
    positionId: base.positionId,
    employmentType: 'full_time',
    hiredOn: '2025-01-15',
    person: { fullName: 'Fictional Rewards reviewer', primaryEmail: randomUUID() + '@example.test' },
  });
  employmentId = hired.employmentId;
  const [employee] = await owner.db.select({ personId: employment.personId }).from(employment)
    .where(eq(employment.id, employmentId));
  const userId = await createAppUser(base.tenantId, employee.personId, 'employee');
  reviewer = { ...admin, userId, personId: employee.personId, roles: ['employee'], grants: [{ role: 'employee', companyId: null }] };
});

async function save(actor: SessionContext, userId: string, active: boolean, revision: number) {
  const [row] = await withTenant(actor, tx => tx.execute<{ revision: number }>(sql`
    select app.reward_save_group_role(${userId}::uuid, 'gr', ${active}, ${revision}, 'Verified fictional group role') as revision
  `));
  return row.revision;
}

async function roles() {
  const [row] = await withTenant(reviewer, tx => tx.execute<{ roles: string[] }>(sql`
    select array(select app.reward_current_group_roles()) as roles
  `));
  return row.roles;
}

async function refused(operation: Promise<unknown>, code: string) {
  const error = await operation.then(() => null, (cause: unknown) => cause);
  expect(error).not.toBeNull();
  expect(pgSqlState(error)).toBe(code);
}

it('requires explicit independent grants, refuses stale writes, and audits grant and removal', async () => {
  expect(await roles()).toEqual([]);
  await refused(save(reviewer, admin.userId!, true, 0), '42501');
  await refused(save(admin, admin.userId!, true, 0), '42501');
  expect(await save(admin, reviewer.userId!, true, 0)).toBe(1);
  expect(await roles()).toEqual(['gr']);
  await refused(save(admin, reviewer.userId!, false, 0), '40001');
  expect(await save(admin, reviewer.userId!, false, 1)).toBe(2);
  expect(await roles()).toEqual([]);

  const events = await owner.db.select({ actor: domainEvent.actorId, payload: domainEvent.payload })
    .from(domainEvent).where(and(eq(domainEvent.tenantId, base.tenantId),
      eq(domainEvent.aggregateId, reviewer.userId!), eq(domainEvent.eventType, 'reward-access.whole-group-role.changed')))
    .orderBy(domainEvent.sequence);
  expect(events).toMatchObject([
    { actor: admin.userId, payload: { role: 'gr', before: null, after: true, revision: 1 } },
    { actor: admin.userId, payload: { role: 'gr', before: true, after: false, revision: 2 } },
  ]);
});

it('rechecks People eligibility when an existing holder gives notice', async () => {
  expect(await save(admin, reviewer.userId!, true, 0)).toBe(1);
  expect(await roles()).toEqual(['gr']);
  await owner.withTenant(admin, tx => tx.update(employment)
    .set({ tenderResignationDate: todayInKualaLumpur() }).where(eq(employment.id, employmentId)));
  expect(await roles()).toEqual([]);
});

it('does not accept a user from another tenant', async () => {
  const [foreign] = await owner.db.select({ id: appUser.id }).from(appUser)
    .where(eq(appUser.id, (await seedBase()).adminUserId));
  await refused(save(admin, foreign.id, true, 0), '22023');
});

it('resolves grants on future draft reviews without assigning a review seat', async () => {
  await save(admin, reviewer.userId!, true, 0);
  const day = todayInKualaLumpur(), year = Number(day.slice(0, 4));
  const target = await owner.withTenant(admin, async tx => {
    const [employer] = await tx.insert(company).values({ tenantId: base.tenantId, legalName: 'Future company' }).returning();
    const [unit] = await tx.insert(businessUnit).values({
      tenantId: base.tenantId, companyId: employer.id, code: 'FUTURE', name: 'Future unit',
    }).returning();
    return { companyId: employer.id, businessUnitId: unit.id };
  });
  const unitId = await createApprovedRewardUnit(admin, { ...target, name: 'Future cycle', year, snapshotDate: day });
  async function access() {
    const [row] = await withTenant(reviewer, tx => tx.execute<{ review: boolean; edit: boolean; coverage: string[] }>(sql`
      select app.reward_access(${unitId}::uuid) as review,
        app.reward_group_figures_stage_allowed(${unitId}::uuid) as edit,
        array(select app.reward_group_coverage_roles(${unitId}::uuid)) as coverage
    `));
    return row;
  }
  expect(await access()).toEqual({review:true,edit:false,coverage:['gr']});
  expect(await listRewardUnits(reviewer, [target.companyId])).toEqual([
    expect.objectContaining({ id: unitId, status: 'draft' }),
  ]);
  await save(admin, reviewer.userId!, false, 1);
  expect(await access()).toEqual({review:false,edit:false,coverage:[]});
  expect(await listRewardUnits(reviewer, [target.companyId])).toEqual([]);
});
