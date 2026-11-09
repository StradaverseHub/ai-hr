import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {driverErrorFact,measuredPreflightLockAttemptMs,startMeasuredLockInterval} from './driver-shutdown.mjs';

export const measuredLockSampleLimit=4097; // 4096 accepted rows plus the existing overflow sentinel.
export const measuredDevelopmentLockUrl='postgres://postgres@127.0.0.1:5433/ai_hr_dev';
export const measuredDevelopmentLockApplication='aihr-measured-preflight-lock-observer';
const lifecycleTimeoutMs=5000;

export async function observeMeasuredLockConnection(sql){
 const [settings]=await sql`select current_setting('transaction_read_only')='on' as readonly,
  current_setting('statement_timeout')='400ms' as bounded
  where session_user='postgres' and current_user='postgres' and current_database()='ai_hr_dev'`;
 if(!settings?.readonly||!settings?.bounded)throw Error('Measured lock observer settings unavailable');
}

export async function observeDatabaseLockCore(sql,phase,accessLocks,categorized){
 const waitCategories=categorized?sql`,jsonb_build_object(
      'advisory',count(*) filter(where usename='ai_hr_app' and wait_event='advisory'),
      'transactionid',count(*) filter(where usename='ai_hr_app' and wait_event='transactionid'),
      'tuple',count(*) filter(where usename='ai_hr_app' and wait_event='tuple'),
      'relation',count(*) filter(where usename='ai_hr_app' and wait_event='relation'),
      'other',count(*) filter(where usename='ai_hr_app' and (wait_event is null or
       wait_event not in ('advisory','transactionid','tuple','relation')))
      ) as app_lock_wait_kinds`:sql``;
 const activity=await sql`select state,coalesce(wait_event_type,'CPU-or-ready') as kind,count(*)::int as connections,
      (count(*) filter(where usename='ai_hr_app'))::int as app_connections${waitCategories}
     from pg_stat_activity where datname=current_database() and backend_type='client backend' group by 1,2`;
 const activityCompletedMs=performance.now();
 const advisoryStartedMs=performance.now();
 const locks=await sql`select a.pid,case when not l.granted then pg_blocking_pids(a.pid) end as blockers,l.mode,l.granted,l.classid::text,l.objid::text,l.objsubid,
     a.usename='ai_hr_app' as app_session from pg_locks l join pg_stat_activity a on a.pid=l.pid
     where a.datname=current_database()and l.database=(select oid from pg_database where datname=current_database())
       and l.locktype='advisory' and (not l.granted or (
       concat(l.classid,':',l.objid,':',l.objsubid)=any(${accessLocks}::text[])
       and (${phase==='loaded'}::boolean or l.mode='ExclusiveLock')
       )) order by l.granted,a.pid limit 40`;
 return {activity,locks,activityCompletedMs,advisoryStartedMs,coreCompletedMs:performance.now()};
}

/** Run real serial probes on the observer thread, with no dependency on message delivery. */
export function startMeasuredPreflightProbes({sql,accessLocks,categorized,token,stopped,onProbe,onFailure}){
 let sequence=0;
 const timer=startMeasuredLockInterval(measuredPreflightLockAttemptMs,async timing=>{
  if(Atomics.load(stopped,0)!==0)return;
  const attributionStart=Atomics.load(token,0),startedMs=performance.now();
  let observation;
  try{observation=await observeDatabaseLockCore(sql,'preflight',accessLocks,categorized);}
  catch(reason){observation={failure:driverErrorFact(reason),coreCompletedMs:performance.now()};}
  const attributionEnd=Atomics.load(token,0);
  onProbe({sequence:++sequence,startedMs,timing,attributionStart,attributionEnd,...observation});
  if(sequence===measuredLockSampleLimit)void timer.stop();
 },onFailure);
 return {stop:timer.stop,samples:()=>sequence};
}

async function withinLifecycle(pending){
 const deadline=new AbortController();
 try{return await Promise.race([pending,delay(lifecycleTimeoutMs,false,{signal:deadline.signal})]);}
 finally{deadline.abort();}
}

/** The browser thread consumes probes but never schedules or completes them. */
export function createMeasuredPreflightObserver({url,accessLocks,categorized,token,onProbe,onFailure}){
 if(url!==measuredDevelopmentLockUrl)throw Error('Measured preflight lock observer database refused');
 const stopped=new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
 const worker=new Worker(new URL('./measured-lock-observer-worker.mjs',import.meta.url),{
  workerData:{url,accessLocks,categorized,token,stopped},env:{},execArgv:[],
 });
 const ready=Promise.withResolvers(),began=Promise.withResolvers(),exited=Promise.withResolvers();
 let state='starting',seen=0,stopRequested=false,closed=false,failure,stopping;
 function fail(){
  if(failure)return;
  failure=Error('Measured preflight lock observer failed to settle');
  ready.resolve(false);
  began.resolve(false);
  onFailure(failure);
 }
 worker.on('message',message=>{
  try{
   if(message.kind==='ready'&&state==='starting'&&message.timeOrigin===performance.timeOrigin){
    state='ready';ready.resolve(true);
   }else if(message.kind==='started'&&state==='start-requested'){
    state='started';began.resolve(true);
   }else if(message.kind==='probe'&&state==='started'&&!closed&&message.sequence===seen+1&&seen<measuredLockSampleLimit){
    seen++;onProbe(message);
   }else if(message.kind==='closed'&&stopRequested&&!closed&&message.samples===seen){
    closed=true;
   }else fail();
  }catch{fail();}
 });
 worker.on('messageerror',fail);
 worker.on('error',fail);
 worker.on('exit',code=>{
  if(code!==0||!closed)fail();
  exited.resolve(true);
 });
 return {
  async ready(){if(!(await withinLifecycle(ready.promise))){fail();throw failure;}},
  async start(){
   if(state!=='ready'||stopRequested||failure){fail();throw failure;}
   state='start-requested';
   worker.postMessage('start');
   if(!(await withinLifecycle(began.promise))){fail();throw failure;}
  },
  stop(){
   return stopping??=(async()=>{
    stopRequested=true;
    Atomics.store(stopped,0,1);
    worker.postMessage('stop');
    if(!(await withinLifecycle(exited.promise))){
     fail();
     void worker.terminate().catch(fail);
     await withinLifecycle(exited.promise);
    }
    if(failure)throw failure;
   })();
  },
 };
}
