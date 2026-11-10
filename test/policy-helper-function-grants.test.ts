/** EXECUTE on three helpers the combined release added (5012/5070, 5055, 5090): never PUBLIC, and always every role that
 * needs it. Two are evaluated inside row-security policies (under whichever role the policy applies to); the third is a
 * WHEN condition of the domain_event fence triggers, evaluated under the role that writes domain_event. The roles are
 * derived here independently of the migrations, from the catalogue: who can reach each policy, who can write the table. */
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {closeAll,migrateTestDb,owner} from './harness';

const POLICY_HELPERS=['app.import_released_attempt_ids()','app.payroll_history_hidden_rows(text)'];
const SEALING='app.domain_event_chain_sealing()';
type Need={role:string;relation:string;policy:string;execute:boolean};
const publicExecute=async(fn:string)=>(await owner.client<{p:boolean}[]>`select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where p.oid=to_regprocedure(${fn}) and a.grantee=0 and a.privilege_type='EXECUTE') as p`)[0].p;
/** Every role subject to row security that can reach a policy calling the helper: it holds a privilege on the table
 * (directly or through membership), the policy applies to it, and it neither owns the table (unless row security is
 * forced), bypasses row security nor is a superuser or a predefined pg_ role. */
const policyNeeds=(fn:string)=>owner.client<Need[]>`
 with policies as (select distinct p.oid,p.polname,p.polrelid,p.polroles from pg_policy p join pg_depend d on d.classid='pg_policy'::regclass and d.objid=p.oid
   and d.refclassid='pg_proc'::regclass and d.refobjid=to_regprocedure(${fn}))
 select r.rolname::text as role,c.relname::text as relation,p.polname::text as policy,has_function_privilege(r.oid,to_regprocedure(${fn}),'EXECUTE') as execute
 from policies p join pg_class c on c.oid=p.polrelid cross join pg_roles r
 where not r.rolsuper and not r.rolbypassrls and r.rolname not like 'pg\\_%' and (r.oid<>c.relowner or c.relforcerowsecurity)
  and (has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE') or has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE'))
  and (0=any(p.polroles) or exists(select 1 from unnest(p.polroles) x where pg_has_role(r.oid,x,'MEMBER')))
 order by 1,2,3`;
/** Every role that can write domain_event (table or column INSERT, UPDATE, DELETE or TRUNCATE), including its owner. */
const writers=()=>owner.client<{role:string;execute:boolean}[]>`
 select r.rolname::text as role,has_function_privilege(r.oid,to_regprocedure(${SEALING}),'EXECUTE') as execute from pg_roles r
 where not r.rolsuper and r.rolname not like 'pg\\_%'
  and (has_table_privilege(r.oid,'public.domain_event'::regclass,'INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege(r.oid,'public.domain_event'::regclass,'INSERT,UPDATE'))
 order by 1`;
/** A fresh login-less role holding only what `grant` gives it (ROLE stands for its name). */
async function withStranger<T>(grant:string,fn:(role:string)=>Promise<T>){
 const role='aihr_test_stranger_'+randomUUID().replace(/-/g,'').slice(0,12);
 await owner.client.unsafe(`create role ${role} nologin`);
 try{await owner.client.unsafe(`grant usage on schema app to ${role}; ${grant.replace(/ROLE/g,role)}`);return await fn(role);}
 finally{await owner.client.unsafe(`drop owned by ${role}; drop role ${role}`);}
}

describe('helper functions are executable by exactly the roles that need them',()=>{
 beforeAll(migrateTestDb);
 afterAll(closeAll);

 it('none of the three is executable by PUBLIC',async()=>{
  for(const fn of [...POLICY_HELPERS,SEALING])expect(await publicExecute(fn),fn).toBe(false);
 });

 it('every role a calling policy applies to may run the policy helper',async()=>{
  for(const fn of POLICY_HELPERS){
   const needs=await policyNeeds(fn);
   // The policies exist and reach the application role on every table they guard.
   expect(needs.length,fn).toBeGreaterThan(0);
   const relations=new Set(needs.map(n=>n.relation));
   for(const relation of relations)expect(needs.some(n=>n.relation===relation&&n.role==='ai_hr_app'),fn+' '+relation).toBe(true);
   expect(needs.filter(n=>!n.execute),fn).toEqual([]);
  }
  // The helpers' tables, as reviewed: employment, person, domain_event and the nine catalogue tables; the five payroll tables.
  expect([...new Set((await policyNeeds(POLICY_HELPERS[0])).map(n=>n.relation))].sort()).toEqual(['business_unit','cost_center','department','domain_event','employment','grade_group','grade_group_member','job_grade','label_company_assignment','person','position','profile_option']);
  expect([...new Set((await policyNeeds(POLICY_HELPERS[1])).map(n=>n.relation))].sort()).toEqual(['payroll_batch','payroll_history_import_record','payroll_history_import_revision','payroll_history_import_snapshot','payslip']);
 });

 it('the application role reads every guarded table through the helpers, and runs them directly',async()=>{
  const tables=['employment','person','domain_event','department','job_grade','payroll_batch','payslip','payroll_history_import_record'];
  await owner.client.begin(async tx=>{
   await tx`set local role ai_hr_app`;await tx`select set_config('app.tenant_id',${randomUUID()},true)`;
   for(const table of tables)expect((await tx.unsafe(`select count(*)::int as n from public.${table}`))[0].n,table).toBe(0);
   expect((await tx`select app.import_released_attempt_ids() as ids`)[0].ids).toEqual([]);
   expect((await tx`select app.payroll_history_hidden_rows('payslip') as ids`)[0].ids).toEqual([]);
  });
 });

 it('a role outside those policies and writers cannot run any of the three',async()=>{
  await withStranger('',async role=>{
   for(const [fn,call] of [['import_released_attempt_ids','select app.import_released_attempt_ids()'],['payroll_history_hidden_rows',"select app.payroll_history_hidden_rows('payslip')"],['domain_event_chain_sealing','select app.domain_event_chain_sealing()']] as const){
    await expect(owner.client.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(call);}),fn).rejects.toMatchObject({code:'42501',message:expect.stringContaining(fn)});
   }
  });
 });

 it('every role that writes domain_event may run the fence triggers\' WHEN helper, as itself',async()=>{
  const roles=await writers();
  // The application role and the two Rewards definer owners insert events.
  for(const role of ['ai_hr_app','ai_hr_reward_setup_reader','ai_hr_reward_preparation_invalidator'])expect(roles.map(r=>r.role),role).toContain(role);
  expect(roles.filter(r=>!r.execute)).toEqual([]);
  // Called by name as each writer (the triggers reach it by oid; a call by name also needs the schema).
  const callable=await owner.client<{role:string}[]>`select r.rolname::text as role from pg_roles r where r.rolname=any(${roles.map(r=>r.role)}) and has_schema_privilege(r.oid,'app','USAGE') order by 1`;
  expect(callable.map(r=>r.role)).toContain('ai_hr_app');
  for(const {role} of callable){
   const [row]=await owner.client.begin(async tx=>{await tx.unsafe(`set local role "${role.replace(/"/g,'""')}"`);return tx`select app.domain_event_chain_sealing() as sealing`;});
   expect(row.sealing,role).toBe(false);
  }
  // A role that only reads events is not among them.
  await withStranger('grant select on public.domain_event to ROLE',async role=>{
   expect((await owner.client`select has_function_privilege(${role},to_regprocedure(${SEALING}),'EXECUTE') as x`)[0].x).toBe(false);
  });
 });
});
