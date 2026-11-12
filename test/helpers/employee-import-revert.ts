/** Tests: the employee import Revert now runs as a background job. This drives it to its outcome with real worker
 * ticks and returns the synchronous revert's result (or throws its refusal), so callers keep their assertions. */
import type {SessionContext} from '../../db/client';
import {revertImportForAttempt} from '../../core/import-history-handlers';
import {ImportHistoryError} from '../../core/import-history';
import {getEmployeeImportRevertJob} from '../../core/employee-import-revert-job';
import {runBulkJobTick} from '../../core/bulk-job-worker';
import {BULK_JOB_HANDLERS} from '../../core/bulk-job-handlers';
import {owner} from '../harness';

export async function revertImportToOutcome(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}){
 const started=await revertImportForAttempt(ctx,attemptId,input);
 if(!('job' in started))return started;
 for(let i=0;i<400;i++){
  const job=await getEmployeeImportRevertJob(ctx,started.job.id);
  if(job.state==='completed')return{attemptId,restored:job.restored??0};
  if(job.state==='failed'||job.state==='cancelled')throw new ImportHistoryError(job.error??'The revert could not be completed.',job.blockers);
  if(!await runBulkJobTick(owner.client,{handlers:BULK_JOB_HANDLERS}))await new Promise(resolve=>setTimeout(resolve,40));
 }
 throw new Error('revert job did not finish');
}
