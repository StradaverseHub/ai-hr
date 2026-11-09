/** One fictional upgrade on the controlled hosted job cluster. No provider entrypoint. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { expect, it } from 'vitest';
import { validateMigrationLedgerRows } from '../.github/ci/staging-migration-ledger.mjs';
import { resolveEntitlementsTx } from '../core/entitlements';
import { assertModuleGate } from '../core/module-gate';
import { createDb, type SessionContext } from '../db/client';
import { seedCatalogs } from '../scripts/seed-catalogs';
import { readCurrentAiCentreUpgradeSource } from './fixtures/ai-centre-current-upgrade-source';
import { constructAiCentreCompatibilityOwner } from './helpers/ai-centre-compatibility-owner-constructor';
import { admitSingletonTest } from './helpers/ci-singleton-admission';
import { assertDraftDiscardRoleCatalog, readDraftDiscardRoleCatalog } from './helpers/personnel-draft-discard-ci-role-fixture';

const admission = admitSingletonTest('test/ai-centre-current-prefix-upgrade.test.ts');
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const roleNames = [
  'ai_hr_app', 'ai_hr_architecture_grade_guard', 'ai_hr_company_org_source_reader',
  'ai_hr_draft_discard_port', 'ai_hr_job_profile_reader', 'ai_hr_owner', 'ai_hr_reward_preparation_invalidator',
  'ai_hr_reward_preparation_reader', 'ai_hr_reward_setup_reader', 'ai_hr_reward_upload_reader',
  'ai_hr_reward_view_reader', 'ai_hr_rewards_post_reader',
];
const signatures = [
  'app._ai_control_context(text,boolean)', 'app._ai_control_context_before_centre(text,boolean)',
  'app._ai_control_context_for_purpose(text,boolean,boolean)', 'app.ai_action_unpaused(text,boolean)',
  'app.ai_agent_action_unpaused(text)', 'app.ai_agent_action_unpaused_before_centre(text)',
  'app.ai_centre_assert_running(integer)', 'app.ai_centre_control_lock()', 'app.ai_centre_control_state()',
  'app.ai_centre_read_allowed(text)', 'app.ai_centre_read_controls()', 'app.teras_bump_version()',
  'app.ai_centre_mandate_write_order()', 'app.ai_centre_mandate_bound_tenant()',
];
type Identity = { database: string; dbOid: string; role: string; login: string; loopback: boolean; pid: number; started: string };
type Procedure = { signature: string; oid: string; owner: string; attributes: Record<string, unknown>; body: string; definition: string; defaultExpression: string | null; appExecute: boolean };
type LedgerRow = { id: string; hash: string; created_at: string };
type RoleIdentity = { oid: string; rolname: string };
type RoleEdge = { roleid: string; member: string; grantor: string; admin_option: boolean; inherit_option: boolean; set_option: boolean };
type HolderIdentity = { pid: number; started: string };

async function identity(client: Sql): Promise<Identity> {
  const [row] = await client<Identity[]>`
    select current_database() as database,d.oid::text as "dbOid",current_user as role,session_user as login,
      inet_server_addr()='127.0.0.1'::inet and inet_server_port()=5433 as loopback,
      a.pid,a.backend_start::text as started
    from pg_catalog.pg_stat_activity a join pg_catalog.pg_database d on d.oid=a.datid
    where a.pid=pg_backend_pid()
  `;
  expect(row?.loopback).toBe(true);
  return row;
}

async function setLimits(client: Sql) {
  await client`set statement_timeout='10s'`;
  await client`set lock_timeout='5s'`;
}

it('replays the populated current AI Centre checkpoint under the real fixture owner with native rollback, Stop and tenant isolation', async ({ signal }) => {
  const started = performance.now();
  const workUntil = started + 260_000;
  const cleanupUntil = started + 298_000;
  let workForced = false;
  const guard = () => {
    signal.throwIfAborted();
    expect(workForced, 'Current fixture custody unknown after forced stop').toBe(false);
    expect(performance.now(), 'Current fixture work frontier').toBeLessThan(workUntil);
  };
  const source = readCurrentAiCentreUpgradeSource(process.cwd());
  guard();

  const token = randomUUID().replaceAll('-', '');
  const database = 'ai_hr_ai_compat_' + token;
  const role = 'aihr_ai_compat_' + token;
  const adminUrl = new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
  const appUrl = new URL(process.env.TEST_DATABASE_URL!);
  expect([adminUrl.hostname, appUrl.hostname, adminUrl.port, appUrl.port]).toEqual(['127.0.0.1', '127.0.0.1', '5433', '5433']);
  expect([adminUrl.username, appUrl.username, adminUrl.password, appUrl.password]).toEqual(['postgres', 'ai_hr_app', '', '']);
  expect([adminUrl.search, appUrl.search, adminUrl.hash, appUrl.hash]).toEqual(['', '', '', '']);
  adminUrl.pathname = '/postgres';
  const storageUrl = new URL(adminUrl);
  storageUrl.pathname = '/' + database;
  appUrl.pathname = storageUrl.pathname;
  const ownerUrl = new URL(storageUrl);
  ownerUrl.username = role;

  let directory: string | undefined;
  const admin = postgres(adminUrl.toString(), { max: 1, connect_timeout: 5, onnotice: () => {} });
  const storage = createDb(storageUrl.toString(), { max: 1 });
  const migration = createDb(ownerUrl.toString(), { max: 1 });
  const application = createDb(appUrl.toString(), { max: 1 });
  let roleOid: string | undefined, dbOid: string | undefined;
  let courseFailed = false;
  let forcedStop: Promise<PromiseSettledResult<void>[]> | undefined;
  let releaseForeignHolder: (() => void) | undefined;
  const privateClients = [application.client, migration.client, storage.client];
  const closeClients = (clients: Sql[], seconds: number) =>
    Promise.allSettled(clients.map(client => client.end({ timeout: seconds })));
  const stopWork = () => {
    workForced = true;
    releaseForeignHolder?.();
    forcedStop ??= closeClients([...privateClients, admin], 0);
  };
  const workTimer = setTimeout(stopWork, Math.max(0, workUntil - performance.now()));
  const hardTimer = setTimeout(stopWork, Math.max(0, cleanupUntil - performance.now()));
  signal.addEventListener('abort', stopWork, { once: true });
  const report = {
    kind: 'NATIVE_AI_CENTRE_CURRENT_FICTIONAL_AI_CONTROLS_CHECKPOINT_ONLY',
    releaseAuthorized: false, stagingOwnerEquivalence: false,
    rewardsPreparationEquivalence: false, syntheticRewardCreatorGrantGapObserved: false,
    shutdown: 'unobserved' as 'unobserved' | 'unknown' | 'physically-settled',
    bounds: { caseMs: 300_000, workMs: 260_000, evidenceWriteAdmissionMs: 298_000, holderReadyMs: 2_500, holderCourseMs: 15_000 },
    checkpoint: source.checkpointTag, baselineRows: source.boundary, checkpointRows: source.expected.length,
    phase: 'admit', complete: false, cleanupComplete: false,
    rollbackProofs: [] as string[], ledgerDigests: [] as string[], foreignDenialWhileHeld: false, foreignHolderSettled: false,
  };
  const save = (bytes = JSON.stringify(report)) =>
    writeFileSync(join(admission.evidenceDirectory, 'ai-centre-current-prefix-upgrade.json'), bytes, { mode: 0o600 });
  const fixtureActor = (tenantId: string, actorRole: 'hr_admin' | 'employee') => ({
    tenantId, userId: randomUUID(), personId: randomUUID(), roles: [actorRole],
    grants: [{ role: actorRole, companyId: null }],
  } satisfies SessionContext);
  const own = fixtureActor(randomUUID(), 'hr_admin');
  const foreign = fixtureActor(randomUUID(), 'hr_admin');
  const employee = fixtureActor(own.tenantId, 'employee');

  const roleGraph = async () => {
    const roles = await admin<RoleIdentity[]>`
      select oid::text,rolname,rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreaterole,rolcreatedb,rolreplication,
        rolconnlimit,rolpassword is null as no_password,rolvaliduntil is null as no_expiry
      from pg_catalog.pg_authid where rolname<>${role} order by oid limit 257
    `;
    const edges = await admin<RoleEdge[]>`
      select roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option
      from pg_catalog.pg_auth_members where member is distinct from (select oid from pg_catalog.pg_roles where rolname=${role})
      order by roleid,member,grantor limit 257
    `;
    expect(roles.length).toBeLessThan(257);
    expect(edges.length).toBeLessThan(257);
    return { roles: Array.from(roles), edges: Array.from(edges) };
  };
  let admittedGlobal: Awaited<ReturnType<typeof roleGraph>> | undefined;
  const ledger = async () => Array.from(await storage.client<LedgerRow[]>`
    select m.id::text as id,m.hash,m.created_at::text as created_at from drizzle.__drizzle_migrations as m order by m.id
  `);
  const procedures = async () => Array.from(await storage.client<Procedure[]>`
    select p.oid::regprocedure::text as signature,p.oid::text,p.proowner::regrole::text as owner,
      to_jsonb(p)-'prosrc'-'proconfig' as attributes,p.prosrc as body,pg_get_functiondef(p.oid) as definition,
      pg_get_expr(p.proargdefaults,0) as "defaultExpression",
      has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as "appExecute"
    from pg_catalog.pg_proc p where p.oid in (select to_regprocedure(s) from unnest(${signatures}::text[]) as v(s))
    order by p.oid::regprocedure::text
  `);
  const mandateCatalogue = async () => ({
    table: Array.from(await storage.client`
      select c.oid::text,c.relowner::regrole::text as owner,c.relacl::text,c.relrowsecurity as rls,c.relforcerowsecurity as force
      from pg_catalog.pg_class c where c.oid='public.teras_mandate_control'::regclass
    `),
    policies: Array.from(await storage.client`
      select oid::text,polname,to_jsonb(p) as row from pg_catalog.pg_policy p where polrelid='public.teras_mandate_control'::regclass order by oid
    `),
    triggers: Array.from(await storage.client`
      select oid::text,tgname,tgtype,tgenabled,tgfoid::regprocedure::text as signature
      from pg_catalog.pg_trigger where tgrelid='public.teras_mandate_control'::regclass and not tgisinternal order by tgname
    `),
  });
  const controls = async () => Array.from(await storage.client`
    select tenant_id,stopped,version,changed_by_user_id from public.teras_mandate_control order by tenant_id
  `);
  const facts = async () => ({
    controls: await controls(),
    runs: Array.from(await storage.client`select tenant_id,user_id,state,reserved_tokens from public.ai_model_run order by tenant_id,reserved_tokens`),
    modules: Array.from(await storage.client`select tenant_id,module_code,status from public.tenant_module order by tenant_id,module_code`),
  });
  const entitlement = (actor: SessionContext) => application.withTenant(actor, async tx => {
    const entitlements = await resolveEntitlementsTx(tx, actor.tenantId);
    assertModuleGate({ ...actor, entitlements }, 'assistant');
  });
  const state = (actor: SessionContext) => application.withTenant(actor, tx =>
    tx.execute(sql`select * from app.ai_centre_control_state()`));
  const actions = (actor: SessionContext) => application.withTenant(actor, tx =>
    tx.execute(sql`select app.ai_action_unpaused('hr_assistant',false) as feature,app.ai_agent_action_unpaused('claims.cancel') as action`));

  try {
    guard();
    await setLimits(admin);
    const adminSession = await identity(admin);
    expect(adminSession).toMatchObject({ database: 'postgres', role: 'postgres', login: 'postgres' });
    const discardRoleCatalogue = await readDraftDiscardRoleCatalog(admin);
    assertDraftDiscardRoleCatalog(discardRoleCatalogue);
    const globalBefore = await roleGraph();
    admittedGlobal = globalBefore;
    // The only supported incident global edges are the two known draft-discard edges.
    const relevantOids = new Set(globalBefore.roles.filter(row => roleNames.includes(row.rolname)).map(row => row.oid));
    const expectedEdges = discardRoleCatalogue.edges.map(edge => {
      const oid = (name: string) => {
        const row = globalBefore.roles.find(candidate => candidate.rolname === name);
        if (!row) throw new Error('Known fixture role is absent');
        return row.oid;
      };
      return {
        roleid: oid(edge.role), member: oid(edge.member), grantor: oid(edge.grantor),
        inherit_option: edge.inherit, set_option: edge.set, admin_option: edge.admin,
      };
    });
    const edgeKey = (row: typeof expectedEdges[number]) => row.roleid + '/' + row.member + '/' + row.grantor;
    expect(globalBefore.edges.filter(row => [row.roleid, row.member, row.grantor].some(id => relevantOids.has(id)))
      .sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))))
      .toEqual(expectedEdges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))));
    expect(globalBefore.roles.filter(row => roleNames.includes(row.rolname)).map(row => row.rolname).sort()).toEqual(roleNames);
    for (const row of globalBefore.roles.filter(row => roleNames.includes(row.rolname))) {
      expect(row).toMatchObject({
        rolcanlogin: ['ai_hr_app', 'ai_hr_owner'].includes(row.rolname),
        rolinherit: ['ai_hr_app', 'ai_hr_draft_discard_port', 'ai_hr_owner'].includes(row.rolname),
        rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
        no_password: true, no_expiry: true,
      });
    }

    guard();
    await admin.unsafe(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
    [{ oid: roleOid }] = await admin<{ oid: string }[]>`select oid::text from pg_catalog.pg_roles where rolname=${role}`;
    guard();
    await admin.unsafe(`CREATE DATABASE "${database}" WITH OWNER "${role}" TEMPLATE template0`);
    [{ oid: dbOid }] = await admin<{ oid: string }[]>`
      select oid::text from pg_catalog.pg_database where datname=${database} and datdba=${roleOid}::oid
    `;
    await setLimits(storage.client);
    expect(await identity(storage.client)).toMatchObject({ database, dbOid, role: 'postgres', login: 'postgres' });
    expect(await storage.client`select oid from pg_catalog.pg_event_trigger`).toHaveLength(0);

    directory = mkdtempSync(join(tmpdir(), 'aihr-current-ai-upgrade-'));
    mkdirSync(join(directory, 'meta'));
    for (const file of source.migrations) writeFileSync(join(directory, file.name), file.bytes, { flag: 'wx', mode: 0o600 });
    const journal = join(directory, 'meta', '_journal.json');
    writeFileSync(journal, source.baselineJournal, { flag: 'wx', mode: 0o600 });
    report.phase = 'bootstrap-fixture'; save();
    guard();
    await migrate(storage.db, { migrationsFolder: directory });
    guard();
    expect(await roleGraph()).toEqual(globalBefore);
    const before = await ledger();
    validateMigrationLedgerRows(source.expected.slice(0, source.boundary), before);
    report.ledgerDigests.push(sha(before));

    // This transfer verifies its own complete native remap and known member edges.
    // It cannot establish that the synthetic baseline has any installed owner equivalence.
    await constructAiCentreCompatibilityOwner(storage.client, database, role);
    guard();
    await setLimits(migration.client);
    const m = await identity(migration.client);
    expect(m).toMatchObject({ database, dbOid, role, login: role });
    expect(await admin`select datid::text as "dbOid",usename from pg_catalog.pg_stat_activity where pid=${m.pid} and backend_start::text=${m.started}`)
      .toEqual([{ dbOid, usename: role }]);
    expect(await admin`
      select oid::text,rolsuper,rolbypassrls,rolcanlogin,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolconnlimit
      from pg_catalog.pg_roles where rolname=${role}
    `).toEqual([{ oid: roleOid, rolsuper: false, rolbypassrls: false, rolcanlogin: true, rolinherit: true,
      rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolconnlimit: -1 }]);
    expect(await roleGraph()).toEqual(globalBefore);
    const [ownerAuthority] = await migration.client`
      select has_schema_privilege(current_user,'app','USAGE') as app_usage,
        has_schema_privilege(current_user,'app','CREATE') as app_create,
        has_schema_privilege(current_user,'public','CREATE') as public_create,
        has_schema_privilege(current_user,'drizzle','CREATE') as ledger_schema_create,
        has_database_privilege(current_user,current_database(),'TEMP') as temp,
        (select relowner=current_user::regrole from pg_catalog.pg_class where oid='drizzle.__drizzle_migrations'::regclass) as ledger_owner,
        (select relowner=current_user::regrole from pg_catalog.pg_class where oid='public.teras_mandate_control'::regclass) as control_owner,
        (select proowner=current_user::regrole from pg_catalog.pg_proc where oid='app.ai_centre_assert_running(integer)'::regprocedure) as guard_owner,
        not pg_has_role(current_user,'ai_hr_app','USAGE') and pg_has_role(current_user,'ai_hr_app','SET') as app_edge,
        not pg_has_role(current_user,'ai_hr_draft_discard_port','USAGE') and pg_has_role(current_user,'ai_hr_draft_discard_port','SET') as discard_edge
    `;
    expect(ownerAuthority).toEqual({
      app_usage: true, app_create: true, public_create: true, ledger_schema_create: true, temp: true,
      ledger_owner: true, control_owner: true, guard_owner: true, app_edge: true, discard_edge: true,
    });

    // 3701 grants this helper to the role that creates the Rewards wrapper.
    // The historical real-M course correctly has a different dedicated ACL.
    // Observe the synthetic gap rather than granting execution or crediting the
    // Rewards path. The AI controls and entitlement checks never call it.
    const [rewardBoundary] = await storage.client`
      select p.proowner::regrole::text as owner,
        encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as body,
        (select proowner::regrole::text from pg_catalog.pg_proc where oid='app.reward_roles(uuid)'::regprocedure) as caller_owner,
        has_function_privilege(${role},p.oid,'EXECUTE') as fixture_execute,
        has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
        (select jsonb_agg(jsonb_build_array(a.grantee::regrole::text,a.grantor::regrole::text,a.privilege_type,a.is_grantable)
           order by a.grantee::regrole::text collate "C") from aclexplode(p.proacl) a) as acl
      from pg_catalog.pg_proc p where p.oid='app.reward_preparation_released(uuid)'::regprocedure
    `;
    const preparationReader = 'ai_hr_reward_preparation_reader';
    expect(rewardBoundary).toEqual({
      owner: preparationReader, body: 'b373c6574febec928c07a7e8f05b91be19157d1d15e4b126b6791187b6a90458',
      caller_owner: role, fixture_execute: false, app_execute: false,
      acl: [[preparationReader, preparationReader, 'EXECUTE', false], ['postgres', preparationReader, 'EXECUTE', false]],
    });
    report.syntheticRewardCreatorGrantGapObserved = true;

    guard();
    await migration.client`alter default privileges in schema public grant select,insert,update,delete on tables to ai_hr_app`;
    await migration.client`alter default privileges in schema public grant select,usage on sequences to ai_hr_app`;
    expect(await storage.client`
      select d.defaclobjtype::text as kind,n.nspname as namespace,a.grantee::regrole::text as grantee,
        a.grantor::regrole::text as grantor,array_agg(a.privilege_type order by a.privilege_type) as privileges,
        bool_or(a.is_grantable) as grantable
      from pg_catalog.pg_default_acl d join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) a
      group by 1,2,3,4 order by d.defaclobjtype::text collate "C"
    `).toEqual([
      { kind: 'S', namespace: 'public', grantee: 'ai_hr_app', grantor: role, privileges: ['SELECT', 'USAGE'], grantable: false },
      { kind: 'r', namespace: 'public', grantee: 'ai_hr_app', grantor: role, privileges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'], grantable: false },
    ]);

    guard();
    await seedCatalogs(storage.db);
    for (const actor of [own, foreign]) {
      await storage.client`insert into public.tenant(id,workos_org_id,name,status) values(${actor.tenantId},${randomUUID()},'Fictional AI checkpoint','active')`;
      await storage.client`insert into public.company(tenant_id,legal_name) values(${actor.tenantId},'Fictional AI employer')`;
    }
    for (const actor of [own, foreign, employee]) {
      await storage.client`insert into public.person(id,tenant_id,full_name,primary_email)
        values(${actor.personId},${actor.tenantId},'Fictional AI actor',${actor.userId+'@example.invalid'})`;
      await storage.client`insert into public.app_user(id,tenant_id,person_id,workos_user_id)
        values(${actor.userId},${actor.tenantId},${actor.personId},${randomUUID()})`;
      await storage.client`insert into public.role_assignment(tenant_id,app_user_id,role)
        values(${actor.tenantId},${actor.userId},${actor.roles[0]})`;
    }
    await storage.client`insert into public.tenant_module(tenant_id,module_code,status) values(${own.tenantId},'assistant','active')`;
    for (const [actor, generation, pending] of [[own, 7, 1], [foreign, 11, 2]] as const) {
      await storage.client`insert into public.teras_mandate_control(tenant_id,stopped,version,changed_by_user_id)
        values(${actor.tenantId},true,${generation},${actor.userId})`;
      for (let n = 1; n <= pending; n++) await storage.client`
        insert into public.ai_model_run(tenant_id,user_id,feature_id,operation,provider,model,state,reserved_tokens)
        values(${actor.tenantId},${actor.userId},'hr_assistant','conversation','fixture','never-sent','pending',${n})
      `;
    }

    await setLimits(application.client);
    expect(await identity(application.client)).toMatchObject({ database, dbOid, role: 'ai_hr_app', login: 'ai_hr_app' });
    await entitlement(own);
    await expect(entitlement(foreign)).rejects.toMatchObject({ name: 'ModuleNotEnabledError', moduleCode: 'assistant' });
    expect(Array.from(await state(own))).toEqual([{ stopped: true, generation: 7, pending: 1 }]);
    expect(Array.from(await state(foreign))).toEqual([{ stopped: true, generation: 11, pending: 2 }]);

    const beforeFacts = await facts();
    const beforeCatalogue = await mandateCatalogue();
    const beforeProcs = await procedures();
    expect(beforeCatalogue.table).toEqual([expect.objectContaining({ owner: role, rls: true, force: false })]);
    expect(beforeCatalogue.triggers.map(row => row.tgname)).toEqual(['aaa_ai_centre_control_lock', 'teras_mandate_control_version']);
    expect(beforeCatalogue.policies.map(row => row.polname).sort()).toEqual([
      'teras_control_admin_insert', 'teras_control_admin_update', 'teras_control_read',
    ]);
    const nativeGrants = await storage.client`
      select a.grantor::regrole::text as grantor,a.grantee::regrole::text as grantee,
        a.privilege_type as privilege,a.is_grantable as grantable
      from pg_catalog.pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid='public.teras_mandate_control'::regclass
      order by (a.grantee::regrole::text='ai_hr_app') desc,a.privilege_type collate "C"
    `;
    expect(Array.from(nativeGrants)).toEqual([
      ...['INSERT', 'SELECT', 'UPDATE'].map(privilege => ({ grantor: role, grantee: 'ai_hr_app', privilege, grantable: false })),
      ...['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE']
        .map(privilege => ({ grantor: role, grantee: role, privilege, grantable: false })),
    ]);
    expect(beforeProcs).toHaveLength(11);
    expect(beforeProcs.every(row => row.owner === role)).toBe(true);
    expect(await storage.client`select to_regclass('public.notification_event_processing') is null as absent`).toEqual([{ absent: true }]);

    writeFileSync(journal, source.checkpointJournal, { mode: 0o600 });
    for (const [procedure, exactMessage] of [
      ['app._ai_control_context_before_centre(text,boolean)', 'Unexpected AI Centre compatibility predecessor: app._ai_control_context_before_centre(text,boolean)'],
      ['app.teras_bump_version()', 'Unexpected AI Centre mandate predecessor: app.teras_bump_version()'],
    ] as const) {
      guard();
      const original = beforeProcs.find(row => row.signature === procedure);
      expect(original).toBeDefined();
      const originalDefinition = original!.definition;
      expect(originalDefinition.split('AS $function$')).toHaveLength(2);
      await migration.client.unsafe(originalDefinition.replace('AS $function$', 'AS $function$\n-- current fictional predecessor drift'));
      const drifted = await procedures();
      expect(drifted).not.toEqual(beforeProcs);
      report.phase = 'rollback'; save();
      guard();
      await expect(migrate(migration.db, { migrationsFolder: directory })).rejects.toMatchObject({
        cause: { code: '55000', message: exactMessage },
      });
      guard();
      expect(await ledger()).toEqual(before);
      expect(await procedures()).toEqual(drifted);
      expect(await mandateCatalogue()).toEqual(beforeCatalogue);
      expect(await facts()).toEqual(beforeFacts);
      await entitlement(own);
      await expect(entitlement(foreign)).rejects.toMatchObject({ name: 'ModuleNotEnabledError', moduleCode: 'assistant' });
      expect(await storage.client`select to_regclass('public.notification_event_processing') is null as absent`).toEqual([{ absent: true }]);
      await migration.client.unsafe(originalDefinition);
      expect(await procedures()).toEqual(beforeProcs);
      report.rollbackProofs.push(procedure);
    }

    report.phase = 'positive-checkpoint'; save();
    guard();
    await migrate(migration.db, { migrationsFolder: directory });
    guard();
    const after = await ledger();
    validateMigrationLedgerRows(source.expected, after);
    expect(after.slice(0, source.boundary)).toEqual(before);
    expect(await facts()).toEqual(beforeFacts);
    report.ledgerDigests.push(sha(after));
    const afterCatalogue = await mandateCatalogue();
    expect(afterCatalogue.table).toEqual(beforeCatalogue.table);
    expect(afterCatalogue.policies).toEqual(beforeCatalogue.policies);
    expect(afterCatalogue.triggers.map(row => [row.tgname, row.tgtype, row.tgenabled, row.signature])).toEqual([
      ['aa_ai_centre_mandate_write_order', 22, 'O', 'app.ai_centre_mandate_write_order()'],
      ['aaa_ai_centre_bound_tenant', 23, 'O', 'app.ai_centre_mandate_bound_tenant()'],
      ['aaa_ai_centre_control_lock', 23, 'O', 'app.ai_centre_control_lock()'],
      ['teras_mandate_control_version', 19, 'O', 'app.teras_bump_version()'],
    ]);
    const afterProcs = await procedures();
    expect(afterProcs).toHaveLength(14);
    // 2138 replaces this declaration with the same default at a different SQL offset.
    const action = 'app.ai_action_unpaused(text,boolean)';
    expect([beforeProcs, afterProcs].map(rows => rows.find(row => row.signature === action)?.defaultExpression))
      .toEqual(['false', 'false']);
    const stable = ({ signature, oid, owner, appExecute, attributes, defaultExpression }: Procedure) => ({
      signature, oid, owner, appExecute,
      attributes: signature === action ? { ...attributes, proargdefaults: defaultExpression } : attributes,
    });
    expect(afterProcs.filter(row => beforeProcs.some(previous => previous.signature === row.signature)).map(stable))
      .toEqual(beforeProcs.map(stable));
    for (const signature of ['app.ai_centre_mandate_write_order()', 'app.ai_centre_mandate_bound_tenant()']) {
      expect(afterProcs.find(row => row.signature === signature)).toMatchObject({
        owner: role, appExecute: false, attributes: { prosecdef: false },
      });
    }

    report.phase = 'native-behavior'; save();
    await entitlement(own);
    await expect(entitlement(foreign)).rejects.toMatchObject({ name: 'ModuleNotEnabledError', moduleCode: 'assistant' });
    expect(Array.from(await state(own))).toEqual([{ stopped: true, generation: 7, pending: 1 }]);
    expect(Array.from(await state(foreign))).toEqual([{ stopped: true, generation: 11, pending: 2 }]);
    await expect(state(employee)).rejects.toMatchObject({ cause: { code: '42501', message: 'AI controls unavailable' } });
    const crossTenant = { ...own, tenantId: foreign.tenantId };
    await expect(state(crossTenant)).rejects.toMatchObject({ cause: { code: '42501', message: 'AI controls unavailable' } });
    expect(Array.from(await actions(own))).toEqual([{ feature: false, action: false }]);
    const rollbackAdmission = new Error('Roll back fictional paused-admission observation');
    await expect(application.withTenant(own, async tx => {
      const [result] = await tx.execute(sql`
        select allowed,blocked_reason from app.ai_admit('hr_assistant','conversation','fixture','never-sent',1)
      `);
      expect(result).toEqual({ allowed: false, blocked_reason: 'paused' });
      throw rollbackAdmission;
    })).rejects.toBe(rollbackAdmission);
    expect(await facts()).toEqual(beforeFacts);
    await expect(migration.client`update public.teras_mandate_control set stopped=false where tenant_id=${own.tenantId}`)
      .rejects.toMatchObject({ code: '42501', message: 'Mandate control requires a bound tenant' });
    await migration.client.begin(async tx => {
      await tx`select set_config('app.tenant_id',${own.tenantId},true)`;
      await tx`update public.teras_mandate_control set stopped=false,version=999 where tenant_id=${own.tenantId}`;
    });
    expect(Array.from(await state(own))).toEqual([{ stopped: false, generation: 8, pending: 1 }]);
    expect(Array.from(await actions(own))).toEqual([{ feature: true, action: true }]);
    expect(Array.from(await application.withTenant(own, tx => tx.execute(sql`
      select app.ai_centre_assert_running(7) as stale,app.ai_centre_assert_running(8) as current,
        app.ai_action_unpaused('hr_assistant',true) as forced
    `)))).toEqual([{ stale: null, current: 8, forced: false }]);
    const resumed = await controls();
    await expect(application.withTenant(employee, tx => tx.execute(sql`
      insert into public.teras_mandate_control(tenant_id,changed_by_user_id) values(${employee.tenantId},${employee.userId})
    `))).rejects.toMatchObject({ cause: { code: '42501' } });
    guard();
    const holderStarted = performance.now();
    const holderUntil = Math.min(workUntil, holderStarted + 15_000);
    const readyUntil = Math.min(holderUntil, holderStarted + 2_500);
    let releaseHolder!: () => void;
    let identifyHolder!: (identity: HolderIdentity) => void;
    const release = new Promise<void>(resolve => { releaseHolder = resolve; });
    const ready = new Promise<HolderIdentity>(resolve => { identifyHolder = resolve; });
    const expired = new Error('Current AI foreign-lock observation deadline expired');
    const requireHolderTime = (until: number) => {
      if (signal.aborted || workForced || performance.now() >= until) {
        stopWork();
        throw expired;
      }
    };
    requireHolderTime(readyUntil);
    releaseForeignHolder = releaseHolder;
    let rejectCourse!: (reason: Error) => void;
    const failedCourse = new Promise<never>((_, reject) => { rejectCourse = reject; });
    const stopForeign = () => {
      stopWork();
      rejectCourse(expired);
    };
    const readyTimer = setTimeout(stopForeign, Math.max(0, readyUntil - performance.now()));
    const courseTimer = setTimeout(stopForeign, Math.max(0, holderUntil - performance.now()));
    signal.addEventListener('abort', stopForeign, { once: true });
    let holderCallback: Promise<void> | undefined;
    const holder = (async () => {
      requireHolderTime(readyUntil);
      return migration.client.begin(tx => {
        holderCallback = (async () => {
          requireHolderTime(readyUntil);
          const [native] = await tx<(HolderIdentity & { distinct_keys: boolean })[]>`
            select pid,backend_start::text as started,hashtext(${own.tenantId})<>hashtext(${foreign.tenantId}) as distinct_keys
            from pg_catalog.pg_stat_activity where pid=pg_backend_pid()
          `;
          requireHolderTime(readyUntil);
          expect(native.distinct_keys).toBe(true);
          await tx`select pg_advisory_xact_lock(hashtext('ai-control'),hashtext(${foreign.tenantId}))`;
          requireHolderTime(readyUntil);
          identifyHolder({ pid: native.pid, started: native.started });
          await release;
          requireHolderTime(holderUntil);
        })();
        return holderCallback;
      });
    })();
    let foreignFailed = false;
    let holderIdentity: HolderIdentity | undefined;
    let observedDenial: Promise<unknown> | undefined;
    const holderDatabaseOid = dbOid;
    if (!holderDatabaseOid) throw Error('Native fixture database identity is missing');
    const observeHolder = async (identity: HolderIdentity, expectedHeld: boolean) => {
      requireHolderTime(holderUntil);
      const actual = await storage.client`
        select a.xact_start is not null as in_transaction,
          exists(select 1 from pg_catalog.pg_locks l where l.pid=a.pid and locktype='advisory'
            and granted and objsubid=2 and database=a.datid
            and classid::bigint=(hashtext('ai-control')::bigint+4294967296)%4294967296
            and objid::bigint=(hashtext(${foreign.tenantId})::bigint+4294967296)%4294967296) as held
        from pg_catalog.pg_stat_activity a where a.pid=${identity.pid} and a.backend_start::text=${identity.started}
          and a.datid=${holderDatabaseOid}::oid and a.usename=${role}
      `;
      requireHolderTime(holderUntil);
      expect(actual).toEqual([{ in_transaction: expectedHeld, held: expectedHeld }]);
    };
    try {
      holderIdentity = await Promise.race([
        ready, holder.then(() => { throw new Error('Foreign AI holder ended before readiness'); }), failedCourse,
      ]);
      requireHolderTime(readyUntil);
      clearTimeout(readyTimer);
      await observeHolder(holderIdentity, true);
      requireHolderTime(holderUntil);
      observedDenial = application.withTenant(own, tx => {
        requireHolderTime(holderUntil);
        return tx.execute(sql`
          update public.teras_mandate_control set tenant_id=${foreign.tenantId} where tenant_id=${own.tenantId}
        `);
      });
      await expect(Promise.race([observedDenial, failedCourse])).rejects.toMatchObject({
        cause: { code: '42501', message: 'Mandate control row differs from bound tenant' },
      });
      requireHolderTime(holderUntil);
      await observeHolder(holderIdentity, true);
    } catch (error) {
      foreignFailed = true;
      throw error;
    } finally {
      clearTimeout(readyTimer);
      releaseHolder();
      try {
        const [settled] = await Promise.allSettled([holder, ...(observedDenial ? [observedDenial] : [])]);
        // postgres.js may reject the outer begin before its callback settles on close.
        const [callback] = holderCallback ? await Promise.allSettled([holderCallback]) : [];
        if (!foreignFailed) {
          if (settled.status === 'rejected') throw settled.reason;
          expect(callback?.status).toBe('fulfilled');
          requireHolderTime(holderUntil);
          expect(holderIdentity).toBeDefined();
          await observeHolder(holderIdentity!, false);
          requireHolderTime(holderUntil);
          report.foreignDenialWhileHeld = true;
          report.foreignHolderSettled = true;
        }
      } finally {
        clearTimeout(courseTimer);
        releaseForeignHolder = undefined;
        signal.removeEventListener('abort', stopForeign);
      }
    }
    expect(await controls()).toEqual(resumed);
    await application.withTenant(own, tx => tx.execute(sql`
      update public.teras_mandate_control set stopped=true,changed_by_user_id=${own.userId} where tenant_id=${own.tenantId}
    `));
    expect(Array.from(await state(own))).toEqual([{ stopped: true, generation: 9, pending: 1 }]);
    expect(Array.from(await state(foreign))).toEqual([{ stopped: true, generation: 11, pending: 2 }]);

    guard();
    await migrate(migration.db, { migrationsFolder: directory });
    expect(await ledger()).toEqual(after);
    expect(await mandateCatalogue()).toEqual(afterCatalogue);
    expect(await procedures()).toEqual(afterProcs);
    expect(await roleGraph()).toEqual(globalBefore);
    guard();
    expect(forcedStop).toBeUndefined();
    report.complete = true;
  } catch (error) {
    courseFailed = true;
    throw error;
  } finally {
    clearTimeout(workTimer);
    const cleanup: unknown[] = [];
    const cleanupStep = () => {
      expect(forcedStop, 'Unknown native custody after forced stop').toBeUndefined();
      expect(performance.now() + 3_000, 'Private cleanup frontier').toBeLessThan(cleanupUntil);
    };
    try {
      if (forcedStop) await forcedStop;
      else {
        const closed = await closeClients(privateClients, 5);
        for (const entry of closed) if (entry.status === 'rejected') cleanup.push(entry.reason);
        expect(cleanup).toHaveLength(0);
        cleanupStep();
        await admin`set statement_timeout='2s'`;
        cleanupStep();
        await admin`set lock_timeout='1s'`;
        cleanupStep();
        // End ACKs alone cannot authorize destruction. Match the exact owned
        // database and require positive native absence before DROP.
        const current = await admin<{ oid: string; owner: string }[]>`
          select oid::text,datdba::text as owner from pg_catalog.pg_database where datname=${database}
        `;
        if (dbOid) {
          expect(current).toEqual([{ oid: dbOid, owner: roleOid }]);
          cleanupStep();
          expect(await admin`select pid from pg_catalog.pg_stat_activity where datid=${dbOid}::oid`).toHaveLength(0);
          cleanupStep();
          await admin.unsafe(`DROP DATABASE "${database}"`);
        } else {
          expect(current).toHaveLength(0);
        }
        cleanupStep();
        const actualRole = await admin<{ oid: string }[]>`select oid::text from pg_catalog.pg_roles where rolname=${role}`;
        if (roleOid) {
          expect(actualRole).toEqual([{ oid: roleOid }]);
          cleanupStep();
          await admin.unsafe(`DROP ROLE "${role}"`);
        } else {
          expect(actualRole).toHaveLength(0);
        }
        cleanupStep();
        expect(await admin`
          select not exists(select 1 from pg_catalog.pg_roles where rolname=${role}) as role_absent,
            not exists(select 1 from pg_catalog.pg_database where datname=${database}) as database_absent
        `).toEqual([{ role_absent: true, database_absent: true }]);
        if (admittedGlobal) expect(await roleGraph()).toEqual(admittedGlobal);
        cleanupStep();
        report.shutdown = 'physically-settled';
      }
    } catch (error) { cleanup.push(error); }
    try { await admin.end({ timeout: Math.max(0, Math.min(5, (cleanupUntil - performance.now()) / 1000)) }); }
    catch (error) { cleanup.push(error); }
    if (forcedStop) {
      await forcedStop;
      cleanup.push(new Error('Native fixture ownership or settlement is unknown after deadline'));
    }
    clearTimeout(hardTimer);
    signal.removeEventListener('abort', stopWork);
    try { if (directory) rmSync(directory, { recursive: true }); } catch (error) { cleanup.push(error); }
    report.cleanupComplete = cleanup.length === 0 && report.shutdown === 'physically-settled';
    if (!report.cleanupComplete) {
      report.shutdown = 'unknown';
      report.complete = false;
    }
    const finalBytes = JSON.stringify(report);
    try {
      // This clock admits writing the already-encoded packet. It does not
      // attest when the filesystem finishes; the outer hosted case must pass.
      if (!signal.aborted && performance.now() < cleanupUntil) save(finalBytes);
      else {
        cleanup.push(new Error('Native fixture evidence write admission expired'));
        report.shutdown = 'unknown';
        report.cleanupComplete = false;
        report.complete = false;
        save();
      }
    } catch (error) { cleanup.push(error); }
    if (!courseFailed && cleanup.length) throw new AggregateError(cleanup, 'Current AI upgrade fixture did not settle');
  }
}, 300_000);
