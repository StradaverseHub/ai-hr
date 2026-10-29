/** Queue coordinator. Owner connection discovers/locks jobs only; HR writes ALWAYS use app RLS. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type postgres from 'postgres';
import {client,withTenant,type SessionContext,type Tx} from '../db/client';
import {resolveEntitlementsInTenantTx} from './entitlements';
import {bankJobTx,type BankImportJobRow} from './bank-import-job';
import {ImportFileError} from '../lib/import-file';
import {PersonnelImportHeaderError} from '../lib/personnel-import-contract';
import {PersonnelCsvError} from '../lib/personnel-csv';
import {decodeBankImportSource} from '../lib/bank-import-source.server';
import {BANK_IMPORT_BATCH_ROWS,BANK_IMPORT_VALIDATION_ROWS} from '../lib/bank-import-job';
import {analyzeBankImportBatch,applyBankImportRowTx} from './import-sections';
import {createImportAttemptTx,recordImportEventTx,sealImportPlan} from './import-history';
import type {ImportPlanBase} from '../lib/import-history';
import type {ImportRecord} from '../lib/import-schema';
import type {SectionRowResult} from '../lib/import-sections';

type QueueRow={ordinal:number;record:ImportRecord;preview:SectionRowResult;company_id:string|null;employment_id:string|null;binding:string;state:string;error:string|null};
async function sourceTx(tx:Tx,id:string){const parts=await tx.execute<{content:Buffer}>(sql`select content from bank_import_chunk where job_id=${id}::uuid order by part`);return Buffer.concat(parts.map(p=>p.content));}
async function freshContext(context:SessionContext):Promise<SessionContext>{
 const ctx=structuredClone(context);
 ctx.entitlements=await client.begin(async transaction=>resolveEntitlementsInTenantTx(async(q,params)=>[...await transaction.unsafe(q,params as postgres.ParameterOrJSON<never>[])],ctx.tenantId));
 return ctx;
}
/** One bounded phase. Exported for real DB recovery/concurrency tests. */
export async function processBankImportJob(ctx:SessionContext,id:string):Promise<void>{
 const job=await withTenant(ctx,tx=>bankJobTx(tx,id));
 if(job.state==='queued'){
  const content=await withTenant(ctx,tx=>sourceTx(tx,id));
  if(content.length!==job.source_bytes||createHash('sha256').update(content).digest('hex')!==job.source_hash)throw new Error('The uploaded file is incomplete or its checksum differs. Upload it again.');
  const decoded=await decodeBankImportSource(job.source_name,content);
  await withTenant(ctx,async tx=>{
   const current=await bankJobTx(tx,id,true);if(current.state!=='queued')return;
   for(let start=0;start<decoded.records.length;start+=1000){
    const rows=decoded.records.slice(start,start+1000).map((record,i)=>({ordinal:start+i+1,record,error:decoded.errors.get(start+i+1)??null}));
    await tx.execute(sql`insert into bank_import_row(job_id,ordinal,record,error) select ${id}::uuid,x.ordinal,x.record,x.error from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(ordinal int,record jsonb,error text)`);
   }
   await tx.execute(sql`update bank_import_job set state='validating',total=${decoded.records.length},updated_at=now() where id=${id}::uuid`);
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
 const pending=await withTenant(ctx,tx=>tx.execute<QueueRow>(sql`select * from bank_import_row where job_id=${id}::uuid and state='valid' order by ordinal limit ${BANK_IMPORT_BATCH_ROWS}`));
 for(const row of pending){
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
/** Owner credential stays in the dedicated worker. Never passed to a domain writer. */
export async function runBankImportTick(owner:postgres.Sql):Promise<boolean>{
 const connection=await owner.reserve();
 try{
  const [proof]=await connection<{ok:boolean}[]>`select exists(select 1 from pg_roles r join pg_class c on c.oid='public.bank_import_job'::regclass where r.rolname=current_user and (r.rolsuper or c.relowner=r.oid)) as ok`;
  if(!proof?.ok)throw new Error('The import worker requires the physical queue owner connection.');
  const [lock]=await connection<{ok:boolean}[]>`select pg_try_advisory_lock(hashtextextended('bank-import-worker',0)) as ok`;
  if(!lock?.ok)return false;
  try{
   const [job]=await connection<BankImportJobRow[]>`select * from bank_import_job where state in ('queued','validating','importing') order by updated_at,created_at limit 1`;
   if(!job)return false;
   try{await processBankImportJob(await freshContext(job.context),job.id);}
   catch(error){
    const message=error instanceof ImportFileError?(error.code==='FILE_TOO_LARGE'?'The file exceeds the import size or worksheet limits. Use up to 250,000 rows and 128 MiB.':'The file could not be read. Use the Bank & Statutory template and its reference sheets.'):
     error instanceof PersonnelImportHeaderError||error instanceof PersonnelCsvError?error.message.slice(0,1000):'Import stopped. Rows already saved are retained. Review the result and your access before trying again.';
    // Bounded message only; raw DB failures can contain employee values. Already saved rows stay saved.
    await connection`update bank_import_job set state='failed',error=${message},updated_at=now() where id=${job.id}::uuid`;
   }
   return true;
  }finally{await connection`select pg_advisory_unlock(hashtextextended('bank-import-worker',0))`;}
 }finally{await connection.release();}
}
