/** ADR-0151 wave 1 source adapters: cancel, or edit the dates/reason/remark of, the caller's own PENDING plain
 * leave request through the native leave service. Own employments only. Confirmation takes the service's own
 * request lock, re-reads the request, and requires the reviewed values to be unchanged before the native write;
 * an edit must also produce the engine day count the person reviewed. Anything else is the Leave form's. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {cancelOwnLeaveTx,editLeaveRequestTx,lockLeaveRequestDependenciesTx,previewLeaveDeduction} from '../../packs/leave/service';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled} from '../entitlements';
import {myOwnEmploymentSubjectsTx} from '../read';
import {todayInKualaLumpur} from '../../lib/hr-date';
import type {GenericOwnSubject} from './generic-own-review-store';
import {OwnPendingLeave,OwnLeaveChangeChoices,OwnLeaveCancellationSourceReceipt,OwnLeaveEditReview,OwnLeaveEditSourceReceipt,type OwnLeaveCancellationHumanContent,type OwnLeaveEditHumanContent} from '../../lib/assistant-actions/own-leave-change-contract';
export class OwnLeaveChangeUnavailable extends Error{constructor(){super('That leave change needs another look. Please reopen it or use the Leave page.');this.name='OwnLeaveChangeUnavailable';}}
export const ownLeaveChangeUnavailable=():never=>{throw new OwnLeaveChangeUnavailable();};
const fail=ownLeaveChangeUnavailable;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
const digestOf=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function actor(tx:Tx,supplied:SessionContext){const fresh=await readOwnLeaveActorTx(tx,capture(supplied));if(!fresh)return fail();assertModuleEnabled(fresh,'leave');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
async function ownEmploymentIds(tx:Tx,fresh:SessionContext){const subjects=await myOwnEmploymentSubjectsTx(tx,fresh);if(subjects.length>16)return fail();return subjects.map(row=>row.employmentId);}
type Row={leaveRequestId:string;employmentId:string;companyId:string;leaveTypeId:string;leaveTypeName:string;startDate:string;endDate:string;days:string;durationType:string;status:string;reason:string|null;employeeRemark:string|null;grouped:boolean;perDate:boolean;imported:boolean};
const rowSql=sql`select q.id as "leaveRequestId",q.employment_id as "employmentId",e.company_id as "companyId",q.leave_type_id as "leaveTypeId",t.name as "leaveTypeName",
 to_char(q.start_date,'YYYY-MM-DD') as "startDate",to_char(q.end_date,'YYYY-MM-DD') as "endDate",q.days::text as days,q.duration_type as "durationType",q.status::text as status,
 q.reason,q.employee_remark as "employeeRemark",q.parent_group_id is not null as grouped,q.imported_history as imported,
 exists(select 1 from public.leave_request_date x where x.leave_request_id=q.id) as "perDate"
 from public.leave_request q join public.employment e on e.id=q.employment_id and e.tenant_id=q.tenant_id join public.leave_type t on t.id=q.leave_type_id and t.tenant_id=q.tenant_id`;
async function rowOf(tx:Tx,fresh:SessionContext,id:string):Promise<Row|undefined>{const rows=await tx.execute<Row>(sql`${rowSql} where q.id=${id}::uuid and q.tenant_id=${fresh.tenantId}::uuid`);return (rows as unknown as Row[])[0];}
/** Plain own pending requests only: one row, no split group, no per-date approval rows, not imported history. */
const plain=(row:Row)=>row.status==='pending'&&!row.grouped&&!row.perDate&&!row.imported;
function pendingOf(row:Row){if(!plain(row))return fail();return OwnPendingLeave.parse({employmentId:row.employmentId,leaveRequestId:row.leaveRequestId,leaveTypeName:row.leaveTypeName,startDate:row.startDate,endDate:row.endDate,days:Number(row.days),reason:row.reason,employeeRemark:row.employeeRemark});}

export async function readOwnLeaveChangeChoicesTx(tx:Tx,supplied:SessionContext){
 const fresh=await actor(tx,supplied),ids=await ownEmploymentIds(tx,fresh);if(!ids.length)return OwnLeaveChangeChoices.parse({kind:'choices',requests:[],truncated:false});
 const rows=(await tx.execute<Row>(sql`${rowSql} where q.tenant_id=${fresh.tenantId}::uuid and q.status='pending' and q.parent_group_id is null and not q.imported_history
  and q.employment_id in (${sql.join(ids.map(id=>sql`${id}::uuid`),sql`,`)}) order by q.start_date,q.id limit 40`)) as unknown as Row[];
 const requests=rows.filter(plain).map(pendingOf);
 return OwnLeaveChangeChoices.parse({kind:'choices',requests:requests.slice(0,25),truncated:requests.length>25||rows.length>=40});
}
/** The request must belong to one of the caller's own employments. */
export async function withOwnLeaveChangeSubjectTx<T>(tx:Tx,supplied:SessionContext,leaveRequestId:string,work:(fresh:SessionContext,own:GenericOwnSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied),ids=await ownEmploymentIds(tx,fresh),row=await rowOf(tx,fresh,leaveRequestId);
 if(!row||!ids.includes(row.employmentId))return fail();
 return work(fresh,{subjectId:row.leaveRequestId,employmentId:row.employmentId,companyId:row.companyId});
}
async function lockedRow(tx:Tx,fresh:SessionContext,id:string){await lockLeaveRequestDependenciesTx(tx,fresh,id);const row=await rowOf(tx,fresh,id);if(!row)return fail();return row;}
async function currentStatus(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string},eventType:string){
 const rows=await tx.execute<{status:string}>(sql`select q.status::text as status from public.leave_request q join public.domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id
  where q.id=${reference.subjectId}::uuid and q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${reference.employmentId}::uuid
   and d.id=${reference.eventId}::uuid and d.aggregate_type='leave-request' and d.event_type=${eventType} and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`);
 const row=(rows as unknown as {status:string}[])[0];if(!row)return fail();return row.status as 'pending'|'approved'|'rejected'|'cancelled';
}

// Cancel
export async function prepareOwnLeaveCancellationSourceTx(tx:Tx,fresh:SessionContext,human:OwnLeaveCancellationHumanContent){
 const row=await rowOf(tx,fresh,human.leaveRequestId);if(!row||row.employmentId!==human.employmentId)return fail();
 const review=pendingOf(row);return{review,reviewedDigest:digestOf(review)};
}
export async function confirmOwnLeaveCancellationSourceTx(tx:Tx,fresh:SessionContext,human:OwnLeaveCancellationHumanContent,reviewedDigest:string){
 const row=await lockedRow(tx,fresh,human.leaveRequestId);if(row.employmentId!==human.employmentId||digestOf(pendingOf(row))!==reviewedDigest)return fail();
 const done=await cancelOwnLeaveTx(tx,fresh,{leaveRequestId:human.leaveRequestId});
 return{eventId:done.eventId,receipt:OwnLeaveCancellationSourceReceipt.parse({kind:'cancelled',leaveRequestId:human.leaveRequestId,eventId:done.eventId,employmentId:human.employmentId,currentStatus:'cancelled'})};
}
export async function reconcileOwnLeaveCancellationSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 return OwnLeaveCancellationSourceReceipt.parse({kind:'cancelled',leaveRequestId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,currentStatus:await currentStatus(tx,fresh,reference,'leave-request.self-cancelled')});
}

// Edit
/** Omitted reason/remark keep the current text; the native edit would otherwise clear them. */
const afterText=(human:OwnLeaveEditHumanContent,row:Row)=>({reason:human.reason!==undefined?human.reason.trim()||null:row.reason,employeeRemark:human.employeeRemark!==undefined?human.employeeRemark.trim()||null:row.employeeRemark});
async function editReview(tx:Tx,fresh:SessionContext,human:OwnLeaveEditHumanContent,row:Row){
 if(row.employmentId!==human.employmentId||row.durationType!=='full_day')return fail();
 const before=pendingOf(row),text=afterText(human,row);
 const preview=await previewLeaveDeduction(fresh,{employmentId:row.employmentId,leaveTypeId:row.leaveTypeId,startDate:human.startDate,endDate:human.endDate,durationType:'full_day',today:todayInKualaLumpur()},tx);
 // Splits, unpaid portions and overrides are the Leave form's to explain; this card cannot show them faithfully.
 if(!Number.isFinite(preview.days)||preview.days<=0||preview.isEmergencySplit||(preview.unpaidDays??0)>0||(preview.overrides?.length??0)>0)return fail();
 return OwnLeaveEditReview.parse({before,after:{startDate:human.startDate,endDate:human.endDate,days:preview.days,...text}});
}
export async function prepareOwnLeaveEditSourceTx(tx:Tx,fresh:SessionContext,human:OwnLeaveEditHumanContent){
 const row=await rowOf(tx,fresh,human.leaveRequestId);if(!row)return fail();
 const review=await editReview(tx,fresh,human,row);return{review,reviewedDigest:digestOf(review)};
}
export async function confirmOwnLeaveEditSourceTx(tx:Tx,fresh:SessionContext,human:OwnLeaveEditHumanContent,reviewedDigest:string){
 const row=await lockedRow(tx,fresh,human.leaveRequestId),review=await editReview(tx,fresh,human,row);if(digestOf(review)!==reviewedDigest)return fail();
 const done=await editLeaveRequestTx(tx,fresh,{leaveRequestId:human.leaveRequestId,leaveTypeId:row.leaveTypeId,startDate:human.startDate,endDate:human.endDate,durationType:'full_day',
  reason:review.after.reason??undefined,employeeRemark:review.after.employeeRemark??undefined,today:todayInKualaLumpur()});
 if(done.days!==review.after.days)return fail();
 return{eventId:done.eventId,receipt:OwnLeaveEditSourceReceipt.parse({kind:'edited',leaveRequestId:human.leaveRequestId,eventId:done.eventId,employmentId:human.employmentId,days:done.days,currentStatus:'pending'})};
}
export async function reconcileOwnLeaveEditSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 const status=await currentStatus(tx,fresh,reference,'leave-request.edited');
 const [event]=(await tx.execute<{days:number}>(sql`select (payload->'after'->>'days')::numeric::float8 as days from public.domain_event where id=${reference.eventId}::uuid and tenant_id=${fresh.tenantId}::uuid`)) as unknown as {days:number}[];
 if(!event||!Number.isFinite(event.days))return fail();
 return OwnLeaveEditSourceReceipt.parse({kind:'edited',leaveRequestId:reference.subjectId,eventId:reference.eventId,employmentId:reference.employmentId,days:event.days,currentStatus:status});
}
