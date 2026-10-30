'use server';
import { AttendanceLevelError, attendanceLevelProblemToken } from '@/lib/attendance-workflow-v3';

import {attendancePolicyLocalWorkInstant} from '@/lib/attendance-policy-unclocked-work';
import { publicErrorMessage } from '@/lib/public-error';
import type { AttendanceDayKindOverride } from '@/lib/attendance-day-adjustment';
import { saveAttendanceDayEdit, amendExistingAttendanceApplication } from '@/packs/attendance/service';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { scopedAdmin } from '@/lib/scope';
import { listEmployees } from '@/core/read';
// ADR-0080 D11 — through the PACK FACADE. The page beside this file imports core/attendance directly as
// audited kernel-contract debt (test/pack-drift-allowlist.json); a NEW file may not, and the drift ratchet
// refuses one that tries.
import {
  attendanceApplicationDetail,
  requestAttendanceCorrection,
  decideAttendanceCorrection,
  ClockDataChangedError,
  AttendancePayrollClosedError,
} from '@/packs/attendance/service';

/** Decide an existing request; its original requester and proposal stay intact. */
export async function adminCorrectAttendanceDayAction(formData: FormData) {
  const {s,scopeIds}=await scopedAdmin();
  const employmentId=String(formData.get('employmentId')??''),date=String(formData.get('date')??'');
  const employees=await listEmployees(s,scopeIds);
  if(!employees.some(e=>e.employmentId===employmentId))return {ok:false as const,message:'The employee is outside your current company scope.'};
  try {
    const stage=String(formData.get('stage')??'');
    const outcome=await amendExistingAttendanceApplication(s,{employmentId,date,correctionId:String(formData.get('correctionId')??''),
      baseline:String(formData.get('baseline')??''),reason:String(formData.get('reason')??''),
      checkIn:String(formData.get('checkIn')??'')||null,checkOut:String(formData.get('checkOut')??'')||null,
      expectedStageIndex:stage===''?undefined:Number(stage),confirmPayrollRecalculation:formData.get('confirmPayrollRecalculation')==='on'});
    refreshAttendanceDay();return {ok:true as const,pending:outcome.status==='pending'};
  }catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}

function refreshAttendanceDay(){
  for(const path of ['/attendance','/attendance/individual','/attendance/daily','/attendance/requests','/attendance/application-history','/attendance/my-records','/attendance/request-status','/approvals'])revalidatePath(path);
  revalidatePath('/attendance/individual/[date]','page');
  revalidatePath('/attendance/application-history/[id]','page');
}
export async function saveAttendanceDayChangesAction(formData:FormData){
  const {s,scopeIds}=await scopedAdmin();
  const employmentId=String(formData.get('employmentId')??''),date=String(formData.get('date')??'');
  const employees=await listEmployees(s,scopeIds);
  if(!employees.some(e=>e.employmentId===employmentId))return {ok:false as const,message:'The employee is outside your current company scope.'};
  try{
    const base={employmentId,date,baseline:String(formData.get('baseline')??''),reason:String(formData.get('reason')??''),confirmPayrollRecalculation:formData.get('confirmPayrollRecalculation')==='on'};
    if(formData.get('kind')==='schedule')await saveAttendanceDayEdit(s,{...base,kind:'schedule',shiftId:String(formData.get('shiftId')??'')||null,
      dayKind:(String(formData.get('dayKind')??'')||null) as AttendanceDayKindOverride|null});
    else if(formData.get('kind')==='overtime'){
      const raw=String(formData.get('rows')??'');if(raw.length>20000)throw new Error('Too many overtime changes.');
      await saveAttendanceDayEdit(s,{...base,kind:'overtime',rows:JSON.parse(raw)});
    }else throw new Error('Choose a supported attendance correction.');
    refreshAttendanceDay();return {ok:true as const};
  }catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}

/** Mounted schedule-only adapter. Native admission/calculation/audit/revalidation remain in the
 * original owner; the overtime form and compatibility composite retain their existing route. */
export async function saveAttendanceDayScheduleAction(formData:FormData){
  if(formData.get('kind')!=='schedule')return {ok:false as const,message:'Choose a supported attendance correction.'};
  const captured=new FormData();formData.forEach((value,key)=>captured.append(key,value));
  return saveAttendanceDayChangesAction(captured);
}

/** A complete staged punch set goes through the existing request/decision workflow. */
export async function saveAttendanceClockDataAction(formData: FormData) {
  const {s,scopeIds}=await scopedAdmin();
  const employmentId=String(formData.get('employmentId') ?? ''), date=String(formData.get('date') ?? '');
  const back=`/attendance/individual/${encodeURIComponent(date)}?emp=${encodeURIComponent(employmentId)}`;
  const fail=(key:string):never=>redirect(`${back}&error=${encodeURIComponent(key)}`);
  const employees=await listEmployees(s,scopeIds);
  if (!employees.some(e=>e.employmentId===employmentId)) fail('correctionForbidden');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('correctionBadDate');
  const reason=String(formData.get('reason') ?? '').trim();
  if (!reason) fail('correctionReasonRequired');
  let correctionId:string;
  try {
    const raw=String(formData.get('clockChanges') ?? '');
    if(raw.length>40000) throw new Error('Invalid clock data');
    ({correctionId}=await requestAttendanceCorrection(s,{employmentId,date,reason,clockChanges:JSON.parse(raw)}));
  } catch(e) {
    if (e instanceof AttendanceLevelError) redirect(`${back}&workflowProblem=${encodeURIComponent(attendanceLevelProblemToken(e.problem))}`);
    fail(e instanceof ClockDataChangedError ? 'clockDataChanged' : e instanceof AttendancePayrollClosedError ? 'clockDataPayrollClosed' : 'correctionRejected');
  }
  try {const outcome=await decideAttendanceCorrection(s,{correctionId:correctionId!,decision:'approved',expectedStageIndex:0});if(outcome.status==='pending')fail('clockDataPending');}
  catch(e) {fail(e instanceof ClockDataChangedError ? 'clockDataChanged' : e instanceof AttendancePayrollClosedError ? 'clockDataPayrollClosed' : 'clockDataPending');}
  revalidatePath('/attendance');
  revalidatePath('/attendance/individual');
  revalidatePath('/attendance/my-records');
  redirect(`${back}&corrected=1`);
}

export async function rejectAttendanceDayApplicationAction(formData:FormData){
  const {s,scopeIds}=await scopedAdmin();
  try{
    const id=String(formData.get('correctionId')??''), reason=String(formData.get('reason')??'').trim();
    if(!reason||reason.length>500)throw new Error('Enter a rejection reason of at most 500 characters.');
    const detail=await attendanceApplicationDetail(s,scopeIds,id);
    if(!detail?.canDecide||detail.application.employmentId!==formData.get('employmentId')||detail.application.attendanceDate!==formData.get('date'))throw new Error('This application is not available for your decision.');
    const stage=String(formData.get('stage')??'');
    await decideAttendanceCorrection(s,{correctionId:id,decision:'rejected',rejectReason:reason,remarks:reason,expectedStageIndex:stage===''?undefined:Number(stage)});
    refreshAttendanceDay();return {ok:true as const,pending:false};
  }catch(e){return {ok:false as const,message:publicErrorMessage(e)};}
}

/** Submit explicit complete actual work for the configured workflow; this action never approves it. */
export async function submitUnclockedAttendanceWorkAction(formData:FormData){
 const {s,scopeIds}=await scopedAdmin();
 const employmentId=String(formData.get('employmentId')??''),date=String(formData.get('date')??'');
 const employees=await listEmployees(s,scopeIds);
 if(!employees.some(row=>row.employmentId===employmentId))return {ok:false as const,message:'The employee is outside your current company scope.'};
 try{
  const starts=formData.getAll('workStart'),ends=formData.getAll('workEnd');
  if(starts.length!==ends.length||starts.length<1||starts.length>16||formData.get('completeWorkedDay')!=='on')
   throw Error('Confirm the complete work date and enter every actual work interval.');
  const intervals=starts.map((start,index)=>({fromEpochMillisecond:attendancePolicyLocalWorkInstant(String(start)),toEpochMillisecond:attendancePolicyLocalWorkInstant(String(ends[index]))}));
  const requestedStarts=formData.getAll('requestedStart'),requestedEnds=formData.getAll('requestedEnd'),positioned=formData.get('useRequestedPositions')==='on';
  if(positioned?(requestedStarts.length<1||requestedStarts.length>16||requestedStarts.length!==requestedEnds.length):(requestedStarts.length>0||requestedEnds.length>0))
   throw Error('Record every interval covered by the requested overtime count.');
  const requestedIntervals=positioned?requestedStarts.map((start,index)=>({fromEpochMillisecond:attendancePolicyLocalWorkInstant(String(start)),
   toEpochMillisecond:attendancePolicyLocalWorkInstant(String(requestedEnds[index]))})):undefined;
  const result=await requestAttendanceCorrection(s,{employmentId,date,reason:String(formData.get('reason')??''),
   requestedOtMinutes:Number(formData.get('requestedOtMinutes')),unclockedWork:{completeWorkedDay:true,intervals,...(requestedIntervals?{requestedIntervals}:{})}});
  refreshAttendanceDay();return {ok:true as const,correctionId:result.correctionId};
 }catch(error){return {ok:false as const,message:publicErrorMessage(error)};}
}
