import {rejectedAssessmentTaskChanges,rejectedAssessmentWords} from './assessment-task-shape-cases';
import {assertAssessmentParserContract} from './assessment-parser-contract';
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
import {assessmentReminderProjectionWork,assessmentReminderProjectionExpiry} from '../../../packs/performance/onehr/reminder-projection';
import {assessmentReminderPreparationValue} from '../../../packs/performance/onehr/reminder-preparation';
import {todayInKualaLumpur} from '../../../lib/hr-date';
import {pgSqlState} from '../../../lib/db-error';
import {assessmentReminderTaskKeys,assessmentReminderTaskSchema,assessmentPreparedWordsSchema,assessmentReminderMailSchema} from '../../../lib/assessment-reminder-mail';
import {notificationWorkerLifecycle} from '../../../lib/notification-worker/lifecycle';
import {notificationWorkerProjection,notificationWorkerAssessmentContract} from '../../../lib/notification-worker/projection';
import {nativeAssessmentReminderFacts,prepareNativeAssessmentReminder} from '../../../lib/notification-worker/reminder';
import {createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from '../../harness';
import type {NotificationWorkerFixtureOwner} from './owner-fixture';
export function registerNotificationAssessmentCases(fixtureOwner:NotificationWorkerFixtureOwner){
describe.sequential('native assessment reminder preparation (stage3)',()=>{
 const sources=['lifecycle','projection','assessment'].map(name=>readFileSync('test/fixtures/notification-worker/'+name+'.sql','utf8'));
 let service:ReturnType<NotificationWorkerFixtureOwner['connect']>,base:Base;
 beforeAll(async()=>{
  // Native grammar is intentionally pinned to the actual locked canonical parser.
  // A parser upgrade requires a reviewed shape/positive/negative parity refresh.
  assertAssessmentParserContract();
  await fixtureOwner.install(sources,3,notificationWorkerAssessmentContract);
 },300000);
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
  return{facts,proposal:{kind:'prepare',...assessmentReminderPreparationValue({actor,name:'Fictional reminder subject',cycleName:'Fictional native reminder cycle',cycleId:facts.cycleId,tenantScope:'00000000-0000-0000-0000-000000000000',epochs:facts.epochs,expiresAt:assessmentReminderProjectionExpiry(new Date(facts.startedAt),facts.graph,facts.moduleExpiry?new Date(facts.moduleExpiry):null),now:new Date(clock.value.checkedAt),words:null})}};
 }
 async function assertGlobalCursor(tenantId:string,sourceEvent?:string){
  const [expected]=sourceEvent?await owner.client`select sequence from public.domain_event where id=${sourceEvent}::uuid and tenant_id=${tenantId}::uuid`:
   await owner.client`select max(sequence) as sequence from public.domain_event where tenant_id=${tenantId}::uuid`;
  if(!expected?.sequence)throw Error('Actual committed source sequence required');
  const [cursor]=await owner.client`select last_sequence,assessment_last_sequence from public.notification_cursor where tenant_id=${tenantId}::uuid`;
  expect(cursor).toEqual({last_sequence:String(expected.sequence),assessment_last_sequence:null});
 }
 async function preparationEffects(row:Awaited<ReturnType<typeof queued>>,run:string){
  const tenant=row.tenantId,event=row.sourceEventId!;
  return{
   preparation:await prepared(row.id),
   notices:await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,event)),
   outbox:await owner.db.select().from(s.notificationDelivery).where(eq(s.notificationDelivery.sourceEventId,event)),
   receipts:await owner.client`select * from public.notification_event_processing where event_id=${event}::uuid order by consumer`,
   cursor:await owner.client`select * from public.notification_cursor where tenant_id=${tenant}::uuid`,
   counters:await owner.client`select committed_batches,processed_events,created_notifications from notification_worker_private.run where run_id=${run}::uuid`,
   batches:await owner.client`select batch_id from notification_worker_private.batch where run_id=${run}::uuid`,
   admissions:await owner.client`select a.* from notification_worker_private.assessment_admission a join notification_worker_private.batch b on b.batch_id=a.batch_id where b.run_id=${run}::uuid`,
  };
 }
 it('matches actual legacy preparation, notifications and consent outbox across independent equivalent tenants',async()=>{
  const legacy=await fixture(base),native=await fixture(await seedBase());await historical();const old=await queued(legacy),next=await queued(native);
  const before=new Date();const result=await dispatchNotifications(legacy.ctx),run=await notificationWorkerLifecycle(service).openRun(),projected=await notificationWorkerProjection(service).projectBatch(run,native.b.tenantId,25);
  expect(result).toEqual({processed:2,created:1});expect(projected).toEqual(result);
  const a=await prepared(old.id),b=await prepared(next.id);expect(b.tasks).toEqual(a.tasks);expect(b.tasks).toEqual([{key:'own_competency',count:1,closesAt:null}]);expect(b.mailWords).toEqual(a.mailWords);expect(b.mailWords).toEqual({subject:'Fictional: Fictional native reminder cycle',opening:'Please complete 1 task groups.'});
  for(const item of [a,b]){expect(new Date(item.preparedAt!).getTime()).toBeGreaterThanOrEqual(before.getTime());expect(new Date(item.preparedUntil!).getTime()).toBeGreaterThan(new Date(item.preparedAt!).getTime());expect(new Date(item.preparedUntil!).getTime()-new Date(item.preparedAt!).getTime()).toBeLessThanOrEqual(60000);expect(item.outcome).toBe('queued');}
  const normalize=async(f:Fixture,event:string)=>{const [notice]=await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,event));expect(notice.recipientEmploymentId).toBe(f.subject.employmentId);const [outbox]=await owner.db.select().from(s.notificationDelivery).where(eq(s.notificationDelivery.notificationId,notice.id));expect(outbox.recipientUserId).toBe(f.self.userId);return{kind:notice.kind,title:notice.title,body:notice.body,link:notice.linkPath,severity:notice.severity,delivery:{kind:outbox.kind,category:outbox.category,status:outbox.status,attempts:outbox.attempts}};};
  expect(await normalize(native,next.sourceEventId!)).toEqual(await normalize(legacy,old.sourceEventId!));
  await assertGlobalCursor(native.b.tenantId);await assertGlobalCursor(legacy.b.tenantId);
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
 it('refuses noncanonical JSON tasks, dates, epochs, skip shapes and oversized task wire without any committed preparation or projection effect',async()=>{
  const f=await fixture(base);await historical();const row=await queued(f);await targetOnly(row.sourceEventId!);const run=await notificationWorkerLifecycle(service).openRun(),before=await preparationEffects(row,run);
  type Proposal=Awaited<ReturnType<typeof validProposal>>['proposal'];

  const changes:((p:Proposal)=>Record<string,unknown>)[]=rejectedAssessmentTaskChanges.map(change=>p=>{
   const tasks=[{...p.tasks[0],...change}];expect(assessmentReminderTaskSchema.safeParse(tasks[0]).success,'Fixed malformed task '+JSON.stringify(change)).toBe(false);return{...p,tasks};
  });
  for(const key of ['preparedAt','preparedUntil'])for(const value of ['infinity','tomorrow','now','2026-02-29T12:00:00Z','2026-01-01T12:00:00+24:00','0000-02-29T12:00:00Z','2026-01-01T12:00:00+23:59',null])changes.push(p=>({...p,[key]:value}));
  for(const key of ['tenantEpoch','cycleEpoch'])for(const value of ['1','NaN',null,true,-1,1.5,9007199254740992])changes.push(p=>({...p,[key]:value}));
  for(const mailWords of rejectedAssessmentWords){expect(assessmentPreparedWordsSchema.safeParse(mailWords).success).toBe(false);changes.push(p=>({...p,mailWords}));}
  // Canonical ISO syntax permits arbitrarily many fractional digits. The native
  // wire ceiling is a separate operational bound, not a canonical-shape claim.
  changes.push(p=>{const task={...p.tasks[0],closesAt:'2026-01-01T00:00:00.'+'0'.repeat(66000)+'Z'};expect(assessmentReminderTaskSchema.safeParse(task).success).toBe(true);return{...p,tasks:[task]};});
  changes.push(()=>({kind:'skip',other:'changed'}),()=>({kind:'skip',outcome:null}),()=>({kind:'skip',outcome:'changed',extra:true}));
  for(const change of changes){
   await expect(begin(run,base.tenantId,async(tx,batch)=>{const {proposal}=await validProposal(tx,batch,row.sourceEventId!);
    await tx`select notification_worker.prepare_assessment(${batch}::uuid,${row.sourceEventId}::uuid,${tx.json(change(proposal))}::jsonb)`;
   })).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='22023');
   expect(await preparationEffects(row,run)).toEqual(before);
  }
  // Parser validity alone does not override the canonical table's byte limits.
  // Isolate each overflow below the aggregate envelope and require deliberate
  // API refusal (22023), not a later storage constraint exception (23514).
  for(const target of ['tasks','words'] as const){
   await expect(begin(run,base.tenantId,async(tx,batch)=>{const {proposal}=await validProposal(tx,batch,row.sourceEventId!);
    const tasks=target==='tasks'?assessmentReminderTaskKeys.map((key,index)=>({key,count:index+1,closesAt:null,people:['\u0001'.repeat(200),'\u0002'.repeat(200),'\u0003'.repeat(200)]})):proposal.tasks;
    const words=target==='words'?{subject:'\u0001'.repeat(20000),opening:'😀'.repeat(30000)}:null;
    expect(assessmentReminderMailSchema.safeParse({tasks,words}).success).toBe(true);
    const decision={...proposal,tasks,mailWords:words};
    // Measure the actual complete wire document, including its JSON null. Passing
    // null as a separate SQL parameter instead yields SQL NULL, not JSON null.
    const [wire]=await tx`select octet_length((payload->'tasks')::text) as task_bytes,
     octet_length((payload->'mailWords')::text) as word_bytes,octet_length(payload::text) as decision_bytes
     from (select ${tx.json(decision)}::jsonb as payload) encoded`;
    expect(wire.decision_bytes).toBeLessThan(260000);
    if(target==='tasks'){expect(wire.task_bytes).toBeGreaterThan(20000);expect(wire.word_bytes).toBeLessThanOrEqual(220000);}
    else{expect(wire.word_bytes).toBeGreaterThan(220000);expect(wire.task_bytes).toBeLessThanOrEqual(20000);}
    await tx`select notification_worker.prepare_assessment(${batch}::uuid,${row.sourceEventId}::uuid,${tx.json(decision)}::jsonb)`;
   })).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='22023');
   expect(await preparationEffects(row,run)).toEqual(before);
  }
 },30000);
 const wireEdges=[{label:'Unicode code-point boundaries and JS trim',tasks:[
   {key:'own_competency',count:1,closesAt:null},
   {key:'own_competency',count:1000000,closesAt:'2096-02-29T12:34:56Z'},
   {key:'own_competency',count:2,closesAt:'2000-02-29T00:00:00.123456789+23:59'},
   {key:'own_competency',count:3,closesAt:'0000-02-29T00:00:00-23:59'},
   {key:'own_competency',count:4,closesAt:'9999-12-31T23:59:59.9+00:00',people:[' \u00a0\ufeffFictional 😀\u202f\n','😀'.repeat(200),'e\u0301'.repeat(100)]},
  ],words:{subject:'😀'.repeat(20000),opening:'😀'.repeat(30000)}},
  {label:'all sixteen task groups at maximum logical cardinalities within storage bounds',tasks:assessmentReminderTaskKeys.map((key,index)=>({key,count:index+1,closesAt:null,people:['a'.repeat(200),'b'.repeat(200),'c'.repeat(200)]})),
   words:{subject:'s'.repeat(20000),opening:'o'.repeat(30000)}}];
 for(const {label,tasks,words} of wireEdges)it('persists '+label+' through a real LOGIN then parses the canonical mail consumer',async()=>{
  const f=await fixture(base);await historical();const row=await queued(f);await targetOnly(row.sourceEventId!);const run=await notificationWorkerLifecycle(service).openRun();
  // This is typed-wire qualification, not native proof of caller-proposed task truth.
  const expected=assessmentReminderMailSchema.parse({tasks,words});
  await begin(run,base.tenantId,async(tx,batch)=>{const {proposal}=await validProposal(tx,batch,row.sourceEventId!);
   const [wire]=await tx`select octet_length((${tx.json(tasks)}::jsonb)::text) as task_bytes,
    octet_length((${tx.json(words)}::jsonb)::text) as word_bytes,
    octet_length((${tx.json({...proposal,tasks,mailWords:words})}::jsonb)::text) as decision_bytes`;
   expect(wire.task_bytes).toBeLessThanOrEqual(20000);expect(wire.word_bytes).toBeLessThanOrEqual(220000);expect(wire.decision_bytes).toBeLessThanOrEqual(260000);
   // Preserve raw JSON numeric decimal forms; canonical numbers do not require an
   // integer-only lexical spelling. Both epochs still equal native captured facts.
   const tenantNumber=String(proposal.tenantEpoch)+'.0',cycleNumber=String(proposal.cycleEpoch)+'.0';
   // Force text parameter transport before JSON parsing. A raw string inferred as
   // jsonb is JSON-stringified by this client's normal JSON serializer.
   const [encoding]=await tx`select jsonb_typeof((${tenantNumber}::text)::jsonb) as tenant_type,jsonb_typeof((${cycleNumber}::text)::jsonb) as cycle_type`;
   expect(encoding).toEqual({tenant_type:'number',cycle_type:'number'});
   const [result]=await tx`select notification_worker.prepare_assessment(${batch}::uuid,${row.sourceEventId}::uuid,
    jsonb_set(jsonb_set(jsonb_set(${tx.json({...proposal,tasks,mailWords:words})}::jsonb,'{tasks,0,count}','1.0'::jsonb),
     '{tenantEpoch}',(${tenantNumber}::text)::jsonb),'{cycleEpoch}',(${cycleNumber}::text)::jsonb)) as recipients`;
   expect(result.recipients).toEqual([f.subject.employmentId]);
   const rendered={severity:'action',title:'Assessment work waiting on you',body:'Open your performance workspace to complete your pending review tasks.',linkPath:'/me/performance'};
   await tx`select * from notification_worker.project(${batch}::uuid,${row.sourceEventId}::uuid,'performance.reminder',${f.subject.employmentId}::uuid,${tx.json(rendered)}::jsonb,'performance')`;
   await tx`select notification_worker.finish_event(${batch}::uuid,${row.sourceEventId}::uuid,'processed')`;
   expect((await tx`select * from notification_worker.finish_batch(${batch}::uuid)`)[0]).toEqual({processed:1,created:1});
  });
  const persisted=await prepared(row.id);expect({tasks:persisted.tasks,words:persisted.mailWords}).toEqual(expected);
  expect(assessmentReminderMailSchema.parse({tasks:persisted.tasks,words:persisted.mailWords})).toEqual(expected);
  expect(persisted.outcome).toBe('queued');
  if(label==='Unicode code-point boundaries and JS trim')expect(persisted.tasks[4].people).toEqual(['Fictional 😀','😀'.repeat(200),'e\u0301'.repeat(100)]);
  else{expect(persisted.tasks).toHaveLength(16);expect(persisted.tasks[15].people).toEqual(['a'.repeat(200),'b'.repeat(200),'c'.repeat(200)]);}
  await assertGlobalCursor(base.tenantId,row.sourceEventId!);
  const effects=await preparationEffects(row,run);expect(effects.notices).toHaveLength(1);expect(effects.outbox).toHaveLength(1);expect(effects.batches).toEqual([]);expect(effects.admissions).toEqual([]);
 },30000);
});
}
