/** Real RLS writes and native queue transactions against the normally migrated point-read policy. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {commitEmployeeImport} from '../core/import';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand,getBankImportJob} from '../core/bank-import-job';
import {processBankImportJob} from '../core/bank-import-worker';
import {parseCsvRecords} from '../lib/csv';
import {pgErrorChain,pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

const HINT='app.bank_import_point_read';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const policyRows=async()=>[...await owner.client`select policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='employment' order by policyname`];
const functionRow=async()=>[...await owner.client`select pg_get_functiondef(p.oid) as definition,p.proowner,p.proacl,p.proconfig from pg_proc p where p.oid='app.visible_employment_ids()'::regprocedure`];
let b:Base,ctx:SessionContext,target:{id:string;personId:string},baseline:Awaited<ReturnType<typeof policyRows>>=[],definition:Awaited<ReturnType<typeof functionRow>>=[];
let poolTouched=false;

// Reserve the entire private test-process pool, rather than querying an arbitrary
// connection and pretending that it proves the writer connection was restored.
async function allAppConnections<T>(work:(connection:Awaited<ReturnType<typeof client.reserve>>)=>Promise<T>){
 const connections:Awaited<ReturnType<typeof client.reserve>>[]=[];
 try{
  expect(client.options.max).toBe(10);
  for(let i=0;i<client.options.max;i++)connections.push(await client.reserve());
  return await Promise.all(connections.map(work));
 }finally{for(const connection of connections)await connection.release();}
}
const poolHint=(value:string)=>allAppConnections(connection=>connection`select set_config(${HINT},${value},false)`);
async function sameBackendRestored(pid:number){
 let found=false;
 await allAppConnections(async connection=>{
  const [row]=await connection`select pg_backend_pid() as pid,current_setting(${HINT},true) as hint,current_user as role`;
  if(row.pid!==pid)return;
  found=true;expect(row).toMatchObject({pid,hint:'off',role:'ai_hr_app'});
  await connection.unsafe('BEGIN');
  try{
   await connection`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true)`;
   expect((await connection`select id from employment where id=${target.id}::uuid`).map(row=>row.id)).toEqual([target.id]);
   const [after]=await connection`select current_setting(${HINT},true) as hint`;expect(after.hint).toBe('off');
  }finally{await connection.unsafe('ROLLBACK');}
 });
 expect(found,'The exact native writer backend must be checked after its transaction').toBe(true);
}
async function nativeJob(value:string){
 const bytes=Buffer.from(`employee_code,tax_number\nPOINT001,${value}`);
 const id=(await createBankImportJob(ctx,{name:'point-read.csv',bytes:bytes.length,hash:digest(bytes.toString())})).job.id;
 await uploadBankImportChunk(ctx,id,0,bytes);await bankImportCommand(ctx,id,'validate');
 for(let i=0;i<4;i++)await processBankImportJob(ctx,id);
 expect((await getBankImportJob(ctx,id)).job).toMatchObject({state:'ready',valid:1});
 await bankImportCommand(ctx,id,'confirm');await processBankImportJob(ctx,id);return id;
}
async function watchNativeWriter(){
 await owner.client.unsafe(`CREATE SCHEMA ci_bank_point_read;
 CREATE TABLE ci_bank_point_read.witness(pid int NOT NULL,hint text NOT NULL,role_name text NOT NULL,superuser boolean NOT NULL,bypass boolean NOT NULL);
 CREATE SEQUENCE ci_bank_point_read.failed_backend;
 CREATE FUNCTION ci_bank_point_read.watch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
 DECLARE marker text; actor name; s boolean; b boolean;
 BEGIN
  IF NEW.tax_number LIKE 'TPOINT%' AND NEW.tax_number IS DISTINCT FROM OLD.tax_number THEN
   marker:=current_setting('app.bank_import_point_read',true);
   actor:=CASE WHEN current_setting('role')='none' THEN session_user ELSE current_setting('role') END;
   SELECT rolsuper,rolbypassrls INTO s,b FROM pg_roles WHERE rolname=actor;
   IF marker IS DISTINCT FROM 'on' OR actor<>'ai_hr_app' OR s IS DISTINCT FROM false OR b IS DISTINCT FROM false THEN RAISE EXCEPTION 'Canonical writer lacks scoped marker or app role'; END IF;
   IF NEW.tax_number='TPOINTFAIL' THEN
    PERFORM setval('ci_bank_point_read.failed_backend',pg_backend_pid(),true);
    RAISE EXCEPTION 'Intentional native write rollback';
   END IF;
   INSERT INTO ci_bank_point_read.witness VALUES(pg_backend_pid(),marker,actor,s,b);
  END IF;
  RETURN NEW;
 END $body$;
 REVOKE ALL ON FUNCTION ci_bank_point_read.watch() FROM PUBLIC;
 CREATE TRIGGER ci_bank_point_read_watch BEFORE UPDATE ON employee_statutory_my FOR EACH ROW EXECUTE FUNCTION ci_bank_point_read.watch()`).simple();
}

describe('Bank point-read hint remains an optimization with current write permissions',()=>{
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  baseline=[];definition=[];poolTouched=false;
  await resetDb();b=await seedBase();ctx=adminCtx(b);baseline=await policyRows();definition=await functionRow();
  expect(baseline.find(row=>row.policyname==='employment_rls')?.qual,'The ordinary migrator must install the real point-read policy').toContain(HINT);
  const records=parseCsvRecords('full_name,email,department,hired_on,ic_number,basic_salary,employee_code\nPoint Subject,point@example.test,Finance,2026-01-05,900101105555,5000,POINT001\nPoint Employee,point-employee@example.test,Finance,2026-01-05,900101105556,5000,POINT002').records;
  expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records})).imported).toBe(2);
  [target]=await owner.db.select({id:schema.employment.id,personId:schema.employment.personId}).from(schema.employment).where(eq(schema.employment.employeeCode,'POINT001'));
  poolTouched=true;await poolHint('off');
 });
 afterEach(async()=>{
  try{
   if(baseline.length){
    await owner.client.unsafe('DROP SCHEMA IF EXISTS ci_bank_point_read CASCADE');
    expect(await policyRows()).toEqual(baseline);expect(await functionRow()).toEqual(definition);
   }
  }finally{if(poolTouched)await poolHint('');}
 });
 afterAll(closeAll);
 it('preserves denied writes, explicit WITH CHECK and void/foreign fences even for forged hints',async()=>{
  const [own]=await owner.db.select().from(schema.employment).where(eq(schema.employment.employeeCode,'POINT002'));
  const employeeId=await createAppUser(b.tenantId,own.personId,'employee');
  const employee:SessionContext={...ctx,userId:employeeId,personId:own.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const foreign=adminCtx(await seedBase());
  const [partnerPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Point Partner',primaryEmail:'point-partner@example.test'}).returning();
  const partnerId=await createAppUser(b.tenantId,partnerPerson.id,'employee');
  const [unrelated]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Unrelated Point Company'}).returning();
  await owner.db.update(schema.roleAssignment).set({role:'payroll_partner',companyId:unrelated.id}).where(eq(schema.roleAssignment.appUserId,partnerId));
  const partner:SessionContext={...ctx,userId:partnerId,personId:partnerPerson.id,roles:['payroll_partner'],grants:[{role:'payroll_partner',companyId:unrelated.id}]};
  const [voidPerson]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Voided Point Subject',primaryEmail:'point-void@example.test'}).returning();
  let voidId='';
  await owner.client.begin(async tx=>{await tx`set local session_replication_role='replica'`;const [row]=await tx`insert into employment(tenant_id,person_id,company_id,hired_on,voided_at,voided_by,void_reason,voided_import_attempt_id) values(${b.tenantId}::uuid,${voidPerson.id}::uuid,${b.companyId}::uuid,'2026-01-05',now(),${b.adminUserId}::uuid,'Fictional point-read void',${randomUUID()}::uuid) returning id`;voidId=row.id;});
  const baselineRows=await owner.client`select to_jsonb(e) as value from employment e order by id`;
   for(const hint of [null,'off','on','garbage']){
    const scoped=<T>(actor:SessionContext,work:(tx:Tx)=>Promise<T>)=>withTenant(actor,async tx=>{if(hint!==null)await tx.execute(sql`select set_config(${HINT},${hint},true)`);return work(tx);});
    for(const actor of [employee,partner,foreign])expect(await scoped(actor,tx=>tx.update(schema.employment).set({employeeCode:'POINT-FORBIDDEN'}).where(eq(schema.employment.id,target.id)).returning({id:schema.employment.id}))).toEqual([]);
    expect(await scoped(ctx,tx=>tx.update(schema.employment).set({employeeCode:'POINT-FORBIDDEN'}).where(eq(schema.employment.id,voidId)).returning({id:schema.employment.id}))).toEqual([]);
    expect(await scoped(employee,tx=>tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,own.id)))).toEqual([{id:own.id}]);
    // No changed business field: a BEFORE trigger refusing a protected edit must
    // not masquerade as proof that the explicit RLS WITH CHECK still applies.
    const error=await scoped(employee,tx=>tx.update(schema.employment).set({tenantId:b.tenantId}).where(eq(schema.employment.id,own.id))).then(()=>null,error=>error);
    expect(pgSqlState(error),'Self visibility must not defeat the explicit administrator WITH CHECK').toBe('42501');
    expect(pgErrorChain(error).some(link=>link.message?.includes('row-level security policy')),'The refusal must come from RLS WITH CHECK itself').toBe(true);
    expect(await scoped(ctx,tx=>tx.update(schema.employment).set({employeeCode:'POINT001'}).where(eq(schema.employment.id,target.id)).returning({id:schema.employment.id}))).toEqual([{id:target.id}]);
   }
  expect(await owner.client`select to_jsonb(e) as value from employment e order by id`).toEqual(baselineRows);
 });

 it('runs the canonical native writer with the marker and restores the SAME backend after commit',async()=>{
  const id=await nativeJob('TPOINTCOMMIT');await watchNativeWriter();
  await processBankImportJob(ctx,id);
  const {job}=await getBankImportJob(ctx,id);expect(job).toMatchObject({state:'completed',processed:1,saved:1,failed:0});
  const witnesses=await owner.client`select * from ci_bank_point_read.witness`;expect(witnesses.length).toBeGreaterThan(0);
  for(const row of witnesses){expect(row).toMatchObject({hint:'on',role_name:'ai_hr_app',superuser:false,bypass:false});await sameBackendRestored(row.pid);}
  expect((await owner.client`select tax_number from employee_statutory_my where person_id=${target.personId}::uuid`)[0].tax_number).toBe('TPOINTCOMMIT');
  expect((await owner.client`select count(*)::int as rows from import_attempt_item where attempt_id=${job.attemptId}::uuid and ordinal=1 and status='applied'`)[0].rows).toBe(1);
 });

 it('rolls back the native mutation and restores the SAME backend before recording a failed row',async()=>{
  const id=await nativeJob('TPOINTFAIL');
  const [before]=await owner.client`select to_jsonb(s) as value from employee_statutory_my s where person_id=${target.personId}::uuid`;
  await watchNativeWriter();await processBankImportJob(ctx,id);
  const {job}=await getBankImportJob(ctx,id);expect(job).toMatchObject({state:'completed',processed:1,saved:0,failed:1});
  const [observed]=await owner.client`select last_value::int as pid,is_called from ci_bank_point_read.failed_backend`;expect(observed.is_called).toBe(true);expect(observed.pid).toBeGreaterThan(1);
  // A sequence survives rollback; only the trigger branch that first proved the
  // actual native app role and marker can publish this exact backend identity.
  await sameBackendRestored(observed.pid);
  expect((await owner.client`select to_jsonb(s) as value from employee_statutory_my s where person_id=${target.personId}::uuid`)[0]).toEqual(before);
  expect((await owner.client`select count(*)::int as rows from import_attempt_item where attempt_id=${job.attemptId}::uuid`)[0].rows).toBe(0);
 });
});
