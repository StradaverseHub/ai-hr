/** Dedicated continuous worker, aihr-bank-import.service's ExecStart. Both credentials are root-provisioned, outside
 * the web environment. MIGRATION_DATABASE_URL only discovers/coordinates the queues; DATABASE_URL owns all HR
 * transactions.
 *
 * Without AIHR_WORKER_LANES this process is the worker (scripts/lib/worker-lane-process.ts): with AIHR_WORKER_LANE
 * unset it runs the Bank & Statutory and Individual Transaction queues, the reward and probation ticks and every kind
 * on the shared bulk-job kernel (core/bulk-job-handlers.ts); AIHR_WORKER_LANE=<lane> registers only that lane's kinds
 * (core/bulk-job-lanes.ts, ADR 0181 J1) and runs no singleton tick.
 *
 * With AIHR_WORKER_LANES=<lane>,... (from the protected worker environment) this process only supervises
 * (core/worker-lane-supervisor.ts): it opens no database connection and loads no handler, and starts one all-lane
 * child plus one child per listed lane. Removing the key is the rollback. Several processes run together safely: the
 * claim takes leases with SKIP LOCKED and the Bank and Individual ticks hold session advisory locks.
 */
import {spawn} from 'node:child_process';
import {dedicatedWorkerLanes} from '../db/capacity';
import {workerLanesFromEnv} from '../core/bulk-job-lanes';
import {superviseWorkerLanes,workerLaneChildren} from '../core/worker-lane-supervisor';
import {importWorkerStallSeconds} from '../lib/import-worker-watchdog';

// Every setting is validated before anything starts: an invalid value refuses with a message naming the setting.
importWorkerStallSeconds(process.env);
workerLanesFromEnv(process.env);
// A lane child (AIHR_WORKER_LANE set) never supervises; the supervisor removes AIHR_WORKER_LANES from its children.
const dedicated=process.env.AIHR_WORKER_LANE?.trim()?[]:dedicatedWorkerLanes(process.env);

if(!dedicated.length){
 // The worker itself, loaded only here so the supervisor never loads a handler.
 void import('./lib/worker-lane-process').then(worker=>worker.runWorkerProcess());
}else{
 if(!process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_DATABASE_URL is required by the import worker.');
 const once=process.argv.includes('--once');
 const script=process.argv[1];
 console.error(`Import worker supervisor started (pid ${process.pid}); lanes: all, ${dedicated.join(', ')} (AIHR_WORKER_LANES).`);
 const supervisor=superviseWorkerLanes({
  children:workerLaneChildren(process.env,dedicated),once,
  spawn:spec=>spawn(process.execPath,[...process.execArgv,script,...(once?['--once']:[])],{
   env:Object.fromEntries(Object.entries(spec.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),
   stdio:['ignore','inherit','inherit','ipc'],
  }),
  exit:code=>process.exit(code),
 });
 for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>supervisor.stop(signal));
}
