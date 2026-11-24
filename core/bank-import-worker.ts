/** Queue coordinator. Owner connection discovers/locks jobs only; HR writes ALWAYS use app RLS. */
import {createHash} from 'node:crypto';
import {withBackgroundDatabaseWork} from '../db/workload';
import {DatabaseAdmissionError} from '../db/admission';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {client,withTenant,withPoolWork,type SessionContext,type Tx} from '../db/client';
import {resolveEntitlementsInTenantTx} from './entitlements';
import {bankJobTx,type BankImportJobRow} from './bank-import-job';
import {ImportFileError} from '../lib/import-file';
import {unexpectedErrorReference} from '../lib/public-error';
import {PersonnelImportHeaderError} from '../lib/personnel-import-contract';
import {PersonnelCsvError} from '../lib/personnel-csv';
import {BANK_IMPORT_STAGE_ROWS,bankImportStagedRecords,stageBankImportSource} from '../lib/bank-import-stream-source.server';
import {BANK_IMPORT_BATCH_ROWS,BANK_IMPORT_VALIDATION_ROWS} from '../lib/bank-import-job';
import {analyzeBankImportBatch,applyBankImportRowTx,BankImportRowRejectedError} from './import-sections';
import {OwnerConnectionUnresponsive,ownerClaimDeadline,ownerDeadlineMs,ownerStep,reservedWithin} from './owner-step-deadline';
import {createImportAttemptTx,recordImportEventTx,sealImportPlan} from './import-history';
import type {ImportPlanBase} from '../lib/import-history';
import type {ImportRecord} from '../lib/import-schema';
import type {SectionRowResult} from '../lib/import-sections';

type QueueRow={ordinal:number;record:ImportRecord;preview:SectionRowResult;company_id:string|null;employment_id:string|null;binding:string;state:string;error:string|null};
async function sourcePartsTx(tx:Tx,id:string):Promise<Buffer[]>{return(await tx.execute<{content:Buffer}>(sql`select content from bank_import_chunk where job_id=${id}::uuid order by part`)).map(p=>p.content);}
async function sourceTx(tx:Tx,id:string){return Buffer.concat(await sourcePartsTx(tx,id));}
export async function freshImportContext(context:SessionContext):Promise<SessionContext>{
 const ctx=structuredClone(context);
 ctx.entitlements=await withBackgroundDatabaseWork(()=>withPoolWork(ctx.tenantId,()=>client.begin(async transaction=>resolveEntitlementsInTenantTx(async(q,params)=>[...await transaction.unsafe(q,params as postgres.ParameterOrJSON<never>[])],ctx.tenantId))));
 return ctx;
}
/** How long one import tick keeps saving rows before it hands the worker loop back. The worker runs every queue in
 * one loop (scripts/bank-import-runner.ts), so a tick that saves a full BANK_IMPORT_BATCH_ROWS batch made every other
 * background job wait for it: on production on 24 Nov 2026 rows took about 5.3 s each, so one 100-row batch held the
 * loop for about 9 minutes and a queued payroll history commit sat at "Submitting…" with the worker shown as not
 * running. Each row is its own committed checkpoint, so stopping early loses nothing; the next tick resumes at the
 * next valid row. At least one row is always attempted, so a slow row still makes progress. */
export const BANK_IMPORT_TICK_BUDGET_MS=10_000;
export type BankImportPhaseOptions={budgetMs?:number;now?:()=>number};
/** One bounded phase. Exported for real DB recovery/concurrency tests. */
export function processBankImportJob(ctx:SessionContext,id:string,options:BankImportPhaseOptions={}):Promise<void>{
 return withBackgroundDatabaseWork(()=>processBankImportPhase(ctx,id,options));
}
async function processBankImportPhase(ctx:SessionContext,id:string,options:BankImportPhaseOptions):Promise<void>{
 const job=await withTenant(ctx,tx=>bankJobTx(tx,id));
 if(job.state==='queued'){
  // The parts stay separate: the hash and the decoder read them in order, and a CSV decode releases each one.
  const parts=await withTenant(ctx,tx=>sourcePartsTx(tx,id));
  const hash=createHash('sha256');let bytes=0;for(const part of parts){hash.update(part);bytes+=part.length;}
  if(bytes!==job.source_bytes||hash.digest('hex')!==job.source_hash)throw new Error('The uploaded file is incomplete or its checksum differs. Upload it again.');
  // Same rows, errors and refusals as decodeBankImportSource, staged as compact batches (lib/bank-import-stream-source.server.ts).
  const staged=await stageBankImportSource(job.source_name,parts);
  await withTenant(ctx,async tx=>{
   const current=await bankJobTx(tx,id,true);if(current.state!=='queued')return;
   for(let batch=0;batch<staged.batches.length;batch++){
    const start=batch*BANK_IMPORT_STAGE_ROWS;
    const rows=bankImportStagedRecords(staged,batch).map((record,i)=>({ordinal:start+i+1,record,error:staged.errors.get(start+i+1)??null}));
    await tx.execute(sql`insert into bank_import_row(job_id,ordinal,record,error) select ${id}::uuid,x.ordinal,x.record,x.error from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(ordinal int,record jsonb,error text)`);
   }
   await tx.execute(sql`update bank_import_job set state='validating',total=${staged.total},updated_at=now() where id=${id}::uuid`);
  });
  return;
 }
 if(job.state==='validating'){
  const pending=await withTenant(ctx,tx=>tx.execute<QueueRow>(sql`select * from bank_import_row where job_id=${id}::uuid and state='pending' order by ordinal limit ${BANK_IMPORT_VALIDATION_ROWS}`));
  if(!pending.length){await withTenant(ctx,tx=>tx.execute(sql`update bank_import_job set state='ready',updated_at=now() where id=${id}::uuid and state='validating'`));return;}
  const analyzed=await analyzeBankImportBatch(ctx,pending.map(r=>r.record));
  if(analyzed.fileErrors.length)throw new Error(analyzed.fileErrors.join(' '));
  await withTenant(ctx,async tx=>{
   await bankJobTx(tx,id,true);
   const companyIds=[...new Set(analyzed.rows.flatMap(row=>row.companyId?[row.companyId]:[]))];
   const access=companyIds.length?await tx.execute<{id:string;ok:boolean}>(sql`select x.id,app.import_company_access('bank_statutory',x.id,'maintain') as ok from jsonb_to_recordset(${JSON.stringify(companyIds.map(id=>({id})))}::jsonb) x(id uuid)`):[];
   const allowed=new Set(access.filter(row=>row.ok).map(row=>row.id));
   const updates=pending.map((input,i)=>{
    const row=analyzed.rows[i],preview={...row.preview,rowNum:input.ordinal};
    if(input.error)preview.errors.push(input.error);
    if(row.companyId&&!allowed.has(row.companyId))preview.errors.push('You do not have permission to update this employee.');
    if(preview.errors.length)preview.ok=false;
    return{ordinal:input.ordinal,preview,company_id:row.companyId,employment_id:row.employmentId,binding:row.binding,state:preview.errors.length?'invalid':preview.ok?'valid':'unchanged'};
   });
   const changed=await tx.execute<{state:string}>(sql`update bank_import_row r set preview=x.preview,error=null,company_id=x.company_id,employment_id=x.employment_id,binding=x.binding,state=x.state
    from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) x(ordinal int,preview jsonb,company_id uuid,employment_id uuid,binding text,state text)
    where r.job_id=${id}::uuid and r.ordinal=x.ordinal and r.state='pending' returning r.state`);
   const valid=changed.filter(row=>row.state==='valid').length,invalid=changed.filter(row=>row.state==='invalid').length,unchanged=changed.filter(row=>row.state==='unchanged').length;
   await tx.execute(sql`update bank_import_job set company_ids=array(select distinct value::uuid from jsonb_array_elements_text(to_jsonb(company_ids)||${JSON.stringify(companyIds)}::jsonb)),validated=validated+${changed.length},valid=valid+${valid},invalid=invalid+${invalid},unchanged=unchanged+${unchanged},updated_at=now() where id=${id}::uuid`);
  });return;
 }
 if(job.state!=='importing')return;
 if(!job.attempt_id){
  await withTenant(ctx,async tx=>{
   const current=await bankJobTx(tx,id,true);if(current.attempt_id)return;
   const companies=await tx.execute<{company_id:string}>(sql`select distinct company_id from bank_import_row where job_id=${id}::uuid and state='valid' and company_id is not null`);
   // Detailed preview remains paginated in bank_import_row; the immutable history plan references it.
   const plan=sealImportPlan<ImportPlanBase&{kind:'bank_statutory';jobId:string;rows:never[]}>({version:1,kind:'bank_statutory',jobId:id,rows:[],previewHash:'',counts:{total:current.total,valid:current.valid,invalid:current.invalid},issues:[]});
   const attempt=await createImportAttemptTx(tx,ctx,{kind:'bank_statutory',sourceName:current.source_name,content:await sourceTx(tx,id),companyIds:companies.map(c=>c.company_id),plan,operationKey:id});
   await tx.execute(sql`update bank_import_job set attempt_id=${attempt.attemptId}::uuid,processed=total-valid,updated_at=now() where id=${id}::uuid`);
  });return;
 }
 const now=options.now??(()=>performance.now()),deadline=now()+(options.budgetMs??BANK_IMPORT_TICK_BUDGET_MS);
 const pending=await withTenant(ctx,tx=>tx.execute<QueueRow>(sql`select * from bank_import_row where job_id=${id}::uuid and state='valid' order by ordinal limit ${BANK_IMPORT_BATCH_ROWS}`));
 for(const [index,row] of pending.entries()){
  if(index>0&&now()>=deadline)break;
  try{
   await withTenant(ctx,async tx=>{
    const [current]=await tx.execute<QueueRow>(sql`select * from bank_import_row where job_id=${id}::uuid and ordinal=${row.ordinal} for update`);
    if(current?.state!=='valid')return;
    // Optimization only; the policy retains the same current principal checks.
    // LOCAL confines it to this canonical HR/audit/checkpoint transaction.
    await tx.execute(sql`select set_config('app.bank_import_point_read','on',true)`);
    // The same transaction owns this exact row's mutation, immutable audit item and checkpoint.
    const saved=await applyBankImportRowTx(tx,ctx,{record:current.record,binding:current.binding,employmentId:current.employment_id!,companyId:current.company_id!,attemptId:job.attempt_id!,ordinal:row.ordinal});
    await tx.execute(sql`update bank_import_row set state=${saved?'applied':'skipped'} where job_id=${id}::uuid and ordinal=${row.ordinal}`);
    await tx.execute(sql`update bank_import_job set processed=processed+1,saved=saved+${saved?1:0},updated_at=now() where id=${id}::uuid`);
   });
  }catch(error){
   // Only the canonical analyzer can reject employee data. SQL/connection/unknown failures
   // stop the job with its atomic checkpoints intact; they must never consume a valid row.
   if(!(error instanceof BankImportRowRejectedError))throw error;
   // Permission revocation/infrastructure faults fail the job rather than pretending every row failed.
   await withTenant(ctx,async tx=>{
    const [proof]=await tx.execute<{ok:boolean}>(sql`select app.principal_snapshot_current() as ok`);if(!proof?.ok)throw error;
    const changed=await tx.execute(sql`update bank_import_row set state='failed',error='This row was not saved. Its data or permissions changed after validation; review and import it again.' where job_id=${id}::uuid and ordinal=${row.ordinal} and state='valid' returning ordinal`);
    if(changed.length)await tx.execute(sql`update bank_import_job set processed=processed+1,failed=failed+1,updated_at=now() where id=${id}::uuid`);
   });
  }
 }
 await withTenant(ctx,async tx=>{
  const current=await bankJobTx(tx,id,true);
  if(current.processed!==current.total)return;
  await recordImportEventTx(tx,ctx,{attemptId:current.attempt_id!,kind:'confirmed',importKind:'bank_statutory',detail:{succeeded:current.saved,failed:current.failed+current.invalid}});
  await tx.execute(sql`update bank_import_job set state='completed',updated_at=now() where id=${id}::uuid`);
  await tx.execute(sql`delete from bank_import_chunk where job_id=${id}::uuid`);
 });
}
/** Owner credential stays in the dedicated worker. Never passed to a domain writer. The owner steps (reservation,
 * proof, lock, claim, failure record, unlock) are bounded by core/owner-step-deadline.ts; processing the job is not.
 * A reservation whose statement missed its deadline is neither unlocked nor released: the worker exits, and the
 * session's end frees the advisory lock. ownerDeadlineMs is a test hook. */
export async function runBankImportTick(owner:postgres.Sql,options:{ownerDeadlineMs?:number}={}):Promise<boolean>{
 const deadlineMs=ownerDeadlineMs(options.ownerDeadlineMs);
 const claimStep=ownerClaimDeadline(deadlineMs);
 const connection=await reservedWithin(owner.reserve(),deadlineMs);
 let unresponsive=false;
 const lost=(error:unknown)=>{if(error instanceof OwnerConnectionUnresponsive)unresponsive=true;throw error;};
 try{
  const [proof]=await claimStep(connection<{ok:boolean}[]>`select exists(select 1 from pg_roles r join pg_class c on c.oid='public.bank_import_job'::regclass where r.rolname=current_user and (r.rolsuper or c.relowner=r.oid)) as ok`,'the Bank import owner proof');
  if(!proof?.ok)throw new Error('The import worker requires the physical queue owner connection.');
  const [lock]=await claimStep(connection<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended('bank-import-worker',0)) as ok`,'the Bank import lock');
  if(!lock?.ok)return false;
  try{
   const [job]=await claimStep(connection<BankImportJobRow[]>`select * from bank_import_job where state in ('queued','validating','importing') order by updated_at,created_at limit 1`,'the Bank import claim');
   if(!job)return false;
   try{await processBankImportJob(await freshImportContext(job.context),job.id);}
   catch(error){
    if(error instanceof DatabaseAdmissionError)return false;
    const message=error instanceof ImportFileError?(error.code==='FILE_TOO_LARGE'?'The file exceeds the import size or worksheet limits. Use up to 250,000 rows and 128 MiB.':'The file could not be read. Use the Bank & Statutory template and its reference sheets.'):
     error instanceof PersonnelImportHeaderError||error instanceof PersonnelCsvError?error.message.slice(0,1000):
     // d3ba1e9f: an unexpected stop carries a short reference (full error in the worker log) for the Error Log.
     `Import stopped. Rows already saved are retained. Review the result and your access before trying again. Reference ${unexpectedErrorReference(error,'bank import job')}.`;
    // Bounded message only; raw DB failures can contain employee values. Already saved rows stay saved.
    await ownerStep(connection`update bank_import_job set state='failed',error=${message},updated_at=now() where id=${job.id}::uuid`,'the Bank import failure record',deadlineMs);
   }
   return true;
  }catch(error){return lost(error);}
  finally{if(!unresponsive)await ownerStep(connection`select pg_advisory_unlock(hashtextextended('bank-import-worker',0))`,'the Bank import unlock',deadlineMs);}
 }catch(error){return lost(error);}
 finally{if(!unresponsive)connection.release();}
}
