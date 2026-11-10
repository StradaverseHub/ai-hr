/** Payroll processing (draft -> processed) as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; draft
 * migrations 9950/9951; owner decision 2026-11-10: a `processing` run status, visible to payroll operators and hidden
 * from employees, with a run-level durable lease).
 *
 * The web action checks the run and its authority, admits the job and moves the run draft -> processing in one short
 * transaction (`requestPayrollProcessing`). From then on payroll_batch.processing_job_id is the run's lease: every
 * lifecycle owner already refuses a run that is not in the status it needs, so nothing needs the run's company/month
 * key held for the whole run any more. The worker then runs the full generation's own compute path
 * (core/payroll.ts generatePayslipsTx, `runPayrollProcessingUnitTx`) in short transactions, each under the same keys
 * a synchronous generation takes, so an input writer waits at most one chunk instead of the whole run:
 *
 *   prepare   the whole-run readiness gate and the run's planned employments, read with no key held;
 *   begin     the opening gates and the whole-run attach-on-generate;
 *   employees steps of PAYROLL_PROCESS_STEP_EMPLOYEES payslips, applied in chunk transactions of about
 *             PAYROLL_PROCESS_CHUNK_BUDGET_MS, each employee's figures exactly as the full run;
 *   finalize  the remaining overtime-prefill candidates, segment coverage and the full generation's tail (status,
 *             totals summed in the run's order, ledgers, claims, events, audit capture) in one transaction.
 *
 * A change to an employee's salary, statutory profile, fixed items or policy while the run is processing is either
 * read by that employee's chunk (it has not run yet) or marks the run for recalculation (it has), through the
 * existing needs_recalc_at owner. A failure or cancellation discards: payslips deleted, the prefilled overtime inputs
 * put back, the attached one-off rows detached, the run back in draft, and one `payroll-batch.processing-discarded`
 * event records it.
 */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {payrollBatch} from '../db/schema';
import {bulkJobId,bulkJobProgress,bulkJobWorkerStatusTx,enqueueBulkJobTx,type BulkJobRow} from './bulk-job';
import {isTransientBulkJobError,type BulkJobHandler,type BulkJobPrepared,type BulkJobRefused,type BulkJobStep,type BulkJobStepInput,type BulkJobUnit} from './bulk-job-worker';
import {publicErrorMessage} from '../lib/public-error';
import {lockPayComponentCatalogReadTx} from './pay-component-catalog-lock';
import {lockNativePayrollBatchPeriodTx} from './payroll-period-lock';
import {
 BatchNotDraftError,capturePayrollProcessingInputsTx,clearBatchRecalc,completePayrollProcessingTx,runPayrollProcessingUnitTx,
 type PayrollProcessingChunkResult,type PayrollProcessingInputSnapshot,type PayrollProcessingPlan,
} from './payroll';
import {PAYROLL_PROCESS_JOB_KIND,type PayrollProcessingStatus} from '../lib/payroll-processing-job';

export {PAYROLL_PROCESS_JOB_KIND};
/** Employees per step. A step is one pass of the full generation's compute path (its run-wide reads once, then each
 * employee's own). A chunk transaction applies steps until PAYROLL_PROCESS_CHUNK_BUDGET_MS of work and commits, so
 * its hold is at most the budget plus one step, on a quiet host or a loaded one (the populated rehearsal,
 * scripts/performance/payroll-processing-rehearsal.ts, sized both under the 1 s bar). */
export const payrollProcessStepEmployees=()=>Math.max(1,Number(process.env.PAYROLL_PROCESS_STEP_EMPLOYEES??2));
const payrollProcessChunkBudgetMs=()=>Math.max(1,Number(process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS??100));
/** Payslips deleted per discard transaction. */
const DISCARD_BATCH=500;

type JobInput={batchId:string};
type JobPlan=PayrollProcessingPlan&{batchId:string;finalized?:{payslips:number;totalNet:number;skipped:number};captured?:boolean};
type EmployeesStep={employmentIds:string[]};
const inputOf=(job:BulkJobRow)=>job.input as JobInput;
const planOf=(job:BulkJobRow)=>job.plan as JobPlan|null;

export class PayrollProcessingNotAllowedError extends Error{constructor(){super('You do not have authority to process this payroll run.');this.name='PayrollProcessingNotAllowedError';}}
/** An earlier-started run of the same company is still processing (a later month reads the earlier month's payslips).
 * Transient: the job waits its turn, retrying with the kernel's backoff. */
export class PayrollRunQueuedError extends Error{constructor(){super('Another payroll run of this company is still being processed.');this.name='PayrollRunQueuedError';}}

async function assertRunAuthorityTx(tx:Tx,companyId:string){
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.principal_snapshot_current() and app.can_admin_payroll_for(${companyId}::uuid) as allowed`);
 if(row?.allowed!==true)throw new PayrollProcessingNotAllowedError();
}
/** The same keys a synchronous generation takes (generatePayslips): the shared Access lock and pay-catalogue key,
 * the run's company/month key and its company's payroll inputs key (exclusive), held only for this one unit. */
async function lockRunUnitTx(tx:Tx,ctx:SessionContext,batchId:string){
 await lockPayComponentCatalogReadTx(tx,ctx);
 await lockNativePayrollBatchPeriodTx(tx,ctx,batchId);
}

/** Web side: validate the run and the caller's authority, admit the job and move the run to 'processing'. Short:
 * no figure is read. A repeated request while the run processes returns the running job. */
export async function requestPayrollProcessing(ctx:SessionContext,p:{batchId:string;operationKey?:string}):Promise<{jobId:string;existing:boolean}>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 const batchId=bulkJobId(p.batchId);
 return withTenant(ctx,async tx=>{
  await lockRunUnitTx(tx,ctx,batchId);
  const [batch]=await tx.select({id:payrollBatch.id,status:payrollBatch.status,companyId:payrollBatch.companyId,processingJobId:payrollBatch.processingJobId})
   .from(payrollBatch).where(eq(payrollBatch.id,batchId)).limit(1).for('update');
  if(!batch)throw new Error('batch not found');
  await assertRunAuthorityTx(tx,batch.companyId);
  if(batch.status==='processing'&&batch.processingJobId)return{jobId:batch.processingJobId,existing:true};
  if(batch.status!=='draft')throw new BatchNotDraftError();
  const {row:job}=await enqueueBulkJobTx(tx,ctx,{kind:PAYROLL_PROCESS_JOB_KIND,operationKey:p.operationKey,companyIds:[batch.companyId],input:{batchId} satisfies JobInput});
  // The retired Attendance Formula guard fires on this transition, exactly as on draft -> processed.
  await tx.update(payrollBatch).set({status:'processing',processingJobId:job.id,processingStartedAt:new Date()}).where(eq(payrollBatch.id,batchId));
  // A full generation clears the run's recalculation mark when it finishes (a draft is never marked). Cleared here
  // instead, so a mark written while the run processes survives the flip to processed.
  await clearBatchRecalc(tx,ctx,{batchId,employmentIds:null});
  return{jobId:job.id,existing:false};
 });
}

/** The run's processing state for the run screen: its status, and the signed-in creator's own job (progress,
 * outcome). Another payroll operator sees the status only (the job row is creator-only). */
export async function payrollProcessingStatus(ctx:SessionContext,batchId:string):Promise<PayrollProcessingStatus|null>{
 return withTenant(ctx,async tx=>{
  const [batch]=await tx.select({status:payrollBatch.status,processingJobId:payrollBatch.processingJobId}).from(payrollBatch).where(eq(payrollBatch.id,bulkJobId(batchId))).limit(1);
  if(!batch)return null;
  const [job]=await tx.execute<BulkJobRow>(sql`select * from bulk_job where kind=${PAYROLL_PROCESS_JOB_KIND} and tenant_id=${ctx.tenantId}::uuid
   and created_by=${ctx.userId??null}::uuid and coalesce(plan->>'batchId',input->>'batchId')=${batchId} order by created_at desc limit 1`);
  return{status:batch.status,job:job?bulkJobProgress(job):null,worker:await bulkJobWorkerStatusTx(tx,PAYROLL_PROCESS_JOB_KIND)};
 });
}

async function batchOf(tx:Tx,batchId:string){
 const [batch]=await tx.select({id:payrollBatch.id,status:payrollBatch.status,companyId:payrollBatch.companyId,processingJobId:payrollBatch.processingJobId,processingStartedAt:payrollBatch.processingStartedAt})
  .from(payrollBatch).where(eq(payrollBatch.id,batchId)).limit(1);
 return batch;
}

export const payrollProcessJobHandler:BulkJobHandler<EmployeesStep|Record<string,never>>={
 kind:PAYROLL_PROCESS_JOB_KIND,
 mode:'atomic',
 maxStepsPerChunk:32,
 get chunkBudgetMs(){return payrollProcessChunkBudgetMs();},
 phaseOf:kind=>kind==='begin'?'begin':'employees',
 isTransient:error=>error instanceof PayrollRunQueuedError||isTransientBulkJobError(error),
 async prepare(ctx,job){
  const {batchId}=inputOf(job);
  // A refusal before any payslip is written needs no discard: the job ends failed and commitPrepareTx puts the run
  // back in draft in the same transaction. The plan keeps the run id after the kernel clears the job's input.
  try{return await prepareRun(ctx,job,batchId);}
  catch(error){
   if(error instanceof PayrollRunQueuedError||isTransientBulkJobError(error))throw error;
   return{refused:publicErrorMessage(error),plan:{batchId}};
  }
 },
 async commitPrepareTx(tx,_ctx,job,prepared){
  if(!('refused' in prepared))return;
  await tx.update(payrollBatch).set({status:'draft',processingJobId:null,processingStartedAt:null})
   .where(and(eq(payrollBatch.id,inputOf(job).batchId),eq(payrollBatch.processingJobId,job.id)));
 },
 async beginChunkTx(tx,ctx,job){await lockRunUnitTx(tx,ctx,inputOf(job).batchId);},
 async applyStepTx(tx,ctx,job,step){
  return applyRunStepTx(tx,ctx,job,step);
 },
 async finalize(ctx,job,unit){
  return finalizeRun(ctx,job,unit);
 },
 async discard(job,unit){
  return discardRun(job,unit);
 },
};

async function prepareRun(ctx:SessionContext,job:BulkJobRow,batchId:string):Promise<BulkJobPrepared|BulkJobRefused>{
  return withTenant(ctx,async tx=>{
   const batch=await batchOf(tx,batchId);
   if(!batch||batch.status!=='processing'||batch.processingJobId!==job.id)return{refused:'This payroll run is no longer waiting to be processed.'};
   await assertRunAuthorityTx(tx,batch.companyId);
   const [earlier]=await tx.execute<{id:string}>(sql`select id from payroll_batch where tenant_id=${ctx.tenantId}::uuid and company_id=${batch.companyId}::uuid
    and processing_job_id is not null and id<>${batchId}::uuid and (processing_started_at,id)<(${batch.processingStartedAt?.toISOString()??null}::timestamptz,${batchId}::uuid) limit 1`);
   if(earlier)throw new PayrollRunQueuedError();
   const unit=await runPayrollProcessingUnitTx(tx,ctx,batchId,{jobId:job.id,phase:'plan',employmentIds:[],order:{},prefillOvertime:false});
   if(!('processingPlan' in unit)||!unit.processingPlan)throw new Error('Payroll processing plan unavailable.');
   const plan=unit.processingPlan;
   const steps:BulkJobStepInput[]=[{kind:'begin',payload:{}}];
   const size=payrollProcessStepEmployees();
   for(let i=0;i<plan.employmentIds.length;i+=size)
    steps.push({kind:'employees',payload:{employmentIds:plan.employmentIds.slice(i,i+size)} satisfies EmployeesStep});
   return{steps,plan:{...plan,batchId} satisfies JobPlan,counters:{employees:plan.employmentIds.length},companyIds:[batch.companyId],phase:'begin'};
  });
}

async function applyRunStepTx(tx:Tx,ctx:SessionContext,job:BulkJobRow,step:BulkJobStep<EmployeesStep|Record<string,never>>){
  const {batchId}=inputOf(job);const plan=planOf(job);
  if(!plan)throw new Error('Payroll processing plan unavailable.');
  if(step.kind==='begin'){
   const unit=await runPayrollProcessingUnitTx(tx,ctx,batchId,{jobId:job.id,phase:'begin',employmentIds:[],order:{},prefillOvertime:plan.prefillOvertime});
   if(!('processingBegin' in unit)||!unit.processingBegin)throw new Error('Payroll processing begin unavailable.');
   return{result:unit.processingBegin};
  }
  const ids=(step.payload as EmployeesStep).employmentIds;
  const unit=await runPayrollProcessingUnitTx(tx,ctx,batchId,{jobId:job.id,phase:'employees',employmentIds:ids,order:Object.fromEntries(ids.map((id,i)=>[id,i])),prefillOvertime:plan.prefillOvertime});
  if(!('processingChunk' in unit)||!unit.processingChunk)throw new Error('Payroll processing chunk unavailable.');
  return{result:unit.processingChunk,counters:{paid:unit.processingChunk.paid.length,skipped:unit.processingChunk.skipped.length}};
}

/** Finalize in two bounded units. First the flip, under the run's keys: status, totals, ledgers, claims and events,
 * exactly the full generation's tail. Then, with no run key held, the audit loop's input capture, which reads every
 * owner row of the run and grows with it. Each unit records itself on the job plan in its own transaction, so a
 * unit that committed is never repeated after a worker restart. */
async function finalizeRun(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit):Promise<'more'|{result:unknown}>{
  const plan=planOf(job);const {batchId}=inputOf(job);
  if(!plan)throw new Error('Payroll processing plan unavailable.');
  const label=(tx:Tx,phase:string)=>tx.execute(sql`select set_config('application_name',${`aihr-bulk:${PAYROLL_PROCESS_JOB_KIND}:${phase}`},true)`);
  if(!plan.finalized){
   const started=performance.now();
   await withTenant(ctx,async tx=>{
    await label(tx,'finalize');
    await unit.fenceTx(tx);
    await lockRunUnitTx(tx,ctx,batchId);
    const batch=await batchOf(tx,batchId);
    if(batch)await assertRunAuthorityTx(tx,batch.companyId);
    const rows=await tx.execute<{result:PayrollProcessingChunkResult}>(sql`select result from bulk_job_step where job_id=${job.id}::uuid and kind='employees' and state='applied' order by seq`);
    const done=await completePayrollProcessingTx(tx,ctx,{batchId,jobId:job.id,plannedEmploymentIds:plan.employmentIds,prefillOvertime:plan.prefillOvertime,chunks:rows.map(r=>r.result)});
    const finalized={payslips:done.payslips,totalNet:done.totalNet,skipped:done.skipped.length};
    await tx.execute(sql`update bulk_job set plan=plan||${JSON.stringify({finalized})}::jsonb,updated_at=now() where id=${job.id}::uuid`);
   });
   unit.metric('finalizeTxMs',performance.now()-started);
   return 'more';
  }
  if(!plan.captured){
   const started=performance.now();
   await withTenant(ctx,async tx=>{
    await label(tx,'capture');
    await unit.fenceTx(tx);
    await capturePayrollProcessingInputsTx(tx,ctx,batchId);
    await tx.execute(sql`update bulk_job set plan=plan||'{"captured":true}'::jsonb,updated_at=now() where id=${job.id}::uuid`);
   });
   unit.metric('captureTxMs',performance.now()-started);
  }
  return{result:{batchId,...plan.finalized}};
}

/** Owner-only: undo what the job wrote in bounded batches, then return the run to draft and record it. */
async function discardRun(job:BulkJobRow,unit:Omit<BulkJobUnit,'fenceTx'>):Promise<'more'|'done'>{
  const {batchId}=inputOf(job);
  const started=performance.now();
  // The reserved queue-owner connection has no begin(): one explicit transaction on it.
  const owner=unit.owner;
  const inTransaction=async<T,>(work:()=>Promise<T>)=>{await owner`begin`;try{const out=await work();await owner`commit`;return out;}catch(error){await owner`rollback`;throw error;}};
  const outcome=await inTransaction(async()=>{
   const [batch]=await owner<{status:string;processing_job_id:string|null;tenant_id:string;needs_recalc_at:Date|null}[]>`select status,processing_job_id,tenant_id,needs_recalc_at from payroll_batch where id=${batchId}::uuid for update`;
   // Nothing of this job's is left on the run (it finalized, or never owned it).
   if(!batch||batch.status!=='processing'||batch.processing_job_id!==job.id)return'done' as const;
   const deleted=await owner`delete from payslip where id in (select id from payslip where batch_id=${batchId}::uuid limit ${DISCARD_BATCH})`;
   if(deleted.count===DISCARD_BATCH)return'more' as const;
   // The overtime prefill's rewrites, put back as they were before each chunk (one chunk per employee).
   const snapshots=await owner<{snapshots:PayrollProcessingInputSnapshot[]|null}[]>`select result->'inputSnapshots' as snapshots from bulk_job_step where job_id=${job.id}::uuid and kind='employees' and state='applied'`;
   let restored=0;
   for(const snapshot of snapshots.flatMap(r=>r.snapshots??[])){
    if(snapshot.row===null)await owner`delete from payroll_input where batch_id=${batchId}::uuid and employment_id=${snapshot.employmentId}::uuid`;
    else await owner`update payroll_input t set (overtime_amount,ot_breakdown,ot_derivation,ot_source,updated_at)=(select r.overtime_amount,r.ot_breakdown,r.ot_derivation,r.ot_source,r.updated_at
      from jsonb_populate_record(null::payroll_input,${JSON.stringify(snapshot.row)}::jsonb) r) where t.id=${String(snapshot.row.id)}::uuid and t.batch_id=${batchId}::uuid`;
    restored++;
   }
   // The one-off rows the begin unit stamped onto this run return to being period-keyed.
   const [begin]=await owner<{ids:string[]|null}[]>`select array(select jsonb_array_elements_text(result->'attachedTxnIds')) as ids from bulk_job_step where job_id=${job.id}::uuid and kind='begin' and state='applied'`;
   const attached=begin?.ids??[];
   const detached=attached.length?await owner<{id:string;employment_id:string;pay_period:string}[]>`update payroll_individual_txn set batch_id=null where batch_id=${batchId}::uuid and id=any(${attached}::uuid[]) returning id,employment_id,pay_period`:[];
   // The same record a draft teardown leaves for each one (core/payroll.ts teardownDraftChildren).
   for(const t of detached)await owner`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
     values(${batch.tenant_id}::uuid,'payroll-individual-txn',${t.id}::uuid,'payroll.individual-txn.detached','system',null,${t.employment_id}::uuid,
      ${JSON.stringify({batchId,payPeriod:t.pay_period,reason:'payroll-processing-discarded'})}::jsonb)`;
   // A draft is never marked: a mark written while the run processed went with the payslips it was about.
   await owner`update payroll_batch set status='draft',processing_job_id=null,processing_started_at=null,needs_recalc_at=null,recalc_employment_ids=null where id=${batchId}::uuid`;
   if(batch.needs_recalc_at)await owner`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
     values(${batch.tenant_id}::uuid,'payroll-batch',${batchId}::uuid,'payroll-batch.recalc-cleared','system',null,${JSON.stringify({processingJobId:job.id})}::jsonb)`;
   await owner`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
     values(${batch.tenant_id}::uuid,'payroll-batch',${batchId}::uuid,'payroll-batch.processing-discarded','system',null,
      ${JSON.stringify({jobId:job.id,initiatedBy:job.created_by,outcome:job.outcome??'failed',reason:(job.error??'').slice(0,500),inputsRestored:restored,oneOffTransactionsDetached:detached.length})}::jsonb)`;
   return'done' as const;
  });
  unit.metric('discardTxMs',performance.now()-started);
  return outcome;
}
