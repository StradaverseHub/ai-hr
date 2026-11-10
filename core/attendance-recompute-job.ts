/**
 * Recompute Attendance (preview and apply) as clients of the shared bulk-job kernel (core/bulk-job-worker.ts;
 * migrations 9003, 9940). core/attendance-recompute.ts is unchanged in what it computes and writes; this moves
 * WHERE it runs.
 *
 * The synchronous preview and apply each held the tenant-wide Access lock (exclusive), the leave-dependency
 * configuration (shared) and every in-scope employee's clock key for the whole scope: 53–66 s for 1,207
 * employees over one day, with every clock-in waiting. Here the request validates the scope and admits a job;
 * the import worker re-works the scope one employee per step, each step in a chunk transaction of about 100 ms
 * that takes the same locks for that employee only, and finalize assembles exactly the result (and, for apply,
 * the run's history event and pay-run marks) the synchronous call returned.
 *
 * All-or-nothing where it was: a changed day inside a CLOSED pay run refuses the whole preview or apply. An apply
 * therefore first checks, read-only, every employee whose stored days a closed run may own ('check' steps, before
 * any write); one hit refuses the job and nothing is written. Each apply step still re-checks under the payroll
 * lock (a run closed meanwhile refuses that employee alone, reported on the job). Per-employee results are
 * independent (core/attendance-recompute.ts computeRecomputeDaysTx), so the job's end state equals the
 * synchronous call's for the same scope (test/attendance-recompute-job-equivalence.test.ts).
 */
import {randomUUID} from 'node:crypto';
import {and,gte,inArray,lte,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {attendance} from '../db/schema';
import {ATTENDANCE_JOB_ALREADY_RUNNING,ATTENDANCE_RECOMPUTE_KIND,ATTENDANCE_RECOMPUTE_PREVIEW_KIND,type AttendanceJobProgress} from '../lib/attendance-bulk-job';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {lockLeaveDependenciesTx,lockLeaveDependencyReadConfigurationTx} from './leave-dependency-lock';
import type {BulkJobHandler,BulkJobPrepared,BulkJobRefused,BulkJobStepOutcome} from './bulk-job-worker';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobProgress,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import {batchesCoveringAttendanceDates,closedBatchesCoveringAttendanceDates} from '../packs/payroll/service';
import {
 RecomputeScopeError,appendRecomputeRunTx,assertRecomputeAuthorityTx,assertRecomputeScope,closedRecomputeDayTx,closedRecomputeMessage,
 computeRecomputeDaysTx,emptyRecomputeResult,readRecomputePeopleTx,recomputePayAffecting,writeRecomputedDaysTx,
 type RecomputeFlag,type RecomputePerson,type RecomputeResult,type RecomputeRow,type RecomputeScope,
} from './attendance-recompute';

export {ATTENDANCE_RECOMPUTE_KIND,ATTENDANCE_RECOMPUTE_PREVIEW_KIND};
export const ATTENDANCE_RECOMPUTE_CHUNK_BUDGET_MS=Number(process.env.ATTENDANCE_RECOMPUTE_CHUNK_BUDGET_MS??100);
export type RecomputeJobInput={scope:Omit<RecomputeScope,'dryRun'>;runId:string;ranAt:string};
type StepKind='check'|'preview'|'apply';
/** An employee's stored days in [from, to]. An employee's windows tile the whole scope, so a day recorded after the
 * job read the scope still falls in exactly one of them. */
type Window={person:RecomputePerson;from:string;to:string};
type StepPayload={windows:Window[]};
type Day={employmentId:string;date:string};
/** Stored days re-worked per step. One day costs a schedule and calculation of its own (tens of milliseconds), so a
 * long range splits one employee into several windows and a one-day scope packs several employees together. */
export const ATTENDANCE_RECOMPUTE_STEP_DAYS=Number(process.env.ATTENDANCE_RECOMPUTE_STEP_DAYS??2);
const STEP_WINDOWS=8;
const nextDay=(date:string)=>new Date(Date.parse(`${date}T00:00:00Z`)+86_400_000).toISOString().slice(0,10);
/** Steps of windows in employment-id order: an employee's days split into windows of at most `perStep` days, and
 * consecutive windows packed until a step holds `perStep` days. */
function windowSteps(kind:StepKind,people:RecomputePerson[],daysOf:Map<string,string[]>,scope:{from:string;to:string},perStep:number){
 const steps:{kind:StepKind;payload:StepPayload;days:number}[]=[];
 for(const person of people){
  const dates=daysOf.get(person.employmentId)??[];
  for(let i=0;i<dates.length;i+=perStep){
   const part=dates.slice(i,i+perStep),last=i+perStep>=dates.length;
   const window={person,from:i===0?scope.from:nextDay(dates[i-1]),to:last?scope.to:part[part.length-1]};
   const step=steps[steps.length-1];
   if(step&&step.kind===kind&&step.days+part.length<=perStep&&step.payload.windows.length<STEP_WINDOWS){step.payload.windows.push(window);step.days+=part.length;}
   else steps.push({kind,payload:{windows:[window]},days:part.length});
  }
 }
 return steps;
}
type StepResult={checked:number;unchanged:number;rows:RecomputeRow[];flags:RecomputeFlag[];payAffecting:Day[];closed:Day|null;outOfScope?:boolean;skipped?:boolean};
const inputOf=(job:BulkJobRow)=>job.input as RecomputeJobInput;
const byDayThenEmployment=(a:Day,b:Day)=>a.date<b.date?-1:a.date>b.date?1:a.employmentId<b.employmentId?-1:a.employmentId>b.employmentId?1:0;
const byEmploymentThenDay=(a:Day,b:Day)=>a.employmentId<b.employmentId?-1:a.employmentId>b.employmentId?1:a.date<b.date?-1:a.date>b.date?1:0;
const label=(tx:Tx,kind:string,phase:string)=>tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);

/** Before any apply step: did a check step find a changed day a closed run owns, or fail to tell? */
async function applyRefusedTx(tx:Tx,job:BulkJobRow,cache:Map<string,unknown>){
 if(cache.has('refused'))return cache.get('refused') as boolean;
 const [row]=await tx.execute<{refused:boolean}>(sql`select exists(select 1 from bulk_job_step where job_id=${job.id}::uuid and kind='check'
  and (state='failed' or jsonb_typeof(result->'closed')='object')) as refused`);
 cache.set('refused',row.refused);return row.refused;
}

function recomputeJobHandler(kind:string,dryRun:boolean):BulkJobHandler<StepPayload>{
 return{
  kind,
  mode:'per-step',
  chunkBudgetMs:ATTENDANCE_RECOMPUTE_CHUNK_BUDGET_MS,
  maxStepsPerChunk:8,
  phaseOf:stepKind=>stepKind==='check'?'checking':'employees',
  stepRef:step=>step.payload.windows.map(w=>w.person.employeeCode??w.person.name).filter((v,i,all)=>all.indexOf(v)===i).join(', '),
  /** The scope, its people and the administrator's authority, read once with no lock held. */
  async prepare(ctx,job){
   const {scope}=inputOf(job);
   try{assertRecomputeScope(scope);}catch(error){if(error instanceof RecomputeScopeError)return{refused:error.message};throw error;}
   return withTenant(ctx,async (tx):Promise<BulkJobPrepared|BulkJobRefused>=>{
    const people=await readRecomputePeopleTx(tx,scope);
    if(people.length===0)return{steps:[],counters:{people:0}};
    try{await assertRecomputeAuthorityTx(tx,scope.companyId);}catch(error){if(error instanceof RecomputeScopeError)return{refused:error.message};throw error;}
    // Employment id order, as the synchronous call took the clock keys.
    const ordered=[...people].sort((a,b)=>a.employmentId<b.employmentId?-1:a.employmentId>b.employmentId?1:0);
    // The stored days in scope (only rows that exist are re-worked, as the synchronous call read them).
    const days:Day[]=[];
    for(let i=0;i<ordered.length;i+=1000)days.push(...await tx.select({employmentId:attendance.employmentId,date:attendance.attendanceDate}).from(attendance)
     .where(and(inArray(attendance.employmentId,ordered.slice(i,i+1000).map(p=>p.employmentId)),gte(attendance.attendanceDate,scope.from),lte(attendance.attendanceDate,scope.to)))
     .orderBy(attendance.attendanceDate));
    const daysOf=new Map<string,string[]>();
    for(const d of days){const list=daysOf.get(d.employmentId)??[];list.push(d.date);daysOf.set(d.employmentId,list);}
    let checks:RecomputePerson[]=[];
    if(!dryRun){
     // Which employees' stored days a CLOSED run may own: only those need the read-only check before any write.
     const covered=days.length?await closedBatchesCoveringAttendanceDates(tx,{companyId:scope.companyId,entries:days}):[];
     const owned=new Set(covered.flatMap(batch=>batch.employmentIds));
     checks=ordered.filter(p=>owned.has(p.employmentId));
    }
    const perStep=Math.max(1,ATTENDANCE_RECOMPUTE_STEP_DAYS);
    const steps=[...windowSteps('check',checks,daysOf,scope,perStep),...windowSteps(dryRun?'preview':'apply',ordered,daysOf,scope,perStep)]
     .map(({kind,payload},i)=>({kind,payload,rowNum:i+1}));
    return{steps,counters:{people:people.length,days:days.length,checks:checks.length}};
   });
  },
  /** The synchronous call's own locks and authority, for one chunk only. */
  async beginChunkTx(tx,ctx,job){
   await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
   await lockLeaveDependencyReadConfigurationTx(tx,ctx.tenantId);
   await assertRecomputeAuthorityTx(tx,inputOf(job).scope.companyId);
  },
  /** The step's windows: re-work those stored days (and, applying, write the changed ones) under each employee's
   * clock key. Every day is decided on its own, so windows and packing change nothing a day gets. */
  async applyStepTx(tx,ctx,job,step,cache):Promise<BulkJobStepOutcome>{
   const {scope,runId}=inputOf(job);const stepKind=step.kind as StepKind;
   const empty:StepResult={checked:0,unchanged:0,rows:[],flags:[],payAffecting:[],closed:null};
   const ids=[...new Set(step.payload.windows.map(w=>w.person.employmentId))].sort();
   if(stepKind==='apply'){
    if(await applyRefusedTx(tx,job,cache))return{result:{...empty,skipped:true} satisfies StepResult};
    await lockLeaveDependenciesTx(tx,ctx.tenantId,ids);
   }
   // Still in scope now (the synchronous call read its people at the moment it ran); labels as they are now.
   const people=new Map<string,RecomputePerson>();
   for(const id of ids){const [person]=await readRecomputePeopleTx(tx,scope,id);if(person)people.set(id,person);}
   for(const id of ids.filter(id=>people.has(id)))await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + id}, 0))`);
   const changed:Awaited<ReturnType<typeof computeRecomputeDaysTx>>['changed']=[],flags:RecomputeFlag[]=[];let checked=0,unchanged=0;
   for(const window of step.payload.windows){
    const person=people.get(window.person.employmentId);if(!person)continue;
    const computed=await computeRecomputeDaysTx(tx,ctx,{from:window.from,to:window.to,people:[person]});
    changed.push(...computed.changed);flags.push(...computed.flags);checked+=computed.checked;unchanged+=computed.unchanged;
   }
   const rows=changed.map(c=>c.row);
   const closed=await closedRecomputeDayTx(tx,rows);
   if(stepKind==='apply'){
    if(closed)throw new RecomputeScopeError(closedRecomputeMessage(closed.date));
    await writeRecomputedDaysTx(tx,ctx,runId,changed);
   }
   const result:StepResult={checked,unchanged,rows:stepKind==='check'?[]:rows,flags:stepKind==='check'?[]:flags,
    payAffecting:stepKind==='check'?[]:recomputePayAffecting(rows),closed,...(people.size<ids.length?{outOfScope:true}:{})};
   const counters:Record<string,number>=stepKind==='check'?{checked:1}:{updated:rows.length};
   if(people.size<ids.length)counters.outOfScope=ids.length-people.size;
   return{result,counters};
  },
  /** The synchronous call's result, assembled from the steps; applying, its run event and pay-run marks. */
  async finalize(ctx,job,unit){
   const input=inputOf(job);const {scope}=input;
   const empty=emptyRecomputeResult({...scope,dryRun},input.runId,input.ranAt);
   const started=performance.now();
   const result=await withTenant(ctx,async tx=>{
    await label(tx,kind,'finalize');await unit.fenceTx(tx);
    const steps=await tx.execute<{kind:StepKind;state:string;error:string|null;result:StepResult|null}>(sql`select kind,state,error,result from bulk_job_step where job_id=${job.id}::uuid order by seq`);
    if(steps.length===0)return empty;
    // All or nothing where the synchronous call was: a closed run owning a changed day refuses the whole scope.
    const closed=steps.map(s=>s.result?.closed).filter((d):d is Day=>!!d).sort(byEmploymentThenDay)[0];
    if(closed)throw new RecomputeScopeError(closedRecomputeMessage(closed.date));
    const failedCheck=steps.find(s=>s.kind==='check'&&s.state==='failed');
    if(failedCheck)throw new RecomputeScopeError(failedCheck.error??'Attendance could not be checked against closed payroll.');
    await assertRecomputeAuthorityTx(tx,scope.companyId);
    const result=await assembledTx(tx,scope,empty,steps);
    if(!dryRun&&result.checked>0)await appendRecomputeRunTx(tx,ctx,result);
    return result;
   });
   unit.metric('finalizeTxMs',performance.now()-started);
   return{result};
  },
  /** An apply that stopped after some employees were written (cancelled, or authority or a step failure ended it
   * before finalize): their days keep the run's history event and pay-run marks, as finalize would have written. */
  async afterTerminal(ctx,job){
   if(dryRun||job.state==='completed'||!ctx)return;
   const input=inputOf(job);const {scope}=input;
   await withTenant(ctx,async tx=>{
    const steps=await tx.execute<{kind:StepKind;state:string;error:string|null;result:StepResult|null}>(sql`select kind,state,error,result from bulk_job_step where job_id=${job.id}::uuid order by seq`);
    const result=await assembledTx(tx,scope,emptyRecomputeResult({...scope,dryRun},input.runId,input.ranAt),steps);
    if(result.updated>0)await appendRecomputeRunTx(tx,ctx,result);
   });
  },
 };
}
/** The synchronous result from the applied preview/apply steps: rows and flags in (date, employment) order. */
async function assembledTx(tx:Tx,scope:RecomputeJobInput['scope'],empty:RecomputeResult,steps:{kind:StepKind;state:string;result:StepResult|null}[]):Promise<RecomputeResult>{
 const own=steps.filter(s=>s.kind!=='check'&&s.state==='applied'&&s.result).map(s=>s.result!);
 const checked=own.reduce((n,r)=>n+r.checked,0);
 if(checked===0)return empty;
 const rows=own.flatMap(r=>r.rows).sort(byDayThenEmployment);
 const flags=own.flatMap(r=>r.flags).sort(byDayThenEmployment);
 const batchWarnings=await batchesCoveringAttendanceDates(tx,{companyId:scope.companyId,entries:own.flatMap(r=>r.payAffecting)});
 return{...empty,checked,updated:rows.length,unchanged:own.reduce((n,r)=>n+r.unchanged,0),flagged:flags.length,rows,flags,batchWarnings};
}
export const attendanceRecomputePreviewJobHandler=recomputeJobHandler(ATTENDANCE_RECOMPUTE_PREVIEW_KIND,true);
export const attendanceRecomputeJobHandler=recomputeJobHandler(ATTENDANCE_RECOMPUTE_KIND,false);

// ─── Web side: admission and the creator's progress ───────────────────────────────────────────────────

export class RecomputeJobRefused extends Error{constructor(readonly code:string,readonly status=400){super(code);this.name='RecomputeJobRefused';}}
export type RecomputeJobProgress=AttendanceJobProgress<RecomputeResult>;
export function recomputeJobProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):RecomputeJobProgress{
 const {result,...rest}=bulkJobProgress(row);
 return{...rest,result:row.state==='completed'?result as RecomputeResult:null,errorCode:null,worker:row.state==='queued'?worker:'running'};
}
const kindOf=(dryRun:boolean)=>dryRun?ATTENDANCE_RECOMPUTE_PREVIEW_KIND:ATTENDANCE_RECOMPUTE_KIND;
async function progressTx(tx:Tx,row:BulkJobRow){return recomputeJobProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,row.kind):'running');}
const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new RecomputeJobRefused(error.message===BULK_JOB_ALREADY_RUNNING?ATTENDANCE_JOB_ALREADY_RUNNING:'unavailable',error.status);
 return error;
};
/** Start a preview (dryRun) or an apply. The request validates the scope and the company authority and admits the
 * job; the import worker does the work. Apply always re-works the scope itself; a preview is never an instruction. */
export async function startRecomputeJob(ctx:SessionContext,p:RecomputeScope&{operationKey?:string}):Promise<{job:RecomputeJobProgress;existing:boolean}>{
 const scope:Omit<RecomputeScope,'dryRun'>={companyId:p.companyId,departmentId:p.departmentId??null,employmentIds:p.employmentIds??null,from:p.from,to:p.to};
 assertRecomputeScope(scope);
 try{
  return await withTenant(ctx,async tx=>{
   await assertRecomputeAuthorityTx(tx,scope.companyId);
   const input:RecomputeJobInput={scope,runId:randomUUID(),ranAt:new Date().toISOString()};
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:kindOf(p.dryRun),operationKey:p.operationKey,companyIds:[scope.companyId],input});
   return{job:await progressTx(tx,row),existing};
  });
 }catch(error){throw kernelError(error);}
}
export async function getRecomputeJob(ctx:SessionContext,id:string){
 try{return await withTenant(ctx,async tx=>{
  const row=await bulkJobTx(tx,id);
  if(row.kind!==ATTENDANCE_RECOMPUTE_KIND&&row.kind!==ATTENDANCE_RECOMPUTE_PREVIEW_KIND)throw new BulkJobError('Job unavailable.',404);
  return progressTx(tx,row);
 });}catch(error){throw kernelError(error);}
}
/** The signed-in user's most recent previews and applies, newest first (the screen rejoins a running one). */
export async function listRecomputeJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=[...await listBulkJobsTx(tx,ctx,ATTENDANCE_RECOMPUTE_PREVIEW_KIND,5),...await listBulkJobsTx(tx,ctx,ATTENDANCE_RECOMPUTE_KIND,5)]
  .sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
 const out:RecomputeJobProgress[]=[];
 for(const row of rows)out.push(await progressTx(tx,row));
 return out;
});}
