/** Build the sole protected workload lock sample on an already held observer.
 * @template {Record<string,unknown>} Types
 * @param {import('postgres').Sql<Types>} sql
 */
export function protectedLockObserverQuery(sql){
 return sql`with app_sessions as materialized (
    select pid,state,wait_event_type from pg_catalog.pg_stat_activity
    where datid=(select oid from pg_catalog.pg_database where datname=current_database())
     and usename='ai_hr_app' and backend_type='client backend'
   ), queued as materialized (
    select distinct l.pid from pg_catalog.pg_locks l join app_sessions a on a.pid=l.pid where not l.granted
   )
   select pg_backend_pid() as pid,session_user as login,current_user as role,current_database() as database,
    a.datid::text as "databaseOid",extract(epoch from a.backend_start)::text as "backendStart",
    host(inet_server_addr()) as address,inet_server_port() as port,
    current_setting('transaction_read_only') as "readOnly",current_setting('track_activities') as "trackActivities",
    pg_has_role(current_user,'pg_read_all_stats','USAGE') as "canReadStats",
    (select count(*)::int from app_sessions) as "appSessions",
    (select count(*)::int from app_sessions where state is null or state='disabled') as "invisibleAppSessions",
    (select count(*)::int from app_sessions s left join queued q on q.pid=s.pid
      where s.wait_event_type='Lock' or q.pid is not null) as "blockingAppSessions"
   from pg_catalog.pg_stat_activity a where a.pid=pg_backend_pid()`;
}

/**
 * Bind the sampled row to the held observer before the caller credits counts.
 * @param {Record<string,unknown>[]} rows
 * @param {{pid:number,backendStart:string,databaseOid:string}} expected
 */
export function protectedLockObserverObservedCounts(rows,expected){
 const [row]=rows;
 if(rows.length!==1||!row||!expected||!Number.isSafeInteger(expected.pid)||expected.pid<=1
  ||typeof expected.backendStart!=='string'||!/^\d+(?:\.\d+)?$/.test(expected.backendStart)
  ||typeof expected.databaseOid!=='string'||!/^[1-9]\d{0,9}$/.test(expected.databaseOid)
  ||row.pid!==expected.pid||row.backendStart!==expected.backendStart||row.databaseOid!==expected.databaseOid
  ||row.login!=='ai_hr_workload_observer'||row.role!==row.login||row.database!=='ai_hr_test_w1'
  ||row.address!=='127.0.0.1'||row.port!==5433||row.readOnly!=='on'||row.trackActivities!=='on'
  ||row.canReadStats!==true||row.invisibleAppSessions!==0){
  throw Error('Protected lock observer identity or visibility differed');
 }
 return {appSessions:row.appSessions,blockingAppSessions:row.blockingAppSessions};
}

/**
 * @param {Record<string,unknown>[]} rows
 * @param {{pid:number,backendStart:string,databaseOid:string}} expected
 */
export function protectedLockObserverCounts(rows,expected){
 const {appSessions,blockingAppSessions}=protectedLockObserverObservedCounts(rows,expected);
 if(typeof appSessions!=='number'||!Number.isSafeInteger(appSessions)||appSessions<0
  ||typeof blockingAppSessions!=='number'||!Number.isSafeInteger(blockingAppSessions)
  ||blockingAppSessions<0||blockingAppSessions>appSessions){
  throw Error('Protected lock observer counts differed');
 }
 return {appSessions,blockingAppSessions};
}
