/** Staged employee import as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; migrations 9001, 9003,
 * 9004). Steps are applied in short chunk transactions under the initiating user's authority and stay invisible.
 * Activation is a constant-time release of the attempt; the markers are then settled in bounded owner batches.
 * A failure before release discards the staged rows in bounded batches (ADR-0157 void trail). */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {publicErrorMessage} from '@/lib/public-error';
import {isTransientBulkJobError,type BulkJobHandler,type BulkJobStep,type BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {parseEmployeeImportUpload} from './employee-import-upload';
import {applyEmployeeImportStepTx,assertEmployeeImportAuthorityTx,prepareEmployeeImportJobPlan,recordEmployeeImportAttemptTx,recordImportRun,type EmployeeImportJobPlan,type EmployeeImportPlanStep} from './import';
import {ImportHistoryError,recordImportEventTx,recordImportFailure} from './import-history';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {syncChildReliefFromFamily} from './dependents';
import {claimEmployeeImportEvaluationTx,completeEmployeeImportEvaluationTx} from './personnel-import-evaluation';
import {EMPLOYEE_IMPORT_KIND,type EmployeeImportJobInput} from './employee-import-job';
import type {AllocationImportPreview} from '../lib/cost-allocation-import';
import type {EmployeeImportResultSummary} from '../lib/employee-import-job';
import type {RowResult} from '../lib/import-schema';
import type {BulkJobRowError} from '../lib/bulk-job';

export const EMPLOYEE_IMPORT_CHUNK_BUDGET_MS=Number(process.env.EMPLOYEE_IMPORT_CHUNK_BUDGET_MS??200);
/** Target wall time of one settle or discard batch, and its bounds in rows per table. */
const BATCH_TARGET_MS=Number(process.env.EMPLOYEE_IMPORT_BATCH_TARGET_MS??200);
const BATCH_MIN=10,BATCH_MAX=1000;
export type EmployeeImportStoredPlan={allocationPreview?:AllocationImportPreview;rejected?:RowResult[];skipped?:number;companyId:string;
 replay?:{imported:number;skipped:number;dependents:number;qualification:number;emergency:number};released?:boolean;settled?:boolean;
 counts?:{imported:number;dependents:number;qualification:number;emergency:number}};
type StepResult={employmentId?:string;personId?:string;family?:number;register?:'qualification'|'emergency';subordinate?:string;manager?:string;target?:{employmentId:string;personId:string}|null};
const isTransient=(error:unknown)=>isTransientBulkJobError(error);
export {isTransient as isTransientEmployeeImportError};

class ActivationConflict extends Error{constructor(readonly rows:BulkJobRowError[]){super('Employee data changed before the import could be finished.');}}
const inputOf=(job:BulkJobRow)=>job.input as EmployeeImportJobInput;
const planOf=(job:BulkJobRow)=>(job.plan??{companyId:inputOf(job)?.upload.companyId}) as EmployeeImportStoredPlan;
/** The validated plan travels from prepare to the commit transaction of the same tick (never persisted twice). */
const prepared=new Map<string,EmployeeImportJobPlan&{parsed:ReturnType<typeof parseEmployeeImportUpload>}>();

/** Rebuilds the map of already applied rows from their committed step results (survives a worker restart). */
async function stepEnv(tx:Tx,job:BulkJobRow,cache:Map<string,unknown>){
 let env=cache.get('env') as {employmentByIndex:Map<number,string>;registerSubjects:Map<string,{employmentId:string;personId:string}>}|undefined;
 if(env)return env;
 env={employmentByIndex:new Map(),registerSubjects:new Map()};
 const rows=await tx.execute<{payload:EmployeeImportPlanStep;result:StepResult}>(sql`select payload,result from bulk_job_step where job_id=${job.id}::uuid and kind='employee' and state='applied'`);
 for(const r of rows){if(r.payload.kind!=='employee'||!r.result?.employmentId)continue;env.employmentByIndex.set(r.payload.index,r.result.employmentId);const code=r.payload.row.hire.employeeCode;if(code&&r.result.personId)env.registerSubjects.set(code,{employmentId:r.result.employmentId,personId:r.result.personId});}
 cache.set('env',env);return env;
}
async function setImportAttemptTx(tx:Tx,attemptId:string){await tx.execute(sql`select set_config('app.import_attempt',${attemptId},true)`);}
/** Adaptive batch size so one settle or discard statement stays near BATCH_TARGET_MS of tenant-lock time. */
const batchSizes=new Map<string,number>();
async function ownerBatch(job:BulkJobRow,unit:Pick<BulkJobUnit,'metric'>,name:string,run:(limit:number)=>Promise<number>){
 const limit=batchSizes.get(job.id)??100;const started=performance.now();
 const remaining=await run(limit);
 const ms=performance.now()-started;unit.metric(`${name}TxMs`,ms);
 batchSizes.set(job.id,Math.max(BATCH_MIN,Math.min(BATCH_MAX,Math.round(limit*Math.min(2,Math.max(0.25,BATCH_TARGET_MS/Math.max(ms,1)))))));
 return remaining;
}

export const employeeImportJobHandler:BulkJobHandler<EmployeeImportPlanStep>={
 kind:EMPLOYEE_IMPORT_KIND,
 mode:'atomic',
 chunkBudgetMs:EMPLOYEE_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:64,
 phaseOf:kind=>kind==='employee'?'employees':kind==='superior'?'superiors':'registers',
 isTransient,
 stepRef:step=>(step.payload as {email?:string}).email??'',
 /** Validate once with no tenant locks; a whole-file problem refuses the import before anything is written. */
 async prepare(ctx,job){
  const {upload:input}=inputOf(job);
  const parsed=parseEmployeeImportUpload(input);
  const plan=await prepareEmployeeImportJobPlan(ctx,{companyId:input.companyId,records:parsed.records,dependentRecords:parsed.dependentRecords,registerRecords:parsed.registerRecords,allocationRecords:parsed.allocationRecords,allocationToken:input.allocationToken});
  prepared.set(job.id,{...plan,parsed});
  const counters={total:plan.total,valid:plan.valid,invalid:plan.invalid};
  const stored:EmployeeImportStoredPlan={companyId:input.companyId,allocationPreview:plan.allocationPreview,rejected:plan.rejected,skipped:plan.total-plan.valid};
  if(plan.fileErrors.length)return{refused:plan.fileErrors.join(' '),counters,companyIds:plan.companyIds,plan:stored};
  return{steps:plan.steps.map(step=>({kind:step.kind,rowNum:step.rowNum,payload:step})),counters,companyIds:plan.companyIds,plan:stored};
 },
 /** The attempt (Import History), the authority check and an evaluation claim commit with the runnable steps. */
 async commitPrepareTx(tx,ctx,job,outcome){
  const plan=prepared.get(job.id);prepared.delete(job.id);
  if(!plan)throw new Error('Employee import plan unavailable; it will be prepared again.');
  const {upload,evaluationBinding}=inputOf(job);
  await assertEmployeeImportAuthorityTx(tx,ctx,upload.companyId,plan.companyIds);
  const source={name:job.source_name,content:Buffer.from(job.source_content??Buffer.alloc(0)),operationKey:job.operation_key};
  const {attemptId}=await recordEmployeeImportAttemptTx(tx,ctx,{companyId:upload.companyId,records:plan.parsed.records,fileName:upload.fileName,source},plan.preview,plan.resolved);
  if(evaluationBinding&&!('refused' in outcome)){
   // The write phase starts here, as in the synchronous measured import's transaction.
   const claimed=await claimEmployeeImportEvaluationTx(tx,ctx,evaluationBinding,{companyId:upload.companyId,records:plan.parsed.records,dependentRecords:plan.parsed.dependentRecords,registerRecords:plan.parsed.registerRecords,allocationRecords:plan.parsed.allocationRecords});
   if(claimed.replayed)throw new ImportHistoryError('This import was already completed; nothing new was written.');
  }
  return{attemptId};
 },
 async beginChunkTx(tx,ctx,job){
  await setImportAttemptTx(tx,job.attempt_id!);
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 },
 async applyStepTx(tx,ctx,job,step,cache){
  const env=await stepEnv(tx,job,cache);
  const saved=await applyEmployeeImportStepTx(tx,ctx,step.payload,{attemptId:job.attempt_id!,allocationPreview:planOf(job).allocationPreview,...env});
  return{result:saved,counters:step.kind==='employee'?{imported:1}:undefined};
 },
 /** Release (one short transaction), then settle in bounded batches, then the post-commit follow-ups. */
 async finalize(ctx,job,unit){
  const plan=planOf(job);
  if(!plan.released){await release(ctx,job,unit,plan);return'more';}
  if(!plan.settled){
   const remaining=await ownerBatch(job,unit,'settle',async limit=>{const [r]=await unit.owner<{remaining:string}[]>`select app.import_settle(${job.tenant_id}::uuid,${job.attempt_id}::uuid,${limit}) as remaining`;return Number(r.remaining);});
   if(remaining===0)await unit.owner`update bulk_job set plan=plan||'{"settled":true}'::jsonb where id=${job.id}::uuid`;
   return'more';
  }
  batchSizes.delete(job.id);
  return{result:await followUps(ctx,job,plan)};
 },
 onFailure:job=>planOf(job).released?'fail':'discard',
 async describeFailure(job,error,step,owner){
  if(error instanceof ActivationConflict)return{error:`No employee rows were written. ${error.message}`,errors:error.rows};
  const message=publicErrorMessage(error);
  const rows=await owner<{row_num:number;email:string}[]>`select row_num,payload->>'email' as email from bulk_job_step where job_id=${job.id}::uuid and kind='employee' order by seq`;
  const errors=rows.map(r=>({rowNum:r.row_num,ref:r.email??'',message:step&&r.row_num===step.row_num?message:'Not written because the import was rolled back.'}));
  if(planOf(job).released)return{error:`The employees were imported; finishing the import needs attention: ${message}`};
  return{error:step?`No employee rows were written. The import was rolled back${step.row_num?` after row ${step.row_num} was refused`:''}. ${message}`:`Import stopped: ${message}`,errors};
 },
 /** Void every staged row in bounded owner batches (ADR-0157), release the attempt as discarded, then settle. */
 async discard(job,unit){
  if(!job.attempt_id)return'done';
  const plan=planOf(job);
  if(!plan.released){
   const reason=(job.error??'Employee import was stopped before activation.').slice(0,900);
   const remaining=await ownerBatch(job,unit,'discard',async limit=>{const [r]=await unit.owner<{remaining:string}[]>`select app.import_discard_batch(${job.tenant_id}::uuid,${job.attempt_id}::uuid,${job.created_by}::uuid,${reason.length<3?'Import stopped.':reason},${limit}) as remaining`;return Number(r.remaining);});
   if(remaining===0)await unit.owner`update bulk_job set plan=coalesce(plan,'{}'::jsonb)||'{"released":true}'::jsonb where id=${job.id}::uuid`;
   return'more';
  }
  const remaining=await ownerBatch(job,unit,'settle',async limit=>{const [r]=await unit.owner<{remaining:string}[]>`select app.import_settle(${job.tenant_id}::uuid,${job.attempt_id}::uuid,${limit}) as remaining`;return Number(r.remaining);});
  if(remaining>0)return'more';
  await unit.owner`update bulk_job set plan=null,input=null,source_content=null where id=${job.id}::uuid`;
  await unit.owner`delete from bulk_job_step where job_id=${job.id}::uuid`;
  batchSizes.delete(job.id);
  return'done';
 },
 /** Import History for a failed or stopped job, under the creator's authority (best effort, as before). */
 async afterTerminal(ctx,job){
  if(job.state==='completed'||!ctx)return;
  const plan=planOf(job);
  if(job.attempt_id)await recordImportFailure(ctx,job.attempt_id,'employee_full','failed',new ImportHistoryError(job.error??'Employee import stopped before activation.'));
  await recordImportRun(ctx,{companyId:plan.companyId??inputOf(job)?.upload.companyId,fileName:job.source_name,totalRows:Number(job.counters?.total??0),imported:0,
   rejected:plan.rejected??[],failed:(job.errors??[]).map(e=>({rowNum:e.rowNum,email:e.ref,message:e.message}))});
 },
};

/** The visibility flip. Counts and outcome targets are read first without locks; then the duplicate-email recheck,
 * the attempt release, the completion events and an evaluation receipt commit together in one short transaction. */
async function release(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,plan:EmployeeImportStoredPlan){
 const attemptId=job.attempt_id!;const companyIds=job.company_ids??[];const {evaluationBinding}=inputOf(job);
 const summary=await withTenant(ctx,async tx=>{
  const [counts]=await tx.execute<{imported:number;dependents:number;qualification:number;emergency:number}>(sql`select count(*) filter (where kind='employee')::int as imported,
   coalesce(sum(jsonb_array_length(coalesce(payload->'family','[]'::jsonb))) filter (where kind='employee'),0)::int as dependents,
   count(*) filter (where kind='register' and payload->>'registerKind'='qualification')::int as qualification,count(*) filter (where kind='register' and payload->>'registerKind'='emergency')::int as emergency
   from bulk_job_step where job_id=${job.id}::uuid and state='applied'`);
  if(!evaluationBinding)return{counts,targets:[] as {kind:'person'|'employment';id:string}[]};
  // The measured import's erasure references come from the canonical rows actually written, never from the file.
  const rows=await tx.execute<{result:StepResult}>(sql`select result from bulk_job_step where job_id=${job.id}::uuid and state='applied' order by seq`);
  const targets=new Map<string,{kind:'person'|'employment';id:string}>();
  const add=(kind:'person'|'employment',id?:string|null)=>{if(id)targets.set(kind+':'+id,{kind,id});};
  for(const {result:r} of rows){add('employment',r?.employmentId);add('person',r?.personId);add('employment',r?.subordinate);add('employment',r?.manager);add('employment',r?.target?.employmentId);add('person',r?.target?.personId);}
  return{counts,targets:[...targets.values()]};
 });
 const started=performance.now();
 await withTenant(ctx,async tx=>{
  await tx.execute(sql`select set_config('application_name','aihr-bulk:employee_import:release',true)`);
  await unit.fenceTx(tx);
  // The same writer lock as every hire: duplicate emails are rechecked against persons that became visible since
  // validation, and no other workforce writer can commit one between this check and the release.
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await assertEmployeeImportAuthorityTx(tx,ctx,plan.companyId,companyIds);
  const conflicts=await tx.execute<{employment_id:string;email:string}>(sql`select employment_id,email from app.import_activation_conflicts(${attemptId}::uuid)`);
  if(conflicts.length){
   const rows=await tx.execute<{row_num:number;email:string}>(sql`select row_num,payload->>'email' as email from bulk_job_step where job_id=${job.id}::uuid and kind='employee' and result->>'employmentId' = any(${`{${conflicts.map(c=>c.employment_id).join(',')}}`}::text[])`);
   throw new ActivationConflict(rows.map(r=>({rowNum:r.row_num,ref:r.email,message:`Email "${r.email}" is already used by another employee (Allow Duplicated Work Email is off)`})));
  }
  await tx.execute(sql`select app.import_release(${attemptId}::uuid)`);
  const {counts}=summary;const skipped=Number(job.counters?.total??0)-Number(job.counters?.valid??0);
  await recordImportEventTx(tx,ctx,{attemptId,kind:'confirmed',importKind:'employee_full',detail:{succeeded:counts.imported,failed:Number(job.counters?.invalid??0)}});
  const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employee-import',aggregateId:plan.companyId,eventType:'employee-import.completed',actor:actorOf(ctx),
   payload:{companyId:plan.companyId,imported:counts.imported,failed:0,skipped,companyIds,dependents:counts.dependents,registers:{qualification:counts.qualification,emergency:counts.emergency}}},{returnId:true});
  if(evaluationBinding)await completeEmployeeImportEvaluationTx(tx,ctx,evaluationBinding,plan.companyId,eventId,{imported:counts.imported,failed:0,skipped,dependents:counts.dependents,qualification:counts.qualification,emergency:counts.emergency},summary.targets);
  const next:EmployeeImportStoredPlan={...plan,released:true,counts};
  await tx.execute(sql`update bulk_job set plan=${JSON.stringify(next)}::jsonb,updated_at=now() where id=${job.id}::uuid`);
 });
 unit.metric('releaseTxMs',performance.now()-started);
}

/** Post-commit best effort, exactly as the synchronous import: never reported as a rolled-back import. */
async function followUps(ctx:SessionContext,job:BulkJobRow,plan:EmployeeImportStoredPlan):Promise<EmployeeImportResultSummary>{
 const counts=plan.counts??{imported:0,dependents:0,qualification:0,emergency:0};
 const warnings:string[]=[];
 const families=await withTenant(ctx,tx=>tx.execute<{person_id:string}>(sql`select distinct result->>'personId' as person_id from bulk_job_step where job_id=${job.id}::uuid and kind='employee' and state='applied' and coalesce((result->>'family')::int,0)>0 and result->>'personId' is not null`));
 for(const {person_id} of families){try{const r=await syncChildReliefFromFamily(ctx,person_id);if(r.skipped==='error')warnings.push('Family records were saved; review the tax child-relief refresh on the Personnel record.');}catch{warnings.push('Family records were saved; review the tax child-relief refresh on the Personnel record.');}}
 const upload=inputOf(job)?.upload;
 const runId=await recordImportRun(ctx,{companyId:plan.companyId,fileName:upload?.fileName||job.source_name,totalRows:Number(job.counters?.total??0),imported:counts.imported,rejected:plan.rejected??[],failed:[]}).catch(()=>null);
 const summary:EmployeeImportResultSummary={companyId:plan.companyId,imported:counts.imported,failed:[],skipped:plan.skipped??0,dependentsImported:counts.dependents,
  registersImported:{qualification:counts.qualification,emergency:counts.emergency},superiorFailed:[],fileErrors:[],warnings:[...new Set(warnings)],runId,attemptId:job.attempt_id};
 // The job no longer needs its inputs or per-step state; Import History keeps the source.
 await withTenant(ctx,async tx=>{await tx.execute(sql`delete from bulk_job_step where job_id=${job.id}::uuid`);await tx.execute(sql`update bulk_job set input=null,source_content=null where id=${job.id}::uuid`);}).catch(()=>undefined);
 return summary;
}
export type {BulkJobStep};
