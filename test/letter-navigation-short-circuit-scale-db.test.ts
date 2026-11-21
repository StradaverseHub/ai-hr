import { sql, type SQL } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { letterNavigation } from '../core/letter-navigation';
import { withTenant, type SessionContext } from '../db/client';
import { LETTER_NAV_ITEMS } from '../lib/letter-navigation';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

const has = (capability: string) =>
  sql`app.letter_permission_for_user(app.current_user_id(), scoped.id, ${capability})`;

// The existing native predicate owns each answer. Every conjunction is
// satisfied by one visible company, including when a caller holds mixed grants.
function shortCircuitNavigation(ctx: SessionContext, scopeIds: readonly string[]) {
  if (!scopeIds.length) return Promise.resolve([]);
  const companies = sql.join(scopeIds.map(id => sql`${id}::uuid`), sql`,`);
  const probes = LETTER_NAV_ITEMS.map((entry, ordinal) => {
    const requirements: SQL[] = entry.all.map(has);
    if ('any' in entry) requirements.push(sql`(${sql.join(entry.any.map(has), sql` or `)})`);
    return sql`select ${ordinal}::int as ordinal
      where exists (select 1 from scoped where ${sql.join(requirements, sql` and `)})`;
  });
  return withTenant(ctx, async tx => {
    const visible = await tx.execute<{ ordinal: number }>(sql`
      with scoped as materialized (
        select id from public.company where id = any(array[${companies}])
          and archived_at is null and app.principal_snapshot_current()
      )
      ${sql.join(probes, sql` union all `)}
      order by ordinal
    `);
    return visible.map(row => LETTER_NAV_ITEMS[row.ordinal].href);
  });
}

async function compare(name: string, ctx: SessionContext, scope: readonly string[]) {
  const existing = () => letterNavigation(ctx, scope);
  const shortCircuit = () => shortCircuitNavigation(ctx, scope);
  const expected = await existing();
  expect(await shortCircuit()).toEqual(expected);
  const time = { existing: [] as number[], shortCircuit: [] as number[] };
  for (let pair = 0; pair < 6; pair++) {
    const order = pair % 2 ? ['shortCircuit', 'existing'] as const : ['existing', 'shortCircuit'] as const;
    for (const arm of order) {
      const start = performance.now();
      const result = await (arm === 'existing' ? existing() : shortCircuit());
      time[arm].push(performance.now() - start);
      expect(result).toEqual(expected);
    }
  }
  const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
  console.info('Letter navigation permission proof', JSON.stringify({
    actor: name, companies: scope.length, destinations: expected.length,
    existingMedianMs: median(time.existing), shortCircuitMedianMs: median(time.shortCircuit),
  }));
  return expected;
}

afterAll(closeAll);

it('stops each Letter navigation search at a matching company without crossing scopes', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'employees', 'active');
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

  await owner.db.execute(sql`insert into letter_capability_grant(tenant_id,company_id,capability,role,allowed)
    values
      (${base.tenantId}::uuid,${groupCompany}::uuid,'read','employee',true),
      (${base.tenantId}::uuid,${otherCompany}::uuid,'generate','employee',true)`);
  expect(await compare('split grants', employee, [groupCompany, otherCompany])).toEqual([
    '/letters/templates', '/letters/fields', '/letters/register',
  ]);
  expect(await compare('generation only', employee, [otherCompany])).toEqual([]);

  await owner.db.execute(sql`update letter_capability_grant set allowed=false
    where tenant_id=${base.tenantId}::uuid and company_id=${groupCompany}::uuid
      and capability='read' and role='employee'`);
  expect(await compare('revoked grant', employee, [groupCompany, otherCompany])).toEqual([]);
  expect(await shortCircuitNavigation(group.personas.group, [])).toEqual([]);
}, 180_000);
