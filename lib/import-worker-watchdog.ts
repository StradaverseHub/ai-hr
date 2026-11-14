/** Stall watchdog of the protected import worker (scripts/bank-import-runner.ts, deploy/systemd/BANK-IMPORT.md).
 *
 * The worker's loop is one Bank tick, one Individual Transaction tick, one bulk-job unit and a short pause. A phase
 * that never returns (for example a database call waiting on a dead connection) used to stop every background import
 * silently while systemd still showed the service active. The runner reports each phase here; a timer checks every
 * 30 s and, once one phase has lasted longer than the limit, logs one line to stderr and exits with status 70, so
 * the unit's Restart=on-failure starts a fresh process.
 *
 * Exiting is the whole recovery. The watchdog writes nothing and waits for nothing: the stalled call may be holding
 * the only owner connection, so any clean-up through it could hang too. Process exit closes the sockets; PostgreSQL
 * rolls back each open transaction, and the work it held becomes claimable again (a bulk-job lease once it expires,
 * the Bank and Individual advisory locks when their session ends).
 *
 * The limits come from measurement (deploy/systemd/BANK-IMPORT.md, "Stall watchdog"). The longest legitimate phase
 * measured is the first tick of a maximum Bank & Statutory workbook (250,000 rows): it decodes the whole file and
 * stores every row in one transaction, with no lease. It took 228-339 s on 4-vCPU GitHub runners, about 1,020 s
 * when scaled by 3 for the 2-vCPU staging host. The default (30 min) leaves room above that; the minimum (20 min)
 * stays above it and above the 900 s bulk-job prepare lease (core/bulk-job-worker.ts PREPARE_LEASE_SECONDS), so a
 * legitimate phase is never cut short and restarted again and again.
 *
 * Dependency-free so the runner can load it before any database module. */

export type ImportWorkerPhase='start'|'bank'|'individual'|'bulk'|'pause'|'stop';

export const IMPORT_WORKER_STALL_ENV='AIHR_IMPORT_WORKER_STALL_SECONDS';
export const IMPORT_WORKER_STALL_DEFAULT_SECONDS=1800;
/** Above the maximum Bank workbook first tick scaled to staging (about 1,020 s) and the 900 s bulk-job prepare lease. */
export const IMPORT_WORKER_STALL_MIN_SECONDS=1200;
export const IMPORT_WORKER_STALL_MAX_SECONDS=21600;
export const IMPORT_WORKER_STALL_EXIT_CODE=70;
const CHECK_EVERY_MS=30_000;

/** The configured limit in seconds; throws a message naming the setting and its range when the value is invalid. */
export function importWorkerStallSeconds(env:Record<string,string|undefined>):number{
 const raw=env[IMPORT_WORKER_STALL_ENV];
 if(raw===undefined)return IMPORT_WORKER_STALL_DEFAULT_SECONDS;
 const value=Number(raw);
 if(!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(value)||value<IMPORT_WORKER_STALL_MIN_SECONDS||value>IMPORT_WORKER_STALL_MAX_SECONDS)
  throw new Error(`${IMPORT_WORKER_STALL_ENV} must be a whole number of seconds from ${IMPORT_WORKER_STALL_MIN_SECONDS} to ${IMPORT_WORKER_STALL_MAX_SECONDS} (default ${IMPORT_WORKER_STALL_DEFAULT_SECONDS}).`);
 return value;
}

type Timer={unref():unknown};
export type ImportWorkerWatchdogOptions={
 limitSeconds:number;
 checkEveryMs?:number;
 now?:()=>number;
 log?:(line:string)=>void;
 exit?:(code:number)=>void;
 setInterval?:(fn:()=>void,ms:number)=>Timer;
 clearInterval?:(timer:Timer)=>void;
};
export type ImportWorkerWatchdog={
 /** The loop entered this phase now. */
 enter(phase:ImportWorkerPhase):void;
 /** One check, as the timer runs it. Returns true when it exited. */
 check():boolean;
 stop():void;
 readonly phase:ImportWorkerPhase;
};

export function startImportWorkerWatchdog(options:ImportWorkerWatchdogOptions):ImportWorkerWatchdog{
 const now=options.now??Date.now;
 const log=options.log??(line=>console.error(line));
 const exit=options.exit??(code=>process.exit(code));
 const limitMs=options.limitSeconds*1000;
 let phase:ImportWorkerPhase='start',since=now(),fired=false;
 const check=()=>{
  if(fired)return true;
  const elapsed=now()-since;
  if(elapsed<=limitMs)return false;
  fired=true;
  log(`Import worker stalled in ${phase} for ${Math.floor(elapsed/1000)} s; exiting so systemd restarts it.`);
  exit(IMPORT_WORKER_STALL_EXIT_CODE);
  return true;
 };
 const timer=(options.setInterval??((fn,ms)=>setInterval(fn,ms)))(check,options.checkEveryMs??CHECK_EVERY_MS);
 // The timer only watches: it must never keep a finished worker (or a --once run) alive.
 timer.unref();
 return{
  enter(next){phase=next;since=now();},
  check,
  stop(){(options.clearInterval??(t=>clearInterval(t as NodeJS.Timeout)))(timer);},
  get phase(){return phase;},
 };
}
