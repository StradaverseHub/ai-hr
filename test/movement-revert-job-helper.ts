/** Runs a movement import revert the way the history screen does (revertImportForAttempt admits a background job, the
 * protected worker plans and releases it) and answers like the synchronous revert: the restored count, or its refusal. */
import type {SessionContext} from '../db/client';
import {revertImportForAttempt} from '../core/import-history-handlers';
import {getMovementImportRevertJob} from '../core/movement-import-revert-job';
import {ImportHistoryError} from '../core/import-history';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../core/bulk-job-handlers';
import {owner} from './harness';

export async function revertMovementByJob(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}){
 const out=await revertImportForAttempt(ctx,attemptId,input);
 if(!('job' in out))return out;
 for(let i=0;i<600;i++){
  const [row]=await owner.client<{state:string}[]>`select state from bulk_job where id=${out.job.id}::uuid`;
  if(['completed','failed','cancelled'].includes(row.state)){
   const job=await getMovementImportRevertJob(ctx,out.job.id).catch(()=>null);
   if(row.state==='completed')return{attemptId,restored:job?.restored??0,jobId:out.job.id};
   throw new ImportHistoryError(job?.error??'The revert could not be completed.',job?.blockers??[]);
  }
  if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(r=>setTimeout(r,50));
 }
 throw new Error('the revert job did not finish');
}
