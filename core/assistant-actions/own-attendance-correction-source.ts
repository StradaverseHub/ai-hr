/** UNMOUNTED own-human Attendance request source. All canonical input shapes are retained; own
 * unclocked testimony still fails the native other-HR rule, and clockChanges still needs native admin.
 * Attachments, web-punch removal, decisions and on-behalf requests remain separate unavailable actions. */
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceCorrection,domainEvent,employment} from '../../db/schema';
import {OwnAttendanceCorrectionIntent,OwnAttendanceCorrectionReview,OwnAttendanceCorrectionReceipt} from '../../lib/assistant-actions/own-attendance-correction-contract';
import {prepareAttendanceCorrectionRequestTx,requestAttendanceCorrectionTx,attendanceCorrectionPreparedDigest,type AttendanceCorrectionRequestInput} from '../../packs/attendance/service';
import {assertAiPrincipalTx} from '../ai-principal';
import {assertMayUseAssistant} from '../assistant-grant';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled,resolveEntitlementsTx} from '../entitlements';
const fail=():never=>{throw Error('Attendance request could not be confirmed.');};
function inputOf(intent:OwnAttendanceCorrectionIntent):AttendanceCorrectionRequestInput{
 const {version:_,clockChanges,unclockedWork,...input}=intent;return {...input,clockChanges:clockChanges??undefined,unclockedWork:unclockedWork??undefined};
}
async function guard(tx:Tx,supplied:SessionContext,employmentId:string){
 const current={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(g=>({...g}))};await assertAiPrincipalTx(tx,current);
 const fresh={...current,entitlements:await resolveEntitlementsTx(tx,current.tenantId)};await assertMayUseAssistant(fresh,tx);assertModuleEnabled(fresh,'attendance');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');
 if(!fresh.personId)return fail();const [own]=await tx.select({id:employment.id}).from(employment).where(and(eq(employment.id,employmentId),eq(employment.tenantId,fresh.tenantId),eq(employment.personId,fresh.personId))).limit(1);if(!own)return fail();return fresh;
}
function publicRequest(prepared:Awaited<ReturnType<typeof prepareAttendanceCorrectionRequestTx>>){
 const p=prepared.data;return OwnAttendanceCorrectionIntent.parse({version:1,employmentId:p.employmentId,date:p.date,checkIn:p.checkIn,checkOut:p.checkOut,requestedOtMinutes:p.requestedOtMinutes,
  plannedStartTime:p.plannedStartTime,plannedEndTime:p.plannedEndTime,otReasonCategory:p.otReasonCategory,reason:p.reason,remark:p.remark,requestKind:p.requestKind,clockChanges:p.clockChanges,
  ...(p.unclockedWork?{unclockedWork:{completeWorkedDay:p.unclockedWork.completeWorkedDay,intervals:p.unclockedWork.intervals,...(p.unclockedWork.requestedIntervals?{requestedIntervals:p.unclockedWork.requestedIntervals}:{})}}:{})});
}
export async function prepareOwnAttendanceCorrectionTx(tx:Tx,ctx:SessionContext,value:unknown){
 const intent=OwnAttendanceCorrectionIntent.parse(value),fresh=await guard(tx,ctx,intent.employmentId),prepared=await prepareAttendanceCorrectionRequestTx(tx,fresh,inputOf(intent));
 return OwnAttendanceCorrectionReview.parse({version:1,action:'attendance.correction.request',request:publicRequest(prepared),before:{checkIn:prepared.source.original?.checkIn??null,checkOut:prepared.source.original?.checkOut??null},
  meaning:'submit_for_existing_approval_not_clock_or_overtime_approval',reviewDigest:attendanceCorrectionPreparedDigest(fresh,prepared)});
}
/** Shared custody must keep the exact human input, own the confirmation row and roll back the whole
 * top-level transaction on failure. No caller-prepared policy/workflow is accepted as an effect input. */
export async function confirmOwnAttendanceCorrectionTx(tx:Tx,ctx:SessionContext,value:unknown,expectedDigest:string){
 const intent=OwnAttendanceCorrectionIntent.parse(value),fresh=await guard(tx,ctx,intent.employmentId);
 const effect=await requestAttendanceCorrectionTx(tx,fresh,inputOf(intent),{expectedDigest});return reopenOwnAttendanceCorrectionEventTx(tx,fresh,{employmentId:intent.employmentId,eventId:effect.eventId});
}
/** Terminal custody retains native refs only. This proves the caller originally submitted this own
 * request and reads its current status; a later approval/rejection is never an AI decision or retry. */
export async function reopenOwnAttendanceCorrectionEventTx(tx:Tx,ctx:SessionContext,value:unknown){
 const reference=OwnAttendanceCorrectionReceipt.pick({employmentId:true,eventId:true}).strict().parse(value),fresh=await guard(tx,ctx,reference.employmentId);
 const [row]=await tx.select({correctionId:attendanceCorrection.id,date:attendanceCorrection.attendanceDate,status:attendanceCorrection.status,cancelledAt:attendanceCorrection.cancelledAt,
  eventEmployment:sql<string>`${domainEvent.payload}->>'employmentId'`,eventDate:sql<string>`${domainEvent.payload}->>'date'`,sameCreation:sql<boolean>`${attendanceCorrection.createdAt}=${domainEvent.occurredAt}`})
  .from(attendanceCorrection).innerJoin(domainEvent,and(eq(domainEvent.aggregateId,attendanceCorrection.id),eq(domainEvent.tenantId,attendanceCorrection.tenantId)))
  .where(and(eq(attendanceCorrection.tenantId,fresh.tenantId),eq(attendanceCorrection.employmentId,reference.employmentId),eq(domainEvent.id,reference.eventId),eq(domainEvent.actorType,'user'),eq(domainEvent.actorId,fresh.userId!),
   eq(domainEvent.aggregateType,'attendance-correction'),eq(domainEvent.eventType,'attendance-correction.requested'),eq(domainEvent.subjectEmploymentId,reference.employmentId)));
 if(!row||!row.sameCreation||row.eventEmployment!==reference.employmentId||row.eventDate!==row.date)return fail();
 return OwnAttendanceCorrectionReceipt.parse({version:1,action:'attendance.correction.request',proof:'recorded_submission_current_own_request',correctionId:row.correctionId,employmentId:reference.employmentId,eventId:reference.eventId,
  date:row.date,status:row.status,cancelled:!!row.cancelledAt,meaning:'submitted_not_approved'});
}
