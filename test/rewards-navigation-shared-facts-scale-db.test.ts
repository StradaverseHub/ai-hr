import { sql, type SQL } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { buildScaleFixture } from './helpers/ai-centre-scale-fixture';
import { closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule } from './harness';

const existingConfigurationFlags = sql`
  select app.reward_setup_allowed(null, 'manage') and app.reward_actor_holds_role('gr') as history_upload,
    app.reward_setup_allowed(null, 'manage') as manage,
    app.reward_config_page_allowed(null, 'plans.manage', 'library_view') as plans,
    app.reward_config_editor_anywhere() and app.reward_level_rank(app.reward_actor_page_level('pat.manage')) >= 3 as pat,
    app.reward_config_page_allowed(null, 'salary.view', 'library_view') as salary,
    app.reward_config_page_allowed(null, 'bonus.view', 'library_view') as bonus
`;

// Reuse only facts taken in this statement for the same live principal. The native
// predicates still decide what the actor holds, what they may edit, and each role's ceiling.
const sharedConfigurationFlags = sql`
  with held_roles as materialized (
    select role from unnest(array['gr','ctro','ec','hr_admin']) as actor(role)
    where app.reward_actor_holds_role(role)
  ), authority as materialized (
    select app.reward_setup_allowed(null, 'manage') as manage,
      app.reward_config_editor_anywhere() as editor_anywhere,
      app.reward_config_viewer(null) as library_viewer
  ), page_levels as (
    select
      coalesce(max(app.reward_level_rank(app.reward_role_level(role, 'plans.manage'))), 0) as plans,
      coalesce(max(app.reward_level_rank(app.reward_role_level(role, 'pat.manage'))), 0) as pat,
      coalesce(max(app.reward_level_rank(app.reward_role_level(role, 'salary.view'))), 0) as salary,
      coalesce(max(app.reward_level_rank(app.reward_role_level(role, 'bonus.view'))), 0) as bonus
    from held_roles
  )
  select a.manage and exists(select 1 from held_roles where role='gr') as history_upload,
    a.manage,
    (a.editor_anywhere or exists(select 1 from held_roles where role='ec')) and l.plans >= 1 as plans,
    a.editor_anywhere and l.pat >= 3 as pat,
    a.library_viewer and l.salary >= 1 as salary,
    a.library_viewer and l.bonus >= 1 as bonus
  from authority a cross join page_levels l
`;

type Flags = { history_upload: boolean; manage: boolean; plans: boolean; pat: boolean; salary: boolean; bonus: boolean };

async function compare(ctx: SessionContext, persona: string) {
  return withTenant(ctx, async tx => {
    const read = async (query: SQL) => {
      const [flags] = await tx.execute<Flags>(query);
      expect(flags).toBeDefined();
      return flags;
    };
    const expected = await read(existingConfigurationFlags);
    expect(await read(sharedConfigurationFlags)).toEqual(expected);
    const times = { existing: [] as number[], shared: [] as number[] };
    for (let pair = 0; pair < 8; pair++) {
      const order = pair % 2 ? ['shared', 'existing'] as const : ['existing', 'shared'] as const;
      for (const arm of order) {
        const started = performance.now();
        const flags = await read(arm === 'existing' ? existingConfigurationFlags : sharedConfigurationFlags);
        times[arm].push(performance.now() - started);
        expect(flags).toEqual(expected);
      }
    }
    const median = (values: number[]) => values.sort((left, right) => left - right)[Math.floor(values.length / 2)];
    console.info('Rewards shell configuration facts', JSON.stringify({
      persona, existingMedianMs: median(times.existing), sharedMedianMs: median(times.shared),
      visibleFlags: Object.values(expected).filter(Boolean).length,
    }));
    return expected;
  });
}

afterAll(closeAll);

it('shares live Rewards configuration facts without changing flags at group scale', async () => {
  await migrateTestDb();
  await resetDb();
  const base = await seedBase();
  await setModule(base.tenantId, 'rewards', 'active');
  const fixture = await buildScaleFixture(base, { employments: 1025, events: 0 });
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  expect(fixture.activeEmploymentIds.length).toBeGreaterThanOrEqual(1000);

  const newUser = async () => ({
    ...fixture.personas.group,
    userId: await createAppUser(base.tenantId, null, 'employee'),
    personId: undefined,
    roles: ['employee'],
    grants: [{ role: 'employee', companyId: null }],
  } satisfies SessionContext);
  const [employee, groupRewards, groupCtro] = await Promise.all([newUser(), newUser(), newUser()]);
  await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,role,valid_from,created_by,reason)
    values(${base.tenantId}::uuid,${groupRewards.userId}::uuid,'gr','2000-01-01',${base.adminUserId}::uuid,'Fictional group Rewards fixture')`);
  await owner.db.execute(sql`insert into reward_group_role_grant(tenant_id,user_id,role,active,revision)
    values(${base.tenantId}::uuid,${groupCtro.userId}::uuid,'ctro',true,1)`);

  for (const [persona, ctx] of Object.entries(fixture.personas)) await compare(ctx, persona);
  expect(Object.values(await compare(employee, 'employee'))).toEqual(Array(6).fill(false));
  expect(await compare(groupRewards, 'groupRewards')).toMatchObject({ plans: true, history_upload: true });
  expect(await compare(groupCtro, 'groupCtro')).toMatchObject({ salary: true, bonus: true });
}, 180_000);
