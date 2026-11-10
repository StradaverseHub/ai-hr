/** Shared background bulk-job kernel, worker side (migration 9003). The queue-owner connection only claims, leases,
 * coordinates and runs a kind's owner-only discard/settle routines. Every HR write runs through the app role under
 * the creator's freshly resolved authority, in short transactions that fence on the lease. A kind plugs in with a
 * BulkJobHandler (see the ADR section "Shared job kernel"). */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
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
/** Per-unit services the kernel gives a kind: lease fencing for its own transactions and timing records. */
export type BulkJobUnit={
 /** Inside an app-role transaction: refuses (rolls back) unless this worker still holds the job's lease. */
 fenceTx(tx:Tx):Promise<void>;
 /** Records the largest observed value of a named metric on the job (milliseconds by convention). */
 metric(name:string,value:number):void;
 /** The worker's queue-owner connection, for a kind's owner-only routines (discard, settle). */
 owner:postgres.ReservedSql;
};
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
 /** Called repeatedly in state 'finalizing' until it returns the result; each call must be one bounded unit. */
 finalize?(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit):Promise<'more'|BulkJobFinalized>;
 /** Owner-only undo of staged work in bounded batches ('more' until done). Required for 'atomic'. */
 discard?(job:BulkJobRow,unit:Omit<BulkJobUnit,'fenceTx'>):Promise<'more'|'done'>;
 /** On a non-transient failure: discard staged work (default for atomic kinds) or end as failed without discard. */
 onFailure?(job:BulkJobRow,error:unknown):'discard'|'fail';
 /** Text and row errors recorded for a failure (the owner connection may read the job's steps). Default: the
  *  public message of the error. */
 describeFailure?(job:BulkJobRow,error:unknown,step:BulkJobStep|null,owner:postgres.ReservedSql):Promise<{error:string;errors?:BulkJobRowError[]}>;
 /** Reference shown with a per-step refusal (for example an employee code or email); never IC, bank or salary. */
 stepRef?(step:BulkJobStep<P>):string;
 isTransient?(error:unknown):boolean;
 /** Best effort after the terminal state committed (history, post-commit refreshes). ctx is null when revoked. */
 afterTerminal?(ctx:SessionContext|null,job:BulkJobRow):Promise<void>;
};
export class BulkJobStepRefused extends Error{constructor(readonly step:BulkJobStep,readonly cause:unknown){super(publicErrorMessage(cause));this.name='BulkJobStepRefused';}}
class LeaseLost extends Error{constructor(){super('Bulk job lease lost.');}}
/** The creator can no longer act on the job (grants or company access changed). */
export class BulkJobAuthorityLost extends Error{constructor(){super('Your access to this job changed, so it was stopped.');this.name='BulkJobAuthorityLost';}}
const TERMINAL:readonly BulkJobState[]=['completed','failed','cancelled'];
const LEASE_SECONDS=60,PREPARE_LEASE_SECONDS=900,MAX_TRANSIENT_RETRIES=600,STEP_INSERT_BATCH=400;

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
type Claimed={job:BulkJobRow;token:string;metrics:Record<string,number>};
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
  let [job]=await connection<BulkJobRow[]>`update bulk_job set lease_token=${token}::uuid,lease_expires_at=now()+make_interval(secs=>${LEASE_SECONDS})
   where id=(select id from bulk_job where state in ('queued','preparing','running','finalizing','discarding') and kind=any(${kinds})
    and (lease_expires_at is null or lease_expires_at<now()) and (not_before is null or not_before<=now())
    order by updated_at,created_at limit 1 for update skip locked) returning *`;
  if(!job)[job]=await connection<BulkJobRow[]>`update bulk_job set lease_token=${token}::uuid,lease_expires_at=now()+make_interval(secs=>${LEASE_SECONDS})
   where id=(select id from bulk_job where notified_at is null and state in ('completed','failed','cancelled') and kind=any(${kinds})
    and finished_at>now()-interval '1 day' and (lease_expires_at is null or lease_expires_at<now()) and (not_before is null or not_before<=now())
    order by finished_at limit 1 for update skip locked) returning *`;
  if(!job)return false;
  const claimed:Claimed={job,token,metrics:{}};
  try{await withBackgroundDatabaseWork(()=>processClaimed(connection,handlers.get(job.kind)!,claimed));}
  finally{
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
function unitOf(connection:postgres.ReservedSql,c:Claimed):BulkJobUnit{
 return{
  owner:connection,
  metric:(name,value)=>{c.metrics[name]=Math.max(c.metrics[name]??0,Math.round(value));},
  fenceTx:async tx=>{
   const [row]=await tx.execute<{id:string}>(sql`select id from bulk_job where id=${c.job.id}::uuid and lease_token=${c.token}::uuid for update`);
   if(row)return;
   // Row security hides the job once the creator's captured grants are no longer current: that is lost authority,
   // a real failure, not a lost lease. Only the owner's view of the lease can tell the two apart.
   const [lease]=await connection<{held:boolean}[]>`select lease_token=${c.token}::uuid as held from bulk_job where id=${c.job.id}::uuid`;
   if(lease?.held)throw new BulkJobAuthorityLost();
   throw new LeaseLost();
  },
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
 if(TERMINAL.includes(job.state))return notifyFinished(connection,job);
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
 }catch(error){
  caches.delete(job.id); // a rolled-back chunk must not leave stale ids behind
  if(error instanceof LeaseLost)return;
  if(isTransient(handler,error))return retryLater(connection,handler,c,error);
  const step=error instanceof BulkJobStepRefused?error.step:null;const cause=error instanceof BulkJobStepRefused?error.cause:error;
  const described=handler.describeFailure?await handler.describeFailure(job,cause,step,connection):{error:publicErrorMessage(cause)};
  return failJob(connection,handler,c,ctx,described.error,described.errors??[],error);
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
 if(job.state==='queued')await jobTx(ctx,c,unit,'prepare',tx=>tx.execute(sql`update bulk_job set state='preparing',updated_at=now() where id=${job.id}::uuid and state='queued'`));
 const started=performance.now();
 const prepared=await handler.prepare(ctx,job);
 unit.metric('prepareMs',performance.now()-started);
 if('refused' in prepared){
  await jobTx(ctx,c,unit,'prepare',async tx=>{
   const own=await handler.commitPrepareTx?.(tx,ctx,job,prepared);
   await tx.execute(sql`update bulk_job set state='failed',finished_at=now(),updated_at=now(),error=${prepared.refused.slice(0,4000)},errors=${JSON.stringify((prepared.errors??[]).slice(0,2000))}::jsonb,
    counters=${JSON.stringify(prepared.counters??{})}::jsonb,plan=${JSON.stringify(own?.plan??prepared.plan??null)}::jsonb,attempt_id=${own?.attemptId??null}::uuid
    ${prepared.companyIds?sql`,company_ids=${pgUuidArray(prepared.companyIds)}`:sql``} where id=${job.id}::uuid`);
  });
  return terminal(connection,handler,c,ctx);
 }
 const rows=prepared.steps.map((step,seq)=>({seq,kind:step.kind,row_num:step.rowNum??null,payload:step.payload}));
 for(let start=0;start===0||start<rows.length;start+=STEP_INSERT_BATCH){
  const batch=rows.slice(start,start+STEP_INSERT_BATCH);
  await jobTx(ctx,c,unit,'prepare',async tx=>{
   if(start===0)await tx.execute(sql`delete from bulk_job_step where job_id=${job.id}::uuid`);
   if(batch.length)await tx.execute(sql`insert into bulk_job_step(job_id,tenant_id,seq,kind,row_num,payload)
    select ${job.id}::uuid,${ctx.tenantId}::uuid,x.seq,x.kind,x.row_num,x.payload from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) x(seq int,kind text,row_num int,payload jsonb)`);
  });
 }
 await jobTx(ctx,c,unit,'prepare',async tx=>{
  const own=await handler.commitPrepareTx?.(tx,ctx,job,prepared);
  const phase=rows.length?(handler.phaseOf?.(rows[0].kind)??null):(prepared.phase??null);
  await tx.execute(sql`update bulk_job set state=${rows.length?'running':handler.finalize?'finalizing':'completed'},phase=${phase},steps_total=${rows.length},steps_done=0,
   counters=${JSON.stringify(prepared.counters??{})}::jsonb,plan=${JSON.stringify(own?.plan??prepared.plan??null)}::jsonb,attempt_id=${own?.attemptId??null}::uuid,
   ${prepared.companyIds?sql`company_ids=${pgUuidArray(prepared.companyIds)},`:sql``}transient_retries=0,updated_at=now()
   ${!rows.length&&!handler.finalize?sql`,finished_at=now()`:sql``} where id=${job.id}::uuid`);
 });
 if(!rows.length&&!handler.finalize)await terminal(connection,handler,c,ctx);
}
const pgUuidArray=(ids:readonly string[])=>ids.length?sql`ARRAY[${sql.join(ids.map(i=>sql`${i}`),sql`, `)}]::uuid[]`:sql`'{}'::uuid[]`;

/** One chunk: about chunkBudgetMs of steps, each step's write and its applied marker in the same transaction. */
async function chunkUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit,ctx:SessionContext){
 const job=c.job;const budget=handler.chunkBudgetMs??250;const max=handler.maxStepsPerChunk??64;
 const cache=cacheOf(job.id);
 let lockedAt=0;
 const result=await jobTx(ctx,c,unit,'chunk',async tx=>{
  const started=performance.now();
  await handler.beginChunkTx?.(tx,ctx,job);
  lockedAt=performance.now(); // the kind's writer locks are held from here until COMMIT returns
  const steps=await tx.execute<BulkJobStep>(sql`select seq,kind,row_num,payload from bulk_job_step where job_id=${job.id}::uuid and state='pending' order by seq limit ${max} for update`);
  if(!steps.length){
   await tx.execute(sql`update bulk_job set state=${handler.finalize?'finalizing':'completed'},updated_at=now()${handler.finalize?sql``:sql`,finished_at=now()`} where id=${job.id}::uuid and state='running'`);
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
    await tx.execute(sql`update bulk_job_step set state='applied',result=${outcome?.result===undefined?null:JSON.stringify(outcome.result)}::jsonb where job_id=${job.id}::uuid and seq=${step.seq}`);
    counters=merge(counters,outcome?.counters);
   }else{
    try{
     const outcome=await tx.transaction(async savepoint=>handler.applyStepTx(savepoint,ctx,job,step,cache));
     await tx.execute(sql`update bulk_job_step set state='applied',result=${outcome?.result===undefined?null:JSON.stringify(outcome.result)}::jsonb where job_id=${job.id}::uuid and seq=${step.seq}`);
     counters=merge(counters,outcome?.counters);
    }catch(error){
     if(isTransient(handler,error)&&!(count===0&&handler.transientStepLimit!==undefined&&job.transient_retries>=handler.transientStepLimit))throw error;
     const message=publicErrorMessage(error).slice(0,1000);
     await tx.execute(sql`update bulk_job_step set state='failed',error=${message} where job_id=${job.id}::uuid and seq=${step.seq}`);
     failures.push({rowNum:step.row_num??0,ref:handler.stepRef?.(step)??'',message});counters=merge(counters,{failed:1});
    }
   }
   count++;
  }
  const ms=performance.now()-started;
  await tx.execute(sql`update bulk_job set steps_done=steps_done+${count},phase=${handler.phaseOf?.(kind)??job.phase},
   counters=(select coalesce(jsonb_object_agg(k,coalesce((counters->>k)::numeric,0)+coalesce((${JSON.stringify(counters)}::jsonb->>k)::numeric,0)),'{}'::jsonb)
    from (select jsonb_object_keys(counters) k union select jsonb_object_keys(${JSON.stringify(counters)}::jsonb)) keys),
   errors=case when jsonb_array_length(errors)<2000 then errors||${JSON.stringify(failures)}::jsonb else errors end,
   transient_retries=0,updated_at=now() where id=${job.id}::uuid`);
  return{count,done:false,ms};
 });
 if(result.done)caches.delete(job.id);
 else{unit.metric('chunks',(Number(job.metrics?.chunks)||0)+1);unit.metric('maxChunkMs',result.ms);unit.metric('chunkHoldMs',performance.now()-lockedAt);}
 if(result.done&&!handler.finalize)await terminal(connection,handler,c,ctx);
}

async function finalizeUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit,ctx:SessionContext){
 const job=c.job;
 const outcome=handler.finalize?await handler.finalize(ctx,job,unit):{result:null};
 if(outcome==='more'){await connection`update bulk_job set updated_at=now(),transient_retries=0 where id=${job.id}::uuid and lease_token=${c.token}::uuid`;return;}
 await jobTx(ctx,c,unit,'finalize',tx=>tx.execute(sql`update bulk_job set state='completed',finished_at=now(),updated_at=now(),result=${JSON.stringify(outcome.result??null)}::jsonb,
  counters=counters||${JSON.stringify(outcome.counters??{})}::jsonb,transient_retries=0 where id=${job.id}::uuid and state='finalizing'`));
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
async function failJob(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,ctx:SessionContext|null,message:string,errors:BulkJobRowError[],error:unknown){
 const discard=Boolean(handler.discard)&&(handler.onFailure?.(c.job,error)??(handler.mode==='atomic'?'discard':'fail'))==='discard';
 await connection`update bulk_job set state=${discard?'discarding':'failed'},outcome=${discard?'failed':null},error=${message.slice(0,4000)},
   errors=${JSON.stringify(errors.slice(0,2000))}::text::jsonb,updated_at=now(),finished_at=case when ${discard} then null else now() end
  where id=${c.job.id}::uuid and lease_token=${c.token}::uuid and state=any(${['queued','preparing','running','finalizing']})`;
 caches.delete(c.job.id);
 if(!discard)return terminal(connection,handler,c,ctx);
}
async function discardUnit(connection:postgres.ReservedSql,handler:BulkJobHandler,c:Claimed,unit:BulkJobUnit){
 const job=c.job;
 const outcome=handler.discard?await handler.discard(job,{owner:connection,metric:unit.metric}):'done';
 if(outcome==='more'){await connection`update bulk_job set updated_at=now() where id=${job.id}::uuid and lease_token=${c.token}::uuid`;return;}
 // The kind's afterTerminal still reads its inputs (Import History); each kind clears its own data.
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
 try{await handler.afterTerminal?.(ctx,fresh);}catch{/* best effort, as the synchronous imports were */}
 // Personal data the job no longer needs: the uploaded inputs and per-step payloads (outcomes stay on the job).
 await connection`update bulk_job set input=null,source_content=null where id=${fresh.id}::uuid`;
 await connection`delete from bulk_job_step where job_id=${fresh.id}::uuid`;
 await notifyFinished(connection,fresh);
}
/** The creator's in-app notice (registry event bulk-job.finished), appended under their own authority exactly once.
 * When their access is gone nobody else is told; the job row still shows the outcome to an authorized creator. */
async function notifyFinished(connection:postgres.ReservedSql,job:BulkJobRow){
 if(job.notified_at)return;
 try{
  const ctx=await bulkJobContext(connection,job);
  const done=await withTenant(ctx,async tx=>{
   const [row]=await tx.execute<{state:BulkJobState;notified_at:Date|null}>(sql`select state,notified_at from bulk_job where id=${job.id}::uuid for update`);
   if(!row)return false;
   if(row.notified_at)return true;
   const eventId=await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'bulk-job',aggregateId:job.id,eventType:BULK_JOB_FINISHED_EVENT,actor:actorOf(ctx),
    payload:{kind:job.kind,outcome:row.state}},{returnId:true});
   await tx.execute(sql`update bulk_job set notice_event_id=${eventId}::uuid,notified_at=now() where id=${job.id}::uuid`);
   return true;
  });
  if(done)return;
 }catch(error){if(isTransientBulkJobError(error))return; /* retried by a later tick while unnotified */}
 await connection`update bulk_job set notified_at=now() where id=${job.id}::uuid and notified_at is null`;
}
