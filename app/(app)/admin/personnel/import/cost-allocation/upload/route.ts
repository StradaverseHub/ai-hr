import {requireAdmin} from '@/lib/authz';
import {previewCostAllocationUpload} from '@/core/cost-allocation-import';
import {ImportHistoryError,IMPORT_SOURCE_MAX_BYTES} from '@/core/import-history';
import {publicErrorMessage} from '@/lib/public-error';
import {CostAllocationError} from '@/lib/employment-cost-allocation';
export const runtime='nodejs';
/** Raw file transport keeps the original bytes for import history and bounds memory before parsing. */
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
  const result=await previewCostAllocationUpload(ctx,{name:url.searchParams.get('name')??'',operationKey:request.headers.get('x-upload-operation')??undefined,content:Buffer.concat(chunks)});
  return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const known=error instanceof ImportHistoryError||error instanceof CostAllocationError;
  if(!known)console.error('[cost allocation upload]',error);
  return Response.json({error:known?publicErrorMessage(error):null},{status:400,headers:{'Cache-Control':'private, no-store'}});
 }finally{reader.releaseLock();}
}
