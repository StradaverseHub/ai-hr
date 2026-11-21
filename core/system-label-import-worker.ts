/** Staged System Labels import as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; migrations 5011,
 * 5012, 5013, 5070). All-or-nothing, as the single-transaction import was: the worker validates once with no writer lock
 * (refusing unless the preview token still matches), writes each new code through its ordinary writer in chunk
 * transactions of about 100 ms that hold the import's usual locks, and every staged row and audit event stays
 * invisible until one short release transaction makes the whole import visible. A refusal or a stop deletes the
 * staged rows in bounded owner batches; the release record keeps their chunk events hidden for good. The release
 * runs under the creator's authority (app role), so this kind declares no owner finalize; its one write to the job
 * itself goes through unit.set (sealed), and the discard runs in unit.ownerTx, attributed to the job. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {publicErrorMessage} from '../lib/public-error';
import type {LabelImportPreviewRow} from '../lib/system-label-definition';
import type {BulkJobRowError} from '../lib/bulk-job';
import type {SystemLabelImportResult} from '../lib/system-label-import-job';
import type {SystemLabelImportFailedRow} from '../lib/system-label-import-problems';
import {isTransientBulkJobError,type BulkJobHandler,type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {OPERATOR_CHUNK_BUDGET_MS,lockOperatorChunkTx} from './operator-chunks';
import {SYSTEM_LABEL_IMPORT_KIND,type SystemLabelImportJobInput} from './system-label-import-job';
import {SYSTEM_LABEL_GRADE_ALREADY_GROUPED,SYSTEM_LABEL_IMPORT_CHANGED,SYSTEM_LABEL_IMPORT_NOTHING,analyseSystemLabelImport,appendSystemLabelImportAppliedTx,applySystemLabelWriteTx,
 lockSystemLabelImportTx,systemLabelImportBlockedRows,systemLabelImportErrorReport,systemLabelImportEventRows,systemLabelImportSummary,
 type SystemLabelImportEventRow,type SystemLabelImportSummary,type SystemLabelWrite} from './system-label-import';

/** Step work per chunk before it commits (one new code costs a few milliseconds idle, far more on a loaded host). */
export const SYSTEM_LABEL_IMPORT_CHUNK_BUDGET_MS=Number(process.env.SYSTEM_LABEL_IMPORT_CHUNK_BUDGET_MS??OPERATOR_CHUNK_BUDGET_MS);
const DISCARD_BATCH=200;
/** What prepare stores for release: the preview's summary, its history rows and the rows the error workbook lists. */
export type SystemLabelImportStoredPlan={summary:SystemLabelImportSummary;eventRows:SystemLabelImportEventRow[];blocked:LabelImportPreviewRow[];
 /** The staged attempt that marks every row this import writes (bulk_job.attempt_id is Import History's). */
 attemptId?:string;released?:boolean;result?:SystemLabelImportResult;
 /** Board c074c6b8: the released plan keeps `blocked`, which the result screen and its Error Log read (jobs released
  * before this marker kept only the stored English report). */
 blockedKept?:true;
 /** Board c074c6b8: the rows that stopped a failed import, with their worksheet and Excel row. */
 failed?:SystemLabelImportFailedRow[]};
const inputOf=(job:BulkJobRow)=>job.input as SystemLabelImportJobInput;
const planOf=(job:BulkJobRow)=>(job.plan??{}) as SystemLabelImportStoredPlan;
const attemptOf=(job:BulkJobRow)=>planOf(job).attemptId??null;
const rowNumOf=(key:string)=>{const n=Number(key.slice(key.lastIndexOf(':')+1));return Number.isSafeInteger(n)?n:null;};
const sheetOf=(key:string)=>key.slice(0,key.lastIndexOf(':'));
const codeOf=(write:SystemLabelWrite)=>write.kind==='org'?String((write.orgKind==='department'?write.create.name:write.orgKind==='position'?write.create.title:write.create.code)??''):write.kind==='option'?write.input.value:write.kind==='grade'?write.input.code:write.input.name;

/** A visible code that appeared while the import was staged and that the preview's rules refuse. */
class ReleaseConflict extends Error{constructor(readonly rows:{kind:string;code:string}[]){super('Labels changed while the import was running.');}}
async function setImportAttemptTx(tx:Tx,attemptId:string){await tx.execute(sql`select set_config('app.import_attempt',${attemptId},true)`);}
/** The single-transaction import's writer locks, in its order; the tenant writer lock through the chunk lock owner. */
const lockTx=(tx:Tx,ctx:SessionContext)=>lockSystemLabelImportTx(tx,ctx,tx=>lockOperatorChunkTx(tx,ctx.tenantId));

export const systemLabelImportJobHandler:BulkJobHandler<SystemLabelWrite>={
 kind:SYSTEM_LABEL_IMPORT_KIND,
 mode:'atomic',
 chunkBudgetMs:SYSTEM_LABEL_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:32,
 phaseOf:()=>'codes',
 isTransient:isTransientBulkJobError,
 stepRef:step=>codeOf(step.payload).slice(0,200),
 /** Validate once, as the preview did and with no writer lock: the token proves nothing changed since the preview. */
 async prepare(ctx,job){
  const {token,selectedKeys}=inputOf(job);
  let analysed:Awaited<ReturnType<typeof analyseSystemLabelImport>>;
  try{analysed=await analyseSystemLabelImport(ctx,Buffer.from(job.source_content??Buffer.alloc(0)),selectedKeys);}
  catch(error){if(isTransientBulkJobError(error))throw error;return{refused:publicErrorMessage(error)};}
  const {preview,writes}=analysed;
  const summary=systemLabelImportSummary(preview);
  const counters={total:preview.rows.length,valid:summary.imported,skipped:summary.skipped,invalid:summary.failed};
  if(preview.token!==token)return{refused:SYSTEM_LABEL_IMPORT_CHANGED,counters};
  if(!preview.valid)return{refused:SYSTEM_LABEL_IMPORT_NOTHING,counters};
  const plan:SystemLabelImportStoredPlan={summary,eventRows:systemLabelImportEventRows(preview),blocked:systemLabelImportBlockedRows(preview)};
  return{steps:writes.map(write=>({kind:write.kind,rowNum:rowNumOf(write.key),payload:write})),counters,plan};
 },
 /** The administrator check of the request, repeated where the steps become runnable; the attempt marks every row. */
 async commitPrepareTx(tx,_ctx,_job,outcome){
  if('refused' in outcome)return;
  const [permission]=await tx.execute<{allowed:boolean}>(sql`select app.is_admin() and app.principal_snapshot_current() as allowed`);
  if(!permission?.allowed)throw new Error('Only an administrator may import System Labels.');
  return{plan:{...(outcome.plan as SystemLabelImportStoredPlan),attemptId:randomUUID()}};
 },
 async beginChunkTx(tx,ctx,job){
  await setImportAttemptTx(tx,attemptOf(job)!);
  await lockTx(tx,ctx);
 },
 async applyStepTx(tx,ctx,_job,step){
  await applySystemLabelWriteTx(tx,ctx,step.payload);
  return{counters:{imported:1}};
 },
 /** Release (one short transaction under the same locks), then the result the screen shows. */
 async finalize(ctx,job,unit){
  const plan=planOf(job);
  if(!plan.released){await release(ctx,job,unit,plan);return'more';}
  return{result:plan.result??{...plan.summary}};
 },
 onFailure:job=>planOf(job).released?'fail':'discard',
 async describeFailure(job,error,step,owner){
  if(error instanceof ReleaseConflict){
   // Board c074c6b8: name each conflicting code's worksheet and Excel row, from this job's own steps (one bounded read).
   const codes=[...new Set(error.rows.map(r=>r.code.trim().toLowerCase()))];
   const steps=await owner<{key:string;row_num:number|null;code:string}[]>`select payload->>'key' as key,row_num,code from (select payload,row_num,
     case payload->>'kind' when 'org' then case payload->>'orgKind' when 'department' then payload#>>'{create,name}' when 'position' then payload#>>'{create,title}' else payload#>>'{create,code}' end
      when 'option' then payload#>>'{input,value}' when 'grade' then payload#>>'{input,code}' else payload#>>'{input,name}' end as code
     from bulk_job_step where job_id=${job.id}::uuid) s where lower(btrim(code)) in (select jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb)) limit 400`;
   const rows=error.rows.map(r=>{const at=steps.find(st=>sheetOf(st.key)===r.kind&&st.code.trim().toLowerCase()===r.code.trim().toLowerCase());
    return{sheet:r.kind,row:at?.row_num??null,code:r.code.slice(0,200),detail:'releaseConflict' as const,message:''};});
   return{error:`No labels were imported. ${error.message} Preview the workbook again.`,
    errors:rows.map(r=>({rowNum:r.row??0,ref:r.code,message:`Code "${r.code}" was added by someone else while the import was running.`})),planMerge:{failed:rows}};
  }
  const message=publicErrorMessage(error);
  if(planOf(job).released)return{error:`The labels were imported; finishing the import needs attention: ${message}`};
  const errors:BulkJobRowError[]=step?[{rowNum:step.row_num??0,ref:codeOf(step.payload as SystemLabelWrite).slice(0,200),message:message.slice(0,1000)}]:[];
  const failed:SystemLabelImportFailedRow[]=step?[{sheet:sheetOf((step.payload as SystemLabelWrite).key),row:step.row_num??null,code:errors[0].ref,
   detail:message===SYSTEM_LABEL_GRADE_ALREADY_GROUPED?'gradeAlreadyGrouped':'saveRefused',message:message.slice(0,1000)}]:[];
  return{error:step?`No labels were imported${step.row_num?`; row ${step.row_num} was refused`:''}. ${message}`:`No labels were imported. ${message}`,errors,...(failed.length?{planMerge:{failed}}:{})};
 },
 /** Delete every staged row in bounded owner batches; the last batch records the attempt as discarded. */
 async discard(job,unit){
  const attemptId=attemptOf(job);
  if(!attemptId)return'done';
  const started=performance.now();
  // One bounded owner transaction per unit, attributed to the job (app.bulk_job); the definer checks the attempt itself.
  const remaining=await unit.ownerTx(async owner=>{
   const [r]=await owner<{remaining:string}[]>`select app.system_label_import_discard_batch(${job.tenant_id}::uuid,${attemptId}::uuid,${job.id}::uuid,${job.created_by}::uuid,${DISCARD_BATCH}) as remaining`;
   return Number(r.remaining);
  });
  unit.metric('discardTxMs',performance.now()-started);
  return remaining>0?'more':'done';
 },
};

/** The visibility flip: conflicts and the administrator's authority are rechecked under the import's writer locks,
 * and the release record and the import's history event commit together. Constant in the size of the workbook
 * apart from the conflict probe, which reads only this import's staged rows through their marker index. */
async function release(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,plan:SystemLabelImportStoredPlan){
 const started=performance.now();
 await withTenant(ctx,async tx=>{
  await tx.execute(sql`select set_config('application_name','aihr-bulk:system_label_import:release',true)`);
  await unit.fenceTx(tx);
  await lockTx(tx,ctx);
  const conflicts=await tx.execute<{kind:string;code:string}>(sql`select kind,code from app.system_label_import_conflicts(${attemptOf(job)}::uuid)`);
  if(conflicts.length)throw new ReleaseConflict([...conflicts].slice(0,200));
  await tx.execute(sql`select app.system_label_import_release_attempt(${attemptOf(job)}::uuid,${job.id}::uuid)`);
  await appendSystemLabelImportAppliedTx(tx,ctx,plan.summary,plan.eventRows);
  const result:SystemLabelImportResult={...plan.summary,...systemLabelImportErrorReport(plan.blocked)};
  // Board c074c6b8: keep the refused and skipped rows; the result screen lists them and its Error Log is built from them.
  const next:SystemLabelImportStoredPlan={summary:plan.summary,eventRows:[],blocked:plan.blocked,blockedKept:true,attemptId:plan.attemptId,released:true,result};
  await unit.set(tx,{plan:next});
 });
 unit.metric('releaseTxMs',performance.now()-started);
}
