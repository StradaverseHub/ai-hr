/** Optional fictional-run diagnostic. The original blocking sample is already retained. */
const families=new Set(['access-configuration','ai-control','audit-chain','employment','payroll-history','pay-component-catalog','unclassified']);
const modes=new Set(['ShareLock','ExclusiveLock']);
const categories=new Set(['advisory-exclusive','advisory-shared','rewards-authority','rewards-library','rewards-company','audit-append','ai-action-pause','unknown']);
const states=new Set(['granted','queued']);
const maxEdges=8;

export async function observeSampledAdvisoryBlockers(sql,queued,lockLabels){
 try{
  const targets=queued.filter(row=>row.app_session===true&&Number.isSafeInteger(row.pid)&&row.pid>0&&modes.has(row.mode))
   .slice(0,maxEdges).map(row=>{
    const key=row.classid+':'+row.objid+':'+row.objsubid;
    const family=lockLabels.get(key)?.split(':',1)[0];
    const blockers=(row.blockers??[]).filter(pid=>Number.isSafeInteger(pid)&&pid>0).slice(0,4);
    return {pid:row.pid,key,mode:row.mode,family:families.has(family)?family:'unclassified',blockers};
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
   edges.push({family,waiterMode,blockerMode,blockerState,waiterCategory,blockerCategory});
  }
  return edges;
 }catch{return null;}
}
