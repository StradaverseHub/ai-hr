/** ADR 0181 J2, imports: the shared mechanics of a set-based import group, for the per-step import kinds that apply
 * one planned row per kernel step (leave ledger import first; core/employee-import-worker.ts has its own copy of the
 * same rules for its atomic staged kind).
 *
 * The first step of a chunk, when its row has the kind's common shape, writes the longest run of following pending
 * steps of that shape (up to the group size) through the kind's set writer, in ONE savepoint. The later steps of the
 * group then only record the outcome the group gave them, and the last one ends the chunk (the kernel's `endChunk`).
 * When the set writer declines or refuses anything, its savepoint is rolled back and every row of the group takes the
 * kind's unchanged per-row apply, which then decides and records exactly its own outcome (an error row, a skip, a
 * transient retry). The set writer never decides a refusal.
 *
 * The group size adapts to measured time, as the employee import's does: a straight line (fixed cost F, cost m a row)
 * from the last two groups of different sizes; the chunk fills max(target, multiple x F), never more than the ceiling
 * (a chunk holds the tenant's exclusive Access lock; SCALE rule 1 keeps every exclusive hold under about 1 s). Before a
 * line exists, the size doubles while the last group's own rate keeps it under the ceiling. `<KIND>_GROUP_MAX=1`
 * restores the per-row path for every row.
 *
 * Timing: each chunk logs one `[aihr-timing]` `bulk-chunk` line (mode `group`, `single` or `declined` with a closed
 * reason; numbers and labels only, never a tenant, person, company or value) and adds process CPU (`importCalcMs`) and
 * the rest of the wall time (`importDbMs`) to bulk_job.metrics with group and single counts and maxima. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';
import type {BulkJobStep,BulkJobStepOutcome} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';

/** Thrown by a set writer that will not decide a group (the per-row path then runs). `reason` is a closed label. */
export class SetPathDeclined extends Error{
 constructor(readonly reason:string){super(`Set path declined: ${reason}`);this.name='SetPathDeclined';}
}
export type ImportGroupPass={rows:number;wallMs:number};
export type ImportGroupLimits={max:number;targetMs:number;ceilingMs:number;fixedMultiple:number};

/** The next group size from the last two groups of different sizes (see the file header). Always 2..max, and at most
 * double the last group. */
export function nextImportGroupSize(seen:readonly ImportGroupPass[],last:number,limits:ImportGroupLimits){
 const max=Math.max(2,limits.max),doubled=Math.max(2,Math.min(max,last*2));
 // Without a line, growth stops where the last group's own rate would cross the ceiling (its cost is at least
 // proportional to its rows, the fixed cost being >= 0).
 const point=seen.at(-1);
 const grow=Math.max(2,Math.min(doubled,point&&point.wallMs>0?Math.floor(point.rows*limits.ceilingMs/point.wallMs):Infinity));
 const [a,b]=seen.slice(-2);
 if(!a||!b||a.rows===b.rows)return grow;
 const perRow=(b.wallMs-a.wallMs)/(b.rows-a.rows);
 if(!(perRow>0))return grow;
 const fixed=Math.max(0,b.wallMs-b.rows*perRow);
 const target=Math.min(limits.ceilingMs,Math.max(limits.targetMs,limits.fixedMultiple*fixed));
 return Math.max(2,Math.min(doubled,Math.floor((target-fixed)/perRow)));
}
/** The last two passes of different sizes (a pass of a size already seen replaces it). */
export const rememberImportGroupPass=(seen:readonly ImportGroupPass[],pass:ImportGroupPass)=>[...seen.filter(p=>p.rows!==pass.rows),pass].slice(-2);

const settingNumber=(raw:string|undefined,fallback:number)=>{const value=Number(raw??fallback);return Number.isFinite(value)&&value>0?value:fallback;};
const roundMs=(value:number)=>Math.max(0,Math.round(value));
const cpuMsSince=(start:NodeJS.CpuUsage)=>{const c=process.cpuUsage(start);return(c.user+c.system)/1000;};

/** What one kind tells the controller. `P` is the step payload, `R` the set writer's per-row outcome. */
export type ImportGroupKind<P,R>={
 /** The bulk_job kind (the timing line's label). */
 kind:string;
 /** The kind's knobs as the environment holds them (`<KIND>_GROUP_MAX`, `_CHUNK_TARGET_MS`, `_CHUNK_CEILING_MS`,
  *  `_CHUNK_FIXED_MULTIPLE`), read by the kind with literal keys so the module catalogue's gate checks see them
  *  (test/module-catalog-drift.test.ts); unset or invalid values take the defaults. */
 settings:()=>{groupMax?:string;targetMs?:string;ceilingMs?:string;fixedMultiple?:string};
 defaults:{groupMax:number;targetMs:number;ceilingMs:number;fixedMultiple:number;firstGroup:number};
 /** Per-row steps: the chunk commits once they reach this much wall time or this many steps (the old kernel limits). */
 perRowBudgetMs:()=>number;perRowMaxSteps:number;
};
export type ImportGroupApply<P,R>={
 /** The row may join a set-based group (the kind's common shape). */
 shape(step:BulkJobStep<P>):boolean;
 /** `candidate` may join the group formed so far (`members`, the first one being the chunk's first step), for
  *  example the same company or a person not yet in the group. The group ends before the first one that may not. */
 joins?(candidate:BulkJobStep<P>,members:readonly BulkJobStep<P>[]):boolean;
 /** Writes the whole group in the caller's savepoint, or throws (any error declines the group). One outcome per step. */
 applyGroup(savepoint:Tx,steps:BulkJobStep<P>[]):Promise<R[]>;
 /** The kernel outcome a grouped step records: exactly what the per-row apply returns for the same row. */
 outcomeOf(outcome:R,step:BulkJobStep<P>):{result?:unknown;counters?:Record<string,number>};
 /** The kind's unchanged per-row apply. */
 perRow():Promise<BulkJobStepOutcome>;
};

type ChunkState={startedAt:number;cpu:NodeJS.CpuUsage;entered:number;done:Map<number,{result?:unknown;counters?:Record<string,number>}>;last:number|null};
type GroupState={size:number;seen:ImportGroupPass[];single:Set<number>;chunk:ChunkState};
const freshChunk=():ChunkState=>({startedAt:performance.now(),cpu:process.cpuUsage(),entered:0,done:new Map(),last:null});

/** One controller per kind; its state is per job and process (a resumed or moved job only loses its size estimate). */
export function importGroupController<P,R>(kind:ImportGroupKind<P,R>){
 const states=new Map<string,GroupState>();
 const limits=():ImportGroupLimits=>{const raw=kind.settings();return{
  max:Math.max(1,Math.floor(settingNumber(raw.groupMax,kind.defaults.groupMax))||1),
  targetMs:settingNumber(raw.targetMs,kind.defaults.targetMs),
  ceilingMs:settingNumber(raw.ceilingMs,kind.defaults.ceilingMs),
  fixedMultiple:settingNumber(raw.fixedMultiple,kind.defaults.fixedMultiple),
 };};
 const groupMax=()=>limits().max;
 const stateOf=(jobId:string)=>{let s=states.get(jobId);if(!s){s={size:kind.defaults.firstGroup,seen:[],single:new Set(),chunk:freshChunk()};states.set(jobId,s);}return s;};
 /** The pending steps a chunk reads: a group never extends past them. */
 const maxSteps=()=>Math.max(kind.perRowMaxSteps,groupMax());
 function log(mode:'group'|'single'|'declined',rows:number,wallMs:number,cpuMs:number,reason?:string){
  if(process.env.AIHR_TIMING==='off')return;
  console.info('[aihr-timing] '+JSON.stringify({t:'bulk-chunk',kind:kind.kind,mode,rows,wallMs:roundMs(wallMs),calcMs:roundMs(cpuMs),dbMs:roundMs(wallMs-cpuMs),...(reason?{reason}:{})}));
 }
 async function group(tx:Tx,job:BulkJobRow,step:BulkJobStep<P>,s:GroupState,apply:ImportGroupApply<P,R>):Promise<BulkJobStepOutcome|null>{
  // The same verified pending list the kernel read for this chunk (same definer, same limit; nothing applied yet).
  const pending=await tx.execute<BulkJobStep<P>>(sql`select seq,kind,row_num,payload from app.bulk_job_pending_steps(${job.id}::uuid,${maxSteps()})`);
  if(pending[0]?.seq!==step.seq)return null;
  const limit=Math.min(groupMax(),s.size);
  const members:BulkJobStep<P>[]=[];
  for(const candidate of pending){
   if(members.length>=limit||s.single.has(candidate.seq)||!apply.shape(candidate)||(apply.joins&&members.length>0&&!apply.joins(candidate,members)))break;
   members.push(candidate);
  }
  if(members.length<2)return null;
  const started=performance.now(),cpu=process.cpuUsage();
  let outcomes:R[];
  try{
   outcomes=await tx.transaction(savepoint=>apply.applyGroup(savepoint as Tx,members));
   if(outcomes.length!==members.length)throw new SetPathDeclined('outcomes');
  }catch(error){
   // Declined, refused or busy: every row of the group takes the per-row path, which decides it as before.
   for(const m of members)s.single.add(m.seq);
   log('declined',members.length,performance.now()-started,cpuMsSince(cpu),error instanceof SetPathDeclined?error.reason:'refused');
   return null;
  }
  const wallMs=performance.now()-started,cpuMs=cpuMsSince(cpu),n=members.length;
  s.chunk.done=new Map(members.map((m,i)=>[m.seq,apply.outcomeOf(outcomes[i],m)]));
  s.chunk.last=members[n-1].seq;s.chunk.entered++;
  s.seen=rememberImportGroupPass(s.seen,{rows:n,wallMs});
  s.size=nextImportGroupSize(s.seen,n,limits());
  log('group',n,wallMs,cpuMs);
  return{...s.chunk.done.get(step.seq),metrics:{
   add:{importGroups:1,importGroupRows:n,importCalcMs:roundMs(cpuMs),importDbMs:roundMs(wallMs-cpuMs)},
   max:{importGroupMaxRows:n,importGroupMaxMs:roundMs(wallMs),importGroupMaxCalcMs:roundMs(cpuMs),importGroupMaxDbMs:roundMs(wallMs-cpuMs)},
  }};
 }
 return{
  groupMax,maxSteps,
  /** Start of every chunk transaction (no statement). */
  beginChunk(jobId:string){stateOf(jobId).chunk=freshChunk();},
  forget(jobId:string){states.delete(jobId);},
  async applyStep(tx:Tx,job:BulkJobRow,step:BulkJobStep<P>,apply:ImportGroupApply<P,R>):Promise<BulkJobStepOutcome>{
   const s=stateOf(job.id),chunk=s.chunk;
   // Written by this chunk's group already: the step only records the outcome it had; the group's last step ends
   // the chunk.
   const grouped=chunk.done.get(step.seq);
   if(grouped){chunk.entered++;return{...grouped,...(step.seq===chunk.last?{endChunk:true}:{})};}
   if(chunk.entered===0&&groupMax()>=2&&!s.single.has(step.seq)&&apply.shape(step)){
    const outcome=await group(tx,job,step,s,apply);
    if(outcome)return outcome;
   }
   chunk.entered++;
   const started=performance.now(),cpu=process.cpuUsage();
   const outcome=await apply.perRow();
   const wallMs=performance.now()-started,cpuMs=cpuMsSince(cpu);
   s.single.delete(step.seq);
   // The old kernel limits of a per-row chunk: its wall-time budget and its step cap.
   const end=chunk.entered>=kind.perRowMaxSteps||performance.now()-chunk.startedAt>=kind.perRowBudgetMs();
   if(end)log('single',chunk.entered,performance.now()-chunk.startedAt,cpuMsSince(chunk.cpu));
   return{...(outcome??{}),...(end?{endChunk:true}:{}),metrics:{add:{importSingles:1,importCalcMs:roundMs(cpuMs),importDbMs:roundMs(wallMs-cpuMs)},max:{importSingleMaxMs:roundMs(wallMs)}}};
  },
 };
}
