/** Dedicated continuous worker. Both credentials are root-provisioned, outside the web environment.
 * MIGRATION_DATABASE_URL only discovers/coordinates the queues; DATABASE_URL owns all HR transactions.
 * It runs the Bank & Statutory and Individual Transaction queues and every kind on the shared bulk-job kernel
 * (core/bulk-job-handlers.ts), so one protected installation serves all background imports.
 */
import './lib/stub-server-only';
import postgres from 'postgres';
import {freshImportContext,runBankImportTick} from '../core/bank-import-worker';
import {runIndividualImportTick} from '../core/individual-import-worker';
import {retireBulkJobWorker,runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {client} from '../db/client';
import {movementWorkbookKeyReady} from '../lib/movement-workbook-metadata.server';
import {IMPORT_WORKER_STALL_ENV,importWorkerStallSeconds,startImportWorkerWatchdog} from '../lib/import-worker-watchdog';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url)throw new Error('MIGRATION_DATABASE_URL is required by the import worker.');
// Validated before any connection opens: an invalid value refuses to start with a message naming the setting.
const stallSeconds=importWorkerStallSeconds(process.env);
const owner=postgres(url,{max:1,onnotice:()=>{}});
// Between two bulk-job units, so waiting interactive writers always get the tenant locks first.
const bulkPauseMs=Number(process.env.BULK_JOB_PAUSE_MS??25);
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
// Exits (status 70, systemd restarts it) when one phase below runs longer than stallSeconds (lib/import-worker-watchdog.ts).
const watchdog=startImportWorkerWatchdog({limitSeconds:stallSeconds});
async function main(){
 console.error(`Import worker started (pid ${process.pid}); stall watchdog ${stallSeconds} s (${IMPORT_WORKER_STALL_ENV}).`);
 // Other imports keep running; only Movement workbook checks fail, so warn loudly instead of refusing to start.
 if(!movementWorkbookKeyReady())console.error('Import worker: MOVEMENT_IMPORT_WORKBOOK_KEY/_ID are missing or invalid in its environment. Movement Excel imports will fail with "Workbook signing is not configured" until the web process values are copied into /etc/aihr/import-worker.env.');
 try{do{
  watchdog.enter('bank');
  const bankWorked=await runBankImportTick(owner);
  watchdog.enter('individual');
  const individualWorked=await runIndividualImportTick(owner,freshImportContext);
  watchdog.enter('bulk');
  const bulkWorked=await runBulkJobTick(owner,{handlers:BULK_JOB_HANDLERS});
  if(process.argv.includes('--once'))break;
  watchdog.enter('pause');
  if(!bankWorked&&!individualWorked)await new Promise(resolve=>setTimeout(resolve,bulkWorked?bulkPauseMs:1000));
 }while(!stopping);}
 finally{watchdog.enter('stop');await retireBulkJobWorker(owner).catch(()=>undefined);await owner.end({timeout:5});await client.end({timeout:5});watchdog.stop();}
}
main().catch(()=>{console.error('Bank import worker stopped. Check its database access, migrations and runtime configuration.');process.exitCode=1;});
