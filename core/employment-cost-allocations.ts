/** One cost-distribution owner for manual entry, repeated-row imports and new-hire transactions. */
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,isNull,lte,or,gt,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment,company,costCenter,employmentCostAllocationHead as head,employmentCostAllocationSet as sets,employmentCostAllocationRow as rows} from '../db/schema';
import {tenantMutation} from '../db/tenant-mutation';
import {assertWorkforceEmploymentTx,assertWorkforceCompanyTx} from './workforce-access';
import {lockLabelCriteriaTx,visibleLabelIdsCondition} from './system-labels';
import {provenCompanyDatesTx} from './employment-company';
import {todayInKualaLumpur} from '../lib/hr-date';
import {allocationInputSchema,normalizedAllocationRows,CostAllocationError,type CostAllocationInput} from '../lib/employment-cost-allocation';
export {CostAllocationError} from '../lib/employment-cost-allocation';
async function subjectTx(tx:Tx,ctx:SessionContext,id:string,date:string,write=false){
 await assertWorkforceEmploymentTx(tx,ctx,id,write?'maintain':'view');
 if(write)await lockLabelCriteriaTx(tx,ctx.tenantId);
 const query=tx.select().from(employment).where(eq(employment.id,id));const[e]=await(write?query.for('update'):query);if(!e)throw new CostAllocationError('scope');
 const proof=(await provenCompanyDatesTx(tx,[{employmentId:id,date}])).get(`${id}|${date}`);if(!proof?.companyId)throw new CostAllocationError('date');
 await assertWorkforceCompanyTx(tx,ctx,proof.companyId,write?'maintain':'view');if(write){const[live]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,proof.companyId),isNull(company.archivedAt)));if(!live)throw new CostAllocationError('scope');}return{employment:e,companyId:proof.companyId};
}
export async function getEmploymentCostAllocations(ctx:SessionContext,employmentId:string,effectiveDate=todayInKualaLumpur()){
 const input=allocationInputSchema.pick({employmentId:true,effectiveDate:true}).parse({employmentId,effectiveDate});
 return withTenant(ctx,async tx=>{
  const subject=await subjectTx(tx,ctx,input.employmentId,input.effectiveDate);
  const[h]=await tx.select().from(head).where(eq(head.employmentId,employmentId));
  const history=await tx.select().from(sets).where(eq(sets.employmentId,employmentId)).orderBy(desc(sets.validFrom),desc(sets.revision));
  const historicRows=await tx.select({setId:rows.setId,costCenterId:rows.costCenterId,hundredths:rows.hundredths,codeSnapshot:rows.codeSnapshot,labelSnapshot:rows.labelSnapshot}).from(rows).innerJoin(sets,eq(sets.id,rows.setId)).where(eq(sets.employmentId,employmentId)).orderBy(asc(sets.revision),asc(rows.costCenterId));
  const current=history.find(v=>!v.supersededAt&&v.validFrom<=effectiveDate&&(!v.validTo||v.validTo>effectiveDate));
  const saved=current?await tx.select({costCenterId:rows.costCenterId,hundredths:rows.hundredths,codeSnapshot:rows.codeSnapshot,labelSnapshot:rows.labelSnapshot,label:costCenter.label,code:costCenter.code}).from(rows).leftJoin(costCenter,eq(costCenter.id,rows.costCenterId)).where(eq(rows.setId,current.id)).orderBy(asc(rows.codeSnapshot),asc(rows.costCenterId)):[];
  const choices=await tx.select({id:costCenter.id,code:costCenter.code,label:costCenter.label}).from(costCenter).where(and(isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[subject.companyId]))).orderBy(asc(costCenter.code),asc(costCenter.id));
  const[authority]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.maintain') and app.access_workforce_company(${subject.companyId}::uuid,'workforce.maintain') as allowed`);
  return{employmentId,companyId:subject.companyId,effectiveDate,revision:h?.revision??0,current:current?{id:current.id,validFrom:current.validFrom,validTo:current.validTo,companyId:current.companyId,source:current.source}:null,rows:saved.map(row=>({...row,displayLabel:row.label?.trim()||row.code||row.labelSnapshot||row.codeSnapshot})),choices:choices.map(row=>({...row,displayLabel:row.label?.trim()||row.code})),total:saved.reduce((n,r)=>n+r.hundredths,0),canEdit:authority?.allowed===true,history:history.map(v=>({id:v.id,revision:v.revision,effectiveDate:v.validFrom,validTo:v.validTo,companyId:v.companyId,operation:v.operation,source:v.source,superseded:!!v.supersededAt,rows:historicRows.filter(r=>r.setId===v.id),createdAt:v.createdAt.toISOString()})),needsReplacement:!!current&&current.companyId!==subject.companyId};
 });
}
export type EmploymentCostAllocationView=Awaited<ReturnType<typeof getEmploymentCostAllocations>>;
export async function prepareCostAllocationsTx(tx:Tx,ctx:SessionContext,raw:unknown){
 const input=allocationInputSchema.parse(raw),normalized=normalizedAllocationRows(input.rows,input.operation);const subject=await subjectTx(tx,ctx,input.employmentId,input.effectiveDate,true);
 const[h]=await tx.select().from(head).where(eq(head.employmentId,input.employmentId));if((h?.revision??0)!==input.expectedRevision)throw new CostAllocationError('changed');
 const labels=normalized.length?await tx.select({id:costCenter.id,code:costCenter.code,label:costCenter.label}).from(costCenter).where(and(sql`${costCenter.id} in (${sql.join(normalized.map(r=>sql`${r.costCenterId}::uuid`),sql`,`)})`,isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[subject.companyId]))).orderBy(asc(costCenter.id)).for('share'):[];
 if(labels.length!==normalized.length)throw new CostAllocationError('label');
 const digest=createHash('sha256').update(JSON.stringify({actor:ctx.userId,tenant:ctx.tenantId,input,companyId:subject.companyId,labels})).digest('hex');
 return{input,normalized,companyId:subject.companyId,labels,digest};
}
export function previewEmploymentCostAllocations(ctx:SessionContext,raw:unknown){return withTenant(ctx,async tx=>{const p=await prepareCostAllocationsTx(tx,ctx,raw);return{...p.input,companyId:p.companyId,digest:p.digest,total:p.normalized.reduce((n,r)=>n+r.hundredths,0)};});}
/** existingTx is mandatory for companion new-hire writes to join the employee's transaction. */
export function saveEmploymentCostAllocations(ctx:SessionContext,raw:unknown,options:{digest?:string;source?:'manual'|'employee-import'|'allocation-import';existingTx?:Tx}={}){
 return tenantMutation(ctx,options.existingTx,async tx=>{
  const p=await prepareCostAllocationsTx(tx,ctx,raw);if(options.digest!==undefined&&options.digest!==p.digest)throw new CostAllocationError('preview');
  const[result]=await tx.execute<{id:string}>(sql`select app.employment_cost_allocation_commit(${p.input.employmentId}::uuid,${p.companyId}::uuid,${p.input.effectiveDate}::date,${p.input.expectedRevision},${p.input.operation},${JSON.stringify(p.normalized)}::jsonb,${options.source??'manual'}) as id`);return{id:result.id,revision:p.input.expectedRevision+1};
 });
}
/** Transfer writers call this before changing company history. No implicit remapping or clearing. */
export async function assertCostAllocationTransferTx(tx:Tx,employmentId:string,date:string){
 const[used]=await tx.execute<{used:boolean}>(sql`select app.cost_allocation_transfer_required(${employmentId}::uuid,${date}::date) as used`);
 if(used?.used)throw new CostAllocationError('transfer');
}
