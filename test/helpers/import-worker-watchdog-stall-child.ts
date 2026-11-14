/** Child process of test/import-worker-watchdog-db.test.ts: the worker's loop shape (watchdog phase, then a real
 * runBulkJobTick on the queue-owner connection) with a fixture kind whose step writes a row and then never returns,
 * as a database call on a dead connection would. The watchdog (limit from argv, in seconds) must end the process
 * with status 70 while the chunk transaction is still open. */
import '../../scripts/lib/stub-server-only';
import postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {runBulkJobTick,type BulkJobHandler} from '../../core/bulk-job-worker';
import {startImportWorkerWatchdog} from '../../lib/import-worker-watchdog';

const owner=postgres(process.env.MIGRATION_DATABASE_URL!,{max:1,onnotice:()=>{}});
const hanging:BulkJobHandler<{value:string}>={
 kind:'watchdog_fixture',mode:'per-step',chunkBudgetMs:10_000,maxStepsPerChunk:8,
 async prepare(){throw new Error('The parent test prepares this job.');},
 async applyStepTx(tx,_ctx,job,step){
  await tx.execute(sql`insert into public.watchdog_fixture_row(job_id,value) values(${job.id}::uuid,${step.payload.value})`);
  console.log('step written, now stalling');
  return new Promise<never>(()=>{});
 },
};
const watchdog=startImportWorkerWatchdog({limitSeconds:Number(process.argv[2]),checkEveryMs:100});
async function main(){
 watchdog.enter('bulk');
 const worked=await runBulkJobTick(owner,{handlers:[hanging]});
 console.log(`tick returned ${worked}`);
 process.exit(0);
}
main().catch(error=>{console.error('stall child failed',error);process.exit(1);});
