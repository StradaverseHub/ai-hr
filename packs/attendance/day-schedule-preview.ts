/** Native rollback preview. Validation/leave/day/payroll locks survive the preview SAVEPOINT. */
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceOvertimeCalculation,payComponent} from '../../db/schema';
import {AttendanceDayReviewWitness,type AttendanceDayReviewViewData} from '../../lib/attendance-day-review';
import {attendanceDayEditor,lockAttendanceDayScheduleReviewTx,saveAttendanceDayEdit,type AttendanceDayEdit} from './day-adjustment';
import {captureAttendanceDayReviewStateTx,attendanceDayReviewViewTx} from './day-schedule-effects';
import {canonicalOvertimeInputTx} from './overtime-input';
import {OvertimeOwnerError} from './overtime-patterns';
const Evidence=z.object({adjustmentId:z.guid(),eventId:z.guid(),version:z.number().int().positive(),witness:AttendanceDayReviewWitness}).strict();
export async function readAttendanceDayScheduleEvidenceTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string;eventId:string},current=false){
 const [record]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_attendance_day_schedule_receipt(${p.employmentId}::uuid,${p.date}::date,${p.eventId}::uuid,${current}) as receipt`);
 const evidence=Evidence.parse(record?.receipt);
 return {...evidence,before:await attendanceDayReviewViewTx(tx,ctx,p,evidence.witness.before.summary),after:await attendanceDayReviewViewTx(tx,ctx,p,evidence.witness.after.summary)};
}
async function retainLabelLocksTx(tx:Tx,ctx:SessionContext,view:AttendanceDayReviewViewData){
 const lines=view.pattern.lines,ids=[...new Set(lines.map(row=>row.componentId))].sort();
 if(!ids.length)return;
 const labels=await tx.select({id:payComponent.id,code:payComponent.code,name:payComponent.name}).from(payComponent).where(and(eq(payComponent.tenantId,ctx.tenantId),inArray(payComponent.id,ids))).orderBy(asc(payComponent.id)).for('share');
 if(lines.some(row=>!labels.some(label=>label.id===row.componentId&&label.code===row.code&&label.name===row.name)))throw Error('Native earning labels changed. Reopen the Attendance day.');
}
export async function previewAttendanceDayScheduleTx(tx:Tx,ctx:SessionContext,input:Extract<AttendanceDayEdit,{kind:'schedule'}>){
 const p=structuredClone(input),{current,payroll}=await lockAttendanceDayScheduleReviewTx(tx,ctx,p),ids=payroll.map(row=>row.batchId);
 const before=await captureAttendanceDayReviewStateTx(tx,ctx,p,ids,current),beforeView=await attendanceDayReviewViewTx(tx,ctx,p,before.summary);
 let canonical:unknown=null;
 if(before.summary.day){try{canonical=await canonicalOvertimeInputTx(tx,ctx,p);}catch(error){if(!(error instanceof OvertimeOwnerError)||error.code!=='unavailable')throw error;}}
 let evidence:Awaited<ReturnType<typeof readAttendanceDayScheduleEvidenceTx>>,proposedNativeDigests:unknown=null;
 await tx.execute(sql`savepoint attendance_day_schedule_preview`);
 try{
  const native=await saveAttendanceDayEdit(ctx,p,tx,{returnEventId:true,reviewEffects:true});if(!native.eventId)throw Error('Native day evidence is unavailable.');
  evidence=await readAttendanceDayScheduleEvidenceTx(tx,ctx,{...p,eventId:native.eventId});
  const calculationId=evidence.witness.after.summary.pattern.calculationId;
  if(calculationId){const [header]=await tx.select({input:attendanceOvertimeCalculation.inputDigest,approval:attendanceOvertimeCalculation.approvalDigest,references:attendanceOvertimeCalculation.referenceDigest,duration:attendanceOvertimeCalculation.durationInputDigest}).from(attendanceOvertimeCalculation).where(and(eq(attendanceOvertimeCalculation.tenantId,ctx.tenantId),eq(attendanceOvertimeCalculation.id,calculationId))).limit(1);if(!header)throw Error('Native proposed input evidence is unavailable.');proposedNativeDigests=header;}
  // A new financial record needs canonical native provenance, never guessed preview facts.
  if(!canonical&&evidence.witness.after.summary.pattern.calculationId!==evidence.witness.before.summary.pattern.calculationId)throw Error('Review the native overtime evidence before changing this day.');
 }finally{await tx.execute(sql`rollback to savepoint attendance_day_schedule_preview`);await tx.execute(sql`release savepoint attendance_day_schedule_preview`);}
 await retainLabelLocksTx(tx,ctx,evidence.after);
 const editor=await attendanceDayEditor(ctx,p.employmentId,p.date,tx);if(!editor||editor.baseline!==current.baseline)throw Error('Native preview changed the attendance day.');
 return {before:beforeView,after:evidence.after,sourceDigest:createHash('sha256').update(JSON.stringify([1,before,canonical,beforeView,evidence.after,proposedNativeDigests])).digest('hex')};
}
