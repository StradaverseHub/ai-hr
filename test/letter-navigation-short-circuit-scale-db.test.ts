import { and, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { letterNavigation } from '../core/letter-navigation';
import { withTenant, type SessionContext } from '../db/client';
import { LETTER_NAV_ITEMS, visibleLetterDestinations } from '../lib/letter-navigation';
import { company } from '../db/schema';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, resetDb, seedBase } from './harness';

/** The previous query projected every flag for every company before filtering links. */
function previousNavigation(ctx: SessionContext, scopeIds: readonly string[]) {
  if (!scopeIds.length) return Promise.resolve([]);
  const has = (capability: string) => sql<boolean>`app.letter_permission_for_user(app.current_user_id(),${company.id},${capability})`;
  return withTenant(ctx, async tx => {
    const rows = await tx.select({
      read: has('read'), template: has('template'), generate: has('generate'),
      approve: has('approve'), report: has('report'), settings: has('settings'),
    }).from(company).where(and(inArray(company.id, [...scopeIds]), isNull(company.archivedAt), sql`app.principal_snapshot_current()`));
    return visibleLetterDestinations(rows);
  });
}

async function compare(name: string, ctx: SessionContext, scope: readonly string[]) {
  const reads = {
    existing: () => previousNavigation(ctx, scope),
    sharedRead: () => letterNavigation(ctx, scope),
  };
  const expected = await reads.existing();
  expect(await reads.sharedRead()).toEqual(expected);
  const time = { existing: [] as number[], sharedRead: [] as number[] };
  for (let pair = 0; pair < 6; pair++) {
    const order = pair % 2 ? ['sharedRead', 'existing'] as const : ['existing', 'sharedRead'] as const;
    for (const arm of order) {
      const start = performance.now();
      const result = await reads[arm]();
      time[arm].push(performance.now() - start);
      expect(result).toEqual(expected);
    }
  }
  const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
  console.info('Letter navigation permission proof', JSON.stringify({
    actor: name, companies: scope.length, destinations: expected.length,
    existingMedianMs: median(time.existing), sharedReadMedianMs: median(time.sharedRead),
  }));
  return expected;
}

afterAll(closeAll);

it('reuses readable companies without combining Letter grants across scopes', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  const group = await buildScaleFixture(base, { employments: 1025, events: 0 });
  expect(group.activeEmploymentIds.length).toBeGreaterThanOrEqual(1000);
  expect(group.companyIds.length).toBeGreaterThanOrEqual(70);
  const [groupCompany, otherCompany] = group.companyIds;
  const employee = {
    ...group.personas.group,
    userId: await createAppUser(base.tenantId, null, 'employee'),
    personId: undefined,
    roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }],
  } satisfies SessionContext;

  expect(await compare('group HR', group.personas.group, group.companyIds)).toEqual(LETTER_NAV_ITEMS.map(row => row.href));
  await compare('multi-company HR', group.personas.multi, group.companyIds);
  await compare('one company HR', group.personas.single, group.companyIds);
  expect(await compare('employee with no grants', employee, group.companyIds)).toEqual([]);

  await withTenant(group.personas.group, tx => tx.execute(sql`insert into letter_capability_grant(tenant_id,company_id,capability,role,allowed)
    values
      (${base.tenantId}::uuid,${groupCompany}::uuid,'read','employee',true),
      (${base.tenantId}::uuid,${otherCompany}::uuid,'generate','employee',true)`));
  expect(await compare('split grants', employee, [groupCompany, otherCompany])).toEqual([
    '/letters/templates', '/letters/fields', '/letters/register',
  ]);
  expect(await compare('generation only', employee, [otherCompany])).toEqual([]);

  await withTenant(group.personas.group, tx => tx.execute(sql`update letter_capability_grant set allowed=false
    where tenant_id=${base.tenantId}::uuid and company_id=${groupCompany}::uuid
      and capability='read' and role='employee'`));
  expect(await compare('revoked grant', employee, [groupCompany, otherCompany])).toEqual([]);
  expect(await letterNavigation(group.personas.group, [])).toEqual([]);
}, 180_000);
