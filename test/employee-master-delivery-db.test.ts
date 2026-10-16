import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {saveEmployeeMasterReport,deleteEmployeeMasterReport} from '../core/employee-master-reports';
import {saveEmployeeMasterSchedule} from '../core/employee-master-schedules';
import {sweepEmployeeMasterReports} from '../core/employee-master-delivery';
import {sweepSkipReason} from '../core/sweep-scope';
import {masterReportDatabaseGrants} from '../deploy/identity-email/database';
import {defaultMasterColumn} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import * as schema from '../db/schema';
const raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:2}),issuer='https://hr.test/identity/realms/ai-hr';
let b:Base,ctx:SessionContext,e:Awaited<ReturnType<typeof hireEmployee>>,report:{id:string;version:number},scheduleId:string;
beforeAll(migrateTestDb);afterAll(async()=>{await raw.end();await closeAll();});
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');const admin={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 e=await hireEmployee(admin,{person:{fullName:'Synthetic managed recipient',primaryEmail:'fixture@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,e.personId,'hr_admin'),subject=randomUUID();await owner.db.insert(schema.appExternalIdentity).values({issuer,subject,appUserId:userId});
 ctx={tenantId:b.tenantId,userId,personId:e.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};
 await saveNotificationEmailPolicy(admin,['employee_master_reports']);await saveNotificationEmailPreferences(ctx,e.employmentId,['employee_master_reports'],'en',{issuer,subject,email:'fixture@example.test',emailVerified:true});
 const field=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode')!;
 report=await saveEmployeeMasterReport(ctx,[b.companyId],{name:'Synthetic scheduled report',description:'',sharedRoleIds:[],spec:{v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(field)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}}});
 const saved=await saveEmployeeMasterSchedule(ctx,[b.companyId],{reportId:report.id,version:report.version,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId,employmentId:e.employmentId}]});scheduleId=saved.id;
});
async function queued(){
 const due=new Date(Date.now()-1000),before=new Date(due.getTime()-1000);
 await owner.db.update(schema.notificationPref).set({updatedAt:before,reportConsentVerifiedAt:before}).where(eq(schema.notificationPref.category,'employee_master_reports'));
 await owner.db.update(schema.notificationEmailPolicy).set({updatedAt:before}).where(eq(schema.notificationEmailPolicy.category,'employee_master_reports'));
 await owner.db.update(schema.customReportSchedule).set({nextRunAt:due}).where(eq(schema.customReportSchedule.id,scheduleId));
 const [added]=await raw`select identity_email.queue_report(${scheduleId}::uuid,${due.toISOString()}::timestamptz,${new Date(Date.now()+86400000).toISOString()}::timestamptz) added`;expect(added.added).toBe(1);
 const [job]=await raw`select * from identity_email.claim_reports(10)`;return {id:String(job.id),token:String(job.lease_token)};
}
async function target(job:{id:string;token:string}){return (await raw`select identity_email.report_target(${job.id}::uuid,${job.token}::uuid,${issuer}) target`)[0].target;}
const start=async(job:{id:string;token:string},expected:postgres.JSONValue)=>(await raw`select identity_email.start_report(${job.id}::uuid,${job.token}::uuid,${issuer},${raw.json(expected)}::jsonb) started`)[0].started;
/** Actual pending DDL and invocation under an owner without superuser, BYPASSRLS or custom SET ACL. */
async function restrictedTargetOwner(run:()=>Promise<void>){
 const role='report_owner_'+randomUUID().replaceAll('-','');
 const tables=['custom_report_occurrence','custom_report_schedule','custom_report','app_user','employment','person','notification_pref','notification_email_policy','app_external_identity'];
 const initial=await raw`select c.relname,r.rolname as owner from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='public'::regnamespace and c.relname=any(${tables}::text[])`;
 const [original]=await raw`select r.rolname as owner from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid='identity_email.report_target(uuid,uuid,text)'::regprocedure`;
 const quote=(value:string)=>'"'+value.replaceAll('"','""')+'"';
 await raw.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`);
 try{
  await raw.unsafe(`GRANT USAGE,CREATE ON SCHEMA public,app,identity_email TO ${quote(role)}`);
  await raw.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quote(role)}`);
  await raw.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app,identity_email TO ${quote(role)}`);
  for(const table of tables)await raw.unsafe(`ALTER TABLE public.${quote(table)} OWNER TO ${quote(role)}`);
  await raw.unsafe(`ALTER FUNCTION identity_email.report_target(uuid,uuid,text) OWNER TO ${quote(role)}`);
  const migration=readFileSync(new URL('../db/migrations/0549_employee_master_delivery.sql',import.meta.url),'utf8'),start=migration.indexOf('CREATE FUNCTION identity_email.report_target('),end=migration.indexOf('--> statement-breakpoint',start);
  expect(start).toBeGreaterThanOrEqual(0);expect(end).toBeGreaterThan(start);const definition=migration.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');expect(definition.length).toBeGreaterThan(4000);
  await raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE ${quote(role)}`);await tx.unsafe(definition);});
  const [flags]=await raw`select r.rolsuper,r.rolbypassrls,pg_has_role('ai_hr_app',r.oid,'USAGE') as app_member,has_parameter_privilege(r.oid,'app.tenant_id','SET') as custom_set from pg_roles r where r.rolname=${role}`;
  expect(flags).toEqual({rolsuper:false,rolbypassrls:false,app_member:false,custom_set:false});
  await run();
 }finally{
  await raw.unsafe(`ALTER FUNCTION identity_email.report_target(uuid,uuid,text) OWNER TO ${quote(original.owner)}`);
  for(const row of initial)await raw.unsafe(`ALTER TABLE public.${quote(row.relname)} OWNER TO ${quote(row.owner)}`);
  await raw.unsafe(`DROP OWNED BY ${quote(role)}`);await raw.unsafe(`DROP ROLE ${quote(role)}`);
 }
}

describe('managed report nonce and durable lifecycle in the actual database',()=>{
 it('defines and invokes the private target as the restricted owner and restores all caller context on success, refusal and error',async()=>{
  const job=await queued();
  await restrictedTargetOwner(async()=>{
   const values=[randomUUID(),randomUUID(),'employee','[{"role":"employee","companyId":null}]'];
   const [originalStamp]=await raw`select pg_get_functiondef('identity_email.report_access_stamp(uuid)'::regprocedure) definition`;
   await raw.begin(async tx=>{
    const context=async()=>(await tx`select current_setting('app.tenant_id',true) tenant,current_setting('app.user_id',true) actor,current_setting('app.roles',true) roles,current_setting('app.grants',true) grants`)[0];
    await tx`select set_config('app.tenant_id',${values[0]},true),set_config('app.user_id',${values[1]},true),set_config('app.roles',${values[2]},true),set_config('app.grants',${values[3]},true)`;
    const prior=await context();
    expect((await tx`select identity_email.report_target(${job.id}::uuid,${job.token}::uuid,${issuer}) value`)[0].value).not.toBeNull();expect(await context()).toEqual(prior);
    expect((await tx`select identity_email.report_target(${job.id}::uuid,${randomUUID()}::uuid,${issuer}) value`)[0].value).toBeNull();expect(await context()).toEqual(prior);
    await tx.unsafe("CREATE OR REPLACE FUNCTION identity_email.report_access_stamp(p_tenant uuid) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN RAISE EXCEPTION 'Synthetic private target failure' USING ERRCODE='22007'; END $$");
    try{await expect(tx.savepoint(async sub=>sub`select identity_email.report_target(${job.id}::uuid,${job.token}::uuid,${issuer})`)).rejects.toMatchObject({code:'22007'});expect(await context()).toEqual(prior);}
    finally{await tx.unsafe(originalStamp.definition);}
   });
  });
 });
 it('freezes exact user/employment/version/scope and microsecond consent revisions; the app renderer context has no address or provider subject',async()=>{
  const job=await queued(),value=await target(job);expect(value).toMatchObject({ownerUserId:ctx.userId,recipientUserId:ctx.userId,recipientEmploymentId:e.employmentId,reportVersion:report.version,companyIds:[b.companyId]});expect(value.consentUpdatedAt).toMatch(/\.\d{6}Z$/);
  const [context]=await withTenant(ctx,tx=>tx.execute(sql`select app.employee_master_render_context(${job.id}::uuid,${job.token}::uuid,${issuer}) context`)) as unknown as {context:Record<string,unknown>}[];expect(context.context.recipientEmploymentId).toBe(e.employmentId);expect(context.context).not.toHaveProperty('email');expect(context.context).not.toHaveProperty('subject');
  expect((await raw`select identity_email.report_target(${job.id}::uuid,${randomUUID()}::uuid,${issuer}) target`)[0].target).toBeNull();
 });
 it('does not expose nonce capabilities through an otherwise visible application audit row',async()=>{
  const job=await queued();expect(await withTenant(ctx,tx=>tx.select({id:schema.customReportOccurrence.id}).from(schema.customReportOccurrence))).toEqual([{id:job.id}]);
  await expect(withTenant(ctx,tx=>tx.select({token:schema.customReportOccurrence.leaseToken}).from(schema.customReportOccurrence))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(ctx,tx=>tx.select({until:schema.customReportOccurrence.leaseUntil}).from(schema.customReportOccurrence))).rejects.toMatchObject({cause:{code:'42501'}});
 });
 it('reclaims only unstarted expired leases and invalidates the old nonce',async()=>{
  const job=await queued();expect(await raw`select * from identity_email.claim_reports(10)`).toEqual([]);await owner.db.update(schema.customReportOccurrence).set({leaseUntil:new Date(Date.now()-1000)}).where(eq(schema.customReportOccurrence.id,job.id));
  const [replacement]=await raw`select * from identity_email.claim_reports(10)`;expect(replacement.lease_token).not.toBe(job.token);expect(await target(job)).toBeNull();expect(await target({id:job.id,token:String(replacement.lease_token)})).not.toBeNull();
 });
 it('does not resume a queued occurrence after schedule re-review',async()=>{
  const job=await queued(),expected=await target(job);await saveEmployeeMasterSchedule(ctx,[b.companyId],{reportId:report.id,version:report.version,enabled:true,config:{frequency:'monthly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId:ctx.userId!,employmentId:e.employmentId}]});expect(await target(job)).toBeNull();expect(await start(job,expected)).toBe(false);
 });
 it('rejects a revoked exact private identity binding',async()=>{
  const job=await queued(),expected=await target(job);await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()}).where(eq(schema.appExternalIdentity.appUserId,ctx.userId!));expect(await target(job)).toBeNull();expect(await start(job,expected)).toBe(false);
 });
 it('refuses a stale prepared target after granular grants or relationship metadata changes',async()=>{
  const job=await queued(),expected=await target(job);await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'report.read.personnel',role:'hr_admin',allowed:false});const changed=await target(job);expect(changed.accessStamp).not.toBe(expected.accessStamp);expect(await start(job,expected)).toBe(false);
 });
 it('permits exactly one start and marks an abandoned started attempt uncertain without reclaiming SMTP',async()=>{
  const job=await queued(),expected=await target(job);const starts=await Promise.all([start(job,expected),start(job,expected)]);expect(starts.filter(Boolean)).toHaveLength(1);
  await owner.db.update(schema.customReportOccurrence).set({leaseUntil:new Date(Date.now()-1000)}).where(eq(schema.customReportOccurrence.id,job.id));expect(await raw`select * from identity_email.claim_reports(10)`).toEqual([]);
  expect((await owner.db.select().from(schema.customReportOccurrence))[0]).toMatchObject({status:'uncertain',reason:'uncertain',leaseToken:null});expect((await raw`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'sent',null,0,${[b.companyId]}::uuid[]) finished`)[0].finished).toBe(false);
 });
 it('retains delivery audit after deletion, and will not accept invented export scope in success metadata',async()=>{
  const job=await queued(),expected=await target(job);expect(await start(job,expected)).toBe(true);expect((await raw`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'sent',null,1,${[randomUUID()]}::uuid[]) finished`)[0].finished).toBe(false);
  await deleteEmployeeMasterReport(ctx,report.id);expect((await raw`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'sent',null,1,${[b.companyId]}::uuid[]) finished`)[0].finished).toBe(true);expect((await withTenant(ctx,tx=>tx.select({status:schema.customReportOccurrence.status,frozenScopeIds:schema.customReportOccurrence.frozenScopeIds}).from(schema.customReportOccurrence)))[0]).toMatchObject({status:'sent',frozenScopeIds:[b.companyId]});
 });
 it('claims each lease just before processing so earlier rendering cannot expire later work',async()=>{
  const before=new Date(Date.now()-60_000);
  await owner.db.update(schema.notificationPref).set({updatedAt:before,reportConsentVerifiedAt:before}).where(eq(schema.notificationPref.category,'employee_master_reports'));
  await owner.db.update(schema.notificationEmailPolicy).set({updatedAt:before}).where(eq(schema.notificationEmailPolicy.category,'employee_master_reports'));
  for(const offset of [20_000,10_000]){
   const due=new Date(Date.now()-offset);await owner.db.update(schema.customReportSchedule).set({nextRunAt:due}).where(eq(schema.customReportSchedule.id,scheduleId));
   expect((await raw`select identity_email.queue_report(${scheduleId}::uuid,${due.toISOString()}::timestamptz,${new Date(Date.now()+86400000).toISOString()}::timestamptz) added`)[0].added).toBe(1);
  }
  let attempted=0;
  const result=await sweepEmployeeMasterReports(owner.db,{limit:2,transport:async<T>(request:import('../lib/employee-master-delivery-model').MasterDeliveryRequest):Promise<T>=>{
   if(request.op==='status')return {version:1,ready:true} as T;
   attempted++;const job={id:request.occurrenceId,token:request.leaseToken};expect(await target(job)).not.toBeNull();
   if(attempted===1)await raw`update custom_report_occurrence set lease_until=now()-interval '1 second' where id<>${job.id}::uuid and lease_token is not null and status='pending'`;
   expect((await raw`select identity_email.finish_report(${job.id}::uuid,${job.token}::uuid,'skipped','notEligible') finished`)[0].finished).toBe(true);
   return {outcome:'skipped'} as T;
  }});
  expect(result).toMatchObject({attempted:2,skipped:2,unavailable:false});expect(attempted).toBe(2);
 });
 it.each(['suspended','closed'])('leaves schedules and pending leases untouched for %s tenants and refuses a prepared send',async status=>{
  const job=await queued(),expected=await target(job);
  const due=new Date(Date.now()-1000);
  await owner.db.update(schema.customReportSchedule).set({nextRunAt:due}).where(eq(schema.customReportSchedule.id,scheduleId));
  await owner.db.update(schema.tenant).set({status}).where(eq(schema.tenant.id,b.tenantId));
  expect((await raw`select identity_email.queue_report(${scheduleId}::uuid,${due.toISOString()}::timestamptz,${new Date(Date.now()+86400000).toISOString()}::timestamptz) added`)[0].added).toBe(0);
  expect((await owner.db.select().from(schema.customReportSchedule).where(eq(schema.customReportSchedule.id,scheduleId)))[0].nextRunAt).toEqual(due);
  expect(await target(job)).toBeNull();expect(await start(job,expected)).toBe(false);
  await owner.db.update(schema.customReportOccurrence).set({leaseUntil:new Date(Date.now()-1000)}).where(eq(schema.customReportOccurrence.id,job.id));
  expect(await raw`select * from identity_email.claim_reports(10)`).toEqual([]);
  const transport=async<T>(request:import('../lib/employee-master-delivery-model').MasterDeliveryRequest):Promise<T>=>{expect(request.op).toBe('status');return {version:1,ready:true} as T;};
  expect(await sweepEmployeeMasterReports(owner.db,{transport})).toMatchObject({queued:0,attempted:0,tenantsFailed:0});
  expect((await owner.db.select().from(schema.customReportOccurrence).where(eq(schema.customReportOccurrence.id,job.id)))[0]).toMatchObject({status:'pending',leaseToken:job.token});
 });
 it('refuses unknown tenant standing at storage and keeps the shared sweep predicate fail-closed',async()=>{
  await expect(owner.db.update(schema.tenant).set({status:'unknown-standing'}).where(eq(schema.tenant.id,b.tenantId))).rejects.toMatchObject({cause:{code:'23514',constraint_name:'tenant_status_check'}});
  expect((await owner.db.select({status:schema.tenant.status}).from(schema.tenant).where(eq(schema.tenant.id,b.tenantId)))[0]).toEqual({status:'active'});
  expect(sweepSkipReason('unknown-standing')).not.toBeNull();
 });
 it('keeps the installed private role incapable of direct HR reads, queue/claim and app helper access',async()=>{
  const role='report_mail_'+randomUUID().replaceAll('-','');await raw.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  try{await raw.unsafe(`GRANT USAGE ON SCHEMA identity_email TO "${role}"`);for(const grant of masterReportDatabaseGrants(role))await raw.unsafe(grant);
   await raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE "${role}"`);expect((await tx`select identity_email.report_target(${randomUUID()}::uuid,${randomUUID()}::uuid,${issuer}) target`)[0].target).toBeNull();});
   for(const query of ['select * from public.person','select * from public.custom_report_occurrence','select identity_email.claim_reports(10)','select app.employee_master_render_context(null,null,null)'])await expect(raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE "${role}"`);return tx.unsafe(query);})).rejects.toThrow(/permission denied/);
   expect((await raw`select has_function_privilege('ai_hr_app','identity_email.report_target(uuid,uuid,text)','EXECUTE') allowed`)[0].allowed).toBe(false);
  }finally{await raw.unsafe(`DROP OWNED BY "${role}"`);await raw.unsafe(`DROP ROLE "${role}"`);}
 });
});
