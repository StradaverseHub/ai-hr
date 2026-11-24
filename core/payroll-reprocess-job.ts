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
 * chunk lasts about PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE times one pass's measured fixed cost, and at least
 * PAYROLL_REPROCESS_CHUNK_TARGET_MS (at most PAYROLL_REPROCESS_GROUP_MAX employees; 1 restores one employee per chunk).
 * An addition, an exclusion and the employees a refused pass names take the per-employee transaction
 * (`reprocessEmployeeTx`) in a chunk of their own, exactly as before, so every outcome and stop is the request path's;
 * a refused pass is narrowed to the employee it names (or halved), and grouping resumes after them.
 * Each chunk records its calculation (process CPU) and database (the rest of its wall time) split on the job's metrics.
 *
 * Audit loop capture once per job (ADR 0181 J2). The passes defer the run-wide inputs capture; the job takes it once, with
 * every employee it reprocessed, in its own finalize unit before it completes (or in its settle, when it stopped after
 * committing employees). Each records `captured` on the plan in the same transaction, so it is never taken twice.
 */

import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {enqueueBulkJobTx,type BulkJobRow} from './bulk-job';
import {BulkJobAuthorityLost,BulkJobWaiting,isTransientBulkJobError,type BulkJobHandler,type BulkJobStepOutcome,type BulkJobUnit} from './bulk-job-worker';
import {publicErrorMessage} from '../lib/public-error';
import {
 captureSelectiveReprocessInputsTx,claimSelectiveReprocess,completeSelectiveReprocess,enqueueSelectiveReprocess,reprocessEmployeeGroupTx,reprocessEmployeeTx,reprocessRunErrorCode,
 payrollReprocessJobRowTx,type SelectiveReprocessRun,
} from './payroll';
import {PAYROLL_REPROCESS_JOB_KIND} from '../lib/payroll-processing-job';

export {PAYROLL_REPROCESS_JOB_KIND};
type JobInput={reprocessJobId:string;batchId:string;employmentIds:string[];reason?:string};
type Stopped={current:{employmentId:string;name:string;employeeCode:string|null}|null};
/** `stopped`: what a failure recorded for the settle (the run-level stop code and the employee it stopped at). A
 * failure before the plan exists leaves a plan that holds only this key. */
type JobPlan=JobInput&{completed?:Record<string,unknown>;stopped?:{code:string;employee:Stopped['current']};captured?:true};
type Step={employmentId:string};
const inputOf=(job:BulkJobRow)=>job.input as JobInput|null;
const planOf=(job:BulkJobRow)=>job.plan as JobPlan|null;
/** The employee a failing step stopped at, kept for the failure record (process-local, per job). */
const stoppedOf=new Map<string,Stopped>();
const runOf=(job:BulkJobRow):SelectiveReprocessRun=>{const p=planOf(job)!;return{jobId:p.reprocessJobId,batchId:p.batchId,employmentIds:p.employmentIds,reason:p.reason,workerToken:job.id};};
/** Employees per engine pass, at most (1: one employee per chunk, the per-employee transaction only). */
export const payrollReprocessGroupMax=()=>Math.max(1,Math.floor(Number(process.env.PAYROLL_REPROCESS_GROUP_MAX??200))||1);
/** The chunk length the group size aims for, at least. The chunk holds the run's company/month key and its company's
 * payroll inputs key, so this bounds how long a salary or statutory change for that company may wait behind it. */
export const payrollReprocessChunkTargetMs=()=>Math.max(1,Number(process.env.PAYROLL_REPROCESS_CHUNK_TARGET_MS??1000)||1000);
/** One engine pass has a fixed cost whatever its size (the run-wide reads: on the hosted runner about 2.6 s of a
 * one-employee pass, against about 50 ms per further employee). A chunk may last this many times that fixed cost, so the
 * fixed cost is spread over a group instead of paid per employee; the per-employee path held the same keys for one fixed
 * cost per employee. */
export const payrollReprocessFixedMultiple=()=>Math.max(1,Number(process.env.PAYROLL_REPROCESS_CHUNK_FIXED_MULTIPLE??2)||2);
const FIRST_GROUP=16;
/** Per job and process:
 *  - `size`: the next group size, and `seen` the last passes of two different sizes it was estimated from;
 *  - `cap`: a narrower limit for the group starting at one employee, after a refused pass (see `narrow`);
 *  - `single`: employees a refused pass named, who take the per-employee transaction;
 *  - `chunk`: the employees the current chunk's group already wrote (their steps only record themselves; the last one
 *    ends the chunk). */
type GroupState={size:number;seen:{employees:number;wallMs:number}[];cap:{at:string;max:number}|null;single:Set<string>;chunk:{done:Set<string>;last:string|null}};
const groupStateOf=new Map<string,GroupState>();
const stateOf=(jobId:string)=>{let state=groupStateOf.get(jobId);if(!state){state={size:FIRST_GROUP,seen:[],cap:null,single:new Set(),chunk:{done:new Set(),last:null}};groupStateOf.set(jobId,state);}return state;};
const isTransient=(error:unknown)=>error instanceof BulkJobWaiting||isTransientBulkJobError(error);
/** The next group size from the passes seen so far. Two passes of different sizes give the fixed cost F and the cost per
 * employee m (a straight line); the group then fills max(target, multiple x F). Until then, or when the two passes do not
 * give a rising line, the size doubles. Always 2..PAYROLL_REPROCESS_GROUP_MAX, and at most double the last group. */
export function nextReprocessGroupSize(seen:readonly {employees:number;wallMs:number}[],last:number){
 const max=payrollReprocessGroupMax(),grow=Math.max(2,Math.min(max,last*2));
 const [a,b]=seen.slice(-2);
 if(!a||!b||a.employees===b.employees)return grow;
 const perEmployee=(b.wallMs-a.wallMs)/(b.employees-a.employees);
 if(!(perEmployee>0))return grow;
 const fixed=Math.max(0,b.wallMs-b.employees*perEmployee);
 const target=Math.max(payrollReprocessChunkTargetMs(),payrollReprocessFixedMultiple()*fixed);
 return Math.max(2,Math.min(grow,Math.floor((target-fixed)/perEmployee)));
}
/** After a refused pass of `group` (its first employee then takes the per-employee transaction in this chunk): the
 * employees the refusal names (its `rows[].employmentId` or `employmentId`, as the reprocess refusals carry) take the
 * per-employee transaction too, and the next group, starting at the second employee, stops before the first of them.
 * A refusal that names no one halves the next group, so a refusing employee is found in about log2(n) passes. */
export function narrowRefusedGroup(group:readonly string[],error:unknown):{cap:{at:string;max:number}|null;single:string[]}{
 const named=new Set<string>();
 const e=error as {employmentId?:unknown;rows?:unknown}|null;
 if(typeof e?.employmentId==='string')named.add(e.employmentId);
 if(Array.isArray(e?.rows))for(const row of e.rows){const id=(row as {employmentId?:unknown}|null)?.employmentId;if(typeof id==='string')named.add(id);}
 const rest=group.slice(1);if(!rest.length)return{cap:null,single:[]};
 const first=rest.findIndex(id=>named.has(id));
 const single=rest.filter(id=>named.has(id));
 // Only the first employee named (it runs alone now): the rest group as usual.
 if(first<0&&named.size)return{cap:null,single};
 const max=first>=0?first:Math.floor(group.length/2);
 return{cap:max>=1?{at:rest[0],max}:null,single};
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

const label=(tx:Tx,phase:string)=>tx.execute(sql`select set_config('application_name',${`aihr-bulk:${PAYROLL_REPROCESS_JOB_KIND}:${phase}`},true)`);
/** A stopped job's capture, under its creator's re-checked authority and exactly once (the plan marker commits with it).
 * The creator's access gone: nothing is captured, as when the pass itself had no login (the daily Audit loop's
 * `inputs_now` capture still shows the inputs). */
async function captureStoppedOnceTx(ctx:SessionContext,job:BulkJobRow,unit:Pick<BulkJobUnit,'fenceTx'|'set'>,reprocessJobId:string){
 await withTenant(ctx,async tx=>{
  await label(tx,'capture');
  try{await unit.fenceTx(tx);}catch(error){if(error instanceof BulkJobAuthorityLost)return;throw error;}
  const [fresh]=await tx.execute<{captured:boolean}>(sql`select coalesce((plan->>'captured')::boolean,false) as captured from bulk_job where id=${job.id}::uuid`);
  if(fresh?.captured)return;
  await captureSelectiveReprocessInputsTx(tx,ctx,reprocessJobId,job.id);
  await unit.set(tx,{planMerge:{captured:true} satisfies Pick<JobPlan,'captured'>});
 });
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
  const cap=state.cap?.at===id?state.cap.max:Infinity;
  const limit=Math.min(payrollReprocessGroupMax(),state.size,cap);
  if(limit>=2&&!state.single.has(id)&&!state.chunk.last){
   const at=run.employmentIds.indexOf(id);
   const candidates=at<0?[id]:run.employmentIds.slice(at,at+limit);
   const group=await reprocessEmployeeGroupTx(tx,ctx,run,candidates,{isTransient,stopped});
   if(group.kind==='done'){stoppedOf.delete(job.id);return{counters:{done:1}};}
   if(group.kind==='set'){
    const n=group.employmentIds.length,{wallMs,cpuMs}=group.timing;
    logChunk('group',n,wallMs,cpuMs,{wallMs:group.timing.engineWallMs,cpuMs:group.timing.engineCpuMs});
    state.chunk={done:new Set(group.employmentIds),last:group.employmentIds[n-1]};
    if(state.cap?.at===id)state.cap=null;
    // Passes of the full size estimate the line; a narrowed or cut-short group is still a valid point on it.
    state.seen=[...state.seen.filter(p=>p.employees!==n),{employees:n,wallMs}].slice(-2);
    state.size=nextReprocessGroupSize(state.seen,n);
    stoppedOf.delete(job.id);
    return{counters:{done:1},metrics:{
     add:{reprocessGroups:1,reprocessGroupEmployees:n,reprocessCalcMs:ms(cpuMs),reprocessDbMs:ms(wallMs-cpuMs)},
     max:{reprocessGroupMaxEmployees:n,reprocessGroupMaxMs:ms(wallMs),reprocessGroupMaxCalcMs:ms(cpuMs),reprocessGroupMaxDbMs:ms(wallMs-cpuMs)},
    }};
   }
   // A refused pass: this employee takes the per-employee transaction now; the refusal narrows what follows.
   if(group.kind==='fallback'){
    const narrowed=narrowRefusedGroup(group.employmentIds,group.error);
    state.cap=narrowed.cap;for(const employmentId of narrowed.single)state.single.add(employmentId);
   }
   stopped.current=null;
  }
  const started=performance.now(),cpuStarted=process.cpuUsage();
  await reprocessEmployeeTx(tx,ctx,run,id,stopped);
  state.single.delete(id);if(state.cap?.at===id)state.cap=null;
  stoppedOf.delete(job.id);
  const cpu=process.cpuUsage(cpuStarted),wallMs=performance.now()-started,cpuMs=(cpu.user+cpu.system)/1000;
  logChunk('single',1,wallMs,cpuMs);
  return{counters:{done:1},endChunk:true,metrics:{
   add:{reprocessSingles:1,reprocessCalcMs:ms(cpuMs),reprocessDbMs:ms(wallMs-cpuMs)},max:{reprocessSingleMaxMs:ms(wallMs)},
  }};
 },
 async finalize(ctx,job,unit){
  groupStateOf.delete(job.id);
  const plan=planOf(job)!;
  if(plan.completed)return{result:plan.completed};
  // First unit: the Audit loop's capture for every employee this job reprocessed, with no run key held.
  if(!plan.captured){
   const started=performance.now();
   await withTenant(ctx,async tx=>{
    await label(tx,'capture');
    await unit.fenceTx(tx);
    await captureSelectiveReprocessInputsTx(tx,ctx,plan.reprocessJobId,job.id);
    await unit.set(tx,{planMerge:{captured:true} satisfies Pick<JobPlan,'captured'>});
   });
   unit.metric('captureTxMs',performance.now()-started);
   return'more';
  }
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
 async settle(ctx,job,unit){
  if(job.state==='completed')return;
  const plan=planOf(job);
  const reprocessJobId=plan?.reprocessJobId??inputOf(job)?.reprocessJobId;if(!reprocessJobId)return;
  // The employees committed before the stop keep their results, so the Audit loop's capture is taken for them (once:
  // the marker commits with it). Before the stop record, which ends this job's hold on the reprocess job.
  if(ctx&&!plan?.captured)await captureStoppedOnceTx(ctx,job,unit,reprocessJobId);
  const stop=plan?.stopped;
  await unit.ownerTx(async owner=>{
   await owner`update payroll_reprocess_job set status='failed',error=${stop?.code??'REPROCESS_STOPPED'},updated_at=now(),
     result=coalesce(result,'{"outcomes":[]}'::jsonb)||jsonb_build_object('stoppedEmployee',${JSON.stringify(stop?.employee??null)}::jsonb)
    where id=${reprocessJobId}::uuid and status='running' and result->>'workerToken'=${job.id}`;
  });
 },
};

