/** Real child processes and native commits. No installed/package witness or transport. */
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as s from '../../../db/schema';
import {client} from '../../../db/client';
import {hireEmployee} from '../../../core/org';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../../../core/notification-email';
import {notificationWorkerLifecycle} from '../../../lib/notification-worker/lifecycle';
import {notificationWorkerAssessmentContract} from '../../../lib/notification-worker/projection';
import {notificationProcessBounds} from '../../../lib/notification-worker/process';
import {pgSqlState} from '../../../lib/db-error';
import {adminCtx,createAppUser,owner,resetDb,seedBase,setModule,type Base} from '../../harness';
import type {NotificationWorkerFixtureOwner} from './owner-fixture';
type Message={kind:string;run?:string;processed?:number;created?:number;reason?:string};
type Witness={child:ChildProcess;messages:Message[];closed:Promise<{code:number|null;signal:NodeJS.Signals|null}>;wait:(kind:string)=>Promise<Message>;output:()=>string};
export function registerNotificationProcessCases(fixtureOwner:NotificationWorkerFixtureOwner){
 describe.sequential('UNINSTALLED native notification process protocol',()=>{
  const sources=['lifecycle','projection','assessment','process'].map(name=>readFileSync('test/fixtures/notification-worker/'+name+'.sql','utf8'));
  const children=new Set<Witness>();let b:Base,employment:string,recipientUser:string;
  beforeAll(async()=>{await fixtureOwner.install(sources,3,notificationWorkerAssessmentContract);await captureTriggerCatalogue();},300000);
  beforeEach(async()=>{
   await owner.client`truncate notification_worker_private.run cascade`;
   await owner.client`update notification_worker_private.authority set active_run=null,enabled=true,max_run_batches=10`;
   await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');
   const email=randomUUID()+'@example.invalid',employee=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional process employee',primaryEmail:email},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
   employment=employee.employmentId;const user=await createAppUser(b.tenantId,employee.personId,'employee'),issuer='https://process-fixture.example.invalid/identity',subject=randomUUID();recipientUser=user;
   await owner.db.insert(s.appExternalIdentity).values({issuer,subject,appUserId:user});await saveNotificationEmailPolicy(adminCtx(b),['leave']);
   await saveNotificationEmailPreferences({...adminCtx(b),userId:user,personId:employee.personId,roles:['employee']},employment,['leave'],'en',{issuer,subject,email,emailVerified:true});
   await owner.client`update public.notification_event_processing set disposition='legacy-cursor',processed_at=now()`;
  });
  afterEach(async()=>{
   for(const witness of children){if(witness.child.exitCode===null&&witness.child.signalCode===null)witness.child.kill('SIGKILL');await witness.closed;expect(witness.output()).not.toMatch(/postgres(?:ql)?:\/\/|fictional.*key|password=/i);}
   children.clear();await fixtureOwner.finishCase();
  });
  afterAll(async()=>{await owner.client`select notification_worker_private.assert_process_profile()`;await fixtureOwner.clearStage();});
  async function captureTriggerCatalogue(){
   // Bounded owner catalogue evidence only, captured BEFORE profile assertions.
   // No worker credential, source payload, HR row or caller-supplied PASS flag.
   const rows=await owner.client`select t.oid,r.relnamespace::regnamespace::text as relation_schema,r.relname,t.tgname,t.tgisinternal,t.tgconstraint,c.contype,
    t.tgfoid::regprocedure::text as function_signature,t.tgtype,t.tgdeferrable,t.tginitdeferred,t.tgenabled,
    pg_get_triggerdef(t.oid,true)as definition,to_jsonb(t)as details
    from pg_trigger t join pg_class r on r.oid=t.tgrelid left join pg_constraint c on c.oid=t.tgconstraint
    where (r.relnamespace='notification_worker_private'::regnamespace or t.tgconstraint in(select c.oid from pg_constraint c join pg_class source ON source.oid=c.conrelid where c.contype='f' and source.relnamespace='notification_worker_private'::regnamespace)) order by r.relname,t.tgname limit 513`;
   const [counts]=await owner.client`select
    (select count(*)::int from notification_worker_private.process_contract where kind='trigger')as sealed,
    (select count(*)::int from pg_trigger t join pg_class r on r.oid=t.tgrelid where (r.relnamespace='notification_worker_private'::regnamespace or t.tgconstraint in(select c.oid from pg_constraint c join pg_class source ON source.oid=c.conrelid where c.contype='f' and source.relnamespace='notification_worker_private'::regnamespace)))as actual,
    (select count(*)::int from pg_trigger t join pg_class r on r.oid=t.tgrelid where r.relnamespace='notification_worker_private'::regnamespace and not t.tgisinternal)as custom,
    (select count(*)::int from notification_worker_private.process_contract c left join pg_trigger t on t.oid=c.object_oid where c.kind='trigger'and(t.oid is null or to_jsonb(t)is distinct from c.details))as changed_or_missing,
    (select count(*)::int from pg_trigger t join pg_class r on r.oid=t.tgrelid where (r.relnamespace='notification_worker_private'::regnamespace or t.tgconstraint in(select c.oid from pg_constraint c join pg_class source ON source.oid=c.conrelid where c.contype='f' and source.relnamespace='notification_worker_private'::regnamespace)) and not exists(select 1 from notification_worker_private.process_contract c where c.kind='trigger'and c.object_oid=t.oid))as unexpected`;
   const temp=realpathSync(process.env.RUNNER_TEMP!),directory=process.env.AIHR_FOCUSED_EVIDENCE_DIR??join(temp,'aihr-ci');
   expect([join(temp,'aihr-focused'),join(temp,'aihr-ci')]).toContain(directory);expect(realpathSync(directory)).toBe(directory);
   const report={kind:'OWNED_NATIVE_PROCESS_TRIGGER_CATALOGUE_NOT_RELEASE',source:process.env.AIHR_CI_HEAD,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,database:fixtureOwner.binding.database,counts,truncated:rows.length>512,triggers:Array.from(rows.slice(0,512))};
   const bytes=JSON.stringify(report,null,2)+'\n',bounded=Buffer.byteLength(bytes)<=2*1024*1024;
   writeFileSync(join(directory,'notification-process-trigger-catalogue.json'),bounded?bytes:JSON.stringify({...report,truncated:true,triggers:[],reason:'catalogue-byte-bound'})+'\n',{flag:'wx',mode:0o600});
   expect(bounded).toBe(true);
   expect(rows.length).toBeLessThanOrEqual(512);expect(counts.actual).toBe(counts.sealed);expect(counts.custom).toBe(3);expect(counts.changed_or_missing).toBe(0);expect(counts.unexpected).toBe(0);
   expect(rows.some(row=>row.tgisinternal&&row.contype==='f')).toBe(true);
   expect(rows.find(row=>row.tgname==='notification_batch_must_settle')).toMatchObject({tgisinternal:false,tgdeferrable:true,tginitdeferred:true,tgenabled:'O',tgtype:21});
  }
  async function launch(options:{pauseAfterCommit?:boolean;moduleKill?:string}={}){
   const child=spawn(process.execPath,['--import','tsx','test/fixtures/notification-worker/process-child.ts'],{cwd:process.cwd(),env:{PATH:process.env.PATH,TZ:'UTC',LANG:'en_US.UTF-8',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'StradaverseHub/ai-hr',MODULE_KILL:options.moduleKill??'',SETTING_KILL:''},stdio:['ignore','pipe','pipe','ipc']});
   const messages:Message[]=[],waiters=new Set<()=>void>();let output='';
   child.stdout?.on('data',value=>{output+=String(value);if(output.length>16384)child.kill('SIGKILL');});child.stderr?.on('data',value=>{output+=String(value);if(output.length>16384)child.kill('SIGKILL');});
   child.on('message',raw=>{if(raw&&typeof raw==='object'&&'kind'in raw&&typeof raw.kind==='string'){messages.push(raw as Message);for(const wake of waiters)wake();}});
   const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{resolve({code,signal});for(const wake of waiters)wake();});});
   const witness:Witness={child,messages,closed,output:()=>output,wait:kind=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{waiters.delete(check);reject(Error('Fixed process transition missing: '+kind));},5000);
    function check(){const message=messages.find(value=>value.kind===kind);if(message){clearTimeout(timer);waiters.delete(check);resolve(message);}else if(child.exitCode!==null||child.signalCode!==null){clearTimeout(timer);waiters.delete(check);reject(Error('Child exited before '+kind));}}
    waiters.add(check);check();
   })};children.add(witness);await witness.wait('ready');child.send({...fixtureOwner.processBinding(),kind:'start',pauseAfterCommit:options.pauseAfterCommit??false});
   const opened=await new Promise<Message|null>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.off('message',check);reject(Error('Child neither admitted nor refused its native run'));},5000);
    const finish=(message:Message|null)=>{clearTimeout(timer);child.off('message',check);resolve(message);};
    function check(){const message=messages.find(value=>value.kind==='opened');if(message)finish(message);}
    child.on('message',check);closed.then(()=>finish(null),reject);check();
   });
   if(opened){
    const record=await native(opened.run!);expect((await owner.client`select pid,backend_start,usename from pg_stat_activity where pid=${record.backend_pid}`)[0]).toEqual({pid:record.backend_pid,backend_start:record.backend_started_at,usename:'ai_hr_notification_worker'});
    expect((await owner.client`select count(*)::integer as n from pg_stat_activity where usename='ai_hr_notification_worker'`)[0].n).toBe(1);
    child.send({kind:'continue'});
   }
   return witness;
  }
  async function event(type='leave-request.approved',count=1){return owner.db.insert(s.domainEvent).values(Array.from({length:count},()=>({tenantId:b.tenantId,aggregateType:'fixture',aggregateId:randomUUID(),eventType:type,actorType:'system' as const,subjectEmploymentId:employment,payload:{}}))).returning();}
  async function state(){return{
   notices:await owner.client`select source_event_id,recipient_employment_id,kind,title,body,link_path,severity from public.notification where tenant_id=${b.tenantId}::uuid order by source_event_id`,
   deliveries:await owner.client`select source_event_id,status,attempts,category,recipient_user_id from public.notification_delivery where tenant_id=${b.tenantId}::uuid order by source_event_id`,
   receipts:await owner.client`select event_id,event_sequence,consumer,disposition,processed_at from public.notification_event_processing where tenant_id=${b.tenantId}::uuid order by event_sequence,consumer`,
   cursor:await owner.client`select * from public.notification_cursor where tenant_id=${b.tenantId}::uuid`,
  };}
  async function native(run:string){return(await owner.client`select r.run_id,r.backend_pid,r.backend_started_at,r.state,r.committed_batches,r.processed_events,r.created_notifications,j.job_key,j.outcome,j.result,j.error from notification_worker_private.run r join public.job_run j on j.id=r.run_id where r.run_id=${run}::uuid`)[0];}
  async function backendGone(run:string){
   const record=await native(run);expect(record.backend_started_at).toBeInstanceOf(Date);
   for(let tries=0;tries<200;tries++){if(!(await owner.client`select 1 from pg_stat_activity where pid=${record.backend_pid}` ).length)return;await new Promise(resolve=>setTimeout(resolve,10));}
   throw Error('Owned exact process backend remains present');
  }
  async function businessFacts(){
   const tables=['person','employment','app_user','role_assignment','payroll_batch','payslip','leave_ledger','tenant_setting','tenant_module','domain_event','notification','notification_delivery','notification_event_processing','notification_cursor','performance_assessment_reminder_recipient'];
   return owner.client.unsafe(tables.map(table=>`select '${table}'as name,md5(coalesce(jsonb_agg(to_jsonb(r)order by to_jsonb(r)::text),'[]'::jsonb)::text)as digest from public.${table} r`).join(' union all '));
  }
  async function recover(run:string){const before=await businessFacts();try{return await owner.client`select notification_worker_private.recover_abandoned_run(${run}::uuid)`;}finally{expect(await businessFacts()).toEqual(before);}}
  async function proofRun(witness:Witness){const message=await witness.wait('opened');expect(message.run).toMatch(/^[0-9a-f-]{36}$/);return message.run!;}
  /** Fixed owner-only trigger: same actual native receipt update after projection,
   * bounded try-lock/sleep avoids changing the worker's 300ms lock timeout. */
  async function pauseSettlement<T>(work:(release:()=>void,wait:()=>Promise<void>)=>Promise<T>){
   const key='process-fixture:'+randomUUID();let release!:()=>void;const done=new Promise<void>(resolve=>{release=resolve;});
   await owner.client.unsafe(`create function public.notification_process_fixture_pause() returns trigger language plpgsql as $pause$BEGIN FOR i IN 1..200 LOOP IF pg_try_advisory_xact_lock(hashtextextended('${key}',0)) THEN RETURN NEW;END IF;PERFORM pg_sleep(0.02);END LOOP;RAISE EXCEPTION 'Bounded fictional settlement pause' USING ERRCODE='55000';END$pause$`);
   await owner.client`revoke all on function public.notification_process_fixture_pause() from public,ai_hr_app,ai_hr_notification_worker`;
   await owner.client`create trigger notification_process_fixture_pause before update on public.notification_event_processing for each row when(new.disposition is not null and old.disposition is null) execute function public.notification_process_fixture_pause()`;
   const original=await owner.client`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as details from pg_proc p where p.oid='public.notification_process_fixture_pause()'::regprocedure`;
   const originalTrigger=await owner.client`select to_jsonb(t)as details from pg_trigger t where tgrelid='public.notification_event_processing'::regclass and tgname='notification_process_fixture_pause'`;
   let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});const hold=owner.client.begin(async tx=>{await tx`select pg_advisory_xact_lock(hashtextextended(${key},0))`;entered();await done;});
   const wait=async()=>{for(let tries=0;tries<200;tries++){if((await owner.client`select 1 from pg_stat_activity where usename='ai_hr_notification_worker' and wait_event='PgSleep' and query like '%notification_worker.finish_batch%'`).length)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Real receipt settlement did not reach its fixed pause');};
   try{await ready;return await work(release,wait);}finally{release();await hold;expect(await owner.client`select pg_get_functiondef(p.oid) as definition,to_jsonb(p) as details from pg_proc p where p.oid='public.notification_process_fixture_pause()'::regprocedure`).toEqual(original);expect(await owner.client`select to_jsonb(t)as details from pg_trigger t where tgrelid='public.notification_event_processing'::regclass and tgname='notification_process_fixture_pause'`).toEqual(originalTrigger);await owner.client`drop trigger notification_process_fixture_pause on public.notification_event_processing`;await owner.client`drop function public.notification_process_fixture_pause()`;}
  }
  it('runs a real dedicated LOGIN child to complete native nonempty projection, consent outbox, receipts and truthful counters',async()=>{
   const events=await event(undefined,2),w=await launch(),run=await proofRun(w);expect(await w.closed).toEqual({code:0,signal:null});await backendGone(run);
   expect(await native(run)).toMatchObject({state:'completed',outcome:'success',job_key:'notifications.project',processed_events:'2',created_notifications:'2',result:{batches:1,processed:2,created:2}});
   const facts=await state();expect(facts.notices).toHaveLength(2);expect(facts.notices.map(n=>n.source_event_id).sort()).toEqual(events.map(e=>e.id).sort());for(const row of facts.notices)expect(row).toMatchObject({recipient_employment_id:employment,kind:'leave.approved',title:'Leave approved',body:'Your leave request was approved.',link_path:'/me',severity:'info'});
   expect(facts.deliveries).toHaveLength(2);for(const row of facts.deliveries)expect(row).toMatchObject({category:'leave',status:'pending',attempts:0,recipient_user_id:recipientUser});
   expect(facts.receipts.filter(r=>events.some(e=>e.id===r.event_id)&&r.consumer==='notifications').map(r=>r.disposition)).toEqual(['processed','processed']);
   expect((await owner.client`select sum(processed)::text as processed,sum(created)::text as created from notification_worker_private.committed_batch where run_id=${run}::uuid`)[0]).toEqual({processed:'2',created:'2'});expect(w.messages.filter(m=>m.kind==='committed')).toEqual([{kind:'committed',run,processed:2,created:2}]);
  });
  it('SIGTERM drains the actual in-flight COMMIT then records interrupted with its native committed totals',async()=>{
   await event();let run='';await pauseSettlement(async(release,wait)=>{const w=await launch();run=await proofRun(w);await wait();w.child.kill('SIGTERM');release();expect(await w.closed).toEqual({code:2,signal:null});});await backendGone(run);
   expect(await native(run)).toMatchObject({state:'failed',outcome:'failed',error:'interrupted',processed_events:'1',created_notifications:'1',result:{batches:1,processed:1,created:1}});expect((await state()).notices).toHaveLength(1);
  });
  it.each(['before','after']as const)('SIGKILL %s COMMIT preserves exact truth; owner recovery and a fresh process never duplicate or replay a committed event',async phase=>{
   await event();const before=await state();let run='';
   if(phase==='before')await pauseSettlement(async(release,wait)=>{const w=await launch();run=await proofRun(w);await wait();w.child.kill('SIGKILL');expect(await w.closed).toEqual({code:null,signal:'SIGKILL'});release();});
   else{const w=await launch({pauseAfterCommit:true});run=await proofRun(w);await w.wait('committed');w.child.kill('SIGKILL');expect(await w.closed).toEqual({code:null,signal:'SIGKILL'});}
   await backendGone(run);const committed=phase==='after'?1:0;expect(await native(run)).toMatchObject({state:'running',outcome:'running',processed_events:String(committed),created_notifications:String(committed)});
   const stopped=await state();if(phase==='before')expect(stopped).toEqual(before);else expect(stopped.notices).toHaveLength(1);
   const refused=await launch();expect(await refused.closed).toEqual({code:1,signal:null});expect(refused.messages.some(m=>m.kind==='opened')).toBe(false);expect(await state()).toEqual(stopped);
   await recover(run);expect(await native(run)).toMatchObject({state:'failed',outcome:'failed',error:'abandoned',result:{batches:committed,processed:committed,created:committed}});expect(await state()).toEqual(stopped);
   const fresh=await launch({pauseAfterCommit:true}),next=await proofRun(fresh);await fresh.wait('committed');await expect(recover(run)).rejects.toSatisfy((error:unknown)=>pgSqlState(error)==='42501');expect((await owner.client`select active_run from notification_worker_private.authority`)[0].active_run).toBe(next);
   fresh.child.send({kind:'continue'});expect(await fresh.closed).toEqual({code:0,signal:null});expect(await native(next)).toMatchObject({processed_events:String(1-committed),created_notifications:String(1-committed)});expect((await state()).notices).toHaveLength(1);expect((await state()).deliveries).toHaveLength(1);
  });
  it('an unknown SQL refusal exits without retries or guessed terminal writes, preserving pending work for exact owner reconciliation',async()=>{
   await event();const before=await state();await owner.client`create function public.notification_process_refusal() returns trigger language plpgsql as 'BEGIN RAISE EXCEPTION ''Fixed process refusal'' USING ERRCODE=''P0001'';END'`;
   await owner.client`revoke all on function public.notification_process_refusal() from public,ai_hr_app,ai_hr_notification_worker`;await owner.client`create trigger notification_process_refusal before update on public.notification_event_processing for each row execute function public.notification_process_refusal()`;
   const original=await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as details from pg_proc p where p.oid='public.notification_process_refusal()'::regprocedure`,trigger=await owner.client`select to_jsonb(t)as details from pg_trigger t where tgrelid='public.notification_event_processing'::regclass and tgname='notification_process_refusal'`;
   let run='';try{const w=await launch();run=await proofRun(w);expect(await w.closed).toEqual({code:1,signal:null});expect(w.messages.filter(m=>m.kind==='admitting')).toHaveLength(1);expect(w.messages.filter(m=>m.kind==='committed')).toHaveLength(0);expect(await state()).toEqual(before);expect(await native(run)).toMatchObject({state:'running',outcome:'running',processed_events:'0'});}
   finally{expect(await owner.client`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as details from pg_proc p where p.oid='public.notification_process_refusal()'::regprocedure`).toEqual(original);expect(await owner.client`select to_jsonb(t)as details from pg_trigger t where tgrelid='public.notification_event_processing'::regclass and tgname='notification_process_refusal'`).toEqual(trigger);await owner.client`drop trigger notification_process_refusal on public.notification_event_processing`;await owner.client`drop function public.notification_process_refusal()`;}
   await backendGone(run);await recover(run);const fresh=await launch();expect(await fresh.closed).toEqual({code:0,signal:null});expect((await state()).notices).toHaveLength(1);
  });
  it.each(['unsupported','module-kill']as const)('keeps %s work pending without a success or fallback',async kind=>{
   await event(kind==='unsupported'?'leave-request.self-cancelled':undefined);const before=await state(),w=await launch({moduleKill:kind==='module-kill'?'notifications':''}),run=await proofRun(w);expect(await w.closed).toEqual({code:2,signal:null});expect(await state()).toEqual(before);
   expect(await native(run)).toMatchObject({state:'failed',outcome:'failed',error:kind==='unsupported'?'projection-unimplemented':'scope-changed',processed_events:'0',created_notifications:'0'});
  });
  it('enforces the fixed eight-batch process budget with actual committed receipts and remaining pending work',async()=>{
   const count=notificationProcessBounds.events*notificationProcessBounds.batches+1,events=await event(undefined,count),w=await launch(),run=await proofRun(w);expect(await w.closed).toEqual({code:2,signal:null});
   expect(await native(run)).toMatchObject({state:'failed',outcome:'failed',error:'budget-exhausted',committed_batches:8,processed_events:'160',created_notifications:'160'});expect(w.messages.filter(m=>m.kind==='committed')).toHaveLength(8);
   const facts=await state();expect(facts.notices).toHaveLength(160);expect(facts.receipts.filter(r=>r.consumer==='notifications'&&events.some(e=>e.id===r.event_id)&&r.disposition===null)).toHaveLength(1);
  });
  it('owner recovery cannot terminate a live child, bypass ACLs, clear a foreign job, or accept native receipt/counter/profile drift',async()=>{
   await event();const w=await launch({pauseAfterCommit:true}),run=await proofRun(w);await w.wait('committed');const before=await state();await expect(recover(run)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');expect(await state()).toEqual(before);
   const [acl]=await owner.client`select has_function_privilege('ai_hr_app','notification_worker_private.recover_abandoned_run(uuid)','EXECUTE')as app,has_function_privilege('ai_hr_notification_worker','notification_worker_private.recover_abandoned_run(uuid)','EXECUTE')as worker,exists(select 1 from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='notification_worker_private.recover_abandoned_run(uuid)'::regprocedure and a.grantee=0)as public_exec`;
   expect(acl).toEqual({app:false,worker:false,public_exec:false});const worker=fixtureOwner.connect();for(const db of [worker,client])await expect(db`select notification_worker_private.recover_abandoned_run(${run}::uuid)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
   w.child.kill('SIGKILL');await w.closed;await backendGone(run);await expect(recover(randomUUID())).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
   await owner.client`update notification_worker_private.run set processed_events=processed_events+1 where run_id=${run}::uuid`;await expect(recover(run)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');await owner.client`update notification_worker_private.run set processed_events=processed_events-1 where run_id=${run}::uuid`;
   const record=await native(run),[identity]=await owner.client`select pg_backend_pid()as pid,backend_start from pg_stat_activity where pid=pg_backend_pid()`;
   await owner.client`update notification_worker_private.run set backend_pid=${identity.pid},backend_started_at=${new Date(identity.backend_start.getTime()-1000)} where run_id=${run}::uuid`;await expect(recover(run)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');await owner.client`update notification_worker_private.run set backend_pid=${record.backend_pid},backend_started_at=${record.backend_started_at} where run_id=${run}::uuid`;
   await owner.client`alter function notification_worker_private.consumer(uuid)cost 101`;try{await expect(recover(run)).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');}finally{await owner.client`alter function notification_worker_private.consumer(uuid)cost 100`;}
   expect(await state()).toEqual(before);await recover(run);expect(await state()).toEqual(before);
  });
  it('retains every original fail_run refusal and refuses a changed process profile before admitting a new native run',async()=>{
   const worker=fixtureOwner.connect(),api=notificationWorkerLifecycle(worker),run=await api.openRun();
   await expect(worker`select notification_worker.fail_run(${run}::uuid,'invented-success')`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='22023');await api.failRun(run,'interrupted');expect(await native(run)).toMatchObject({state:'failed',outcome:'failed',error:'interrupted'});
   await owner.client`alter function notification_worker_private.consumer(uuid)cost 101`;try{const w=await launch();expect(await w.closed).toEqual({code:1,signal:null});expect(w.messages.some(m=>m.kind==='opened')).toBe(false);}finally{await owner.client`alter function notification_worker_private.consumer(uuid)cost 100`;}
   const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
   const [internal]=await owner.client`select t.oid,r.relnamespace::regnamespace::text as schema,r.relname,t.tgname,to_jsonb(t)as details from pg_trigger t join pg_class r on r.oid=t.tgrelid join pg_constraint c on c.oid=t.tgconstraint where r.relnamespace='notification_worker_private'::regnamespace and t.tgisinternal and c.contype='f' and t.tgenabled='O' order by t.oid limit 1`;
   expect(internal).toBeTruthy();
   const [referenced]=await owner.client`select t.oid,r.relnamespace::regnamespace::text as schema,r.relname,t.tgname,to_jsonb(t)as details from pg_trigger t join pg_class r on r.oid=t.tgrelid join pg_constraint c on c.oid=t.tgconstraint join pg_class source on source.oid=c.conrelid where r.relnamespace<>'notification_worker_private'::regnamespace and source.relnamespace='notification_worker_private'::regnamespace and t.tgisinternal and c.contype='f' and t.tgenabled='O' order by t.oid limit 1`;
   expect(referenced).toBeTruthy();
   const [custom]=await owner.client`select t.oid,r.relnamespace::regnamespace::text as schema,r.relname,t.tgname,to_jsonb(t)as details from pg_trigger t join pg_class r on r.oid=t.tgrelid where t.tgrelid='notification_worker_private.batch'::regclass and t.tgname='notification_batch_must_settle'`;
   expect(custom).toBeTruthy();
   for(const trigger of [internal,referenced,custom]){
    // Hostile owner-only catalogue mutation. No data operation/admission is
    // attempted while a guard is disabled; exact metadata is restored in finally.
    const table=quote(trigger.schema)+'.'+quote(trigger.relname),name=quote(trigger.tgname);
    await owner.client.unsafe('alter table '+table+' disable trigger '+name);
    try{await expect(owner.client`select notification_worker_private.assert_process_profile()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');}
    finally{await owner.client.unsafe('alter table '+table+' enable trigger '+name);expect((await owner.client`select to_jsonb(t)as details from pg_trigger t where oid=${trigger.oid}::oid`)[0].details).toEqual(trigger.details);}
    await owner.client`select notification_worker_private.assert_process_profile()`;
   }
   await owner.client`create trigger notification_process_unexpected before insert on notification_worker_private.run for each row execute function notification_worker_private.process_start_guard()`;
   const [added]=await owner.client`select to_jsonb(t)as details from pg_trigger t where tgrelid='notification_worker_private.run'::regclass and tgname='notification_process_unexpected'`;
   try{await expect(owner.client`select notification_worker_private.assert_process_profile()`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');}
   finally{expect((await owner.client`select to_jsonb(t)as details from pg_trigger t where tgrelid='notification_worker_private.run'::regclass and tgname='notification_process_unexpected'`)[0]).toEqual(added);await owner.client`drop trigger notification_process_unexpected on notification_worker_private.run`;}
   await owner.client`select notification_worker_private.assert_process_profile()`;
   // Preserve actual native FK enforcement, not just an enabled catalogue flag.
   await expect(owner.client`insert into notification_worker_private.committed_event(batch_id,event_id,event_sequence,disposition,created)values(${randomUUID()}::uuid,${randomUUID()}::uuid,1,'ignored',0)`).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='23503');
   expect((await owner.client`select count(*)::int as n from notification_worker_private.run`)[0].n).toBe(1);
  });
 });
}
