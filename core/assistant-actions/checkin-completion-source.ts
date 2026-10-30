import {PerformancePostimageProof} from './performance-postimage-proof';
/** One native check-in completion. Purpose-bound human notes review; terminal receipts never contain notes. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {performanceCheckin,employment,person,company} from '../../db/schema';
import {CheckInCompletion as C,type CheckInCompletionHuman as Human} from '../../lib/assistant-actions/checkin-completion-contract';
import {completeCheckInTx,readCheckInCompletionPlanTx} from '../../packs/performance/service';
import {assertCanDecide} from '../approvals';
import {lockAccessConfigurationTx} from '../access-configuration-lock';
import {withAgentActionGuard} from './agent-action-guard';
import type {CheckInCompletionSubject} from './checkin-completion-custody-adapter';
export const checkInCompletionUnavailable=():never=>{throw Error('Please reopen the check-in completion review.');};
const fail=checkInCompletionUnavailable,hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Subject=CheckInCompletionSubject&{revision:string;employeeName:string;companyName:string;noteChars:number;noteBytes:number};
async function subject(tx:Tx,ctx:SessionContext,id:string):Promise<Subject>{
 const [row]=await tx.execute<{scope:Subject|null}>(sql`select app.assistant_checkin_complete_scope(${id}::uuid) as scope`);
 if(!row?.scope)return fail();await assertCanDecide(tx,ctx,row.scope.employmentId,'check-in');
 return row.scope;
}
export async function withCheckInCompletionSubjectTx<T>(tx:Tx,ctx:SessionContext,id:string,_mode:'pending'|'recorded',work:(fresh:SessionContext,s:CheckInCompletionSubject)=>Promise<T>):Promise<T>{
 const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await lockAccessConfigurationTx(tx,fresh.tenantId);return work(fresh,await subject(tx,fresh,id));
}
async function review(tx:Tx,ctx:SessionContext,human:Human){
 const s=await subject(tx,ctx,human.subjectId);if(s.employmentId!==human.employmentId)return fail();
 if(s.noteChars>8000||s.noteBytes>32000)return fail();
 const native=await readCheckInCompletionPlanTx(tx,ctx,{checkinId:human.subjectId,...(human.notesMode==='replace'?{notes:human.notes}:{})},true),g=native.checkin;
 const item=C.Item.parse({subjectId:g.id,employmentId:g.subjectEmploymentId,employeeName:s.employeeName,companyName:s.companyName,scheduledOn:g.scheduledOn,before:'scheduled',after:'completed',beforeNotes:g.notes,afterNotes:native.afterNotes,notesMode:human.notesMode});
 return{review:item,reviewedDigest:hash([1,C.action,s,human,native.reviewDigest,item]),nativeDigest:native.reviewDigest,postimageProof:PerformancePostimageProof.parse(native.postimageProof),normalizedReplacement:human.notesMode==='replace'?native.afterNotes:null};
}
export async function prepareCheckInCompletionSourceTx(tx:Tx,ctx:SessionContext,human:Human){return review(tx,ctx,human);}
export async function confirmCheckInCompletionSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string){
 const current=await review(tx,ctx,human);if(current.reviewedDigest!==expected)return fail();
 const effect=await completeCheckInTx(tx,ctx,{checkinId:human.subjectId,...(human.notesMode==='replace'?{notes:human.notes}:{})},current.nativeDigest,true);
 return{eventId:effect.eventId,receipt:C.Receipt.parse({kind:'completed',subjectId:effect.checkinId,employmentId:effect.employmentId,eventId:effect.eventId,completedAt:effect.completedAt})};
}
export async function reconcileCheckInCompletionSourceTx(tx:Tx,ctx:SessionContext,reference:{subjectId:string;employmentId:string;eventId:string;actionId:string}){
 const s=await subject(tx,ctx,reference.subjectId);if(s.employmentId!==reference.employmentId)return fail();
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_performance_review_receipt(${reference.actionId}::uuid,${reference.eventId}::uuid) as receipt`);return C.Receipt.parse(row?.receipt);
}
export async function readCheckInCompletionChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');await lockAccessConfigurationTx(tx,fresh.tenantId);const pick=C.Selection.parse(selection??{query:''});
 // The SQL predicate mirrors native visibility/direct-manager/delegation and the actual native super-admin own-subject exception.
 // Limit before projection; only exact participant/company labels and dates are returned.
 const rows=await tx.select({subjectId:performanceCheckin.id,employmentId:performanceCheckin.subjectEmploymentId,scheduledOn:performanceCheckin.scheduledOn,employeeName:person.fullName,companyName:company.legalName}).from(performanceCheckin).innerJoin(employment,and(eq(employment.id,performanceCheckin.subjectEmploymentId),eq(employment.tenantId,performanceCheckin.tenantId))).innerJoin(person,and(eq(person.id,employment.personId),eq(person.tenantId,employment.tenantId))).innerJoin(company,and(eq(company.id,employment.companyId),eq(company.tenantId,employment.tenantId)))
  .where(and(eq(performanceCheckin.tenantId,fresh.tenantId),eq(performanceCheckin.status,'scheduled'),sql`${person.fullName} ilike ${'%'+pick.query.replace(/[\\%_]/g,'\\$&')+'%'}`,sql`app.assistant_checkin_complete_choice_scope(${performanceCheckin.id})`,...(pick.subjectId?[eq(performanceCheckin.id,pick.subjectId)]:[])))
  .orderBy(performanceCheckin.scheduledOn,performanceCheckin.id).limit(26);
 return C.Choices.parse({kind:'choices',items:rows.slice(0,25),truncated:rows.length>25});
}
