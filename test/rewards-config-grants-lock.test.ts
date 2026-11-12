/** Migration 5620 (board 60f1fdcd loose ends, docs/adr/2026-11-12-rewards-direct-configuration.md):
 * - the 5580 configuration predicates and the creating flag are no longer executable by PUBLIC, yet every role that
 *   evaluates them may (derived from the catalogue, as test/policy-helper-function-grants does);
 * - the creating flag cannot be set by the application role to slip a raw annual review past the annual-admission
 *   guard: the flag also requires the owner role, and the guard evaluates it as the inserting role;
 * - the review creator refuses a plan it cannot see before its company-year lock, instead of hashing a NULL year.
 * Fictional tenants only. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {adminCtx,setModule,owner,migrateTestDb,resetDb,seedBase,closeAll,type Base} from './harness';
import {withTenant} from '../db/client';
import {businessUnit} from '../db/schema';
import {createApprovedRewardUnit} from './rewards-setup-fixture';

const PREDICATES=['app.reward_config_editor(uuid)','app.reward_config_viewer(uuid)','app.reward_config_library_viewer()',
 'app.reward_config_editor_anywhere()','app.reward_config_creating()'];
let b:Base;let bu:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');
 const [unit]=await owner.db.insert(businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'GRANTS-BU',name:'Fictional grants unit'}).returning();bu=unit.id;
});

const publicExecute=async(fn:string)=>(await owner.client<{p:boolean}[]>`select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where p.oid=to_regprocedure(${fn}) and a.grantee=0 and a.privilege_type='EXECUTE') as p`)[0].p;
const execute=async(role:string,fn:string)=>(await owner.client<{e:boolean}[]>`select has_function_privilege(${role},to_regprocedure(${fn}),'EXECUTE') as e`)[0].e;
/** Every role subject to row security that reaches a policy calling fn (same derivation as policy-helper-function-grants). */
const policyNeeds=(fn:string)=>owner.client<{role:string;relation:string;execute:boolean}[]>`
 with policies as (select distinct p.oid,p.polrelid,p.polroles from pg_policy p join pg_depend d on d.classid='pg_policy'::regclass and d.objid=p.oid
   and d.refclassid='pg_proc'::regclass and d.refobjid=to_regprocedure(${fn}))
 select distinct r.rolname::text as role,c.relname::text as relation,has_function_privilege(r.oid,to_regprocedure(${fn}),'EXECUTE') as execute
 from policies p join pg_class c on c.oid=p.polrelid cross join pg_roles r
 where not r.rolsuper and not r.rolbypassrls and r.rolname not like 'pg\\_%' and (not pg_has_role(r.oid,c.relowner,'USAGE') or c.relforcerowsecurity)
  and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE'))
  and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) x where pg_has_role(r.oid,x,'MEMBER')))
 order by 1,2`;

it('takes EXECUTE on the five configuration predicates away from PUBLIC and keeps it for every role that evaluates them',async()=>{
 for(const fn of PREDICATES)expect(await publicExecute(fn),fn).toBe(false);
 for(const fn of PREDICATES)expect(await execute('ai_hr_app',fn),fn).toBe(true);
 // The editor predicate sits in permissive policies that apply to every role: each role that reaches one may run it.
 const needs=await policyNeeds('app.reward_config_editor(uuid)');
 expect([...new Set(needs.map(n=>n.relation))].sort()).toEqual(expect.arrayContaining(['reward_library','reward_library_version','reward_pat_version']));
 expect([...new Set(needs.map(n=>n.role))].sort()).toEqual(expect.arrayContaining(['ai_hr_app','ai_hr_reward_setup_reader']));
 expect(needs.filter(n=>!n.execute)).toEqual([]);
 // The creating flag is evaluated by the SECURITY INVOKER annual-admission guard under whichever role inserts a review.
 const inserters=await owner.client<{role:string;execute:boolean}[]>`select r.rolname::text as role,has_function_privilege(r.oid,'app.reward_config_creating()'::regprocedure,'EXECUTE') as execute
  from pg_roles r where not r.rolsuper and r.rolname not like 'pg\\_%' and has_table_privilege(r.oid,'public.reward_unit'::regclass,'INSERT') order by 1`;
 expect(inserters.map(r=>r.role)).toEqual(expect.arrayContaining(['ai_hr_app','ai_hr_reward_setup_reader']));
 expect(inserters.filter(r=>!r.execute)).toEqual([]);
 // The other three are application calls only (menus, list views, the change log), not policy predicates.
 for(const fn of PREDICATES.slice(1,4))expect(await policyNeeds(fn),fn).toEqual([]);
 for(const fn of PREDICATES.slice(1,4))expect(await execute('ai_hr_reward_upload_reader',fn),fn).toBe(false);
});

it('does not let the application role use the creating flag to pass the annual-admission guard',async()=>{
 const unit=await createApprovedRewardUnit(adminCtx(b),{name:'Guard bypass attempt',year:2026,companyId:b.companyId,businessUnitId:bu,snapshotDate:'2026-01-01'});
 // The flag requires the owner role as well as this transaction's id: the application role does not hold it.
 const [membership]=await owner.client<{member:boolean}[]>`select pg_has_role('ai_hr_app',(select relowner from pg_class where oid='public.app_user'::regclass),'USAGE') as member`;
 expect(membership.member).toBe(false);
 const definition=(await owner.client<{src:string}[]>`select prosrc as src from pg_proc where oid='app.reward_config_creating()'::regprocedure`)[0].src;
 expect(definition).toMatch(/current_setting\('app\.reward_config_creating',true\)/);expect(definition).toMatch(/pg_has_role\(current_user/);
 // A Group Rewards administrator (setup authority over the company) forges the flag and inserts a copy of a real
 // annual review: the flag reads false and the guard refuses with its own message, before any snapshot check.
 const attempt=withTenant(adminCtx(b),async tx=>{
  const [flag]=await tx.execute<{forged:string;creating:boolean;role:string}>(sql`select set_config('app.reward_config_creating',txid_current()::text,true) as forged,app.reward_config_creating() as creating,current_user::text as role`);
  expect(flag.role).toBe('ai_hr_app');expect(flag.forged).toMatch(/^\d+$/);expect(flag.creating).toBe(false);
  const [authority]=await tx.execute<{allowed:boolean}>(sql`select app.reward_setup_allowed(${b.companyId}::uuid,'manage') as allowed`);expect(authority.allowed).toBe(true);
  await tx.execute(sql`insert into reward_unit(tenant_id,cycle_id,company_id,business_unit_id,policy,policy_group_version_id,snapshot_date,created_by)
   select tenant_id,cycle_id,company_id,business_unit_id,policy,policy_group_version_id,snapshot_date,app.current_user_id() from reward_unit where id=${unit}::uuid`);
 });
 await expect(attempt).rejects.toMatchObject({cause:{code:'42501',message:expect.stringMatching(/Use approved Rewards annual admission/)}});
 const [count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from reward_unit where tenant_id=${b.tenantId}::uuid and kind='annual'`);
 expect(count.n).toBe(1);
 // Contrast: under a role that holds the owner role the same flag reads true, so the role is what the guard requires.
 const [ownerFlag]=await owner.client.begin(async tx=>{await tx`select set_config('app.reward_config_creating',txid_current()::text,true)`;return tx<{creating:boolean}[]>`select app.reward_config_creating() as creating`;});
 expect(ownerFlag.creating).toBe(true);
});

it('refuses a plan the creator cannot see before taking the company-year lock, across tenants too',async()=>{
 const unit=await createApprovedRewardUnit(adminCtx(b),{name:'Lock fixture',year:2026,companyId:b.companyId,businessUnitId:bu,snapshotDate:'2026-01-01'});
 const [binding]=await owner.db.execute<{plan:string}>(sql`select plan_version_id::text as plan from reward_unit_setup where unit_id=${unit}::uuid`);
 // The body reads the plan year itself and refuses NULL before the company-year lock, which now hashes that variable.
 const src=(await owner.client<{src:string}[]>`select prosrc as src from pg_proc where oid='app.reward_config_create_planned_unit(uuid,uuid,uuid)'::regprocedure`)[0].src;
 const read=src.indexOf('SELECT year INTO plan_year FROM reward_plan_setup'),refuse=src.indexOf('IF plan_year IS NULL THEN RAISE'),lock=src.indexOf(":company-year:'||wanted_company::text||':'||plan_year::text");
 expect(read).toBeGreaterThan(0);expect(refuse).toBeGreaterThan(read);expect(lock).toBeGreaterThan(refuse);
 expect(src).not.toMatch(/company-year:'\|\|wanted_company::text\|\|':'\|\|\(SELECT/);
 expect(src.indexOf("app.reward_setup_allowed(wanted_company,'manage')")).toBeLessThan(read);
 // An unknown plan version: refused with the plan message (the authority check passes; the plan is not visible).
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.reward_config_create_planned_unit(${randomUUID()}::uuid,${b.companyId}::uuid,${bu}::uuid)`)))
  .rejects.toMatchObject({cause:{message:expect.stringMatching(/Current approved plan and available legal employer required/)}});
 // Another tenant's Group Rewards administrator naming this tenant's plan: invisible there, refused the same way.
 const other=await seedBase();await setModule(other.tenantId,'rewards','active');
 const [otherUnit]=await owner.db.insert(businessUnit).values({tenantId:other.tenantId,companyId:other.companyId,code:'GRANTS-OTHER',name:'Fictional other unit'}).returning();
 await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,company_id,role,valid_from,created_by,reason) values(${other.tenantId}::uuid,${other.adminUserId}::uuid,null,'gr','2000-01-01',${other.adminUserId}::uuid,'Fictional other-tenant Group Rewards')`);
 await expect(withTenant(adminCtx(other),tx=>tx.execute(sql`select app.reward_config_create_planned_unit(${binding.plan}::uuid,${other.companyId}::uuid,${otherUnit.id}::uuid)`)))
  .rejects.toMatchObject({cause:{message:expect.stringMatching(/Current approved plan and available legal employer required/)}});
 const [counts]=await owner.db.execute<{mine:number;theirs:number}>(sql`select count(*) filter(where tenant_id=${b.tenantId}::uuid)::int as mine,count(*) filter(where tenant_id=${other.tenantId}::uuid)::int as theirs from reward_unit`);
 expect(counts).toEqual({mine:1,theirs:0});
});
