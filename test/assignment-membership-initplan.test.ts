/** Real appended policy migration; populated data and native authority, no mocks. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {againstReviewedVisibility,REVIEWED_VISIBILITY_PREDECESSOR} from './helpers/reviewed-visibility';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {assignment} from '../db/schema';
import {pgSqlState} from '../lib/db-error';
import {closeAll,migrateTestDb,owner,resetDb} from './harness';
import {createAssignmentAuthorityFixture,assertAssignmentAuthority} from './performance/employee-choice-assignment-authority';

const migration=readFileSync('db/migrations/3102_assignment_membership_initplan.sql','utf8');
const compact=(value:string)=>value.replace(/\s+/g,'');
// Independent predecessor/deparsed successor identities, not parsed from the append.
const originalQual='((tenant_id=app.current_tenant_id())AND(employment_id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[])))';
const currentQual='((tenant_id=app.current_tenant_id())AND(employment_idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest)))';
const previousSql='(tenant_id=app.current_tenant_id()) AND (employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]))';
const checkQual='((tenant_id=app.current_tenant_id())ANDapp.can_admin_employment(employment_id))';
type Policy={schemaname:string;tablename:string;policyname:string;permissive:string;roles:string[];cmd:string;qual:string;with_check:string};
async function policy(){
 const rows=Array.from(await owner.client<Policy[]>`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where schemaname='public' and tablename='assignment' and policyname='assignment_rls'`);
 expect(rows).toHaveLength(1);return rows[0];
}
async function security(){
 const policies=Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
 const functions=Array.from(await owner.client`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,
  p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig,p.prosecdef,p.provolatile,p.proparallel
  from pg_proc p where p.oid in ('app.visible_employment_ids()'::regprocedure,'app.visible_person_ids()'::regprocedure,
   'app.can_see_employment(uuid)'::regprocedure,'app.can_see_person(uuid)'::regprocedure) order by p.oid::regprocedure::text`);
 const grants=Array.from(await owner.client`select table_schema,table_name,grantee,privilege_type,is_grantable
  from information_schema.role_table_grants where table_schema='public' and table_name in ('assignment','employment','person')
  order by table_schema,table_name,grantee,privilege_type`);
 const indexes=Array.from(await owner.client`select indexname,indexdef from pg_indexes where schemaname='public' and tablename='assignment' order by indexname`);
 return {policies,functions,grants,indexes};
}
async function setQual(qual:string){await owner.client.begin(tx=>tx.unsafe('ALTER POLICY assignment_rls ON public.assignment USING ('+qual+')'));}
beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);

it('installs the exact append and preserves all non-membership policy fields',async()=>{
 expect(createHash('sha256').update(migration).digest('hex')).toBe('21a7750a316cc8a0025e8d5c51e77cd06491ce8b1fea50d8414267e9c0cc6ab0');
 const row=await policy();expect(row).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(compact(row.qual)).toBe(currentQual);expect(compact(row.with_check)).toBe(checkQual);
});

it('replays actual SQL on populated predecessor data with native history, scope and live revocation parity',async()=>{
 const f=await createAssignmentAuthorityFixture(),installed=await policy(),metadata=await security();
 try{
  await setQual(previousSql);expect(compact((await policy()).qual)).toBe(originalQual);
  const before=await assertAssignmentAuthority(f);
  await owner.client.begin(tx=>tx.unsafe(againstReviewedVisibility(migration)));
  expect(await policy()).toEqual(installed);expect(await security()).toEqual(metadata);
  const after=await assertAssignmentAuthority(f);expect(after).toEqual(before);
  let denied:unknown;
  try{await withTenant(f.employeeCtx,tx=>tx.update(assignment).set({departmentId:f.b.deptB}).where(eq(assignment.id,f.alpha.assignmentId!)));}
  catch(error){denied=error;}
  expect(pgSqlState(denied)).toBe('42501');
  const rollback=new Error('Intentional native administrator write rollback');
  await expect(withTenant(f.ctx,async tx=>{
   const rows=await tx.update(assignment).set({departmentId:f.b.deptB}).where(eq(assignment.id,f.alpha.assignmentId!)).returning({id:assignment.id});
   expect(rows).toEqual([{id:f.alpha.assignmentId!}]);throw rollback;
  })).rejects.toBe(rollback);
  const [restored]=await owner.db.select({departmentId:assignment.departmentId}).from(assignment).where(eq(assignment.id,f.alpha.assignmentId!));
  expect(restored.departmentId).toBe(f.b.deptA);
 }finally{await setQual(installed.qual);}
 expect(await security()).toEqual(metadata);
},120000);

it.each(['using','with-check','roles','command','permissive','missing','function-settings','function-volatility','function-security','function-body']as const)
 ('refuses unexpected %s drift and rolls back the complete rehearsal',async drift=>{
 const installed=await policy(),metadata=await security();
 await expect(owner.client.begin(async tx=>{
  await tx.unsafe(REVIEWED_VISIBILITY_PREDECESSOR);
  await tx.unsafe('ALTER POLICY assignment_rls ON public.assignment USING ('+previousSql+')');
  if(drift==='using')await tx.unsafe('ALTER POLICY assignment_rls ON public.assignment USING (true)');
  if(drift==='with-check')await tx.unsafe('ALTER POLICY assignment_rls ON public.assignment WITH CHECK (true)');
  if(drift==='roles')await tx.unsafe('ALTER POLICY assignment_rls ON public.assignment TO PUBLIC');
  if(['command','permissive','missing'].includes(drift)){
   await tx.unsafe('DROP POLICY assignment_rls ON public.assignment');
   if(drift==='command')await tx.unsafe('CREATE POLICY assignment_rls ON public.assignment FOR SELECT TO ai_hr_app USING ('+previousSql+')');
   if(drift==='permissive')await tx.unsafe('CREATE POLICY assignment_rls ON public.assignment AS RESTRICTIVE FOR ALL TO ai_hr_app USING ('+previousSql+') WITH CHECK (tenant_id=app.current_tenant_id() AND app.can_admin_employment(employment_id))');
  }
  if(drift==='function-settings')await tx.unsafe("ALTER FUNCTION app.visible_employment_ids() SET search_path='pg_catalog'");
  if(drift==='function-volatility')await tx.unsafe('ALTER FUNCTION app.visible_employment_ids() VOLATILE');
  if(drift==='function-security')await tx.unsafe('ALTER FUNCTION app.visible_employment_ids() SECURITY INVOKER');
  if(drift==='function-body')await tx.unsafe('CREATE OR REPLACE FUNCTION app.visible_employment_ids() RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $body$ BEGIN RETURN ARRAY[]::uuid[]; END; $body$');
  await tx.unsafe(migration);throw new Error('Unexpectedly accepted unreviewed authority drift');
 })).rejects.toMatchObject({code:'55000'});
 expect(await policy()).toEqual(installed);expect(await security()).toEqual(metadata);
});

it('retains positive policy truth with NULL, empty, duplicate and matching memberships',async()=>{
 const first=randomUUID(),second=randomUUID(),outside=randomUUID();
 const members=[sql`null::uuid[]`,sql`array[]::uuid[]`,sql`array[null::uuid]`,sql`array[${first}::uuid]`,sql`array[${second}::uuid]`,sql`array[${first}::uuid,${first}::uuid]`,sql`array[null::uuid,${first}::uuid]`];
 const inputs=[null,first,second,outside].flatMap((subject,i)=>members.map((ids,j)=>sql`(${i*members.length+j},${subject}::uuid,${ids})`));
 const rows=await owner.db.execute<{old_allowed:boolean;new_allowed:boolean}>(sql`
  with inputs(id,subject,members) as (values ${sql.join(inputs,sql`,`)})
  select (subject=any(members))is true as old_allowed,(subject in(select unnest((select members))))is true as new_allowed from inputs order by id`);
 expect(rows).toHaveLength(28);expect(rows.every(row=>row.old_allowed===row.new_allowed)).toBe(true);
 expect(rows.some(row=>row.new_allowed)).toBe(true);expect(rows.some(row=>!row.new_allowed)).toBe(true);
});
