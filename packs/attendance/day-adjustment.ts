import {AttendanceDayOvertimeChanges} from '../../lib/attendance-day-overtime-review';
import {captureAttendanceDayOvertimeStateTx,attendanceDayOvertimeViewTx,attendanceDayOvertimeWitnessTx} from './day-overtime-effects';
import {captureAttendanceDayReviewStateTx,attendanceDayReviewWitnessTx} from './day-schedule-effects';
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { type SessionContext, type Tx } from '../../db/client';
import { actorOf, appendEvent } from '../../db/events';
import * as s from '../../db/schema';
import { withAttendanceTenant,assertModuleGate } from '../../core/module-gate';
import { attendanceDayCalculationTx, recomputeDayFigures, decideAttendanceCorrection, lockAttendanceLeaveDependenciesTx } from '../../core/attendance';
import { attendanceWorkflowsForTx } from '../../core/attendance-workflow';
import { assertShiftsAllowedForEmploymentsTx } from '../../core/schedule-shift-eligibility';
import { punchesForCorrectionTx, clockFingerprint, lockAttendancePayrollTx, markAttendancePayrollTx } from '../../core/attendance-punch-change';
import { assertNoDependentAttendanceCreditTx } from '../leave/service';
import { batchesCoveringAttendanceDates, closedBatchesCoveringAttendanceDates } from '../payroll/service';
import { attendanceApplicationType } from '../../lib/attendance-workflow';
import type { AttendanceDayKindOverride, ManualOtRows } from '../../lib/attendance-day-adjustment';
import {refreshOvertimePatternDayTx} from './overtime-calculation';

const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function dateValue(date:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('Choose a valid attendance date.');}
async function subject(tx:Tx,ctx:SessionContext,id:string){
  const [row]=await tx.select({id:s.employment.id,companyId:s.employment.companyId,personId:s.employment.personId,ruleId:s.employment.attendanceRuleId,
    allowed:sql<boolean>`app.can_admin_employment(${s.employment.id})`}).from(s.employment).where(eq(s.employment.id,id)).limit(1);
  return row?.allowed?{...row,self:!!ctx.personId&&ctx.personId===row.personId}:null;
}

async function readTx(tx:Tx,ctx:SessionContext,employmentId:string,date:string) {
  const employee=await subject(tx,ctx,employmentId);if(!employee)return null;
  const [adjustments,calculation,applications,leave,shifts,punches,processed,closed,events]=await Promise.all([
    tx.select().from(s.attendanceDayAdjustment).where(and(eq(s.attendanceDayAdjustment.employmentId,employmentId),eq(s.attendanceDayAdjustment.attendanceDate,date))).limit(1),
    attendanceDayCalculationTx(tx,ctx,employmentId,date),
    tx.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.employmentId,employmentId),eq(s.attendanceCorrection.attendanceDate,date)))
      .orderBy(asc(s.attendanceCorrection.createdAt),asc(s.attendanceCorrection.id)),
    tx.select({id:s.leaveRequest.id,name:s.leaveType.name,code:s.leaveType.code,duration:s.leaveRequest.durationType})
      .from(s.leaveRequest).innerJoin(s.leaveType,eq(s.leaveType.id,s.leaveRequest.leaveTypeId)).where(and(eq(s.leaveRequest.employmentId,employmentId),
        eq(s.leaveRequest.status,'approved'),lte(s.leaveRequest.startDate,date),gte(s.leaveRequest.endDate,date))).orderBy(asc(s.leaveRequest.id)),
    tx.select({id:s.shift.id,name:s.shift.name,code:s.shift.code,ruleId:s.shift.ruleId}).from(s.shift).where(and(isNull(s.shift.archivedAt),employee.ruleId?eq(s.shift.ruleId,employee.ruleId):undefined)).orderBy(asc(s.shift.code),asc(s.shift.id)),
    punchesForCorrectionTx(tx,employmentId,date),
    batchesCoveringAttendanceDates(tx,{companyId:employee.companyId,entries:[{employmentId,date}]}),
    closedBatchesCoveringAttendanceDates(tx,{companyId:employee.companyId,entries:[{employmentId,date}]}),
    tx.select({id:s.domainEvent.id,at:s.domainEvent.occurredAt,actor:s.person.fullName,payload:s.domainEvent.payload})
      .from(s.domainEvent).leftJoin(s.appUser,eq(s.appUser.id,s.domainEvent.actorId)).leftJoin(s.person,eq(s.person.id,s.appUser.personId)).where(and(eq(s.domainEvent.subjectEmploymentId,employmentId),eq(s.domainEvent.aggregateType,'attendance-day-adjustment'),sql`${s.domainEvent.payload}->>'date'=${date}`))
      .orderBy(desc(s.domainEvent.occurredAt),desc(s.domainEvent.id)).limit(20),
  ]);
  const adjustment=adjustments[0]??null,manual=adjustment?.manualOtRows??{};
  const workflows=await attendanceWorkflowsForTx(tx,applications.map(a=>a.id));
  const irregularities=applications.filter(a=>attendanceApplicationType(a)==='irregularity').map(a=>({
    ...a,createdAt:a.createdAt.toISOString(),workflow:workflows.get(a.id)??null,
  }));
  const rows=calculation.rows.map(row=>({...row,effectiveMinutes:manual[row.key]?.minutes??calculation.effectiveBaseRows.find(r=>r.key===row.key)?.calculatedMinutes??row.calculatedMinutes,
    autoEffectiveMinutes:calculation.effectiveBaseRows.find(r=>r.key===row.key)?.calculatedMinutes??row.calculatedMinutes,manual:manual[row.key]??null,orphan:false}));
  for(const [key,value]of Object.entries(manual))if(!rows.some(r=>r.key===key))rows.push({key,fromMinutes:0,toMinutes:null,ratePattern:'variable',rate:0,bucket:value.bucket,
    calculatedMinutes:0,effectiveMinutes:value.minutes,autoEffectiveMinutes:0,manual:value,orphan:true});
  const baseline=hash([employee,adjustment,calculation,applications,[...workflows],leave,shifts,clockFingerprint(punches),processed.map(b=>b.batchId),closed.map(b=>b.batchId)]);
  return {baseline,shiftId:adjustment?.shiftId??null,dayKind:adjustment?.dayKind??null,schedule:calculation.schedule,shifts,leave,
    rows,complete:!calculation.policyRaw&&!!calculation.day?.checkInAt&&!!calculation.day?.checkOutAt,approvedOtMinutes:calculation.approvedOtMinutes,
    closed:closed.length>0,processed:processed.length>0,self:employee.self,applications:irregularities,
    history:events.map(e=>({...e,at:e.at.toISOString()})),adjustment};
}

/** Native module admission is unchanged for both default and already-owned transaction paths. */
async function withAttendanceDayTx<T>(ctx:SessionContext,work:(tx:Tx)=>Promise<T>,existingTx?:Tx):Promise<T>{
  if(existingTx){assertModuleGate(ctx,'attendance');return work(existingTx);}
  return withAttendanceTenant(ctx,work);
}
export async function attendanceDayEditor(ctx:SessionContext,employmentId:string,date:string,existingTx?:Tx){
  dateValue(date);return withAttendanceDayTx(ctx,tx=>readTx(tx,ctx,employmentId,date),existingTx);
}
export type AttendanceDayEditorData=NonNullable<Awaited<ReturnType<typeof attendanceDayEditor>>>;
export type AttendanceDayEdit={employmentId:string;date:string;baseline:string;reason:string;confirmPayrollRecalculation:boolean} & (
  {kind:'schedule';shiftId:string|null;dayKind:AttendanceDayKindOverride|null}|
  {kind:'overtime';rows:{key:string;minutes:number|null}[]}
);

async function lockAttendanceDaySubjectTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}){
    await lockAttendanceLeaveDependenciesTx(tx,ctx,[p.employmentId]);
    const employee=await subject(tx,ctx,p.employmentId);if(!employee||employee.self)throw new Error('You cannot correct your own attendance or an employee outside your administrator scope.');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
}
/** Native pre-decryption interval admission. Recorded receipts do not reopen a payroll or mutate a day. */
export async function lockAttendanceDayScheduleIntervalTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string},mode:'pending'|'recorded'){
    assertModuleGate(ctx,'attendance');dateValue(p.date);await lockAttendanceDaySubjectTx(tx,ctx,p);
    if(mode==='pending'){await lockAttendancePayrollTx(tx,p.employmentId,p.date);await assertNoDependentAttendanceCreditTx(tx,p.employmentId,p.date);}
}
async function lockedAttendanceDayEditStateTx(tx:Tx,ctx:SessionContext,p:AttendanceDayEdit){
    await lockAttendanceDaySubjectTx(tx,ctx,p);
    const payroll=await lockAttendancePayrollTx(tx,p.employmentId,p.date);
    await assertNoDependentAttendanceCreditTx(tx,p.employmentId,p.date);
    if(payroll.some(b=>b.status==='processed')&&!p.confirmPayrollRecalculation)throw new Error('Confirm that processed payroll will be marked for recalculation.');
    await tx.select({id:s.attendance.id}).from(s.attendance).where(and(eq(s.attendance.employmentId,p.employmentId),eq(s.attendance.attendanceDate,p.date))).for('update');
    const current=await readTx(tx,ctx,p.employmentId,p.date);
    if(!current||current.baseline!==p.baseline)throw new Error('This attendance day changed. Reload it before saving.');
    if(p.kind==='schedule'){
      if(p.dayKind!==null&&!['workday','off_day','rest_day','holiday'].includes(p.dayKind))throw new Error('Choose a supported day type.');
      if(current.leave.length&&p.dayKind!==current.dayKind)throw new Error('Leave owns this date, including partial-day leave. Manage the leave request instead.');
      if(p.shiftId!==current.shiftId&&p.shiftId){
        const [sh]=await tx.select({id:s.shift.id}).from(s.shift).where(and(eq(s.shift.id,p.shiftId),isNull(s.shift.archivedAt))).limit(1).for('share');
        if(!sh)throw new Error('Choose an active shift from this organisation.');
        await assertShiftsAllowedForEmploymentsTx(tx,[{employmentId:p.employmentId,shiftId:p.shiftId}]);
      }
    }
    return {current,payroll};
}
/** Same owner/validation and retained pre-preview locks; schedule mode only. */
export async function lockAttendanceDayScheduleReviewTx(tx:Tx,ctx:SessionContext,p:Extract<AttendanceDayEdit,{kind:'schedule'}>){
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 if(p.kind!=='schedule')throw Error('Choose a supported attendance correction.');
 dateValue(p.date);const reason=p.reason.trim();if(!reason||reason.length>500)throw Error('Explain the correction in at most 500 characters.');
 assertModuleGate(ctx,'attendance');return lockedAttendanceDayEditStateTx(tx,ctx,p);
}

function nativeOvertimeManualRows(ctx:SessionContext,current:AttendanceDayEditorData,rows:Extract<AttendanceDayEdit,{kind:'overtime'}>['rows']):ManualOtRows{
  const manual:ManualOtRows={...current.adjustment?.manualOtRows};
  if(!Array.isArray(rows)||!rows.length||rows.length>100)throw new Error('Select the overtime rows to change.');
  const seen=new Set<string>();
  for(const input of rows){
    if(seen.has(input.key))throw new Error('An overtime row was submitted twice.');seen.add(input.key);
    const row=current.rows.find(r=>r.key===input.key);if(!row)throw new Error('The overtime row no longer applies. Reload this day.');
    if(input.minutes===null){delete manual[input.key];continue;}
    if(!current.complete||row.orphan||!Number.isSafeInteger(input.minutes)||input.minutes<0||input.minutes>1440)throw new Error('Enter whole overtime minutes for an applicable row on a complete attendance day.');
    manual[input.key]={minutes:input.minutes,bucket:row.bucket,calculatedMinutes:row.calculatedMinutes,recordedAt:new Date().toISOString(),actorId:ctx.userId??'system'};
  }
  return manual;
}

/** OT-only review admission under the same native business locks; no independent calculator. */
export async function lockAttendanceDayOvertimeReviewTx(tx:Tx,ctx:SessionContext,p:Extract<AttendanceDayEdit,{kind:'overtime'}>){
 p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))};
 if(p.kind!=='overtime')throw Error('Choose a supported attendance correction.');
 dateValue(p.date);const reason=p.reason.trim();if(!reason||reason.length>500)throw Error('Explain the correction in at most 500 characters.');
 assertModuleGate(ctx,'attendance');const locked=await lockedAttendanceDayEditStateTx(tx,ctx,p);
 nativeOvertimeManualRows(ctx,locked.current,p.rows);AttendanceDayOvertimeChanges.parse(p.rows);return locked;
}

export async function saveAttendanceDayEdit(ctx:SessionContext,p:AttendanceDayEdit,existingTx?:Tx,options?:{returnEventId:true;reviewEffects?:true;reviewOvertimeEffects?:true}):Promise<{version:number;adjustmentId?:string;eventId?:string}>{
  p=structuredClone(p);ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  if(options?.reviewOvertimeEffects&&p.kind!=='overtime')throw Error('Reviewed overtime effects support overtime corrections only.');
  if(options?.reviewEffects&&p.kind!=='schedule')throw Error('Reviewed effects support schedule corrections only.');
  if(!['schedule','overtime'].includes(p.kind))throw new Error('Choose a supported attendance correction.');
  dateValue(p.date);const reason=p.reason.trim();if(!reason||reason.length>500)throw new Error('Explain the correction in at most 500 characters.');
  return withAttendanceDayTx(ctx,async tx=>{
    const {current,payroll}=await lockedAttendanceDayEditStateTx(tx,ctx,p);
    const beforeReview=options?.reviewEffects?await captureAttendanceDayReviewStateTx(tx,ctx,p,payroll.map(row=>row.batchId),current):null;
    if(options?.reviewOvertimeEffects&&p.kind==='overtime'){nativeOvertimeManualRows(ctx,current,p.rows);AttendanceDayOvertimeChanges.parse(p.rows);}
    const beforeOvertime=options?.reviewOvertimeEffects?await captureAttendanceDayOvertimeStateTx(tx,ctx,p,payroll.map(row=>row.batchId),current):null;
    // Write authority alone is insufficient: validate authorized native financial evidence BEFORE mutation.
    if(beforeOvertime)await attendanceDayOvertimeViewTx(tx,ctx,p,beforeOvertime.summary);
    let shiftId=current.shiftId,dayKind=current.dayKind;let manual:ManualOtRows={...current.adjustment?.manualOtRows};
    if(p.kind==='schedule'){
      shiftId=p.shiftId;dayKind=p.dayKind;
    }else{
      manual=nativeOvertimeManualRows(ctx,current,p.rows);
    }
    const values={shiftId,dayKind,manualOtRows:manual,reason,updatedBy:ctx.userId??'system',updatedAt:new Date(),version:(current.adjustment?.version??0)+1};
    const [saved]=await tx.insert(s.attendanceDayAdjustment).values({tenantId:ctx.tenantId,employmentId:p.employmentId,attendanceDate:p.date,...values})
      .onConflictDoUpdate({target:[s.attendanceDayAdjustment.tenantId,s.attendanceDayAdjustment.employmentId,s.attendanceDayAdjustment.attendanceDate],set:values}).returning();
    const calculated=await attendanceDayCalculationTx(tx,ctx,p.employmentId,p.date);
    if(calculated.day?.checkInAt){
      const figures=await recomputeDayFigures(tx,ctx,{employmentId:p.employmentId,date:p.date,checkInAt:calculated.day.checkInAt,
        checkOutAt:calculated.day.checkOutAt,approvedOtMinutes:calculated.approvedOtMinutes});
      await tx.update(s.attendance).set(figures.columns).where(eq(s.attendance.id,calculated.day.id));
      await refreshOvertimePatternDayTx(tx,ctx,{employmentId:p.employmentId,date:p.date,reason:'Corrected attendance day'});
    }
    const eventArgs={tenantId:ctx.tenantId,aggregateType:'attendance-day-adjustment',aggregateId:saved.id,eventType:'attendance.day.corrected',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,
      payload:{date:p.date,kind:p.kind,reason,before:current.adjustment,after:saved,scheduleBefore:current.schedule,scheduleAfter:calculated.schedule,calculationBefore:current.rows,calculationAfter:calculated.rows}};
    let eventId:string|undefined;
    if(options?.reviewEffects){
      // The reviewed mode attests the ACTUAL completed effects. Default audit ordering/payload is unchanged.
      await markAttendancePayrollTx(tx,ctx,payroll,p.employmentId);
      const afterEditor=await readTx(tx,ctx,p.employmentId,p.date);if(!beforeReview||!afterEditor)throw Error('Native day review is unavailable.');
      const afterReview=await captureAttendanceDayReviewStateTx(tx,ctx,p,payroll.map(row=>row.batchId),afterEditor);
      const reviewEffects=await attendanceDayReviewWitnessTx(tx,ctx,p,payroll.map(row=>row.batchId),beforeReview,afterReview);
      eventId=await appendEvent(tx,{...eventArgs,payload:{...eventArgs.payload,reviewEffects}},{returnId:true});
    }else if(options?.reviewOvertimeEffects&&p.kind==='overtime'){
      await markAttendancePayrollTx(tx,ctx,payroll,p.employmentId);
      const editor=await readTx(tx,ctx,p.employmentId,p.date);if(!beforeOvertime||!editor)throw Error('Native overtime review is unavailable.');
      const after=await captureAttendanceDayOvertimeStateTx(tx,ctx,p,payroll.map(row=>row.batchId),editor);
      await attendanceDayOvertimeViewTx(tx,ctx,p,after.summary);
      const reviewOvertimeEffects=await attendanceDayOvertimeWitnessTx(tx,ctx,p,payroll.map(row=>row.batchId),beforeOvertime,after);
      eventId=await appendEvent(tx,{...eventArgs,payload:{...eventArgs.payload,reviewOvertimeEffects}},{returnId:true});
    }else{
      eventId=await appendEvent(tx,eventArgs,{returnId:options?.returnEventId===true});
      await markAttendancePayrollTx(tx,ctx,payroll,p.employmentId);
    }
    return eventId?{version:saved.version,adjustmentId:saved.id,eventId}:{version:saved.version};
  },existingTx);
}

export async function amendExistingAttendanceApplication(ctx:SessionContext,p:{employmentId:string;date:string;correctionId:string;baseline:string;reason:string;checkIn:string|null;checkOut:string|null;expectedStageIndex?:number;confirmPayrollRecalculation?:boolean}){
  p={...p};ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
  dateValue(p.date);const reason=p.reason.trim();if(!reason||reason.length>500)throw new Error('Explain the administrator correction in at most 500 characters.');
  return withAttendanceTenant(ctx,async tx=>{
    await lockAttendanceLeaveDependenciesTx(tx,ctx,[p.employmentId]);
    const employee=await subject(tx,ctx,p.employmentId);if(!employee||employee.self)throw new Error('You cannot decide your own attendance or an employee outside your administrator scope.');
    const payroll=await lockAttendancePayrollTx(tx,p.employmentId,p.date);
    await assertNoDependentAttendanceCreditTx(tx,p.employmentId,p.date);
    if(payroll.some(b=>b.status==='processed')&&!p.confirmPayrollRecalculation)throw new Error('Confirm that processed payroll will be marked for recalculation.');
    const current=await readTx(tx,ctx,p.employmentId,p.date);if(!current||current.baseline!==p.baseline)throw new Error('The attendance day or application changed. Reload it before deciding.');
    const [application]=await tx.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.id,p.correctionId),eq(s.attendanceCorrection.employmentId,p.employmentId),eq(s.attendanceCorrection.attendanceDate,p.date))).limit(1).for('update');
    if(!application||application.status!=='pending'||attendanceApplicationType(application)!=='irregularity')throw new Error('Choose an existing pending irregularity application for this employee and date.');
    const workflow=current.applications.find(a=>a.id===application.id)?.workflow;
    if(workflow&&workflow.currentStage!==p.expectedStageIndex)throw new Error('The approval stage changed. Reload the application.');
    const originalIn=application.adminAmendment?.checkIn??application.proposedCheckIn,originalOut=application.adminAmendment?.checkOut??application.proposedCheckOut;
    const normal=(v:string|null)=>v?v.slice(0,5):null;
    const changed=normal(p.checkIn)!==normal(originalIn)||normal(p.checkOut)!==normal(originalOut);
    if(changed){
      if(application.clockChanges||workflow&&workflow.currentStage>0)throw new Error('A staged clock-set request or a request with earlier approval decisions cannot be rewritten here. Review its original request in Application History.');
      if(!p.checkIn||!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.checkIn)||p.checkOut&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.checkOut))throw new Error('Enter valid requested clock times.');
      if(p.checkOut&&p.checkOut<=p.checkIn)throw new Error('Check-out must follow check-in for this application.');
      const amendment={version:randomUUID(),checkIn:p.checkIn,checkOut:p.checkOut,reason,actorId:ctx.userId??'system',recordedAt:new Date().toISOString()};
      await tx.update(s.attendanceCorrection).set({adminAmendment:amendment}).where(eq(s.attendanceCorrection.id,application.id));
      await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance-correction',aggregateId:application.id,eventType:'attendance-correction.admin-amended',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{reason,before:application.adminAmendment??{checkIn:application.proposedCheckIn,checkOut:application.proposedCheckOut},after:amendment}});
    }
    return decideAttendanceCorrection(ctx,{correctionId:application.id,decision:'approved',remarks:reason,expectedStageIndex:p.expectedStageIndex},tx);
  });
}


export async function attendanceIrregularitiesForDate(ctx:SessionContext,employmentId:string,date:string){
  dateValue(date);
  return withAttendanceTenant(ctx,async tx=>{
    const applications=await tx.select().from(s.attendanceCorrection).where(and(eq(s.attendanceCorrection.employmentId,employmentId),eq(s.attendanceCorrection.attendanceDate,date)))
      .orderBy(asc(s.attendanceCorrection.createdAt),asc(s.attendanceCorrection.id));
    const workflows=await attendanceWorkflowsForTx(tx,applications.map(a=>a.id));
    return applications.filter(a=>attendanceApplicationType(a)==='irregularity').map(a=>({...a,createdAt:a.createdAt.toISOString(),workflow:workflows.get(a.id)??null}));
  });
}
