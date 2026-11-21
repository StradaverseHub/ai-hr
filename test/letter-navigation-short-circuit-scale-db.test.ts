import { sql, type SQL } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { letterNavigation } from '../core/letter-navigation';
import { withTenant, type SessionContext } from '../db/client';
import { LETTER_NAV_ITEMS } from '../lib/letter-navigation';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, resetDb, seedBase } from './harness';

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

/** Resolve Read once at each visible company, then consider compound destinations only there. */
function sharedReadNavigation(ctx: SessionContext, scopeIds: readonly string[]) {
  if (!scopeIds.length) return Promise.resolve([]);
  const companies = sql.join(scopeIds.map(id => sql`${id}::uuid`), sql`,`);
  return withTenant(ctx, async tx => {
    const [visible] = await tx.execute<Record<string, boolean>>(sql`
      with scoped as materialized (
        select id from public.company where id = any(array[${companies}])
          and archived_at is null and app.principal_snapshot_current()
      ), readable as materialized (
        select id from scoped where ${has('read')}
      )
      select exists(select 1 from readable) or exists(select 1 from scoped where ${has('template')}) as templates,
        exists(select 1 from readable scoped where ${has('generate')}) as generate,
        exists(select 1 from readable scoped where ${has('approve')}) as approval,
        exists(select 1 from readable) as register,
        exists(select 1 from readable scoped where ${has('report')}) as reports,
        exists(select 1 from scoped where ${has('settings')} or ${has('approve')}) as settings
    `);
    const flags: Record<string, boolean> = { ...visible, fields: visible.templates };
    return LETTER_NAV_ITEMS.map(item => item.href).filter(href => flags[href.split('/').at(-1)!]);
  });
}

async function compare(name: string, ctx: SessionContext, scope: readonly string[]) {
  const existing = () => letterNavigation(ctx, scope);
  const shortCircuit = () => shortCircuitNavigation(ctx, scope);
  const sharedRead = () => sharedReadNavigation(ctx, scope);
  const reads = { existing, shortCircuit, sharedRead };
  const expected = await existing();
  expect(await shortCircuit()).toEqual(expected);
  expect(await sharedRead()).toEqual(expected);
  const time = { existing: [] as number[], shortCircuit: [] as number[], sharedRead: [] as number[] };
  for (let pair = 0; pair < 6; pair++) {
    const order = pair % 2
      ? ['sharedRead', 'shortCircuit', 'existing'] as const
      : ['existing', 'shortCircuit', 'sharedRead'] as const;
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
    existingMedianMs: median(time.existing), shortCircuitMedianMs: median(time.shortCircuit),
    sharedReadMedianMs: median(time.sharedRead),
  }));
  return expected;
}

afterAll(closeAll);

it('stops each Letter navigation search at a matching company without crossing scopes', async () => {
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
  expect(await shortCircuitNavigation(group.personas.group, [])).toEqual([]);
}, 180_000);
