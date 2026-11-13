/** Admission and creator-scoped progress for background System Labels imports, a client of the shared bulk-job
 * kernel (core/bulk-job.ts; migrations 5011, 5070). The request only checks and enqueues; the worker
 * (core/system-label-import-worker.ts) validates against the preview token, stages the codes and releases them. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {readSystemLabelWorkbook,LABEL_WORKBOOK_MAX_BYTES} from '../lib/system-label-workbook';
import {SYSTEM_LABEL_IMPORT_ALREADY_RUNNING,type SystemLabelImportProgress,type SystemLabelImportResult} from '../lib/system-label-import-job';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobId,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import type {BulkJobRowError,BulkJobState} from '../lib/bulk-job';
import type {LabelImportPreviewRow} from '../lib/system-label-definition';
import type {SystemLabelImportFailedRow} from '../lib/system-label-import-problems';

export const SYSTEM_LABEL_IMPORT_KIND='system_label_import';
export class SystemLabelImportJobError extends Error{constructor(message:string,readonly status=400){super(message);}}
/** What the worker reads back besides the workbook bytes (kept as the job's source until it ends). */
export type SystemLabelImportJobInput={token:string;selectedKeys?:string[]};

export function systemLabelImportProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):SystemLabelImportProgress{
 return{id:row.id,state:row.state,sourceName:row.source_name,stepsTotal:row.steps_total,stepsDone:row.steps_done,
  error:row.error,errors:row.errors??[],result:(row.state==='completed'?row.result:null) as SystemLabelImportResult|null,
  worker:row.state==='queued'?worker:'running',createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()};
}
async function progressTx(tx:Tx,row:BulkJobRow){return systemLabelImportProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,SYSTEM_LABEL_IMPORT_KIND):'running');}
const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new SystemLabelImportJobError(error.message===BULK_JOB_ALREADY_RUNNING?SYSTEM_LABEL_IMPORT_ALREADY_RUNNING:error.message==='Job unavailable.'?'Import unavailable.':error.message,error.status);
 return error;
};
/** Start the import the administrator confirmed in the preview. Same administrator check the single-transaction
 * import made when it was requested; the worker repeats the analysis and refuses if the preview token changed. */
export async function startSystemLabelImportJob(ctx:SessionContext,p:{bytes:Buffer;token:string;selectedKeys?:string[];fileName?:string;operationKey?:string}):Promise<{job:SystemLabelImportProgress;existing:boolean}>{
 if(!ctx.userId)throw new SystemLabelImportJobError('Sign in again to import System Labels.',401);
 const bytes=Buffer.from(p.bytes);
 if(!bytes.length||bytes.length>LABEL_WORKBOOK_MAX_BYTES)throw new SystemLabelImportJobError('Choose an XLSX or XLS file no larger than 5 MB.');
 if(!/^[0-9a-f]{64}$/.test(p.token))throw new SystemLabelImportJobError('Preview the workbook again.');
 if(!readSystemLabelWorkbook(bytes).length)throw new SystemLabelImportJobError('The workbook contains no label data. Fill in new codes in a recognised category sheet.');
 const input:SystemLabelImportJobInput={token:p.token,...(p.selectedKeys?{selectedKeys:p.selectedKeys.slice()}:{})};
 try{
  return await withTenant(ctx,async tx=>{
   const [permission]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() as allowed`);
   if(!permission?.allowed)throw new SystemLabelImportJobError('Only an administrator may import System Labels.',403);
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:SYSTEM_LABEL_IMPORT_KIND,operationKey:p.operationKey,
    source:{name:(p.fileName||'system-labels.xlsx').slice(0,255),content:bytes},input});
   return{job:await progressTx(tx,row),existing};
  });
 }catch(error){throw kernelError(error);}
}
export async function getSystemLabelImportJob(ctx:SessionContext,id:string){
 try{return await withTenant(ctx,async tx=>progressTx(tx,await bulkJobTx(tx,id,{kind:SYSTEM_LABEL_IMPORT_KIND})));}catch(error){throw kernelError(error);}
}
/** The signed-in administrator's most recent imports, newest first (the page rejoins a running one). */
export async function listSystemLabelImportJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await listBulkJobsTx(tx,ctx,SYSTEM_LABEL_IMPORT_KIND,10);
 const worker=rows.some(r=>r.state==='queued')?await bulkJobWorkerStatusTx(tx,SYSTEM_LABEL_IMPORT_KIND):'running';
 return rows.map(row=>systemLabelImportProgress(row,worker));
});}
/** Board c074c6b8: what one import's problem list is built from, exactly as the worker stored it (no re-validation:
 * checking the file again after it was imported would call its own new codes "already exists"). */
export type SystemLabelImportProblemSource={id:string;state:BulkJobState;blocked:LabelImportPreviewRow[];failed:SystemLabelImportFailedRow[];
 errors:BulkJobRowError[];error:string|null;
 /** A completed import released before its refused rows were kept: only its stored English report exists. */
 legacy:boolean};
/** One bounded read of the creator's own job row (bulk_job row security), as the progress route reads it. */
export async function readSystemLabelImportProblems(ctx:SessionContext,id:string):Promise<SystemLabelImportProblemSource>{
 try{return await withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{id:string;state:BulkJobState;plan:Record<string,unknown>|null;error:string|null;errors:BulkJobRowError[]|null}>(
   sql`select id,state,plan,error,errors from bulk_job where id=${bulkJobId(id)}::uuid and kind=${SYSTEM_LABEL_IMPORT_KIND}`);
  if(!row)throw new BulkJobError('Job unavailable.',404);
  const plan=(row.plan??{}) as {blocked?:LabelImportPreviewRow[];blockedKept?:boolean;released?:boolean;failed?:SystemLabelImportFailedRow[]};
  const completed=row.state==='completed',failed=row.state==='failed';
  return{id:row.id,state:row.state,blocked:completed&&plan.blockedKept?plan.blocked??[]:[],failed:failed?plan.failed??[]:[],
   errors:failed?row.errors??[]:[],error:failed?row.error:null,legacy:completed&&!plan.blockedKept};
 });}catch(error){throw kernelError(error);}
}
