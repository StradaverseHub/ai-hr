/** The CHECK of an uploaded movement file as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; kind row
 * in draft 5077).
 *
 * The synchronous check (previewMovementUpload) rehearsed every employee in its own transaction that always rolled back,
 * under the exclusive Access lock, all inside the web request. Here the request only stores the file on the job; the
 * worker reads and plans it once (prepare, no tenant lock), then checks one employee per step in a savepoint of its
 * chunk that always rolls back, with the chunk's shared reads (MovementChunkReads), and records the import attempt with
 * the sealed plan in one short transaction at the end (recordMovementPreview, shared with the synchronous check). The
 * result is exactly what the synchronous check returned: the attempt, its reviewed preview hash and the preview. */
import {sql} from 'drizzle-orm';
import {isTransientBulkJobError,type BulkJobHandler} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {ImportHistoryError} from './import-history';
import {beginMovementChunkTx,checkMovementEmployeeTx,movementCheckCounts,movementCheckRefusedEmployee,movementUncheckedEmployee,planMovementCheck,type MovementChunkReads} from './movement-import';
import {recordMovementPreview,sourceRecords,type MovementCheckSource} from './movement-import-history';
import {MOVEMENT_CHECK_KIND,type MovementCheckJobInput} from './movement-import-job';
import {movementImportResolver} from './movement-import-worker';
import {withTenant} from '../db/client';
import {defaultLocale} from '../i18n/config';
import type {MovementImportEmployee,MovementImportPreview,MovementImportRecord} from '../lib/movement-import-contract';
import type {MovementCheckJobResult} from '../lib/movement-import-job';
import {movementImportIssueText} from '../lib/movement-import-issues';

/** Wall-clock step work per chunk before it commits: one employee's check is longer, so a chunk checks one employee. */
export const MOVEMENT_CHECK_CHUNK_BUDGET_MS=Number(process.env.MOVEMENT_CHECK_CHUNK_BUDGET_MS??100);
type StepPayload={key:string;records:MovementImportRecord[]};
/** What the job keeps between units. The file's records stay in the step payloads (removed at the end). */
export type MovementCheckStoredPlan={sourceName:string;inputHash?:string;selection?:number[];fileErrors?:string[];sourceHash?:string;catalogueHash?:string;
 names?:[string,string][];
 /** File order: an employee whose company could not be resolved is kept as checked; the others point at their step. */
 order?:{key:string;seq?:number;checked?:MovementImportEmployee}[];
 /** Set in the attempt's own transaction, so a repeated finalize never records a second attempt. */
 recorded?:MovementCheckJobResult};
const inputOf=(job:BulkJobRow)=>job.input as MovementCheckJobInput|null;
const planOf=(job:BulkJobRow)=>(job.plan??{sourceName:inputOf(job)?.name??''}) as MovementCheckStoredPlan;
const isTransient=(error:unknown)=>isTransientBulkJobError(error);
/** The route's finite application codes; anything else (database wrappers included) is a refused change. */
const FINITE=/^(?:workbook_[a-z_]+|file_too_large|invalid_file|unknown_or_inactive_event_type|too_many_employees|movement_reference_catalog_too_large)$/;
async function refusalText(job:BulkJobRow,error:unknown){
 if(error instanceof ImportHistoryError)return error.message;
 const raw=error instanceof Error&&!('query'in error)&&!('cause'in error)?error.message:'';
 return movementImportIssueText(FINITE.test(raw)?raw:'change_refused',await movementImportResolver(inputOf(job)?.locale??defaultLocale));
}
const chunkReads=new Map<string,MovementChunkReads>();
const fileOf=(job:BulkJobRow)=>{if(!job.source_content)throw new Error('The movement file is no longer available.');return Buffer.from(job.source_content);};
const groupOf=(plan:MovementCheckStoredPlan,payload:StepPayload)=>({key:payload.key,records:payload.records,selection:plan.selection!,names:new Map(plan.names??[])});

export const movementCheckJobHandler:BulkJobHandler<StepPayload>={
 kind:MOVEMENT_CHECK_KIND,
 mode:'per-step',
 chunkBudgetMs:MOVEMENT_CHECK_CHUNK_BUDGET_MS,
 maxStepsPerChunk:4,
 // A step that keeps meeting lock or serialization refusals is reported as that employee's refused change.
 transientStepLimit:30,
 phaseOf:()=>'employees',
 isTransient,
 stepRef:step=>step.payload.records[0]?.employeeCode??'',
 /** Read and plan the file once, with no tenant lock held. */
 async prepare(ctx,job){
  const input=inputOf(job)!;const resolve=await movementImportResolver(input.locale);
  const base:MovementCheckStoredPlan={sourceName:input.name};
  let source:MovementCheckSource;
  try{source=await sourceRecords(ctx,input.name,fileOf(job),{resolve});}catch(error){if(isTransient(error))throw error;return{refused:await refusalText(job,error),plan:base};}
  if(source.fileErrors.length)return{steps:[],plan:{...base,fileErrors:source.fileErrors,sourceHash:source.sourceHash,catalogueHash:source.catalogueHash}};
  let planned:Awaited<ReturnType<typeof planMovementCheck>>;
  try{planned=await planMovementCheck(ctx,{records:source.records,sourceHash:source.sourceHash,catalogueHash:source.catalogueHash});}catch(error){if(isTransient(error))throw error;return{refused:await refusalText(job,error),plan:base};}
  const names=new Map(planned.names),order:NonNullable<MovementCheckStoredPlan['order']>=[],steps:{kind:string;rowNum:number;payload:StepPayload}[]=[];
  for(const {key,records} of planned.groups){
   const checked=movementUncheckedEmployee({key,records,selection:planned.selection,names});
   if(checked){order.push({key,checked});continue;}
   order.push({key,seq:steps.length});steps.push({kind:'employee',rowNum:Math.min(...records.map(r=>r.row)),payload:{key,records}});
  }
  return{steps,plan:{...base,inputHash:planned.inputHash,selection:planned.selection,fileErrors:planned.fileErrors,sourceHash:source.sourceHash,catalogueHash:source.catalogueHash,names:planned.names,order},counters:{employees:steps.length}};
 },
 /** The locks every employee transaction of the synchronous check took, once for the chunk, and its shared reads. */
 async beginChunkTx(tx,ctx,job){chunkReads.set(job.id,await beginMovementChunkTx(tx,ctx));},
 /** One employee, rehearsed in a savepoint that always rolls back; its preview is the step's result. */
 async applyStepTx(tx,ctx,job,step){
  const plan=planOf(job);
  const checked=await checkMovementEmployeeTx(tx,ctx,{...groupOf(plan,step.payload),inputHash:plan.inputHash!,catalogueHash:plan.catalogueHash},chunkReads.get(job.id)!,isTransient);
  const counters:Record<string,number>=checked.fingerprint?{valid:1}:{invalid:1};
  return{result:checked,counters};
 },
 /** The preview in file order, then the attempt in one short transaction fenced on the lease. */
 async finalize(ctx,job,unit){
  chunkReads.delete(job.id);
  const plan=planOf(job);
  if(plan.recorded)return{result:plan.recorded};
  const input=inputOf(job)!;const resolve=await movementImportResolver(input.locale);
  let preview:MovementImportPreview={inputHash:plan.inputHash??'',selection:plan.selection??[],fileErrors:plan.fileErrors??[],employees:[],excluded:0,valid:0};
  if(!preview.fileErrors.length){
   const steps=await withTenant(ctx,tx=>tx.execute<{seq:number;state:string;payload:StepPayload;result:MovementImportEmployee|null}>(sql`select seq,state,payload,result from bulk_job_step where job_id=${job.id}::uuid order by seq`));
   const bySeq=new Map([...steps].map(s=>[s.seq,s]));
   for(const entry of plan.order??[]){
    if(entry.checked){preview.employees.push(entry.checked);continue;}
    const step=bySeq.get(entry.seq!);if(!step)throw new Error('Movement check step unavailable.');
    preview.employees.push(step.state==='applied'&&step.result?step.result:movementCheckRefusedEmployee(groupOf(plan,step.payload)));
   }
   preview=movementCheckCounts(preview);
  }else preview={inputHash:'',selection:[],fileErrors:plan.fileErrors!,employees:[],excluded:0,valid:0};
  const source={fileErrors:plan.fileErrors??[],sourceHash:plan.sourceHash!,catalogueHash:plan.catalogueHash!};
  const started=performance.now();
  const recorded=await recordMovementPreview(ctx,{name:input.name,content:fileOf(job),operationKey:input.operationKey??job.id,source,preview,resolve},{
   before:async tx=>{await tx.execute(sql`select set_config('application_name','aihr-bulk:movement_check:finalize',true)`);await unit.fenceTx(tx);},
   // The marker commits with the attempt, through the sealed job update (the hook above fenced this transaction).
   after:async(tx,attempt)=>{await unit.set(tx,{planMerge:{recorded:{...attempt,preview}}});},
  });
  unit.metric('recordTxMs',performance.now()-started);
  return{result:recorded};
 },
 async afterTerminal(_ctx,job){chunkReads.delete(job.id);},
};
