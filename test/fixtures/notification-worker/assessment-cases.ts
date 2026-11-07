/** Actual native preparation source and isolated equivalent legacy fixtures; no delivery/provider. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import type {TransactionSql} from 'postgres';
import * as s from '../../../db/schema';
import {hireEmployee,setReportingLine} from '../../../core/org';
import {dispatchNotifications} from '../../../core/notifications';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../../../core/notification-email';
import {toSnapshot} from '../../../core/entitlements';
import * as performance from '../../../packs/performance/service';
import {defaultPolicy} from '../../../packs/performance/onehr/model';
import framework from '../../../packs/performance/onehr/framework.json';
import {assessmentReminderProjectionWork} from '../../../packs/performance/onehr/reminder-projection';
import {assessmentReminderPreparationValue} from '../../../packs/performance/onehr/reminder-preparation';
import {todayInKualaLumpur} from '../../../lib/hr-date';
import {pgSqlState} from '../../../lib/db-error';
import {notificationWorkerLifecycle} from '../../../lib/notification-worker/lifecycle';
import {notificationWorkerProjection,notificationWorkerAssessmentContract} from '../../../lib/notification-worker/projection';
import {nativeAssessmentReminderFacts,prepareNativeAssessmentReminder} from '../../../lib/notification-worker/reminder';
import {createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from '../../harness';
import type {NotificationWorkerFixtureOwner} from './owner-fixture';
export function registerNotificationAssessmentCases(fixtureOwner:NotificationWorkerFixtureOwner){
describe.sequential('native assessment reminder preparation (stage3)',()=>{
 const sources=['lifecycle','projection','assessment'].map(name=>readFileSync('test/fixtures/notification-worker/'+name+'.sql','utf8'));
 let service:ReturnType<NotificationWorkerFixtureOwner['connect']>,base:Base;
 beforeAll(()=>fixtureOwner.install(sources,3,notificationWorkerAssessmentContract),300000);
 beforeEach(async()=>{await owner.client`truncate notification_worker_private.run cascade`;await owner.client`update notification_worker_private.authority set active_run=null,enabled=true`;await resetDb();base=await seedBase();service=fixtureOwner.connect();});
 afterEach(()=>fixtureOwner.finishCase());afterAll(()=>fixtureOwner.clearStage());
 async function fixture(b:Base){
  await setModule(b.tenantId,'performance','active');await setModule(b.tenantId,'notifications','active');const ctx=await entitledCtx(b),year=Number(todayInKualaLumpur().slice(0,4));
  const [grade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'12',name:'Fictional reminder grade'}).returning();
  const hire=async(name:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,gradeId:grade.id,employmentType:'full_time',hiredOn:'2020-01-01'});
  const subject=await hire('Fictional reminder subject'),manager=await hire('Fictional reminder manager');
  await setReportingLine(ctx,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,subject.personId,'employee'),self={...ctx,userId,personId:subject.personId,roles:['employee'],grants:undefined};
  const {cycleId}=await performance.createCycle(ctx,{name:'Fictional native reminder cycle',companyId:b.companyId,periodStart:`${year}-01-01`,periodEnd:`${year}-12-31`});
  const policy=defaultPolicy(framework);policy.modules={pm:false,tm:true,idp:false,evidence:false,calibration:false};
  policy.profiles=[{id:randomUUID(),companyId:b.companyId,grade:'12',name:'Fictional native profile',competencies:[{id:'fictional-skill',principle:'Technical',text:'Fictional current skill',future:false}]}];
  await performance.configureOnehrCycle(ctx,cycleId,null,policy);await performance.openCycle(ctx,{cycleId});
  const issuer='https://fictional.example.invalid/identity',identitySubject=randomUUID(),[person]=await owner.db.select().from(s.person).where(eq(s.person.id,subject.personId));
  await owner.db.insert(s.appExternalIdentity).values({issuer,subject:identitySubject,appUserId:userId});
  await saveNotificationEmailPolicy(ctx,['performance']);await saveNotificationEmailPreferences(self,subject.employmentId,['performance'],'en',{issuer,subject:identitySubject,email:person.primaryEmail,emailVerified:true});
  await performance.saveAssessmentReminderWords({...ctx,grants:[{role:'hr_admin',companyId:null}]},{subject:'{first_name}: {cycle}',opening:'Please complete {count} task groups.'});
  return{b,ctx,self,subject,manager,cycleId};
 }
 type Fixture=Awaited<ReturnType<typeof fixture>>;
 async function queued(f:Fixture){
  const result=await performance.queueAssessmentReminders(f.ctx,f.cycleId,'manual');expect(result.queued).toBe(1);
  const [row]=await owner.db.select().from(s.assessmentReminderRecipient).where(eq(s.assessmentReminderRecipient.runId,result.runId!));
  const selected=(await owner.db.select().from(s.assessmentReminderRecipient).where(eq(s.assessmentReminderRecipient.runId,result.runId!))).find(r=>r.userId===f.self.userId);
  expect(row).toBeTruthy();expect(selected?.sourceEventId).toBeTruthy();return selected!;
 }
 async function historical(){await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;}
 async function targetOnly(event:string){await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now() where event_id<>${event}::uuid`;}
 async function begin<T>(run:string,tenant:string,work:(tx:TransactionSql,batch:string)=>Promise<T>){return service.begin(async tx=>{const [row]=await tx`select notification_worker.open_batch(${run}::uuid,${tenant}::uuid,25) as id`;return work(tx,row.id);});}
 async function prepared(id:string){return (await owner.db.select().from(s.assessmentReminderRecipient).where(eq(s.assessmentReminderRecipient.id,id)))[0];}
 async function validProposal(tx:TransactionSql,batch:string,event:string){
  const [raw]=await tx`select notification_worker.facts(${batch}::uuid,${event}::uuid,'assessment-reminder') as value`,facts=nativeAssessmentReminderFacts.parse(raw.value);if(facts.kind!=='ready')throw Error('Actual queued fixture required');
  const current=assessmentReminderProjectionWork(facts.graph,{tenantId:facts.tenantId,entitlements:toSnapshot(facts.tenantId,facts.snapshot)},new Date(facts.startedAt)),actor=current?.recipients.find(r=>r.userId===facts.userId);
  expect(actor?.tasks).toEqual([{key:'own_competency',count:1,closesAt:null}]);if(!actor||!current)throw Error('Actual pending-work fixture required');
  const [clock]=await tx`select notification_worker.facts(${batch}::uuid,${event}::uuid,'assessment-reminder-current') as value`;
  return{facts,proposal:{kind:'prepare',...assessmentReminderPreparationValue({actor,name:'Fictional reminder subject',cycleName:'Fictional native reminder cycle',cycleId:facts.cycleId,tenantScope:'00000000-0000-0000-0000-000000000000',epochs:facts.epochs,expiresAt:Date.parse(facts.startedAt)+60000,now:new Date(clock.value.checkedAt),words:null})}};
 }
 it('matches actual legacy preparation, notifications and consent outbox across independent equivalent tenants',async()=>{
  const legacy=await fixture(base),native=await fixture(await seedBase());await historical();const old=await queued(legacy),next=await queued(native);
  const before=new Date();const result=await dispatchNotifications(legacy.ctx),run=await notificationWorkerLifecycle(service).openRun(),projected=await notificationWorkerProjection(service).projectBatch(run,native.b.tenantId,25);
  expect(result).toEqual({processed:2,created:1});expect(projected).toEqual(result);
  const a=await prepared(old.id),b=await prepared(next.id);expect(b.tasks).toEqual(a.tasks);expect(b.tasks).toEqual([{key:'own_competency',count:1,closesAt:null}]);expect(b.mailWords).toEqual(a.mailWords);expect(b.mailWords).toEqual({subject:'Fictional: Fictional native reminder cycle',opening:'Please complete 1 task groups.'});
  for(const item of [a,b]){expect(new Date(item.preparedAt!).getTime()).toBeGreaterThanOrEqual(before.getTime());expect(new Date(item.preparedUntil!).getTime()).toBeGreaterThan(new Date(item.preparedAt!).getTime());expect(new Date(item.preparedUntil!).getTime()-new Date(item.preparedAt!).getTime()).toBeLessThanOrEqual(60000);expect(item.outcome).toBe('queued');}
  const normalize=async(f:Fixture,event:string)=>{const [notice]=await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,event));expect(notice.recipientEmploymentId).toBe(f.subject.employmentId);const [outbox]=await owner.db.select().from(s.notificationDelivery).where(eq(s.notificationDelivery.notificationId,notice.id));expect(outbox.recipientUserId).toBe(f.self.userId);return{kind:notice.kind,title:notice.title,body:notice.body,link:notice.linkPath,severity:notice.severity,delivery:{kind:outbox.kind,category:outbox.category,status:outbox.status,attempts:outbox.attempts}};};
  expect(await normalize(native,next.sourceEventId!)).toEqual(await normalize(legacy,old.sourceEventId!));
  expect((await owner.client`select count(*)::integer as n from pg_stat_activity where usename='ai_hr_notification_worker'`)[0].n).toBe(1);
  for(const table of ['assessment_admission','assessment_projection'])expect(await owner.client.unsafe(`select * from notification_worker_private.${table}`)).toHaveLength(0);
 },30000);
 it('observes real consent revocation and clears prepared data through the same canonical skip decision',async()=>{
  const f=await fixture(base);await historical();const row=await queued(f);
  await saveNotificationEmailPreferences(f.self,f.subject.employmentId,[],'en',null);await targetOnly(row.sourceEventId!);
  const run=await notificationWorkerLifecycle(service).openRun();expect(await notificationWorkerProjection(service).projectBatch(run,base.tenantId,25)).toEqual({processed:1,created:0});
  expect(await prepared(row.id)).toMatchObject({outcome:'noConsent',tasks:[],mailWords:null,preparedAt:null,preparedUntil:null});
  expect(await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,row.sourceEventId!))).toEqual([]);
 },30000);
 it('rechecks actual native epochs immediately before preparation and never projects stale task mail',async()=>{
  const f=await fixture(base);await historical();const row=await queued(f);await targetOnly(row.sourceEventId!);const run=await notificationWorkerLifecycle(service).openRun();
  await begin(run,base.tenantId,async(tx,batch)=>{
   const {proposal}=await validProposal(tx,batch,row.sourceEventId!);
   await owner.db.update(s.person).set({fullName:'Fictional source changed concurrently'}).where(eq(s.person.id,f.subject.personId));
   const [result]=await tx`select notification_worker.prepare_assessment(${batch}::uuid,${row.sourceEventId}::uuid,${tx.json(proposal)}::jsonb) as recipients`;expect(result.recipients).toEqual([]);
   await tx`select notification_worker.finish_event(${batch}::uuid,${row.sourceEventId}::uuid,'processed')`;
   expect((await tx`select * from notification_worker.finish_batch(${batch}::uuid)`)[0]).toEqual({processed:1,created:0});
  });
  expect(await prepared(row.id)).toMatchObject({outcome:'changed',tasks:[],mailWords:null,preparedAt:null,preparedUntil:null});
 },30000);
 it('rolls back native preparation, notice/outbox, receipts and counters when receipt settlement refuses',async()=>{
  const f=await fixture(base);await historical();const row=await queued(f);await targetOnly(row.sourceEventId!);const before=await prepared(row.id),run=await notificationWorkerLifecycle(service).openRun();
  await owner.client`create function public.assessment_receipt_fault() returns trigger language plpgsql as 'BEGIN RAISE EXCEPTION ''Fictional receipt refusal'' USING ERRCODE=''P0001'';END;'`;
  await owner.client`create trigger assessment_receipt_fault before update on public.notification_event_processing for each row execute function public.assessment_receipt_fault()`;
  try{await expect(notificationWorkerProjection(service).projectBatch(run,base.tenantId,25)).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='P0001');expect(await prepared(row.id)).toEqual(before);
   expect(await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,row.sourceEventId!))).toEqual([]);
   expect((await owner.client`select committed_batches,processed_events,created_notifications from notification_worker_private.run where run_id=${run}::uuid`)[0]).toEqual({committed_batches:0,processed_events:'0',created_notifications:'0'});
  }finally{await owner.client`drop trigger assessment_receipt_fault on public.notification_event_processing`;await owner.client`drop function public.assessment_receipt_fault()`;}
  expect(await notificationWorkerProjection(service).projectBatch(run,base.tenantId,25)).toEqual({processed:1,created:1});
 },30000);
 it('refuses forged preparation identities/epochs/extra fields, premature settlement and unrelated direct writes',async()=>{
  const f=await fixture(base);await historical();const row=await queued(f);await targetOnly(row.sourceEventId!);const before=await prepared(row.id),run=await notificationWorkerLifecycle(service).openRun();
  const refuse=(work:Promise<unknown>,code:string)=>expect(work).rejects.toSatisfy((error:unknown)=>pgSqlState(error)===code);
  await refuse(begin(run,base.tenantId,(tx,batch)=>tx`select notification_worker.finish_event(${batch}::uuid,${row.sourceEventId}::uuid,'processed')`),'42501');
  for(const change of ['epoch','identity']as const)await refuse(begin(run,base.tenantId,async(tx,batch)=>{const {proposal}=await validProposal(tx,batch,row.sourceEventId!);const wrong=change==='epoch'?{...proposal,tenantEpoch:proposal.tenantEpoch+1}:{...proposal,userId:randomUUID()};await tx`select notification_worker.prepare_assessment(${batch}::uuid,${row.sourceEventId}::uuid,${tx.json(wrong)}::jsonb)`;}),change==='epoch'?'42501':'22023');
  await refuse(begin(run,base.tenantId,async tx=>{await tx`select set_config('app.roles','super_admin',true),set_config('app.grants','[{"role":"super_admin","companyId":null}]',true)`;await tx`update public.performance_assessment_reminder_recipient set tasks='[]'::jsonb`;}),'42501');
  expect(await prepared(row.id)).toEqual(before);
  const accessible=await owner.client`select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname !~ '^pg_' and has_schema_privilege('ai_hr_notification_worker',n.oid,'USAGE') and has_function_privilege('ai_hr_notification_worker',p.oid,'EXECUTE')`;
  expect(accessible).toHaveLength(13);expect(accessible.every(row=>row.signature.startsWith('notification_worker.'))).toBe(true);
 },30000);
});
}
