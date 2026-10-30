/** Truthful employment creation intent. No existing check-in is nominated before INSERT. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {employment,person,company} from '../../db/schema';
import {CheckInScheduling as C,type CheckInSchedulingHuman as Human} from '../../lib/assistant-actions/checkin-scheduling-contract';
import {readCheckInSchedulingPlanTx,scheduleCheckInTx} from '../../packs/performance/service';
import {assertCanDecide} from '../approvals';
import {lockLeaveDependencyReadConfigurationTx} from '../leave-dependency-lock';
import {withAgentActionGuard} from './agent-action-guard';
import type {CheckInSchedulingSubject} from './checkin-scheduling-custody-adapter';
export const checkInSchedulingUnavailable=():never=>{throw Error('Please reopen the scheduling review.');};
const fail=checkInSchedulingUnavailable,hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Subject=CheckInSchedulingSubject&{employeeName:string;companyName:string};
async function interval(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await tx.execute(sql`select app.access_workforce_write_lock()`);await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);return fresh;}
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 await assertCanDecide(tx,ctx,id,'check-in');
 const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_checkin_schedule_scope(${id}::uuid) as scope`);if(!row?.scope)return fail();return row.scope;
}
export async function withCheckInSchedulingSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:CheckInSchedulingSubject)=>Promise<T>):Promise<T>{
 const fresh=await interval(tx,ctx);return work(fresh,await subject(tx,fresh,id));
}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const native=await readCheckInSchedulingPlanTx(tx,ctx,{subjectEmploymentId:human.employmentId,scheduledOn:human.scheduledOn}),s=await subject(tx,ctx,human.employmentId);
 const item=C.Item.parse({employmentId:s.employmentId,employeeName:s.employeeName,companyName:s.companyName,scheduledOn:native.scheduledOn,before:'not_created',after:'scheduled'});
 return{review:item,reviewedDigest:hash([1,C.action,s,human,native.reviewDigest,item]),nativeDigest:native.reviewDigest,managerEmploymentId:native.managerEmploymentId};
}
export async function prepareCheckInSchedulingSourceTx(tx:Tx,ctx:SessionContext,human:Human){return{...await review(tx,ctx,human),plannedResultId:randomUUID()};}
export async function confirmCheckInSchedulingSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string,plannedResultId:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const effect=await scheduleCheckInTx(tx,ctx,{subjectEmploymentId:human.employmentId,scheduledOn:human.scheduledOn},{plannedResultId,expectedDigest:current.nativeDigest});
 return{eventId:effect.eventId,checkinId:effect.checkinId,receipt:C.Receipt.parse({kind:'scheduled',employmentId:effect.employmentId,checkinId:effect.checkinId,eventId:effect.eventId,scheduledOn:effect.scheduledOn})};
}
export async function reconcileCheckInSchedulingSourceTx(tx:Tx,_ctx:SessionContext,reference:{actionId:string;employmentId:string;eventId:string}){
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_checkin_schedule_receipt(${reference.actionId}::uuid,${reference.eventId}::uuid) as receipt`);const receipt=C.Receipt.parse(row?.receipt);if(receipt.employmentId!==reference.employmentId)return fail();return receipt;
}
export async function readCheckInSchedulingChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await interval(tx,ctx),pick=C.Selection.parse(selection??{query:''});
 const rows=await tx.select({employmentId:employment.id,employeeName:person.fullName,companyName:company.legalName}).from(employment)
 .innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,employment.tenantId)))
 .where(and(eq(employment.tenantId,fresh.tenantId),sql`app.assistant_checkin_schedule_choice_scope(${employment.id})`,sql`${person.fullName} ilike ${'%'+pick.query.replace(/[\\%_]/g,'\\$&')+'%'}`,...(pick.employmentId?[eq(employment.id,pick.employmentId)]:[])))
 .orderBy(person.fullName,employment.id).limit(26);return C.Choices.parse({kind:'choices',items:rows.slice(0,25),truncated:rows.length>25});
}
