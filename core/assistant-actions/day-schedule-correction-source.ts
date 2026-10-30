/** One dated schedule correction, through the exact native Attendance owner and financial reader. */
import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {DayScheduleCorrection as C,type DayScheduleCorrectionHuman as Human} from '../../lib/assistant-actions/day-schedule-correction-contract';
import {canonicalEntitlementsForDigest} from '../../lib/assistant-actions/canonical-entitlements';
import {withAgentActionGuard} from './agent-action-guard';
import {attendanceDayEditor,lockAttendanceDayScheduleIntervalTx,previewAttendanceDayScheduleTx,saveAttendanceDayEdit,readAttendanceDayScheduleEvidenceTx} from '../../packs/attendance/service';
export class DayScheduleCorrectionUnavailable extends Error{constructor(){super('Please reopen this dated schedule correction on the native Attendance screen.');this.name='DayScheduleCorrectionUnavailable';}}
export const dayScheduleCorrectionUnavailable=():never=>{throw new DayScheduleCorrectionUnavailable();};
const fail=dayScheduleCorrectionUnavailable,hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DayScheduleNomination=z.object({employmentId:z.guid(),date:z.iso.date(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']).optional()}).strict();
const Subject=z.object({subjectId:z.guid(),employmentId:z.guid(),companyId:z.guid(),subjectPersonId:z.guid(),employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000),date:z.iso.date(),revision:z.string().max(100),generation:z.string().max(200)}).strict();
export type DayScheduleSubject=z.infer<typeof Subject>;
export async function dayScheduleActorTx(tx:Tx,ctx:SessionContext){const fresh=await withAgentActionGuard(tx,ctx,C.action,'approve');if(!isAdmin(fresh)||!fresh.userId)return fail();return fresh;}
export async function withDayScheduleIntervalTx<T>(tx:Tx,ctx:SessionContext,pick:z.infer<typeof DayScheduleNomination>,work:(fresh:SessionContext,source:DayScheduleSubject)=>Promise<T>){
 const fresh=await dayScheduleActorTx(tx,ctx);await lockAttendanceDayScheduleIntervalTx(tx,fresh,pick,pick.state&&pick.state!=='awaiting_confirmation'?'recorded':'pending');
 const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_attendance_day_schedule_scope(${pick.employmentId}::uuid,${pick.date}::date) as subject`),subject=Subject.parse(row?.subject);
 if(subject.employmentId!==pick.employmentId||subject.subjectId!==pick.employmentId||subject.date!==pick.date||subject.subjectPersonId===fresh.personId)return fail();return work(fresh,subject);
}
const nativeInput=(h:Human)=>({kind:'schedule' as const,employmentId:h.employmentId,date:h.date,baseline:h.baseline,shiftId:h.shiftId,dayKind:h.dayKind,reason:h.reason,confirmPayrollRecalculation:h.confirmPayrollRecalculation});
export async function prepareDayScheduleSourceTx(tx:Tx,ctx:SessionContext,human:Human,subject:DayScheduleSubject){
 if(human.employmentId!==subject.employmentId||human.subjectId!==subject.subjectId||human.date!==subject.date)return fail();
 const native=await previewAttendanceDayScheduleTx(tx,ctx,nativeInput(human));
 const review=C.Item.parse({...Object.fromEntries(['employmentId','subjectId','employeeName','employeeCode','companyName','date'].map(key=>[key,subject[key as keyof DayScheduleSubject]])),before:native.before,after:native.after});
 return {content:human,review,reviewedDigest:hash([1,C.action,subject,human,review,native.sourceDigest,canonicalEntitlementsForDigest(ctx.entitlements)])};
}
export async function confirmDayScheduleSourceTx(tx:Tx,ctx:SessionContext,human:Human,expected:string,subject:DayScheduleSubject){
 const current=await prepareDayScheduleSourceTx(tx,ctx,human,subject);if(current.reviewedDigest!==expected)return fail();
 await tx.execute(sql`select app.assistant_attendance_day_schedule_arm(${human.employmentId}::uuid,${human.date}::date)`);
 const native=await saveAttendanceDayEdit(ctx,nativeInput(human),tx,{returnEventId:true,reviewEffects:true});if(!native.eventId||!native.adjustmentId)return fail();
 const evidence=await readAttendanceDayScheduleEvidenceTx(tx,ctx,{employmentId:human.employmentId,date:human.date,eventId:native.eventId},true);
 if(JSON.stringify(evidence.before)!==JSON.stringify(current.review.before)||JSON.stringify(evidence.after)!==JSON.stringify(current.review.after))return fail();return{eventId:native.eventId};
}
export async function reconcileDayScheduleSourceTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},eventId:string){
 const native=await readAttendanceDayScheduleEvidenceTx(tx,ctx,{...p,eventId});return C.Receipt.parse({kind:'corrected',subjectId:p.employmentId,employmentId:p.employmentId,date:p.date,adjustmentId:native.adjustmentId,eventId:native.eventId,version:native.version,before:native.before,after:native.after});
}
export async function readDayScheduleChoicesTx(tx:Tx,ctx:SessionContext,selection:unknown){
 const fresh=await dayScheduleActorTx(tx,ctx),pick=C.Selection.parse(selection??{query:''}),pattern=`%${pick.query.replace(/[\\%_]/g,'\\$&')}%`;
 const rows=await tx.execute<{employmentId:string;employeeName:string;employeeCode:string|null;companyName:string}>(sql`select e.id as "employmentId",p.full_name as "employeeName",e.employee_code as "employeeCode",c.legal_name as "companyName" from employment e join person p on p.id=e.person_id and p.tenant_id=e.tenant_id join company c on c.id=e.company_id and c.tenant_id=e.tenant_id where e.tenant_id=${fresh.tenantId}::uuid and app.assistant_attendance_schedule_group_choice_scope(e.id) and (p.full_name ilike ${pattern} or coalesce(e.employee_code,'') ilike ${pattern}) order by p.full_name,e.id limit 26`);
 const employees=Array.from(rows).slice(0,25);let truncated=rows.length>25,day:unknown=null;
 if(pick.employmentId&&pick.date){
  await lockAttendanceDayScheduleIntervalTx(tx,fresh,{employmentId:pick.employmentId,date:pick.date},'pending');
  const [row]=await tx.execute<{subject:unknown}>(sql`select app.assistant_attendance_day_schedule_scope(${pick.employmentId}::uuid,${pick.date}::date) as subject`),subject=Subject.parse(row?.subject);
  if(!employees.some(e=>e.employmentId===subject.employmentId)){if(employees.length===25){employees.pop();truncated=true;}employees.push({employmentId:subject.employmentId,employeeName:subject.employeeName,employeeCode:subject.employeeCode,companyName:subject.companyName});}
  const editor=await attendanceDayEditor(fresh,pick.employmentId,pick.date,tx);if(!editor||editor.self||editor.closed||editor.shifts.length>200)return fail();
  day={employmentId:pick.employmentId,date:pick.date,baseline:editor.baseline,shiftId:editor.shiftId,currentShiftCode:editor.schedule.shiftCode??null,dayKind:editor.dayKind,dayKindLocked:editor.leave.length>0,processedPayroll:editor.processed,shifts:editor.shifts.map(({id,code,name})=>({id,code,name}))};
 }
 return C.Choices.parse({kind:'choices',employees,truncated,day});
}
