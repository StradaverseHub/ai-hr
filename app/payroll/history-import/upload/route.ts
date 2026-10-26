import {requireAdmin} from '@/lib/authz';
import {previewPayrollHistoryUpload,PayrollHistoryRevisionError} from '@/packs/payroll/service';
export const runtime='nodejs';
const MAX_BYTES=10*1024*1024;
/** Raw file transport preserves the original workbook bytes and bounds memory before parsing it. */
export async function POST(request:Request){
 const ctx=await requireAdmin();
 const origin=request.headers.get('origin');
 const host=request.headers.get('x-forwarded-host')??request.headers.get('host');
 if(!origin||!host||new URL(origin).host!==host)return Response.json({error:null},{status:403});
 if(Number(request.headers.get('content-length'))>MAX_BYTES)return Response.json({error:null},{status:413});
 if(!request.body)return Response.json({error:null},{status:400});
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{
  while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;
   if(length>MAX_BYTES){await reader.cancel();return Response.json({error:null},{status:413});}chunks.push(next.value);}
  const url=new URL(request.url);
  const result=await previewPayrollHistoryUpload(ctx,{name:url.searchParams.get('name')??'',operationKey:request.headers.get('x-upload-operation')??undefined,content:Buffer.concat(chunks)});
  return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  if(!(error instanceof PayrollHistoryRevisionError))console.error('[history upload]',error);
  return Response.json({error:error instanceof PayrollHistoryRevisionError?error.message:null},{status:400,headers:{'Cache-Control':'private, no-store'}});
 }finally{reader.releaseLock();}
}
