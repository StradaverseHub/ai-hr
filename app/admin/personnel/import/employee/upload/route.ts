import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {commitEmployeeImportUpload,employeeImportUploadInput,EMPLOYEE_IMPORT_TEXT_MAX_BYTES} from '@/core/employee-import-upload';
import {ImportHistoryError,IMPORT_SOURCE_MAX_BYTES} from '@/core/import-history';
import {importSourceName} from '@/core/import-history';
import {publicErrorMessage} from '@/lib/public-error';
export const runtime='nodejs';
const LIMIT=IMPORT_SOURCE_MAX_BYTES+EMPLOYEE_IMPORT_TEXT_MAX_BYTES*2+65536;
/**
 * 524303d9 — "Everything — new employees" Import: the ORIGINAL file (multipart part `file`) plus the sheets
 * as the CSV text the preview validated (part `payload`, JSON). Same-origin only and bounded before parsing,
 * like the Bank & Statutory and Cost Center Allocation uploads, so Import History keeps the file and its sha256.
 */
export async function POST(request:Request){
 const ctx=await requireAdmin();
 const origin=request.headers.get('origin');
 const host=request.headers.get('x-forwarded-host')??request.headers.get('host');
 if(!origin||!host||new URL(origin).host!==host)return Response.json({error:null},{status:403});
 if(Number(request.headers.get('content-length'))>LIMIT)return Response.json({error:null},{status:413});
 const type=request.headers.get('content-type')??'';
 if(!request.body||!type.startsWith('multipart/form-data'))return Response.json({error:null},{status:400});
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{
  while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;
   if(length>LIMIT){await reader.cancel();return Response.json({error:null},{status:413});}chunks.push(next.value);}
  const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':type}}).formData();
  const file=form.get('file'),payload=form.get('payload');
  if(!(file instanceof Blob)||typeof payload!=='string')return Response.json({error:null},{status:400});
  const input=employeeImportUploadInput(JSON.parse(payload));
  const name=importSourceName(file instanceof File?file.name:'',input.fileName||'employees.csv');
  const result=await commitEmployeeImportUpload(ctx,input,{name,content:Buffer.from(await file.arrayBuffer()),operationKey:request.headers.get('x-upload-operation')??undefined});
  revalidatePath('/admin/personnel','layout');revalidatePath('/admin/personnel/import');revalidatePath('/admin/personnel/import/history');
  return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const known=error instanceof ImportHistoryError;
  if(!known)console.error('[employee import upload]',error);
  return Response.json({error:publicErrorMessage(error)},{status:400,headers:{'Cache-Control':'private, no-store'}});
 }finally{reader.releaseLock();}
}
