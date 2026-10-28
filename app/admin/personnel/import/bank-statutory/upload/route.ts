import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {commitBankStatutoryUpload} from '@/core/bank-statutory-upload';
import {BankStatutoryImportError} from '@/core/bank-statutory-import';
import {ImportHistoryError,IMPORT_SOURCE_MAX_BYTES} from '@/core/import-history';
export const runtime='nodejs';
/**
 * 0db97f14 — Bank & Statutory Import: the ORIGINAL file bytes, so Import History keeps the file and its
 * sha256. Same-origin only and bounded before parsing, like the Cost Center Allocation upload.
 */
export async function POST(request:Request){
 const ctx=await requireAdmin();
 const origin=request.headers.get('origin');
 const host=request.headers.get('x-forwarded-host')??request.headers.get('host');
 if(!origin||!host||new URL(origin).host!==host)return Response.json({error:null},{status:403});
 if(Number(request.headers.get('content-length'))>IMPORT_SOURCE_MAX_BYTES)return Response.json({error:null},{status:413});
 if(!request.body)return Response.json({error:null},{status:400});
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{
  while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;
   if(length>IMPORT_SOURCE_MAX_BYTES){await reader.cancel();return Response.json({error:null},{status:413});}chunks.push(next.value);}
  const url=new URL(request.url);
  const result=await commitBankStatutoryUpload(ctx,{name:url.searchParams.get('name')??'',operationKey:request.headers.get('x-upload-operation')??undefined,content:Buffer.concat(chunks)});
  revalidatePath('/admin/personnel','layout');revalidatePath('/admin/personnel/import/history');
  return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const known=error instanceof ImportHistoryError||error instanceof BankStatutoryImportError;
  if(!known)console.error('[bank statutory upload]',error);
  return Response.json({error:known?(error as Error).message:null},{status:400,headers:{'Cache-Control':'private, no-store'}});
 }finally{reader.releaseLock();}
}
