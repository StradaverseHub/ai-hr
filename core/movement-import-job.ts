/** Durable admission and creator-scoped progress for background movement imports, as a client of the shared
 * bulk-job kernel (core/bulk-job.ts, migration 9003; kind row in draft 9910). The confirmation request runs the same
 * attempt checks the synchronous confirmation ran, then only enqueues; the protected import worker re-reads the
 * file and saves each employee in its own short chunk (core/movement-import-worker.ts). */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {isAdmin} from '../lib/authz-model';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,isBulkJobId,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import {importSourceName,recordImportFailure} from './import-history';
import {chosenMovementEmployees,confirmableMovementAttemptTx,type MovementConfirmInput,type MovementUploadResult} from './movement-import-history';
import type {BulkJobState} from '../lib/bulk-job';
import {MOVEMENT_CHECK_ALREADY_RUNNING,MOVEMENT_IMPORT_ALREADY_RUNNING,type MovementCheckJobProgress,type MovementCheckJobResult,type MovementCheckJobState,type MovementImportJobProgress,type MovementImportJobResult,type MovementImportJobState} from '../lib/movement-import-job';

export const MOVEMENT_IMPORT_KIND='movement_import';
export const MOVEMENT_CHECK_KIND='movement_check';
export class MovementImportJobError extends Error{constructor(message:string,readonly status=400){super(message);this.name='MovementImportJobError';}}
/** What the worker reads back: the confirmation exactly as the browser sent it, and the screen's language for the
 * file's localized headers and the Import History texts (as the request's translator supplied them). */
export type MovementImportJobInput=MovementConfirmInput&{locale:string;sourceName:string};
const uiState:Record<BulkJobState,MovementImportJobState>={queued:'queued',preparing:'validating',running:'importing',finalizing:'finishing',discarding:'finishing',completed:'completed',failed:'failed',cancelled:'cancelled'};
export function movementImportJobProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):MovementImportJobProgress{
 const c=row.counters??{};
 const named=(row.plan as {sourceName?:string}|null)?.sourceName??(row.input as MovementImportJobInput|null)?.sourceName??'';
 return{id:row.id,sourceName:row.source_name||named,state:uiState[row.state],stepsTotal:row.steps_total,stepsDone:row.steps_done,imported:c.imported??0,failed:c.refused??0,
  attemptId:row.attempt_id??(row.input as MovementImportJobInput|null)?.attemptId??null,error:row.error,
  result:(row.state==='completed'?row.result:null) as MovementImportJobResult|null,
  updatedAt:new Date(row.updated_at).toISOString(),createdAt:new Date(row.created_at).toISOString(),worker:row.state==='queued'?worker:'running'};
}
async function progressTx(tx:Tx,row:BulkJobRow){return movementImportJobProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,MOVEMENT_IMPORT_KIND):'running');}
const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new MovementImportJobError(error.message===BULK_JOB_ALREADY_RUNNING?MOVEMENT_IMPORT_ALREADY_RUNNING:error.message==='Job unavailable.'?'Import unavailable.':error.message,error.status);
 return error;
};
/** A refusal of the attempt checks: recorded on the attempt after the admission transaction rolled back. */
class AttemptRefused extends Error{constructor(readonly refusal:unknown){super('movement attempt refused');}}

/**
 * Start saving the chosen employees of a checked attempt. Same checks, refusals and Import History records as the
 * synchronous confirmation before it wrote anything; a confirmed attempt answers with its recorded counts, as before.
 * Everything else happens in the worker, which repeats the checks under the initiator's fresh authority.
 */
export async function startMovementImportJob(ctx:SessionContext,input:MovementConfirmInput&{locale:string;operationKey?:string}):Promise<{already:MovementUploadResult}|{job:MovementImportJobProgress;existing:boolean}>{
 if(!ctx.userId)throw new MovementImportJobError('Sign in again to import movements.',401);
 const operationKey=input.operationKey&&isBulkJobId(input.operationKey)?input.operationKey:undefined;
 try{
  return await withTenant(ctx,async tx=>{
   // A repeated request for the same confirmation rejoins its job instead of being judged again.
   if(operationKey){
    const [prior]=await tx.execute<BulkJobRow>(sql`select * from bulk_job where created_by=${ctx.userId}::uuid and operation_key=${operationKey}::uuid and kind=${MOVEMENT_IMPORT_KIND}`);
    if(prior)return{job:await progressTx(tx,prior),existing:true};
   }
   let held:Awaited<ReturnType<typeof confirmableMovementAttemptTx>>;
   try{held=await confirmableMovementAttemptTx(tx,ctx,input.attemptId,input.previewHash);}catch(error){throw new AttemptRefused(error);}
   if('already' in held)return{already:held.already};
   chosenMovementEmployees(held.plan,input.employees);
   const jobInput:MovementImportJobInput={attemptId:input.attemptId,previewHash:input.previewHash,employees:[...input.employees],acknowledgeExcluded:input.acknowledgeExcluded,
    acknowledgeClosedPayroll:input.acknowledgeClosedPayroll===true,locale:input.locale,sourceName:held.name};
   // The original file stays on the attempt; the worker reads it from there, as the confirmation always did.
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:MOVEMENT_IMPORT_KIND,operationKey,companyIds:held.companyIds,input:jobInput});
   return{job:await progressTx(tx,row),existing};
  });
 }catch(error){
  if(error instanceof AttemptRefused){await recordImportFailure(ctx,input.attemptId,'movement','failed',error.refusal);throw error.refusal;}
  throw kernelError(error);
 }
}
export async function getMovementImportJob(ctx:SessionContext,id:string){
 try{return await withTenant(ctx,async tx=>progressTx(tx,await bulkJobTx(tx,id,{kind:MOVEMENT_IMPORT_KIND})));}catch(error){throw kernelError(error);}
}
/** The signed-in user's most recent movement imports, newest first (the screen rejoins a running one). */
export async function listMovementImportJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await listBulkJobsTx(tx,ctx,MOVEMENT_IMPORT_KIND,10);
 const worker=rows.some(r=>r.state==='queued')?await bulkJobWorkerStatusTx(tx,MOVEMENT_IMPORT_KIND):'running';
 return rows.map(row=>movementImportJobProgress(row,worker));
});}
/** A job route's error reply: the kind's own refusals as they are, never raw SQL or cell values. */
export function movementImportJobHttpError(error:unknown){
 if(error instanceof MovementImportJobError)return Response.json({error:error.message},{status:error.status,headers:{'Cache-Control':'private, no-store'}});
 return Response.json({error:'The import request could not be completed. Reopen its progress before retrying.'},{status:500,headers:{'Cache-Control':'private, no-store'}});
}

// ---- The check of an uploaded file (kind movement_check, draft 9912), core/movement-import-check-worker.ts.
/** What the check worker reads back: the file's name, the screen's language (localized headers and refusal texts) and
 * the browser's operation key (one attempt per upload, as the synchronous check recorded it). The bytes are the job's
 * source content, removed when the job ends. */
export type MovementCheckJobInput={name:string;locale:string;operationKey?:string};
const checkState:Record<BulkJobState,MovementCheckJobState>={queued:'queued',preparing:'reading',running:'checking',finalizing:'finishing',discarding:'finishing',completed:'completed',failed:'failed',cancelled:'cancelled'};
export function movementCheckJobProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):MovementCheckJobProgress{
 return{id:row.id,sourceName:row.source_name||(row.input as MovementCheckJobInput|null)?.name||'',state:checkState[row.state],stepsTotal:row.steps_total,stepsDone:row.steps_done,error:row.error,
  result:(row.state==='completed'?row.result:null) as MovementCheckJobResult|null,
  updatedAt:new Date(row.updated_at).toISOString(),createdAt:new Date(row.created_at).toISOString(),worker:row.state==='queued'?worker:'running'};
}
async function checkProgressTx(tx:Tx,row:BulkJobRow){return movementCheckJobProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,MOVEMENT_CHECK_KIND):'running');}
const checkKernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new MovementImportJobError(error.message===BULK_JOB_ALREADY_RUNNING?MOVEMENT_CHECK_ALREADY_RUNNING:error.message==='Job unavailable.'?'Check unavailable.':error.message,error.status);
 return error;
};
/**
 * Start checking an uploaded movement file. The request only stores the file on the job; the protected import worker
 * reads it, checks each employee in its own short chunk (every change rolled back) and records the attempt with the
 * reviewed plan exactly as the synchronous check did. A repeated request with the same operation key rejoins its job.
 */
export async function startMovementCheckJob(ctx:SessionContext,input:{name:string;content:Buffer;locale:string;operationKey?:string}):Promise<{job:MovementCheckJobProgress;existing:boolean}>{
 if(!ctx.userId)throw new MovementImportJobError('Sign in again to import movements.',401);
 if(!isAdmin(ctx))throw new MovementImportJobError('Only an admin can import movements.',403);
 const operationKey=input.operationKey&&isBulkJobId(input.operationKey)?input.operationKey:undefined;
 const name=importSourceName(input.name,'movements.xlsx');
 try{
  return await withTenant(ctx,async tx=>{
   // The file's own name, as the synchronous check read and recorded it (format detection, attempt name).
   const jobInput:MovementCheckJobInput={name:input.name.slice(0,1000),locale:input.locale,...(operationKey?{operationKey}:{})};
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:MOVEMENT_CHECK_KIND,operationKey,source:{name,content:input.content},input:jobInput});
   return{job:await checkProgressTx(tx,row),existing};
  });
 }catch(error){throw checkKernelError(error);}
}
export async function getMovementCheckJob(ctx:SessionContext,id:string){
 try{return await withTenant(ctx,async tx=>checkProgressTx(tx,await bulkJobTx(tx,id,{kind:MOVEMENT_CHECK_KIND})));}catch(error){throw checkKernelError(error);}
}
/** The signed-in user's most recent movement checks, newest first (the screen rejoins a running one). */
export async function listMovementCheckJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await listBulkJobsTx(tx,ctx,MOVEMENT_CHECK_KIND,10);
 const worker=rows.some(r=>r.state==='queued')?await bulkJobWorkerStatusTx(tx,MOVEMENT_CHECK_KIND):'running';
 return rows.map(row=>movementCheckJobProgress(row,worker));
});}
