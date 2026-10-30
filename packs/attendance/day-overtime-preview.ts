/** Native OT rollback preview. Pre-preview business locks survive every discarded native effect. */
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {attendanceOvertimeCalculation,payComponent} from '../../db/schema';
import {AttendanceDayOvertimeReviewWitness,type AttendanceDayOvertimeReviewViewData} from '../../lib/attendance-day-overtime-review';
import {attendanceDayEditor,lockAttendanceDayOvertimeReviewTx,saveAttendanceDayEdit,type AttendanceDayEdit} from './day-adjustment';
import {captureAttendanceDayOvertimeStateTx,attendanceDayOvertimeViewTx} from './day-overtime-effects';
import {canonicalOvertimeInputTx} from './overtime-input';
import {OvertimeOwnerError} from './overtime-patterns';
const Evidence=z.object({adjustmentId:z.guid(),eventId:z.guid(),version:z.number().int().positive(),witness:AttendanceDayOvertimeReviewWitness}).strict();
export async function readAttendanceDayOvertimeEvidenceTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string;eventId:string},current=false){
 const [row]=await tx.execute<{receipt:unknown}>(sql`select app.assistant_attendance_day_overtime_receipt(${p.employmentId}::uuid,${p.date}::date,${p.eventId}::uuid,${current}) as receipt`);
 const evidence=Evidence.parse(row?.receipt);
 return {...evidence,before:await attendanceDayOvertimeViewTx(tx,ctx,p,evidence.witness.before.summary),after:await attendanceDayOvertimeViewTx(tx,ctx,p,evidence.witness.after.summary)};
}
async function retainLabelsTx(tx:Tx,ctx:SessionContext,view:AttendanceDayOvertimeReviewViewData){
 const lines=view.pattern.lines,ids=[...new Set(lines.map(row=>row.componentId))].sort();if(!ids.length)return;
 const labels=await tx.select({id:payComponent.id,code:payComponent.code,name:payComponent.name}).from(payComponent).where(and(eq(payComponent.tenantId,ctx.tenantId),inArray(payComponent.id,ids))).orderBy(asc(payComponent.id)).for('share');
 if(lines.some(row=>!labels.some(label=>label.id===row.componentId&&label.code===row.code&&label.name===row.name)))throw Error('Native earning labels changed. Reopen the Attendance day.');
}
export async function previewAttendanceDayOvertimeTx(tx:Tx,ctx:SessionContext,input:Extract<AttendanceDayEdit,{kind:'overtime'}>){
 const p=structuredClone(input),{current,payroll}=await lockAttendanceDayOvertimeReviewTx(tx,ctx,p),ids=payroll.map(row=>row.batchId);
 const before=await captureAttendanceDayOvertimeStateTx(tx,ctx,p,ids,current),beforeView=await attendanceDayOvertimeViewTx(tx,ctx,p,before.summary);
 let canonical:unknown=null;if(before.summary.day){try{canonical=await canonicalOvertimeInputTx(tx,ctx,p);}catch(error){if(!(error instanceof OvertimeOwnerError)||error.code!=='unavailable')throw error;}}
 let evidence:Awaited<ReturnType<typeof readAttendanceDayOvertimeEvidenceTx>>,proposedHeader:unknown=null,stableAdjustment:unknown=null;
 await tx.execute(sql`savepoint attendance_day_overtime_preview`);
 try{
  const native=await saveAttendanceDayEdit(ctx,p,tx,{returnEventId:true,reviewOvertimeEffects:true});if(!native.eventId)throw Error('Native overtime evidence is unavailable.');
  evidence=await readAttendanceDayOvertimeEvidenceTx(tx,ctx,{...p,eventId:native.eventId});
  const after=await attendanceDayEditor(ctx,p.employmentId,p.date,tx);if(!after?.adjustment)throw Error('Native proposed adjustment is unavailable.');
  // Exclude ONLY newly generated adjustment ID/updatedAt and selected non-null rows' new recordedAt.
  // Existing row ID, every unselected actor/time/field, selected actor/bucket/calculation/minutes and
  // immutable financial input/approval/reference/duration commitments remain bound.
  const selected=new Set(p.rows.filter(row=>row.minutes!==null).map(row=>row.key));
  const {updatedAt,manualOtRows,...adjustment}=after.adjustment;
  stableAdjustment={...adjustment,id:current.adjustment?adjustment.id:undefined,manualOtRows:Object.fromEntries(Object.keys(manualOtRows).sort().map(key=>{const value=manualOtRows[key];if(!selected.has(key))return[key,value];const{recordedAt,...rest}=value;return[key,rest];}))};
  const calculationId=evidence.witness.after.summary.pattern.calculationId;
  if(calculationId){const[header]=await tx.select({input:attendanceOvertimeCalculation.inputDigest,approval:attendanceOvertimeCalculation.approvalDigest,references:attendanceOvertimeCalculation.referenceDigest,duration:attendanceOvertimeCalculation.durationInputDigest}).from(attendanceOvertimeCalculation).where(and(eq(attendanceOvertimeCalculation.tenantId,ctx.tenantId),eq(attendanceOvertimeCalculation.id,calculationId))).limit(1);if(!header)throw Error('Native financial input evidence is unavailable.');proposedHeader=header;}
  if(!canonical&&calculationId!==evidence.witness.before.summary.pattern.calculationId)throw Error('Review the native overtime evidence before changing this day.');
 }finally{await tx.execute(sql`rollback to savepoint attendance_day_overtime_preview`);await tx.execute(sql`release savepoint attendance_day_overtime_preview`);}
 await retainLabelsTx(tx,ctx,evidence.after);
 const unchanged=await attendanceDayEditor(ctx,p.employmentId,p.date,tx);if(!unchanged||unchanged.baseline!==current.baseline)throw Error('Native preview changed the attendance day.');
 return {before:beforeView,after:evidence.after,selectedRows:evidence.witness.selectedRows,sourceDigest:createHash('sha256').update(JSON.stringify([1,'overtime',p,before,canonical,beforeView,evidence.after,proposedHeader,stableAdjustment])).digest('hex')};
}
