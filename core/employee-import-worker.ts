/** Queue coordinator and chunk executor for staged employee imports (design B, migration 9001).
 * The owner connection discovers/coordinates jobs and runs discard. HR writes ALWAYS use the app role under the
 * initiating user's fresh authority, in short chunk transactions. Nothing is visible until one activation. */
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {withBackgroundDatabaseWork} from '../db/workload';
import {DatabaseAdmissionError} from '../db/admission';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {publicErrorMessage} from '@/lib/public-error';
import {pgSqlState} from '../lib/db-error';
import {freshImportContext} from './bank-import-worker';
import {employeeJobTx,type EmployeeImportJobRow} from './employee-import-job';
import {parseEmployeeImportUpload,type EmployeeImportUploadInput} from './employee-import-upload';
import {applyEmployeeImportStepTx,assertEmployeeImportAuthorityTx,prepareEmployeeImportJobPlan,recordEmployeeImportAttemptTx,recordImportRun,type EmployeeImportPlanStep} from './import';
import {ImportHistoryError,recordImportEventTx,recordImportFailure} from './import-history';
import {LeaveDependencyUnavailable,lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {syncChildReliefFromFamily} from './dependents';
import type {AllocationImportPreview} from '../lib/cost-allocation-import';
import type {EmployeeImportPhase,EmployeeImportResultSummary,EmployeeImportRowError} from '../lib/employee-import-job';
import type {RowResult} from '../lib/import-schema';

export const EMPLOYEE_IMPORT_CHUNK_BUDGET_MS=Number(process.env.EMPLOYEE_IMPORT_CHUNK_BUDGET_MS??250);
const MAX_STEPS_PER_CHUNK=64;
const MAX_TRANSIENT_RETRIES=600;
type StoredPlan={allocationPreview?:AllocationImportPreview;rejected?:RowResult[];skipped?:number};
type Step={seq:number;kind:'employee'|'superior'|'register';row_num:number|null;state:string;payload:EmployeeImportPlanStep;employment_id:string|null;person_id:string|null};
type WorkerGlobal=typeof globalThis&{__aihrEmployeeImportChunk?:(ms:number,steps:number,jobId:string)=>void;__aihrEmployeeImportActivation?:(ms:number,jobId:string)=>void};

/** Transient database refusals retry the same chunk; a real row refusal fails the job. */
export function isTransientEmployeeImportError(error:unknown){
 if(error instanceof LeaveDependencyUnavailable)return error.reason==='busy';
 if(error instanceof DatabaseAdmissionError)return true;
 const code=pgSqlState(error);
 return code==='40P01'||code==='40001'||code==='55P03';
}
class StepRefused extends Error{constructor(readonly step:Pick<Step,'row_num'>&{email:string},cause:unknown){super(publicErrorMessage(cause));}}

function phaseOf(kind:Step['kind']):EmployeeImportPhase{return kind==='employee'?'employees':kind==='superior'?'superiors':'registers';}
const stepCaches=new Map<string,{employmentByIndex:Map<number,string>;registerSubjects:Map<string,{employmentId:string;personId:string}>;familyPersons:Set<string>}>();
async function stepCache(tx:Tx,jobId:string){
 let cache=stepCaches.get(jobId);if(cache)return cache;
 cache={employmentByIndex:new Map(),registerSubjects:new Map(),familyPersons:new Set()};
 const rows=await tx.execute<{payload:EmployeeImportPlanStep;employment_id:string;person_id:string}>(sql`select payload,employment_id,person_id from employee_import_step where job_id=${jobId}::uuid and kind='employee' and state='applied'`);
 for(const r of rows){if(r.payload.kind!=='employee')continue;cache.employmentByIndex.set(r.payload.index,r.employment_id);const code=r.payload.row.hire.employeeCode;if(code)cache.registerSubjects.set(code,{employmentId:r.employment_id,personId:r.person_id});if((r.payload.family?.length??0)>0)cache.familyPersons.add(r.person_id);}
 stepCaches.set(jobId,cache);return cache;
}

/** One bounded phase of one job. Exported for real DB recovery/concurrency tests. */
export function processEmployeeImportJob(ctx:SessionContext,id:string):Promise<void>{return withBackgroundDatabaseWork(()=>processPhase(ctx,id));}
async function processPhase(ctx:SessionContext,id:string):Promise<void>{
 const job=await withTenant(ctx,tx=>employeeJobTx(tx,id));
 if(job.state==='queued'||job.state==='validating')return validatePhase(ctx,job);
 if(job.state==='importing')return applyChunk(ctx,job);
 if(job.state==='activating')return activate(ctx,job);
}

/** Validate once with no tenant locks; persist the attempt, the plan and every step atomically, then start applying. */
async function validatePhase(ctx:SessionContext,job:EmployeeImportJobRow):Promise<void>{
 if(job.state==='queued')await withTenant(ctx,tx=>tx.execute(sql`update employee_import_job set state='validating',updated_at=now() where id=${job.id}::uuid and state='queued'`));
 const input=job.input as EmployeeImportUploadInput;
 const parsed=parseEmployeeImportUpload(input);
 const plan=await prepareEmployeeImportJobPlan(ctx,{companyId:job.company_id,records:parsed.records,dependentRecords:parsed.dependentRecords,registerRecords:parsed.registerRecords,allocationRecords:parsed.allocationRecords,allocationToken:input.allocationToken});
 const source={name:job.source_name,content:Buffer.from(job.source_content??Buffer.alloc(0)),operationKey:job.operation_key};
 await withTenant(ctx,async tx=>{
  const current=await employeeJobTx(tx,job.id,true);if(!['queued','validating'].includes(current.state))return;
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  await assertEmployeeImportAuthorityTx(tx,ctx,job.company_id,plan.companyIds);
  const {attemptId}=await recordEmployeeImportAttemptTx(tx,ctx,{companyId:job.company_id,records:parsed.records,fileName:input.fileName,source},plan.preview,plan.resolved);
  if(plan.fileErrors.length){
   const message=plan.fileErrors.join(' ');
   await tx.execute(sql`update employee_import_job set state='discarding',attempt_id=${attemptId}::uuid,company_ids=${pgUuidArray(plan.companyIds)},total=${plan.total},valid=${plan.valid},invalid=${plan.invalid},error=${message.slice(0,4000)},plan=${JSON.stringify({rejected:plan.rejected,skipped:plan.total-plan.valid})}::jsonb,updated_at=now() where id=${job.id}::uuid`);
   return;
  }
  const rows=plan.steps.map((step,seq)=>({seq,kind:step.kind,row_num:step.rowNum,payload:step}));
  for(let start=0;start<rows.length;start+=500)await tx.execute(sql`insert into employee_import_step(job_id,tenant_id,seq,kind,row_num,payload) select ${job.id}::uuid,${ctx.tenantId}::uuid,x.seq,x.kind,x.row_num,x.payload from jsonb_to_recordset(${JSON.stringify(rows.slice(start,start+500))}::jsonb) x(seq int,kind text,row_num int,payload jsonb)`);
  const stored:StoredPlan={allocationPreview:plan.allocationPreview,rejected:plan.rejected,skipped:plan.total-plan.valid};
  await tx.execute(sql`update employee_import_job set state='importing',phase=${rows.length?phaseOf(rows[0].kind):'activation'},attempt_id=${attemptId}::uuid,company_ids=${pgUuidArray(plan.companyIds)},total=${plan.total},valid=${plan.valid},invalid=${plan.invalid},steps_total=${rows.length},plan=${JSON.stringify(stored)}::jsonb,updated_at=now() where id=${job.id}::uuid`);
 });
}
const pgUuidArray=(ids:readonly string[])=>sql`ARRAY[${sql.join(ids.map(i=>sql`${i}`),sql`, `)}]::uuid[]`;
async function setImportAttemptTx(tx:Tx,attemptId:string){await tx.execute(sql`select set_config('app.import_attempt',${attemptId},true)`);}

/** One chunk: about 250 ms of work under the normal writer locks, then commit. Step state + hire commit together, so a crash re-runs nothing that committed. */
async function applyChunk(ctx:SessionContext,job:EmployeeImportJobRow):Promise<void>{
 const attemptId=job.attempt_id!;const stored=(job.plan??{}) as StoredPlan;
 const started=Date.now();
 const applied=await withTenant(ctx,async tx=>{
  await setImportAttemptTx(tx,attemptId);
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  const steps=await tx.execute<Step>(sql`select seq,kind,row_num,state,payload,employment_id,person_id from employee_import_step where job_id=${job.id}::uuid and state='pending' order by seq limit ${MAX_STEPS_PER_CHUNK} for update`);
  if(!steps.length){
   await tx.execute(sql`update employee_import_job set state='activating',phase='activation',updated_at=now() where id=${job.id}::uuid and state='importing'`);
   return{count:0,more:false,ms:Date.now()-started};
  }
  const cache=await stepCache(tx,job.id);
  let count=0;let kind:Step['kind']=steps[0].kind;
  for(const step of steps){
   if(count>0&&Date.now()-started>=EMPLOYEE_IMPORT_CHUNK_BUDGET_MS)break;
   kind=step.kind;
   try{
    const saved=await applyEmployeeImportStepTx(tx,ctx,step.payload,{attemptId,allocationPreview:stored.allocationPreview,employmentByIndex:cache.employmentByIndex,registerSubjects:cache.registerSubjects});
    await tx.execute(sql`update employee_import_step set state='applied',employment_id=${saved.employmentId??null}::uuid,person_id=${saved.personId??null}::uuid where job_id=${job.id}::uuid and seq=${step.seq} and state='pending'`);
    if((saved.family??0)>0&&saved.personId)cache.familyPersons.add(saved.personId);
    count++;
   }catch(error){
    if(isTransientEmployeeImportError(error))throw error;
    throw new StepRefused({row_num:step.row_num,email:(step.payload as {email?:string}).email??''},error);
   }
  }
  const more=steps.length>count;
  await tx.execute(sql`update employee_import_job set steps_done=steps_done+${count},imported=(select count(*)::int from employee_import_step where job_id=${job.id}::uuid and kind='employee' and state='applied'),chunks=chunks+1,max_chunk_ms=greatest(max_chunk_ms,${Date.now()-started}),phase=${phaseOf(kind)},transient_retries=0,updated_at=now() where id=${job.id}::uuid`);
  return{count,more,ms:Date.now()-started};
 });
 (globalThis as WorkerGlobal).__aihrEmployeeImportChunk?.(applied.ms,applied.count,job.id);
 if(!applied.count)stepCaches.delete(job.id);
}

/** All rows staged: flip visibility in one short transaction under the initiating user's freshly checked authority. */
async function activate(ctx:SessionContext,job:EmployeeImportJobRow):Promise<void>{
 const attemptId=job.attempt_id!;const started=Date.now();
 const companyIds=job.company_ids??[];
 const result=await withTenant(ctx,async tx=>{
  await setImportAttemptTx(tx,attemptId);
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
  await assertEmployeeImportAuthorityTx(tx,ctx,job.company_id,companyIds);
  const conflicts=await tx.execute<{employment_id:string;email:string}>(sql`select employment_id,email from app.import_activation_conflicts(${attemptId}::uuid)`);
  if(conflicts.length){
   const rows=await tx.execute<{employment_id:string;row_num:number;email:string}>(sql`select employment_id,row_num,payload->>'email' as email from employee_import_step where job_id=${job.id}::uuid and kind='employee' and employment_id = any(${pgUuidArray(conflicts.map(c=>c.employment_id))})`);
   throw new ActivationConflict(rows.map(r=>({rowNum:r.row_num,email:r.email,message:`Email "${r.email}" is already used by another employee (Allow Duplicated Work Email is off)`})));
  }
  const [counts]=await tx.execute<{dependents:number;qualification:number;emergency:number}>(sql`select coalesce(sum(jsonb_array_length(coalesce(payload->'family','[]'::jsonb))) filter (where kind='employee'),0)::int as dependents,count(*) filter (where kind='register' and payload->>'registerKind'='qualification')::int as qualification,count(*) filter (where kind='register' and payload->>'registerKind'='emergency')::int as emergency from employee_import_step where job_id=${job.id}::uuid and state='applied'`);
  await tx.execute(sql`select * from app.import_activate(${attemptId}::uuid)`);
  const imported=job.imported;
  await recordImportEventTx(tx,ctx,{attemptId,kind:'confirmed',importKind:'employee_full',detail:{succeeded:imported,failed:job.total-job.valid}});
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employee-import',aggregateId:job.company_id,eventType:'employee-import.completed',actor:actorOf(ctx),payload:{companyId:job.company_id,imported,failed:0,skipped:job.total-job.valid,companyIds,dependents:counts.dependents,registers:{qualification:counts.qualification,emergency:counts.emergency}}});
  await tx.execute(sql`update employee_import_job set state='completed',phase='activation',updated_at=now(),activation_ms=${Date.now()-started} where id=${job.id}::uuid and state='activating'`);
  return{imported,dependents:counts.dependents,registers:{qualification:counts.qualification,emergency:counts.emergency}};
 });
 (globalThis as WorkerGlobal).__aihrEmployeeImportActivation?.(Date.now()-started,job.id);
 // Post-commit best effort, exactly as the synchronous import: never reported as a rolled-back import.
 const warnings:string[]=[];
 const familyPersons=stepCaches.get(job.id)?.familyPersons??(await withTenant(ctx,tx=>tx.execute<{person_id:string}>(sql`select person_id from employee_import_step where job_id=${job.id}::uuid and kind='employee' and jsonb_array_length(coalesce(payload->'family','[]'::jsonb))>0 and person_id is not null`)).then(rows=>new Set(rows.map(r=>r.person_id))));
 for(const personId of familyPersons){try{const r=await syncChildReliefFromFamily(ctx,personId);if(r.skipped==='error')warnings.push('Family records were saved; review the tax child-relief refresh on the Personnel record.');}catch{warnings.push('Family records were saved; review the tax child-relief refresh on the Personnel record.');}}
 const rejected=(job.plan as StoredPlan|null)?.rejected??[];
 const runId=await recordImportRun(ctx,{companyId:job.company_id,fileName:job.input?.fileName??job.source_name,totalRows:job.total,imported:result.imported,rejected,failed:[]}).catch(()=>null);
 const summary:EmployeeImportResultSummary={companyId:job.company_id,imported:result.imported,failed:[],skipped:job.total-job.valid,dependentsImported:result.dependents,registersImported:result.registers,superiorFailed:[],fileErrors:[],warnings:[...new Set(warnings)],runId,attemptId};
 await withTenant(ctx,tx=>tx.execute(sql`update employee_import_job set result=${JSON.stringify(summary)}::jsonb,input=null,source_content=null,plan=null,updated_at=now() where id=${job.id}::uuid`)).catch(()=>undefined);
 await withTenant(ctx,tx=>tx.execute(sql`delete from employee_import_step where job_id=${job.id}::uuid`)).catch(()=>undefined);
 stepCaches.delete(job.id);
}
class ActivationConflict extends Error{constructor(readonly rows:EmployeeImportRowError[]){super('Employee data changed before the import could be finished.');}}

/** Terminal: void every staged row (ADR-0157; decided rule), run on the worker's owner connection so a revoked initiator can never leave staged rows behind. */
async function discardJob(owner:postgres.ReservedSql,job:EmployeeImportJobRow){
 if(job.attempt_id)await owner`select * from app.import_discard(${job.tenant_id}::uuid,${job.attempt_id}::uuid,${job.created_by}::uuid,${(job.error??'Employee import was stopped before activation.').slice(0,900)})`;
 await owner`update employee_import_job set state='failed',input=null,source_content=null,plan=null,updated_at=now() where id=${job.id}::uuid and state='discarding'`;
 await owner`delete from employee_import_step where job_id=${job.id}::uuid`;
 stepCaches.delete(job.id);
}
/** Record the failure and row-level reasons: every valid row is reported, the refused row carries the real reason. */
async function failJob(owner:postgres.ReservedSql,job:EmployeeImportJobRow,message:string,failedRowNum:number|null,failedEmail:string,firstError:string,rowErrors?:EmployeeImportRowError[]){
 const steps=await owner<{row_num:number;email:string;kind:string}[]>`select row_num,payload->>'email' as email,kind from employee_import_step where job_id=${job.id}::uuid and kind='employee' order by seq`;
 const errors:EmployeeImportRowError[]=rowErrors?? (steps.length?steps.map(s=>({rowNum:s.row_num,email:s.email??'',message:s.row_num===failedRowNum?firstError:'Not written because the import was rolled back.'})):[]);
 await owner`update employee_import_job set state='discarding',error=${message.slice(0,4000)},errors=${JSON.stringify(errors)}::jsonb,updated_at=now() where id=${job.id}::uuid and state in ('queued','validating','importing','activating')`;
}

/** Owner credential stays in the dedicated worker. Never passed to a domain writer. */
export async function runEmployeeImportTick(owner:postgres.Sql):Promise<boolean>{
 const connection=await owner.reserve();
 try{
  const [proof]=await connection<{ok:boolean}[]>`select exists(select 1 from pg_roles r join pg_class c on c.oid='public.employee_import_job'::regclass where r.rolname=current_user and (r.rolsuper or c.relowner=r.oid)) as ok`;
  if(!proof?.ok)throw new Error('The import worker requires the physical queue owner connection.');
  const [lock]=await connection<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended('employee-import-worker',0)) as ok`;
  if(!lock?.ok)return false;
  try{
   const [job]=await connection<EmployeeImportJobRow[]>`select * from employee_import_job where state in ('queued','validating','importing','activating','discarding') order by updated_at,created_at limit 1`;
   if(!job)return false;
   if(job.state==='discarding'){
    await discardJob(connection,job);
    // Best-effort history under the initiating user's context (a revoked user keeps no authority; the job row is still terminal).
    try{const ctx=await freshImportContext(job.context);if(job.attempt_id)await recordImportFailure(ctx,job.attempt_id,'employee_full','failed',new ImportHistoryError(job.error??'Employee import stopped before activation.'));
     await recordImportRun(ctx,{companyId:job.company_id,fileName:job.source_name,totalRows:job.total,imported:0,rejected:(job.plan as StoredPlan|null)?.rejected??[],failed:job.errors.map(e=>({rowNum:e.rowNum,email:e.email,message:e.message}))});}catch{/* best effort */}
    return true;
   }
   let ctx:SessionContext;
   try{ctx=await freshImportContext(job.context);}catch(error){if(isTransientEmployeeImportError(error)){await connection`update employee_import_job set transient_retries=transient_retries+1,updated_at=now() where id=${job.id}::uuid`;return false;}await failJob(connection,job,'Import stopped: your account or access could not be confirmed.',null,'',publicErrorMessage(error));return true;}
   try{await processEmployeeImportJob(ctx,job.id);return true;}
   catch(error){
    if(isTransientEmployeeImportError(error)){
     stepCaches.delete(job.id); // A rolled-back chunk must not leave stale ids in the map.
     const [row]=await connection<{transient_retries:number}[]>`update employee_import_job set transient_retries=transient_retries+1,updated_at=now() where id=${job.id}::uuid returning transient_retries`;
     if((row?.transient_retries??0)<MAX_TRANSIENT_RETRIES)return false;
     await failJob(connection,job,'Import stopped: other work kept the system busy for too long. No employees were created; try again later.',null,'','');return true;
    }
    if(error instanceof StepRefused){await failJob(connection,job,`No employee rows were written. The import was rolled back${error.step.row_num?` after row ${error.step.row_num} was refused`:''}. ${error.message}`,error.step.row_num,error.step.email,error.message);return true;}
    if(error instanceof ActivationConflict){await failJob(connection,job,`No employee rows were written. ${error.message}`,null,'','',error.rows);return true;}
    await failJob(connection,job,`Import stopped: ${publicErrorMessage(error)}`,null,'',publicErrorMessage(error));return true;
   }
  }finally{await connection`select pg_advisory_unlock(hashtextextended('employee-import-worker',0))`;}
 }finally{await connection.release();}
}
