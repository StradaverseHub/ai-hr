/** Personnel register imports (Qualifications, Emergency Contacts) as an ALL-OR-NOTHING client of the shared bulk-job
 * kernel (docs/adr/2026-11-10-register-section-import-jobs.md). A register file changes EXISTING records, so the staged-row
 * visibility of the employee import cannot hide it. Instead each chunk step runs the unchanged register writers for
 * one employee (the employment for qualifications, the person for contacts) inside a savepoint, CAPTURES exactly what
 * they wrote — that employee's register rows before and after, and the audit events — and rolls the savepoint back.
 * Nothing is visible until the release: one set-based statement (migration 5061), under the writers' own locks and
 * the creator's captured authority, that checks every captured employee is still the same, still maintainable and
 * unchanged since capture, then applies every captured row and event. An employee whose register changed meanwhile is captured again;
 * after a few rounds the import stops with nothing written. */
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {publicErrorMessage} from '../lib/public-error';
import {normalizeEmployeeCode} from '../lib/employee-code';
import type {ImportRecord} from '../lib/import-schema';
import type {PersonnelRegisterKind} from '../lib/personnel-register-import';
import type {SectionImportResult} from '../lib/import-sections';
import {REGISTER_IMPORT_KIND} from '../lib/section-import-job';
import {lockAccessConfigurationWriteTx} from './access-configuration-lock';
import {analyzeRegisterImportTx,loadSubjectsTx,validateRegisterImport,writeRegisterRowsTx,type RegisterResolvedRow,type RegisterSubject} from './personnel-register-import';
import {recordSectionRun} from './import-sections';
import type {BulkJobHandler,BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';

/** Writer work per chunk transaction: one employee's rows usually take a few milliseconds each. */
export const REGISTER_IMPORT_CHUNK_BUDGET_MS=Number(process.env.REGISTER_IMPORT_CHUNK_BUDGET_MS??100);
/** Release attempts before an import whose employees keep changing stops with nothing written. */
const MAX_RECAPTURE_ROUNDS=3;
export const REGISTER_IMPORT_CHANGED='No register rows were written. Personnel records changed while the import was running. Check the file again and import it once more.';

export type RegisterImportJobInput={section:PersonnelRegisterKind;records:ImportRecord[];fileName:string};
type SubjectRef={code:string;employmentId:string;personId:string};
/** One step = every row of one employee's register, in file order. */
export type RegisterStepPayload={key:string;rowNums:number[];subjects:SubjectRef[]};
type Row=Record<string,unknown>&{id:string};
type CapturedEvent={rowNum:number;aggregateType:string;aggregateId:string;eventType:string;actorType:string;actorId:string|null;subjectEmploymentId:string|null;payload:unknown};
/** What the writers did for one employee, rolled back and kept until the release. */
export type RegisterCapture={key:string;fingerprint:string;created:Row[];changed:{id:string;set:Record<string,unknown>}[];events:CapturedEvent[];rows:number;subjects:SubjectRef[]};
export type RegisterStoredPlan={section:PersonnelRegisterKind;total:number;rounds?:number;released?:boolean;updated?:number;result?:SectionImportResult};

const TABLES={
 qualification:{table:sql.raw('public.employee_qualification'),key:sql.raw('employment_id')},
 emergency:{table:sql.raw('public.person_emergency_contact'),key:sql.raw('person_id')},
} as const;
/** Columns a register writer never changes (the identity trigger refuses them); a capture that touched one is refused. */
const IDENTITY=['id','tenant_id','created_at','employment_id','person_id'];
const COLUMN=/^[a-z_][a-z0-9_]*$/;
const inputOf=(job:BulkJobRow)=>job.input as RegisterImportJobInput;
const planOf=(job:BulkJobRow)=>(job.plan??{}) as RegisterStoredPlan;
const keyOf=(kind:PersonnelRegisterKind,subject:RegisterSubject)=>kind==='qualification'?subject.employmentId!:subject.personId!;
export class RegisterImportStopped extends Error{constructor(message:string){super(message);this.name='RegisterImportStopped';}}
class CaptureRollback extends Error{constructor(readonly capture:RegisterCapture){super('register capture');}}
export function registerFailedResult(section:PersonnelRegisterKind,total:number,fileErrors:string[]):SectionImportResult{
 return{section,updated:0,skipped:total,failed:[],fileErrors,runId:null};
}

/** The employee's register rows as the creator's session sees them, and their fingerprint: every row's identity and
 * row version (xmin), so any later write to any of them, by anyone, changes it, whatever the session's time zone. The
 * release computes the same expression (migration 5061). */
async function registerRowsTx(tx:Tx,kind:PersonnelRegisterKind,key:string):Promise<Row[]>{
 const t=TABLES[kind];
 return(await tx.execute<{row:Row}>(sql`select to_jsonb(r) as row from ${t.table} r where r.${t.key}=${key}::uuid order by r.id`)).map(r=>r.row);
}
async function fingerprintsTx(tx:Tx,kind:PersonnelRegisterKind,keys:readonly string[]):Promise<Map<string,string>>{
 const t=TABLES[kind];
 if(!keys.length)return new Map();
 const rows=await tx.execute<{key:string;fp:string}>(sql`select k.key::text as key,(select md5(coalesce(string_agg(r.id::text||'@'||r.xmin::text,',' order by r.id),'')) from ${t.table} r where r.${t.key}=k.key) as fp
  from unnest(${`{${keys.join(',')}}`}::uuid[]) k(key)`);
 return new Map(rows.map(r=>[r.key,r.fp]));
}
function diffRows(before:Row[],after:Row[]){
 const prior=new Map(before.map(row=>[row.id,row]));
 const created:Row[]=[],changed:{id:string;set:Record<string,unknown>}[]=[];
 for(const row of after){
  const old=prior.get(row.id);
  if(!old){created.push(row);continue;}
  prior.delete(row.id);
  const set:Record<string,unknown>={};
  for(const column of Object.keys(row))if(JSON.stringify(row[column])!==JSON.stringify(old[column]))set[column]=row[column];
  if(!Object.keys(set).length)continue;
  if(Object.keys(set).some(column=>IDENTITY.includes(column)||!COLUMN.test(column)))throw new Error('A register writer changed a record identity.');
  changed.push({id:row.id,set});
 }
 if(prior.size)throw new Error('A register record disappeared during the import.');
 return{created,changed};
}

/** Run the unchanged register writers for one employee in a savepoint and keep only what they did. The savepoint's
 * app.import_attempt is a throwaway token, so the database stamps exactly the events these writers append. */
async function captureTx(tx:Tx,ctx:SessionContext,kind:PersonnelRegisterKind,key:string,resolved:RegisterResolvedRow[],rowNums:number[],subjects:SubjectRef[]):Promise<RegisterCapture>{
 const token=randomUUID();
 try{
  await tx.transaction(async savepoint=>{
   await savepoint.execute(sql`select set_config('app.import_attempt',${token},true)`);
   const fp=(await fingerprintsTx(savepoint,kind,[key])).get(key)!;
   const before=await registerRowsTx(savepoint,kind,key);
   await writeRegisterRowsTx(savepoint,ctx,kind,resolved);
   const after=await registerRowsTx(savepoint,kind,key);
   const events=await savepoint.execute<{aggregate_type:string;aggregate_id:string;event_type:string;actor_type:string;actor_id:string|null;subject_employment_id:string|null;payload:unknown}>(sql`
    select aggregate_type,aggregate_id,event_type,actor_type::text as actor_type,actor_id,subject_employment_id,payload from public.domain_event where import_pending_attempt_id=${token}::uuid order by sequence`);
   // Each register writer appends exactly one event, in file order: the n-th event belongs to the n-th row.
   if(events.length!==resolved.length)throw new Error('Register audit events could not be matched to their rows.');
   const {created,changed}=diffRows(before,after);
   throw new CaptureRollback({key,fingerprint:fp,created,changed,rows:resolved.length,subjects,
    events:events.map((e,i)=>({rowNum:rowNums[i],aggregateType:e.aggregate_type,aggregateId:e.aggregate_id,eventType:e.event_type,actorType:e.actor_type,actorId:e.actor_id,subjectEmploymentId:e.subject_employment_id,payload:e.payload}))});
  });
 }catch(error){if(error instanceof CaptureRollback)return error.capture;throw error;}
 throw new Error('Register capture did not complete.');
}

const sameSubjects=(refs:SubjectRef[],subjects:RegisterSubject[])=>refs.every(ref=>{
 const match=subjects.filter(s=>s.employeeCode===normalizeEmployeeCode(ref.code));
 return match.length===1&&match[0].valid&&match[0].employmentId===ref.employmentId&&match[0].personId===ref.personId;
});

/** The visibility flip, in one statement on the worker's queue-owner connection (migration 5061): under the creator's
 * captured session it re-checks the creator, every employee's identity, status and workforce maintain authority, the
 * tables' row security and every employee's register fingerprint, once per statement rather than once per row, then
 * applies every captured row and the writers' audit events in file order. Changed employees go back for a fresh
 * capture. A read-only organisation refuses first, through the creator's own transaction, as a write there would. */
async function release(ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,plan:RegisterStoredPlan){
 // The audit chain is armed exactly as the creator's own session arms it now (withTenant's decision), never from
 // anything stored on the job.
 const [chain]=await withTenant(ctx,async tx=>{
  await unit.fenceTx(tx);await tx.execute(sql`select pg_current_xact_id()`);
  return tx.execute<{chained:boolean}>(sql`select coalesce(current_setting('app.audit_hash_chain',true),'')='on' as chained`);
 });
 const started=performance.now();
 const [row]=await unit.owner<{r:{released:boolean;stale?:number[];updated?:number}}[]>`select app.register_import_release(${job.id}::uuid,${chain?.chained===true}) as r`;
 unit.metric('releaseTxMs',performance.now()-started);
 const out=row.r;
 if(out.released)return;
 const stale=out.stale??[];
 const rounds=(plan.rounds??0)+1;
 if(rounds>MAX_RECAPTURE_ROUNDS)throw new RegisterImportStopped(REGISTER_IMPORT_CHANGED);
 await withTenant(ctx,async tx=>{
  await unit.fenceTx(tx);
  await tx.execute(sql`update bulk_job_step set state='pending',result=null where job_id=${job.id}::uuid and seq=any(${`{${stale.join(',')}}`}::int[])`);
  await tx.execute(sql`update bulk_job set state='running',steps_done=steps_done-${stale.length},plan=${JSON.stringify({...plan,rounds})}::jsonb,updated_at=now() where id=${job.id}::uuid and state='finalizing'`);
 });
 unit.metric('recaptured',stale.length);
}

export const registerImportJobHandler:BulkJobHandler<RegisterStepPayload>={
 kind:REGISTER_IMPORT_KIND,
 mode:'atomic',
 chunkBudgetMs:REGISTER_IMPORT_CHUNK_BUDGET_MS,
 maxStepsPerChunk:16,
 phaseOf:()=>'registers',
 stepRef:step=>step.payload.subjects[0]?.code??'',
 /** The commit's whole-file analysis, on one snapshot with no tenant lock: any invalid row refuses the file. */
 async prepare(ctx,job){
  const {section,records}=inputOf(job);
  const {preview,resolved}=await validateRegisterImport(ctx,section,records);
  const plan:RegisterStoredPlan={section,total:records.length};
  if(preview.fileErrors.length)return{refused:preview.fileErrors.join(' '),counters:{total:records.length},plan:{...plan,result:registerFailedResult(section,records.length,preview.fileErrors)}};
  const groups=new Map<string,RegisterStepPayload>();
  for(const row of resolved){
   const s=row.subject!;const key=keyOf(section,s);
   const group=groups.get(key)??{key,rowNums:[],subjects:[]};
   group.rowNums.push(row.preview.rowNum);
   if(!group.subjects.some(ref=>ref.code===row.preview.employeeCode))group.subjects.push({code:row.preview.employeeCode,employmentId:s.employmentId!,personId:s.personId!});
   groups.set(key,group);
  }
  return{steps:[...groups.values()].map(g=>({kind:'subject',rowNum:g.rowNums[0],payload:g})),counters:{total:records.length},plan};
 },
 /** The register writers' first lock, as the synchronous commit took it. */
 async beginChunkTx(tx,ctx){await lockAccessConfigurationWriteTx(tx,ctx.tenantId);},
 /** Re-check this employee's rows exactly as the commit did (locked subjects, same analysis), then capture. */
 async applyStepTx(tx,ctx,job,step){
  const {section,records}=inputOf(job);
  const recs=step.payload.rowNums.map(n=>records[n-1]);
  const subjects=await loadSubjectsTx(tx,recs,true);
  const analyzed=await analyzeRegisterImportTx(tx,section,recs,{subjects});
  if(analyzed.preview.fileErrors.length)throw new RegisterImportStopped(analyzed.preview.fileErrors.join(' '));
  if(!sameSubjects(step.payload.subjects,subjects))throw new RegisterImportStopped(REGISTER_IMPORT_CHANGED);
  const capture=await captureTx(tx,ctx,section,step.payload.key,analyzed.resolved,step.payload.rowNums,step.payload.subjects);
  return{result:capture};
 },
 async finalize(ctx,job,unit){
  const plan=planOf(job);
  if(!plan.released){await release(ctx,job,unit,plan);return'more';}
  const {section,records,fileName}=inputOf(job);
  const updated=plan.updated??0;
  // The synchronous import's history row, best effort and only when something was written, exactly as before.
  const runId=updated>0?await recordSectionRun(ctx,{companyId:null,fileName,totalRows:records.length,updated,rejected:[],failed:[]}):null;
  const result:SectionImportResult={section,updated,skipped:records.length-updated,failed:[],fileErrors:[],runId};
  return{result,counters:{updated}};
 },
 /** Nothing is staged before the release, so a stopped import has nothing to undo. */
 async discard(){return'done';},
 async describeFailure(_job,error){
  if(error instanceof RegisterImportStopped)return{error:error.message};
  return{error:`No register rows were written. ${publicErrorMessage(error)}`};
 },
};
