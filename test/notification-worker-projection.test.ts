/** Real LOGIN prototype parity against isolated equivalent legacy fixtures. No delivery/provider. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createNotice,publishNotice} from '../core/notice';
import {dispatchNotifications} from '../core/notifications';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import {notificationWorkerLifecycle} from '../lib/notification-worker/lifecycle';
import {notificationWorkerProjection,notificationWorkerProjectionContract,UnsupportedNotificationFacts} from '../lib/notification-worker/projection';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const role='ai_hr_notification_worker',password=randomUUID();
const fixtures=['lifecycle','projection'].map(name=>readFileSync('test/fixtures/notification-worker/'+name+'.sql','utf8'));
let created=false,url:URL,service:ReturnType<typeof postgres>,b:Base;
const sockets:ReturnType<typeof postgres>[]=[],jobs=new Set<string>();
function connect(){const connection=postgres(url.toString(),{max:1,connection:{statement_timeout:20000,lock_timeout:300}});sockets.push(connection);return connection;}
beforeAll(async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 await migrateTestDb();url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(url.hostname).toBe('127.0.0.1');expect(url.pathname).toMatch(/^\/ai_hr_test_w\d+(?:_[a-z0-9_]+)?$/);
 expect(await owner.client`select 1 from pg_roles where rolname=${role}`).toHaveLength(0);
 await owner.client.unsafe(`CREATE ROLE ai_hr_notification_worker LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);created=true;
 await owner.client.begin(async tx=>{for(const source of fixtures)await tx.unsafe(source);
  await tx`insert into notification_worker_private.registry_contract(event_type,kind,category,recipient_port,implemented)
   select x."eventType",x.kind,x.category,x."recipientPort",x.implemented from jsonb_to_recordset(${tx.json(notificationWorkerProjectionContract)}::jsonb) as x("eventType" text,kind text,category text,"recipientPort" text,implemented boolean)`;
 });
 const [identity]=await owner.client`select current_user::regrole::oid as owner,(select oid from pg_roles where rolname=${role}) as login`;
 await owner.client`insert into notification_worker_private.authority(singleton,enabled,login_oid,owner_oid,api_version,max_batch_events,max_run_batches,max_run_seconds,max_tenants)
  values(true,true,${identity.login},${identity.owner},2,25,10,300,100)`;
 url.username=role;url.password=password;
},300000);
beforeEach(async()=>{
 await owner.client`truncate notification_worker_private.run cascade`;
 await owner.client`update notification_worker_private.authority set active_run=null,enabled=true,max_run_batches=10,max_batch_projections=50000`;
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');service=connect();
 const [actual]=await service`select session_user,current_user`;expect(actual).toEqual({session_user:role,current_user:role});
},30000);
afterEach(async()=>{
 try{if(created)for(const row of await owner.client`select run_id from notification_worker_private.run`)jobs.add(row.run_id);}
 finally{await Promise.all(sockets.splice(0).map(sql=>sql.end({timeout:0})));}
});
afterAll(async()=>{
 try{if(created){await owner.client`drop schema if exists notification_worker cascade`;await owner.client`drop schema if exists notification_worker_private cascade`;
  await owner.client`drop owned by ai_hr_notification_worker`;await owner.client`drop role ai_hr_notification_worker`;
  await owner.client`delete from public.job_run where id=any(${[...jobs]}::uuid[])`;
 }}finally{await closeAll();}
});
async function historical(){await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;}
async function employee(base:Base,label:string){
 const email=randomUUID()+'@example.invalid';
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional worker '+label,primaryEmail:email},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,e.personId,'employee'),subject=randomUUID(),issuer='https://fictional.example.invalid/identity';
 await owner.db.insert(s.appExternalIdentity).values({issuer,subject,appUserId:userId});
 const ctx={...adminCtx(base),userId,personId:e.personId,roles:['employee']};
 await saveNotificationEmailPreferences(ctx,e.employmentId,['leave','payroll','notice'],'en',{issuer,subject,email,emailVerified:true});
 return {...e,userId};
}
async function fixture(base:Base){
 await setModule(base.tenantId,'notifications','active');
 await saveNotificationEmailPolicy(adminCtx(base),['leave','payroll','notice']);
 const a=await employee(base,'A'),other=await employee(base,'B');
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:base.tenantId,companyId:base.companyId,period:'2026-07'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:base.tenantId,companyId:base.companyId,payPeriodId:period.id,payPeriod:'2026-07',batchDate:'2026-07-25',status:'closed'}).returning();
 await owner.db.insert(s.payslip).values([a,other].map(e=>({tenantId:base.tenantId,batchId:batch.id,employmentId:e.employmentId,basicSalary:'3000',grossPay:'3000',statutory:{},totalDeductions:'330',netPay:'2670',employerCost:'3390'})));
 const line=await setReportingLine(adminCtx(base),{subordinateEmploymentId:a.employmentId,managerEmploymentId:other.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 const notice=await createNotice(adminCtx(base),{title:'Fictional worker notice',body:'Fictional immutable audience.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur(),targetMode:'individual',employmentIds:[a.employmentId,other.employmentId],notifyOnPublish:true});
 return{base,a,other,batch,line,notice,cases:new Map<string,string>()};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function event(base:Base,type:string,subject:string|null,payload:Record<string,unknown>={},aggregateId=randomUUID(),aggregateType='fixture'){
 const [ev]=await owner.db.insert(s.domainEvent).values({tenantId:base.tenantId,aggregateType,aggregateId,eventType:type,actorType:'system',subjectEmploymentId:subject,payload}).returning();return ev;
}
async function cases(f:Fixture){
 const add=async(label:string,type:string,subject:string|null,value:Record<string,unknown>={},id?:string,aggregateType?:string)=>{const ev=await event(f.base,type,subject,value,id,aggregateType);f.cases.set(ev.id,label);return ev;};
 await add('leave-mixed','leave-request.approved',f.a.employmentId,{mixed:true});
 await add('leave-superseded','leave-cancellation.rejected',f.a.employmentId,{supersededByAdminCancellation:true});
 await add('overtime','attendance-correction.approved',f.other.employmentId,{overtime:true,deferred:true,date:'2026-07-01'});
 await add('not-overtime','attendance-correction.approved',f.a.employmentId,{overtime:false});
 await add('unknown','fixture.unmapped',f.a.employmentId);
 await add('payroll','payroll-batch.closed',null,{},f.batch.id,'payroll-batch');
 await add('delegation','delegation.ended',f.a.employmentId,{endDate:'2026-07-01'},f.line.reportingLineId);
 await publishNotice(adminCtx(f.base),f.notice.id);
 const [published]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,f.notice.id));
 const all=await owner.client`select id from public.domain_event where aggregate_id=${f.notice.id}::uuid and event_type='notice.published'`;
 expect(published).toBeTruthy();expect(all).toHaveLength(1);f.cases.set(all[0].id,'notice');
}
async function normalized(f:Fixture){
 const rows=await owner.client`select n.source_event_id,n.recipient_employment_id,n.recipient_user_id,n.kind,n.title,n.body,n.link_path,n.severity,
  (select coalesce(jsonb_agg(jsonb_build_object('category',d.category,'channel',d.channel,'status',d.status,'attempts',d.attempts,'user',case d.recipient_user_id when ${f.a.userId}::uuid then 'A' when ${f.other.userId}::uuid then 'B' else 'unexpected' end) order by d.category),'[]'::jsonb) from public.notification_delivery d where d.notification_id=n.id) as deliveries
  from public.notification n where n.tenant_id=${f.base.tenantId}::uuid`;
 const simplify=(text:string|null)=>text?.replaceAll(f.notice.id,'<notice>');
 const notifications=rows.map(row=>({event:f.cases.get(row.source_event_id),recipient:row.recipient_employment_id===f.a.employmentId?'A':row.recipient_employment_id===f.other.employmentId?'B':'unexpected',account:row.recipient_user_id,kind:row.kind,title:row.title,body:row.body,link:simplify(row.link_path),severity:row.severity,deliveries:row.deliveries})).sort((a,c)=>JSON.stringify(a).localeCompare(JSON.stringify(c)));
 const receipts=await owner.client`select event_id,disposition from public.notification_event_processing where tenant_id=${f.base.tenantId}::uuid and consumer='notifications' and event_id=any(${[...f.cases.keys()]}::uuid[])`;
 return{notifications,receipts:receipts.map(row=>({event:f.cases.get(row.event_id),disposition:row.disposition})).sort((a,c)=>(a.event??'').localeCompare(c.event??''))};
}
async function sourceState(){
 const names=['person','employment','role_assignment','app_user','payroll_batch','payslip','domain_event','notification','notification_delivery','notification_event_processing','notification_cursor','tenant_setting','tenant_module','performance_assessment_reminder_recipient'];
 return owner.client.unsafe(names.map(name=>`select '${name}' as name,md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]'::jsonb)::text) as digest from public.${name} x`).join(' union all '));
}
async function open(){return notificationWorkerLifecycle(service).openRun();}
async function admitted<T>(run:string,tenant:string,body:(tx:postgres.TransactionSql,batch:string)=>Promise<T>){return service.begin(async tx=>{const [batch]=await tx`select notification_worker.open_batch(${run}::uuid,${tenant}::uuid,25) as id`;return body(tx,batch.id);});}
const refused=(work:Promise<unknown>,code='42501')=>expect(work).rejects.toSatisfy((error:unknown)=>pgSqlState(error)===code);

it('matches actual legacy projection on independent equivalent tenants, including real consent outbox, recipient IDs and receipts',async()=>{
 const legacy=await fixture(b),base=await seedBase(),native=await fixture(base);await historical();await cases(legacy);await cases(native);
 const legacyResult=await dispatchNotifications(await entitledCtx(b),{limit:25});
 const run=await open(),nativeResult=await notificationWorkerProjection(service).projectBatch(run,base.tenantId,25);
 expect(legacyResult).toEqual({processed:8,created:7});expect(nativeResult).toEqual(legacyResult);
 const old=await normalized(legacy),next=await normalized(native);expect(next).toEqual(old);
 expect(next.notifications.filter(row=>row.kind==='payslip.ready').map(row=>row.recipient).sort()).toEqual(['A','B']);
 expect(next.notifications.find(row=>row.kind==='leave.approved')).toMatchObject({recipient:'A',title:'Leave partially approved',link:'/me',severity:'info'});
 expect(next.notifications.filter(row=>row.kind==='notice.published')).toHaveLength(2);
 expect(next.notifications.find(row=>row.kind==='delegation.ended')).toMatchObject({recipient:'B',title:'Your stand-in cover has ended'});
 expect(next.notifications.flatMap(row=>row.deliveries)).toHaveLength(5);
 expect(next.receipts.find(row=>row.event==='unknown')).toMatchObject({disposition:'ignored'});
 expect(next.receipts.filter(row=>row.disposition==='processed')).toHaveLength(7);
 const [cursor]=await owner.client`select c.last_sequence=(select max(e.sequence) from public.domain_event e where e.id=any(${[...native.cases.keys()]}::uuid[])) as exact,c.assessment_last_sequence from public.notification_cursor c where c.tenant_id=${base.tenantId}::uuid`;
 expect(cursor).toEqual({exact:true,assessment_last_sequence:'0'});
 expect(await notificationWorkerProjection(service).projectBatch(run,base.tenantId,25)).toEqual({processed:0,created:0});
 // The legacy tenant was already drained through its separate canonical carrier.
 const api=notificationWorkerLifecycle(service);for(const scope of await api.scopePage(run))expect((await api.settleScope(run,scope.tenant_id,'drained')).pending).toBe('0');
 await api.finishRun(run);const [job]=await owner.db.select().from(s.jobRun).where(eq(s.jobRun.id,run));
 expect(job).toMatchObject({outcome:'success',result:{batches:2,processed:8,created:7}});
},30000);

it.each(['notification','notification_delivery','notification_event_processing','notification_cursor'] as const)('rolls back every effect, receipt, cursor and native counter when %s refuses after projection',async table=>{
 const f=await fixture(b);await historical();await event(b,'leave-request.approved',f.a.employmentId);const run=await open(),before=await sourceState();
 // Owner-only fixed fault; service receives neither trigger/function privileges nor a SQL broker.
 await owner.client.unsafe(`CREATE FUNCTION public.notification_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $fault$ BEGIN RAISE EXCEPTION 'Controlled projection rollback' USING ERRCODE='P0001'; END $fault$`);
 await owner.client.unsafe(`CREATE TRIGGER notification_projection_fault BEFORE ${table==='notification_event_processing'?'UPDATE':'INSERT'} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.notification_projection_fault()`);
 try{await refused(notificationWorkerProjection(service).projectBatch(run,b.tenantId,25),'P0001');expect(await sourceState()).toEqual(before);
  expect((await owner.client`select committed_batches,processed_events,created_notifications from notification_worker_private.run where run_id=${run}::uuid`)[0]).toEqual({committed_batches:0,processed_events:'0',created_notifications:'0'});
  expect(await owner.client`select * from notification_worker_private.batch`).toHaveLength(0);
 }finally{await owner.client.unsafe(`DROP TRIGGER notification_projection_fault ON public.${table}`);await owner.client`drop function public.notification_projection_fault()`;}
 expect(await notificationWorkerProjection(service).projectBatch(run,b.tenantId,25)).toEqual({processed:1,created:1});
 await notificationWorkerLifecycle(service).failRun(run,'database-refusal');
 expect((await owner.db.select().from(s.jobRun).where(eq(s.jobRun.id,run)))[0]).toMatchObject({outcome:'failed',result:{batches:1,processed:1,created:1}});
},30000);

it('refuses unfinished/foreign/wrong-family/wrong-kind/wrong-category/malformed proposals and direct source writes inside actual admission',async()=>{
 const f=await fixture(b),foreign=await fixture(await seedBase());await historical();const local=await event(b,'leave-request.approved',f.a.employmentId),alien=await event(foreign.base,'leave-request.approved',foreign.a.employmentId);
 const run=await open(),before=await sourceState(),rendered={title:'Fictional',body:'Fictional',linkPath:'/me',severity:'info'};
 const attempt=(work:(tx:postgres.TransactionSql,batch:string)=>Promise<unknown>,code='42501')=>refused(admitted(run,b.tenantId,work),code);
 await attempt((tx,batch)=>tx`select notification_worker.facts(${batch}::uuid,${alien.id}::uuid,'meta')`);
 await attempt((tx,batch)=>tx`select notification_worker.facts(${batch}::uuid,${local.id}::uuid,'payroll-audience')`);
 await attempt((tx,batch)=>tx`select * from notification_worker.project(${batch}::uuid,${local.id}::uuid,'leave.approved',${foreign.a.employmentId}::uuid,${tx.json(rendered)},'leave')`);
 for(const [kind,category] of [['forged','leave'],['leave.approved','payroll']])await attempt((tx,batch)=>tx`select * from notification_worker.project(${batch}::uuid,${local.id}::uuid,${kind},${f.a.employmentId}::uuid,${tx.json(rendered)},${category})`);
 for(const invalid of [{...rendered,linkPath:'//example.invalid'},{...rendered,extra:'not closed'},{...rendered,body:'x'.repeat(4001)},{...rendered,severity:'fatal'}])await attempt((tx,batch)=>tx`select * from notification_worker.project(${batch}::uuid,${local.id}::uuid,'leave.approved',${f.a.employmentId}::uuid,${tx.json(invalid)},'leave')`,'22023');
 await attempt((tx,batch)=>tx`select notification_worker.project_reward_account(${batch}::uuid,${local.id}::uuid)`);
 await attempt((tx,batch)=>tx`select notification_worker.finish_event(${batch}::uuid,${local.id}::uuid,'ignored')`);
 await attempt((tx,batch)=>tx`select * from notification_worker.finish_batch(${batch}::uuid)`,'55000');
 for(const command of ['update public.employment set employee_code=employee_code','delete from public.notification_event_processing','update public.notification_delivery set status=\'sent\'','update public.job_run set outcome=\'success\'','update notification_worker_private.registry_contract set implemented=true','select app.reward_access_project_account_suspension(null::uuid)','set role ai_hr_app'])await attempt(async(tx)=>{
  await tx`select set_config('app.tenant_id',${foreign.base.tenantId},true),set_config('app.roles','super_admin',true),set_config('app.grants','[{"role":"super_admin","companyId":null}]',true)`;await tx.unsafe(command);
 });
 expect(await sourceState()).toEqual(before);
 await attempt(async(tx,batch)=>{await tx`select notification_worker.finish_event(${batch}::uuid,${local.id}::uuid,'processed')`;await tx`select notification_worker.finish_event(${batch}::uuid,${local.id}::uuid,'processed')`;});
 expect(await sourceState()).toEqual(before);
},30000);

it('retains pending late commits behind the cursor and exact overlap duplicate counts',async context=>{
 const f=await fixture(b);await historical();const first=await event(b,'leave-request.approved',f.a.employmentId);let release!:()=>void,entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;}),done=new Promise<void>(resolve=>{release=resolve;});let late='';
 const writer=owner.client.begin(async tx=>{const [row]=await tx`insert into public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload) values(${b.tenantId}::uuid,'fixture',${randomUUID()}::uuid,'toil.accrued','system',${f.a.employmentId}::uuid,'{"daysCredited":1}') returning id`;late=row.id;entered();await done;});
 const abort=()=>release();context.signal.addEventListener('abort',abort,{once:true});
 try{await Promise.race([ready,writer.then(()=>{throw Error('Writer ended before its controlled late commit');})]);context.signal.throwIfAborted();
  const later=await event(b,'leave-request.approved',f.other.employmentId),run=await open();
  expect(await notificationWorkerProjection(service).projectBatch(run,b.tenantId,25)).toEqual({processed:2,created:2});
  const [cursor]=await owner.client`select last_sequence from public.notification_cursor where tenant_id=${b.tenantId}::uuid`;expect(cursor.last_sequence).toBe(String(later.sequence));
  release();await writer;const [source]=await owner.client`select sequence from public.domain_event where id=${late}::uuid`;expect(BigInt(source.sequence)).toBeLessThan(BigInt(cursor.last_sequence));
  expect(await notificationWorkerProjection(service).projectBatch(run,b.tenantId,25)).toEqual({processed:1,created:1});
  expect((await owner.client`select last_sequence from public.notification_cursor where tenant_id=${b.tenantId}::uuid`)[0].last_sequence).toBe(cursor.last_sequence);
  // Independently retain an overlap projection while restoring only its processing intent.
  await owner.client`update public.notification_event_processing set disposition=null,processed_at=null where event_id=${first.id}::uuid and consumer='notifications'`;
  expect(await notificationWorkerProjection(service).projectBatch(run,b.tenantId,25)).toEqual({processed:1,created:0});
  expect(await owner.client`select id from public.notification where source_event_id=${first.id}::uuid`).toHaveLength(1);
 }finally{release();context.signal.removeEventListener('abort',abort);await writer;}
},30000);

it('rolls back earlier supported projections rather than consuming an unsupported assessment preparation event',async()=>{
 const f=await fixture(b);await historical();await event(b,'leave-request.approved',f.a.employmentId);const reminder=await event(b,'assessment.reminder-queued',f.a.employmentId,{},randomUUID(),'assessment-reminder');
 const run=await open(),before=await sourceState();await expect(notificationWorkerProjection(service).projectBatch(run,b.tenantId,25)).rejects.toBeInstanceOf(UnsupportedNotificationFacts);
 expect(await sourceState()).toEqual(before);expect((await owner.client`select committed_batches from notification_worker_private.run where run_id=${run}::uuid`)[0].committed_batches).toBe(0);
 await refused(admitted(run,b.tenantId,(tx,batch)=>tx`select notification_worker.finish_event(${batch}::uuid,${reminder.id}::uuid,'processed')`));
 await refused(notificationWorkerLifecycle(service).finishRun(run),'55000');
},30000);

it('denies drifted native helper code and gives the real worker exactly twelve fixed APIs and no table/schema authority',async()=>{
 await historical();const run=await open();
 const actual=await owner.client`select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname !~ '^pg_' and has_schema_privilege(${role},n.oid,'USAGE') and has_function_privilege(${role},p.oid,'EXECUTE') order by 1`;
 expect(actual).toHaveLength(12);expect(actual.every(row=>row.signature.startsWith('notification_worker.'))).toBe(true);
 expect((await owner.client`select count(*)::integer as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in('r','p','v','m','f') and (has_table_privilege(${role},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(${role},c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`)[0].n).toBe(0);
 const [original]=await owner.client`select pg_get_functiondef('app.notification_email_enqueue(uuid,text,bigint)'::regprocedure) as definition`;
 try{await owner.client.unsafe(`CREATE OR REPLACE FUNCTION app.notification_email_enqueue(p_notification uuid,p_category text,p_sequence bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$ BEGIN RAISE EXCEPTION 'Drift must never execute'; END $body$`);
  await refused(notificationWorkerLifecycle(service).scopePage(run));
 }finally{await owner.client.unsafe(original.definition);}
 expect((await notificationWorkerLifecycle(service).scopePage(run)).some(row=>row.tenant_id===b.tenantId)).toBe(true);
},30000);
