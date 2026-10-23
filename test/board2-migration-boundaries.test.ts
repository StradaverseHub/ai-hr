/** Actual migrated ACL/RLS/ledger checks, to run after the reviewed lower migration union. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

let base:Base;
beforeAll(async()=>{await migrateTestDb();await resetDb();base=await seedBase();});
afterAll(closeAll);

describe('Board 2 migration storage and private-port boundaries',()=>{
 it('runs application reads as the non-owner, non-bypass application role',async()=>{
  const [identity]=await withTenant(adminCtx(base),tx=>tx.execute<{role:string}>(sql`select current_user as role`));
  expect(identity.role).toBe('ai_hr_app');
  const [role]=await owner.client<{superuser:boolean;bypass:boolean}[]>`
   select rolsuper as superuser,rolbypassrls as bypass from pg_roles where rolname='ai_hr_app'`;
  expect(role).toEqual({superuser:false,bypass:false});
 });

 it('keeps private TP3 drafts and the CC outbox read-only to the application role',async()=>{
  const rows=await owner.client<{name:string;rls:boolean;forced:boolean;can_read:boolean;can_write:boolean}[]>`
   select c.relname as name,c.relrowsecurity as rls,c.relforcerowsecurity as forced,
    has_table_privilege('ai_hr_app',c.oid,'SELECT') as can_read,
    (has_table_privilege('ai_hr_app',c.oid,'INSERT') or has_table_privilege('ai_hr_app',c.oid,'UPDATE')
     or has_table_privilege('ai_hr_app',c.oid,'DELETE') or has_table_privilege('ai_hr_app',c.oid,'TRUNCATE')) as can_write
   from pg_class c where c.oid in ('public.employee_tp3_draft'::regclass,'public.attendance_workflow_cc_delivery'::regclass)
   order by c.relname`;
  expect(rows).toHaveLength(2);
  for(const row of rows)expect(row).toMatchObject({rls:true,can_read:true,can_write:false});
  expect(rows.find(row=>row.name==='employee_tp3_draft')?.forced).toBe(true);
  const policies=await owner.client<{expression:string}[]>`
   select pg_get_expr(polqual,polrelid) as expression from pg_policy
   where polrelid='public.employee_tp3_draft'::regclass order by polname`;
  expect(policies).toHaveLength(1);
  for(const guard of ['current_tenant_id','principal_snapshot_current','is_self_person'])expect(policies[0].expression).toContain(guard);
 });

 it('does not expose privileged helpers or private CC delivery ports through PUBLIC or the app role',async()=>{
  const ports:[string,boolean][]=[
   ['app.my_tp3_eligible(uuid)',false],
   ['app.my_tp3_save_draft(uuid,integer,integer,smallint,jsonb,jsonb,boolean)',true],
   ['app.my_tp3_insert(uuid,integer,smallint,jsonb,jsonb)',true],
   ['app.my_tp3_projection(uuid,jsonb)',true],
   ['app.my_tp3_complete_guard()',false],
   ['app.my_ea_source_options()',true],
   ['app.my_ea_source_available(uuid,uuid,text)',true],
   ['app.attendance_workflow_resolve_v4(uuid,jsonb,jsonb)',true],
   ['app.attendance_workflow_retire(uuid,integer)',true],
   ['app.attendance_workflow_retirement_guard()',false],
   ['app.attendance_workflow_cc_claim(uuid,uuid[])',true],
   ['app.attendance_workflow_cc_enqueue()',false],
   ['app.attendance_workflow_version_successor()',false],
   ['identity_email.attendance_cc_target(uuid,uuid,text)',false],
   ['identity_email.start_attendance_cc(uuid,uuid,text,jsonb)',false],
   ['identity_email.finish_attendance_cc(uuid,uuid,text,text)',false],
  ];
  for(const [signature,appExecute] of ports){
   const rows=await owner.client<{definer:boolean;config:string[]|null;app_execute:boolean;public_execute:boolean}[]>`
    select p.prosecdef as definer,p.proconfig as config,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
     exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
    from pg_proc p where p.oid=to_regprocedure(${signature})`;
   expect(rows,signature).toHaveLength(1);
   expect(rows[0],signature).toMatchObject({definer:true,app_execute:appExecute,public_execute:false});
   expect(rows[0].config?.map(value=>value.replaceAll(' ','')),signature).toContain('search_path=pg_catalog,public,pg_temp');
  }
 });

 it('retains deferred commit guards for complete TP3 publication and workflow successors',async()=>{
  const rows=await owner.client<{name:string;deferred:boolean;initially_deferred:boolean;enabled:boolean}[]>`
   select tgname as name,tgdeferrable as deferred,tginitdeferred as initially_deferred,tgenabled<>'D' as enabled
   from pg_trigger where (tgrelid='public.employee_tp3_draft'::regclass and tgname='employee_tp3_complete_submission')
    or (tgrelid='public.attendance_workflow_template'::regclass and tgname='attendance_workflow_version_has_successor')
   order by tgname`;
  expect(rows).toHaveLength(2);
  for(const row of rows)expect(row).toMatchObject({deferred:true,initially_deferred:true,enabled:true});
 });

 it('actually applies each of the three migration files instead of silently skipping a lower watermark',async()=>{
  const files=['0591_my_tp3_private_drafts.sql','0592_attendance_workflow_v4.sql','0593_my_ea_source_eligibility.sql'];
  const rows=await owner.client<{hash:string}[]>`select hash from drizzle.__drizzle_migrations order by created_at,id`;
  for(const file of files){
   const hash=createHash('sha256').update(readFileSync(new URL(`../db/migrations/${file}`,import.meta.url))).digest('hex');
   expect(rows.filter(row=>row.hash===hash),file).toHaveLength(1);
  }
 });
});
