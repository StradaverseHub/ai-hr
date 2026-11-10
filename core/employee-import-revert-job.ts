/** The employee import Revert (ADR-0155, ADR-0157) as a background job on the shared bulk-job kernel (draft migration
 * 9932; docs/adr/2026-11-10-register-section-import-jobs.md). The request only admits the job, inside the synchronous
 * revert's own checks. The worker reviews eligibility once without any lock (nothing is written), then performs the
 * whole revert in one short owner-run transaction that re-checks everything set-based under the revert's locks and
 * the creator's captured session: the same refusals, voids, audit events in the same order and Import History event. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {normalizeImportRevertReason} from '../lib/import-history';
import {publicErrorMessage} from '../lib/public-error';
import type {EmployeeImportRevertProgress} from '../lib/employee-import-revert';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import type {BulkJobHandler} from './bulk-job-worker';
import {ImportHistoryError,planImportRevert,recordImportFailure,type ImportRevertBlocker} from './import-history';
import {employeeFullRevertHandler} from './employee-import-history';

export const EMPLOYEE_IMPORT_REVERT_KIND='employee_import_revert';
type RevertInput={attemptId:string;previewHash:string;reason:string};
type RevertPlan={attemptId:string;confirmedEventId?:string;employmentIds?:string[];released?:boolean;restored?:number};
export type {EmployeeImportRevertProgress} from '../lib/employee-import-revert';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const inputOf=(job:BulkJobRow)=>job.input as RevertInput;
const planOf=(job:BulkJobRow)=>(job.plan??{}) as RevertPlan;
/** The synchronous revert's words for each refusal the release can return. */
const REFUSALS:Record<string,string>={
 access:'Access changed. Sign in again before continuing.',unavailable:'Import attempt unavailable.',
 maintain:'Reverting this import needs maintain permission for every company in it.',reverted:'This import has already been reverted.',
 unsaved:'This import was not saved, so there is nothing to revert.',changed:'What this revert would restore has changed. Review it again before confirming.',
};
const BLOCKED='This import cannot be reverted because some records changed after it.';
const blockersOf=(job:BulkJobRow):ImportRevertBlocker[]=>(job.errors??[]).map(e=>({itemId:'',label:e.ref,reason:e.message}));
/** A failure that is not one of the revert's own refusals: the screen shows its generic message, as before. */
const INTERNAL_FAILURE='employee-import-revert-failed';
export function employeeImportRevertProgress(row:BulkJobRow):EmployeeImportRevertProgress{
 const plan=planOf(row);
 return{id:row.id,state:row.state,attemptId:plan.attemptId??inputOf(row)?.attemptId??'',error:row.error===INTERNAL_FAILURE?null:row.error,blockers:blockersOf(row),restored:row.state==='completed'?(plan.restored??null):null};
}

/** Admission, with the synchronous revert's input checks and its first authority check, in its words. One revert per
 * person runs at a time (the kind is creator-exclusive); a second confirmation of a reverted import is refused by the
 * job's review in the synchronous words, and recorded as a failed revert as before. */
export async function createEmployeeImportRevertJob(ctx:SessionContext,attemptId:string,input:{previewHash:string;reason:string}):Promise<EmployeeImportRevertProgress>{
 if(!uuid.test(attemptId))throw new ImportHistoryError('Import attempt unavailable.');
 const reason=normalizeImportRevertReason(input.reason);if(!reason)throw new ImportHistoryError('Enter a reason for the revert (3 to 1,000 characters).');
 if(typeof input.previewHash!=='string'||!/^[0-9a-f]{64}$/.test(input.previewHash))throw new ImportHistoryError('Review what will be restored before confirming.');
 try{
  return await withTenant(ctx,async tx=>{
   const [principal]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);
   if(!principal?.ok)throw new ImportHistoryError('Access changed. Sign in again before continuing.');
   const [attempt]=await tx.execute<{kind:string;company_ids:string[]}>(sql`select kind,company_ids from import_attempt where id=${attemptId}::uuid`);
   if(!attempt||attempt.kind!=='employee_full')throw new ImportHistoryError('Import attempt unavailable.');
   const [covers]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${attemptId}::uuid,'maintain',true) as ok`);
   if(!covers?.ok)throw new ImportHistoryError('Reverting this import needs maintain permission for every company in it.');
   const {row}=await enqueueBulkJobTx(tx,ctx,{kind:EMPLOYEE_IMPORT_REVERT_KIND,companyIds:attempt.company_ids,
    input:{attemptId,previewHash:input.previewHash,reason} satisfies RevertInput,plan:{attemptId} satisfies RevertPlan});
   return employeeImportRevertProgress(row);
  });
 }catch(error){
  if(error instanceof BulkJobError)throw new ImportHistoryError(error.message===BULK_JOB_ALREADY_RUNNING?'Another revert you started is still running. Wait for it to finish.':'Import attempt unavailable.');
  throw error;
 }
}
export async function getEmployeeImportRevertJob(ctx:SessionContext,id:string){
 return withTenant(ctx,async tx=>employeeImportRevertProgress(await bulkJobTx(tx,id,{kind:EMPLOYEE_IMPORT_REVERT_KIND})));
}
/** The signed-in user's running revert of this attempt, if any (the history page rejoins it). */
export async function activeEmployeeImportRevertJob(ctx:SessionContext,attemptId:string){
 return withTenant(ctx,async tx=>{
  const rows=await listBulkJobsTx(tx,ctx,EMPLOYEE_IMPORT_REVERT_KIND,10);
  const row=rows.find(r=>planOf(r).attemptId===attemptId&&['queued','preparing','running','finalizing'].includes(r.state));
  return row?employeeImportRevertProgress(row):null;
 });
}

const toErrors=(blockers:ImportRevertBlocker[])=>blockers.slice(0,2000).map(b=>({rowNum:0,ref:b.label,message:b.reason}));
async function blockedError(ctx:SessionContext,attemptId:string){
 // A refusal at release names the blockers exactly as the synchronous revert did: a fresh review lists them.
 const plan=await planImportRevert(ctx,attemptId,employeeFullRevertHandler).catch(()=>null);
 return new ImportHistoryError(BLOCKED,plan?.blockers??[]);
}

export const employeeImportRevertJobHandler:BulkJobHandler<never>={
 kind:EMPLOYEE_IMPORT_REVERT_KIND,
 mode:'per-step',
 /** The synchronous revert's review without its locks: a refusal here writes nothing. */
 async prepare(ctx,job){
  const {attemptId,previewHash}=inputOf(job);
  try{
   const plan=await planImportRevert(ctx,attemptId,employeeFullRevertHandler);
   if(plan.blockers.length)return{refused:BLOCKED,errors:toErrors(plan.blockers),plan:{attemptId}};
   if(plan.previewHash!==previewHash)return{refused:REFUSALS.changed,plan:{attemptId}};
   const employmentIds=[...new Set(plan.items.map(i=>i.employmentId).filter((id):id is string=>!!id))].sort();
   return{steps:[],plan:{attemptId,confirmedEventId:plan.confirmedEventId,employmentIds} satisfies RevertPlan,counters:{items:plan.items.length}};
  }catch(error){
   if(error instanceof ImportHistoryError)return{refused:error.message,errors:toErrors(error.blockers),plan:{attemptId}};
   throw error;
  }
 },
 /** The revert: one owner-run statement (app.employee_import_revert_release) after the creator's own transaction has
  * confirmed the lease and that the organisation accepts writes. */
 async finalize(ctx,job,unit){
  const {attemptId}=inputOf(job);
  const [armed]=await withTenant(ctx,async tx=>{
   await unit.fenceTx(tx);await tx.execute(sql`select pg_current_xact_id()`);
   return tx.execute<{on:boolean}>(sql`select coalesce(current_setting('app.audit_hash_chain',true),'')='on' as on`);
  });
  const started=performance.now();
  const [row]=await unit.owner<{r:{released?:boolean;restored?:number;refused?:string}}[]>`select app.employee_import_revert_release(${job.id}::uuid,${armed?.on===true}) as r`;
  unit.metric('releaseTxMs',performance.now()-started);
  const out=row.r;
  if(out.refused==='blocked')throw await blockedError(ctx,attemptId);
  if(out.refused)throw new ImportHistoryError(REFUSALS[out.refused]??'The revert could not be completed. Nothing was changed.');
  return{result:{attemptId,restored:out.restored??0},counters:{restored:out.restored??0}};
 },
 async describeFailure(_job,error){
  if(error instanceof ImportHistoryError)return{error:error.message,errors:toErrors(error.blockers)};
  console.error('[import revert]',publicErrorMessage(error));
  return{error:INTERNAL_FAILURE};
 },
 /** The synchronous revert recorded a failed attempt as a revert_failed event, with its blockers (best effort). */
 async afterTerminal(ctx,job){
  if(job.state==='completed'||!ctx)return;
  const attemptId=planOf(job).attemptId??inputOf(job)?.attemptId;if(!attemptId)return;
  await recordImportFailure(ctx,attemptId,'employee_full','revert_failed',job.error===INTERNAL_FAILURE||!job.error?new Error('revert failed'):new ImportHistoryError(job.error,blockersOf(job)));
 },
};
