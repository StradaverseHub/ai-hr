/** Compare scoped approver reads in one disposable fixture transaction. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const probe = `
CREATE FUNCTION app.performance_approver_options_probe(wanted_companies uuid[])
RETURNS TABLE(id uuid,name text,employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 WITH request AS MATERIALIZED (
  SELECT DISTINCT company_id FROM unnest(wanted_companies) AS wanted(company_id)
 ), valid_scope AS MATERIALIZED (
  SELECT first_company.company_id
  FROM request first_company
  WHERE app.principal_snapshot_current()
   AND NOT EXISTS (
    SELECT 1
    FROM request r
    LEFT JOIN public.company c ON c.id=r.company_id AND c.tenant_id=app.current_tenant_id()
    WHERE c.id IS NULL OR NOT app.is_admin_for(c.id)
   )
  ORDER BY first_company.company_id
  LIMIT 1
 )
 SELECT e.id,p.full_name,e.employee_code FROM valid_scope s
 JOIN public.employment e ON e.tenant_id=app.current_tenant_id()
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE app.access_workforce_employment_permitted(
   e.tenant_id,e.company_id,e.voided_at,e.import_pending_attempt_id,
   (SELECT app.access_workforce_permitted_companies('workforce.view'))
  )
  AND app.attendance_selected_approver_eligible(s.company_id,e.id)
 ORDER BY p.full_name,e.employee_code,e.id
$$;
REVOKE ALL ON FUNCTION app.performance_approver_options_probe(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_approver_options_probe(uuid[]) TO ai_hr_app;
`;

const rolledBack = new Error('Discard disposable approver prototype');
const unknownCompany = '00000000-0000-0000-0000-000000000001';
const contract = 'app.attendance_workflow_v3_approver_options(uuid[])';

function disposableOwner(dbEnv, restricted=false) {
 assert.equal(dbEnv.GITHUB_ACTIONS,'true');
 assert.equal(dbEnv.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(dbEnv.GITHUB_REPOSITORY,'StradaverseHub/ai-hr');
 assert.equal(dbEnv.GITHUB_WORKFLOW,'alpha-focused-checks');
 assert.equal(dbEnv.GITHUB_JOB,'selected-tests');
 assert.equal(dbEnv.PERF_HTTP_SUITE,'browser-route-baseline');
 assert.equal(dbEnv.MIGRATION_DATABASE_URL,'postgres://postgres@127.0.0.1:5433/ai_hr_dev');
 const postgres = createRequire(join(process.cwd(),'package.json'))('postgres');
 const url = new URL(dbEnv.MIGRATION_DATABASE_URL);
 if (restricted) url.username = 'ai_hr_owner';
 return postgres(url.href,{max:1,connect_timeout:5});
}

/** Project only the disposable fixture into the release owner's existing role model. */
export async function projectAttendanceFixtureOwner(dbEnv) {
 const db = disposableOwner(dbEnv);
 const helper = pathToFileURL(join(process.cwd(),'test/helpers/installed-owner-projection.ts')).href;
 const {PROJECT_INSTALLED_OWNERSHIP} = await import(helper);
 try {
  await db.begin(async tx => {
   const [before] = await tx`select current_database() as database, session_user as login`;
   assert.deepEqual(before,{database:'ai_hr_dev',login:'postgres'});
   const [role] = await tx`select rolcanlogin as login,
    not(rolsuper or rolcreaterole or rolcreatedb or rolbypassrls) as restricted
    from pg_roles where rolname='ai_hr_owner'`;
   if (role) {
    assert(role.restricted,'Expected the existing disposable restricted owner');
    if (!role.login) await tx`ALTER ROLE ai_hr_owner LOGIN`;
   } else await tx`CREATE ROLE ai_hr_owner LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS NOINHERIT`;
   await tx`ALTER DATABASE ai_hr_dev OWNER TO ai_hr_owner`;
   await tx`GRANT CONNECT ON DATABASE ai_hr_dev TO ai_hr_app`;
   await tx.unsafe(PROJECT_INSTALLED_OWNERSHIP);
   assert.equal((await requireControl(tx)).owner,'ai_hr_owner');
  });
 } finally {
  await db.end({timeout:5});
 }
 const owner = disposableOwner(dbEnv,true);
 try {
  const [login] = await owner`select session_user as login,
    not(rolsuper or rolcreaterole or rolcreatedb or rolbypassrls) as restricted
    from pg_roles where rolname=current_user`;
  assert.deepEqual(login,{login:'ai_hr_owner',restricted:true});
  return {login:login.login,restricted:true,installedOwnership:true};
 } finally {
  await owner.end({timeout:5});
 }
}

async function readControl(tx) {
 const [control] = await tx`
  select pg_get_userbyid(p.proowner) as owner, p.proconfig as settings, md5(p.prosrc) as body,
   p.prosecdef as definer, p.provolatile as volatility, coalesce(p.proacl::text,'') as acl,
   pg_get_functiondef(p.oid) as definition
  from pg_proc p where p.oid=to_regprocedure(${contract})
 `;
 return control;
}

async function requireControl(tx) {
 const control = await readControl(tx);
 assert(['postgres','ai_hr_owner'].includes(control.owner));
 assert.deepEqual(control.settings,['search_path=pg_catalog, public, app','row_security=on']);
 assert.equal(control.body,'db08941be2cb88ad411f77e2e89b0cd6');
 assert(control.definer && control.volatility==='s');
 const [eligibility] = await tx`
  select md5(p.prosrc) as body
  from pg_proc p where p.oid=to_regprocedure('app.attendance_selected_approver_eligible(uuid,uuid)')
 `;
 // The exact cross-company-pending body uses company only for tenant membership.
 assert.equal(eligibility.body,'1e59af65efaf32491df7a36f443e3f6c');
 // Keep the exact workforce visibility owner and its existing set-based equivalent paired.
 const contracts = [
  ['app.access_workforce_employment(uuid,text)','dcdb6797287dc5c3339ffab3873fd892'],
  ['app.access_workforce_permitted_companies(text)','6eb803690169338c1a8480d4c488d6c1'],
  ['app.access_workforce_employment_permitted(uuid,uuid,timestamptz,uuid,uuid[])','4dcea99560326ecaba91f1f7942d402c'],
  ['app.import_marker_released(uuid)','e494ebf66f1e0e7e031738300e39166d'],
 ];
 const bodies = await tx`
  select sig as signature, md5(proc.prosrc) as hash
  from unnest(${contracts.map(([signature])=>signature)}::text[]) as wanted(sig)
  left join pg_proc proc on proc.oid=to_regprocedure(wanted.sig)
 `;
 assert.deepEqual(Object.fromEntries(bodies.map(row=>[row.signature,row.hash])),Object.fromEntries(contracts));
 return control;
}

export async function measureApproverOptions(fixture, dbEnv, record) {
 const db = disposableOwner(dbEnv);
 const [group, company, , , employee] = fixture.users;
 const report = {authorization:'existing-set-based-workforce-owner',measurements:[],rolledBack:false};
 try {
  await db.begin(async tx => {
   const control = await requireControl(tx);
   await tx.unsafe(probe).simple();
   await tx.unsafe('ALTER FUNCTION app.performance_approver_options_probe(uuid[]) OWNER TO '+control.owner);
   const boundCases = await Promise.all([group,company,employee].map(async actor => {
    const grants = await tx`
     select role::text,company_id as "companyId" from public.role_assignment
     where tenant_id=${actor.tenantId}::uuid and app_user_id=${actor.userId}::uuid
     order by role,company_id
    `;
    assert(grants.length>0);
    return {actor,grants,roles:[...new Set(grants.map(grant=>grant.role))].join(',')};
   }));
   const tenantCompanies = await tx`
    select id from public.company where tenant_id=${group.tenantId}::uuid order by id
   `;
   assert.equal(tenantCompanies.length,70,'Expected the group-size fixture');
   const own = group.companyId;
   const other = fixture.tenants[0].companies.find(row=>row.companyId!==own).companyId;
   const foreign = fixture.tenants[1].companies[0].companyId;
   const cases = [
    ['group-full',0,tenantCompanies.map(row=>row.id),true],
    ['company-own',1,[own],true],
    ['group-pair',0,[own,other],true],
    ['group-repeated',0,[own,other,own],true],
    ['group-empty',0,[],false],
    ['group-null-array',0,null,false],
    ['group-null-member',0,[own,null],false],
    ['group-unknown-company',0,[own,unknownCompany],false],
    ['group-foreign-tenant',0,[own,foreign],false],
    ['company-other-scope',1,[own,other],false],
    ['employee-denied',2,[own],false],
   ];
   await tx`SET LOCAL ROLE ai_hr_app`;
   await tx`SET LOCAL statement_timeout='30s'`;
   for(const [label,actorIndex,companies,hasRows] of cases){
    const {actor,grants,roles} = boundCases[actorIndex];
    await tx`select set_config('app.tenant_id',${actor.tenantId},true),
     set_config('app.user_id',${actor.userId},true),set_config('app.roles',${roles},true),
     set_config('app.grants',${JSON.stringify(grants)},true),set_config('jit','off',true)`;
    const [principal] = await tx`select app.principal_snapshot_current() as ok, current_user as role`;
    assert(principal.ok && principal.role==='ai_hr_app');
    const scope = companies && tx.array(companies,2950);
    const controlStart = performance.now();
    const before = await tx`select * from app.attendance_workflow_v3_approver_options(${scope}::uuid[])`;
    const controlMs = Math.round(performance.now()-controlStart);
    const probeStart = performance.now();
    const after = await tx`select * from app.performance_approver_options_probe(${scope}::uuid[])`;
    const prototypeMs = Math.round(performance.now()-probeStart);
    const equal = Array.from(before).every((row,index)=>row.id===after[index]?.id
     &&row.name===after[index].name&&row.employee_code===after[index].employee_code)
     && before.length===after.length;
    report.measurements.push({label,companies:companies?.length??null,rows:before.length,controlMs,prototypeMs,equal});
    record(report);
    assert(equal,label+' returned a different ordered list');
    assert.equal(before.length>0,hasRows,label+' returned unexpected control evidence');
   }
   throw rolledBack;
  });
 } catch(error) {
  if(error!==rolledBack)throw error;
  const [cleanup] = await db`
   select to_regprocedure('app.performance_approver_options_probe(uuid[])') is null as removed,
    md5(prosrc) as body from pg_proc where oid=to_regprocedure(${contract})
  `;
  assert(cleanup.removed && cleanup.body==='db08941be2cb88ad411f77e2e89b0cd6');
  report.rolledBack=true;
  record(report);
 } finally {
  await db.end({timeout:5});
 }
}

/** Let the exact browser build call the experiment inside the disposable runner. */
export async function installApproverOptionsBrowserPrototype(dbEnv) {
 const db = disposableOwner(dbEnv,true);
 try {
  const control = await db.begin(async tx => {
   const prior = await requireControl(tx);
   assert.equal(prior.owner,'ai_hr_owner');
   const [identity] = await tx`select session_user as login`;
   assert.equal(identity.login,prior.owner);
   const definition = probe.split('REVOKE ALL')[0].replace(
    'CREATE FUNCTION app.performance_approver_options_probe',
    'CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_approver_options',
   );
   await tx.unsafe(definition).simple();
   const installed = await readControl(tx);
   assert.notEqual(installed.body, prior.body);
   assert.equal(installed.acl, prior.acl);
   assert.equal(installed.owner, prior.owner);
   assert.deepEqual(installed.settings, prior.settings);
   assert.equal(installed.volatility, prior.volatility);
   assert.equal(installed.definer, prior.definer);
   return prior;
  });
  return async () => {
   const restore = disposableOwner(dbEnv,true);
   try {
    await restore.begin(async tx => {
     await tx.unsafe(control.definition).simple();
     assert.deepEqual(await requireControl(tx), control);
    });
   } finally {
    await restore.end({timeout:5});
   }
  };
 } finally {
  await db.end({timeout:5});
 }
}
