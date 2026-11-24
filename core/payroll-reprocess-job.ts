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
 *
 * Set-based chunks (ADR 0181 J2). Steps stay one per employee, but the first step of a chunk recalculates a group: the
 * longest run of following employees that are ordinary recalculations goes through ONE pass of the payroll engine
 * (`reprocessEmployeeGroupTx`: the run-wide reads once, the same per-employee calculation, one checkpoint and one
 * multi-row event insert), and the group's other steps then only record themselves. The group's size adapts so a
 * chunk lasts about PAYROLL_REPROCESS_CHUNK_TARGET_MS (at most PAYROLL_REPROCESS_GROUP_MAX employees; 1 restores one
 * employee per chunk). An addition, an exclusion, a refused pass and its employees take the per-employee transaction
 * (`reprocessEmployeeTx`) in a chunk of their own, exactly as before, so every outcome and stop is the request path's.
 * Each chunk records its calculation (process CPU) and database (the rest of its wall time) split on the job's metrics.
 */

import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {enqueueBulkJobTx,type BulkJobRow} from './bulk-job';
import {BulkJobWaiting,isTransientBulkJobError,type BulkJobHandler,type BulkJobStepOutcome} from './bulk-job-worker';
import {publicErrorMessage} from '../lib/public-error';
import {
 claimSelectiveReprocess,completeSelectiveReprocess,enqueueSelectiveReprocess,reprocessEmployeeGroupTx,reprocessEmployeeTx,reprocessRunErrorCode,
 payrollReprocessJobRowTx,type SelectiveReprocessRun,
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
/** Employees per engine pass, at most (1: one employee per chunk, the per-employee transaction only). */
export const payrollReprocessGroupMax=()=>Math.max(1,Math.floor(Number(process.env.PAYROLL_REPROCESS_GROUP_MAX??200))||1);
/** The chunk length the group size aims for. The chunk holds the run's company/month key and its company's payroll
 * inputs key, so this is how long a salary or statutory change for that company may wait behind it. */
export const payrollReprocessChunkTargetMs=()=>Math.max(1,Number(process.env.PAYROLL_REPROCESS_CHUNK_TARGET_MS??1000)||1000);
const FIRST_GROUP=16;
/** Per job and process: the next group size, employees whose pass was refused (per-employee from here), and the
 * employees the current chunk's group already wrote (their steps only record themselves; the last one ends the chunk). */
type GroupState={size:number;fallback:Set<string>;chunk:{done:Set<string>;last:string|null}};
const groupStateOf=new Map<string,GroupState>();
const stateOf=(jobId:string)=>{let state=groupStateOf.get(jobId);if(!state){state={size:FIRST_GROUP,fallback:new Set(),chunk:{done:new Set(),last:null}};groupStateOf.set(jobId,state);}return state;};
const isTransient=(error:unknown)=>error instanceof BulkJobWaiting||isTransientBulkJobError(error);
/** The next group: scaled toward the chunk target from the last group's wall time, at most doubling. */
function nextGroupSize(employees:number,wallMs:number){
 return Math.max(2,Math.min(payrollReprocessGroupMax(),employees*2,Math.floor(employees*payrollReprocessChunkTargetMs()/Math.max(1,wallMs))));
}
const ms=(value:number)=>Math.max(0,Math.round(value));
/** One line per chunk on the worker's stdout, beside the web's request timing (lib/request-timing.ts, same prefix and
 * privacy rule: closed labels and numbers only, never a tenant, person, company or value). */
function logChunk(mode:'group'|'single',employees:number,wallMs:number,cpuMs:number,engine?:{wallMs:number;cpuMs:number}){
 if(process.env.AIHR_TIMING==='off')return;
 console.info('[aihr-timing] '+JSON.stringify({t:'bulk-chunk',kind:PAYROLL_REPROCESS_JOB_KIND,mode,employees,wallMs:ms(wallMs),calcMs:ms(cpuMs),dbMs:ms(wallMs-cpuMs),
  ...(engine?{engineWallMs:ms(engine.wallMs),engineCalcMs:ms(engine.cpuMs)}:{})}));
}

/** Web side: the same validation, permission and idempotent enqueue as before, then the background job. A job that
 * already completed returns its stored result; one another worker is running is reported as running. */
export async function requestSelectiveReprocess(ctx:SessionContext,p:{batchId:string;employmentIds:string[];reason?:string;idempotencyKey?:string;heldEmploymentIds?:string[]})
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
 // A chunk is one group (its steps all fit) or one per-employee transaction: chunks end by `endChunk`, so the budget
 // is only a backstop below the 60 s lease.
 get maxStepsPerChunk(){return payrollReprocessGroupMax();},
 chunkBudgetMs:30_000,
 isTransient,
 // Every chunk transaction starts with no group written yet. The point-read marker (0691/9954) is the processing
 // job's: an employment read skips rebuilding the visible-employment array when the initiator administers the
 // company or its payroll, an arm of the same predicate, so the rows read are the same.
 async beginChunkTx(tx,_ctx,job){
  stateOf(job.id).chunk={done:new Set(),last:null};
  await tx.execute(sql`select set_config('app.bank_import_point_read','on',true)`);
 },
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
 async applyStepTx(tx,ctx,job,step):Promise<BulkJobStepOutcome>{
  const id=step.payload.employmentId,state=stateOf(job.id);
  // Written by this chunk's group already: only the step records itself, and the group's last step ends the chunk.
  if(state.chunk.done.has(id))return{counters:{done:1},...(id===state.chunk.last?{endChunk:true}:{})};
  const stopped:Stopped={current:null};stoppedOf.set(job.id,stopped);
  const run=runOf(job);
  if(payrollReprocessGroupMax()>1&&!state.fallback.has(id)&&!state.chunk.last){
   const at=run.employmentIds.indexOf(id);
   const candidates=at<0?[id]:run.employmentIds.slice(at,at+Math.min(payrollReprocessGroupMax(),state.size));
   const group=await reprocessEmployeeGroupTx(tx,ctx,run,candidates,{isTransient,stopped});
   if(group.kind==='done'){stoppedOf.delete(job.id);return{counters:{done:1}};}
   if(group.kind==='set'){
    const n=group.employmentIds.length,{wallMs,cpuMs}=group.timing;
    logChunk('group',n,wallMs,cpuMs,{wallMs:group.timing.engineWallMs,cpuMs:group.timing.engineCpuMs});
    state.chunk={done:new Set(group.employmentIds),last:group.employmentIds[n-1]};
    state.size=nextGroupSize(n,wallMs);
    stoppedOf.delete(job.id);
    return{counters:{done:1},metrics:{
     add:{reprocessGroups:1,reprocessGroupEmployees:n,reprocessCalcMs:ms(cpuMs),reprocessDbMs:ms(wallMs-cpuMs)},
     max:{reprocessGroupMaxEmployees:n,reprocessGroupMaxMs:ms(wallMs),reprocessGroupMaxCalcMs:ms(cpuMs),reprocessGroupMaxDbMs:ms(wallMs-cpuMs)},
    }};
   }
   // A refused pass: its employees take the per-employee transaction, one chunk each, from this one on.
   if(group.kind==='fallback')for(const employmentId of group.employmentIds)state.fallback.add(employmentId);
   stopped.current=null;
  }
  const started=performance.now(),cpuStarted=process.cpuUsage();
  await reprocessEmployeeTx(tx,ctx,run,id,stopped);
  state.fallback.delete(id);
  stoppedOf.delete(job.id);
  const cpu=process.cpuUsage(cpuStarted),wallMs=performance.now()-started,cpuMs=(cpu.user+cpu.system)/1000;
  logChunk('single',1,wallMs,cpuMs);
  return{counters:{done:1},endChunk:true,metrics:{
   add:{reprocessSingles:1,reprocessCalcMs:ms(cpuMs),reprocessDbMs:ms(wallMs-cpuMs)},max:{reprocessSingleMaxMs:ms(wallMs)},
  }};
 },
 async finalize(ctx,job){
  groupStateOf.delete(job.id);
  const plan=planOf(job)!;
  if(plan.completed)return{result:plan.completed};
  return{result:await completeSelectiveReprocess(ctx,plan.reprocessJobId,job.id)};
 },
 // Nothing to undo: every committed employee stays, exactly as when the request path stopped.
 onFailure:()=>'fail',
 // The request path's stop record: status failed, the run-level stop code and the employee it stopped at. Read only
 // here: the kernel merges the stop into the plan with the failure, and the settle below writes the record from it.
 async describeFailure(job,error){
  const stopped=stoppedOf.get(job.id)?.current??null;stoppedOf.delete(job.id);groupStateOf.delete(job.id);
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

