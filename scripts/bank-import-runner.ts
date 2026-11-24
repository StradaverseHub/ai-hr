/** Dedicated continuous worker. Both credentials are root-provisioned, outside the web environment.
 * MIGRATION_DATABASE_URL only discovers/coordinates the queues; DATABASE_URL owns all HR transactions.
 * With AIHR_WORKER_LANE unset it runs the Bank & Statutory and Individual Transaction queues, the reward and probation
 * ticks and every kind on the shared bulk-job kernel (core/bulk-job-handlers.ts). AIHR_WORKER_LANE=<lane> registers
 * only that lane's kinds (core/bulk-job-lanes.ts, ADR 0181 J1), so its claim and heartbeat advertise exactly that
 * subset; the singleton ticks run only in the default lane. Several processes run together safely: the claim takes
 * leases with SKIP LOCKED and the Bank and Individual ticks hold session advisory locks.
 */
import './lib/stub-server-only';
import {freshImportContext,runBankImportTick} from '../core/bank-import-worker';
import {runIndividualImportTick} from '../core/individual-import-worker';
import {retireBulkJobWorker} from '../core/bulk-job-worker';
import {runWorkerLaneIteration,type WorkerSingletonTicks} from '../core/worker-lane-loop';
import {runRewardPlanCompanyTick} from '../packs/rewards/service';
import {runProbationReconciliationTick} from '../packs/probation/service';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {WORKER_LANES,WORKER_LANE_ENV,laneHandlers,lanesRunSingletonTicks,workerLanesFromEnv} from '../core/bulk-job-lanes';
import {client,createDb} from '../db/client';
import {openImportWorkerOwner} from '../db/worker-connection';
import {movementWorkbookKeyReady} from '../lib/movement-workbook-metadata.server';
import {IMPORT_WORKER_STALL_ENV,importWorkerStallSeconds,startImportWorkerWatchdog} from '../lib/import-worker-watchdog';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url)throw new Error('MIGRATION_DATABASE_URL is required by the import worker.');
// Validated before any connection opens: an invalid value refuses to start with a message naming the setting.
const stallSeconds=importWorkerStallSeconds(process.env);
const lanes=workerLanesFromEnv(process.env);
const handlers=laneHandlers(BULK_JOB_HANDLERS,lanes);
const singletons=lanesRunSingletonTicks(lanes);
// Server and client keepalive end a half-open owner session, and its advisory locks, within minutes (db/worker-connection.ts).
const owner=openImportWorkerOwner(url);
// One bounded owner pool for canonical reconciliation transactions; never the web pool. Default lane only, so a
// dedicated lane process holds at most the queue-owner connection and its app pool (db/capacity.ts).
const probationOwner=singletons?createDb(url,{max:1}):null;
const ticks:WorkerSingletonTicks={bank:runBankImportTick,individual:db=>runIndividualImportTick(db,freshImportContext),
 rewardPlans:runRewardPlanCompanyTick,probation:runProbationReconciliationTick};
// Between two bulk-job units, so waiting interactive writers always get the tenant locks first.
const bulkPauseMs=Number(process.env.BULK_JOB_PAUSE_MS??25);
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
// Exits (status 70, systemd restarts it) when one phase below runs longer than stallSeconds (lib/import-worker-watchdog.ts).
const watchdog=startImportWorkerWatchdog({limitSeconds:stallSeconds});
async function main(){
 const laneLabel=lanes.length===WORKER_LANES.length?'all lanes':`lane ${lanes[0]}`;
 console.error(`Import worker started (pid ${process.pid}, ${laneLabel}, ${handlers.length} job kinds, ${WORKER_LANE_ENV}); stall watchdog ${stallSeconds} s (${IMPORT_WORKER_STALL_ENV}).`);
 // Other imports keep running; only Movement workbook checks fail, so warn loudly instead of refusing to start.
 if(!movementWorkbookKeyReady())console.error('Import worker: MOVEMENT_IMPORT_WORKBOOK_KEY/_ID are missing or invalid in its environment. Movement Excel imports will fail with "Workbook signing is not configured" until the web process values are copied into /etc/aihr/import-worker.env.');
 try{do{
  const worked=await runWorkerLaneIteration({owner,probationOwner,lanes,handlers,ticks,enter:phase=>watchdog.enter(phase)});
  if(process.argv.includes('--once'))break;
  watchdog.enter('pause');
  if(!worked.bank&&!worked.individual)await new Promise(resolve=>setTimeout(resolve,worked.bulk||worked.rewardPlans||worked.probation?bulkPauseMs:1000));
 }while(!stopping);}
 finally{watchdog.enter('stop');await retireBulkJobWorker(owner).catch(()=>undefined);await owner.end({timeout:5});await probationOwner?.client.end({timeout:5});await client.end({timeout:5});watchdog.stop();}
}
main().catch(()=>{console.error('Bank import worker stopped. Check its database access, migrations and runtime configuration.');process.exitCode=1;});
