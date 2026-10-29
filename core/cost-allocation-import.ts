import {normalizeEmployeeCode,isValidEmployeeCode} from '../lib/employee-code';
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,isNull,lte,gt,or,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,costCenter,employment,employmentCostAllocationHead,employmentCostAllocationSet as allocationSet,employmentCostAllocationRow as allocationRow} from '../db/schema';
import {assertWorkforceCompanyTx,workforceEmploymentPredicate} from './workforce-access';
import {lockLabelCriteriaTx,visibleLabelIdsCondition} from './system-labels';
import {provenCompanyDatesTx} from './employment-company';
import {prepareCostAllocationsTx,saveEmploymentCostAllocations} from './employment-cost-allocations';
import {normalizedAllocationRows,CostAllocationError,percentageHundredths,formatAllocationPercent,ALLOCATION_SHEET} from '../lib/employment-cost-allocation';
import {allocationBindingKey,companyCodeKey,parseCostAllocationCsv,AllocationFileError,type AllocationImportRecords,type AllocationImportGroup,type AllocationImportPreview,type CostAllocationImportPlan} from '../lib/cost-allocation-import';
import type {AllocationWorkbookReferences} from '../lib/cost-allocation-workbook';
import {workbookToCsvTexts} from '../lib/spreadsheet';
import {createImportAttemptTx,importAttemptEventsTx,importAttemptItemsTx,lockImportAttemptTx,recordImportEventTx,recordImportFailure,recordImportItemTx,sealImportPlan,ImportHistoryError,IMPORT_SOURCE_MAX_BYTES,type ImportAttemptItemRow,type ImportRevertHandler} from './import-history';
export type NewAllocationEmployee={companyId:string;employeeCode:string;hiredOn:string;index:number};
type CompanyRef={id:string;name:string;label:string|null;registration:string|null};
/** The Company Code shown to users: the company label, else its registration number, else its legal name. */
export const allocationCompanyCode=(c:Pick<CompanyRef,'name'|'label'|'registration'>)=>c.label?.trim()||c.registration?.trim()||c.name;
/** Live companies the actor can maintain allocations for. Archived companies are never candidates. */
async function maintainableCompaniesTx(tx:Tx):Promise<CompanyRef[]>{
 return tx.select({id:company.id,name:company.legalName,label:company.companyLabel,registration:company.registrationNo}).from(company)
  .where(and(isNull(company.archivedAt),sql`app.access_workforce_company(${company.id},'workforce.maintain')`)).orderBy(asc(company.legalName),asc(company.id));
}
/** Payroll-history matcher rules: label, registration number or legal name; the internal id is never accepted. */
export function matchAllocationCompany(companies:CompanyRef[],raw:string):{company:CompanyRef}|{error:'missing'|'unknown'|'ambiguous'}{
 const code=companyCodeKey(raw);if(!code)return{error:'missing'};
 const candidates=companies.filter(c=>[c.label,c.registration,c.name].some(v=>companyCodeKey(v)===code));
 return candidates.length===1?{company:candidates[0]}:{error:candidates.length?'ambiguous':'unknown'};
}
export async function costAllocationReferencesTx(tx:Tx,ctx:SessionContext,companyId:string){
 z.uuid().parse(companyId);await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');const[live]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,companyId),isNull(company.archivedAt)));if(!live)throw new CostAllocationError('scope');
 return tx.select({companyId:sql<string>`${companyId}`,id:costCenter.id,code:costCenter.code,label:costCenter.label}).from(costCenter).where(and(isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[companyId]))).orderBy(asc(costCenter.code),asc(costCenter.id));
}
export function costAllocationReferences(ctx:SessionContext,companyId:string){return withTenant(ctx,tx=>costAllocationReferencesTx(tx,ctx,companyId));}
/** One template for every company the actor may maintain (c4055300); no company is chosen first. */
export function costAllocationWorkbookReferences(ctx:SessionContext):Promise<AllocationWorkbookReferences>{
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select app.access_workforce_write_lock()`);
  const companies=await maintainableCompaniesTx(tx),result:AllocationWorkbookReferences={companies:[],costCenters:[]};
  for(const c of companies){
   const code=allocationCompanyCode(c);result.companies.push({code,name:c.name});
   for(const ref of await costAllocationReferencesTx(tx,ctx,c.id))result.costCenters.push({companyCode:code,code:ref.code,label:ref.label});
  }
  return result;
 });
}
const rowsLabel=(rowNums:number[])=>rowNums.length===1?`Row ${rowNums[0]}`:`Rows ${rowNums.join(', ')}`;
const companyLabel=(c:CompanyRef)=>`${allocationCompanyCode(c)} (${c.name})`;

export async function previewCostAllocationImportTx(tx:Tx,ctx:SessionContext,records:AllocationImportRecords,newEmployees?:NewAllocationEmployee[]):Promise<AllocationImportPreview>{
 if(records.length>5000)throw new CostAllocationError('invalid');await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLabelCriteriaTx(tx,ctx.tenantId);
 const companies=await maintainableCompaniesTx(tx);
 const groups=new Map<string,AllocationImportGroup>(),snapshots:unknown[]=[];
 for(const[at,r]of records.entries()){
  if(Object.values(r).every(v=>!String(v??'').trim()))continue;
  const employeeCode=normalizeEmployeeCode(r.employee_code??''),companyCode=(r.company_code??'').trim(),effectiveDate=(r.effective_date??'').trim(),operation=(r.operation??'').trim().toLowerCase();
  const key=`${companyCodeKey(companyCode)}|${employeeCode}|${effectiveDate}`;let g=groups.get(key);
  if(!g){g={key,companyCode,companyId:'',employeeCode,effectiveDate,operation:operation==='clear'?'clear':'replace',rows:[],rowNums:[],errors:[],expectedRevision:0};groups.set(key,g);}
  g.rowNums.push(at+2);
  if(operation!==g.operation||!['replace','clear'].includes(operation))g.errors.push(`Row ${at+2}: Operation must be Replace or Clear, and the same on every row for one employee and date.`);
  if(g.operation==='clear'){if(r.cost_center_code?.trim()||r.percentage?.trim()||g.rowNums.length>1)g.errors.push(`Row ${at+2}: Clear needs exactly one row with a blank Cost Center Code and Percentage.`);continue;}
  try{percentageHundredths(r.percentage);}catch(e){g.errors.push(`Row ${at+2} (${r.cost_center_code}): ${(e as Error).message}`);}
 }
 const referenceCache=new Map<string,Awaited<ReturnType<typeof costAllocationReferencesTx>>>();
 for(const g of groups.values()){
  const rows=rowsLabel(g.rowNums);
  const matched=matchAllocationCompany(companies,g.companyCode);
  if('error' in matched){g.errors.push(matched.error==='missing'?`${rows}: Company Code is required.`:matched.error==='ambiguous'?`${rows}: Company Code "${g.companyCode}" matches more than one company. Use the Company Code listed on the Reference sheet.`:`${rows}: Company Code "${g.companyCode}" does not match a company you can import for.`);continue;}
  const co=matched.company;g.companyId=co.id;g.companyName=co.name;
  if(!z.iso.date().safeParse(g.effectiveDate).success){g.errors.push(`${rows}: Effective Date must be a date in YYYY-MM-DD form.`);continue;}
  if(!isValidEmployeeCode(g.employeeCode)){g.errors.push(`${rows}: Employee ID is missing or invalid.`);continue;}
  try{
   let references=referenceCache.get(co.id);if(!references){references=await costAllocationReferencesTx(tx,ctx,co.id);referenceCache.set(co.id,references);snapshots.push([co.id,references]);}
   const inputRows=g.rowNums.map(n=>records[n-2]);
   if(g.operation==='replace')for(const[i,r]of inputRows.entries()){const found=references.filter(c=>c.code.trim().toLowerCase()===r.cost_center_code?.trim().toLowerCase());if(found.length!==1)g.errors.push(`Row ${g.rowNums[i]} (${r.cost_center_code}): this Cost Center Code is not available for ${companyLabel(co)}.`);else {g.rows.push({costCenterId:found[0].id,percentage:r.percentage});(g.displayRows??=[]).push({code:found[0].code,percentage:r.percentage});}}
   if(!g.errors.length)normalizedAllocationRows(g.rows,g.operation);
   if(newEmployees){
    const candidates=newEmployees.filter(e=>allocationBindingKey(e.companyId,e.employeeCode)===allocationBindingKey(g.companyId,g.employeeCode));
    if(candidates.length!==1||g.effectiveDate<candidates[0].hiredOn)throw new CostAllocationError('binding');g.newEmployeeIndex=candidates[0].index;
   }else{
    // The employee is matched WITHIN the row's company on the effective date, never tenant-wide.
    const candidates=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.employeeCode,g.employeeCode),workforceEmploymentPredicate(sql`${employment.id}`,'maintain'))).orderBy(asc(employment.id));
    const proof=candidates.length?await provenCompanyDatesTx(tx,candidates.map(c=>({employmentId:c.id,date:g.effectiveDate}))):new Map();
    const matches=candidates.filter(c=>proof.get(`${c.id}|${g.effectiveDate}`)?.companyId===co.id);
    if(matches.length!==1){g.errors.push(matches.length?`${rows}: Employee ID ${g.employeeCode} matches more than one employee of ${companyLabel(co)}.`:`${rows}: Employee ID ${g.employeeCode} is not an employee of ${companyLabel(co)} on ${g.effectiveDate}.`);continue;}
    g.employmentId=matches[0].id;
    const[h]=await tx.select().from(employmentCostAllocationHead).where(eq(employmentCostAllocationHead.employmentId,g.employmentId));g.expectedRevision=h?.revision??0;
    if(!g.errors.length){const p=await prepareCostAllocationsTx(tx,ctx,{employmentId:g.employmentId,effectiveDate:g.effectiveDate,expectedRevision:g.expectedRevision,operation:g.operation,rows:g.rows});if(p.companyId!==g.companyId)throw new CostAllocationError('binding');snapshots.push(p.digest);}
   }
  }catch(e){g.errors.push(`${rows}: ${e instanceof CostAllocationError?e.message:'The allocation company, employee or effective date is unavailable.'}`);}
 }
 if(!newEmployees){
  // Each employee's dated sets are saved together, so one invalid set holds back that employee's others.
  const invalid=new Set([...groups.values()].filter(g=>g.errors.length&&g.employmentId).map(g=>g.employmentId));
  for(const g of groups.values())if(!g.errors.length&&g.employmentId&&invalid.has(g.employmentId))g.errors.push(`${rowsLabel(g.rowNums)}: Another allocation for Employee ID ${g.employeeCode} in this file has errors, so this employee is not imported. Correct that row first.`);
 }
 const result=[...groups.values()];const token=createHash('sha256').update(JSON.stringify({actor:ctx.userId,tenant:ctx.tenantId,records,newEmployees,result,snapshots})).digest('hex');
 return{groups:result,token,validCount:result.filter(g=>!g.errors.length).length};
}
export function previewCostAllocationImport(ctx:SessionContext,records:AllocationImportRecords){return withTenant(ctx,tx=>previewCostAllocationImportTx(tx,ctx,records));}

/** Reads the uploaded file. A workbook's "Cost Center Allocations" sheet is used, else its first sheet. */
export async function readCostAllocationSource(name:string,content:Buffer):Promise<AllocationImportRecords>{
 if(content.length>IMPORT_SOURCE_MAX_BYTES)throw new AllocationFileError('Choose a file no larger than 10 MB.');
 const lower=name.toLowerCase();let text:string;
 if(lower.endsWith('.xlsx')||lower.endsWith('.xls')){
  let decoded:Awaited<ReturnType<typeof workbookToCsvTexts>>;
  try{decoded=await workbookToCsvTexts(content,[ALLOCATION_SHEET],true,undefined,false,true);}catch{throw new AllocationFileError('The workbook could not be read. Download the template and try again.');}
  text=decoded.extra[ALLOCATION_SHEET]??decoded.first;
 }else if(lower.endsWith('.csv')){
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{throw new AllocationFileError('Save the CSV file as UTF-8.');}
 }else throw new AllocationFileError('Choose the .xlsx template or a .csv file with the same columns.');
 return parseCostAllocationCsv(text);
}
const fileMessage=(e:unknown)=>e instanceof AllocationFileError?e.message:'This file could not be read.';
const storedGroup=(g:AllocationImportGroup):AllocationImportGroup=>({key:g.key,companyCode:g.companyCode,companyId:g.companyId,...(g.companyName?{companyName:g.companyName}:{}),employeeCode:g.employeeCode,effectiveDate:g.effectiveDate,operation:g.operation,rows:g.rows,rowNums:g.rowNums,...(g.displayRows?{displayRows:g.displayRows}:{}),errors:g.errors,...(g.employmentId?{employmentId:g.employmentId}:{}),expectedRevision:g.expectedRevision});
/** Validates an upload and records it as an import attempt with the original file. Nothing is saved yet. */
export async function previewCostAllocationUpload(ctx:SessionContext,input:{name:string;content:Buffer;operationKey?:string}){
 let records:AllocationImportRecords=[],parseError:string|undefined;
 try{records=await readCostAllocationSource(input.name,input.content);}catch(e){parseError=fileMessage(e);}
 if(!parseError&&!records.some(r=>Object.values(r).some(v=>String(v??'').trim())))parseError='The file has no allocation rows.';
 return withTenant(ctx,async tx=>{
  const preview=parseError?null:await previewCostAllocationImportTx(tx,ctx,records);
  const groups=(preview?.groups??[]).map(storedGroup);
  const plan=sealImportPlan<CostAllocationImportPlan>({version:1,kind:'cost_allocations',token:preview?.token??'',groups,counts:{total:groups.length,valid:preview?.validCount??0,invalid:groups.length-(preview?.validCount??0)},issues:parseError?[{rowNum:1,reason:parseError}]:[],previewHash:''});
  const companyIds=[...new Set(groups.map(g=>g.companyId).filter(Boolean))];
  const created=await createImportAttemptTx(tx,ctx,{kind:'cost_allocations',sourceName:input.name,content:input.content,companyIds,plan,operationKey:input.operationKey});
  return{attemptId:created.attemptId,plan:created.plan};
 });
}
type AllocationSnapshot={setId:string|null;operation:'none'|'replace'|'clear';rows:{costCenterId:string;code:string;label:string;hundredths:number}[]};
export type CostAllocationItemState=AllocationSnapshot&{headRevision:number;effectiveDate:string;employeeCode:string;companyCode:string};
async function allocationAtTx(tx:Tx,employmentId:string,date:string):Promise<AllocationSnapshot>{
 const[current]=await tx.select({id:allocationSet.id,operation:allocationSet.operation}).from(allocationSet).where(and(eq(allocationSet.employmentId,employmentId),isNull(allocationSet.supersededAt),lte(allocationSet.validFrom,date),or(isNull(allocationSet.validTo),gt(allocationSet.validTo,date))));
 if(!current)return{setId:null,operation:'none',rows:[]};
 const rows=await tx.select({costCenterId:allocationRow.costCenterId,code:allocationRow.codeSnapshot,label:allocationRow.labelSnapshot,hundredths:allocationRow.hundredths}).from(allocationRow).where(eq(allocationRow.setId,current.id)).orderBy(asc(allocationRow.codeSnapshot),asc(allocationRow.costCenterId));
 return{setId:current.id,operation:current.operation as 'replace'|'clear',rows};
}
async function headRevisionTx(tx:Tx,employmentId:string){const[h]=await tx.select({revision:employmentCostAllocationHead.revision}).from(employmentCostAllocationHead).where(eq(employmentCostAllocationHead.employmentId,employmentId));return h?.revision??0;}
export type CostAllocationImportResult={attemptId:string;succeeded:number;failed:number;alreadyCommitted:boolean;results:{key:string;employeeCode:string;effectiveDate:string;rowNums:number[];saved:boolean;errors:string[]}[]};
/**
 * Saves a validated attempt. The source is re-read and re-validated under lock and must reproduce the
 * reviewed preview. Each employee's dated sets are saved in their own transaction (latest date first, so a
 * revert can restore them newest-first), so one employee's failure never undoes another's.
 */
export async function confirmCostAllocationUpload(ctx:SessionContext,input:{attemptId:string;previewHash:string}):Promise<CostAllocationImportResult>{
 let prepared:{plan:CostAllocationImportPlan;preview:AllocationImportPreview}|{already:CostAllocationImportResult};
 try{
  prepared=await withTenant(ctx,async tx=>{
   await lockAllocationWritersTx(tx,ctx);
   const source=await lockImportAttemptTx(tx,ctx,input.attemptId,'cost_allocations');const plan=source.plan as unknown as CostAllocationImportPlan;
   const events=await importAttemptEventsTx(tx,source.id);
   if(events.some(e=>e.kind==='reverted'))throw new ImportHistoryError('This import was reverted. Upload the file again to import it.');
   const confirmed=events.find(e=>e.kind==='confirmed');
   if(confirmed)return{already:{attemptId:source.id,succeeded:Number(confirmed.detail.succeeded??0),failed:Number(confirmed.detail.failed??0),alreadyCommitted:true,results:[]}};
   if((await importAttemptItemsTx(tx,source.id)).length)throw new ImportHistoryError('This import is already being saved.');
   if(input.previewHash!==plan.previewHash||plan.issues.length||!plan.counts.valid)throw new ImportHistoryError('Correct the file and upload it again before saving.');
   const[covers]=await tx.execute<{ok:boolean}>(sql`select app.import_attempt_access(${source.id}::uuid,'maintain',true) as ok`);
   if(!covers?.ok)throw new ImportHistoryError('Your permission for a company in this file has changed. Upload the file again.');
   const preview=await previewCostAllocationImportTx(tx,ctx,await readCostAllocationSource(source.sourceName,source.sourceContent));
   if(preview.token!==plan.token)throw new ImportHistoryError('Allocations, cost centers or permissions changed since this file was checked. Upload it again.');
   return{plan,preview};
  });
 }catch(error){await recordImportFailure(ctx,input.attemptId,'cost_allocations','failed',error);throw error;}
 if('already' in prepared)return prepared.already;
 const{preview}=prepared,results:CostAllocationImportResult['results']=[];
 const byEmployment=new Map<string,AllocationImportGroup[]>();
 for(const g of preview.groups)if(!g.errors.length&&g.employmentId){const list=byEmployment.get(g.employmentId)??[];list.push(g);byEmployment.set(g.employmentId,list);}
 let succeeded=0,failed=0;
 const employees=[...byEmployment.entries()].sort(([,a],[,b])=>Math.min(...a.flatMap(g=>g.rowNums))-Math.min(...b.flatMap(g=>g.rowNums)));
 for(const[employmentId,list]of employees){
  const ordered=[...list].sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate));
  try{
   await withTenant(ctx,async tx=>{
    await lockAllocationWritersTx(tx,ctx);
    await lockImportAttemptTx(tx,ctx,input.attemptId,'cost_allocations');
    let revision=await headRevisionTx(tx,employmentId);
    if(revision!==ordered[0].expectedRevision)throw new CostAllocationError('changed');
    for(const g of ordered){
     const before=await allocationAtTx(tx,employmentId,g.effectiveDate),beforeRevision=revision;
     const saved=await saveEmploymentCostAllocations(ctx,{employmentId,effectiveDate:g.effectiveDate,expectedRevision:revision,operation:g.operation,rows:g.rows},{existingTx:tx,source:'allocation-import'});revision=saved.revision;
     const after=await allocationAtTx(tx,employmentId,g.effectiveDate),common={effectiveDate:g.effectiveDate,employeeCode:g.employeeCode,companyCode:g.companyCode};
     await recordImportItemTx(tx,ctx,{attemptId:input.attemptId,companyId:g.companyId,employmentId,itemKey:g.key,label:`${g.employeeCode} · ${g.effectiveDate}`,ordinal:Math.min(...g.rowNums),status:'applied',before:{...before,...common,headRevision:beforeRevision} satisfies CostAllocationItemState,after:{...after,...common,headRevision:saved.revision} satisfies CostAllocationItemState});
    }
   });
   for(const g of ordered)results.push({key:g.key,employeeCode:g.employeeCode,effectiveDate:g.effectiveDate,rowNums:g.rowNums,saved:true,errors:[]});succeeded+=ordered.length;
  }catch(error){
   const message=error instanceof CostAllocationError||error instanceof ImportHistoryError?error.message:'This employee could not be saved; nothing was changed for them.';
   if(!(error instanceof CostAllocationError||error instanceof ImportHistoryError))console.error('[cost allocation import employee]',error);
   for(const g of ordered)results.push({key:g.key,employeeCode:g.employeeCode,effectiveDate:g.effectiveDate,rowNums:g.rowNums,saved:false,errors:[message]});failed+=ordered.length;
   try{await withTenant(ctx,async tx=>{for(const g of ordered)await recordImportItemTx(tx,ctx,{attemptId:input.attemptId,companyId:g.companyId,employmentId,itemKey:g.key,label:`${g.employeeCode} · ${g.effectiveDate}`,ordinal:Math.min(...g.rowNums),status:'failed',errors:[message]});});}catch(recordError){console.error('[cost allocation import failure item]',recordError);}
  }
 }
 const invalid=preview.groups.filter(g=>g.errors.length);
 for(const g of invalid)results.push({key:g.key,employeeCode:g.employeeCode,effectiveDate:g.effectiveDate,rowNums:g.rowNums,saved:false,errors:g.errors});failed+=invalid.length;
 results.sort((a,b)=>Math.min(...a.rowNums)-Math.min(...b.rowNums));
 try{
  await withTenant(ctx,async tx=>{
   await lockImportAttemptTx(tx,ctx,input.attemptId,'cost_allocations');
   for(const g of invalid)if(g.companyId)await recordImportItemTx(tx,ctx,{attemptId:input.attemptId,companyId:g.companyId,employmentId:g.employmentId??null,itemKey:g.key,label:`${g.employeeCode} · ${g.effectiveDate}`,ordinal:Math.min(...g.rowNums),status:'failed',errors:g.errors});
   await recordImportEventTx(tx,ctx,{attemptId:input.attemptId,kind:'confirmed',importKind:'cost_allocations',detail:{succeeded,failed}});
  });
 }catch(error){
  if(String((error as {message?:string})?.message??'').includes('import_attempt_confirm_once_uq'))return{attemptId:input.attemptId,succeeded,failed,alreadyCommitted:true,results};
  throw error;
 }
 return{attemptId:input.attemptId,succeeded,failed,alreadyCommitted:false,results};
}

/**
 * Revert (c4055300): eligible only while each employee's allocation head revision still equals the revision
 * the import left. The earlier allocation (or a clear when there was none) is re-committed at the same
 * effective date through the single allocation writer, newest import write first, with source import-revert.
 */
const itemState=(value:unknown)=>value as CostAllocationItemState;
/** Writer locks always precede the attempt row lock, in confirm and revert alike, so they cannot deadlock. */
async function lockAllocationWritersTx(tx:Tx,ctx:SessionContext){await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLabelCriteriaTx(tx,ctx.tenantId);}
export const costAllocationRevertHandler:ImportRevertHandler={
 kind:'cost_allocations',
 lock:(tx,ctx)=>lockAllocationWritersTx(tx,ctx),
 async inspect(tx,_ctx,items){
  const byEmployment=new Map<string,ImportAttemptItemRow[]>();
  for(const i of items){const list=byEmployment.get(i.employmentId!)??[];list.push(i);byEmployment.set(i.employmentId!,list);}
  const out:{itemId:string;blockers:string[];restore:unknown}[]=[],fingerprint:Record<string,number>={};
  const proof=await provenCompanyDatesTx(tx,items.map(i=>({employmentId:i.employmentId!,date:itemState(i.after).effectiveDate})));
  for(const[employmentId,list]of byEmployment){
   const[access]=await tx.execute<{ok:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.maintain') as ok`);
   const current=access?.ok?await headRevisionTx(tx,employmentId):-1;fingerprint[employmentId]=current;
   const left=Math.max(...list.map(i=>itemState(i.after).headRevision));
   for(const i of list){
    const before=itemState(i.before),after=itemState(i.after),blockers:string[]=[];
    if(!access?.ok)blockers.push('You no longer have permission to maintain this employee.');
    else if(current!==left)blockers.push('This employee\'s cost center allocation has been changed since this import.');
    if(proof.get(`${employmentId}|${after.effectiveDate}`)?.companyId!==i.companyId)blockers.push('The employee\'s company on the effective date has changed since this import.');
    if(before.rows.length){
     const ids=before.rows.map(r=>r.costCenterId);
     const live=await tx.select({id:costCenter.id}).from(costCenter).where(and(inArray(costCenter.id,ids),isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[i.companyId])));
     const liveIds=new Set(live.map(r=>r.id));
     for(const r of before.rows)if(!liveIds.has(r.costCenterId))blockers.push(`Cost center ${r.code} is no longer available for this company, so the earlier allocation cannot be restored.`);
    }
    out.push({itemId:i.id,blockers,restore:{effectiveDate:after.effectiveDate,operation:before.rows.length?'replace':'clear',rows:before.rows.map(r=>({code:r.code,label:r.label,percentage:formatAllocationPercent(r.hundredths)}))}});
   }
  }
  return{items:out,fingerprint};
 },
 async apply(tx,ctx,items){
  const byEmployment=new Map<string,ImportAttemptItemRow[]>();
  for(const i of items){const list=byEmployment.get(i.employmentId!)??[];list.push(i);byEmployment.set(i.employmentId!,list);}
  let restored=0;
  for(const[employmentId,list]of [...byEmployment.entries()].sort(([a],[b])=>a.localeCompare(b))){
   let revision=await headRevisionTx(tx,employmentId);
   for(const i of [...list].sort((a,b)=>itemState(b.after).headRevision-itemState(a.after).headRevision)){
    const before=itemState(i.before),after=itemState(i.after);
    const rows=before.rows.map(r=>({costCenterId:r.costCenterId,percentage:formatAllocationPercent(r.hundredths)}));
    const saved=await saveEmploymentCostAllocations(ctx,{employmentId,effectiveDate:after.effectiveDate,expectedRevision:revision,operation:rows.length?'replace':'clear',rows},{existingTx:tx,source:'import-revert'});revision=saved.revision;restored++;
   }
  }
  return{employees:byEmployment.size,sets:restored};
 },
};
/** Called only inside the actual employee creation transaction, after its assignment spine exists. */
export async function writeNewEmployeeCostAllocationsTx(tx:Tx,ctx:SessionContext,groups:AllocationImportGroup[],employeeIndex:number,employmentId:string){
 let revision=0;for(const g of groups.filter(g=>g.newEmployeeIndex===employeeIndex).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate))){
  if(g.errors.length)throw new CostAllocationError('invalid');await saveEmploymentCostAllocations(ctx,{employmentId,effectiveDate:g.effectiveDate,expectedRevision:revision,operation:g.operation,rows:g.rows},{existingTx:tx,source:'employee-import'});revision++;
 }
}
export {AllocationFileError};
