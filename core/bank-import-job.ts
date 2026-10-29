/** Durable admission and creator-scoped progress. No HR changes occur in an HTTP request. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {BANK_IMPORT_CHUNK_BYTES,BANK_IMPORT_MAX_BYTES,BANK_IMPORT_PAGE_ROWS,type BankImportProgress,type BankImportState} from '../lib/bank-import-job';
import {importFileFormat} from '../lib/import-file';
import {importSourceName} from './import-history';
export class BankImportJobError extends Error{constructor(message:string,readonly status=400){super(message);}}
export type BankImportJobRow={id:string;tenant_id:string;created_by:string;context:SessionContext;source_name:string;source_hash:string;source_bytes:number;uploaded_bytes:number;state:BankImportState;total:number;validated:number;valid:number;invalid:number;unchanged:number;processed:number;saved:number;failed:number;attempt_id:string|null;error:string|null;updated_at:Date;created_at:Date};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const bankJobId=(id:string)=>{if(!uuid.test(id))throw new BankImportJobError('Import unavailable.',404);return id;};
export async function bankJobTx(tx:Tx,id:string,lock=false){
 const [row]=await tx.execute<BankImportJobRow>(sql`select * from bank_import_job where id=${bankJobId(id)}::uuid ${lock?sql`for update`:sql``}`);
 if(!row)throw new BankImportJobError('Import unavailable.',404);return row;
}
function progress(row:BankImportJobRow):BankImportProgress{return{id:row.id,sourceName:row.source_name,state:row.state,total:row.total,validated:row.validated,valid:row.valid,invalid:row.invalid,unchanged:row.unchanged,processed:row.processed,saved:row.saved,failed:row.failed,uploadedBytes:row.uploaded_bytes,sourceBytes:row.source_bytes,attemptId:row.attempt_id,error:row.error,updatedAt:new Date(row.updated_at).toISOString(),createdAt:new Date(row.created_at).toISOString()};}
export async function createBankImportJob(ctx:SessionContext,input:{name:string;hash:string;bytes:number}){
 if(!ctx.userId||typeof input.name!=='string'||!importFileFormat(input.name)||!/^[a-f0-9]{64}$/.test(input.hash)||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>BANK_IMPORT_MAX_BYTES)throw new BankImportJobError('Choose a CSV or Excel file no larger than 128 MiB.');
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'bank-import-admit:'+ctx.tenantId+':'+input.hash},0))`);
  const [existing]=await tx.execute<BankImportJobRow>(sql`select * from bank_import_job where source_hash=${input.hash} and state in ('uploading','queued','validating','ready','importing')`);
  if(existing)return{job:progress(existing),existing:true};
  const [count]=await tx.execute<{n:number}>(sql`select count(*)::int as n from bank_import_job where state in ('uploading','queued','validating','ready','importing')`);
  if(count.n>=3)throw new BankImportJobError('Finish or cancel your existing imports before uploading another file.',409);
  const [row]=await tx.execute<BankImportJobRow>(sql`insert into bank_import_job(tenant_id,created_by,context,source_name,source_hash,source_bytes) values(${ctx.tenantId}::uuid,${ctx.userId}::uuid,'{}'::jsonb,${importSourceName(input.name,'bank-statutory.csv')},${input.hash},${input.bytes}) on conflict do nothing returning *`);
  if(!row)throw new BankImportJobError('This file already has an active import. Wait for that import to finish.',409);
  return{job:progress(row),existing:false};
 });
}
export async function uploadBankImportChunk(ctx:SessionContext,id:string,part:number,content:Buffer){
 return withTenant(ctx,async tx=>{
  const job=await bankJobTx(tx,id,true),offset=part*BANK_IMPORT_CHUNK_BYTES;
  if(job.state!=='uploading'||!Number.isSafeInteger(part)||part<0||offset>=job.source_bytes||content.length!==Math.min(BANK_IMPORT_CHUNK_BYTES,job.source_bytes-offset))throw new BankImportJobError('Invalid upload part.');
  const [prior]=await tx.execute<{same:boolean}>(sql`select content=${content} as same from bank_import_chunk where job_id=${id}::uuid and part=${part}`);
  if(prior){if(!prior.same)throw new BankImportJobError('This upload part differs from the original.',409);return;}
  await tx.execute(sql`insert into bank_import_chunk(job_id,part,content) values(${id}::uuid,${part},${content})`);
  await tx.execute(sql`update bank_import_job set uploaded_bytes=uploaded_bytes+${content.length},updated_at=now() where id=${id}::uuid`);
 });
}
export async function bankImportCommand(ctx:SessionContext,id:string,command:'validate'|'confirm'|'cancel'){
 return withTenant(ctx,async tx=>{
  const job=await bankJobTx(tx,id,true);
  if(command==='validate'){
   if(job.state!=='uploading')return progress(job);
   if(job.uploaded_bytes!==job.source_bytes)throw new BankImportJobError('Upload every part before validating.');
   await tx.execute(sql`update bank_import_job set state='queued',updated_at=now() where id=${id}::uuid`);
  }else if(command==='confirm'){
   if(job.state==='importing'||job.state==='completed')return progress(job);
   if(job.state!=='ready'||job.valid<1)throw new BankImportJobError('Wait for validation and review the preview before importing.');
   // The worker creates the shared immutable attempt before applying the first row.
   await tx.execute(sql`update bank_import_job set state='importing',updated_at=now() where id=${id}::uuid`);
  }else{
   if(!['uploading','ready'].includes(job.state))throw new BankImportJobError('This import is processing and cannot be cancelled here.',409);
   await tx.execute(sql`update bank_import_job set state='cancelled',updated_at=now() where id=${id}::uuid`);
   await tx.execute(sql`delete from bank_import_chunk where job_id=${id}::uuid`);
  }
  return progress(await bankJobTx(tx,id));
 });
}
export async function getBankImportJob(ctx:SessionContext,id:string,page=0){
 return withTenant(ctx,async tx=>{
  const job=await bankJobTx(tx,id);
  const offset=Math.max(0,Math.min(2500,Math.floor(page)||0))*BANK_IMPORT_PAGE_ROWS;
  const rows=await tx.execute<{ordinal:number;preview:Record<string,unknown>|null;state:string;error:string|null}>(sql`select ordinal,preview,state,error from bank_import_row where job_id=${id}::uuid order by ordinal limit ${BANK_IMPORT_PAGE_ROWS} offset ${offset}`);
  return{job:progress(job),rows:[...rows]};
 });
}
export async function listBankImportJobs(ctx:SessionContext){return withTenant(ctx,async tx=>{
 const rows=await tx.execute<BankImportJobRow>(sql`select * from bank_import_job where state not in ('cancelled') order by created_at desc limit 10`);
 return rows.map(progress);
});}
