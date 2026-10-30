import {organisationChoiceLabels} from '../lib/organisation-choice-label';
/** One cost-distribution owner for manual entry, repeated-row imports and new-hire transactions. */
import {createHash} from 'node:crypto';
import {and,asc,desc,eq,isNull,lte,or,gt,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {employment,assignment,company,costCenter,employmentCostAllocationHead as head,employmentCostAllocationSet as sets,employmentCostAllocationRow as rows} from '../db/schema';
import {tenantMutation} from '../db/tenant-mutation';
import {assertWorkforceEmploymentTx,assertWorkforceCompanyTx} from './workforce-access';
import {lockLabelCriteriaTx,visibleLabelIdsCondition} from './system-labels';
import {provenCompanyDatesTx,dayBefore} from './employment-company';
import {todayInKualaLumpur} from '../lib/hr-date';
import {allocationInputSchema,normalizedAllocationRows,CostAllocationError,type CostAllocationInput,type AllocationSource} from '../lib/employment-cost-allocation';
import {z} from 'zod';
export {CostAllocationError} from '../lib/employment-cost-allocation';
async function subjectTx(tx:Tx,ctx:SessionContext,id:string,date:string,write=false){
 await assertWorkforceEmploymentTx(tx,ctx,id,write?'maintain':'view');
 if(write)await lockLabelCriteriaTx(tx,ctx.tenantId);
 const query=tx.select().from(employment).where(eq(employment.id,id));const[e]=await(write?query.for('update'):query);if(!e)throw new CostAllocationError('scope');
 const proof=(await provenCompanyDatesTx(tx,[{employmentId:id,date}])).get(`${id}|${date}`);if(!proof?.companyId)throw new CostAllocationError('date');
 await assertWorkforceCompanyTx(tx,ctx,proof.companyId,write?'maintain':'view');if(write){const[live]=await tx.select({id:company.id}).from(company).where(and(eq(company.id,proof.companyId),isNull(company.archivedAt)));if(!live)throw new CostAllocationError('scope');}return{employment:e,companyId:proof.companyId};
}
async function defaultAllocationDateTx(tx:Tx,ctx:SessionContext,employmentId:string){
 await assertWorkforceEmploymentTx(tx,ctx,employmentId,'view');
 const[e]=await tx.select({terminatedOn:employment.terminatedOn}).from(employment).where(eq(employment.id,employmentId));
 if(!e)throw new CostAllocationError('scope');
 const versions=await tx.select({from:assignment.validFrom,to:assignment.validTo}).from(assignment).where(and(eq(assignment.employmentId,employmentId),isNull(assignment.supersededAt))).orderBy(asc(assignment.validFrom),asc(assignment.id));
 const today=todayInKualaLumpur();
 // Candidate boundaries come from the dated company spine. Only the canonical tenure/history proof
 // may admit a date; neither group service nor a guessed termination boundary establishes ownership.
 const candidates=[...new Set([today,...versions.flatMap(v=>[v.from,...(v.to?[dayBefore(v.to)]:[])]),...(e.terminatedOn?[e.terminatedOn]:[])])];
 const proof=await provenCompanyDatesTx(tx,candidates.map(date=>({employmentId,date})));
 const valid=candidates.filter(date=>!!proof.get(`${employmentId}|${date}`)?.companyId).sort();
 const selected=valid.filter(date=>date<=today).pop()??valid.find(date=>date>today);
 if(!selected)throw new CostAllocationError('date');return selected;
}
export async function getEmploymentCostAllocations(ctx:SessionContext,employmentId:string,effectiveDate?:string){
 allocationInputSchema.pick({employmentId:true}).parse({employmentId});
 if(effectiveDate!==undefined)allocationInputSchema.pick({effectiveDate:true}).parse({effectiveDate});
 return withTenant(ctx,async tx=>{
  const selectedDate=effectiveDate??await defaultAllocationDateTx(tx,ctx,employmentId);
  const subject=await subjectTx(tx,ctx,employmentId,selectedDate);

  const[h]=await tx.select().from(head).where(eq(head.employmentId,employmentId));
  const history=await tx.select().from(sets).where(eq(sets.employmentId,employmentId)).orderBy(desc(sets.validFrom),desc(sets.revision));
  const historicRows=await tx.select({setId:rows.setId,costCenterId:rows.costCenterId,hundredths:rows.hundredths,codeSnapshot:rows.codeSnapshot,labelSnapshot:rows.labelSnapshot}).from(rows).innerJoin(sets,eq(sets.id,rows.setId)).where(eq(sets.employmentId,employmentId)).orderBy(asc(sets.revision),asc(rows.costCenterId));
  const current=history.find(v=>!v.supersededAt&&v.validFrom<=selectedDate&&(!v.validTo||v.validTo>selectedDate));
  const saved=current?await tx.select({costCenterId:rows.costCenterId,hundredths:rows.hundredths,codeSnapshot:rows.codeSnapshot,labelSnapshot:rows.labelSnapshot,label:costCenter.label,code:costCenter.code}).from(rows).leftJoin(costCenter,eq(costCenter.id,rows.costCenterId)).where(eq(rows.setId,current.id)).orderBy(asc(rows.codeSnapshot),asc(rows.costCenterId)):[];
  const choices=await tx.select({id:costCenter.id,code:costCenter.code,label:costCenter.label}).from(costCenter).where(and(isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[subject.companyId]))).orderBy(asc(costCenter.code),asc(costCenter.id));
  const[authority]=await tx.execute<{allowed:boolean}>(sql`select app.access_workforce_employment(${employmentId}::uuid,'workforce.maintain') and app.access_workforce_company(${subject.companyId}::uuid,'workforce.maintain') as allowed`);
  return{employmentId,companyId:subject.companyId,effectiveDate:selectedDate,revision:h?.revision??0,current:current?{id:current.id,validFrom:current.validFrom,validTo:current.validTo,companyId:current.companyId,source:current.source}:null,rows:saved.map(row=>({...row,displayLabel:row.label?.trim()||row.code||row.labelSnapshot||row.codeSnapshot})),choices:organisationChoiceLabels(choices),total:saved.reduce((n,r)=>n+r.hundredths,0),canEdit:authority?.allowed===true,history:history.map(v=>({id:v.id,revision:v.revision,effectiveDate:v.validFrom,validTo:v.validTo,companyId:v.companyId,operation:v.operation,source:v.source,superseded:!!v.supersededAt,rows:historicRows.filter(r=>r.setId===v.id),createdAt:v.createdAt.toISOString()})),needsReplacement:!!current&&current.companyId!==subject.companyId};
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
export function saveEmploymentCostAllocations(ctx:SessionContext,raw:unknown,options:{digest?:string;source?:AllocationSource;existingTx?:Tx}={}){
 return tenantMutation(ctx,options.existingTx,async tx=>{
  const p=await prepareCostAllocationsTx(tx,ctx,raw);if(options.digest!==undefined&&options.digest!==p.digest)throw new CostAllocationError('preview');
  const[result]=await tx.execute<{id:string}>(sql`select app.employment_cost_allocation_commit(${p.input.employmentId}::uuid,${p.companyId}::uuid,${p.input.effectiveDate}::date,${p.input.expectedRevision},${p.input.operation},${JSON.stringify(p.normalized)}::jsonb,${options.source??'manual'}) as id`);return{id:result.id,revision:p.input.expectedRevision+1};
 });
}
/** Private reviewed-command projection. The boolean witness precedes all timeline reads because row
 * policies may otherwise omit a version belonging to another company. It adds VIEW of every ACTIVE
 * version, never maintenance of those other companies. The ordinary command's authority is unchanged. */
const reviewedRow=z.object({costCenterId:z.guid(),hundredths:z.number().int().min(1).max(10000),codeSnapshot:z.string().max(4000),labelSnapshot:z.string().max(4000)}).strict();
const reviewedVersion=z.object({id:z.guid(),companyId:z.guid(),companyName:z.string().min(1).max(4000),revision:z.number().int().positive(),validFrom:z.iso.date(),validTo:z.iso.date().nullable(),superseded:z.boolean(),operation:z.enum(['replace','clear']),source:z.string().max(80),rows:z.array(reviewedRow).max(100)}).strict();
export const reviewedCostAllocationTimeline=z.array(reviewedVersion).max(100);
const reviewedContext=z.object({version:z.literal(1),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),labels:z.array(z.object({id:z.guid(),code:z.string().max(4000),label:z.string().max(4000).nullable(),version:z.string().regex(/^[0-9]+$/)}).strict()).max(100)}).strict();
export type ReviewedCostAllocationVersion=z.infer<typeof reviewedVersion>;
export async function reviewedCostAllocationSubjectTx(tx:Tx,ctx:SessionContext,employmentId:string,effectiveDate:string){
 const[witness]=await tx.execute<{allowed:boolean}>(sql`select app.employment_cost_allocation_review_visible(${employmentId}::uuid) as allowed`);
 if(witness?.allowed!==true)throw new CostAllocationError('scope');
 return subjectTx(tx,ctx,employmentId,effectiveDate,true);
}
export async function reviewedCostAllocationChoicesTx(tx:Tx,ctx:SessionContext,employmentId:string,effectiveDate:string){
 const s=await reviewedCostAllocationSubjectTx(tx,ctx,employmentId,effectiveDate);
 const[h]=await tx.select({revision:head.revision}).from(head).where(eq(head.employmentId,employmentId));
 const timeline=await reviewedVersionsTx(tx,employmentId);
 const current=timeline.find(v=>v.validFrom<=effectiveDate&&(!v.validTo||v.validTo>effectiveDate));
 const choices=await tx.select({id:costCenter.id,code:costCenter.code,label:costCenter.label}).from(costCenter).where(and(isNull(costCenter.archivedAt),visibleLabelIdsCondition(costCenter,'cost_center',[s.companyId]))).orderBy(asc(costCenter.code),asc(costCenter.id)).limit(101);
 if(choices.length>100)throw new CostAllocationError('scope');
 return{effectiveDate,effectiveCompanyId:s.companyId,expectedRevision:h?.revision??0,rows:current?.rows??[],choices};
}
async function reviewedVersionsTx(tx:Tx,employmentId:string,ids?:string[]){
 const predicate=ids?sql`s.id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)})`:sql`s.superseded_at is null`;
 if(ids&&!ids.length)return[];
 const result=await tx.execute<{version:unknown}>(sql`select jsonb_build_object('id',s.id,'companyId',s.company_id,'companyName',(select c.legal_name from company c where c.id=s.company_id and c.tenant_id=s.tenant_id),'revision',s.revision,'validFrom',s.valid_from,'validTo',s.valid_to,'superseded',s.superseded_at is not null,'operation',s.operation,'source',s.source,'rows',coalesce((select jsonb_agg(jsonb_build_object('costCenterId',r.cost_center_id,'hundredths',r.hundredths,'codeSnapshot',r.code_snapshot,'labelSnapshot',r.label_snapshot) order by r.cost_center_id) from employment_cost_allocation_row r where r.tenant_id=s.tenant_id and r.set_id=s.id),'[]'::jsonb)) as version from employment_cost_allocation_set s where s.tenant_id=app.current_tenant_id() and s.employment_id=${employmentId}::uuid and ${predicate} order by s.valid_from,s.revision limit 101`);
 return reviewedCostAllocationTimeline.parse(result.map(r=>r.version));
}
export async function prepareReviewedCostAllocationsTx(tx:Tx,ctx:SessionContext,raw:unknown){
 const input=allocationInputSchema.parse(raw);
 await reviewedCostAllocationSubjectTx(tx,ctx,input.employmentId,input.effectiveDate);
 const p=await prepareCostAllocationsTx(tx,ctx,input);
 // Access/criteria/employment/labels from prepare, plus company/history/head/versions, remain locked
 // outside the preview subtransaction. Employment and Access serialize a genuinely absent head.
 // These tables intentionally grant the application SELECT only; their owning lock seam must
 // retain that restriction rather than granting UPDATE merely to use SELECT FOR UPDATE.
 await tx.execute(sql`select app.cost_allocation_review_lock(${input.employmentId}::uuid,${input.effectiveDate}::date,${p.companyId}::uuid)`);
 const before=await reviewedVersionsTx(tx,input.employmentId);
 const[context]=await tx.execute<{source:unknown}>(sql`select app.cost_allocation_review_context(${input.employmentId}::uuid,${input.effectiveDate}::date,${p.companyId}::uuid,${JSON.stringify(p.normalized)}::jsonb) as source`);
 const source=reviewedContext.parse(context?.source);
 return{...p,before,source};
}
/** The SAME native save, no writes escaping this raw savepoint. In particular Drizzle nested
 * transactions are not used: a rolled-back driver savepoint must not remain open at final save. */
export async function previewReviewedCostAllocationsTx(tx:Tx,ctx:SessionContext,prepared:Awaited<ReturnType<typeof prepareReviewedCostAllocationsTx>>){
 await tx.execute(sql`savepoint ai_cost_allocation_preview`);
 try{
  const saved=await saveEmploymentCostAllocations(ctx,prepared.input,{existingTx:tx,source:'manual',digest:prepared.digest});
  return await readReviewedCostAllocationEffectsTx(tx,prepared.input.employmentId,prepared.before,saved.id);
 }finally{try{await tx.execute(sql`rollback to savepoint ai_cost_allocation_preview`);}finally{await tx.execute(sql`release savepoint ai_cost_allocation_preview`);}}
}
/** Internal companion projection, called only under the reviewed interval's already-held authority. */
export async function readReviewedCostAllocationEffectsTx(tx:Tx,employmentId:string,before:ReviewedCostAllocationVersion[],setId:string){
  const versions=await reviewedVersionsTx(tx,employmentId,[...before.map(v=>v.id),setId]);
  const next=versions.find(v=>v.id===setId);if(!next)throw new CostAllocationError('preview');
  const {id:_generatedId,...interval}=next;
  const changes=before.flatMap(before=>{const after=versions.find(v=>v.id===before.id);if(!after)throw new CostAllocationError('preview');return JSON.stringify(before)===JSON.stringify(after)?[]:[{before,after}];});
  const total=next.rows.reduce((sum,row)=>sum+row.hundredths,0);
  return{interval,changes,total,remainder:10000-total};
}
/** Transfer writers call this before changing company history. No implicit remapping or clearing. */
export async function assertCostAllocationTransferTx(tx:Tx,employmentId:string,date:string){
 const[used]=await tx.execute<{used:boolean}>(sql`select app.cost_allocation_transfer_required(${employmentId}::uuid,${date}::date) as used`);
 if(used?.used)throw new CostAllocationError('transfer');
}
