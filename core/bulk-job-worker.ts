/** Shared background bulk-job kernel, worker side (migrations 5011, 5013, 5014). The queue-owner connection claims,
 * leases and coordinates, and runs a kind's owner-only routines: discard always, finalize only for a kind that
 * declares it (handler.finalizeOwner and bulk_job_kind.finalize_owner). Every HR write runs through the app role under
 * the creator's freshly resolved authority, in short transactions that fence on the lease. The application role
 * cannot write the job store: the worker's own writes go through definers that require this claim's lease
 * capability, and what later privileged steps trust (input, plan, every step) is sealed and verified. A kind plugs in
 * with a BulkJobHandler (see the ADR section "Shared job kernel"). */
import {sql} from 'drizzle-orm';
import {randomBytes,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import type postgres from 'postgres';
import {withBackgroundDatabaseWork} from '../db/workload';
import {DatabaseAdmissionError} from '../db/admission';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {pgSqlState} from '../lib/db-error';
import {publicErrorMessage} from '../lib/public-error';
import {BULK_JOB_FINISHED_EVENT,type BulkJobRowError,type BulkJobState} from '../lib/bulk-job';
import {LeaveDependencyUnavailable} from './leave-dependency-lock';
import {freshImportContext} from './bank-import-worker';
import type {BulkJobRow} from './bulk-job';

export type BulkJobStepInput={kind:string;rowNum?:number|null;payload:unknown};
export type BulkJobStep<P=unknown>={seq:number;kind:string;row_num:number|null;payload:P};
export type BulkJobPrepared={steps:BulkJobStepInput[];plan?:unknown;counters?:Record<string,number>;companyIds?:readonly string[];phase?:string|null};
export type BulkJobRefused={refused:string;errors?:BulkJobRowError[];plan?:unknown;counters?:Record<string,number>;companyIds?:readonly string[]};
export type BulkJobStepOutcome={result?:unknown;counters?:Record<string,number>}|void;
/** A worker write to its own job row (app.bulk_job_worker_update, 5013). Only the keys present change. `state` is
 * limited to the worker's forward transitions (queued→preparing; preparing→running|finalizing|completed|failed;
 * running→finalizing|completed; finalizing→running|completed); `expectState` makes the write a no-op (false) unless
 * the job is in one of those states. A plan change is resealed. */
export type BulkJobWorkerSet={
 state?:BulkJobState;expectState?:readonly BulkJobState[];phase?:string|null;
 stepsTotal?:number;stepsDone?:number;stepsDoneAdd?:number;
 counters?:Record<string,number>;countersMerge?:Record<string,number>;countersAdd?:Record<string,number>;
 plan?:unknown;planMerge?:Record<string,unknown>;attemptId?:string|null;companyIds?:readonly string[];result?:unknown;
 error?:string|null;errors?:BulkJobRowError[];errorsAppend?:BulkJobRowError[];resetTransientRetries?:boolean;finished?:boolean;noticeEventId?:string;
};
/** A worker write to steps of its job (app.bulk_job_step_update, 5013): each step must still match its seal. */
export type BulkJobStepSet={state?:'pending'|'applied'|'failed';result?:unknown;resultMerge?:Record<string,unknown>;error?:string|null};
/** A fenced app-role transaction (after unit.fenceTx) or the connection inside unit.ownerTx. */
export type BulkJobRunner=Tx|postgres.ReservedSql;
/** Per-unit services the kernel gives a kind. */
export type BulkJobUnit={
 /** Inside an app-role transaction: refuses (rolls back) unless this worker still holds the job's lease, and binds the
  *  transaction to the lease capability so unit.set/unit.step may write the job. */
 fenceTx(tx:Tx):Promise<void>;
 /** Records the largest observed value of a named metric on the job (milliseconds by convention). */
 metric(name:string,value:number):void;
 /** The kind's own writes to its job row (plan, counters, result, ...), sealed. Never UPDATE bulk_job directly. */
 set(runner:BulkJobRunner,set:BulkJobWorkerSet):Promise<boolean>;
 /** The kind's own writes to its steps (state, result, error), sealed. Never UPDATE bulk_job_step directly. */
 step(runner:BulkJobRunner,seqs:number|readonly number[],set:BulkJobStepSet):Promise<number>;
 /** Verifies the whole seal (input, plan and every step) now; throws BulkJobIntegrityError on any difference. The
  *  kernel already does this before the first finalize unit after the last step write. */
 verifySeal():Promise<void>;
 /** The queue-owner connection, as one transaction attributed to this job (app.bulk_job, 5014). Present in discard,
  *  and in finalize only for a kind that declares finalizeOwner. Never open an app-role transaction inside it. */
 ownerTx?<T>(fn:(owner:postgres.ReservedSql)=>Promise<T>):Promise<T>;
};
export type BulkJobDiscardUnit=Omit<BulkJobUnit,'fenceTx'|'ownerTx'>&{ownerTx<T>(fn:(owner:postgres.ReservedSql)=>Promise<T>):Promise<T>};
export type BulkJobFinalized={result:unknown;counters?:Record<string,number>};
export type BulkJobHandler<P=any>={
 kind:string;
 /** 'atomic': a refused step stops the job and the kind's discard undoes the staged work (all-or-nothing).
  *  'per-step': a refused step is recorded on the job and the others continue (each step commits on its own). */
 mode:'atomic'|'per-step';
 /** Validate once with no transaction or tenant lock held. Returns the ordered steps, or a whole-file refusal. */
 prepare(ctx:SessionContext,job:BulkJobRow):Promise<BulkJobPrepared|BulkJobRefused>;
 /** In the one transaction that makes the steps runnable (or records the refusal): history attempt, claims. */
 commitPrepareTx?(tx:Tx,ctx:SessionContext,job:BulkJobRow,prepared:BulkJobPrepared|BulkJobRefused):Promise<{attemptId?:string|null;plan?:unknown}|void>;
 /** Start of every chunk transaction, before steps are read: the kind's normal writer locks and session settings. */
 beginChunkTx?(tx:Tx,ctx:SessionContext,job:BulkJobRow):Promise<void>;
 /** Apply one step. Its write and the kernel's applied marker commit together, so a crash never repeats it. */
 applyStepTx(tx:Tx,ctx:SessionContext,job:BulkJobRow,step:BulkJobStep<P>,cache:Map<string,unknown>):Promise<BulkJobStepOutcome>;
 /** Wall-clock work per chunk transaction before it commits (default 250 ms) and a step cap (default 64). */
 chunkBudgetMs?:number;maxStepsPerChunk?:number;
 /** 'per-step' only: after this many consecutive transient retries the step that keeps refusing is recorded as
  *  failed and the job moves on (a stuck row never blocks the file). Default: retry until the job's budget ends. */
 transientStepLimit?:number;
 phaseOf?(stepKind:string):string;
 /** true: finalize receives unit.ownerTx. The kind's bulk_job_kind row must say finalize_owner too (a migration), or
  *  the job fails before finalize runs. Without it finalize runs as the app role only. */
 finalizeOwner?:true;
 /** Called repeatedly in state 'finalizing' until it returns the result; each call must be one bounded unit. */
 finalize?(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit):Promise<'more'|BulkJobFinalized>;
 /** Owner-only undo of staged work in bounded batches ('more' until done), through unit.ownerTx. Required for 'atomic'. */
 discard?(job:BulkJobRow,unit:BulkJobDiscardUnit):Promise<'more'|'done'>;
 /** On a non-transient failure: discard staged work (default for atomic kinds) or end as failed without discard. */
 onFailure?(job:BulkJobRow,error:unknown):'discard'|'fail';
 /** Text and row errors recorded for a failure. `owner` is the queue-owner connection inside a READ ONLY transaction
  *  (it may read the job's steps); planMerge is applied to the plan with the failure. Default: the public message. */
 describeFailure?(job:BulkJobRow,error:unknown,step:BulkJobStep|null,owner:postgres.ReservedSql):Promise<{error:string;errors?:BulkJobRowError[];planMerge?:Record<string,unknown>}>;
 /** Reference shown with a per-step refusal (for example an employee code or email); never IC, bank or salary. */
 stepRef?(step:BulkJobStep<P>):string;
 isTransient?(error:unknown):boolean;
 /** Best effort after the terminal state committed (history, post-commit refreshes). ctx is null when revoked.
  *  {clearPlan:true}: the kernel also clears the plan when it clears the inputs. */
 afterTerminal?(ctx:SessionContext|null,job:BulkJobRow):Promise<void|{clearPlan?:boolean}>;
 /** true: skip the completion notice for this terminal job (for example a short job its creator watched to the end
  *  on its own screen, bulk_job.watched_at, migration 5041). The job row still shows the outcome. */
 quietNotice?(job:BulkJobRow):boolean;
};
export class BulkJobStepRefused extends Error{constructor(readonly step:BulkJobStep,readonly cause:unknown){super(publicErrorMessage(cause));this.name='BulkJobStepRefused';}}
class LeaseLost extends Error{constructor(){super('Bulk job lease lost.');}}
/** The creator can no longer act on the job (grants or company access changed). */
export class BulkJobAuthorityLost extends Error{constructor(){super('Your access to this job changed, so it was stopped.');this.name='BulkJobAuthorityLost';}}
/** The job's stored input, plan or steps no longer match the worker's seal (5013). */
export class BulkJobIntegrityError extends Error{constructor(readonly part:string){super('The job\'s saved data failed its integrity check, so it was stopped. Start it again.');this.name='BulkJobIntegrityError';}}
/** The handler and the kind's migration disagree (for example finalizeOwner without bulk_job_kind.finalize_owner). */
export class BulkJobConfigurationError extends Error{constructor(message:string){super(message);this.name='BulkJobConfigurationError';}}
const TERMINAL:readonly BulkJobState[]=['completed','failed','cancelled'];
const LEASE_SECONDS=60,PREPARE_LEASE_SECONDS=900,MAX_TRANSIENT_RETRIES=600,STEP_INSERT_BATCH=400;
/** SQLSTATE of a seal mismatch raised by the capability-gated definers (data_corrupted). */
const SEAL_MISMATCH='XX001';

/** Transient database refusals retry the same unit after a short backoff; anything else is a real failure. */
export function isTransientBulkJobError(error:unknown){
 if(error instanceof LeaveDependencyUnavailable)return error.reason==='busy';
 if(error instanceof DatabaseAdmissionError)return true;
 const code=pgSqlState(error);
 return code==='40P01'||code==='40001'||code==='55P03'||code==='53300'||code==='57P03';
}
type WorkerGlobal=typeof globalThis&{__aihrBulkJobTx?:(kind:string,phase:string,ms:number,jobId:string)=>void};
const report=(kind:string,phase:string,ms:number,jobId:string)=>(globalThis as WorkerGlobal).__aihrBulkJobTx?.(kind,phase,ms,jobId);
/** Labels the transaction for lock attribution (pg_stat_activity.application_name) until it commits. */
async function label(tx:Tx,kind:string,phase:string){await tx.execute(sql`select set_config('application_name',${`aihr-bulk:${kind}:${phase}`},true)`);}
const merge=(a:Record<string,number>,b?:Record<string,number>)=>{if(!b)return a;const out={...a};for(const [k,v] of Object.entries(b))out[k]=(out[k]??0)+v;return out;};

export type BulkJobWorkerOptions={workerId?:string;handlers:readonly BulkJobHandler[]};
type Uuid=`${string}-${string}-${string}-${string}-${string}`;
/** One claim: the lease token (visible on the row) and its capability (only here and as a digest in app.bulk_job_seal). */
type Claimed={job:BulkJobRow;token:string;capability:string;metrics:Record<string,number>;ownerOpen?:boolean};
const caches=new Map<string,Map<string,unknown>>();
const cacheOf=(id:string)=>{let c=caches.get(id);if(!c){c=new Map();caches.set(id,c);}return c;};
let beatAt=0;const processWorker:Uuid=randomUUID();

/** Heartbeat for readiness checks (deploy and the queued screen state). Throttled; owner connection only. */
export async function beatBulkJobWorker(owner:postgres.Sql|postgres.ReservedSql,kinds:readonly string[],workerId:string=processWorker,force=false){
 if(!force&&Date.now()-beatAt<15000)return;
 beatAt=Date.now();
 await owner`insert into bulk_job_worker(id,kinds,host,pid) values(${workerId}::uuid,${kinds as string[]},${hostname().slice(0,255)},${process.pid})
  on conflict(id) do update set kinds=excluded.kinds,beat_at=now()`;
 await owner`delete from bulk_job_worker where beat_at<now()-interval '1 day'`;
}
export async function retireBulkJobWorker(owner:postgres.Sql,workerId:string=processWorker){await owner`delete from bulk_job_worker where id=${workerId}::uuid`;}

/** One bounded unit of one job (fair across tenants: least recently touched first). Owner credential stays here. */
export async function runBulkJobTick(owner:postgres.Sql,options:BulkJobWorkerOptions):Promise<boolean>{
 const handlers=new Map(options.handlers.map(h=>[h.kind,h]));
 const kinds=[...handlers.keys()];
 const connection=await owner.reserve();
 try{
  const [proof]=await connection<{ok:boolean}[]>`select exists(select 1 from pg_roles r join pg_class c on c.oid='public.bulk_job'::regclass where r.rolname=current_user and (r.rolsuper or c.relowner=r.oid)) as ok`;
  if(!proof?.ok)throw new Error('The bulk job worker requires the physical queue owner connection.');
  await beatBulkJobWorker(connection,kinds,options.workerId??processWorker);
  const token=randomUUID();
  // Active work first, through the partial queue index (literal state list so the index predicate applies); then a
  // terminal job whose completion notice is still owed (its own partial index). History rows are never scanned.
  // A queued job of a 'tenant_queue' kind (draft 5041) waits until every earlier active job of its kind in its
  // tenant has ended, so jobs of that kind run one after another without ever refusing an admission.
  let [job]=await connection<BulkJobRow[]>`update bulk_job set lease_token=${token}::uuid,lease_expires_at=now()+make_interval(secs=>${LEASE_SECONDS})
   where id=(select j.id from bulk_job j where j.state in ('queued','preparing','running','finalizing','discarding') and j.kind=any(${kinds})
    and (j.lease_expires_at is null or j.lease_expires_at<now()) and (j.not_before is null or j.not_before<=now())
    and not (j.state='queued' and exists(select 1 from bulk_job_kind k where k.kind=j.kind and k.exclusive='tenant_queue')
     and exists(select 1 from bulk_job o where o.tenant_id=j.tenant_id and o.kind=j.kind and o.id<>j.id
      and o.state in ('queued','preparing','running','finalizing','discarding') and (o.created_at,o.id)<(j.created_at,j.id)))
    order by j.updated_at,j.created_at limit 1 for update of j skip locked) returning *`;
  if(!job)[job]=await connection<BulkJobRow[]>`update bulk_job set lease_token=${token}::uuid,lease_expires_at=now()+make_interval(secs=>${LEASE_SECONDS})
   where id=(select id from bulk_job where notified_at is null and state in ('completed','failed','cancelled') and kind=any(${kinds})
    and finished_at>now()-interval '1 day' and (lease_expires_at is null or lease_expires_at<now()) and (not_before is null or not_before<=now())
    order by finished_at limit 1 for update skip locked) returning *`;
  if(!job)return false;
  const claimed:Claimed={job,token,capability:randomBytes(32).toString('hex'),metrics:{}};
  try{
   // Bind a fresh capability to this lease: only this worker can now write the job through the definers.
   const [bound]=await connection<{ok:boolean}[]>`select app.bulk_job_lease_capability(${job.id}::uuid,${token}::uuid,${claimed.capability}) as ok`;
   if(bound?.ok)await withBackgroundDatabaseWork(()=>processClaimed(connection,handlers.get(job.kind)!,claimed));
  }finally{
   await connection`update app.bulk_job_seal set lease_token=null,capability_digest=null where job_id=${job.id}::uuid and lease_token=${token}::uuid`;
   // updated_at moves on every unit, so the least recently touched job is always next (fair across tenants).
   await connection`update bulk_job set lease_token=null,lease_expires_at=null,updated_at=now(),
     metrics=metrics||coalesce((select jsonb_object_agg(k,greatest(coalesce((metrics->>k)::numeric,0),v::numeric)) from jsonb_each_text(${JSON.stringify(claimed.metrics)}::text::jsonb) m(k,v)),'{}'::jsonb)
    where id=${job.id}::uuid and lease_token=${token}::uuid`;
  }
  return true;
 }finally{connection.release();}
}

/** The creator's session as the web had it: database-captured grants with freshly resolved entitlements, and the
 * person currently linked to the login (the canonical principal checks bind a session to that person). */
export async function bulkJobContext(connection:postgres.ReservedSql|postgres.Sql,job:Pick<BulkJobRow,'context'|'created_by'|'tenant_id'>):Promise<SessionContext>{
 const ctx=await freshImportContext(job.context);
 if(!ctx.personId){
  const [user]=await connection<{person_id:string|null}[]>`select person_id from app_user where id=${job.created_by}::uuid and tenant_id=${job.tenant_id}::uuid`;
  if(user?.person_id)ctx.personId=user.person_id;
 }
 return ctx;
}
const isOwnerRunner=(runner:BulkJobRunner):runner is postgres.ReservedSql=>typeof runner==='function';
async function workerSet(runner:BulkJobRunner,jobId:string,set:BulkJobWorkerSet):Promise<boolean>{
 const json=JSON.stringify(set);
 if(isOwnerRunner(runner)){const [r]=await runner<{ok:boolean}[]>`select app.bulk_job_worker_update(${jobId}::uuid,${json}::text::jsonb) as ok`;return Boolean(r?.ok);}
 const [r]=await runner.execute<{ok:boolean}>(sql`select app.bulk_job_worker_update(${jobId}::uuid,${json}::text::jsonb) as ok`);return Boolean(r?.ok);
}
async function stepSet(runner:BulkJobRunner,jobId:string,seqs:number|readonly number[],set:BulkJobStepSet):Promise<number>{
 const list=`{${(typeof seqs==='number'?[seqs]:[...seqs]).map(n=>Math.trunc(n)).join(',')}}`;const json=JSON.stringify(set);
 if(isOwnerRunner(runner)){const [r]=await runner<{n:number}[]>`select app.bulk_job_step_update(${jobId}::uuid,${list}::text::int[],${json}::text::jsonb) as n`;return Number(r?.n??0);}
 const [r]=await runner.execute<{n:number}>(sql`select app.bulk_job_step_update(${jobId}::uuid,${list}::text::int[],${json}::text::jsonb) as n`);return Number(r?.n??0);
}
/** Owner-side seal verification (5013): 'header' input and plan; 'full' also every step; 'first' full unless already
 * verified since the last step write. */
async function verifySealOf(connection:postgres.ReservedSql,c:Claimed,mode:'header'|'full'|'first'){
 const [row]=await connection<{failure:string|null}[]>`select app.bulk_job_seal_verify(${c.job.id}::uuid,${mode}) as failure`;
 if(row?.failure)throw new BulkJobIntegrityError(row.failure);
}
/** One transaction on the queue-owner connection, attributed to the job (app.bulk_job with its lease capability, 5014)
 * and labelled for lock attribution. Refuses unless this worker still holds the lease. */
async function ownerTransaction<T>(connection:postgres.ReservedSql,c:Claimed,phase:string,fn:(owner:postgres.ReservedSql)=>Promise<T>,readOnly=false):Promise<T>{
 if(c.ownerOpen)throw new Error('Bulk job owner transactions do not nest.');
 c.ownerOpen=true;
 const started=performance.now();
 try{
  await (readOnly?connection`begin read only`:connection`begin`);
  try{
   await connection`select set_config('app.bulk_job',${c.job.id},true),set_config('app.bulk_job_capability',${c.capability},true),
     set_config('application_name',${`aihr-bulk:${c.job.kind}:${phase}`},true)`;
   const [held]=await connection<{ok:boolean}[]>`select app.bulk_job_capability_held(${c.job.id}::uuid) as ok`;
   if(!held?.ok)throw new LeaseLost();
   const out=await fn(connection);
   await connection`commit`;
   return out;
  }catch(error){await connection`rollback`.catch(()=>undefined);throw error;}
 }finally{
  c.ownerOpen=false;
  const ms=performance.now()-started;c.metrics[`${phase}OwnerTxMs`]=Math.max(c.metrics[`${phase}OwnerTxMs`]??0,Math.round(ms));
 }
}
function unitOf(connection:postgres.ReservedSql,c:Claimed):BulkJobUnit{
 return{
  metric:(name,value)=>{c.metrics[name]=Math.max(c.metrics[name]??0,Math.round(value));},
  fenceTx:async tx=>{
   // Binds the transaction to this claim's capability and locks the job row while the lease is ours. Row security
   // hides the job once the creator's captured grants are no longer current: that is lost authority, a real failure.
   const [row]=await tx.execute<{fence:string}>(sql`select app.bulk_job_fence(${c.job.id}::uuid,${c.capability}) as fence`);
   if(row?.fence==='held')return;
   if(row?.fence==='authority')throw new BulkJobAuthorityLost();
   throw new LeaseLost();
  },
  set:(runner,set)=>workerSet(runner,c.job.id,set),
  step:(runner,seqs,set)=>stepSet(runner,c.job.id,seqs,set),
  verifySeal:()=>verifySealOf(connection,c,'full'),
 };
}
/** App-role transaction under the creator's authority: labelled, fenced on the lease and timed through COMMIT. */
async function jobTx<T>(ctx:SessionContext,c:Claimed,unit:BulkJobUnit,phase:string,fn:(tx:Tx)=>Promise<T>):Promise<T>{
 const started=performance.now();
 const out=await withTenant(ctx,async tx=>{await label(tx,c.job.kind,phase);await unit.fenceTx(tx);return fn(tx);});
 const ms=performance.now()-started;unit.metric(`${phase}TxMs`,ms);report(c.job.kind,phase,ms,c.job.id);
 return out;
}

async function processClaimed(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed){
 const job=c.job;const unit=unitOf(connection,c);
 if(TERMINAL.includes(job.state))return notifyFinished(connection,c,job,handler);
 if(job.state==='discarding')return discardUnit(connection,handler,c,unit);
 let ctx:SessionContext;
 try{ctx=await bulkJobContext(connection,job);}
 catch(error){
  if(isTransient(handler,error))return retryLater(connection,handler,c,error);
  return failJob(connection,handler,c,null,'The job stopped: your account or access could not be confirmed.',[],error);
 }
 if(job.cancel_requested_at&&['queued','preparing','running'].includes(job.state))return cancelJob(connection,handler,c,ctx);
 try{
  if(job.state==='queued'||job.state==='preparing')await prepareUnit(connection,handler,c,unit,ctx);
  else if(job.state==='running')await chunkUnit(connection,handler,c,unit,ctx);
  else if(job.state==='finalizing')await finalizeUnit(connection,handler,c,unit,ctx);
 }catch(raised){
  caches.delete(job.id); // a rolled-back chunk must not leave stale ids behind
  if(raised instanceof LeaseLost)return;
  if(isTransient(handler,raised))return retryLater(connection,handler,c,raised);
  // A seal mismatch raised by a definer is the same integrity failure as one found by verification.
  const error=pgSqlState(raised)===SEAL_MISMATCH?new BulkJobIntegrityError('step'):raised;
  const step=error instanceof BulkJobStepRefused?error.step:null;const cause=error instanceof BulkJobStepRefused?error.cause:error;
  const described:{error:string;errors?:BulkJobRowError[];planMerge?:Record<string,unknown>}=handler.describeFailure
   ?await ownerTransaction(connection,c,'describe',owner=>handler.describeFailure!(job,cause,step,owner),true).catch(()=>({error:publicErrorMessage(cause)}))
   :{error:publicErrorMessage(cause)};
  return failJob(connection,handler,c,ctx,described.error,described.errors??[],error,described.planMerge);
 }
}
const isTransient=(handler:BulkJobHandler,error:unknown)=>handler.isTransient?.(error)??isTransientBulkJobError(error);
async function retryLater(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,error:unknown){
 const [row]=await connection<{transient_retries:number}[]>`update bulk_job set transient_retries=transient_retries+1,
   not_before=now()+make_interval(secs=>least(5.0,0.05*power(2,least(transient_retries,7)))),updated_at=now()
  where id=${c.job.id}::uuid and lease_token=${c.token}::uuid returning transient_retries`;
 if((row?.transient_retries??0)<MAX_TRANSIENT_RETRIES)return;
 return failJob(connection,handler,c,null,'The job stopped: other work kept the system busy for too long. Try again later.',[],error);
}

/** Validate once; persist the ordered steps in batches with no tenant lock held; then one short transaction makes
 * them runnable together with the kind's own records. A crash before that commit simply prepares again. */
async function prepareUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit,ctx:SessionContext){
 const job=c.job;
 await connection`update bulk_job set lease_expires_at=now()+make_interval(secs=>${PREPARE_LEASE_SECONDS}) where id=${job.id}::uuid and lease_token=${c.token}::uuid`;
 // The input is what the creator admitted (sealed by app.bulk_job_enqueue); nothing else may have changed it.
 await verifySealOf(connection,c,'header');
 if(job.state==='queued')await jobTx(ctx,c,unit,'prepare',tx=>workerSet(tx,job.id,{state:'preparing',expectState:['queued']}));
 const started=performance.now();
 const prepared=await handler.prepare(ctx,job);
 unit.metric('prepareMs',performance.now()-started);
 if('refused' in prepared){
  await jobTx(ctx,c,unit,'prepare',async tx=>{
   const own=await handler.commitPrepareTx?.(tx,ctx,job,prepared);
   await workerSet(tx,job.id,{state:'failed',finished:true,error:prepared.refused.slice(0,4000),errors:(prepared.errors??[]).slice(0,2000),
    counters:prepared.counters??{},plan:own?.plan??prepared.plan??null,attemptId:own?.attemptId??null,...(prepared.companyIds?{companyIds:[...prepared.companyIds]}:{})});
  });
  return terminal(connection,handler,c,ctx);
 }
 const rows=prepared.steps.map((step,seq)=>({seq,kind:step.kind,row_num:step.rowNum??null,payload:step.payload}));
 for(let start=0;start===0||start<rows.length;start+=STEP_INSERT_BATCH){
  const batch=rows.slice(start,start+STEP_INSERT_BATCH);
  await jobTx(ctx,c,unit,'prepare',tx=>tx.execute(sql`select app.bulk_job_steps_put(${job.id}::uuid,${start===0},${JSON.stringify(batch)}::text::jsonb)`));
 }
 await jobTx(ctx,c,unit,'prepare',async tx=>{
  const own=await handler.commitPrepareTx?.(tx,ctx,job,prepared);
  const phase=rows.length?(handler.phaseOf?.(rows[0].kind)??null):(prepared.phase??null);
  await workerSet(tx,job.id,{state:rows.length?'running':handler.finalize?'finalizing':'completed',phase,stepsTotal:rows.length,stepsDone:0,
   counters:prepared.counters??{},plan:own?.plan??prepared.plan??null,attemptId:own?.attemptId??null,
   ...(prepared.companyIds?{companyIds:[...prepared.companyIds]}:{}),resetTransientRetries:true,finished:!rows.length&&!handler.finalize});
 });
 if(!rows.length&&!handler.finalize)await terminal(connection,handler,c,ctx);
}

/** One chunk: about chunkBudgetMs of steps, each step's write and its applied marker in the same transaction. */
async function chunkUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit,ctx:SessionContext){
 const job=c.job;const budget=handler.chunkBudgetMs??250;const max=handler.maxStepsPerChunk??64;
 const cache=cacheOf(job.id);
 let lockedAt=0;
 const result=await jobTx(ctx,c,unit,'chunk',async tx=>{
  const started=performance.now();
  await handler.beginChunkTx?.(tx,ctx,job);
  lockedAt=performance.now(); // the kind's writer locks are held from here until COMMIT returns
  // The next pending steps, each verified against its seal before it is applied (the job row is locked by the fence).
  const steps=await tx.execute<BulkJobStep>(sql`select seq,kind,row_num,payload from app.bulk_job_pending_steps(${job.id}::uuid,${max})`);
  if(!steps.length){
   await workerSet(tx,job.id,{state:handler.finalize?'finalizing':'completed',expectState:['running'],finished:!handler.finalize});
   return{count:0,done:true,ms:performance.now()-started};
  }
  let count=0,counters:Record<string,number>={};const failures:BulkJobRowError[]=[];let kind=steps[0].kind;
  for(const step of steps){
   if(count>0&&performance.now()-started>=budget)break;
   kind=step.kind;
   if(handler.mode==='atomic'){
    let outcome:BulkJobStepOutcome;
    try{outcome=await handler.applyStepTx(tx,ctx,job,step,cache);}
    catch(error){if(isTransient(handler,error))throw error;throw new BulkJobStepRefused(step,error);}
    await stepSet(tx,job.id,step.seq,{state:'applied',result:outcome?.result??null});
    counters=merge(counters,outcome?.counters);
   }else{
    let outcome:BulkJobStepOutcome=undefined,refused:unknown=null,failed=false;
    try{outcome=await tx.transaction(async savepoint=>handler.applyStepTx(savepoint,ctx,job,step,cache));}
    catch(error){
     if(isTransient(handler,error)&&!(count===0&&handler.transientStepLimit!==undefined&&job.transient_retries>=handler.transientStepLimit))throw error;
     refused=error;failed=true;
    }
    if(failed){
     const message=publicErrorMessage(refused).slice(0,1000);
     await stepSet(tx,job.id,step.seq,{state:'failed',error:message});
     failures.push({rowNum:step.row_num??0,ref:handler.stepRef?.(step)??'',message});counters=merge(counters,{failed:1});
    }else{
     await stepSet(tx,job.id,step.seq,{state:'applied',result:outcome?.result??null});
     counters=merge(counters,outcome?.counters);
    }
   }
   count++;
  }
  const ms=performance.now()-started;
  await workerSet(tx,job.id,{stepsDoneAdd:count,phase:handler.phaseOf?.(kind)??job.phase,countersAdd:counters,errorsAppend:failures,resetTransientRetries:true});
  return{count,done:false,ms};
 });
 if(result.done)caches.delete(job.id);
 else{unit.metric('chunks',(Number(job.metrics?.chunks)||0)+1);unit.metric('maxChunkMs',result.ms);unit.metric('chunkHoldMs',performance.now()-lockedAt);}
 if(result.done&&!handler.finalize)await terminal(connection,handler,c,ctx);
}

async function finalizeUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit,ctx:SessionContext){
 const job=c.job;
 // What finalize and release trust: the plan and input every unit, every step before the first unit after a step write.
 await verifySealOf(connection,c,'first');
 let finalizeUnitOf:BulkJobUnit=unit;
 if(handler.finalizeOwner){
  const [kind]=await connection<{finalize_owner:boolean}[]>`select finalize_owner from bulk_job_kind where kind=${job.kind}`;
  if(!kind?.finalize_owner)throw new BulkJobConfigurationError(`Bulk job kind ${job.kind} declares an owner finalize that its bulk_job_kind row does not grant.`);
  finalizeUnitOf={...unit,ownerTx:fn=>ownerTransaction(connection,c,'finalize',fn)};
 }
 const outcome=handler.finalize?await handler.finalize(ctx,job,finalizeUnitOf):{result:null};
 if(outcome==='more'){await connection`update bulk_job set updated_at=now(),transient_retries=0 where id=${job.id}::uuid and lease_token=${c.token}::uuid`;return;}
 await jobTx(ctx,c,unit,'finalize',tx=>workerSet(tx,job.id,{state:'completed',expectState:['finalizing'],finished:true,result:outcome.result??null,
  countersMerge:outcome.counters??{},resetTransientRetries:true}));
 await terminal(connection,handler,c,ctx);
}

async function cancelJob(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,ctx:SessionContext){
 if(handler.discard&&c.job.state!=='queued'){
  await connection`update bulk_job set state='discarding',outcome='cancelled',error=coalesce(error,'Stopped at your request.'),updated_at=now() where id=${c.job.id}::uuid and lease_token=${c.token}::uuid`;
  return;
 }
 await connection`update bulk_job set state='cancelled',error=coalesce(error,'Stopped at your request.'),finished_at=now(),updated_at=now() where id=${c.job.id}::uuid and lease_token=${c.token}::uuid`;
 return terminal(connection,handler,c,ctx);
}
async function failJob(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,ctx:SessionContext|null,message:string,errors:BulkJobRowError[],error:unknown,planMerge?:Record<string,unknown>){
 const discard=Boolean(handler.discard)&&(handler.onFailure?.(c.job,error)??(handler.mode==='atomic'?'discard':'fail'))==='discard';
 if(planMerge&&Object.keys(planMerge).length)await ownerTransaction(connection,c,'fail',owner=>workerSet(owner,c.job.id,{planMerge})).catch(()=>undefined);
 await connection`update bulk_job set state=${discard?'discarding':'failed'},outcome=${discard?'failed':null},error=${message.slice(0,4000)},
   errors=${JSON.stringify(errors.slice(0,2000))}::text::jsonb,updated_at=now(),finished_at=case when ${discard} then null else now() end
  where id=${c.job.id}::uuid and lease_token=${c.token}::uuid and state=any(${['queued','preparing','running','finalizing']})`;
 caches.delete(c.job.id);
 if(!discard)return terminal(connection,handler,c,ctx);
}
async function discardUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit){
 const job=c.job;
 const discardUnitOf:BulkJobDiscardUnit={metric:unit.metric,set:unit.set,step:unit.step,verifySeal:unit.verifySeal,ownerTx:fn=>ownerTransaction(connection,c,'discard',fn)};
 let outcome:'more'|'done';
 try{outcome=handler.discard?await handler.discard(job,discardUnitOf):'done';}
 catch(error){
  if(error instanceof LeaseLost)return;
  if(isTransient(handler,error)){await connection`update bulk_job set transient_retries=transient_retries+1,not_before=now()+make_interval(secs=>least(5.0,0.05*power(2,least(transient_retries,7)))),updated_at=now()
   where id=${job.id}::uuid and lease_token=${c.token}::uuid`;return;}
  throw error;
 }
 if(outcome==='more'){await connection`update bulk_job set updated_at=now() where id=${job.id}::uuid and lease_token=${c.token}::uuid`;return;}
 // The kind's afterTerminal still reads its inputs (Import History); the kernel clears them right after.
 await connection`update bulk_job set state=${job.outcome??'failed'},finished_at=now(),updated_at=now() where id=${job.id}::uuid and lease_token=${c.token}::uuid and state='discarding'`;
 caches.delete(job.id);
 let ctx:SessionContext|null=null;try{ctx=await bulkJobContext(connection,job);}catch{ctx=null;}
 return terminal(connection,handler,c,ctx);
}
/** After a terminal state commits: the kind's best-effort follow-up, then the creator's completion notice. */
async function terminal(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,ctx:SessionContext|null){
 const [fresh]=await connection<BulkJobRow[]>`select * from bulk_job where id=${c.job.id}::uuid`;
 if(!fresh||!TERMINAL.includes(fresh.state))return;
 caches.delete(fresh.id);
 let clearPlan=false;
 try{const after=await handler.afterTerminal?.(ctx,fresh) as {clearPlan?:boolean}|undefined;clearPlan=after?.clearPlan===true;}catch{/* best effort, as the synchronous imports were */}
 // Personal data the job no longer needs: the uploaded inputs and per-step payloads (outcomes stay on the job), and
 // the plan when the kind asks. The seal follows (5013).
 await connection`select app.bulk_job_clear_inputs(${fresh.id}::uuid,${clearPlan}::boolean)`;
 await notifyFinished(connection,c,fresh,handler);
}
/** The creator's in-app notice (registry event bulk-job.finished), appended under their own authority exactly once.
 * When their access is gone nobody else is told; the job row still shows the outcome to an authorized creator. */
async function notifyFinished(connection:postgres.ReservedSql,c:Claimed,job:BulkJobRow,handler?:BulkJobHandler){
 if(job.notified_at)return;
 let quiet=false;try{quiet=handler?.quietNotice?.(job)??false;}catch{quiet=false;}
 if(quiet){await connection`update bulk_job set notified_at=now() where id=${job.id}::uuid and notified_at is null`;return;}
 try{
  const ctx=await bulkJobContext(connection,job);
  const unit=unitOf(connection,c);
  const done=await withTenant(ctx,async tx=>{
   try{await unit.fenceTx(tx);}catch(error){if(error instanceof BulkJobAuthorityLost)return false;throw error;}
   const [row]=await tx.execute<{state:BulkJobState;notified_at:Date|null}>(sql`select state,notified_at from bulk_job where id=${job.id}::uuid`);
   if(!row)return false;
   if(row.notified_at)return true;
   const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'bulk-job',aggregateId:job.id,eventType:BULK_JOB_FINISHED_EVENT,actor:actorOf(ctx),
    payload:{kind:job.kind,outcome:row.state}},{returnId:true});
   await workerSet(tx,job.id,{noticeEventId:String(eventId)});
   return true;
  });
  if(done)return;
 }catch(error){if(error instanceof LeaseLost||isTransientBulkJobError(error))return; /* retried by a later tick while unnotified */}
 await connection`update bulk_job set notified_at=now() where id=${job.id}::uuid and notified_at is null`;
}
