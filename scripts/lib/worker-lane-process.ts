/** One worker process: the loop of scripts/bank-import-runner.ts for the lanes in AIHR_WORKER_LANE (unset: all lanes).
 * It runs as aihr-bank-import.service's main process when no dedicated lanes are declared, or as a child of the lane
 * supervisor (core/worker-lane-supervisor.ts) when AIHR_WORKER_LANES is set (ADR 0181 J1.2).
 *
 * Exit status: 0 only after a stop request (SIGTERM/SIGINT, or the supervisor going away) or a --once run that
 * finished its pass. Anything else is a failure systemd must restart (Restart=on-failure): a rejected loop exits 1,
 * the stall watchdog exits 70, and a loop that ends without a stop request exits 75. The last is the 24 November
 * staging case: a PostgreSQL restart left a database call that never settled and no other handle (the watchdog timer
 * is unref'd), so Node drained its event loop and exited 0, and systemd did not restart the worker. */
import './stub-server-only';
import {freshImportContext,runBankImportTick} from '../../core/bank-import-worker';
import {runIndividualImportTick} from '../../core/individual-import-worker';
import {retireBulkJobWorker} from '../../core/bulk-job-worker';
import {OwnerConnectionUnresponsive} from '../../core/owner-step-deadline';
import {runPayrollBatchSummaryTick} from '../../core/payroll-batch-summary';
import {runWorkerLaneIteration,type WorkerSingletonTicks} from '../../core/worker-lane-loop';
import {runRewardPlanCompanyTick} from '../../packs/rewards/service';
import {runProbationReconciliationTick} from '../../packs/probation/service';
import {BULK_JOB_HANDLERS} from '../../core/bulk-job-handlers';
import {WORKER_LANES,WORKER_LANE_ENV,laneHandlers,lanesRunSingletonTicks,workerLanesFromEnv} from '../../core/bulk-job-lanes';
import {WORKER_UNEXPECTED_EXIT_CODE} from '../../core/worker-lane-supervisor';
import {client,createDb} from '../../db/client';
import {openImportWorkerOwner} from '../../db/worker-connection';
import {movementWorkbookKeyReady} from '../../lib/movement-workbook-metadata.server';
import {IMPORT_WORKER_STALL_ENV,importWorkerStallSeconds,startImportWorkerWatchdog} from '../../lib/import-worker-watchdog';

export function runWorkerProcess(){
 const url=process.env.MIGRATION_DATABASE_URL;
 if(!url)throw new Error('MIGRATION_DATABASE_URL is required by the import worker.');
 // Validated before any connection opens: an invalid value refuses to start with a message naming the setting.
 const stallSeconds=importWorkerStallSeconds(process.env);
 const lanes=workerLanesFromEnv(process.env);
 const handlers=laneHandlers(BULK_JOB_HANDLERS,lanes);
 const singletons=lanesRunSingletonTicks(lanes);
 const once=process.argv.includes('--once');
 // Server and client keepalive end a half-open owner session, and its advisory locks, within minutes (db/worker-connection.ts).
 const owner=openImportWorkerOwner(url);
 // One bounded owner pool for canonical reconciliation transactions; never the web pool. Default lane only, so a
 // dedicated lane process holds at most the queue-owner connection and its app pool (db/capacity.ts).
 const probationOwner=singletons?createDb(url,{max:1}):null;
 const ticks:WorkerSingletonTicks={bank:runBankImportTick,individual:db=>runIndividualImportTick(db,freshImportContext),
  rewardPlans:runRewardPlanCompanyTick,probation:runProbationReconciliationTick,payrollSummaries:owner=>runPayrollBatchSummaryTick(owner)};
 // Between two bulk-job units, so waiting interactive writers always get the tenant locks first.
 const bulkPauseMs=Number(process.env.BULK_JOB_PAUSE_MS??25);
 let stopping=false,ended=false;
 process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 // A supervised child: the supervisor going away is a stop request. The channel must not keep the process alive.
 if(process.channel){process.channel.unref();process.on('disconnect',()=>{stopping=true;});}
 process.on('beforeExit',()=>{
  if(ended||process.exitCode)return;
  console.error(`Import worker loop ended without a stop request (a database call never settled, for example after a database restart); exiting with status ${WORKER_UNEXPECTED_EXIT_CODE} so systemd restarts it.`);
  process.exitCode=WORKER_UNEXPECTED_EXIT_CODE;
 });
 // Exits (status 70, systemd restarts it) when one phase below runs longer than stallSeconds (lib/import-worker-watchdog.ts).
 const watchdog=startImportWorkerWatchdog({limitSeconds:stallSeconds});
 async function main(){
  console.error(`Import worker started (pid ${process.pid}); stall watchdog ${stallSeconds} s (${IMPORT_WORKER_STALL_ENV}).`);
  console.error(`Import worker serves ${lanes.length===WORKER_LANES.length?'all lanes':`lane ${lanes[0]}`} (${handlers.length} job kinds, ${WORKER_LANE_ENV}).`);
  // Other imports keep running; only Movement workbook checks fail, so warn loudly instead of refusing to start.
  if(!movementWorkbookKeyReady())console.error('Import worker: MOVEMENT_IMPORT_WORKBOOK_KEY/_ID are missing or invalid in its environment. Movement Excel imports will fail with "Workbook signing is not configured" until the web process values are copied into /etc/aihr/import-worker.env.');
  try{do{
   const worked=await runWorkerLaneIteration({owner,probationOwner,lanes,handlers,ticks,enter:phase=>watchdog.enter(phase)});
   if(once)break;
   watchdog.enter('pause');
   if(!worked.bank&&!worked.individual)await new Promise(resolve=>setTimeout(resolve,worked.bulk||worked.rewardPlans||worked.probation||worked.payrollSummaries?bulkPauseMs:1000));
  }while(!stopping);}
  // The heartbeat removal is bounded (10 s): after OwnerConnectionUnresponsive the abandoned reservation still holds the
  // only owner connection, so it would wait for ever; owner.end then closes that connection after 5 s. A heartbeat
  // left behind only ages out (core/bulk-job-worker.ts).
  finally{watchdog.enter('stop');await retireWithin(owner,10_000);await owner.end({timeout:5});await probationOwner?.client.end({timeout:5});await client.end({timeout:5});watchdog.stop();}
  ended=true;
 }
 main().catch(error=>{
  ended=true;
  if(error instanceof OwnerConnectionUnresponsive)console.error(`Import worker: ${error.message} Exiting so systemd restarts it with a new connection.`);
  console.error('Bank import worker stopped. Check its database access, migrations and runtime configuration.');process.exitCode=1;
 });
}

async function retireWithin(owner:Parameters<typeof retireBulkJobWorker>[0],ms:number){
 let timer:ReturnType<typeof setTimeout>|undefined;
 await Promise.race([retireBulkJobWorker(owner).catch(()=>undefined),new Promise<void>(resolve=>{timer=setTimeout(resolve,ms);})]);
 clearTimeout(timer);
}
