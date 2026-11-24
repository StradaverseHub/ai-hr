/** Payroll processing (draft -> processed) as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; draft
 * migrations 5050/5051; owner decision 2026-11-10: a `processing` run status, visible to payroll operators and hidden
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
 * Set-based groups (ADR 0181 J2). Steps stay PAYROLL_PROCESS_STEP_EMPLOYEES employees each, but one `employees` step
 * computes a group: itself and the chunk's following steps, up to an adaptive number of employees
 * (PAYROLL_PROCESS_GROUP_MAX, sized from the measured fixed cost of a pass like the selective reprocess), through ONE
 * pass of the same compute path, so the run-wide reads and checks are paid once per group instead of once per four
 * employees. The step marks the steps it covered applied in the same transaction (kernel outcome `consumed`). A group
 * pass that refuses is rolled back to its savepoint and its steps then run one per pass exactly as before, so a refusal
 * and its message are the per-step path's. Each chunk records its calculation (process CPU) and database (the rest of
 * its wall time) split on the job's metrics and an `[aihr-timing]` line.
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
import {isTransientBulkJobError,type BulkJobDiscardUnit,type BulkJobHandler,type BulkJobPrepared,type BulkJobRefused,type BulkJobStep,type BulkJobStepInput,type BulkJobStepOutcome,type BulkJobUnit} from './bulk-job-worker';
import {nextGroupSize,rememberGroupPass,splitChunkTime,type GroupPass} from './bulk-job-group-size';
import {publicErrorMessage} from '../lib/public-error';
import {PayrollTaxBasisError} from '../lib/payroll-tax-basis';
import {lockPayComponentCatalogReadTx} from './pay-component-catalog-lock';
import {lockNativePayrollBatchPeriodTx} from './payroll-period-lock';
import {
 BatchNotDraftError,capturePayrollProcessingInputsTx,clearBatchRecalc,completePayrollProcessingTx,runPayrollProcessingUnitTx,
 type PayrollProcessingChunkResult,type PayrollProcessingInputSnapshot,type PayrollProcessingPlan,
} from './payroll';
import {PAYROLL_PROCESS_JOB_KIND,type PayrollProcessingStatus} from '../lib/payroll-processing-job';
import {reasonForPayrollError,transactionFailureForPayrollError} from './payroll-run-group-result';
import {settleRunGroupsForJobTx} from './payroll-run-group-store';

export {PAYROLL_PROCESS_JOB_KIND};
/** Employees per step. A step is one pass of the full generation's compute path (its run-wide reads once, then each
 * employee's own). A chunk transaction applies steps until PAYROLL_PROCESS_CHUNK_BUDGET_MS of work and commits, so
 * its hold is at most the budget plus one step, on a quiet host or a loaded one (the populated rehearsal,
 * scripts/performance/payroll-processing-rehearsal.ts, sized both under the 1 s bar). */
export const payrollProcessStepEmployees=()=>Math.max(1,Number(process.env.PAYROLL_PROCESS_STEP_EMPLOYEES??4));
const payrollProcessChunkBudgetMs=()=>Math.max(1,Number(process.env.PAYROLL_PROCESS_CHUNK_BUDGET_MS??100));
/** Employees per engine pass, at most (1: one step per pass, the steps-of-four path as before). */
export const payrollProcessGroupMax=()=>Math.max(1,Math.floor(Number(process.env.PAYROLL_PROCESS_GROUP_MAX??200))||1);
/** The chunk length a group aims for, at least. A chunk holds the run's company/month key and its company's payroll
 * inputs key exclusively, so this bounds how long a salary or statutory change for that company may wait behind it. */
export const payrollProcessChunkTargetMs=()=>Math.max(1,Number(process.env.PAYROLL_PROCESS_CHUNK_TARGET_MS??500)||500);
/** A group may last this many times one pass's measured fixed cost (see core/bulk-job-group-size.ts). */
export const payrollProcessFixedMultiple=()=>Math.max(1,Number(process.env.PAYROLL_PROCESS_CHUNK_FIXED_MULTIPLE??2)||2);
const FIRST_GROUP=16;
/** Per job and process: the next group size, the passes it was estimated from, and the last step of a refused group
 * (its steps run one per pass, as before). */
type GroupState={size:number;seen:GroupPass[];singleThrough:number};
const groupStateOf=new Map<string,GroupState>();
const groupStateFor=(jobId:string)=>{let state=groupStateOf.get(jobId);if(!state){state={size:Math.max(FIRST_GROUP,2*payrollProcessStepEmployees()),seen:[],singleThrough:-1};groupStateOf.set(jobId,state);}return state;};
const roundMs=(value:number)=>Math.max(0,Math.round(value));
/** One line per engine pass on the worker's stdout, beside the web's request timing (lib/request-timing.ts, same
 * prefix and privacy rule: closed labels and numbers only, never a tenant, person, company or value). */
function logPass(mode:'group'|'single',employees:number,steps:number,time:{wallMs:number;calcMs:number;dbMs:number}){
 if(process.env.AIHR_TIMING==='off')return;
 console.info('[aihr-timing] '+JSON.stringify({t:'bulk-chunk',kind:PAYROLL_PROCESS_JOB_KIND,mode,employees,steps,wallMs:roundMs(time.wallMs),calcMs:roundMs(time.calcMs),dbMs:roundMs(time.dbMs)}));
}
/** Payslips deleted per discard transaction. */
const DISCARD_BATCH=500;

/** `after`: the processing jobs of the same wizard run admitted before this one. The synchronous wizard generated
 * its companies one after another, so this run waits for theirs (a cross-company transfer's coverage marks read
 * the earlier company's run as processed, exactly as before). */
type JobInput={batchId:string;after?:string[]};
type JobPlan=PayrollProcessingPlan&{batchId:string;finalized?:{payslips:number;totalNet:number;skipped:number;taxHeld?:number};captured?:boolean;
 /** A failed run's reason code (core/payroll-run-group-result.ts), for the wizard's result screen. */
 failureReason?:string};
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

/** A processing unit reads its employments one chunk at a time, under the initiator's own authority. The
 * transaction-local marker (migration 0691, first used by the bank import worker) lets an employment read skip
 * rebuilding the whole visible-employment array for every statement when the initiator administers the company or
 * its payroll (5054 added the payroll partner): `app.can_admin_payroll_for` is already an arm of the original
 * predicate, so the rows read are the same and no authority is added. Anyone else takes the original predicate. */
async function pointReadTx(tx:Tx){await tx.execute(sql`select set_config('app.bank_import_point_read','on',true)`);}

/** Web side: validate the run and the caller's authority, admit the job and move the run to 'processing'. Short:
 * no figure is read. A repeated request while the run processes returns the running job. */
export async function requestPayrollProcessing(ctx:SessionContext,p:{batchId:string;operationKey?:string;after?:readonly string[]}):Promise<{jobId:string;existing:boolean}>{
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
  const {row:job}=await enqueueBulkJobTx(tx,ctx,{kind:PAYROLL_PROCESS_JOB_KIND,operationKey:p.operationKey,companyIds:[batch.companyId],input:{batchId,...(p.after?.length?{after:p.after.map(bulkJobId)}:{})} satisfies JobInput});
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
 // A group's steps must all be loaded in its chunk (plus the begin step).
 get maxStepsPerChunk(){return Math.max(32,Math.ceil(payrollProcessGroupMax()/payrollProcessStepEmployees())+1);},
 get chunkBudgetMs(){return payrollProcessChunkBudgetMs();},
 phaseOf:kind=>kind==='begin'?'begin':'employees',
 isTransient:error=>isTransientRunError(error),
 async prepare(ctx,job){
  const {batchId}=inputOf(job);
  // A refusal before any payslip is written needs no discard: the job ends failed and commitPrepareTx puts the run
  // back in draft in the same transaction. The plan keeps the run id after the kernel clears the job's input.
  try{return await prepareRun(ctx,job,batchId);}
  catch(error){
   if(error instanceof PayrollRunQueuedError||isTransientBulkJobError(error))throw error;
   // The wizard's result screen names the reason exactly as the synchronous run's catch mapped this error.
   return{refused:publicErrorMessage(error),plan:{batchId,failureReason:reasonForPayrollError(error),transactionFailure:transactionFailureForPayrollError(error)}};
  }
 },
 async commitPrepareTx(tx,_ctx,job,prepared){
  if(!('refused' in prepared))return;
  await tx.update(payrollBatch).set({status:'draft',processingJobId:null,processingStartedAt:null})
   .where(and(eq(payrollBatch.id,inputOf(job).batchId),eq(payrollBatch.processingJobId,job.id)));
 },
 async beginChunkTx(tx,ctx,job){await lockRunUnitTx(tx,ctx,inputOf(job).batchId);await pointReadTx(tx);},
 async applyStepTx(tx,ctx,job,step,_cache,following){
  return applyRunStepTx(tx,ctx,job,step,following??[]);
 },
 async finalize(ctx,job,unit){
  return finalizeRun(ctx,job,unit);
 },
 async discard(job,unit){
  groupStateOf.delete(job.id);
  return discardRun(job,unit);
 },
 // The reason the synchronous wizard's catch gave this error, kept on the plan for the run group's outcome. The
 // kernel merges it into the plan with the failure (describeFailure itself is read only).
 async describeFailure(job,error){
  groupStateOf.delete(job.id);
  return{error:publicErrorMessage(error),planMerge:{failureReason:reasonForPayrollError(error),transactionFailure:transactionFailureForPayrollError(error)}};
 },
 // A wizard run group waiting for this run settles when its last job finishes (core/payroll-run-group-store.ts);
 // the kernel retries a settle that fails until it succeeds. One owner transaction that the kernel opens, attributes
 // to this job and commits (unit.ownerTx), so the run group's event carries the job (payload.bulkJob, 5014).
 async settle(_ctx,job,unit){
  await unit.ownerTx(owner=>settleRunGroupsForJobTx(owner,job));
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
   const after=inputOf(job).after??[];
   if(after.length){
    const [waiting]=await tx.execute<{id:string}>(sql`select id from payroll_batch where tenant_id=${ctx.tenantId}::uuid and processing_job_id in (${sql.join(after.map(id=>sql`${id}::uuid`),sql`, `)}) limit 1`);
    if(waiting)throw new PayrollRunQueuedError();
   }
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

type RunStep=BulkJobStep<EmployeesStep|Record<string,never>>;
const isTransientRunError=(error:unknown)=>error instanceof PayrollRunQueuedError||isTransientBulkJobError(error);
async function applyRunStepTx(tx:Tx,ctx:SessionContext,job:BulkJobRow,step:RunStep,following:readonly RunStep[]):Promise<BulkJobStepOutcome>{
  const {batchId}=inputOf(job);const plan=planOf(job);
  if(!plan)throw new Error('Payroll processing plan unavailable.');
  if(step.kind==='begin'){
   const unit=await runPayrollProcessingUnitTx(tx,ctx,batchId,{jobId:job.id,phase:'begin',employmentIds:[],order:{},prefillOvertime:plan.prefillOvertime});
   if(!('processingBegin' in unit)||!unit.processingBegin)throw new Error('Payroll processing begin unavailable.');
   return{result:unit.processingBegin};
  }
  const state=groupStateFor(job.id);
  const max=payrollProcessGroupMax();
  // The group: this step and the chunk's following employees steps, while the employees fit the group size.
  const group:RunStep[]=[step];
  if(max>1&&step.seq>state.singleThrough){
   const limit=Math.min(max,state.size);let employees=idsOf(step).length;
   for(const next of following){
    if(next.kind!=='employees'||employees+idsOf(next).length>limit)break;
    group.push(next);employees+=idsOf(next).length;
   }
  }
  if(group.length>1){
   const started=performance.now(),cpuStarted=process.cpuUsage();
   try{
    const chunk=await runEmployeesPassTx(tx,ctx,job,batchId,plan,group.flatMap(idsOf));
    const time=splitChunkTime(started,cpuStarted),n=group.reduce((sum,s)=>sum+idsOf(s).length,0);
    logPass('group',n,group.length,time);
    measure(state,max,n,time.wallMs);
    return{...chunkOutcome(chunk),consumed:group.length-1,metrics:{
     add:{processGroups:1,processGroupEmployees:n,processCalcMs:roundMs(time.calcMs),processDbMs:roundMs(time.dbMs)},
     max:{processGroupMaxEmployees:n,processGroupMaxMs:roundMs(time.wallMs),processGroupMaxCalcMs:roundMs(time.calcMs),processGroupMaxDbMs:roundMs(time.dbMs)},
    }};
   }catch(error){
    if(isTransientRunError(error))throw error;
    // The group's savepoint rolled back every write of the pass. Its steps run one per pass, exactly as before, so a
    // refusal (and the employees it names) is the per-step path's; grouping resumes after them.
    state.singleThrough=group[group.length-1].seq;
   }
  }
  const started=performance.now(),cpuStarted=process.cpuUsage();
  const chunk=await runEmployeesPassTx(tx,ctx,job,batchId,plan,idsOf(step));
  const time=splitChunkTime(started,cpuStarted);
  logPass('single',idsOf(step).length,1,time);
  // A one-step pass is a point on the same line, so a group size estimated below two steps can grow again.
  if(max>1)measure(state,max,idsOf(step).length,time.wallMs);
  return{...chunkOutcome(chunk),metrics:{
   add:{processSingles:1,processSingleEmployees:idsOf(step).length,processCalcMs:roundMs(time.calcMs),processDbMs:roundMs(time.dbMs)},max:{processSingleMaxMs:roundMs(time.wallMs)},
  }};
}
const idsOf=(step:RunStep)=>(step.payload as EmployeesStep).employmentIds;
function measure(state:GroupState,max:number,employees:number,wallMs:number){
  state.seen=rememberGroupPass(state.seen,{employees,wallMs});
  state.size=nextGroupSize(state.seen,employees,{max,targetMs:payrollProcessChunkTargetMs(),fixedMultiple:payrollProcessFixedMultiple()});
}
function chunkOutcome(chunk:PayrollProcessingChunkResult){
  return{result:chunk,counters:{paid:chunk.paid.length,skipped:chunk.skipped.length,...(chunk.taxHeld?.length?{taxHeld:chunk.taxHeld.length}:{})}};
}
/** One pass of the full generation's compute path over `ids` (in the run's planned order), in its own savepoint. */
async function runEmployeesPassTx(tx:Tx,ctx:SessionContext,job:BulkJobRow,batchId:string,plan:JobPlan,ids:readonly string[]){
  const run=(unitTx:Tx)=>runPayrollProcessingUnitTx(unitTx,ctx,batchId,{jobId:job.id,phase:'employees',employmentIds:[...ids],order:Object.fromEntries(ids.map((id,i)=>[id,i])),prefillOvertime:plan.prefillOvertime});
  // 016276b7 — the chunk holds the employees whose tax history it cannot read before it calculates anything. A tax
  // correction committed between that check and the chunk's own history read can still make the read refuse: the
  // chunk is then rolled back to its savepoint and run once more, so its check sees the change and holds exactly that
  // employee. A second refusal (including the refusals that are never a hold) fails the run as before.
  let unit:Awaited<ReturnType<typeof run>>;
  try{unit=await tx.transaction(run);}
  catch(error){if(!(error instanceof PayrollTaxBasisError))throw error;unit=await tx.transaction(run);}
  if(!('processingChunk' in unit)||!unit.processingChunk)throw new Error('Payroll processing chunk unavailable.');
  return unit.processingChunk;
}

/** Finalize in two bounded units. First the flip, under the run's keys: status, totals, ledgers, claims and events,
 * exactly the full generation's tail. Then, with no run key held, the audit loop's input capture, which reads every
 * owner row of the run and grows with it. Each unit records itself on the job plan in its own fenced transaction
 * (unit.set: the application role does not write the job store), so a unit that committed is never repeated after a
 * worker restart. */
async function finalizeRun(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit):Promise<'more'|{result:unknown}>{
  const plan=planOf(job);const {batchId}=inputOf(job);
  if(!plan)throw new Error('Payroll processing plan unavailable.');
  const label=(tx:Tx,phase:string)=>tx.execute(sql`select set_config('application_name',${`aihr-bulk:${PAYROLL_PROCESS_JOB_KIND}:${phase}`},true)`);
  if(!plan.finalized){
   const started=performance.now();
   await withTenant(ctx,async tx=>{
    await label(tx,'finalize');
    await unit.fenceTx(tx);
    await lockRunUnitTx(tx,ctx,batchId);await pointReadTx(tx);
    const batch=await batchOf(tx,batchId);
    if(batch)await assertRunAuthorityTx(tx,batch.companyId);
    // A step a group covered carries no result: the group's first step holds its whole chunk.
    const rows=await tx.execute<{result:PayrollProcessingChunkResult}>(sql`select result from bulk_job_step where job_id=${job.id}::uuid and kind='employees' and state='applied' and result is not null order by seq`);
    groupStateOf.delete(job.id);
    const done=await completePayrollProcessingTx(tx,ctx,{batchId,jobId:job.id,plannedEmploymentIds:plan.employmentIds,prefillOvertime:plan.prefillOvertime,chunks:rows.map(r=>r.result)});
    const finalized={payslips:done.payslips,totalNet:done.totalNet,skipped:done.skipped.length,...(done.taxHeld.length?{taxHeld:done.taxHeld.length}:{})};
    await unit.set(tx,{planMerge:{finalized}});
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
    await unit.set(tx,{planMerge:{captured:true}});
   });
   unit.metric('captureTxMs',performance.now()-started);
  }
  return{result:{batchId,...plan.finalized}};
}

/** Owner-only: undo what the job wrote in bounded batches, then return the run to draft and record it. Each unit is
 * one transaction on the queue-owner connection that the kernel opens, attributes to this job and commits
 * (unit.ownerTx), so the events written here carry the job (payload.bulkJob, migration 5014). */
async function discardRun(job:BulkJobRow,unit:BulkJobDiscardUnit):Promise<'more'|'done'>{
  const {batchId}=inputOf(job);
  const started=performance.now();
  const outcome=await unit.ownerTx(async owner=>{
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
