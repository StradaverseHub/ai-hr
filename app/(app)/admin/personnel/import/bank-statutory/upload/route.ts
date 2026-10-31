/** Compatibility admission for an already-open client. Processing is always delegated to the worker. */
import {createHash} from 'node:crypto';
import {requireAdmin} from '@/lib/authz';
import {createBankImportJob,uploadBankImportChunk,bankImportCommand} from '@/core/bank-import-job';
import {BANK_IMPORT_CHUNK_BYTES} from '@/lib/bank-import-job';
import {IMPORT_SOURCE_MAX_BYTES} from '@/core/import-history';
import {assertBankImportOrigin,bankImportBody,bankImportHttpError} from '@/lib/bank-import-http';
export const runtime='nodejs';
export async function POST(request:Request){
 const ctx=await requireAdmin();
 try{
  assertBankImportOrigin(request);
  const content=await bankImportBody(request,IMPORT_SOURCE_MAX_BYTES),name=new URL(request.url).searchParams.get('name')??'bank-statutory.csv';
  const admitted=await createBankImportJob(ctx,{name,bytes:content.length,hash:createHash('sha256').update(content).digest('hex')});
  if(!admitted.existing||admitted.job.state==='uploading'){
   for(let offset=0,part=0;offset<content.length;offset+=BANK_IMPORT_CHUNK_BYTES,part++)await uploadBankImportChunk(ctx,admitted.job.id,part,content.subarray(offset,offset+BANK_IMPORT_CHUNK_BYTES));
   admitted.job=await bankImportCommand(ctx,admitted.job.id,'validate');
  }
  return Response.json({jobId:admitted.job.id,error:'This file has a background import. Reload the importer to review its progress and confirm the validated changes.'},{status:409,headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return bankImportHttpError(error);}
}
