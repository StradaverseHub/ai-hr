/** Requires the accepted Auth543 SOURCE+JOURNAL union and parent-owned0552 journal entry.
 * Real canonical programmatic enrollment is fictional fixture evidence, not human MFA/broker/SMTP
 * acceptance. No fake Auth schema/definer, ciphertext or active SMTP state is installed here.
 */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {generate} from 'otplib';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {client,withTenant,type SessionContext} from '../db/client';
import {bootstrapInternalOwner} from '../lib/internal-auth/bootstrap';
import {changeInitialPassword,credentialByLogin,startLogin,verifyMfa,assertActiveCredential,type Credential} from '../lib/internal-auth/service';
import {readRecord,type AuthSql} from '../lib/internal-auth/store';
import {hireEmployee} from '../core/org';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {saveEmployeeMasterReport,getEmployeeMasterReport,deleteEmployeeMasterReport} from '../core/employee-master-reports';
import {saveEmployeeMasterSchedule} from '../core/employee-master-schedules';
import {defaultMasterColumn} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {fingerprintReportBytes} from '../lib/employee-master-artifact';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE} from '../lib/email-attachment';
import * as schema from '../db/schema';

const raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:3});
const origin='https://report-broker.test',temporary='Synthetic private enrollment passphrase 771!',password='Different synthetic enrollment passphrase 883!';
const artifact=fingerprintReportBytes(Buffer.from('PK fictional generated workbook'),XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE);
type Job={id:string;token:string};
type Context={target:Record<string,postgres.JSONValue>;issuer:string;leaseUntil:string;bindings:{owner:{subject:string;userId:string;personId:string|null;createdAt:string};recipient:{subject:string;userId:string;personId:string|null;createdAt:string}}};
type Locked={status:'ready';context:Context}|{status:'busy'|'notEligible'|'unavailable'};
let b:Base,ctx:SessionContext,employee:Awaited<ReturnType<typeof hireEmployee>>,report:{id:string;version:number},scheduleId:string,subject:string;

beforeAll(async()=>{
 await migrateTestDb();
 const [prerequisite]=await raw`select to_regprocedure('app.internal_auth_read(text,boolean)') is not null auth,
  to_regprocedure('app.internal_auth_report_start(uuid,uuid,text,jsonb,jsonb)') is not null report`;
 expect(prerequisite,'Real Auth543 and parent-journalled0552 union is required; no test fallback migration exists.').toEqual({auth:true,report:true});
 expect(readFileSync(new URL('./harness.ts',import.meta.url),'utf8')).toContain("'app_internal_auth_record'");
});
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY','8'.repeat(64));
 employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional broker recipient',primaryEmail:'recipient@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,employee.personId,'hr_admin');
 const enrollment=await bootstrapInternalOwner(owner.client,{appUserId:userId,organization:'report-broker',username:'recipient',email:'recipient@example.test',password:temporary,installationOperator:false});subject=enrollment.subject;
 ctx={tenantId:b.tenantId,userId,personId:employee.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};
 await saveNotificationEmailPolicy(adminCtx(b),['employee_master_reports']);
 await saveNotificationEmailPreferences(ctx,employee.employmentId,['employee_master_reports'],'en',{issuer:`${origin}/auth/${b.tenantId}`,subject,email:'recipient@example.test',emailVerified:true});
 const field=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 report=await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Fictional internal schedule',description:'',sharedRoleIds:[],spec:{v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(field)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}}});
 scheduleId=(await saveEmployeeMasterSchedule(ctx,[b.companyId],{reportId:report.id,version:report.version,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId,employmentId:employee.employmentId}]})).id;
});
afterEach(()=>vi.unstubAllEnvs());afterAll(async()=>{await raw.end();await closeAll();});

async function queue():Promise<Job>{
 const due=new Date(Date.now()-1000),before=new Date(due.getTime()-1000);
 await owner.db.update(schema.notificationPref).set({updatedAt:before,reportConsentVerifiedAt:before}).where(and(eq(schema.notificationPref.tenantId,b.tenantId),eq(schema.notificationPref.category,'employee_master_reports')));
 await owner.db.update(schema.notificationEmailPolicy).set({updatedAt:before}).where(and(eq(schema.notificationEmailPolicy.tenantId,b.tenantId),eq(schema.notificationEmailPolicy.category,'employee_master_reports')));
 await owner.db.update(schema.customReportSchedule).set({nextRunAt:due}).where(eq(schema.customReportSchedule.id,scheduleId));
 expect((await raw`select identity_email.queue_report(${scheduleId}::uuid,${due.toISOString()}::timestamptz,${new Date(Date.now()+86400000).toISOString()}::timestamptz) added`)[0].added).toBe(1);
 const jobs=await raw`select * from identity_email.claim_reports(10)`;expect(jobs).toHaveLength(1);return {id:String(jobs[0].id),token:String(jobs[0].lease_token)};
}
async function context(db:AuthSql,job:Job):Promise<Context|null>{return (await db.unsafe('select app.internal_auth_report_context($1::uuid,$2::uuid,$3::text) value',[job.id,job.token,origin]))[0].value as Context|null;}
async function lock(db:AuthSql,job:Job):Promise<Locked>{return (await db.unsafe('select app.internal_auth_report_lock_context($1::uuid,$2::uuid,$3::text) value',[job.id,job.token,origin]))[0].value as Locked;}
async function start(db:AuthSql,job:Job,expected:Context,value:unknown=artifact):Promise<string>{
 // Explicit TEXT parameters avoid postgres.js inferring JSONB and double-encoding a JSON string.
 return String((await db.unsafe('select app.internal_auth_report_start($1::uuid,$2::uuid,$3::text,($4::text)::jsonb,($5::text)::jsonb) value',[job.id,job.token,origin,JSON.stringify(expected),JSON.stringify(value)]))[0].value);
}
async function bounded(tx:AuthSql){await tx.unsafe("set local statement_timeout='5s'");await tx.unsafe("set local lock_timeout='250ms'");}
function ready(value:Locked):Context {expect(value.status).toBe('ready');if(value.status!=='ready')throw new Error('Expected real locked context');return value.context;}
async function state(job:Job){return (await raw`select status,artifact_sha256,artifact_byte_length,artifact_content_type,lease_token from custom_report_occurrence where id=${job.id}::uuid`)[0];}
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function held(query:(tx:AuthSql)=>Promise<unknown>,run:()=>Promise<void>){
 const entered=gate(),release=gate();
 const holding=raw.begin(async tx=>{await bounded(tx);await query(tx);entered.resolve();await release.promise;});
 // Reject instead of waiting forever if the holder cannot obtain its fixture lock.
 await Promise.race([entered.promise,holding.then(()=>{throw new Error('Fixture lock ended before observation');})]);
 try{await run();}finally{release.resolve();await holding;}
}
async function appWriter(tx:AuthSql){
 await tx.unsafe('set local role ai_hr_app');
 await tx.unsafe("select set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.roles','hr_admin',true),set_config('app.grants',$3,true)",[b.tenantId,ctx.userId!,JSON.stringify(ctx.grants)]);
}
/** Recreate the ACTUAL pending0552 definitions under a non-super/non-BYPASS owner. Auth543
 * remains the real installed prerequisite; no substitute Auth definer or encryption is created. */
async function restrictedOwner(run:()=>Promise<void>){
 const role='report_internal_owner_'+randomUUID().replaceAll('-',''),quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
 const tables=['tenant','custom_report_occurrence','custom_report_schedule','custom_report','custom_report_run','app_user','person','employment','role_assignment','app_external_identity','notification_pref','notification_email_policy','app_internal_auth_record'];
 const functions=[
  'identity_email.report_artifact_valid(jsonb)','app.custom_report_artifact_guard()',
  'identity_email.internal_report_context(uuid,uuid,text)','app.internal_auth_report_context(uuid,uuid,text)',
  'app.employee_master_internal_render_context(uuid,uuid,text)','app.internal_auth_report_lock_context(uuid,uuid,text)',
  'identity_email.start_report_bound(uuid,uuid,text,jsonb,jsonb)','identity_email.start_report(uuid,uuid,text,jsonb)',
  'app.internal_auth_report_start(uuid,uuid,text,jsonb,jsonb)',
 ];
 const tableOwners=await raw`select c.relname,r.rolname as owner from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='public'::regnamespace and c.relname=any(${tables}::text[])`;
 expect(tableOwners).toHaveLength(tables.length);
 const functionOwners:Record<string,string>={};for(const signature of functions)functionOwners[signature]=String((await raw`select pg_get_userbyid(p.proowner) owner from pg_proc p where p.oid=${signature}::regprocedure`)[0].owner);
 const migration=readFileSync(new URL('../db/migrations/0552_employee_master_internal_delivery.sql',import.meta.url),'utf8'),parts=migration.split('--> statement-breakpoint');
 await raw.unsafe(`create role ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
 try{
  await raw.unsafe(`grant usage,create on schema public,app,identity_email to ${quote(role)}`);
  await raw.unsafe(`grant select on all tables in schema public to ${quote(role)}`);
  await raw.unsafe(`grant execute on all functions in schema app,identity_email to ${quote(role)}`);
  for(const table of tables)await raw.unsafe(`alter table public.${quote(table)} owner to ${quote(role)}`);
  for(const signature of functions)await raw.unsafe(`alter function ${signature} owner to ${quote(role)}`);
  await raw.begin(async tx=>{
   await tx.unsafe(`set local role ${quote(role)}`);
   for(const signature of functions){const name=signature.slice(0,signature.indexOf('(')),part=parts.find(part=>part.includes('CREATE FUNCTION '+name+'(')||part.includes('CREATE OR REPLACE FUNCTION '+name+'('));expect(part,signature).toBeDefined();await tx.unsafe(part!.replace(/^CREATE FUNCTION /m,'CREATE OR REPLACE FUNCTION '));}
  });
  expect((await raw`select rolsuper,rolbypassrls,pg_has_role('ai_hr_app',oid,'USAGE') member,has_parameter_privilege(oid,'app.tenant_id','SET') custom_set from pg_roles where rolname=${role}`)[0]).toEqual({rolsuper:false,rolbypassrls:false,member:false,custom_set:false});
  await run();
 }finally{
  for(const signature of functions)await raw.unsafe(`alter function ${signature} owner to ${quote(functionOwners[signature])}`);
  for(const row of tableOwners)await raw.unsafe(`alter table public.${quote(String(row.relname))} owner to ${quote(String(row.owner))}`);
  await raw.unsafe(`drop owned by ${quote(role)}`);await raw.unsafe(`drop role ${quote(role)}`);
 }
}

describe('actual app-role nonce context and atomic artifact start',()=>{
 it('executes the actual pending DDL and start under a restricted owner without custom-SET grants',async()=>{
  const job=await queue();await restrictedOwner(async()=>{
   await client.begin(async tx=>{await bounded(tx);const expected=ready(await lock(tx,job));expect(await start(tx,job,expected)).toBe('started');});
   expect(await state(job)).toMatchObject({status:'started',artifact_sha256:artifact.sha256});
   expect((await raw`select has_function_privilege('ai_hr_app','identity_email.start_report_bound(uuid,uuid,text,jsonb,jsonb)','EXECUTE') common,
    has_function_privilege('ai_hr_app','identity_email.internal_report_context(uuid,uuid,text)','EXECUTE') private`)[0]).toEqual({common:false,private:false});
  });
 });
 it('resolves exact tenant-derived bindings and strips address/subject from the renderer context',async()=>{
  const job=await queue(),value=await context(client,job);expect(value).not.toBeNull();
  expect(value).toMatchObject({issuer:`${origin}/auth/${b.tenantId}`,bindings:{owner:{subject,userId:ctx.userId,personId:employee.personId},recipient:{subject,userId:ctx.userId,personId:employee.personId}}});
  expect(value!.leaseUntil).toMatch(/\.\d{6}Z$/);expect(value!.target.consentUpdatedAt).toMatch(/\.\d{6}Z$/);
  const [renderer]=await client`select app.employee_master_internal_render_context(${job.id}::uuid,${job.token}::uuid,${origin}) value`;
  expect(renderer.value).toMatchObject({tenantId:b.tenantId,recipientEmploymentId:employee.employmentId});expect(renderer.value).not.toHaveProperty('email');expect(renderer.value).not.toHaveProperty('subject');expect(renderer.value).not.toHaveProperty('bindings');
  expect(await context(client,{...job,token:randomUUID()})).toBeNull();
  expect((await client`select app.internal_auth_report_context(${job.id}::uuid,${job.token}::uuid,'https://other.test') value`)[0].value).toBeNull();
 });
 it('keeps separate owner and recipient users/subjects/Persons instead of collapsing to the receiving identity',async()=>{
  const ownerCtx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const ownerEnrollment=await bootstrapInternalOwner(owner.client,{appUserId:b.adminUserId,organization:'report-broker',username:'owner',email:'owner@example.test',password:temporary,installationOperator:false});
  const original=await getEmployeeMasterReport(ctx,[b.companyId],report.id);
  report=await saveEmployeeMasterReport(ownerCtx,[b.companyId],{name:'Separate fictional owner',description:'',sharedRoleIds:['hr_admin'],spec:original.spec});
  scheduleId=(await saveEmployeeMasterSchedule(ownerCtx,[b.companyId],{reportId:report.id,version:report.version,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId:ctx.userId!,employmentId:employee.employmentId}]})).id;
  const job=await queue(),value=await context(client,job),[ownerUser]=await raw`select person_id from app_user where id=${b.adminUserId}::uuid`;
  expect(value).toMatchObject({bindings:{owner:{userId:b.adminUserId,subject:ownerEnrollment.subject,personId:ownerUser.person_id},recipient:{userId:ctx.userId,subject,personId:employee.personId}}});
  await client.begin(async tx=>{await bounded(tx);expect(ready(await lock(tx,job)).bindings.owner.subject).not.toBe(subject);});
 });
 it('pins exactly one complete fingerprint under app-role SQL and retains it after a failed started generation',async()=>{
  const job=await queue();
  await client.begin(async tx=>{await bounded(tx);const expected=ready(await lock(tx,job));expect(await start(tx,job,expected)).toBe('started');});
  expect(await state(job)).toMatchObject({status:'started',artifact_sha256:artifact.sha256,artifact_byte_length:artifact.byteLength,artifact_content_type:artifact.contentType});
  const old=await context(client,job);expect(old).toBeNull();
  expect((await raw`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'failed','generationFailed') value`)[0].value).toBe(true);
  expect(await state(job)).toMatchObject({status:'failed',artifact_sha256:artifact.sha256,lease_token:null});
  expect(await raw`select * from identity_email.claim_reports(10)`).toEqual([]);
 });
 it('retains the old private boolean start with NULL artifact and no second-start/reclaim path',async()=>{
  const job=await queue(),value=(await context(client,job))!;
  expect((await raw`select identity_email.start_report(${job.id}::uuid,${job.token}::uuid,${value.issuer},${raw.json(value.target)}::jsonb) value`)[0].value).toBe(true);
  expect(await state(job)).toMatchObject({status:'started',artifact_sha256:null,artifact_byte_length:null,artifact_content_type:null});
  expect((await raw`select identity_email.start_report(${job.id}::uuid,${job.token}::uuid,${value.issuer},${raw.json(value.target)}::jsonb) value`)[0].value).toBe(false);
  await raw`update custom_report_occurrence set lease_until=now()-interval '1 second' where id=${job.id}::uuid`;
  expect(await raw`select * from identity_email.claim_reports(10)`).toEqual([]);expect((await state(job)).status).toBe('uncertain');
 });
 it.each([{sha256:'A'.repeat(64)}, {byteLength:0}, {byteLength:20000001}, {byteLength:1.5}, {contentType:'application/zip'}, {path:'/tmp/foreign'}, {sha256:null}])('refuses invalid/partial/extra artifact without consuming start: %j',async patch=>{
  const job=await queue(),expected=(await context(client,job))!;
  await client.begin(async tx=>{await bounded(tx);expect(await start(tx,job,expected,{...artifact,...patch})).toBe('notEligible');});
  expect(await state(job)).toMatchObject({status:'pending',artifact_sha256:null,artifact_byte_length:null,artifact_content_type:null});
 });
 it('protects pinning with the actual trigger even for a table owner, rather than passing only because app lacks UPDATE',async()=>{
  const job=await queue();
  await expect(raw`update custom_report_occurrence set artifact_sha256=${artifact.sha256},artifact_byte_length=${artifact.byteLength},artifact_content_type=${artifact.contentType} where id=${job.id}::uuid`).rejects.toThrow(/only|immutable/);
  await client.begin(async tx=>{await bounded(tx);expect(await start(tx,job,ready(await lock(tx,job)))).toBe('started');});
  for(const change of ["artifact_sha256=repeat('b',64)",'artifact_sha256=null,artifact_byte_length=null,artifact_content_type=null'])await expect(raw.unsafe(`update custom_report_occurrence set ${change} where id=$1::uuid`,[job.id])).rejects.toThrow(/immutable/);
  await deleteEmployeeMasterReport(ctx,report.id);
  expect((await raw`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'uncertain','uncertain') value`)[0].value).toBe(true);
  expect(await state(job)).toMatchObject({status:'uncertain',artifact_sha256:artifact.sha256});
 });
 it('does not expose the nonce in app audit reads or permit direct artifact mutation',async()=>{
  const job=await queue();
  const [privileges]=await client`select has_table_privilege(current_user,'public.custom_report_occurrence','INSERT') as can_insert,
   has_table_privilege(current_user,'public.custom_report_occurrence','UPDATE') as can_update,
   has_table_privilege(current_user,'public.custom_report_occurrence','DELETE') as can_delete,
   has_table_privilege(current_user,'public.custom_report_occurrence','TRUNCATE') as can_truncate,
   has_column_privilege(current_user,'public.custom_report_occurrence','artifact_sha256','UPDATE') as can_update_artifact`;
  expect(privileges).toEqual({can_insert:false,can_update:false,can_delete:false,can_truncate:false,can_update_artifact:false});
  expect(await withTenant(ctx,tx=>tx.select({id:schema.customReportOccurrence.id,hash:schema.customReportOccurrence.artifactSha256}).from(schema.customReportOccurrence))).toEqual([{id:job.id,hash:null}]);
  await expect(withTenant(ctx,tx=>tx.select({token:schema.customReportOccurrence.leaseToken}).from(schema.customReportOccurrence))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(client`update custom_report_occurrence set artifact_sha256=${artifact.sha256} where id=${job.id}::uuid`).rejects.toThrow(/permission denied/);
  await expect(withTenant(ctx,tx=>tx.execute(sql`update custom_report_occurrence set artifact_sha256=${artifact.sha256} where id=${job.id}::uuid`))).rejects.toMatchObject({cause:{code:'42501'}});
  expect(await state(job)).toMatchObject({status:'pending',artifact_sha256:null,artifact_byte_length:null,artifact_content_type:null});
  await expect(client`select * from app_internal_auth_record`).rejects.toThrow(/permission denied/);
 });
 it('gives a finish-only transport role no Auth/context/start/common/HR read authority',async()=>{
  const role='report_internal_transport_'+randomUUID().replaceAll('-','');
  await raw.unsafe(`create role "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
  try{
   await raw.unsafe(`grant usage on schema app,identity_email to "${role}"`);
   await raw.unsafe(`grant execute on function identity_email.finish_report(uuid,uuid,text,text,integer,uuid[]) to "${role}"`);
   for(const query of ['select * from public.person','select * from public.app_internal_auth_record',"select * from app.internal_auth_read('email-state',false)",'select app.internal_auth_report_context(null,null,null)','select app.internal_auth_report_start(null,null,null,null,null)','select identity_email.start_report(null,null,null,null)','select identity_email.start_report_bound(null,null,null,null,null)'])await expect(raw.begin(async tx=>{await tx.unsafe(`set local role "${role}"`);return tx.unsafe(query);})).rejects.toMatchObject({code:'42501'});
   const [privilege]=await raw`select has_function_privilege(${role},'identity_email.finish_report(uuid,uuid,text,text,integer,uuid[])','EXECUTE') finish`;expect(privilege.finish).toBe(true);
  }finally{await raw.unsafe(`drop owned by "${role}"`);await raw.unsafe(`drop role "${role}"`);}
 });
 it('reuses real active Credential validation on the same locked transaction without treating SQL context as MFA proof',async()=>{
  const initial=await startLogin({organization:'report-broker',username:'recipient',password:temporary,native:false});if(initial.step!=='password')throw new Error('Expected real initial password challenge');
  const setup=await changeInitialPassword(initial.challenge,password);if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected real enrollment challenge');
  expect((await verifyMfa(setup.challenge,await generate({secret:setup.secret}))).step).toBe('complete');
  const canonical=(await credentialByLogin('report-broker','recipient'))!,job=await queue();
  await client.begin(async tx=>{
   await bounded(tx);const expected=ready(await lock(tx,job)),credential=await readRecord<Credential>(tx,`credential:${expected.bindings.recipient.subject}`,true);
   expect(credential?.version).toBe(canonical.version);expect(await assertActiveCredential(tx,credential!)).toEqual({app_user_id:ctx.userId,tenant_id:b.tenantId});
   expect(await start(tx,job,expected)).toBe('started');
  });
 });
});

describe('bounded final checks and concurrent canonical writers',()=>{
 it.each(['repeatable read','serializable'])('explicitly refuses %s instead of relying on a stale pinned snapshot',async isolation=>{
  const job=await queue();await expect(client.begin(async tx=>{await tx.unsafe('set transaction isolation level '+isolation);return lock(tx,job);})).rejects.toMatchObject({code:'22023'});
  expect((await state(job)).status).toBe('pending');
 });
 it('keeps caller GUCs and lock_timeout unchanged on success, foreign nonce and bounded lock refusal',async()=>{
  const job=await queue();
  await client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${randomUUID()},true),set_config('app.user_id',${randomUUID()},true),set_config('app.roles','employee',true),set_config('app.grants','[]',true)`;
   await tx.unsafe("set local lock_timeout='900ms'");
   const snapshot=async()=> (await tx`select current_setting('app.tenant_id') tenant,current_setting('app.user_id') actor,current_setting('app.roles') roles,current_setting('app.grants') grants,current_setting('lock_timeout') timeout`)[0];
   const before=await snapshot();expect((await lock(tx,job)).status).toBe('ready');expect(await snapshot()).toEqual(before);
   expect((await lock(tx,{...job,token:randomUUID()})).status).toBe('notEligible');expect(await snapshot()).toEqual(before);
  });
  await held(tx=>tx.unsafe('select id from custom_report_schedule where id=$1::uuid for update',[scheduleId]),async()=>{
   await client.begin(async tx=>{await tx.unsafe("set local lock_timeout='900ms'");expect((await lock(tx,job)).status).toBe('busy');expect((await tx`select current_setting('lock_timeout') value`)[0].value).toBe('900ms');});
  });
 });
 it.each([
  ['occurrence','select id from custom_report_occurrence where id=$1::uuid for update'],
  ['report','select id from custom_report where id=$1::uuid for update'],
  ['schedule','select id from custom_report_schedule where id=$1::uuid for update'],
  ['login','select id from app_user where id=$1::uuid for update'],
  ['Person','select id from person where id=$1::uuid for update'],
  ['employment','select id from employment where id=$1::uuid for update'],
  ['binding','select app_user_id from app_external_identity where app_user_id=$1::uuid for update'],
  ['grant','select id from role_assignment where app_user_id=$1::uuid for update'],
  ['policy',"select id from notification_email_policy where tenant_id=$1::uuid and category='employee_master_reports' for update"],
  ['preference',"select id from notification_pref where recipient_employment_id=$1::uuid and category='employee_master_reports' for update"],
 ] as const)('returns busy for contended %s and releases the earlier occurrence lock',async(kind,statement)=>{
  const job=await queue(),id=kind==='occurrence'?job.id:kind==='report'?report.id:kind==='schedule'?scheduleId:kind==='Person'?employee.personId:kind==='employment'||kind==='preference'?employee.employmentId:kind==='policy'?b.tenantId:ctx.userId!;
  await held(tx=>tx.unsafe(statement,[id]),async()=>{
   await client.begin(async tx=>{await bounded(tx);expect((await lock(tx,job)).status).toBe('busy');
    // Different connection obtains the initial occurrence immediately: partial locks rolled back.
    if(kind!=='occurrence')await raw.begin(async probe=>{await probe`select id from custom_report_occurrence where id=${job.id}::uuid for update nowait`;});
   });
  });
  await client.begin(async tx=>{await bounded(tx);expect((await lock(tx,job)).status).toBe('ready');});
 });
 it.each(['subject','relay','policy','consent'] as const)('uses the canonical %s try-advisory and leaves no partial claim',async kind=>{
  const job=await queue(),key=kind==='subject'?`internal-auth:${subject}`:kind==='relay'?'internal-auth:email-state':kind==='policy'?`workflow-email-policy:${b.tenantId}`:`workflow-email-consent:${b.tenantId}:${employee.employmentId}`;
  await held(tx=>tx.unsafe('select pg_advisory_xact_lock(hashtextextended($1,0))',[key]),async()=>{
   await client.begin(async tx=>{await bounded(tx);expect((await lock(tx,job)).status).toBe('busy');await raw.begin(async probe=>{await probe`select id from custom_report_occurrence where id=${job.id}::uuid for update nowait`;});});
  });
  expect((await state(job)).status).toBe('pending');
 });
 it('locks the real credential row and refuses an active-record writer without exposing ciphertext',async()=>{
  const job=await queue();
  await held(tx=>tx.unsafe('select record_key from app_internal_auth_record where record_key=$1 for update',[`credential:${subject}`]),async()=>{
   await client.begin(async tx=>{await bounded(tx);const result=await lock(tx,job);expect(result).toEqual({status:'busy'});expect(JSON.stringify(result)).not.toContain('sealed');});
  });
 });
 it('prevents actual app-role user/contact/liveness/grant writes after obtaining the proof locks',async()=>{
  const job=await queue();
  await client.begin(async tx=>{
   await bounded(tx);ready(await lock(tx,job));
   const statements:[string,unknown[]][]=[
    ['update app_user set archived_at=now() where id=$1::uuid',[ctx.userId]],
    ['update person set primary_email=$2 where id=$1::uuid',[employee.personId,'changed@example.test']],
    ['update employment set blacklisted_at=now() where id=$1::uuid',[employee.employmentId]],
    ['delete from role_assignment where app_user_id=$1::uuid',[ctx.userId]],
    ["update notification_pref set enabled=false where recipient_employment_id=$1::uuid and category='employee_master_reports'",[employee.employmentId]],
   ];
   for(const [statement,args]of statements)await expect(raw.begin(async writer=>{await appWriter(writer);await writer.unsafe("set local lock_timeout='50ms'");await writer.unsafe(statement,args as string[]);})).rejects.toMatchObject({code:'55P03'});
  });
  expect(await context(client,job)).not.toBeNull();
 });
 it('blocks FK-backed new actor grants and a real canonical hire for that Person',async()=>{
  const job=await queue();
  await client.begin(async tx=>{
   await bounded(tx);ready(await lock(tx,job));
   await expect(raw.begin(async writer=>{await appWriter(writer);await writer.unsafe("set local lock_timeout='50ms'");await writer.unsafe("insert into role_assignment(tenant_id,app_user_id,role,company_id) values($1::uuid,$2::uuid,'employee',null)",[b.tenantId,ctx.userId!]);})).rejects.toMatchObject({code:'55P03'});
   await expect(withTenant(ctx,async writer=>{await writer.execute(sql`set local lock_timeout='50ms'`);return hireEmployee(ctx,{person:{id:employee.personId},companyId:b.companyId,departmentId:b.deptA,employmentType:'part_time',hiredOn:todayInKualaLumpur()},writer);})).rejects.toMatchObject({cause:{code:'55P03'}});
  });
 });
 it('accepts the complete1000-grant set but refuses1001 instead of truncating principal authority',async()=>{
  const userId=ctx.userId;if(!userId)throw new Error('Fixture login is required.');
  await raw`insert into role_assignment(tenant_id,app_user_id,role,company_id) select ${b.tenantId}::uuid,${userId}::uuid,'employee'::public.role,null from generate_series(1,999)`;
  const job=await queue();await client.begin(async tx=>{await bounded(tx);expect(ready(await lock(tx,job)).target.ownerGrants).toHaveLength(1000);});
  await raw`insert into role_assignment(tenant_id,app_user_id,role,company_id) values(${b.tenantId}::uuid,${userId}::uuid,'employee',null)`;
  expect(await context(client,job)).toBeNull();await client.begin(async tx=>{await bounded(tx);expect((await lock(tx,job)).status).toBe('notEligible');});
  expect((await state(job)).status).toBe('pending');
 });
 it.each(['withdrawal','contact','binding','archive','permission','schedule','expiry'] as const)('refuses a previously inspected target after %s changes',async kind=>{
  const job=await queue(),expected=(await context(client,job))!;
  if(kind==='withdrawal')await saveNotificationEmailPreferences(ctx,employee.employmentId,[],'en',null);
  if(kind==='contact'){
   await owner.db.update(schema.person).set({primaryEmail:'changed@example.test'}).where(eq(schema.person.id,employee.personId));
   await owner.db.update(schema.person).set({primaryEmail:'recipient@example.test'}).where(eq(schema.person.id,employee.personId));
  }
  if(kind==='binding')await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()}).where(eq(schema.appExternalIdentity.subject,subject));
  if(kind==='archive')await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,ctx.userId!));
  if(kind==='permission')await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'report.read.personnel',role:'hr_admin',allowed:false});
  if(kind==='schedule')await owner.db.update(schema.customReportSchedule).set({enabled:false}).where(eq(schema.customReportSchedule.id,scheduleId));
  if(kind==='expiry')await owner.db.update(schema.customReportOccurrence).set({leaseUntil:new Date(Date.now()-1000)}).where(eq(schema.customReportOccurrence.id,job.id));
  await client.begin(async tx=>{await bounded(tx);expect(await start(tx,job,expected)).toBe('notEligible');});expect((await state(job)).status).toBe('pending');
 });
 it('does not revive an old occurrence when the canonical opt-in is withdrawn then freshly granted again',async()=>{
  const job=await queue(),expected=(await context(client,job))!;
  await saveNotificationEmailPreferences(ctx,employee.employmentId,[],'en',null);
  await saveNotificationEmailPreferences(ctx,employee.employmentId,['employee_master_reports'],'en',{issuer:expected.issuer,subject,email:'recipient@example.test',emailVerified:true});
  expect(await context(client,job)).toBeNull();
  await client.begin(async tx=>{await bounded(tx);expect(await start(tx,job,expected)).toBe('notEligible');});
  expect((await state(job)).status).toBe('pending');
 });
});
