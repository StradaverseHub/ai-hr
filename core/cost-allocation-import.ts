import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {company,costCenter,employment,employmentCostAllocationHead} from '../db/schema';
import {assertWorkforceCompanyTx,workforceEmploymentPredicate} from './workforce-access';
import {lockLabelCriteriaTx,visibleLabelIdsCondition} from './system-labels';
import {prepareCostAllocationsTx,saveEmploymentCostAllocations} from './employment-cost-allocations';
import {normalizedAllocationRows,CostAllocationError,percentageHundredths} from '../lib/employment-cost-allocation';
import {allocationBindingKey,type AllocationImportRecords,type AllocationImportGroup,type AllocationImportPreview} from '../lib/cost-allocation-import';
export type NewAllocationEmployee={companyId:string;employeeCode:string;hiredOn:string;index:number};
export async function costAllocationReferencesTx(tx:Tx,ctx:SessionContext,companyId:string){
 z.uuid().parse(companyId);await assertWorkforceCompanyTx(tx,ctx,companyId,'maintain');const[live]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,companyId),isNull(company.archivedAt)));if(!live)throw new CostAllocationError('scope');
 return tx.select({companyId:sql<string>`${companyId}`,id:costCenter.id,code:costCenter.code,label:costCenter.label}).from(costCenter).where(and(isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[companyId]))).orderBy(asc(costCenter.code),asc(costCenter.id));
}
export function costAllocationReferences(ctx:SessionContext,companyId:string){return withTenant(ctx,tx=>costAllocationReferencesTx(tx,ctx,companyId));}
/** The chosen company must be writable. Other catalogues are narrowed before names or counts leave. */
export function costAllocationWorkbookReferences(ctx:SessionContext,companyIds:string[],selectedCompanyId:string){
 const ids=z.array(z.uuid()).max(500).parse(companyIds);z.uuid().parse(selectedCompanyId);
 if(!ids.includes(selectedCompanyId))throw new CostAllocationError('scope');
 return withTenant(ctx,async tx=>{
  const selected=await costAllocationReferencesTx(tx,ctx,selectedCompanyId);
  const permitted=await tx.select({id:company.id}).from(company).where(and(inArray(company.id,ids),isNull(company.archivedAt),sql`app.access_workforce_company(${company.id},'workforce.maintain')`)).orderBy(asc(company.id));
  const result=[...selected];for(const row of permitted)if(row.id!==selectedCompanyId)result.push(...await costAllocationReferencesTx(tx,ctx,row.id));return result;
 });
}

export async function previewCostAllocationImportTx(tx:Tx,ctx:SessionContext,records:AllocationImportRecords,newEmployees?:NewAllocationEmployee[]):Promise<AllocationImportPreview>{
 if(records.length>5000)throw new CostAllocationError('invalid');await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLabelCriteriaTx(tx,ctx.tenantId);
 const groups=new Map<string,AllocationImportGroup>(),snapshots:unknown[]=[];
 for(const[at,r]of records.entries()){
  if(Object.values(r).every(v=>!String(v).trim()))continue;
  const key=[r.company_id,r.employee_code,r.effective_date].map(v=>v?.trim()??'').join('|');let g=groups.get(key);
  if(!g){g={key,companyId:r.company_id?.trim()??'',employeeCode:r.employee_code?.trim()??'',effectiveDate:r.effective_date?.trim()??'',operation:r.operation==='clear'?'clear':'replace',rows:[],rowNums:[],errors:[],expectedRevision:0};groups.set(key,g);}
  g.rowNums.push(at+2);
  if(r.operation!==g.operation||!['replace','clear'].includes(r.operation))g.errors.push(`Row ${at+2}: use one explicit replace or clear operation per employee and date.`);
  if(g.operation==='clear'){if(r.cost_center_code?.trim()||r.percentage?.trim()||g.rowNums.length>1)g.errors.push(`Row ${at+2}: clear requires one row with blank code and percentage.`);continue;}
  try{percentageHundredths(r.percentage);}catch(e){g.errors.push(`Row ${at+2} (${r.cost_center_code}): ${(e as Error).message}`);}
 }
 for(const g of groups.values()){
  try{
   z.uuid().parse(g.companyId);z.iso.date().parse(g.effectiveDate);if(!g.employeeCode)throw new CostAllocationError('binding');
   const references=await costAllocationReferencesTx(tx,ctx,g.companyId);snapshots.push([g.companyId,references]);
   const inputRows=records.filter((r,at)=>g.rowNums.includes(at+2));
   if(g.operation==='replace')for(const r of inputRows){const matched=references.filter(c=>c.code.trim().toLowerCase()===r.cost_center_code?.trim().toLowerCase());if(matched.length!==1)g.errors.push(`Row ${records.indexOf(r)+2} (${r.cost_center_code}): unknown, ambiguous, inactive or unavailable cost center code.`);else {g.rows.push({costCenterId:matched[0].id,percentage:r.percentage});(g.displayRows??=[]).push({code:matched[0].code,percentage:r.percentage});}}
   if(!g.errors.length)normalizedAllocationRows(g.rows,g.operation);
   if(newEmployees){
    const candidates=newEmployees.filter(e=>allocationBindingKey(e.companyId,e.employeeCode)===allocationBindingKey(g.companyId,g.employeeCode));
    if(candidates.length!==1||g.effectiveDate<candidates[0].hiredOn)throw new CostAllocationError('binding');g.newEmployeeIndex=candidates[0].index;
   }else{
    const matches=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.employeeCode,g.employeeCode),workforceEmploymentPredicate(sql`${employment.id}`,'maintain'))).orderBy(asc(employment.id));
    if(matches.length!==1)throw new CostAllocationError('binding');g.employmentId=matches[0].id;
    const[h]=await tx.select().from(employmentCostAllocationHead).where(eq(employmentCostAllocationHead.employmentId,g.employmentId));g.expectedRevision=h?.revision??0;
    if(!g.errors.length){const p=await prepareCostAllocationsTx(tx,ctx,{employmentId:g.employmentId,effectiveDate:g.effectiveDate,expectedRevision:g.expectedRevision,operation:g.operation,rows:g.rows});if(p.companyId!==g.companyId)throw new CostAllocationError('binding');snapshots.push(p.digest);}
   }
  }catch(e){g.errors.push(e instanceof CostAllocationError?e.message:'The allocation company, employee or effective date is unavailable.');}
 }
 const result=[...groups.values()];const token=createHash('sha256').update(JSON.stringify({actor:ctx.userId,tenant:ctx.tenantId,records,newEmployees,result,snapshots})).digest('hex');
 return{groups:result,token,validCount:result.filter(g=>!g.errors.length).length};
}
export function previewCostAllocationImport(ctx:SessionContext,records:AllocationImportRecords){return withTenant(ctx,tx=>previewCostAllocationImportTx(tx,ctx,records));}
export async function commitCostAllocationImport(ctx:SessionContext,records:AllocationImportRecords,token:string){
 return withTenant(ctx,async tx=>{
  const preview=await previewCostAllocationImportTx(tx,ctx,records);if(token!==preview.token)throw new CostAllocationError('preview');
  const results:{key:string;employmentId?:string;effectiveDate:string;rowNums:number[];saved:boolean;errors:string[]}[]=[];
  // Groups for the same employee are dated in order; each subsequent save uses the new owner revision.
  const revisions=new Map<string,number>();
  for(const g of [...preview.groups].sort((a,b)=>a.key.localeCompare(b.key))){
   if(g.errors.length){results.push({key:g.key,employmentId:g.employmentId,effectiveDate:g.effectiveDate,rowNums:g.rowNums,saved:false,errors:g.errors});continue;}
   const expectedRevision=revisions.get(g.employmentId!)??g.expectedRevision;
   await saveEmploymentCostAllocations(ctx,{employmentId:g.employmentId,effectiveDate:g.effectiveDate,expectedRevision,operation:g.operation,rows:g.rows},{existingTx:tx,source:'allocation-import'});revisions.set(g.employmentId!,expectedRevision+1);
   results.push({key:g.key,employmentId:g.employmentId,effectiveDate:g.effectiveDate,rowNums:g.rowNums,saved:true,errors:[]});
  }
  return results;
 });
}
/** Called only inside the actual employee creation transaction, after its assignment spine exists. */
export async function writeNewEmployeeCostAllocationsTx(tx:Tx,ctx:SessionContext,groups:AllocationImportGroup[],employeeIndex:number,employmentId:string){
 let revision=0;for(const g of groups.filter(g=>g.newEmployeeIndex===employeeIndex).sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate))){
  if(g.errors.length)throw new CostAllocationError('invalid');await saveEmploymentCostAllocations(ctx,{employmentId,effectiveDate:g.effectiveDate,expectedRevision:revision,operation:g.operation,rows:g.rows},{existingTx:tx,source:'employee-import'});revision++;
 }
}
