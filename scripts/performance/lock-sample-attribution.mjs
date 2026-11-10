/** Optional fictional-run diagnostic. The original blocking sample is already retained. */
const families=new Set(['access-configuration','ai-control','audit-chain','employment','payroll-history','pay-component-catalog','unclassified']);
const modes=new Set(['ShareLock','ExclusiveLock']);
const categories=new Set(['advisory-exclusive','advisory-shared','rewards-authority','rewards-library','rewards-company','audit-append','ai-action-pause','unknown']);
const originalAuditCategories=new Set(['auth-audit-append','rewards-access-observe','audit-append']);
const states=new Set(['granted','queued']);
const maxEdges=8;
const lockKey=row=>row.classid+':'+row.objid+':'+row.objsubid;
const lockFamily=(key,labels)=>{
 const family=labels.get(key)?.split(':',1)[0];
 return families.has(family)?family:'unclassified';
};
export const originalAuditQueryCategory=value=>originalAuditCategories.has(value)?value:'unknown';

const preflightWorkloads=new Set(['ai-baseline','org-explorer','personnel-switcher','payroll-readiness',
 'movement','payroll-register','saved-reports','mixed-workflows','payroll-close-pair','attendance-rejection',
 'personnel-profile','letter-draft','performance-rewards-drafts','audit-verification','assistant-compatibility']);

/** Mark only serial driver scopes. A new token on exit detects a nested stage that came and went mid-probe. */
export function createPreflightLockWorkload(onChange=()=>{}){
 let current=Object.freeze({stage:null});
 return {
  snapshot:()=>current,
  stageAfter:started=>started===current?current.stage:'transition',
  async within(stage,work){
   if(!preflightWorkloads.has(stage))return work();
   const prior=current.stage;
   current=Object.freeze({stage});
   onChange(stage);
   try{return await work();}
   finally{current=Object.freeze({stage:prior});onChange(prior);}
  },
 };
}

const probePhases=['pilot-http','browser-sign-in-navigation','browser-workflows'];
const probeWorkloads=[null,...preflightWorkloads];

/** A single atomic token marks the exact workload interval, including brief nested transitions. */
export function createMeasuredPreflightAttribution(){
 const token=new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
 let phase=0,stage=0,generation=0;
 function publish(){Atomics.store(token,0,++generation*64+stage*4+phase);}
 return {token,
  setPhase(value){const next=probePhases.indexOf(value);if(next<phase)throw Error('Unknown preflight lock phase');phase=next;publish();},
  setWorkload(value){const next=probeWorkloads.indexOf(value);if(next<0)throw Error('Unknown preflight lock workload');stage=next;publish();},
 };
}

export function measuredPreflightAttribution(start,end){
 if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(end)||end<start)return {phase:'transition',workloadStage:null};
 const phase=probePhases[start&3],workload=probeWorkloads[(start>>2)&15];
 if(phase===undefined||workload===undefined||(start&3)!==(end&3))return {phase:'transition',workloadStage:null};
 return {phase,workloadStage:phase==='browser-workflows'?(start===end?workload:'transition'):null};
}

const waitKinds=['advisory','transactionid','tuple','relation','other'];

/** Use only a closed partition of the original pg_stat_activity wait count. */
export function firstAppLockWaitCategories(activity,waitingAppBackends){
 if(!Array.isArray(activity)||!Number.isSafeInteger(waitingAppBackends)||waitingAppBackends<1||waitingAppBackends>1024)return null;
 const locks=activity.filter(row=>row.state==='active'&&row.kind==='Lock');
 if(locks.length!==1||locks[0].app_connections!==waitingAppBackends)return null;
 const counts=locks[0].app_lock_wait_kinds;
 if(!counts||typeof counts!=='object'||Object.keys(counts).length!==waitKinds.length)return null;
 if(!waitKinds.every(key=>Object.hasOwn(counts,key)&&Number.isSafeInteger(counts[key])&&counts[key]>=0&&counts[key]<=waitingAppBackends))return null;
 if(waitKinds.reduce((total,key)=>total+counts[key],0)!==waitingAppBackends)return null;
 return Object.fromEntries(waitKinds.map(key=>[key,counts[key]]));
}

/** Pair only rows from the retained native query and its own pg_blocking_pids result. */
export function originalAdvisoryAttribution(locks,labels){
 try{
  const waiters=[],edges=[];
  for(const waiter of locks){
   if(waiters.length===maxEdges)break;
   if(waiter.granted!==false||waiter.app_session!==true||!modes.has(waiter.mode))continue;
   const key=lockKey(waiter),family=lockFamily(key,labels);
   const waiterCategory=family==='audit-chain'?originalAuditQueryCategory(waiter.category):'unknown';
   waiters.push({family,mode:waiter.mode,...(waiterCategory==='unknown'?{}:{category:waiterCategory})});
   for(const pid of new Set((waiter.blockers??[]).slice(0,4))){
    if(edges.length===maxEdges)break;
    if(!Number.isSafeInteger(pid)||pid<=0||pid===waiter.pid)continue;
    const candidates=locks.filter(row=>row.pid===pid&&lockKey(row)===key&&modes.has(row.mode)
     &&typeof row.granted==='boolean'&&(waiter.mode==='ExclusiveLock'||row.mode==='ExclusiveLock'));
    const blocker=candidates.find(row=>row.granted)??candidates[0];
    if(!blocker)continue;
    edges.push({source:'original-sample',family,waiterMode:waiter.mode,blockerMode:blocker.mode,
     blockerState:blocker.granted?'granted':'queued',waiterCategory,
     blockerCategory:family==='audit-chain'?originalAuditQueryCategory(blocker.category):'unknown'});
   }
  }
  return {waiters:waiters.length?waiters:null,edges:edges.length?edges:null};
 }catch{return {waiters:null,edges:null};}
}

export function mergeAdvisoryEdges(original,rechecked){
 return rechecked?[...(original??[]),...rechecked].slice(0,maxEdges):original;
}

export async function observeSampledAdvisoryBlockers(sql,queued,lockLabels){
 try{
  const targets=queued.filter(row=>row.app_session===true&&Number.isSafeInteger(row.pid)&&row.pid>0&&modes.has(row.mode))
   .slice(0,maxEdges).map(row=>{
    const key=lockKey(row);
    const blockers=(row.blockers??[]).filter(pid=>Number.isSafeInteger(pid)&&pid>0).slice(0,4);
    return {pid:row.pid,key,mode:row.mode,family:lockFamily(key,lockLabels),blockers};
   });
  if(!targets.length)return null;
  // Recheck the original app waiter, exact lock and current blockers. SQL text stays inside PostgreSQL.
  // A blocker can own the lock or be ahead in its queue. Its current statement is not the acquisition site.
  const rows=await sql`with targets as (
    select * from jsonb_to_recordset(${JSON.stringify(targets)}::jsonb) as t(pid integer,key text,mode text,family text,blockers integer[])
   ), advisory as materialized (
    select l.pid,concat(l.classid,':',l.objid,':',l.objsubid) as key,l.mode,l.granted
    from pg_catalog.pg_locks l where l.locktype='advisory' and l.mode in ('ExclusiveLock','ShareLock')
     and l.database=(select oid from pg_catalog.pg_database where datname=current_database())
     and concat(l.classid,':',l.objid,':',l.objsubid) in (select key from targets)
   ), activity as materialized (
    select a.pid,a.usename,case
     when a.query ~* '^[[:space:]]*select[[:space:]]+(pg_catalog[.])?pg_advisory_xact_lock_shared[[:space:]]*[(]' then 'advisory-shared'
     when a.query ~* '^[[:space:]]*select[[:space:]]+(pg_catalog[.])?pg_advisory_xact_lock[[:space:]]*[(]' then 'advisory-exclusive'
     when a.query ~* '^[[:space:]]*select[[:space:]]+app[.]reward_setup_allowed[[:space:]]*[(]' then 'rewards-authority'
     when a.query ~* '[[:space:]]from[[:space:]]+reward_library[[:space:]]+l[[:space:]]+join[[:space:]]+reward_library_version' then 'rewards-library'
     when a.query ~* '[[:space:]]app[.]reward_company_structure[[:space:]]*[(]' then 'rewards-company'
     when a.query ~* '^[[:space:]]*insert[[:space:]]+into[[:space:]]+(public[.])?"?domain_event"?([[:space:]]|[(])' then 'audit-append'
     when a.query ~* '^[[:space:]]*select[[:space:]]+app[.]ai_(agent_)?action_unpaused[[:space:]]*[(]' then 'ai-action-pause'
     else 'unknown' end as category
    from pg_catalog.pg_stat_activity a where a.datname=current_database() and a.backend_type='client backend'
   ) select t.family,q.mode as "waiterMode",h.mode as "blockerMode",
    case when h.granted then 'granted' else 'queued' end as "blockerState",
    a.category as "waiterCategory",b.category as "blockerCategory"
   from targets t join advisory q on (q.pid,q.key,q.mode)=(t.pid,t.key,t.mode) and not q.granted
   join activity a on a.pid=q.pid and a.usename='ai_hr_app'
   cross join lateral unnest(pg_catalog.pg_blocking_pids(q.pid)) with ordinality as p(pid,ordinal)
   join activity b on b.pid=p.pid
   join lateral (select mode,granted from advisory where pid=p.pid and key=q.key
    and (q.mode='ExclusiveLock' or mode='ExclusiveLock')
    order by granted desc,(mode='ExclusiveLock') desc limit 1) h on true
   where p.pid=any(t.blockers) and p.ordinal<=4 order by t.pid,p.ordinal limit ${maxEdges}`;
  if(!Array.isArray(rows)||rows.length===0||rows.length>maxEdges)return null;
  const edges=[];
  for(const {family,waiterMode,blockerMode,blockerState,waiterCategory,blockerCategory} of rows){
   if(!families.has(family)||!modes.has(waiterMode)||!modes.has(blockerMode)||!states.has(blockerState)
    ||waiterMode===blockerMode&&waiterMode==='ShareLock'
    ||!categories.has(waiterCategory)||!categories.has(blockerCategory))return null;
   edges.push({source:'recheck',family,waiterMode,blockerMode,blockerState,waiterCategory,blockerCategory});
  }
  return edges;
 }catch{return null;}
}
