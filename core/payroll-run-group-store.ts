/**
 * The Payroll Process wizard's run group while its companies' runs process as background jobs (draft migration
 * 5052). The wizard used to generate every run inside the request and carry the finished outcomes on the redirect;
 * each run is now a payroll_process bulk job (core/payroll-processing-job.ts), so the group records, per company,
 * either a finished outcome (refused before any job, exactly as before) or the job it waits for. When the last job
 * finishes, the group is settled once: the same `CompanyOutcome`s the synchronous path built (succeeded with the
 * run's payslip and skip counts, or failed with the reason its error maps to), the same `summarize` header and, for
 * a multi-company run, the same `payroll-run-group.completed` event. Only the group's creator reads or settles it.
 */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import type postgres from 'postgres';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {bulkJobProgress,bulkJobWorkerStatusTx,isBulkJobId,type BulkJobRow} from './bulk-job';
import {summarize,type CompanyOutcome,type RunGroupReasonCode,type RunGroupResult} from './payroll-run-group-result';
import {PAYROLL_PROCESS_JOB_KIND} from '../lib/payroll-processing-job';
import type {BulkJobProgress,BulkJobWorkerStatus} from '../lib/bulk-job';

/** A company whose run is still being processed by its job. `failed` is what the synchronous path reported for
 * this company when its generation threw (the multi-company run reported 0 selected and no run; a resumed run kept
 * both). */
export type PendingCompanyOutcome={status:'processing';jobId:string;companyId:string;companyName:string;batchId:string;employeesSelected:number;
 failed:{employeesSelected:number;batchId?:string}};
export type StoredCompanyOutcome=CompanyOutcome|PendingCompanyOutcome;
export type RunGroupKind='run'|'resume';
/** What the result screen shows: the finished result, or each company's progress while any job runs. */
export type RunGroupView={id:string;kind:RunGroupKind;payPeriod:string;done:boolean;result:RunGroupResult|null;
 companies:{companyId:string;companyName:string;status:StoredCompanyOutcome['status'];job:BulkJobProgress|null}[];worker:BulkJobWorkerStatus};

type GroupRow={id:string;tenant_id:string;created_by:string;kind:RunGroupKind;pay_period:string;started_at:Date|string;company_ids:string[];outcomes:StoredCompanyOutcome[];
 sealed_at:Date|null;ended_at:Date|string|null;result:RunGroupResult|null;event_id:string|null};
type JobOutcomeRow=Pick<BulkJobRow,'id'|'state'|'result'|'plan'|'finished_at'>;
const pending=(o:StoredCompanyOutcome):o is PendingCompanyOutcome=>o.status==='processing';
const iso=(value:Date|string)=>new Date(value).toISOString();
const TERMINAL=new Set(['completed','failed','cancelled']);

/** The finished company outcome for a job, exactly as the synchronous path built it; null while it still runs. */
function finishedOutcome(o:PendingCompanyOutcome,job:JobOutcomeRow|undefined):CompanyOutcome|null{
 if(!job||!TERMINAL.has(job.state))return null;
 if(job.state==='completed'){
  const result=(job.result??{}) as {payslips?:number;skipped?:number};
  const payslips=typeof result.payslips==='number'?result.payslips:0,skipped=typeof result.skipped==='number'?result.skipped:0;
  return{companyId:o.companyId,companyName:o.companyName,status:'succeeded',batchId:o.batchId,employeesSelected:o.employeesSelected,employeesSucceeded:payslips,
   ...(skipped>0?{employeesSkipped:skipped}:{})};
 }
 const reason=((job.plan as {failureReason?:RunGroupReasonCode}|null)?.failureReason)??'SYSTEM_VALIDATION_ERROR';
 return{companyId:o.companyId,companyName:o.companyName,status:'failed',...(o.failed.batchId?{batchId:o.failed.batchId}:{}),
  employeesSelected:o.failed.employeesSelected,employeesSucceeded:0,reason};
}
async function jobsTx(tx:Tx,ids:string[]){
 if(!ids.length)return new Map<string,BulkJobRow>();
 const rows=await tx.execute<BulkJobRow>(sql`select * from bulk_job where kind=${PAYROLL_PROCESS_JOB_KIND} and id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)})`);
 return new Map(rows.map(r=>[r.id,r]));
}

type RunGroupEventInput={mode:'draft'|'process';payPeriod:string;startedAt:string;endedAt:string;requested:string[];result:RunGroupResult};
/** The run group's durable audit record (unchanged shape: the synchronous run appended it after its loop). */
export async function appendRunGroupEventTx(tx:Tx,ctx:SessionContext,p:RunGroupEventInput){
 return appendEvent(tx,{
  tenantId:ctx.tenantId,
  aggregateType:'payroll-run-group',
  // Phase 1 has no persisted run-group row (see plan §"Run-group record"); the durable record is this
  // event. domain_event.aggregate_id is UUID-typed, so mint a synthetic id for the virtual run-group and
  // carry the human-addressable "<period>:<startedAt>" key in the payload as `runKey`.
  aggregateId:randomUUID(),
  eventType:runGroupEventType(p),
  actor:actorOf(ctx),
  payload:runGroupEventPayload(p),
 },{returnId:true});
}
const runGroupEventType=(p:Pick<RunGroupEventInput,'mode'>)=>p.mode==='draft'?'payroll-run-group.drafts-saved':'payroll-run-group.completed';
function runGroupEventPayload(p:RunGroupEventInput){
 const perCompany=p.result.perCompany;
 return{
   ...(p.mode==='draft'?{mode:'draft'}:{}),
   runKey:`${p.payPeriod}:${p.startedAt}`,
   payPeriod:p.payPeriod,
   companyIds:p.requested,
   startedAt:p.startedAt,
   endedAt:p.endedAt,
   overallStatus:p.result.overallStatus,
   perCompany:perCompany.map(c=>({
    companyId:c.companyId,
    batchId:c.batchId??null,
    status:c.status,
    reason:c.reason??null,
    employeesSelected:c.employeesSelected,
    employeesSucceeded:c.employeesSucceeded,
    // r226 — the run-group event is the DURABLE record, so the skip has to be inspectable here too. A COUNT
    // only: the per-employee ids and reasons are on each batch's own `payroll-batch.processed` event.
    employeesSkipped:c.employeesSkipped??0,
   })),
 };
}

/** The settled result of a group whose every company has a finished outcome, or null while a job still runs. */
function settlement(g:GroupRow,jobs:Map<string,JobOutcomeRow>):{result:RunGroupResult;event:RunGroupEventInput|null}|null{
 const resolved:CompanyOutcome[]=[];
 for(const o of g.outcomes){const out=pending(o)?finishedOutcome(o,jobs.get(o.jobId)):o;if(!out)return null;resolved.push(out);}
 const startedAt=iso(g.started_at),endedAt=new Date().toISOString();
 const result=summarize(g.pay_period,startedAt,endedAt,resolved);
 return{result,event:g.kind==='run'?{mode:'process',payPeriod:g.pay_period,startedAt,endedAt,requested:g.company_ids,result}:null};
}

/** The key a run group's web-side settle and a finishing job's settle meet on, one per job. The application role only
 * reads the job store (5013), so it cannot hold a job's row FOR SHARE while it decides; an advisory key needs no
 * privilege on the store and never blocks the worker's own writes to the job. */
const jobSettleKey=(tenantId:string,jobId:string)=>`${tenantId}:payroll-run-group-job:${jobId}`;

/** Settle the group once every company has a finished outcome: the result and, for a multi-company run, its
 * event. Under the group's row lock, so the action and every finishing job can race to it safely; a settled group
 * is never settled again. Each waited job's settle key is taken shared before the jobs are read, and a job's own
 * settle (below) takes its key exclusively before it looks for groups: a job whose terminal state has not committed
 * yet then settles after this transaction, so it finds this group; one whose settle already ran is read here as
 * finished. The group row is this transaction's own insert, which no other session can wait on, so the two orders
 * cannot deadlock. */
async function settleTx(tx:Tx,ctx:SessionContext,id:string){
 const [g]=await tx.execute<GroupRow>(sql`select * from payroll_run_group where id=${id}::uuid for update`);
 if(!g||g.ended_at||!g.sealed_at)return;
 const ids=g.outcomes.filter(pending).map(o=>o.jobId);
 for(const jobId of [...new Set(ids)].sort())await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${jobSettleKey(g.tenant_id,jobId)},0))`);
 const jobs=await jobsTx(tx,ids);
 const settled=settlement(g,jobs);
 if(!settled)return;
 const eventId=settled.event?await appendRunGroupEventTx(tx,ctx,settled.event):null;
 await tx.execute(sql`update payroll_run_group set ended_at=${settled.result.endedAt}::timestamptz,result=${JSON.stringify(settled.result)}::jsonb,event_id=${eventId}::uuid where id=${id}::uuid`);
}

/** Record a run group once every company's outcome is known or admitted as a job, and settle it at once when no
 * job is left to wait for (a run refused for every company, or jobs that already finished). */
export async function recordRunGroup(ctx:SessionContext,p:{kind:RunGroupKind;payPeriod:string;startedAt:string;requested:string[];outcomes:StoredCompanyOutcome[]}):Promise<string>{
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{id:string}>(sql`insert into payroll_run_group(tenant_id,created_by,kind,pay_period,started_at,company_ids,outcomes,sealed_at)
   values(${ctx.tenantId}::uuid,${ctx.userId??null}::uuid,${p.kind},${p.payPeriod},${p.startedAt}::timestamptz,
    ${p.requested.length?sql`ARRAY[${sql.join(p.requested.map(id=>sql`${id}`),sql`, `)}]::uuid[]`:sql`'{}'::uuid[]`},${JSON.stringify(p.outcomes)}::jsonb,now()) returning id`);
  await settleTx(tx,ctx,row.id);
  return row.id;
 });
}

/** A processing job finished: settle every open group that waited for it. This is the job kind's settle
 * (core/bulk-job-worker.ts): the kernel retries it with backoff until it succeeds, so a failed settlement no longer
 * loses the group's result or its audit event, and it is idempotent (a settled group is skipped under its row lock).
 * It runs on the worker's queue-owner connection, so it does not depend on the creator's grants still matching the
 * ones captured when the run started (each job already re-checked them in its own units): the run group is the
 * run's own record, and its event carries the creator as actor, exactly as the synchronous run appended it.
 *
 * `owner` is the connection inside the transaction the caller opened: the kernel's unit.ownerTx for the job's settle
 * (one transaction attributed to the job, so the event also carries payload.bulkJob, migration 5014). No begin or
 * commit here. The job's settle key is taken first (see settleTx), so a group whose recording has not committed yet
 * is waited for and then found. */
export async function settleRunGroupsForJobTx(owner:postgres.ReservedSql,job:Pick<BulkJobRow,'id'|'tenant_id'|'created_by'>){
 await owner`select pg_advisory_xact_lock(hashtextextended(${jobSettleKey(job.tenant_id,job.id)},0))`;
 const groups=await owner<GroupRow[]>`select * from payroll_run_group where tenant_id=${job.tenant_id}::uuid and ended_at is null and sealed_at is not null
  and outcomes @> ${JSON.stringify([{jobId:job.id}])}::jsonb order by id for update`;
 for(const g of groups){
  const ids=g.outcomes.filter(pending).map(o=>o.jobId);
  const jobs=new Map((ids.length?await owner<JobOutcomeRow[]>`select id,state,result,plan,finished_at from bulk_job where tenant_id=${g.tenant_id}::uuid and id=any(${ids}::uuid[])`:[]).map(r=>[r.id,r]));
  const settled=settlement(g,jobs);
  if(!settled)continue;
  let eventId:string|null=null;
  if(settled.event){
   const [row]=await owner<{id:string}[]>`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
    values(${g.tenant_id}::uuid,'payroll-run-group',${randomUUID()}::uuid,${runGroupEventType(settled.event)},'user',${g.created_by}::uuid,
     ${JSON.stringify(runGroupEventPayload(settled.event))}::jsonb) returning id`;
   eventId=row.id;
  }
  await owner`update payroll_run_group set ended_at=${settled.result.endedAt}::timestamptz,result=${JSON.stringify(settled.result)}::jsonb,event_id=${eventId}::uuid where id=${g.id}::uuid`;
 }
}
/** The same settlement as its own transaction on a queue-owner connection, outside a job unit (a repair or a test
 * that settles a job again). A job's settle goes through unit.ownerTx and settleRunGroupsForJobTx instead. */
export async function settleRunGroupsForJob(owner:postgres.ReservedSql,job:Pick<BulkJobRow,'id'|'tenant_id'|'created_by'>){
 await owner`begin`;
 try{
  await settleRunGroupsForJobTx(owner,job);
  await owner`commit`;
 }catch(error){await owner`rollback`;throw error;}
}

/** The result screen's view of a group: the settled result, or (while a job runs) each company's job progress.
 * When every job has finished but the group is not settled yet, the same outcomes are derived for display. */
export async function readRunGroup(ctx:SessionContext,id:string):Promise<RunGroupView|null>{
 if(!isBulkJobId(id))return null;
 return withTenant(ctx,async tx=>{
  const [g]=await tx.execute<GroupRow>(sql`select * from payroll_run_group where id=${id}::uuid`);
  if(!g)return null;
  const worker=await bulkJobWorkerStatusTx(tx,PAYROLL_PROCESS_JOB_KIND);
  const jobs=g.result?new Map<string,BulkJobRow>():await jobsTx(tx,g.outcomes.filter(pending).map(o=>o.jobId));
  const companies=g.outcomes.map(o=>({companyId:o.companyId,companyName:o.companyName,status:o.status,job:pending(o)&&jobs.get(o.jobId)?bulkJobProgress(jobs.get(o.jobId)!):null}));
  if(g.result)return{id:g.id,kind:g.kind,payPeriod:g.pay_period,done:true,result:g.result,companies,worker};
  const resolved=g.outcomes.map(o=>pending(o)?finishedOutcome(o,jobs.get(o.jobId)):o);
  if(resolved.some(o=>o===null))return{id:g.id,kind:g.kind,payPeriod:g.pay_period,done:false,result:null,companies,worker};
  const finished=[...jobs.values()].map(j=>j.finished_at).filter((t):t is Date=>t!=null).map(t=>new Date(t).getTime());
  const endedAt=new Date(finished.length?Math.max(...finished):Date.now()).toISOString();
  return{id:g.id,kind:g.kind,payPeriod:g.pay_period,done:true,result:summarize(g.pay_period,iso(g.started_at),endedAt,resolved as CompanyOutcome[]),companies,worker};
 });
}
