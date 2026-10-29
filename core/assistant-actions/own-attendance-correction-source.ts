/** Human-reviewed own-human Attendance request source. All canonical input shapes are retained; own
 * unclocked testimony still fails the native other-HR rule, and clockChanges still needs native admin.
 * Attachments, web-punch removal, decisions and on-behalf requests remain separate unavailable actions. */
import {z} from 'zod';
import {pgSqlState} from '../../lib/db-error';
import {lockLeaveDependencyReadConfigurationTx,lockLeaveDependenciesTx} from '../leave-dependency-lock';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceCorrection,domainEvent,employment} from '../../db/schema';
import {OwnAttendanceCorrectionIntent,OwnAttendanceCorrectionReview,OwnAttendanceCorrectionReceipt} from '../../lib/assistant-actions/own-attendance-correction-contract';
import {prepareAttendanceCorrectionRequestTx,requestAttendanceCorrectionTx,attendanceCorrectionPreparedDigest,type AttendanceCorrectionRequestInput} from '../../packs/attendance/service';
import {withAgentActionGuard} from './agent-action-guard';
const fail=():never=>{throw Error('Attendance request could not be confirmed.');};
function inputOf(intent:OwnAttendanceCorrectionIntent):AttendanceCorrectionRequestInput{
 const {version:_,clockChanges,unclockedWork,...input}=intent;return {...input,clockChanges:clockChanges??undefined,unclockedWork:unclockedWork??undefined};
}
const capture=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function assertOwnAttendanceCorrectionActorTx(tx:Tx,supplied:SessionContext){const fresh=await withAgentActionGuard(tx,capture(supplied),'attendance.correction.request');if(!fresh.personId)return fail();return fresh;}
async function guard(tx:Tx,supplied:SessionContext,employmentId:string){
 const fresh=await assertOwnAttendanceCorrectionActorTx(tx,supplied);await lockLeaveDependencyReadConfigurationTx(tx,fresh.tenantId);
 const nominate=()=>tx.select({id:employment.id,companyId:employment.companyId}).from(employment).where(and(eq(employment.id,employmentId),eq(employment.tenantId,fresh.tenantId),eq(employment.personId,fresh.personId!))).limit(1);
 const [before]=await nominate();if(!before)return fail();await lockLeaveDependenciesTx(tx,fresh.tenantId,[before.id]);
 const [credit]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${fresh.tenantId+':'+before.id},0)) as owned`);if(credit?.owned!==true)return fail();
 const [after]=await nominate();if(!after||after.id!==before.id||after.companyId!==before.companyId)return fail();return fresh;
}
/** Conditional native policy/day/Payroll locks remain canonical. Bound their waits without raising
 * any existing nonzero bound; SQL failures abort the whole caller transaction, never retry/continue. */
async function bounded<T>(tx:Tx,work:()=>Promise<T>):Promise<T>{
 const [prior]=await tx.execute<{saved:string;milliseconds:number;unit:string}>(sql`select current_setting('lock_timeout') as saved,setting::integer as milliseconds,unit from pg_settings where name='lock_timeout'`);
 if(!prior||prior.unit!=='ms'||!Number.isSafeInteger(prior.milliseconds)||prior.milliseconds<0)return fail();
 const limit=prior.milliseconds===0?1000:Math.min(prior.milliseconds,1000);await tx.execute(sql`select set_config('lock_timeout',${String(limit)+'ms'},true)`);let result:T;
 try{result=await work();}catch(error){if(!pgSqlState(error)){try{await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);}catch{/* Unusable caller Tx MUST roll back. */}}throw error;}
 await tx.execute(sql`select set_config('lock_timeout',${prior.saved},true)`);return result;
}
/** Initial own config/employee/credit ownership. Pending custody must ALSO run the real canonical
 * preparation from its decrypted immutable human input BEFORE custody row ownership. Completed
 * reconciliation locks only its actual native correction, never runs pending-only preparation. */
export async function withOwnAttendanceCorrectionIntervalTx<T>(tx:Tx,supplied:SessionContext,reference:{employmentId:string;correctionId:string|null},work:(fresh:SessionContext,source:{employmentId:string;companyId:string})=>Promise<T>):Promise<T>{
 const ctx=capture(supplied),p=z.object({employmentId:z.guid(),correctionId:z.guid().nullable()}).strict().parse(structuredClone(reference));return bounded(tx,async()=>{const fresh=await guard(tx,ctx,p.employmentId),[source]=await tx.select({employmentId:employment.id,companyId:employment.companyId}).from(employment).where(and(eq(employment.id,p.employmentId),eq(employment.tenantId,fresh.tenantId),eq(employment.personId,fresh.personId!))).limit(1);if(!source)return fail();
 if(p.correctionId){const [row]=await tx.select({id:attendanceCorrection.id}).from(attendanceCorrection).where(and(eq(attendanceCorrection.id,p.correctionId),eq(attendanceCorrection.tenantId,fresh.tenantId),eq(attendanceCorrection.employmentId,p.employmentId))).limit(1).for('update',{noWait:true});if(!row)return fail();}return work(fresh,source);});
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
