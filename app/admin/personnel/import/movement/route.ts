import {getTranslations} from 'next-intl/server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {movementImportTemplateData} from '@/core/movement-import';
import {previewMovementUpload,confirmMovementUpload} from '@/core/movement-import-history';
import {ImportHistoryError} from '@/core/import-history';
import {buildMovementWorkbook,MOVEMENT_WORKBOOK_LIMITS} from '@/lib/movement-workbook.server';
export const runtime='nodejs';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
async function form(request:Request){
 const type=request.headers.get('content-type');if(!type?.startsWith('multipart/form-data')||!request.body)throw new Error('invalid_file');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>MOVEMENT_WORKBOOK_LIMITS.maxBytes+1_600_000){await reader.cancel();throw new Error('file_too_large');}chunks.push(chunk.value);}
 return new Response(Buffer.concat(chunks),{headers:{'Content-Type':type}}).formData();
}
const download=(bytes:Buffer,name:string)=>new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'private, no-store'}});
/**
 * ac6645ec — one template, no company or movement-type selection. `preview` records the upload (original
 * bytes) as an import attempt; `apply` names only that attempt, its reviewed preview hash and the chosen
 * employees: the server re-reads the stored file, so neither rows nor fingerprints come from the browser.
 */
export async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return reply({ok:false,error:'origin'},403);
 const ctx=await requireAdmin(),t=await getTranslations(),resolve=(key:string,fallback:string)=>t.has(key)?t(key):fallback;
 try{
  const data=await form(request),operation=String(data.get('operation')??'');
  if(operation==='download'){
   const template=await movementImportTemplateData(ctx);
   return download(await buildMovementWorkbook({tenantId:ctx.tenantId,types:template.types,companies:template.companies,resolve}),'movement-import.xlsx');
  }
  if(operation==='preview'){
   const file=data.get('file');if(!(file instanceof File))throw new Error('invalid_file');
   if(file.size>MOVEMENT_WORKBOOK_LIMITS.maxBytes)throw new Error('file_too_large');
   const operationKey=String(data.get('operationKey')??'')||undefined;
   const checked=await previewMovementUpload(ctx,{name:file.name,content:Buffer.from(await file.arrayBuffer()),operationKey,resolve});
   revalidatePath('/admin/personnel/import/history');
   return reply({ok:true,...checked});
  }
  if(operation==='apply'){
   const raw=String(data.get('employees')??'');if(raw.length>20000)throw new Error('invalid_selection');
   let employees:unknown;try{employees=JSON.parse(raw);}catch{throw new Error('invalid_selection');}
   if(!Array.isArray(employees)||employees.length>200||employees.some(key=>typeof key!=='string'||key.length>300))throw new Error('invalid_selection');
   const result=await confirmMovementUpload(ctx,{attemptId:String(data.get('attemptId')??''),previewHash:String(data.get('previewHash')??''),employees:employees as string[],acknowledgeExcluded:data.get('acknowledgeExcluded')==='true',
    // 646355e5 slice C — the closed-payroll confirmation box; the server decides where it is needed.
    acknowledgeClosedPayroll:data.get('acknowledgeClosedPayroll')==='true',resolve});
   if(result.imported){revalidatePath('/admin/personnel');for(const employee of result.employees)if(employee.employmentId)revalidatePath('/admin/personnel/'+employee.employmentId);}
   revalidatePath('/admin/personnel/import/history');
   return reply({ok:true,result});
  }
  throw new Error('invalid_file');
 }catch(error){
  if(error instanceof ImportHistoryError)return reply({ok:false,message:error.message},400);
  // Database wrappers contain SQL/bound values. Only finite application codes are presentation data.
  const raw=error instanceof Error&&!('query'in error)&&!('cause'in error)?error.message:'';
  const code=/^(?:workbook_[a-z_]+|file_too_large|invalid_file|unknown_or_inactive_event_type|too_many_employees|movement_reference_catalog_too_large|whole_employee_selection_required|invalid_selection|preview_changed|confirm_excluded_rows|select_valid_rows)$/.test(raw)?raw:'change_refused';
  if(code==='change_refused')console.error('[movement import]',error);
  return reply({ok:false,error:code},400);
 }
}
