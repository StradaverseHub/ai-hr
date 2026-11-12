/** Recruitment slice 16 — the candidate import as a client of the shared bulk-job kernel (core/bulk-job-worker.ts; kind row in
 * 5217). Per-step: one step per file row, so a refused row is recorded and the rest continue (D-055); nothing is staged, and each
 * row becomes visible when its chunk commits. The chunk budget keeps every transaction short (a few dozen rows at most), so one
 * import never holds a lock long enough to slow anyone else's work. The rows' own writes run through the recruitment service
 * (packs/recruitment/service: importCandidateRowTx) under the importer's freshly resolved authority and the ordinary guards; the
 * job's own records go through the kernel (unit.set), never an UPDATE of the job store. The file and the per-row payloads are
 * cleared by the kernel when the job ends; the import record and its rows (ids, outcomes, codes) stay.
 *
 * Subtransactions: each row runs in the kernel's per-step savepoint plus the row's own savepoint (IMPORT_SAVEPOINTS_PER_ROW), so a
 * chunk of at most RECRUITMENT_IMPORT_MAX_ROWS_PER_CHUNK rows stays below PostgreSQL's 64 cached subtransactions per backend
 * (beyond which every snapshot in the database pays for the overflow).
 *
 * Errors: nothing this worker throws carries a database error's message or query parameters (a database message can quote the
 * values of the row it refused) — only the error's name and SQLSTATE, which the kernel needs to tell a retry from a refusal.
 */
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import {isTransientBulkJobError,type BulkJobHandler} from './bulk-job-worker';
import {CANDIDATE_IMPORT_KIND,RecruitmentError,finishCandidateImportTx,importCandidateRowTx,prepareCandidateImport,type CandidateImportJobInput,type ImportStep,type ImportStepPayload} from '../packs/recruitment/service';

/** Wall-clock row work per chunk before it commits; one row is a handful of indexed statements (about 5–20 ms). */
export const RECRUITMENT_IMPORT_CHUNK_BUDGET_MS=Number(process.env.RECRUITMENT_IMPORT_CHUNK_BUDGET_MS??200);
export const RECRUITMENT_IMPORT_MAX_ROWS_PER_CHUNK=25;
/** The kernel's per-step savepoint and the row's own (importCandidateRowTx). */
export const IMPORT_SAVEPOINTS_PER_ROW=2;
const inputOf=(input:unknown)=>input as CandidateImportJobInput;

/** A database error without its message or parameters: name and SQLSTATE only (the kernel reads `code` to retry or refuse). */
export class ImportWorkerDatabaseError extends Error{constructor(readonly code:string,name:string){super(`Recruitment import: ${name} ${code}`);this.name='ImportWorkerDatabaseError';}}
const scrub=(error:unknown):unknown=>{
 const code=pgSqlState(error);
 if(!code||error instanceof RecruitmentError)return error;
 console.error('recruitment import worker',error instanceof Error?error.name:typeof error,code);
 return new ImportWorkerDatabaseError(code,error instanceof Error?error.name:'Error');
};
async function scrubbed<T>(run:()=>Promise<T>):Promise<T>{try{return await run();}catch(error){throw scrub(error);}}
/** The chunk transaction each job's rows are in now (beginChunkTx), so per-chunk facts are read again in every chunk. */
const chunkOf=new Map<string,string>();

export const recruitmentCandidateImportJobHandler:BulkJobHandler<ImportStepPayload>={
 kind:CANDIDATE_IMPORT_KIND,
 mode:'per-step',
 chunkBudgetMs:RECRUITMENT_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:RECRUITMENT_IMPORT_MAX_ROWS_PER_CHUNK,
 // A row that keeps meeting lock or serialization refusals is recorded as refused and the file moves on.
 transientStepLimit:30,
 phaseOf:()=>'rows',
 isTransient:isTransientBulkJobError,
 // A row is referred to by its row number only (the kernel's errors list); never a name, e-mail or ID number.
 stepRef:()=>'',
 /** Read and check the file once, with no transaction held: every row becomes a step (bad rows as 'invalid' steps). */
 async prepare(ctx,job){
  const prepared=await scrubbed(()=>prepareCandidateImport(ctx,job));
  if('refused' in prepared)return{refused:prepared.refused};
  return{steps:prepared.steps.map(step=>({kind:step.kind,rowNum:step.rowNum,payload:step.payload})),counters:{rows:prepared.steps.length},phase:'rows'};
 },
 /** A new chunk transaction: the importer's administration and every other per-chunk fact are resolved again. */
 async beginChunkTx(_tx,_ctx,job){chunkOf.set(job.id,randomUUID());},
 async applyStepTx(tx,ctx,job,step,cache){
  const chunk=chunkOf.get(job.id)??'';
  if(cache.get('chunk')!==chunk){cache.clear();cache.set('chunk',chunk);}
  const input=inputOf(job.input);
  return scrubbed(()=>importCandidateRowTx(tx,ctx,{importId:job.id,companyId:input.companyId},{kind:step.kind as ImportStep['kind'],rowNum:step.row_num??0,payload:step.payload},cache));
 },
 /** The record's ending and one event with counts only, in one short transaction fenced on the lease (repeat-safe). */
 async finalize(ctx,job,unit){
  chunkOf.delete(job.id);
  const counters=await scrubbed(()=>withTenant(ctx,async tx=>{await unit.fenceTx(tx);return finishCandidateImportTx(tx,ctx,job.id,'completed');}));
  return{result:counters??null};
 },
 /** A job that stopped (cancelled or failed) records how it ended, under the importer's authority (best effort; settle ensures it). */
 async afterTerminal(ctx,job){
  chunkOf.delete(job.id);
  if(!ctx||job.state==='completed')return;
  await scrubbed(()=>withTenant(ctx,tx=>finishCandidateImportTx(tx,ctx,job.id,job.state==='cancelled'?'cancelled':'failed')));
 },
 /** Durable: whatever the importer may still do, the record reaches its ending and every refused step has its row (owner path,
  *  only for this job's record: app.recruitment_settle_candidate_import). Idempotent. */
 async settle(_ctx,job,unit){
  await scrubbed(()=>unit.ownerTx(owner=>owner`select app.recruitment_settle_candidate_import(${job.id}::uuid)`));
 },
};
