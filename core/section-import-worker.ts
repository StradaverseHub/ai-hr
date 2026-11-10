/** Profile and Family section imports as a per-row client of the shared bulk-job kernel (docs/adr/2026-11-10-register-section-import-jobs.md). The synchronous commit already wrote one row per transaction and let other rows continue when one
 * was refused; the job keeps exactly that: one step per row, each step running the same row applier
 * (applySectionRowTx) as the synchronous commit, so the validation, writers, refusal messages, history row and audit
 * are unchanged. What moves is where it runs: off the web request, in short chunk transactions, with the row's
 * re-analysis narrowed to that row's own database checks. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {pgSqlState} from '../lib/db-error';
import type {ImportRecord} from '../lib/import-schema';
import type {ImportSection,SectionImportResult} from '../lib/import-sections';
import {SECTION_IMPORT_KIND} from '../lib/section-import-job';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {applySectionRowTx,planSectionImport,recordSectionRun,writeFailureMessage,type SectionRowNomination,type WriteStep} from './import-sections';
import {syncChildReliefFromFamily} from './dependents';
import {isTransientBulkJobError,type BulkJobHandler} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';

export const SECTION_IMPORT_CHUNK_BUDGET_MS=Number(process.env.SECTION_IMPORT_CHUNK_BUDGET_MS??100);
/** Child-relief refreshes per finalize unit (each is one short transaction of its own, as before). */
const RELIEF_BATCH=25;
export type SectionImportJobInput={section:ImportSection;records:ImportRecord[];fileName:string};
type Rejected={rowNum:number;employeeCode:string;employeeName:string;errors:string[]};
export type SectionStoredPlan={section:ImportSection;total?:number;companyId?:string|null;rejected?:Rejected[];reliefFrom?:number;warnings?:string[];result?:SectionImportResult};
type StepResult={wrote:boolean;personId:string;dependent:boolean};
const inputOf=(job:BulkJobRow)=>job.input as SectionImportJobInput;
const planOf=(job:BulkJobRow)=>(job.plan??{}) as SectionStoredPlan;
class SectionRowRefused extends Error{constructor(message:string){super(message);this.name='SectionRowRefused';}}

/** Persons earlier rows of this import wrote (the synchronous commit's appliedPeople), rebuilt after a restart. */
async function appliedPeople(tx:Tx,job:BulkJobRow,cache:Map<string,unknown>){
 let people=cache.get('applied') as Set<string>|undefined;
 if(people)return people;
 const rows=await tx.execute<{person_id:string}>(sql`select result->>'personId' as person_id from bulk_job_step where job_id=${job.id}::uuid and state='applied' and (result->>'wrote')::boolean`);
 people=new Set(rows.map(r=>r.person_id));cache.set('applied',people);return people;
}
const failedOf=(job:BulkJobRow)=>(job.errors??[]).map(e=>({rowNum:e.rowNum,employeeCode:e.ref,message:e.message}));

export const sectionImportJobHandler:BulkJobHandler<SectionRowNomination>={
 kind:SECTION_IMPORT_KIND,
 mode:'per-step',
 chunkBudgetMs:SECTION_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:16,
 // A row that stays busy for this many retries is reported as not saved and the file moves on.
 transientStepLimit:30,
 phaseOf:()=>'rows',
 stepRef:step=>step.payload.employeeCode,
 /** The commit's dry run, with no transaction or lock held. A whole-file refusal writes nothing, as before. */
 async prepare(ctx,job){
  const {section,records}=inputOf(job);
  const planned=await planSectionImport(ctx,section,records);
  const counters={total:planned.total};
  if(planned.fileErrors.length)return{refused:planned.fileErrors.join(' '),counters,
   plan:{section,result:{section,updated:0,skipped:planned.total,failed:[],fileErrors:planned.fileErrors,runId:null}} satisfies SectionStoredPlan};
  const plan:SectionStoredPlan={section,total:planned.total,companyId:planned.companyId,rejected:planned.rejected.filter(r=>r.errors.length)};
  return{steps:planned.nominations.map(n=>({kind:'row',rowNum:n.rowNum,payload:n})),counters,plan};
 },
 /** The row writers' locks, in the order each row transaction took them. */
 async beginChunkTx(tx,ctx){
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
 },
 async applyStepTx(tx,ctx,job,step,cache){
  const {section,records}=inputOf(job);
  const people=await appliedPeople(tx,job,cache);
  const progress:{current:WriteStep}={current:'person'};
  try{
   const out:StepResult=await applySectionRowTx(tx,ctx,{section,records},step.payload,{appliedPeople:people,step:progress});
   if(out.wrote)people.add(out.personId);
   return{result:out,counters:out.wrote?{updated:1}:{skipped:1}};
  }catch(error){
   // A busy lock or serialization refusal is retried by the kernel; it never becomes a failed row while it clears.
   if(isTransientBulkJobError(error))throw error;
   console.error(`[section-import] row ${step.payload.rowNum} (${step.payload.employeeCode}) failed at step "${progress.current}":`,pgSqlState(error)==='PN001'?'NRIC duplicate policy refusal':error);
   throw new SectionRowRefused(writeFailureMessage(progress.current,error));
  }
 },
 /** After the rows: the child-relief refreshes the synchronous commit ran after each saved Family row (bounded
 * batches, each its own transaction), then the history row and the same result. */
 async finalize(ctx,job){
  const plan=planOf(job);const {section,fileName}=inputOf(job);
  const from=plan.reliefFrom??0;
  const relief=await withTenant(ctx,tx=>tx.execute<{seq:number;row_num:number;person_id:string}>(sql`select seq,row_num,result->>'personId' as person_id from bulk_job_step
   where job_id=${job.id}::uuid and state='applied' and (result->>'wrote')::boolean and (result->>'dependent')::boolean and seq>=${from} order by seq limit ${RELIEF_BATCH}`));
  if(relief.length){
   const warnings=[...(plan.warnings??[])];
   for(const row of relief){try{await syncChildReliefFromFamily(ctx,row.person_id);}catch{warnings.push(`Row ${row.row_num} was saved; review the child-relief refresh on Personnel.`);}}
   await withTenant(ctx,tx=>tx.execute(sql`update bulk_job set plan=${JSON.stringify({...plan,reliefFrom:relief.at(-1)!.seq+1,warnings})}::jsonb,updated_at=now() where id=${job.id}::uuid`));
   return'more';
  }
  const updated=Number(job.counters?.updated??0);const failed=failedOf(job);const total=plan.total??0;
  const runId=await recordSectionRun(ctx,{companyId:plan.companyId??null,fileName,totalRows:total,updated,rejected:plan.rejected??[],failed});
  const result:SectionImportResult={section,updated,skipped:total-updated-failed.length,failed,fileErrors:[],warnings:plan.warnings??[],runId};
  return{result};
 },
 /** A job that stopped early (cancelled, or the creator's access changed) keeps the rows it saved, as each row was
 * its own commit; its history row records them. Best effort, as the synchronous history row was. */
 async afterTerminal(ctx,job){
  if(job.state==='completed'||!ctx)return;
  const plan=planOf(job);if(plan.result)return;
  const updated=Number(job.counters?.updated??0);
  if(!updated&&!(job.errors??[]).length)return;
  await recordSectionRun(ctx,{companyId:plan.companyId??null,fileName:inputOf(job)?.fileName??job.source_name,totalRows:plan.total??0,updated,rejected:plan.rejected??[],failed:failedOf(job)});
 },
};
