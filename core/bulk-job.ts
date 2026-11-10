/** Shared background bulk-job kernel, web side (migrations 5011, 5013): admission, creator-scoped reads, cancellation
 * and worker readiness. No HR change happens here; core/bulk-job-worker.ts runs the job. A bulk operation's own module
 * checks its authority, then calls enqueueBulkJobTx in the same transaction. The application role only reads the
 * store: admission and cancel are definers (app.bulk_job_enqueue, app.bulk_job_request_cancel); a job's plan, steps
 * and outcome are written by the worker alone. */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import type {BulkJobProgress,BulkJobRowError,BulkJobState,BulkJobWorkerStatus} from '../lib/bulk-job';

export class BulkJobError extends Error{constructor(message:string,readonly status=400){super(message);this.name='BulkJobError';}}
/** Stable code, translated by the screen, for an admission refused because the kind's scope already runs a job. */
export const BULK_JOB_ALREADY_RUNNING='bulk-job-already-running';

export type BulkJobRow={
 id:string;tenant_id:string;kind:string;created_by:string;context:SessionContext;operation_key:string;exclusive_key:string;
 company_ids:string[];source_name:string;source_hash:string|null;source_bytes:number;source_content:Buffer|null;
 input:unknown;plan:unknown;attempt_id:string|null;state:BulkJobState;outcome:'failed'|'cancelled'|null;phase:string|null;
 steps_total:number;steps_done:number;counters:Record<string,number>;metrics:Record<string,number|string>;result:unknown;
 error:string|null;errors:BulkJobRowError[];cancel_requested_at:Date|null;transient_retries:number;not_before:Date|null;
 lease_token:string|null;lease_expires_at:Date|null;notice_event_id:string|null;notified_at:Date|null;settled_at:Date|null;
 created_at:Date;updated_at:Date;finished_at:Date|null;
 /** Last poll of the creator's progress screen (draft 5041), for BulkJobHandler.quietNotice. */
 watched_at?:Date|null;
};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const isBulkJobId=(id:string)=>uuid.test(id);
export function bulkJobId(id:string){if(!uuid.test(id))throw new BulkJobError('Job unavailable.',404);return id;}
/** Row-level security returns only the creator's own job while their captured grants remain current. Read only: the
 * application role holds no UPDATE on the store, so it cannot lock job rows either. */
export async function bulkJobTx(tx:Tx,id:string,opts:{kind?:string}={}):Promise<BulkJobRow>{
 const [row]=await tx.execute<BulkJobRow>(sql`select * from bulk_job where id=${bulkJobId(id)}::uuid ${opts.kind?sql`and kind=${opts.kind}`:sql``}`);
 if(!row)throw new BulkJobError('Job unavailable.',404);
 return row;
}
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
export function bulkJobProgress(row:BulkJobRow):BulkJobProgress{
 return{id:row.id,kind:row.kind,state:row.state,phase:row.phase,sourceName:row.source_name,stepsTotal:row.steps_total,stepsDone:row.steps_done,
  counters:row.counters??{},error:row.error,errors:row.errors??[],result:row.result??null,cancelRequested:row.cancel_requested_at!==null,
  createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!,finishedAt:iso(row.finished_at)};
}
/** What the web may give a job: its kind, idempotency key, companies, uploaded file and input. The input must match
 * the kind's declared shape (bulk_job_kind.input_shape, 5013). There is no admission plan: only the worker writes it. */
export type BulkJobAdmission={kind:string;operationKey?:string;companyIds?:readonly string[];source?:{name:string;content:Buffer};input?:unknown};
/** Admit a job inside the caller's transaction, after the kind's own permission checks, through app.bulk_job_enqueue
 * (the database checks the session's tenant and user, the kind, the companies and the input shape, and hashes the
 * file). A repeated operation key returns the existing job; a second active job in the kind's scope is refused with
 * BULK_JOB_ALREADY_RUNNING. */
export async function enqueueBulkJobTx(tx:Tx,ctx:SessionContext,admission:BulkJobAdmission):Promise<{row:BulkJobRow;existing:boolean}>{
 if(!ctx.userId)throw new BulkJobError('Sign in again to start this job.',401);
 const operationKey=admission.operationKey&&uuid.test(admission.operationKey)?admission.operationKey:randomUUID();
 const source=admission.source;
 const companies=[...new Set(admission.companyIds??[])];
 const [r]=await tx.execute<{admitted:{id?:string;existing?:boolean;refused?:'running'|'kind'}}>(sql`select app.bulk_job_enqueue(${admission.kind},${operationKey}::uuid,
  ${companies.length?sql`ARRAY[${sql.join(companies.map(id=>sql`${id}`),sql`, `)}]::uuid[]`:sql`'{}'::uuid[]`},
  ${(source?.name??'').slice(0,255)},${source?.content??null}::bytea,${admission.input===undefined?null:JSON.stringify(admission.input)}::text::jsonb) as admitted`);
 const admitted=r?.admitted;
 if(admitted?.refused==='kind')throw new BulkJobError('Job unavailable.',409);
 if(!admitted?.id)throw new BulkJobError(BULK_JOB_ALREADY_RUNNING,409);
 return{row:await bulkJobTx(tx,admitted.id),existing:admitted.existing===true};
}
export async function readBulkJob(ctx:SessionContext,id:string,kind?:string){return withTenant(ctx,tx=>bulkJobTx(tx,id,{kind}));}
/** The signed-in user's most recent jobs of one kind, newest first (a screen uses it to rejoin a running job). */
export async function listBulkJobsTx(tx:Tx,ctx:SessionContext,kind:string,limit=10):Promise<BulkJobRow[]>{
 return[...await tx.execute<BulkJobRow>(sql`select * from bulk_job where tenant_id=${ctx.tenantId}::uuid and created_by=${ctx.userId??null}::uuid and kind=${kind} order by created_at desc limit ${Math.min(Math.max(limit,1),50)}`)];
}
/** The creator asks a queued or running job to stop. The worker honours it before the next chunk: an all-or-nothing
 * kind discards what it staged; a per-row kind stops and keeps the rows already saved. Finalizing cannot be stopped. */
export async function requestBulkJobCancel(ctx:SessionContext,id:string,kind?:string):Promise<BulkJobRow>{
 return withTenant(ctx,async tx=>{
  const [r]=await tx.execute<{outcome:'requested'|'unavailable'|'final'}>(sql`select app.bulk_job_request_cancel(${bulkJobId(id)}::uuid,${kind??null}::text) as outcome`);
  if(r?.outcome==='final')throw new BulkJobError('This job can no longer be stopped.',409);
  if(r?.outcome!=='requested')throw new BulkJobError('Job unavailable.',404);
  return bulkJobTx(tx,id,{kind});
 });
}
/** The creator's progress screen polled the job: stamp it (migration 5041), never waiting on the worker's row lock.
 * The application role only reads the job store, so the stamp is a definer (app.bulk_job_mark_watched). */
export async function markBulkJobWatchedTx(tx:Tx,id:string){
 await tx.execute(sql`select app.bulk_job_mark_watched(${bulkJobId(id)}::uuid)`);
}
/** Whether the caller's own queued job waits behind an earlier active job of a 'tenant_queue' kind (draft 5041). */
export async function bulkJobWaitingTx(tx:Tx,id:string):Promise<boolean>{
 const [row]=await tx.execute<{waiting:boolean}>(sql`select app.bulk_job_waiting(${bulkJobId(id)}::uuid) as waiting`);
 return Boolean(row?.waiting);
}
/** Whether a live worker serves this kind (heartbeat within 90 s). Read through a definer; reveals no job data. */
export async function bulkJobWorkerStatusTx(tx:Tx,kind:string):Promise<BulkJobWorkerStatus>{
 const [row]=await tx.execute<{ready:boolean}>(sql`select app.bulk_job_worker_ready(${kind}) as ready`);
 return row?.ready?'running':'unavailable';
}
