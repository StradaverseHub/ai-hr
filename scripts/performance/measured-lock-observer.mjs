import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {driverErrorFact,startMeasuredPreflightLockInterval} from './driver-shutdown.mjs';
import {originalAuditQueryCategory} from './lock-sample-attribution.mjs';

export const measuredLockSampleLimit=4097; // 4096 accepted rows plus the existing overflow sentinel.
export const measuredDevelopmentLockUrl='postgres://postgres@127.0.0.1:5433/ai_hr_dev';
export const measuredDevelopmentLockApplication='aihr-measured-preflight-lock-observer';
const lifecycleTimeoutMs=5000;

export async function observeMeasuredLockConnection(sql){
 const [settings]=await sql`select current_setting('transaction_read_only')='on' as readonly,
  current_setting('statement_timeout')='400ms' as bounded,pg_backend_pid() as pid
  where session_user='postgres' and current_user='postgres' and current_database()='ai_hr_dev'`;
 if(!settings?.readonly||!settings?.bounded||!Number.isSafeInteger(settings.pid)||settings.pid<=0)
  throw Error('Measured lock observer settings unavailable');
 return settings.pid;
}

function appWaitCategories(sql,categorized){
 return categorized?sql`,jsonb_build_object(
      'advisory',count(*) filter(where usename='ai_hr_app' and wait_event='advisory'),
      'transactionid',count(*) filter(where usename='ai_hr_app' and wait_event='transactionid'),
      'tuple',count(*) filter(where usename='ai_hr_app' and wait_event='tuple'),
      'relation',count(*) filter(where usename='ai_hr_app' and wait_event='relation'),
      'other',count(*) filter(where usename='ai_hr_app' and (wait_event is null or
       wait_event not in ('advisory','transactionid','tuple','relation')))
      ) as app_lock_wait_kinds`:sql``;
}

export async function observeDatabaseLockCore(sql,phase,accessLocks,categorized){
 const waitCategories=appWaitCategories(sql,categorized);
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

const activityFields=['state','kind','connections','app_connections'];
const categoryFields=['advisory','transactionid','tuple','relation','other'];
const lockFields=['pid','blockers','mode','granted','classid','objid','objsubid','app_session'];
const classifiedLockFields=[...lockFields,'category'];
const validCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1024;
const validPid=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647;
const validOid=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,9})$/.test(value)&&Number(value)<=4294967295;
const exactKeys=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===keys.length&&keys.every(key=>Object.hasOwn(row,key));

/** A malformed aggregate cannot turn into a clean sample. Only closed native fields cross the worker boundary. */
function decodeCombinedPreflightLocks(rows,categorized){
 const [row]=rows;
 if(rows.length!==1||!exactKeys(row,['activity','locks']))throw Error('Combined lock probe envelope refused');
 const {activity,locks}=row;
 const fields=categorized?[...activityFields,'app_lock_wait_kinds']:activityFields;
 if(!Array.isArray(activity)||activity.length<1||activity.length>128||!activity.every(entry=>{
  if(!exactKeys(entry,fields)||!(entry.state===null||typeof entry.state==='string'&&/^[a-z][a-z ()-]{0,31}$/.test(entry.state))
   ||typeof entry.kind!=='string'||!/^[A-Za-z][A-Za-z-]{0,31}$/.test(entry.kind)
   ||!validCount(entry.connections)||entry.connections===0||!validCount(entry.app_connections)||entry.app_connections>entry.connections)return false;
  if(!categorized)return true;
  const counts=entry.app_lock_wait_kinds;
  return exactKeys(counts,categoryFields)&&categoryFields.every(key=>validCount(counts[key]))
   &&categoryFields.reduce((total,key)=>total+counts[key],0)===entry.app_connections;
 }))throw Error('Combined lock probe activity census refused');
 if(!Array.isArray(locks)||locks.length>40||!locks.every(entry=>(exactKeys(entry,classifiedLockFields)||exactKeys(entry,lockFields))
  &&validPid(entry.pid)&&entry.pid>0
  &&(entry.mode==='ExclusiveLock'||entry.mode==='ShareLock')&&typeof entry.granted==='boolean'
  &&validOid(entry.classid)&&validOid(entry.objid)&&(entry.objsubid===1||entry.objsubid===2)
  &&(entry.app_session===null||typeof entry.app_session==='boolean')
  &&(entry.granted?entry.blockers===null:Array.isArray(entry.blockers)&&entry.blockers.length<=1024&&entry.blockers.every(validPid)))){
  throw Error('Combined lock probe advisory census refused');
 }
 return {activity,locks:locks.map(row=>({...row,category:originalAuditQueryCategory(row.category)}))};
}

async function observeCombinedPreflightLocks(sql,accessLocks,auditLocks,categorized){
 const waitCategories=appWaitCategories(sql,categorized);
 const knownAudit=sql`concat(l.classid,':',l.objid,':',l.objsubid)=any(${auditLocks}::text[])`;
 // The bounded query prefix stays in PostgreSQL. A label describes the observed statement, not its lock acquisition site.
 const rows=await sql`with backends as materialized (
   select pid,backend_type,state,wait_event_type,wait_event,usename,
    case when usename='ai_hr_app' then left(query,160) end as app_query
   from pg_stat_activity where datname=current_database()
  ), activity as materialized (
   select state,coalesce(wait_event_type,'CPU-or-ready') as kind,count(*)::int as connections,
    (count(*) filter(where usename='ai_hr_app'))::int as app_connections${waitCategories}
   from backends where backend_type='client backend' group by 1,2
  ), advisory as materialized (
   select a.pid,case when not l.granted then pg_blocking_pids(a.pid) end as blockers,l.mode,l.granted,
    l.classid::text as classid,l.objid::text as objid,l.objsubid,
    a.usename='ai_hr_app' as app_session,
    case when ${knownAudit} then case
     when a.app_query ~* '^[[:space:]]*select[[:space:]]+app[.]append_auth_event[[:space:]]*[(]' then 'auth-audit-append'
     when a.app_query ~* '^[[:space:]]*select[[:space:]]+app[.]reward_access_observe[[:space:]]*[(]' then 'rewards-access-observe'
     when a.app_query ~* '^[[:space:]]*insert[[:space:]]+into[[:space:]]+((public|"public")[.])?(domain_event|"domain_event")([[:space:]]|[(])' then 'audit-append'
     else 'unknown' end else 'unknown' end as category
   from pg_locks l join backends a on a.pid=l.pid
   where l.database=(select oid from pg_database where datname=current_database())
    and l.locktype='advisory' and (not l.granted or (
     (concat(l.classid,':',l.objid,':',l.objsubid)=any(${accessLocks}::text[]) or ${knownAudit}) and l.mode='ExclusiveLock'
    )) order by l.granted,(l.granted and ${knownAudit}),a.pid limit 40
  ) select coalesce((select jsonb_agg(to_jsonb(a)) from activity a),'[]'::jsonb) as activity,
    coalesce((select jsonb_agg(to_jsonb(l) order by l.granted,l.pid) from advisory l),'[]'::jsonb) as locks`;
 const coreCompletedMs=performance.now();
 return {...decodeCombinedPreflightLocks(rows,categorized),coreCompletedMs,probeMode:'combined-statement'};
}

/** Run real probes on the observer thread, with no dependency on message delivery. */
export function startMeasuredPreflightProbes({sql,rescueSql=undefined,accessLocks,auditLocks=/** @type {string[]} */ ([]),categorized,token,stopped,onProbe,onFailure}){
 let sequence=0;
 const connections=rescueSql?[sql,rescueSql]:[sql];
 const timer=startMeasuredPreflightLockInterval(measuredLockSampleLimit,connections.length,async (slot,timing)=>{
  if(Atomics.load(stopped,0)!==0)return;
  const attributionStart=Atomics.load(token,0),startedMs=performance.now();
  let observation;
  try{observation=await observeCombinedPreflightLocks(connections[slot],accessLocks,auditLocks,categorized);}
  catch(reason){observation={failure:driverErrorFact(reason),coreCompletedMs:performance.now()};}
  const attributionEnd=Atomics.load(token,0);
  onProbe({sequence:++sequence,startedMs,timing,attributionStart,attributionEnd,...observation});
 },onFailure);
 return {stop:timer.stop,samples:()=>sequence};
}

async function withinLifecycle(pending){
 const deadline=new AbortController();
 try{return await Promise.race([pending,delay(lifecycleTimeoutMs,false,{signal:deadline.signal})]);}
 finally{deadline.abort();}
}

/** The browser thread consumes probes but never schedules or completes them. */
export function createMeasuredPreflightObserver({url,accessLocks,auditLocks=/** @type {string[]} */ ([]),categorized,token,onProbe,onFailure}){
 if(url!==measuredDevelopmentLockUrl)throw Error('Measured preflight lock observer database refused');
 const stopped=new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
 const worker=new Worker(new URL('./measured-lock-observer-worker.mjs',import.meta.url),{
  workerData:{url,accessLocks,auditLocks,categorized,token,stopped},env:{},execArgv:[],
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
