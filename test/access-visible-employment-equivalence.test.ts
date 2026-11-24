/** ADR 0181 precomputed employment visibility (migration 7240): equivalence, on test/access-visible-employment-fixture.ts.
 *
 * The PREVIOUS app.visible_employment_ids (the 5144 statement) and the previous employment_rls and person_rls (the
 * texts 7240 guards) against 7240 in each mode ('legacy', 'shadow', 'precomputed'): for every actor (group, subtree,
 * leaf and second-tree administrators, a super administrator, both-role holders, an employee, claims narrower and
 * wider than the grant, archived and login-blocked administrators, Payroll and performance-and-compensation
 * partners, line managers at several depths, a terminated manager, a manager whose line ends tomorrow, a person with
 * two employments, a department head and a non-qualifying one) the visible employment and person arrays, the
 * employment, person and assignment rows, and the employee picker's page are identical. Then the stored answer equals
 * the legacy walk for one user in every ten employments. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {verifyAccessVisibleEmploymentTenant,visibleEmploymentDifferences} from '../core/access-visible-employment-check';
import {owner} from './harness';
import {teardownFixture} from './access-effective-company-fixture';
import {MODES,actors,b,buildVisibilityFixture,byCode,eq,expectEquivalent,managerUsers,relationshipDifferences,sampleUsers,setMode,stateRow,unusable} from './access-visible-employment-fixture';

beforeAll(buildVisibilityFixture,900_000);
afterAll(teardownFixture);

const visible=(o:unknown)=>{const r=(o as {raw:{visible?:string[]}}).raw;return r.visible?r.visible.length:-1;};

describe('precomputed employment visibility (7240): equivalence',()=>{
 it('installs owner-only stored rows, a usable trusted state and once-per-statement readers',async()=>{
  const tables=await owner.client<{name:string;app:boolean;rls:boolean;forced:boolean}[]>`select c.relname as name,
   has_table_privilege('ai_hr_app',c.oid,'select,insert,update,delete') as app,c.relrowsecurity as rls,c.relforcerowsecurity as forced
   from pg_class c where c.relnamespace='public'::regnamespace and c.relname in ('access_reporting_reach','access_department_closure','access_employment_state','access_employment_precompute_control') order by 1`;
  expect(tables).toEqual(['access_department_closure','access_employment_precompute_control','access_employment_state','access_reporting_reach'].map(name=>({name,app:false,rls:true,forced:true})));
  const fns=await owner.client<{name:string}[]>`select p.proname as name from pg_proc p where p.pronamespace='app'::regnamespace
   and (p.proname like 'access_visible_%' or p.proname like 'access_reach%' or p.proname like 'access_department_closure%' or p.proname like 'access_employment_%' or p.proname like 'employment_%_companies')
   and has_function_privilege('ai_hr_app',p.oid,'execute') order by 1`;
  expect(fns.map(f=>f.name)).toEqual(['access_visible_employment_ids','access_visible_person_ids','employment_partner_companies','employment_read_companies']);
  // Never PUBLIC; every role a calling policy applies to may run them (person_rls applies to every role: the Rewards
  // reader roles read person too). Same derivation as test/policy-helper-function-grants.test.ts.
  for(const fn of ['app.access_visible_employment_ids()','app.access_visible_person_ids()','app.employment_read_companies()','app.employment_partner_companies()']){
   const[pub]=await owner.client<{p:boolean}[]>`select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    where p.oid=to_regprocedure(${fn}) and a.grantee=0 and a.privilege_type='EXECUTE') as p`;
   expect(pub.p,fn).toBe(false);
   const needs=await owner.client<{role:string;relation:string;execute:boolean}[]>`
    with policies as (select distinct p.oid,p.polrelid,p.polroles from pg_policy p join pg_depend d on d.classid='pg_policy'::regclass and d.objid=p.oid
      and d.refclassid='pg_proc'::regclass and d.refobjid=to_regprocedure(${fn}))
    select r.rolname::text as role,c.relname::text as relation,has_function_privilege(r.oid,to_regprocedure(${fn}),'EXECUTE') as execute
    from policies p join pg_class c on c.oid=p.polrelid cross join pg_roles r
    where not r.rolsuper and not r.rolbypassrls and r.rolname not like 'pg\\_%' and (not pg_has_role(r.oid,c.relowner,'USAGE') or c.relforcerowsecurity)
     and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE'))
     and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) x where pg_has_role(r.oid,x,'MEMBER')))`;
   expect(needs.length,fn).toBeGreaterThan(0);
   expect(needs.filter(n=>!n.execute),fn).toEqual([]);
  }
  // Every read-path function is PL/pgSQL, so its statements are planned once per connection: a LANGUAGE sql SECURITY
  // DEFINER function with SET is never inlined and is re-planned on every call (7245; release 6 gate, History 23 s -> 169 s).
  const langs=await owner.client<{name:string;lang:string}[]>`select p.proname as name,l.lanname as lang from pg_proc p join pg_language l on l.oid=p.prolang
   where p.pronamespace='app'::regnamespace and p.proname in ('visible_employment_ids','access_visible_employment_ids','access_visible_employment_unusable','access_visible_employment_legacy',
    'access_visible_employment_stored','access_visible_person_ids','employment_read_companies','employment_partner_companies') order by 1`;
  expect(langs.map(r=>r.lang)).toEqual(Array(8).fill('plpgsql'));
  const personReaders=await owner.client<{n:number}[]>`select count(distinct r.rolname)::int as n from pg_roles r where has_function_privilege(r.oid,'app.access_visible_person_ids()'::regprocedure,'EXECUTE') and r.rolname<>'ai_hr_app' and not r.rolsuper`;
  expect(personReaders[0].n,'roles other than ai_hr_app that read person can run its reader').toBeGreaterThan(0);
  const[mode]=await owner.client<{mode:string}[]>`select mode from access_employment_precompute_control`;expect(mode.mode).toBe('legacy');
  expect(await stateRow()).toMatchObject({stale:false,trusted:true});
  expect(await unusable(managerUsers[eq(2)])).toBeNull();
  // Not vacuous: managers reach through the tree, and the department closure and reach hold rows.
  const[counts]=await owner.client<{reach:number;depts:number}[]>`select (select count(*)::int from access_reporting_reach where tenant_id=${b.tenantId}::uuid) as reach,
   (select count(*)::int from access_department_closure where tenant_id=${b.tenantId}::uuid) as depts`;
  expect(counts.reach).toBeGreaterThan(50);expect(counts.depts).toBeGreaterThan(210);
  const v=await verifyAccessVisibleEmploymentTenant(owner.db,b.tenantId);
  expect(v.trusted).toBe(true);expect(visibleEmploymentDifferences(v)).toBe(0);
  // The employment and person policies ask their company questions once per statement.
  for(const m of MODES){
   await setMode(m);
   const plan=(await withTenant(actors['group administrator'],tx=>tx.execute<{'QUERY PLAN':string}>(sql`explain (verbose,costs off) select e.id from employment e join person p on p.id=e.person_id`))).map(r=>r['QUERY PLAN']).join('\n');
   expect(plan,m).toMatch(/InitPlan[\s\S]*employment_read_companies/);expect(plan,m).toMatch(/InitPlan[\s\S]*access_visible_employment_ids/);
   expect(plan,m).not.toMatch(/can_admin_perfcomp_for\(e\.company_id\)/);
  }
  await setMode('legacy');
 },600_000);

 it('returns identical visibility, rows, order and picker pages for every actor in every mode',async()=>{
  const seen=await expectEquivalent('fixture');
  // Independent expectations: several managers see more than themselves; a terminated manager sees itself only;
  // administrators see the group; an employee with no person sees nothing.
  // (The company clamp removes most hops in this fixture, so depth alone does not order the managers.)
  const managers=Object.keys(seen).filter(k=>k.startsWith('manager EQ'));
  expect(managers.filter(k=>visible(seen[k])>1).length).toBeGreaterThanOrEqual(3);
  expect(visible(seen['manager EQ6'])).toBe(1);
  expect(visible(seen['group administrator'])).toBeGreaterThanOrEqual(1000);
  expect(visible(seen['employee'])).toBe(0);
 },1_800_000);

 it('stores exactly the legacy walk for one user in every ten employments',async()=>{
  expect(sampleUsers.length).toBeGreaterThan(50);
  expect(await relationshipDifferences([...sampleUsers,...Object.values(managerUsers)])).toEqual([]);
 },900_000);
});
