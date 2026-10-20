import {createHash} from 'node:crypto';
import {getTranslations} from 'next-intl/server';
import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {movementImportCatalog,movementImportDownloadData,previewMovementImport,commitMovementImport,type MovementImportFilters} from '@/core/movement-import';
import {buildMovementWorkbook,readMovementWorkbook,movementWorkbookCatalogue,MOVEMENT_WORKBOOK_LIMITS} from '@/lib/movement-workbook.server';
import {personnelImportLabelResolvers} from '@/lib/personnel-import-labels.server';
import {parseMovementTypeCsv} from '@/lib/movement-type-csv';
import {movementErrorReceipt,verifyMovementErrorReceipt,movementWorkbookSigningReady} from '@/lib/movement-workbook-metadata.server';
import type {MovementWorkbookBinding} from '@/lib/movement-workbook-metadata.server';
import type {MovementImportRecord,MovementImportEmployee} from '@/lib/movement-import-contract';
import {retainMovementExclusionReasons} from '@/lib/movement-import-contract';
export const runtime='nodejs';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});
async function form(request:Request){
 const type=request.headers.get('content-type');if(!type?.startsWith('multipart/form-data')||!request.body)throw new Error('invalid_file');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 for(;;){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.byteLength;if(total>MOVEMENT_WORKBOOK_LIMITS.maxBytes+1_600_000){await reader.cancel();throw new Error('file_too_large');}chunks.push(chunk.value);}
 return new Response(Buffer.concat(chunks),{headers:{'Content-Type':type}}).formData();
}
const json=(data:FormData,key:string,max:number)=>{const raw=String(data.get(key)??'');if(raw.length>max)throw new Error('invalid_file');try{return raw?JSON.parse(raw):undefined;}catch{throw new Error('invalid_file');}};
const download=(bytes:Buffer,name:string)=>new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'private, no-store'}});
/** A verified display receipt supplies reasons only. Freshly parsed source owns row/employee/type identity. */
function observedRows(rows:{row:number;errors:string[]}[],records:MovementImportRecord[]):MovementImportEmployee[]{
 const byKey=new Map(records.map(record=>[record.row,record])),seen=new Set<number>(),employees=new Map<string,MovementImportEmployee>();
 for(const row of rows){
  const record=byKey.get(row?.row);
  if(!record||!Number.isSafeInteger(row.row)||seen.has(row.row)||!Array.isArray(row.errors)||row.errors.length>200||row.errors.some(error=>typeof error!=='string'||error.length>1000))throw new Error('workbook_metadata_invalid');
  seen.add(row.row);let employee=employees.get(record.employeeCode);
  if(!employee){employee={employeeCode:record.employeeCode,employmentId:null,name:null,fingerprint:null,rows:[]};employees.set(record.employeeCode,employee);}
  employee.rows.push({row:record.row,employeeCode:record.employeeCode,eventType:record.cells.kind??'',effectiveDate:record.cells.effectiveDate??'',status:'excluded',errors:[...row.errors],source:record.source});
 }
 return [...employees.values()];
}
export async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return reply({ok:false,error:'origin'},403);
 const ctx=await requireAdmin(),t=await getTranslations(),resolve=(key:string,fallback:string)=>t.has(key)?t(key):fallback;
 try{
  const data=await form(request),operation=String(data.get('operation')??''),companyId=String(data.get('companyId')??''),typeCode=String(data.get('typeCode')??'');
  if(operation==='download'){
   const filters=json(data,'filters',15000) as MovementImportFilters|undefined;
   const projected=await movementImportDownloadData(ctx,{companyId,typeCode:typeCode||undefined,filters});
   return download(await buildMovementWorkbook({...projected,tenantId:ctx.tenantId,companyId,typeCode:typeCode||undefined,resolve}),'movement-import.xlsx');
  }
  if(!['preview','apply','errors'].includes(operation))throw new Error('invalid_file');
  const catalog=await movementImportCatalog(ctx,companyId),file=data.get('file');let sourceBindings:MovementWorkbookBinding[]|undefined;let sourceHash:string,records:MovementImportRecord[],fileErrors:string[];
  if(file instanceof File&&file.name.toLowerCase().endsWith('.xlsx')){
   if(file.size>MOVEMENT_WORKBOOK_LIMITS.maxBytes)throw new Error('file_too_large');
   const bytes=Buffer.from(await file.arrayBuffer()),parsed=await readMovementWorkbook(bytes,{tenantId:ctx.tenantId,companyId,catalog,resolve});
   sourceHash=createHash('sha256').update(bytes).digest('hex');records=parsed.records;fileErrors=parsed.fileErrors;sourceBindings=parsed.metadata.sheets;
  }else{
   if(!typeCode)throw new Error('single_type_required');const type=catalog.types.find(t=>t.code===typeCode);if(!type)throw new Error('unknown_or_inactive_event_type');
   if(file instanceof File&&(!file.name.toLowerCase().endsWith('.csv')||file.size>900000))throw new Error('invalid_file');
   const csv=file instanceof File?await file.text():String(data.get('csv')??'');const parsed=parseMovementTypeCsv(csv,type,resolve,personnelImportLabelResolvers);records=parsed.records;fileErrors=parsed.fileErrors;sourceHash=createHash('sha256').update(typeCode+'\0'+csv).digest('hex');
  }
  if(fileErrors.length)return reply({ok:true,preview:{inputHash:'',selection:[],fileErrors,employees:[],excluded:0,valid:0}});
  const input={companyId,csv:'',records,sourceHash,catalogueHash:movementWorkbookCatalogue(catalog)};
  if(operation==='preview'){
   const preview=await previewMovementImport(ctx,input);let previewErrorReceipt:string|undefined;
   if(movementWorkbookSigningReady())try{previewErrorReceipt=movementErrorReceipt({tenantId:ctx.tenantId,userId:ctx.userId??'',companyId,sourceHash,rows:preview.employees.flatMap(employee=>employee.rows.map(row=>({row:row.row,errors:row.errors})))});}catch{/* Display evidence is optional; keyless CSV remains usable. */}
   return reply({ok:true,preview,previewErrorReceipt});
  }
  if(operation==='errors'){
   // Derive errors from the current canonical preview; never turn client-supplied messages into a file.
   const token=String(data.get('errorReceipt')??'');
   const preview=token?{employees:observedRows(verifyMovementErrorReceipt(token,{tenantId:ctx.tenantId,userId:ctx.userId??'',companyId,sourceHash}),records)}:await previewMovementImport(ctx,input);
   const reportRows=token?new Set(preview.employees.flatMap(e=>e.rows.map(row=>row.row))):null;
   const reportRecords=reportRows?records.filter(record=>reportRows.has(record.row)):records;
   return download(await buildMovementWorkbook({tenantId:ctx.tenantId,companyId,companyName:catalog.companies.find(c=>c.value===companyId)?.label??'',catalog,subjects:[],sourceBindings,resolve,records:reportRecords,employees:preview.employees}),'movement-import-errors.xlsx');
  }
  const selection=json(data,'selection',3000),fingerprints=json(data,'fingerprints',15000),inputHash=String(data.get('inputHash')??'');
  if(!Array.isArray(selection)||!fingerprints||typeof fingerprints!=='object'||Array.isArray(fingerprints))throw new Error('invalid_selection');
  const previewToken=String(data.get('previewErrorReceipt')??'');
  const previous=data.has('previewErrorReceipt')?observedRows(verifyMovementErrorReceipt(previewToken,{tenantId:ctx.tenantId,userId:ctx.userId??'',companyId,sourceHash}),records):[];
  const canReportWorkbook=movementWorkbookSigningReady();
  const committed=await commitMovementImport(ctx,{...input,selection,inputHash,fingerprints,acknowledgeExcluded:data.get('acknowledgeExcluded')==='true'});
  const result={...committed,employees:retainMovementExclusionReasons(committed.employees,previous)};
  if(result.imported){revalidatePath('/admin/personnel');for(const employee of result.employees as MovementImportEmployee[])if(employee.employmentId)revalidatePath('/admin/personnel/'+employee.employmentId);}
  let errorReceipt:string|undefined;
  if(canReportWorkbook)try{errorReceipt=movementErrorReceipt({tenantId:ctx.tenantId,userId:ctx.userId??'',companyId,sourceHash,rows:result.employees.flatMap(e=>e.rows.filter(row=>row.status!=='imported').map(row=>({row:row.row,errors:row.errors})))});}catch{/* Optional display download must never conceal an already committed result. */}
  // The browser combines the untouched write result with its current preview once. Returning
  // already-restored errors makes that second pass mistake historical exclusions for fresh refusals.
  // Keep signed report explanations above; never restore identity or authority at the route boundary.
  return reply({ok:true,result:committed,errorReceipt,workbookReportUnavailable:!errorReceipt});
 }catch(error){
  // Database wrappers contain SQL/bound values. Only finite application codes are presentation data.
  const raw=error instanceof Error&&!('query'in error)&&!('cause'in error)?error.message:'';
  const code=/^(?:workbook_[a-z_]+|file_too_large|invalid_file|invalid_filter|single_type_required|unknown_or_inactive_event_type|too_many_employees|movement_reference_catalog_too_large|whole_employee_selection_required|invalid_selection|preview_changed|confirm_excluded_rows|select_valid_rows)$/.test(raw)?raw:'change_refused';
  return reply({ok:false,error:code},400);
 }
}
