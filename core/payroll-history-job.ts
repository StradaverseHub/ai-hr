/** Payroll history upload confirm and revert as staged all-or-nothing jobs on the shared bulk-job kernel
 * (core/bulk-job-worker.ts; draft migration 5055; ADR 2026-11-10-payroll-processing-job.md, "Payroll history upload").
 *
 * Each used to run as one transaction holding the tenant's history barrier and Access lock exclusively for the whole
 * file (105.6 s and 28.2 s at 2,994 employees), so every payroll calculation, payslip, report and letter of the
 * tenant waited. Now:
 *
 *   request   the web action checks the attempt and the caller's authority (a refusal is recorded as before) and
 *             admits a `payroll_history` job; nothing is written;
 *   prepare   the same checks and the whole re-plan in one read-only snapshot, no lock (set-wise reads, about 1 s at
 *             3,000 records), refused exactly when the single transaction refused; the job then opens the tenant's
 *             one stage (5055) and waits its turn while another history job holds it, never refusing;
 *   chunks    the rows the single transaction wrote (records, adoptions, payslips, snapshots, revisions; for a revert
 *             one revision per record), written by the same code in short transactions under the shared Access lock
 *             only; every row is registered to the stage and invisible to everyone else;
 *   release   one short transaction under the history and Access write locks: the same checks, every fact the plan
 *             read re-read and digested (unchanged digest = unchanged plan; a revert re-derives its eligibility
 *             set-wise), each group's period and run sequence allocated and its batch closed, the same history and
 *             audit events, and the stage released, which makes the whole attempt visible at once;
 *   settle    the stage's registry rows are cleared in bounded batches (no visible change).
 *
 * A refusal or failure discards: the queue owner deletes the staged rows nobody saw, and the attempt's failure record
 * (`failed` / `revert_failed` with the single transaction's reason) is written once, retried by the kernel.
 *
 * Hardened kernel (5013, 5014): the application role only reads the job store. The job's plan changes go through
 * unit.set in a transaction that called unit.fenceTx (or inside unit.ownerTx); owner work (the registry clean-up in
 * finalize, which is why the kind declares finalizeOwner / finalize_owner, and the discard) runs in unit.ownerTx,
 * one kernel-managed transaction attributed to the job.
 */
import {sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {bulkJobProgress,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,isBulkJobId,type BulkJobRow} from './bulk-job';
import {BulkJobAuthorityLost,BulkJobWaiting,isTransientBulkJobError,type BulkJobDiscardUnit,type BulkJobHandler,type BulkJobSettleUnit,type BulkJobPrepared,type BulkJobRefused,type BulkJobRunner,type BulkJobUnit} from './bulk-job-worker';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {
 PayrollHistoryRevisionError,checkPayrollHistoryConfirm,checkPayrollHistoryRevert,joinPayrollHistoryStageTx,openPayrollHistoryStageTx,payrollHistoryFailureReason,
 payrollHistoryStageBusyTx,planStagedPayrollHistoryConfirm,planStagedPayrollHistoryRevert,recheckStagedPayrollHistoryConfirm,recordPayrollHistoryFailureTx,
 releaseStagedPayrollHistoryConfirmTx,releaseStagedPayrollHistoryRevertTx,stageHistoryBatchTx,stageHistoryRevertTx,stageHistoryRowTx,
 type HistoryConfirmInput,type HistoryPlanFactKeys,type StagedHistoryGroup,type StagedHistoryRevertTarget,
} from './payroll-history-revisions';
import type {HistoryRevisionChange,HistoryRevisionPlan,HistoryRevisionRow} from '../lib/payroll-history-revisions';
import {PAYROLL_HISTORY_JOB_KIND,type PayrollHistoryJobStatus} from '../lib/payroll-history-job';

export {PAYROLL_HISTORY_JOB_KIND};
/** Rows the owner deletes or clears per transaction (discard, settle). */
const OWNER_BATCH=1000;
const chunkBudgetMs=()=>Math.max(1,Number(process.env.PAYROLL_HISTORY_CHUNK_BUDGET_MS??100));
/** Re-plans allowed after a changed digest before the release gives up (each must reproduce the validated plan). */
const MAX_RECHECKS=5;

type ConfirmJobInput={operation:'confirm'}&HistoryConfirmInput;
type RevertJobInput={operation:'revert';attemptId:string;previewHash:string};
type JobInput=ConfirmJobInput|RevertJobInput;
type ConfirmPlan={operation:'confirm';attemptId:string;input:HistoryConfirmInput;digest:string;factKeys:HistoryPlanFactKeys;groups:StagedHistoryGroup[];
 counts:HistoryRevisionPlan['counts'];skippedReplacements:number;importedRows:number;rechecks?:number;recheck?:boolean};
type RevertPlan={operation:'revert';attemptId:string;previewHash:string;restored:number;digest:string;volatile:Awaited<ReturnType<typeof planStagedPayrollHistoryRevert>>['volatile'];rechecks?:number;recheck?:boolean};
type CommonPlan={stageId:string;opened?:boolean;released?:boolean;settled?:boolean;failureRecorded?:boolean;alreadyCommitted?:Record<string,unknown>;result?:Record<string,unknown>};
type JobPlan=(ConfirmPlan|RevertPlan)&CommonPlan;
type Step={group:number}|{group:number;row:HistoryRevisionRow}|{target:StagedHistoryRevertTarget};
const planOf=(job:BulkJobRow)=>job.plan as JobPlan|null;
const inputOf=(job:BulkJobRow)=>job.input as JobInput|null;
/** The stage is the job itself: one stage per job, so its id is the job's id. */
const stageOf=(job:BulkJobRow)=>job.id;
/** The same request (attempt, preview and selection) is one operation: a repeated submit returns the job it started.
 * After that job failed or stopped, a new request starts a new job, as the single transaction ran again. */
const operationKey=(ctx:SessionContext,input:JobInput)=>{
 const h=createHash('sha256').update(JSON.stringify(['payroll-history',ctx.userId,input])).digest('hex');
 return`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-${(8|(parseInt(h[16],16)&3)).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
};
async function admitTx(tx:Tx,ctx:SessionContext,input:JobInput,companyIds:readonly string[]){
 let {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:PAYROLL_HISTORY_JOB_KIND,operationKey:operationKey(ctx,input),companyIds,input});
 if(existing&&(row.state==='failed'||row.state==='cancelled'))({row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:PAYROLL_HISTORY_JOB_KIND,companyIds,input}));
 return{jobId:row.id,existing};
}

export type PayrollHistoryJobRequest={jobId:string;existing:boolean}|{alreadyCommitted:true;result:Record<string,unknown>};
/** Web side of confirm: the single transaction's checks (a refusal records the failure and throws, as before), then
 * the job. An attempt already committed returns its result, as before. */
export async function requestPayrollHistoryConfirm(ctx:SessionContext,input:HistoryConfirmInput):Promise<PayrollHistoryJobRequest>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 const checked=await checkPayrollHistoryConfirm(ctx,input);
 if(checked.alreadyCommitted)return{alreadyCommitted:true,result:checked.result};
 return withTenant(ctx,async tx=>{
  return admitTx(tx,ctx,{operation:'confirm',...input} satisfies ConfirmJobInput,checked.companyIds);
 });
}
/** Web side of revert: authority and the attempt's state (a refusal records the failure and throws, as before). */
export async function requestPayrollHistoryRevert(ctx:SessionContext,attemptId:string,previewHash:string):Promise<{jobId:string;existing:boolean}>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 const checked=await checkPayrollHistoryRevert(ctx,attemptId,previewHash);
 return withTenant(ctx,async tx=>{
  return admitTx(tx,ctx,{operation:'revert',attemptId,previewHash} satisfies RevertJobInput,checked.companyIds);
 });
}
/** The creator's own job, for the screen's progress panel. */
export async function payrollHistoryJobStatus(ctx:SessionContext,jobId:string):Promise<PayrollHistoryJobStatus|null>{
 if(!isBulkJobId(jobId))return null;
 return withTenant(ctx,async tx=>{
  const job=await bulkJobTx(tx,jobId,{kind:PAYROLL_HISTORY_JOB_KIND}).catch(()=>null);
  if(!job)return null;
  const plan=planOf(job);
  return{job:bulkJobProgress(job),operation:(plan?.operation??inputOf(job)?.operation??'confirm') as 'confirm'|'revert',attemptId:plan?.attemptId??inputOf(job)?.attemptId??null,
   worker:await bulkJobWorkerStatusTx(tx,PAYROLL_HISTORY_JOB_KIND)};
 });
}

function refusedFrom(error:unknown,plan:Partial<JobPlan>):BulkJobRefused{
 return{refused:payrollHistoryFailureReason(error),plan};
}
export const payrollHistoryJobHandler:BulkJobHandler<Step>={
 kind:PAYROLL_HISTORY_JOB_KIND,
 mode:'atomic',
 maxStepsPerChunk:64,
 get chunkBudgetMs(){return chunkBudgetMs();},
 phaseOf:kind=>kind==='revert'?'reverting':'writing',
 async prepare(ctx,job):Promise<BulkJobPrepared|BulkJobRefused>{
  const input=inputOf(job)!;const stageId=stageOf(job);
  // The tenant's one stage: wait while another history job holds it (cheap check before re-planning).
  if(await withTenant(ctx,tx=>payrollHistoryStageBusyTx(tx,stageId)))throw new BulkJobWaiting();
  const base={stageId,attemptId:input.attemptId,operation:input.operation};
  try{
   if(input.operation==='confirm'){
    const {operation,...confirm}=input;void operation;
    const planned=await planStagedPayrollHistoryConfirm(ctx,confirm);
    if(planned.alreadyCommitted)return{steps:[],plan:{...base,input:confirm,alreadyCommitted:planned.result} as Partial<JobPlan>,phase:'committing'};
    const steps=[...planned.groups.map((_g,group)=>({kind:'batch',payload:{group}})),...planned.rows.map(({group,row})=>({kind:'row',rowNum:row.rowNums[0]??null,payload:{group,row}}))];
    // Each group's batch step first: a group's rows follow the batch they are written into.
    steps.sort((a,b)=>(a.payload.group-b.payload.group)||((a.kind==='batch'?0:1)-(b.kind==='batch'?0:1)));
    const plan:JobPlan={...base,operation:'confirm',input:confirm,digest:planned.digest,factKeys:planned.factKeys,groups:planned.groups,counts:planned.counts,
     skippedReplacements:planned.skippedReplacements,importedRows:planned.importedRows};
    return{steps,plan,counters:{records:planned.rows.length,groups:planned.groups.length},companyIds:planned.companyIds,phase:'writing'};
   }
   const planned=await planStagedPayrollHistoryRevert(ctx,input.attemptId,input.previewHash);
   const plan:JobPlan={...base,operation:'revert',previewHash:input.previewHash,restored:planned.targets.length,digest:planned.digest,volatile:planned.volatile};
   return{steps:planned.targets.map(target=>({kind:'revert',payload:{target}})),plan,counters:{records:planned.targets.length},companyIds:planned.companyIds,phase:'reverting'};
  }catch(error){
   if(error instanceof BulkJobWaiting||isTransientBulkJobError(error))throw error;
   return refusedFrom(error,base as Partial<JobPlan>);
  }
 },
 async commitPrepareTx(tx,_ctx,job,prepared){
  if('refused' in prepared)return;
  const plan=prepared.plan as JobPlan;
  if(plan.alreadyCommitted)return;
  // Opening the stage is what makes the job the tenant's one history writer; until then it waits.
  if(!await openPayrollHistoryStageTx(tx,plan.stageId,plan.attemptId,plan.operation))throw new BulkJobWaiting();
  return{plan:{...plan,opened:true}};
 },
 async beginChunkTx(tx,ctx,job){
  // The shared Access lock, as an ordinary payroll writer; the staged rows need no tenant-wide exclusive lock.
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  await joinPayrollHistoryStageTx(tx,stageOf(job));
 },
 async applyStepTx(tx,ctx,job,step,cache){
  const plan=planOf(job)!;
  if(step.kind==='revert')return{result:{change:await stageHistoryRevertTx(tx,ctx,plan.attemptId,(step.payload as {target:StagedHistoryRevertTarget}).target)}};
  const confirm=plan as ConfirmPlan&CommonPlan;
  const {group}=step.payload as {group:number};
  if(step.kind==='batch'){const batchId=await stageHistoryBatchTx(tx,ctx,plan.attemptId,confirm.groups[group]);cache.set('batch:'+group,batchId);return{result:{batchId}};}
  const batchId=(cache.get('batch:'+group) as string|undefined)??await stagedBatchTx(tx,job.id,group);
  cache.set('batch:'+group,batchId);
  return{result:{change:await stageHistoryRowTx(tx,ctx,plan.attemptId,batchId,(step.payload as {row:HistoryRevisionRow}).row)},counters:{written:1}};
 },
 // Finalize clears the released stage's registry rows on the queue-owner connection (unit.ownerTx); the kind's
 // bulk_job_kind row declares finalize_owner to match (5055).
 finalizeOwner:true,
 async finalize(ctx,job,unit){return finalizeHistory(ctx,job,unit);},
 async discard(job,unit){return discardHistory(job,unit);},
 // A failure after the release (only the registry clean-up can fail then) must not discard committed history.
 onFailure:job=>planOf(job)?.released?'fail':'discard',
 async describeFailure(_job,error){return{error:payrollHistoryFailureReason(error)};},
 // The attempt's failure record, written once (the kernel retries a settle that fails).
 async settle(ctx,job,unit){await recordFailureOnce(ctx,job,unit);},
};

async function stagedBatchTx(tx:Tx,jobId:string,group:number){
 const [row]=await tx.execute<{batch_id:string}>(sql`select result->>'batchId' as batch_id from bulk_job_step where job_id=${jobId}::uuid and kind='batch' and state='applied' and (payload->>'group')::int=${group}`);
 if(!row?.batch_id)throw new Error('Staged payroll history batch unavailable.');
 return row.batch_id;
}
const label=(tx:Tx,phase:string)=>tx.execute(sql`select set_config('application_name',${`aihr-bulk:${PAYROLL_HISTORY_JOB_KIND}:${phase}`},true)`);
/** Merges a patch into the job's plan through the kernel's sealed writer (the application role does not write the job
 * store). `runner` is an app-role transaction that already called unit.fenceTx, or the connection inside
 * unit.ownerTx. */
async function savePlan(unit:Pick<BulkJobUnit,'set'>,runner:BulkJobRunner,patch:Partial<JobPlan>){
 await unit.set(runner,{planMerge:patch as Record<string,unknown>});
}

/** Release, then settle the registry, in bounded units; each unit records itself on the plan in its own transaction,
 * so a unit that committed is never repeated after a restart. */
async function finalizeHistory(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit):Promise<'more'|{result:unknown}>{
 const plan=planOf(job)!;
 if(plan.alreadyCommitted)return{result:plan.alreadyCommitted};
 if(!plan.released){
  if(plan.operation==='revert'&&plan.recheck){
   // Something the revert depends on changed: re-derive the whole eligibility without locks; it must still hold.
   const started=performance.now();
   const fresh=await planStagedPayrollHistoryRevert(ctx,plan.attemptId,plan.previewHash);
   await withTenant(ctx,async tx=>{await label(tx,'recheck');await unit.fenceTx(tx);await savePlan(unit,tx,{digest:fresh.digest,volatile:fresh.volatile,recheck:false});});
   unit.metric('recheckMs',performance.now()-started);
   return'more';
  }
  if(plan.operation==='confirm'&&plan.recheck){
   // The digest changed: re-plan without locks; the plan must be the one the attempt was validated with.
   const started=performance.now();
   const fresh=await recheckStagedPayrollHistoryConfirm(ctx,plan.input);
   await withTenant(ctx,async tx=>{await label(tx,'recheck');await unit.fenceTx(tx);await savePlan(unit,tx,{digest:fresh.digest,factKeys:fresh.factKeys,recheck:false});});
   unit.metric('recheckMs',performance.now()-started);
   return'more';
  }
  // The release is decided from the plan and every step's result. The kernel verified the whole seal before the first
  // finalize unit after the last step write; a release that follows a recheck (or a retried unit) verifies it again.
  await unit.verifySeal();
  const started=performance.now();
  const outcome=await withTenant(ctx,async tx=>{
   await label(tx,'release');await unit.fenceTx(tx);
   const changes=(await tx.execute<{change:HistoryRevisionChange}>(sql`select result->'change' as change from bulk_job_step where job_id=${job.id}::uuid and kind in ('row','revert') and state='applied' order by seq`)).map(r=>r.change);
   if(plan.operation==='revert'){
    const result=await releaseStagedPayrollHistoryRevertTx(tx,ctx,{stageId:plan.stageId,id:plan.attemptId,expectedPreviewHash:plan.previewHash,changes,volatile:plan.volatile,digest:plan.digest});
    if(result==='recheck'){
     if((plan.rechecks??0)>=MAX_RECHECKS)throw new PayrollHistoryRevisionError('The revert preview changed. Review eligibility again before confirming.');
     await savePlan(unit,tx,{recheck:true,rechecks:(plan.rechecks??0)+1});
     return'recheck' as const;
    }
    await savePlan(unit,tx,{released:true,result});
    return'released' as const;
   }
   const batches=new Map((await tx.execute<{group:number;batch_id:string}>(sql`select (payload->>'group')::int as group,result->>'batchId' as batch_id from bulk_job_step where job_id=${job.id}::uuid and kind='batch' and state='applied'`)).map(r=>[r.group,r.batch_id]));
   const released=await releaseStagedPayrollHistoryConfirmTx(tx,ctx,{stageId:plan.stageId,input:plan.input,digest:plan.digest,factKeys:plan.factKeys,
    groups:plan.groups.map((group,i)=>({...group,batchId:batches.get(i)!})),changes,counts:plan.counts,skippedReplacements:plan.skippedReplacements});
   if(released==='recheck'){
    if((plan.rechecks??0)>=MAX_RECHECKS)throw new PayrollHistoryRevisionError('The source, master data, permissions or target revisions changed. Validate a new attempt.');
    await savePlan(unit,tx,{recheck:true,rechecks:(plan.rechecks??0)+1});
    return'recheck' as const;
   }
   await savePlan(unit,tx,{released:true,result:{attemptId:plan.attemptId,counts:plan.counts,changes:changes.length,skippedReplacements:plan.skippedReplacements,alreadyCommitted:false,importedRows:plan.importedRows}});
   return'released' as const;
  });
  unit.metric(outcome==='released'?'releaseTxMs':'releaseRecheckTxMs',performance.now()-started);
  return'more';
 }
 if(!plan.settled){
  // The registry rows of a released stage show nothing; clear them in bounded owner batches (one kernel-managed
  // owner transaction each, attributed to the job).
  const started=performance.now();
  const deleted=await unit.ownerTx!(async owner=>{
   const gone=await owner`delete from app.payroll_history_staged_row where (relation,row_id) in (select relation,row_id from app.payroll_history_staged_row where stage_id=${plan.stageId}::uuid limit ${OWNER_BATCH})`;
   return gone.count;
  });
  unit.metric('settleTxMs',performance.now()-started);
  if(deleted===OWNER_BATCH)return'more';
  await withTenant(ctx,async tx=>{await label(tx,'settle');await unit.fenceTx(tx);await savePlan(unit,tx,{settled:true});});
  return'more';
 }
 return{result:plan.result??null};
}

/** Owner-only: delete what an unreleased stage wrote, newest revisions first (a correction references its adoption),
 * then snapshots, payslips, records and batches, in bounded batches; then the stage is closed as discarded. Nobody
 * ever saw these rows, so the visible outcome is that of the old rolled-back transaction. */
async function discardHistory(job:BulkJobRow,unit:BulkJobDiscardUnit):Promise<'more'|'done'>{
 const stageId=stageOf(job);
 const started=performance.now();
 // One bounded transaction per unit, opened, attributed to the job and committed by the kernel (unit.ownerTx).
 const outcome=await unit.ownerTx(async owner=>{
  const [stage]=await owner<{state:string}[]>`select state from app.payroll_history_stage where stage_id=${stageId}::uuid for update`;
  if(!stage||stage.state!=='staged')return'done' as const;
  const staged=(relation:string)=>owner<{row_id:string}[]>`select row_id from app.payroll_history_staged_row where stage_id=${stageId}::uuid and relation=${relation} order by row_id limit ${OWNER_BATCH}`;
  const forget=(relation:string,list:string[])=>owner`delete from app.payroll_history_staged_row where relation=${relation} and row_id=any(${list}::uuid[])`;
  // Newest revisions first: a correction (ordinal 2) references the adoption (ordinal 1) it sets aside.
  const revisions=(await owner<{row_id:string}[]>`select r.row_id from app.payroll_history_staged_row r join public.payroll_history_import_revision v on v.id=r.row_id
   where r.stage_id=${stageId}::uuid and r.relation='payroll_history_import_revision' order by v.ordinal desc,v.id limit ${OWNER_BATCH}`).map(r=>r.row_id);
  if(revisions.length){await owner`delete from public.payroll_history_import_revision where id=any(${revisions}::uuid[])`;await forget('payroll_history_import_revision',revisions);return'more' as const;}
  const snapshots=(await staged('payroll_history_import_snapshot')).map(r=>r.row_id);
  if(snapshots.length){await owner`delete from public.payroll_history_import_snapshot where id=any(${snapshots}::uuid[])`;await forget('payroll_history_import_snapshot',snapshots);return'more' as const;}
  const payslips=(await staged('payslip')).map(r=>r.row_id);
  if(payslips.length){await owner`delete from public.payslip where id=any(${payslips}::uuid[])`;await forget('payslip',payslips);return'more' as const;}
  const records=(await staged('payroll_history_import_record')).map(r=>r.row_id);
  if(records.length){await owner`delete from public.payroll_history_import_record where id=any(${records}::uuid[])`;await forget('payroll_history_import_record',records);return'more' as const;}
  const batches=(await staged('payroll_batch')).map(r=>r.row_id);
  if(batches.length){await owner`delete from public.payroll_batch where id=any(${batches}::uuid[])`;await forget('payroll_batch',batches);return'more' as const;}
  await owner`update app.payroll_history_stage set state='discarded' where stage_id=${stageId}::uuid`;
  return'done' as const;
 });
 unit.metric('discardTxMs',performance.now()-started);
 return outcome;
}

/** The failure record of a confirm or revert that did not commit: under the creator's authority, as the single
 * transaction wrote it. Nothing when it committed, or when the creator's access is gone (the single transaction's
 * recorder skipped an attempt its actor could no longer see).
 *
 * Exactly once: the record and the job's `failureRecorded` plan marker commit in one fenced app-role transaction
 * (unit.fenceTx locks the job row; unit.set writes the sealed marker), so a retried settle finds the marker. */
async function recordFailureOnce(ctx:SessionContext|null,job:BulkJobRow,unit:BulkJobSettleUnit){
 if(job.state==='completed'||!ctx)return;
 const plan=planOf(job),input=inputOf(job);
 if(plan?.failureRecorded||plan?.released)return;
 const attemptId=plan?.attemptId??input?.attemptId;const operation=plan?.operation??input?.operation;
 if(!attemptId||!operation)return;
 await withTenant(ctx,async tx=>{
  // The creator's access went between the kernel's context read and this transaction: nothing to record, as above.
  try{await unit.fenceTx(tx);}catch(error){if(error instanceof BulkJobAuthorityLost)return;throw error;}
  const [fresh]=await tx.execute<{plan:JobPlan|null}>(sql`select plan from bulk_job where id=${job.id}::uuid`);
  if(fresh?.plan?.failureRecorded)return;
  await recordPayrollHistoryFailureTx(tx,ctx,attemptId,operation==='revert'?'revert_failed':'failed',job.error??payrollHistoryFailureReason(null));
  await savePlan(unit,tx,{failureRecorded:true});
 });
}
