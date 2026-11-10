/** Durable admission and creator-scoped progress for background section and register imports, as a client of the
 * shared bulk-job kernel (core/bulk-job.ts). No HR change happens in an HTTP request: Profile and Family files run
 * one row per step (core/section-import-worker.ts); Qualification and Emergency Contact files run all-or-nothing
 * (core/register-import-worker.ts). */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import type {BulkJobState} from '../lib/bulk-job';
import {isImportSection,type ImportSection,type SectionImportResult} from '../lib/import-sections';
import type {ImportRecord} from '../lib/import-schema';
import {isPersonnelRegisterKind} from '../lib/personnel-register-import';
import {REGISTER_IMPORT_KIND,SECTION_IMPORT_ALREADY_RUNNING,SECTION_IMPORT_KIND,SECTION_IMPORT_KINDS,type SectionImportJobProgress} from '../lib/section-import-job';
import {BULK_JOB_ALREADY_RUNNING,BulkJobError,bulkJobTx,bulkJobWorkerStatusTx,enqueueBulkJobTx,listBulkJobsTx,type BulkJobRow} from './bulk-job';
import {assertRegisterImportBounds} from './personnel-register-import';
import {importSourceName} from './import-history';

export class SectionImportJobError extends Error{constructor(message:string,readonly status=400){super(message);this.name='SectionImportJobError';}}
const kindOf=(section:ImportSection)=>isPersonnelRegisterKind(section)?REGISTER_IMPORT_KIND:SECTION_IMPORT_KIND;
type StoredPlan={section?:ImportSection;total?:number;result?:SectionImportResult};

/** The outcome the synchronous import returned, for any finished job: the job's own result once it completed, the
 * file refusal it stored, or (stopped early) what it saved and why it stopped. */
export function sectionImportJobResult(row:BulkJobRow):SectionImportResult|null{
 if(!['completed','failed','cancelled'].includes(row.state))return null;
 if(row.state==='completed'&&row.result)return row.result as SectionImportResult;
 const plan=(row.plan??{}) as StoredPlan;
 if(plan.result)return plan.result;
 const section=(plan.section??'profile') as ImportSection,total=Number(plan.total??row.counters?.total??0);
 const register=row.kind===REGISTER_IMPORT_KIND;
 const updated=register?0:Number(row.counters?.updated??0);
 const failed=register?[]:(row.errors??[]).map(e=>({rowNum:e.rowNum,employeeCode:e.ref,message:e.message}));
 return{section,updated,skipped:Math.max(0,total-updated-failed.length),failed,fileErrors:row.error?[row.error]:[],runId:null,...(register?{}:{warnings:[]})};
}
export function sectionImportProgress(row:BulkJobRow,worker:'running'|'unavailable'='running'):SectionImportJobProgress{
 const plan=(row.plan??{}) as StoredPlan;
 return{id:row.id,kind:row.kind,section:(plan.section??'profile') as ImportSection,sourceName:row.source_name,state:row.state as BulkJobState,
  stepsTotal:row.steps_total,stepsDone:row.steps_done,result:sectionImportJobResult(row),
  updatedAt:new Date(row.updated_at).toISOString(),createdAt:new Date(row.created_at).toISOString(),worker:row.state==='queued'?worker:'running'};
}
async function progressTx(tx:Tx,row:BulkJobRow){return sectionImportProgress(row,row.state==='queued'?await bulkJobWorkerStatusTx(tx,row.kind):'running');}
const kernelError=(error:unknown)=>{
 if(error instanceof BulkJobError)return new SectionImportJobError(error.message===BULK_JOB_ALREADY_RUNNING?SECTION_IMPORT_ALREADY_RUNNING:error.message==='Job unavailable.'?'Import unavailable.':error.message,error.status);
 return error;
};

/** Start a section or register import from the records the action parsed (the same CSV text the preview checked). The
 * request only admits the job, inside the same admin check the synchronous commit's action made; the worker
 * validates, writes and records history under the creator's freshly resolved authority. */
export async function createSectionImportJob(ctx:SessionContext,input:{section:string;records:ImportRecord[];fileName:string;csv:string;operationKey?:string}):Promise<{job:SectionImportJobProgress;existing:boolean}>{
 if(!ctx.userId)throw new SectionImportJobError('Sign in again to import this file.',401);
 if(!isImportSection(input.section)||input.section==='bank_statutory')throw new SectionImportJobError('Unknown import section.');
 const section=input.section;
 // The synchronous register commit refused an oversized file before anything else, with these words.
 if(isPersonnelRegisterKind(section))assertRegisterImportBounds(input.records);
 try{
  return await withTenant(ctx,async tx=>{
   const [admin]=await tx.execute<{ok:boolean}>(sql`select app.is_admin() as ok`);
   if(!admin?.ok)throw new SectionImportJobError('You do not have permission to import Personnel files.',403);
   const {row,existing}=await enqueueBulkJobTx(tx,ctx,{kind:kindOf(section),operationKey:input.operationKey,
    source:{name:importSourceName(input.fileName,`${section}.csv`),content:Buffer.from(input.csv,'utf8')},
    input:{section,records:input.records,fileName:input.fileName},plan:{section,total:input.records.length}});
   return{job:await progressTx(tx,row),existing};
  });
 }catch(error){throw kernelError(error);}
}
export async function getSectionImportJob(ctx:SessionContext,id:string){
 try{return await withTenant(ctx,async tx=>{
  const row=await bulkJobTx(tx,id);
  if(!(SECTION_IMPORT_KINDS as readonly string[]).includes(row.kind))throw new SectionImportJobError('Import unavailable.',404);
  return progressTx(tx,row);
 });}catch(error){throw kernelError(error);}
}
/** The signed-in user's most recent section and register imports, newest first (the screen rejoins a running one). */
export async function listSectionImportJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=[...await listBulkJobsTx(tx,ctx,SECTION_IMPORT_KIND,10),...await listBulkJobsTx(tx,ctx,REGISTER_IMPORT_KIND,10)]
  .sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()).slice(0,10);
 const out:SectionImportJobProgress[]=[];
 for(const row of rows)out.push(await progressTx(tx,row));
 return out;
});}
