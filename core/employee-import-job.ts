/** Durable admission and creator-scoped progress for background employee imports, as a client of the shared
 * bulk-job kernel (core/bulk-job.ts, migration 9003). No HR change occurs in an HTTP request. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {EMPLOYEE_IMPORT_ALREADY_RUNNING,type EmployeeImportProgress,type EmployeeImportRowError,type EmployeeImportState,type EmployeeImportResultSummary,type EmployeeImportPhase} from '../lib/employee-import-job';
import type {BulkJobState} from '../lib/bulk-job';
import type {EmployeeImportEvaluationBinding,EmployeeImportEvaluationReceipt} from '../lib/personnel-import-evaluation';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import {IMPORT_SOURCE_MAX_BYTES,importSourceName} from './import-history';
import {assertWorkforceCompanyTx} from './workforce-access';
import {parseEmployeeImportUpload,type EmployeeImportUploadInput} from './employee-import-upload';
import {readEmployeeImportEvaluationTx} from './personnel-import-evaluation';

export const EMPLOYEE_IMPORT_KIND='employee_import';
export class EmployeeImportJobError extends Error{constructor(message:string,readonly status=400){super(message);}}
/** What the worker reads back. `evaluationBinding` keeps an AI-evaluation-bound import bound to its receipt. */
export type EmployeeImportJobInput={upload:EmployeeImportUploadInput;evaluationBinding?:EmployeeImportEvaluationBinding};
const uiState:Record<BulkJobState,EmployeeImportState>={queued:'queued',preparing:'validating',running:'importing',finalizing:'activating',discarding:'discarding',completed:'completed',failed:'failed',cancelled:'failed'};
export function employeeImportProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):EmployeeImportProgress{
 const c=row.counters??{};
 const phase=(row.state==='finalizing'?'activation':row.phase) as EmployeeImportPhase|null;
 return{id:row.id,sourceName:row.source_name,state:uiState[row.state],phase,total:c.total??0,valid:c.valid??0,invalid:c.invalid??0,
  stepsTotal:row.steps_total,stepsDone:row.steps_done,imported:c.imported??0,attemptId:row.attempt_id,error:row.error,
  errors:(row.errors??[]).map(e=>({rowNum:e.rowNum,email:e.ref,message:e.message})) as EmployeeImportRowError[],
  result:(row.state==='completed'?row.result:null) as EmployeeImportResultSummary|null,
  updatedAt:new Date(row.updated_at).toISOString(),createdAt:new Date(row.created_at).toISOString(),
  worker:row.state==='queued'?worker:'running'};
}
async function progressTx(tx:Tx,row:BulkJobRow){return employeeImportProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,EMPLOYEE_IMPORT_KIND):'running');}
const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new EmployeeImportJobError(error.message===BULK_JOB_ALREADY_RUNNING?EMPLOYEE_IMPORT_ALREADY_RUNNING:error.message===`Job unavailable.`?'Import unavailable.':error.message,error.status);
 return error;
};
/** Start an import from the browser's preview-confirmed inputs. The request only enqueues; the worker validates and
 * writes. An evaluation-bound import that already committed returns its receipt instead of a second job. */
export async function createEmployeeImportJob(ctx:SessionContext,input:EmployeeImportUploadInput,source:{name:string;content:Buffer;operationKey?:string},evaluationBinding?:EmployeeImportEvaluationBinding):Promise<{job:EmployeeImportProgress;existing:boolean}|{replay:EmployeeImportEvaluationReceipt}>{
 if(!ctx.userId)throw new EmployeeImportJobError('Sign in again to import employees.',401);
 if(source.content.length<1||source.content.length>IMPORT_SOURCE_MAX_BYTES)throw new EmployeeImportJobError('Choose a file no larger than 10 MB.');
 if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.companyId))throw new EmployeeImportJobError('Choose a company before importing.');
 try{
  return await withTenant(ctx,async tx=>{
   // Same permission the synchronous import enforced when it was requested: fail here, not later in the worker.
   await assertWorkforceCompanyTx(tx,ctx,input.companyId,'maintain');
   if(evaluationBinding){
    // Same receipt custody as the synchronous measured import: the binding must match these exact inputs, and a
    // committed binding replays its receipt instead of importing twice.
    const parsed=parseEmployeeImportUpload(input);
    const replay=await readEmployeeImportEvaluationTx(tx,ctx,evaluationBinding,{companyId:input.companyId,records:parsed.records,dependentRecords:parsed.dependentRecords,registerRecords:parsed.registerRecords,allocationRecords:parsed.allocationRecords});
    if(replay)return{replay};
   }
   const jobInput:EmployeeImportJobInput={upload:input,...(evaluationBinding?{evaluationBinding}:{})};
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:EMPLOYEE_IMPORT_KIND,operationKey:source.operationKey,companyIds:[input.companyId],
    source:{name:importSourceName(source.name,'employees.csv'),content:source.content},input:jobInput});
   return{job:await progressTx(tx,row),existing};
  });
 }catch(error){throw kernelError(error);}
}
export async function getEmployeeImportJob(ctx:SessionContext,id:string){
 try{return await withTenant(ctx,async tx=>progressTx(tx,await bulkJobTx(tx,id,{kind:EMPLOYEE_IMPORT_KIND})));}catch(error){throw kernelError(error);}
}
/** The signed-in user's most recent jobs, newest first (the page uses this to resume after navigation). */
export async function listEmployeeImportJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await listBulkJobsTx(tx,ctx,EMPLOYEE_IMPORT_KIND,10);
 const worker=rows.some(r=>r.state==='queued')?await bulkJobWorkerStatusTx(tx,EMPLOYEE_IMPORT_KIND):'running';
 return rows.map(row=>employeeImportProgress(row,worker));
});}
/** Internal for tests and the rehearsal: the job's attempt, read as its creator. */
export async function employeeImportJobAttemptTx(tx:Tx,id:string){const [row]=await tx.execute<{attempt_id:string|null}>(sql`select attempt_id from bulk_job where id=${id}::uuid and kind=${EMPLOYEE_IMPORT_KIND}`);return row?.attempt_id??null;}
