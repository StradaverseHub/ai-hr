/** One native check-in cancellation. Only date/participant/status are projected; shared notes are never read here. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {performanceCheckin,employment,person,company} from '../../db/schema';
import {CheckInCancellation as C,type CheckInCancellationHuman as Human} from '../../lib/assistant-actions/checkin-cancellation-contract';
import {cancelCheckInTx,readCheckInCancellationSourceTx} from '../../packs/performance/service';
import {assertCanDecide} from '../approvals';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {withAgentActionGuard} from './agent-action-guard';
import type {CheckInCancellationSubject} from './checkin-cancellation-custody-adapter';
export const checkInCancellationUnavailable=():never=>{throw Error('Please reopen the check-in cancellation review.');};
const fail=checkInCancellationUnavailable,hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Subject=CheckInCancellationSubject&{revision:string;employeeName:string;companyName:string};
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_checkin_cancel_scope(${id}::uuid) as scope`);
 if(!row?.scope)return fail();await assertCanDecide(tx,ctx,row.scope.employmentId,'check-in');
 return row.scope;
}
export async function withCheckInCancellationSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:CheckInCancellationSubject)=>Promise<T>):Promise<T>{
 const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await lockAccessConfigurationTx(tx,fresh.tenantId);return work(fresh,await subject(tx,fresh,id));
}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.subjectId);if(s.employmentId!==human.employmentId)return fail();
 const native=await readCheckInCancellationSourceTx(tx,ctx,human.subjectId),g=native.checkin;
 const item=C.Item.parse({subjectId:g.id,employmentId:g.subjectEmploymentId,employeeName:s.employeeName,companyName:s.companyName,scheduledOn:g.scheduledOn,before:'scheduled',after:'cancelled'});
 return{review:item,reviewedDigest:hash([1,C.action,s,human,native.reviewDigest,item]),nativeDigest:native.reviewDigest};
}
export async function prepareCheckInCancellationSourceTx(tx:Tx,ctx:SessionContext,human:Human){return review(tx,ctx,human);}
export async function confirmCheckInCancellationSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const effect=await cancelCheckInTx(tx,ctx,{checkinId:human.subjectId},current.nativeDigest);
 return{eventId:effect.eventId,receipt:await reconcileCheckInCancellationSourceTx(tx,ctx,{subjectId:effect.checkinId,employmentId:effect.employmentId,eventId:effect.eventId})};
}
export async function reconcileCheckInCancellationSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string}){
 const s=await subject(tx,ctx,reference.subjectId);if(s.employmentId!==reference.employmentId)return fail();
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_checkin_cancel_receipt(${reference.subjectId}::uuid,${reference.eventId}::uuid) as receipt`);return C.Receipt.parse(row?.receipt);
}
export async function readCheckInCancellationChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve'),pick=C.Selection.parse(selection??{query:''});
 // The SQL predicate mirrors native visibility/direct-manager/delegation + absolute self-ban.
 // Limit before projection; only exact participant/company labels and dates are returned.
 const rows=await tx.select({subjectId:performanceCheckin.id,employmentId:performanceCheckin.subjectEmploymentId,scheduledOn:performanceCheckin.scheduledOn,employeeName:person.fullName,companyName:company.legalName}).from(performanceCheckin).innerJoin(employment,and(eq(employment.id,performanceCheckin.subjectEmploymentId),eq(employment.tenantId,performanceCheckin.tenantId))).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,employment.tenantId)))
  .where(and(eq(performanceCheckin.tenantId,fresh.tenantId),eq(performanceCheckin.status,'scheduled'),sql`${person.fullName} ilike ${'%'+pick.query.replace(/[\\%_]/g,'\\$&')+'%'}`,sql`app.assistant_checkin_cancel_choice_scope(${performanceCheckin.id})`,...(pick.subjectId?[eq(performanceCheckin.id,pick.subjectId)]:[])))
  .orderBy(performanceCheckin.scheduledOn,performanceCheckin.id).limit(26);
 return C.Choices.parse({kind:'choices',items:rows.slice(0,25),truncated:rows.length>25});
}
