/** Once-only admission for the scheduled maintenance jobs (provisioning, the workflow notification sweep), shared by
 * the resident process (scripts/scheduled-jobs.ts) and the same scripts when cron or a timer still starts them.
 *
 * It replaces `flock` on a host file, which only excluded runs on one host started through the same lock path. A
 * PostgreSQL session advisory lock excludes every holder on the database, so the resident process and a leftover
 * crontab line never run the same job at once, in either order of installation and removal.
 *
 * The lock lives on one dedicated connection (MIGRATION_DATABASE_URL, the login both jobs already use):
 *   - max 1 and max_lifetime 0: postgres.js never recycles the connection between the lock and the unlock, which
 *     would silently release a held lock (the pool's lifetime timer is otherwise 30–60 minutes or hours, db/client.ts);
 *   - the worker dead-peer settings (db/worker-connection.ts): a vanished holder's backend, and its lock, ends within
 *     about three minutes instead of the server's two-hour TCP keepalive;
 *   - the unlock reports whether the same backend still held it, so a connection lost mid-run is logged, never
 *     hidden. PostgreSQL releases the lock when that backend ends, which is the same guarantee flock gave on exit. */
import postgres from 'postgres';
import {processConnectionOptions} from '../../db/worker-connection';

export const SCHEDULED_JOB_LOCK_PREFIX='aihr.scheduled-job:';
export const SCHEDULED_JOB_KEYS=['provision','notification-email'] as const;
export type ScheduledJobKey=typeof SCHEDULED_JOB_KEYS[number];

export type HeldScheduledJobLock={
 /** True when the backend that took the lock released it; false when the connection was lost while running. */
 release():Promise<boolean>;
};
export type ScheduledJobLocks={
 /** null when another process holds this job's lock (the run is skipped, as `flock -n` did). */
 tryLock(job:ScheduledJobKey):Promise<HeldScheduledJobLock|null>;
 end():Promise<void>;
};

/** Connection-string parameters win over driver options (postgres.js merges the query last), so the name is set here. */
export function withApplicationName(url:string,name:string):string{
 const parsed=new URL(url);
 parsed.searchParams.set('application_name',name);
 return parsed.toString();
}

export function openScheduledJobLocks(url:string,applicationName='aihr-scheduled-job-lock'):ScheduledJobLocks{
 const sql=postgres(withApplicationName(url,applicationName),{max:1,max_lifetime:0,idle_timeout:0,onnotice:()=>{},...processConnectionOptions('worker')});
 return {
  async tryLock(job){
   const key=SCHEDULED_JOB_LOCK_PREFIX+job;
   const [held]=await sql<{owned:boolean;pid:number}[]>`select pg_try_advisory_lock(hashtextextended(${key},0)) as owned, pg_backend_pid() as pid`;
   if(held?.owned!==true)return null;
   let released=false;
   return {async release(){
    if(released)return true;released=true;
    try{
     const [row]=await sql<{unlocked:boolean;pid:number}[]>`select pg_advisory_unlock(hashtextextended(${key},0)) as unlocked, pg_backend_pid() as pid`;
     return row?.unlocked===true&&row.pid===held.pid;
    }catch{return false;}
   }};
  },
  end:()=>sql.end({timeout:5}),
 };
}
