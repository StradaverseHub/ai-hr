/** ADR-0151 wave 1b source adapter: request overtime for one of the caller's OWN employments through the
 * same native service the Plan Overtime form uses (requestAttendanceCorrection with an overtime-only
 * window). Own employments only. The native preparation computes the minutes and the routing; the
 * confirmation must reproduce the exact preparation the person reviewed before anything is written. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {prepareAttendanceCorrectionRequestTx,requestAttendanceCorrectionTx,attendanceCorrectionPreparedDigest,type AttendanceCorrectionRequestInput} from '../../packs/attendance/service';
import {readOwnLeaveActorTx} from './own-leave-actor';
import {assertAiActionUnpausedTx} from '../ai-governance';
import {assertModuleEnabled} from '../entitlements';
import {myOwnEmploymentSubjectsTx} from '../read';
import {plannedOvertimeMinutes} from '../../lib/overtime-duration';
import type {GenericOwnSubject} from './generic-own-review-store';
import {OwnOvertimeChoices,OwnOvertimeReview,OwnOvertimeSourceReceipt,type OwnOvertimeHumanContent} from '../../lib/assistant-actions/own-overtime-request-contract';
export class OwnOvertimeRequestUnavailable extends Error{constructor(){super('That overtime request needs another look. Please reopen it or use the Plan Overtime page.');this.name='OwnOvertimeRequestUnavailable';}}
export const ownOvertimeRequestUnavailable=():never=>{throw new OwnOvertimeRequestUnavailable();};
const fail=ownOvertimeRequestUnavailable;
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
async function actor(tx:Tx,supplied:SessionContext){const fresh=await readOwnLeaveActorTx(tx,capture(supplied));if(!fresh)return fail();assertModuleEnabled(fresh,'attendance');await assertAiActionUnpausedTx(tx,fresh,'hr_assistant');return fresh;}
async function ownSubjects(tx:Tx,fresh:SessionContext){const subjects=await myOwnEmploymentSubjectsTx(tx,fresh);if(subjects.length>16)return fail();return subjects;}

export async function readOwnOvertimeChoicesTx(tx:Tx,supplied:SessionContext){
 const fresh=await actor(tx,supplied),subjects=await ownSubjects(tx,fresh);
 return OwnOvertimeChoices.parse({kind:'choices',employments:subjects.map(row=>({employmentId:row.employmentId,employeeCode:row.employeeCode??null,companyName:row.company}))});
}
/** The subject of an overtime request is the caller's own employment: the request row exists only after confirmation. */
export async function withOwnOvertimeSubjectTx<T>(tx:Tx,supplied:SessionContext,employmentId:string,work:(fresh:SessionContext,own:GenericOwnSubject)=>Promise<T>):Promise<T>{
 const fresh=await actor(tx,supplied),row=(await ownSubjects(tx,fresh)).find(subject=>subject.employmentId===employmentId);
 if(!row)return fail();
 return work(fresh,{subjectId:row.employmentId,employmentId:row.employmentId,companyId:row.currentCompanyId});
}
/** Overtime only: no clock times, no clock changes, no unclocked-work testimony (those are other forms). */
const inputOf=(human:OwnOvertimeHumanContent):AttendanceCorrectionRequestInput=>({employmentId:human.employmentId,date:human.date,plannedStartTime:human.plannedStartTime,plannedEndTime:human.plannedEndTime,
 reason:human.reason,remark:human.remark??null,requestKind:'self_overtime',requestedOtMinutes:minutesOf(human)});
/** The same planned-window rule the Plan Overtime form uses (an earlier end time is the next day). */
function minutesOf(human:OwnOvertimeHumanContent){const minutes=plannedOvertimeMinutes(human.plannedStartTime,human.plannedEndTime);return minutes&&minutes>0?minutes:fail();}
export async function prepareOwnOvertimeSourceTx(tx:Tx,fresh:SessionContext,human:OwnOvertimeHumanContent){
 const prepared=await prepareAttendanceCorrectionRequestTx(tx,fresh,inputOf(human)),data=prepared.data;
 if(data.employmentId!==human.employmentId||data.checkIn||data.checkOut||data.clockChanges||data.unclockedWork||!data.requestedOtMinutes||data.requestedOtMinutes<=0)return fail();
 const review=OwnOvertimeReview.parse({employmentId:data.employmentId,date:data.date,plannedStartTime:human.plannedStartTime,plannedEndTime:human.plannedEndTime,requestedOtMinutes:data.requestedOtMinutes,reason:data.reason,remark:data.remark});
 return{review,reviewedDigest:attendanceCorrectionPreparedDigest(fresh,prepared)};
}
export async function confirmOwnOvertimeSourceTx(tx:Tx,fresh:SessionContext,human:OwnOvertimeHumanContent,reviewedDigest:string){
 const done=await requestAttendanceCorrectionTx(tx,fresh,inputOf(human),{expectedDigest:reviewedDigest});
 return{eventId:done.eventId,receipt:await reconcileOwnOvertimeSourceTx(tx,fresh,{subjectId:human.employmentId,eventId:done.eventId,employmentId:human.employmentId})};
}
/** Completed receipt from the canonical request event and the request's current state. Never repeats the request. */
export async function reconcileOwnOvertimeSourceTx(tx:Tx,fresh:SessionContext,reference:{subjectId:string;eventId:string;employmentId:string}){
 if(reference.subjectId!==reference.employmentId)return fail();
 const rows=await tx.execute<{correctionId:string;date:string;minutes:number;status:string;cancelled:boolean}>(sql`select q.id as "correctionId",to_char(q.attendance_date,'YYYY-MM-DD') as date,q.requested_ot_minutes as minutes,q.status::text as status,q.cancelled_at is not null as cancelled
  from public.attendance_correction q join public.domain_event d on d.aggregate_id=q.id and d.tenant_id=q.tenant_id
  where q.tenant_id=${fresh.tenantId}::uuid and q.employment_id=${reference.employmentId}::uuid and d.id=${reference.eventId}::uuid
   and d.aggregate_type='attendance-correction' and d.event_type='attendance-correction.requested' and d.actor_type='user' and d.actor_id=${fresh.userId}::uuid`);
 const row=(rows as unknown as {correctionId:string;date:string;minutes:number;status:string;cancelled:boolean}[])[0];if(!row)return fail();
 return OwnOvertimeSourceReceipt.parse({kind:'requested',correctionId:row.correctionId,eventId:reference.eventId,employmentId:reference.employmentId,date:row.date,requestedOtMinutes:Number(row.minutes),currentStatus:row.status,cancelled:row.cancelled});
}
