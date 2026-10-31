/** Complete dated replacement/clear through the SAME native owner. No model-supplied arithmetic. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {CostAllocationMaintenance as C,type CostAllocationMaintenanceHuman as Human} from '../../lib/assistant-actions/cost-allocation-maintenance-contract';
import {withAgentActionGuard} from './agent-action-guard';
import {prepareReviewedCostAllocationsTx,previewReviewedCostAllocationsTx,reviewedCostAllocationSubjectTx,reviewedCostAllocationChoicesTx,saveEmploymentCostAllocations,readReviewedCostAllocationEffectsTx} from '../employment-cost-allocations';
import {z} from 'zod';
export class CostAllocationMaintenanceUnavailable extends Error{constructor(){super('Please reopen the allocation review or use Personnel.');this.name='CostAllocationMaintenanceUnavailable';}}
export const costAllocationMaintenanceUnavailable=():never=>{throw new CostAllocationMaintenanceUnavailable();};
const fail=costAllocationMaintenanceUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const CostAllocationNomination=z.object({employmentId:z.guid(),effectiveDate:z.iso.date(),effectiveCompanyId:z.guid()}).strict();
export type CostAllocationNomination=z.infer<typeof CostAllocationNomination>;
export type CostAllocationSubject=CostAllocationNomination&{subjectId:string;companyId:string;subjectPersonId:string;employeeName:string;employeeCode:string|null;companyName:string;effectiveCompanyName:string};
export async function costAllocationActorTx(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await tx.execute(sql`select app.access_workforce_write_lock()`);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,pick:CostAllocationNomination):Promise<CostAllocationSubject>{
 const native=await reviewedCostAllocationSubjectTx(tx,ctx,pick.employmentId,pick.effectiveDate);
 if(native.companyId!==pick.effectiveCompanyId||native.employment.personId===ctx.personId)return fail();
 const[row]=await tx.execute<{subject:CostAllocationSubject|null}>(sql`select app.cost_allocation_review_identity(${pick.employmentId}::uuid,${pick.effectiveDate}::date,${pick.effectiveCompanyId}::uuid) as subject`);
 if(!row?.subject)return fail();return row.subject;
}
export async function withCostAllocationIntervalTx<T>(tx:Tx,ctx:SessionContext,pick:CostAllocationNomination,work:(fresh:SessionContext,s:CostAllocationSubject)=>Promise<T>){const fresh=await costAllocationActorTx(tx,ctx);return work(fresh,await subject(tx,fresh,pick));}
const nativeInput=(h:Human)=>({employmentId:h.employmentId,effectiveDate:h.effectiveDate,expectedRevision:h.expectedRevision,operation:h.operation,rows:h.rows});
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human),prepared=await prepareReviewedCostAllocationsTx(tx,ctx,nativeInput(human));
 if(prepared.companyId!==human.effectiveCompanyId||human.subjectId!==human.employmentId)return fail();
 const preview=C.Preview.parse(await previewReviewedCostAllocationsTx(tx,ctx,prepared));
 const item=C.Item.parse({employmentId:s.employmentId,subjectId:s.subjectId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName,effectiveCompanyName:s.effectiveCompanyName,effectiveCompanyId:s.effectiveCompanyId,effectiveDate:s.effectiveDate,expectedRevision:human.expectedRevision,preview});
 // Enforce public review UTF-8 budget BEFORE custody insertion, including sufficient envelope overhead.
 if(Buffer.byteLength(JSON.stringify({content:human,review:item}),'utf8')>119000)return fail();
 return{content:human,review:item,reviewedDigest:hash([1,C.action,s,human,prepared.source,prepared.before,preview]),prepared};
}
export const prepareCostAllocationSourceTx=review;
export async function confirmCostAllocationSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const saved=await saveEmploymentCostAllocations(ctx,nativeInput(human),{existingTx:tx,source:'manual',digest:current.prepared.digest});
 const actual=C.Preview.parse(await readReviewedCostAllocationEffectsTx(tx,human.employmentId,current.prepared.before,saved.id));
 if(JSON.stringify(actual)!==JSON.stringify(current.review.preview))return fail();
 const[row]=await tx.execute<{receipt:unknown}>(sql`select app.cost_allocation_review_saved_receipt(${human.employmentId}::uuid,${saved.id}::uuid) as receipt`);
 const receipt=C.Receipt.parse(row?.receipt);return{receipt,eventId:receipt.eventId};
}
export async function reconcileCostAllocationSourceTx(tx:Tx,ctx:SessionContext,pick:CostAllocationNomination,eventId:string){await subject(tx,ctx,pick);const[row]=await tx.execute<{receipt:unknown}>(sql`select app.cost_allocation_review_receipt(${pick.employmentId}::uuid,${eventId}::uuid,false) as receipt`);const receipt=C.Receipt.parse(row?.receipt);if(receipt.effectiveDate!==pick.effectiveDate||receipt.effectiveCompanyId!==pick.effectiveCompanyId)return fail();return receipt;}
export async function readCostAllocationChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await costAllocationActorTx(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const all=await tx.execute<z.infer<typeof C.Subject>>(sql`select x.value->>'employmentId' as "employmentId",x.value->>'name' as "employeeName",x.value->>'employeeCode' as "employeeCode",x.value->>'company' as "companyName" from app.access_workforce_list_rows() x(value) where app.employment_cost_allocation_review_visible((x.value->>'employmentId')::uuid) and not exists(select 1 from employment e join app_user u on u.tenant_id=e.tenant_id and u.person_id=e.person_id where e.id=(x.value->>'employmentId')::uuid and u.id=app.current_user_id()) and (x.value->>'name' ilike ${pattern} or coalesce(x.value->>'employeeCode','') ilike ${pattern}) order by x.value->>'name',x.value->>'employmentId' limit 26`);
 const employees=Array.from(all).slice(0,25);let truncated=all.length>25;let current:null|Awaited<ReturnType<typeof reviewedCostAllocationChoicesTx>>=null;
 if(pick.employmentId&&pick.effectiveDate){current=await reviewedCostAllocationChoicesTx(tx,fresh,pick.employmentId,pick.effectiveDate);const s=await subject(tx,fresh,{employmentId:pick.employmentId,effectiveDate:pick.effectiveDate,effectiveCompanyId:current.effectiveCompanyId});if(!employees.some(e=>e.employmentId===s.employmentId)){if(employees.length===25){employees.pop();truncated=true;}employees.push({employmentId:s.employmentId,employeeName:s.employeeName,employeeCode:s.employeeCode,companyName:s.companyName});}}
 const result=C.Choices.parse({kind:'choices',employees,truncated,current});if(Buffer.byteLength(JSON.stringify(result),'utf8')>120000)return fail();return result;
}
