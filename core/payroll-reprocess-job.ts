/** Selective per-employee reprocessing (feedback 9bc442bc) on the payroll processing job's kernel
 * (core/bulk-job-worker.ts; draft migration 5056). The request used to validate, enqueue the payroll_reprocess_job
 * row AND run every selected employee inside the web request, one short transaction each. The request now only
 * validates and enqueues (the same `enqueueSelectiveReprocess`), and admits a `payroll_reprocess` job that runs the
 * same per-employee transaction (`reprocessEmployeeTx`) as one step per chunk, claims the reprocess job with its own
 * worker token, completes it under that token, and records a stop exactly as the request path did (`failed`, the
 * run-level stop code and the employee it stopped at). Employees already committed stay committed, as before; the
 * screen follows the payroll_reprocess_job row it already polled (/api/payroll/reprocess-job/<id>).
 *
 * Hardened kernel (5013, 5014): describeFailure is read only, so it hands the stop (code and employee) to the kernel
 * as a plan merge, and the settle writes the reprocess job's stop record from it in one owner transaction
 * (unit.ownerTx). The admission input is the kind's declared shape (5056); finalize runs as the application role.
 */

import {withTenant,type SessionContext} from '../db/client';
import {enqueueBulkJobTx,type BulkJobRow} from './bulk-job';
import {BulkJobWaiting,isTransientBulkJobError,type BulkJobHandler} from './bulk-job-worker';
import {publicErrorMessage} from '../lib/public-error';
import {
 claimSelectiveReprocess,completeSelectiveReprocess,enqueueSelectiveReprocess,reprocessEmployeeTx,reprocessRunErrorCode,payrollReprocessJobRowTx,
 type SelectiveReprocessRun,
} from './payroll';
import {PAYROLL_REPROCESS_JOB_KIND} from '../lib/payroll-processing-job';

export {PAYROLL_REPROCESS_JOB_KIND};
type JobInput={reprocessJobId:string;batchId:string;employmentIds:string[];reason?:string};
type Stopped={current:{employmentId:string;name:string;employeeCode:string|null}|null};
/** `stopped`: what a failure recorded for the settle (the run-level stop code and the employee it stopped at). A
 * failure before the plan exists leaves a plan that holds only this key. */
type JobPlan=JobInput&{completed?:Record<string,unknown>;stopped?:{code:string;employee:Stopped['current']}};
type Step={employmentId:string};
const inputOf=(job:BulkJobRow)=>job.input as JobInput|null;
const planOf=(job:BulkJobRow)=>job.plan as JobPlan|null;
/** The employee a failing step stopped at, kept for the failure record (process-local, per job). */
const stoppedOf=new Map<string,Stopped>();
const runOf=(job:BulkJobRow):SelectiveReprocessRun=>{const p=planOf(job)!;return{jobId:p.reprocessJobId,batchId:p.batchId,employmentIds:p.employmentIds,reason:p.reason,workerToken:job.id};};

/** Web side: the same validation, permission and idempotent enqueue as before, then the background job. A job that
 * already completed returns its stored result; one another worker is running is reported as running. */
export async function requestSelectiveReprocess(ctx:SessionContext,p:{batchId:string;employmentIds:string[];reason?:string;idempotencyKey?:string})
 :Promise<{jobId:string;status:'queued'|'running'|'completed'}&Record<string,unknown>>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 const enq=await enqueueSelectiveReprocess(ctx,p);
 const job=enq.job;
 if(job.status==='completed')return{jobId:job.id,status:'completed',...(job.result as Record<string,unknown>|null)};
 const abandonedBefore=Date.now()-10*60*1000;
 if(job.status==='running'&&new Date(job.updatedAt).getTime()>=abandonedBefore)return{jobId:job.id,status:'running'};
 const input={reprocessJobId:job.id,batchId:job.batchId,employmentIds:enq.employmentIds,reason:job.reason??undefined} satisfies JobInput;
 await withTenant(ctx,async tx=>{
  // A repeated submit returns the job it started; after that job stopped, a new submit runs again, as before.
  const {row}=await enqueueBulkJobTx(tx,ctx,{kind:PAYROLL_REPROCESS_JOB_KIND,operationKey:job.id,input});
  if(row.state==='failed'||row.state==='cancelled'||row.state==='completed')await enqueueBulkJobTx(tx,ctx,{kind:PAYROLL_REPROCESS_JOB_KIND,input});
 });
 return{jobId:job.id,status:'queued'};
}

export const payrollReprocessJobHandler:BulkJobHandler<Step>={
 kind:PAYROLL_REPROCESS_JOB_KIND,
 mode:'atomic',
 // One employee per transaction, exactly the request path's unit: a later employee's failure never takes back one
 // that already committed.
 maxStepsPerChunk:1,
 isTransient:error=>error instanceof BulkJobWaiting||isTransientBulkJobError(error),
 async prepare(ctx,job){
  const input=inputOf(job)!;
  const row=await withTenant(ctx,tx=>payrollReprocessJobRowTx(tx,input.reprocessJobId));
  if(!row)return{refused:'This reprocess is no longer available.',plan:input};
  if(row.status==='completed')return{steps:[],plan:{...input,completed:row.result as Record<string,unknown>}};
  const token=(row.result as {workerToken?:string}|null)?.workerToken;
  // Claimed by this job already (a restart) or claimable now; otherwise another worker holds it: wait.
  if(!(row.status==='running'&&token===job.id)&&!await claimSelectiveReprocess(ctx,input.reprocessJobId,job.id))throw new BulkJobWaiting();
  const done=new Set(((row.result as {outcomes?:{employmentId:string}[]}|null)?.outcomes??[]).map(o=>o.employmentId));
  return{steps:input.employmentIds.filter(id=>!done.has(id)).map(employmentId=>({kind:'employee',payload:{employmentId} satisfies Step})),plan:input,counters:{employees:input.employmentIds.length}};
 },
 async applyStepTx(tx,ctx,job,step){
  const stopped:Stopped={current:null};stoppedOf.set(job.id,stopped);
  await reprocessEmployeeTx(tx,ctx,runOf(job),step.payload.employmentId,stopped);
  stoppedOf.delete(job.id);
  return{counters:{done:1}};
 },
 async finalize(ctx,job){
  const plan=planOf(job)!;
  if(plan.completed)return{result:plan.completed};
  return{result:await completeSelectiveReprocess(ctx,plan.reprocessJobId,job.id)};
 },
 // Nothing to undo: every committed employee stays, exactly as when the request path stopped.
 onFailure:()=>'fail',
 // The request path's stop record: status failed, the run-level stop code and the employee it stopped at. Read only
 // here: the kernel merges the stop into the plan with the failure, and the settle below writes the record from it.
 async describeFailure(job,error){
  const stopped=stoppedOf.get(job.id)?.current??null;stoppedOf.delete(job.id);
  return{error:publicErrorMessage(error),planMerge:{stopped:{code:reprocessRunErrorCode(error),employee:stopped}} satisfies Pick<JobPlan,'stopped'>};
 },
 // The reprocess job's stop record, in one owner transaction attributed to this job (unit.ownerTx): the failure's
 // own code and employee, or, for a job stopped at its creator's request (or one that failed before its failure was
 // described), what the request path left on a stopped one. Idempotent: only a row still running under this job's
 // token changes, and the kernel retries a settle that fails.
 async settle(_ctx,job,unit){
  if(job.state==='completed')return;
  const plan=planOf(job);
  const reprocessJobId=plan?.reprocessJobId??inputOf(job)?.reprocessJobId;if(!reprocessJobId)return;
  const stop=plan?.stopped;
  await unit.ownerTx(async owner=>{
   await owner`update payroll_reprocess_job set status='failed',error=${stop?.code??'REPROCESS_STOPPED'},updated_at=now(),
     result=coalesce(result,'{"outcomes":[]}'::jsonb)||jsonb_build_object('stoppedEmployee',${JSON.stringify(stop?.employee??null)}::jsonb)
    where id=${reprocessJobId}::uuid and status='running' and result->>'workerToken'=${job.id}`;
  });
 },
};

