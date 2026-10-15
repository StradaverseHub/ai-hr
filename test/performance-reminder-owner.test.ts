/** Production migrations use a restricted owner; postgres-owned trigger tests hid this failure. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import {completeEmployeeDraft,getEmployeeDraft,saveEmployeeDraft} from '../core/employee-draft';
import {todayInKualaLumpur} from '../lib/hr-date';
import * as s from '../db/schema';

let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function restrictedDefiner(run:()=>Promise<void>){
 const role='epoch_owner_'+randomUUID().replaceAll('-','');
 const [initial]=await owner.client`select pg_get_userbyid(c.relowner) as table_owner,pg_get_userbyid(p.proowner) as function_owner from pg_class c cross join pg_proc p where c.oid='performance_assessment_reminder_epoch'::regclass and p.oid='app.assessment_reminder_touch()'::regprocedure`;
 for(const name of [initial.table_owner,initial.function_owner])if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))throw Error('Unexpected fixture owner identifier');
 await owner.client.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
 try{
  await owner.client.unsafe(`GRANT USAGE,CREATE ON SCHEMA public,app TO "${role}"`);
  await owner.client.unsafe(`ALTER TABLE performance_assessment_reminder_epoch OWNER TO "${role}"`);
  await owner.client.unsafe(`ALTER FUNCTION app.assessment_reminder_touch() OWNER TO "${role}"`);
  const [flags]=await owner.client`select r.rolsuper,r.rolbypassrls,p.prosecdef from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='app.assessment_reminder_touch()'::regprocedure`;
  expect(flags).toEqual({rolsuper:false,rolbypassrls:false,prosecdef:true});
  const [membership]=await owner.client`select pg_has_role('ai_hr_app',${role},'USAGE') as inherited`;
  expect(membership.inherited).toBe(false);
  await run();
 }finally{
  await owner.client.unsafe(`ALTER FUNCTION app.assessment_reminder_touch() OWNER TO "${initial.function_owner}"`);
  await owner.client.unsafe(`ALTER TABLE performance_assessment_reminder_epoch OWNER TO "${initial.table_owner}"`);
  await owner.client.unsafe(`DROP OWNED BY "${role}"`);await owner.client.unsafe(`DROP ROLE "${role}"`);
 }
}
describe('Performance invalidation under the production owner privilege model',()=>{
 it('activates a saved employee draft and advances its canonical tenant epoch under a non-bypass definer',async()=>{
  const ctx=adminCtx(b),code='EPOCH'+randomUUID().slice(0,8).toUpperCase();
  const {id}=await saveEmployeeDraft(ctx,{currentStep:1,data:{profile:{fullName:'Owner regression employee',employeeCode:code,primaryEmail:'epoch-'+randomUUID()+'@fixture.test'},employment:{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()},payroll:{basicSalary:'5200'}}});
  const zero='00000000-0000-0000-0000-000000000000';
  const scope=and(eq(s.assessmentReminderEpoch.tenantId,b.tenantId),eq(s.assessmentReminderEpoch.scopeId,zero));
  const [before]=await owner.db.select().from(s.assessmentReminderEpoch).where(scope).orderBy(s.assessmentReminderEpoch.scopeId);
  await restrictedDefiner(async()=>{
   const {employmentId}=await completeEmployeeDraft(ctx,id);
   const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employmentId));
   expect(employee).toMatchObject({tenantId:b.tenantId,companyId:b.companyId,employeeCode:code});
   expect(await getEmployeeDraft(ctx,id)).toBeNull();
   const rows=await owner.db.select().from(s.assessmentReminderEpoch).where(scope).orderBy(s.assessmentReminderEpoch.scopeId);
   expect(rows).toHaveLength(1);expect(rows[0].scopeId).toBe(zero);expect(rows[0].revision).toBeGreaterThan(before.revision);
  });
 });
 it('removes inherited bootstrap write grants while retaining scoped app reads and owner-only invalidation',async()=>{
  const foreign=await seedBase(),ctx=adminCtx(b);
  // The production bootstrap grants CRUD by default. Rehearse the exact repair against that state.
  await owner.client.unsafe('GRANT ALL ON performance_assessment_reminder_epoch TO ai_hr_app,PUBLIC');
  const repair=readFileSync(new URL('../db/migrations/0542_account_email_failures.sql',import.meta.url),'utf8').split('-- Restricted migration-owner reminder invalidation')[1];
  expect(repair).toBeTruthy();await owner.client.unsafe('-- Restricted migration-owner reminder invalidation'+repair);
  await restrictedDefiner(async()=>{
   const [flags]=await owner.client`select c.relrowsecurity,has_table_privilege('ai_hr_app',c.oid,'INSERT') as ins,has_table_privilege('ai_hr_app',c.oid,'UPDATE') as upd,has_table_privilege('ai_hr_app',c.oid,'DELETE') as del,has_table_privilege('ai_hr_app',c.oid,'TRUNCATE') as trunc,exists(select 1 from aclexplode(c.relacl) a where a.grantee=0) as public_grant,has_function_privilege('ai_hr_app','app.assessment_reminder_touch()','EXECUTE') as direct_touch from pg_class c where c.oid='performance_assessment_reminder_epoch'::regclass`;
   expect(flags).toEqual({relrowsecurity:true,ins:false,upd:false,del:false,trunc:false,public_grant:false,direct_touch:false});
   const own=await withTenant(ctx,tx=>tx.select().from(s.assessmentReminderEpoch).orderBy(s.assessmentReminderEpoch.tenantId,s.assessmentReminderEpoch.scopeId));
   expect(own.length).toBeGreaterThan(0);expect(own.every(row=>row.tenantId===b.tenantId)).toBe(true);expect(own.some(row=>row.tenantId===foreign.tenantId)).toBe(false);
   expect(await withTenant({...ctx,userId:null,personId:null,roles:[]},tx=>tx.select().from(s.assessmentReminderEpoch).orderBy(s.assessmentReminderEpoch.scopeId))).toEqual([]);
   await expect(withTenant(ctx,tx=>tx.insert(s.assessmentReminderEpoch).values({tenantId:b.tenantId,scopeId:randomUUID()}))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
   await expect(withTenant(ctx,tx=>tx.update(s.assessmentReminderEpoch).set({revision:999}))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
   await expect(withTenant(ctx,tx=>tx.delete(s.assessmentReminderEpoch))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
   await expect(withTenant(ctx,tx=>tx.execute(sql`TRUNCATE performance_assessment_reminder_epoch`))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
  });
 });
});
