/** Native attendance source adapter. It neither changes attendance nor creates a payable claim. */
import {createHash} from 'node:crypto';
import {and,asc,eq,gte,inArray,isNull,lte,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,attendancePunch,employment,leaveType,company} from '../../db/schema';
import {assertModuleGate} from '../../core/module-gate';
import {employmentInformationAt} from '../../core/information-correction-history';
import {assertWorkforceEmploymentTx} from '../../core/workforce-access';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {isAttendanceTrace} from '../../core/attendance-trace';
import {approvedLeaveMeasurementsTx} from '../leave/service';
import {ATTENDANCE_FORMULA_VARIABLES,ATTENDANCE_FORMULA_FIELDS} from '../../lib/attendance-formula-catalog';
import type {AttendanceFormulaDay,AttendanceFormulaFact} from '../../lib/attendance-formula-language';
import type {FormulaValue} from '../../lib/pay-formula-registry';
import {addDaysIso,datesBetween,isoWeekdayOf} from '../../lib/roster-month';
import {isCalendarDate} from '../../lib/calendar-date';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {recordedOvertimeWorkIntervals,canonicalOvertimeInputTx} from './overtime-input';
import {OvertimeOwnerError,type CanonicalOvertimeSnapshot} from './overtime-patterns';
import {intersectAttendancePolicyIntervals as intersect,attendancePolicyIntervalMinutes as count,subtractAttendancePolicyIntervals as subtract,unionAttendancePolicyIntervals as union,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry)).digest('hex');
/** Authorization is checked against the real effective employer for every requested date. */
export async function readAttendanceFormulaDaysTx(tx:Tx,ctx:SessionContext,p:{companyId:string;employmentId:string;from:string;to:string;fields?:readonly {code:string;key:string}[];includeEligibility?:boolean}){
 assertModuleGate(ctx,'attendance');
 if(!isCalendarDate(p.from)||!isCalendarDate(p.to)||p.to<p.from||p.to>addDaysIso(p.from,61)||p.to>todayInKualaLumpur())throw Error('Choose a valid attendance period.');
 if((p.fields?.length??0)>32||p.fields?.some(request=>!ATTENDANCE_FORMULA_FIELDS.some(field=>field.function===request.code&&field.key===request.key)))throw Error('Choose fields from the Attendance variable library.');
 if(p.includeEligibility||p.fields?.some(request=>request.code.startsWith('Employee')&&request.key!=='basicSalary'))await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'view');
 let salaryAllowed=false;
 if(p.fields?.some(request=>request.code==='EmployeeInformation'&&request.key==='basicSalary')){const [permission]=await tx.execute<{allowed:boolean}>(sql`select app.pay_formula_trace_access(${p.companyId}::uuid,${p.employmentId}::uuid,'{"categories":["compensation"],"fieldIds":["payroll.basic_salary_and_salary_history.basicsalary"],"workforce":false}'::jsonb) as allowed`);salaryAllowed=permission?.allowed===true;}
 const dates=datesBetween(p.from,p.to);if(dates.length>62)throw Error('An attendance formula period is limited to 62 days.');
 const [subject]=await tx.select({row:employment,allowed:sql<boolean>`app.can_admin_employment(${employment.id}) and app.is_admin_for(${p.companyId}::uuid)`}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.id,p.employmentId))).limit(1);
 if(!subject?.allowed)throw Error('Attendance formula testing requires the employee and company administrative scope.');
 const employers=await provenCompanyDatesTx(tx,dates.map(date=>({employmentId:p.employmentId,date})));
 if(dates.some(date=>{const proof=employers.get(p.employmentId+'|'+date);return !proof||proof.reason||proof.companyId!==p.companyId;}))throw Error('The entire formula period must belong to the selected effective company.');
 const from=addDaysIso(p.from,-1),to=addDaysIso(p.to,1);
 const records=await tx.select().from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,p.employmentId),gte(attendance.attendanceDate,from),lte(attendance.attendanceDate,to))).orderBy(asc(attendance.attendanceDate),asc(attendance.id));
 if(new Set(records.map(row=>row.attendanceDate)).size!==records.length)throw Error('Attendance day identity is ambiguous.');
 const punches=await tx.select().from(attendancePunch).where(and(eq(attendancePunch.tenantId,ctx.tenantId),eq(attendancePunch.employmentId,p.employmentId),gte(attendancePunch.attendanceDate,from),lte(attendancePunch.attendanceDate,to),isNull(attendancePunch.voidedAt))).orderBy(asc(attendancePunch.attendanceDate),asc(attendancePunch.punchAt),asc(attendancePunch.id));
 const leave=await approvedLeaveMeasurementsTx(tx,{employmentIds:[p.employmentId],from,to,today:todayInKualaLumpur()});
 const typeIds=[...new Set([...leave.values()].flatMap(value=>value.types))];
 const types=typeIds.length?await tx.select({id:leaveType.id,code:leaveType.code}).from(leaveType).where(inArray(leaveType.id,typeIds)).orderBy(asc(leaveType.id)):[];
 const leaveCodes=(date:string,half:'AM'|'PM')=>{const evidence=leave.get(p.employmentId+':'+date);if(evidence?.leave===null||evidence?.unknownTypes.length)return null;const rows=(evidence?.leave??[]).filter(piece=>piece.session==='full_day'||piece.session===half);const codes=rows.map(piece=>types.find(type=>type.id===piece.typeId)?.code);return codes.some(code=>!code)?null:[...new Set(codes as string[])].sort().join(',');};
 const snapshots=new Map<string,CanonicalOvertimeSnapshot>();
 for(const row of records){try{snapshots.set(row.attendanceDate,await canonicalOvertimeInputTx(tx,ctx,{employmentId:p.employmentId,date:row.attendanceDate}));}catch(error){if(!(error instanceof OvertimeOwnerError)||error.code!=='unavailable')throw error;}}
 const [companyFields]=p.fields?.some(field=>field.code==='CompanyCode')?await tx.select({code:company.companyLabel,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,p.companyId))):[];
 const datedEmployment=new Map<string,{hiredOn:string;joinDate:string|null}>();
 for(const date of dates){const [row]=await tx.select({hiredOn:employmentInformationAt('hiredOn',sql`${date}::date`,sql`${employment.hiredOn}`),joinDate:employmentInformationAt('joinDate',sql`${date}::date`,sql`${employment.joinDate}`)}).from(employment).where(eq(employment.id,p.employmentId));if(row)datedEmployment.set(date,row);}
 const sourceDigest=digest({datedEmployment:[...datedEmployment],companyFields,snapshots:[...snapshots],companyId:p.companyId,employment:subject.row,employers:[...employers],records,punches,leave:[...leave],types});
 const days:AttendanceFormulaDay[]=dates.map(date=>{
  const row=records.find(record=>record.attendanceDate===date),trace=isAttendanceTrace(row?.calcTrace)?row.calcTrace:null;
  const values:Record<string,AttendanceFormulaFact>=Object.fromEntries(ATTENDANCE_FORMULA_VARIABLES.map(variable=>[variable.id,{state:'unavailable',reason:'Required canonical evidence is unavailable for this date.'}]));
  const put=(id:string,value:FormulaValue,source:string)=>{values[id]={state:'known',value,source,revision:sourceDigest};};
  const decimal=(id:string,value:number|null|undefined,source='recorded-attendance')=>{if(value!=null&&Number.isFinite(value))put(id,{type:'decimal',value:String(value)},source);};
  const string=(id:string,value:string|null|undefined,source='recorded-attendance')=>{if(value!=null)put(id,{type:'string',value},source);};
  const flag=(id:string,value:boolean,source='recorded-attendance')=>put(id,{type:'boolean',value},source);
  const dateValue=(id:string,value:string|null|undefined,source:string)=>{if(value&&isCalendarDate(value))put(id,{type:'date',value},source);};
  dateValue('RecordDate',date,'canonical-attendance-date');dateValue('ShiftDate',date,'canonical-attendance-date');dateValue('DayDate',date,'canonical-attendance-date');
  decimal('WeekDayNumber',isoWeekdayOf(date),'hr-date');string('WeekDay',['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'][isoWeekdayOf(date)-1],'hr-date');
  string('PID',subject.row.personId,'effective-employment');dateValue('StartWork',datedEmployment.get(date)?.hiredOn,'dated-employment-information');
  const end=[subject.row.resignationDate,subject.row.lastWorkingDate,subject.row.terminatedOn].filter((value):value is string=>!!value).sort()[0];dateValue('LastWork',end,'effective-employment');flag('isResigned',!!end&&end<date,'effective-employment');
  for(const [prefix,offset]of [['Yesterday',-1],['Tomorrow',1]] as const){const adjacent=addDaysIso(date,offset),other=records.find(record=>record.attendanceDate===adjacent);string(prefix+'NormalDayType',other?.dayType);const am=leaveCodes(adjacent,'AM'),pm=leaveCodes(adjacent,'PM');if(am!==null&&pm!==null)string(prefix+'LeaveCode',[...new Set([am,pm].filter(Boolean))].sort().join(','),'approved-leave');}
  for(const [half,suffix]of [['AM','1stHalf'],['PM','2ndHalf']] as const){const codes=leaveCodes(date,half);if(codes!==null){string('LeaveCode'+suffix,codes,'approved-leave');string('LeaveCode'+suffix+'All',codes,'approved-leave');}const evidence=leave.get(p.employmentId+':'+date);if(!evidence?.unknownTypes.length&&evidence?.leave!==null)decimal('LeaveValue'+suffix,(evidence?.leave??[]).filter(piece=>piece.session===half||piece.session==='full_day').reduce((sum,piece)=>sum+(piece.session==='full_day'?piece.days/2:piece.days),0),'approved-leave');}
  const leaveEvidence=leave.get(p.employmentId+':'+date);if(leaveEvidence?.leave&&!leaveEvidence.unknownTypes.length){const hourly=leaveEvidence.leave.filter(piece=>piece.session==='hourly');if(hourly.every(piece=>piece.minutes!==null))decimal('OnLeaveDurationMins',hourly.reduce((sum,piece)=>sum+piece.minutes!,0),'approved-leave');}else if(!leaveEvidence)decimal('OnLeaveDurationMins',0,'approved-leave-empty');
  const nativeSnapshot=snapshots.get(date);
  for(const request of p.fields??[]){
   const descriptor=ATTENDANCE_FORMULA_FIELDS.find(field=>field.function===request.code&&field.key===request.key)!;
   if(descriptor.dateBasis==='current-only'&&date!==todayInKualaLumpur())continue;
   let value:unknown;
   if(request.code==='CompanyCode')value=request.key==='id'?p.companyId:companyFields?.[request.key as 'code'|'name'];
   else if(request.code==='EmployeeProfile')value=request.key==='groupJoinDate'?datedEmployment.get(date)?.hiredOn:request.key==='joinDate'?datedEmployment.get(date)?.joinDate:({employeeNo:subject.row.employeeCode,resignationDate:subject.row.resignationDate,confirmationDate:subject.row.confirmationDate,lastWorkingDate:subject.row.lastWorkingDate} as Record<string,unknown>)[request.key];
   else if(request.code==='EmployeeInformation'){if(request.key==='basicSalary'&&!salaryAllowed)continue;const field=nativeSnapshot?.input.facts[request.key as keyof NonNullable<typeof nativeSnapshot>['input']['facts']];if(field?.state==='known')value=field.value;}
   else if(request.code==='ShiftCode'&&trace)value=({id:trace.schedule.shiftId,start:trace.schedule.startAbs,end:trace.schedule.endAbs,workingMinutes:trace.schedule.normalMinutesOverride??trace.schedule.scheduledMinutes,breakMinutes:trace.schedule.breakMinutes} as Record<string,unknown>)[request.key];
   if(value!==undefined&&value!==null&&value!==''){const key=request.code+':'+request.key;if(descriptor.type==='decimal')decimal(key,Number(value),descriptor.source);else if(descriptor.type==='date')dateValue(key,String(value),descriptor.source);else string(key,String(value),descriptor.source);}
  }
  if(!row)return {date,values};
  const dayPunches=punches.filter(punch=>punch.attendanceId===row.id);
  decimal('ClockSrcCount',dayPunches.length,'canonical-active-punches');
  decimal('TotalWorkingMins',row.workedMinutes);decimal('OTEntry',row.otMinutes);decimal('LateInShift',row.lateMinutes);decimal('EarlyOutFromShift',row.earlyOutMinutes);
  string('DayTypeToday',row.dayType);string('SysDetectDayType',row.dayType);string('FirstInTime',row.checkInAt);string('LastOutTime',row.checkOutAt);
  if(!trace)return {date,values};
  const {schedule,punch,lateness,earlyOut,overtime}=trace;
  const snapshot=snapshots.get(date),context=snapshot?.policyExecutionContext,placement=context?.state==='policy'?(context.workPlacement??context.placement):undefined;
  const calendar=context?.state==='policy'?context.calendar.find(day=>day.date===date):undefined;
  if(calendar?.state==='known'){flag('GazettedPublicHoliday',calendar.dayClass==='publicHoliday','canonical-dated-calendar');string('DayCodeInfo',calendar.dayClass,'canonical-dated-calendar');}
  const review=snapshot?.policyClockReview;if(review?.state==='known')string('PairingRemark',review.evidence.flags.map(flag=>flag.kind).join(','),'canonical-pairing-review');
  const approvals=snapshot?.policyApprovalInput;
  const activePlans=approvals?.requests.filter(request=>request.status==='approved'&&!request.cancelledAt);
  const plans=activePlans?.every(request=>request.positionedPlan.state==='recorded')?union(activePlans.flatMap(request=>request.positionedPlan.state==='recorded'?request.positionedPlan.intervals:[]),4320):undefined;
  if(plans)decimal('ScheduleOT',count(plans,4320),'canonical-positioned-approved-plans');
  decimal('FirstIn',punch.inAbs);decimal('LastOut',punch.outAbs);decimal('FirstInLastOutMins',punch.spanMinutes);decimal('ShiftStart',schedule.startAbs);decimal('ShiftEnd',schedule.endAbs);
  string('ShiftID',schedule.shiftId);string('ShiftGroupID',schedule.ruleId);decimal('ScheduleWorkingTime',schedule.normalMinutesOverride??schedule.scheduledMinutes);decimal('ShiftWorkingMins',schedule.normalMinutesOverride??schedule.scheduledMinutes);
  if(schedule.startAbs!==null)string('ShiftStartTime',String(Math.floor(schedule.startAbs/60)%24).padStart(2,'0')+':'+String(schedule.startAbs%60).padStart(2,'0'));
  if(schedule.endAbs!==null)string('ShiftEndTime',String(Math.floor(schedule.endAbs/60)%24).padStart(2,'0')+':'+String(schedule.endAbs%60).padStart(2,'0'));
  if(lateness){decimal('InGracePeriod',lateness.graceMinutes);decimal('LateInShiftRaw',Math.max(0,lateness.checkInAbs-lateness.startAbs));decimal('LateWithinGracePeriod',Math.min(Math.max(0,lateness.checkInAbs-lateness.startAbs),lateness.graceMinutes));}
  if(earlyOut){decimal('OutGracePeriod',earlyOut.graceMinutes);decimal('EarlyOutFromShiftRaw',Math.max(0,earlyOut.endAbs-earlyOut.checkOutAbs));}
  if(schedule.startAbs!==null)decimal('EarlyInShift',Math.max(0,schedule.startAbs-punch.inAbs));
  if(punch.outAbs!==null&&schedule.endAbs!==null)decimal('LateOut',Math.max(0,punch.outAbs-schedule.endAbs));
  if(overtime){decimal('OTAdjustment',overtime.minutes-overtime.rawMinutes);}
  const positioned=recordedOvertimeWorkIntervals(row,dayPunches);
  if(positioned&&schedule.startAbs!==null&&schedule.endAbs!==null){
   const base=Date.parse(date+'T00:00:00+08:00')/1000;
   const work:AttendancePolicyInterval[]=positioned.map(interval=>({from:(Number(interval.startEpochSeconds)-base)/60,to:(Number(interval.startEpochSeconds)-base+interval.elapsedSeconds)/60}));
   if(placement?.state==='known'&&placement.scheduled.from===schedule.startAbs&&placement.scheduled.to===schedule.endAbs){
    const net=subtract(work,placement.unpaidWindows,4320);
    const approved=plans?intersect(net,plans,4320):snapshot?.input.approval.status==='notRequired'?net:undefined;
    for(const [zone,window]of [['A',{from:0,to:schedule.startAbs}],['B',{from:schedule.endAbs,to:4320}]] as const){
     const covered=window.to>window.from?intersect(net,[window],4320):[];
     decimal('Zone'+zone+'WorkingMins',count(covered,4320),'canonical-net-positioned-work');
     const classes=context?.state==='policy'?covered.flatMap(part=>{const output:string[]=[];for(let offset=Math.floor(part.from/1440);offset<=Math.floor((part.to-1)/1440);offset++){const proof=context.calendar.find(proof=>proof.date===addDaysIso(date,offset));if(proof?.state!=='known')return ['unavailable'];output.push(proof.dayClass);}return output;}):[];
     if(classes.length&&new Set(classes).size===1&&classes[0]!=='unavailable'){string('Zone'+zone+'DayType',classes[0],'canonical-dated-calendar');if(zone==='A')string('ZoneADayTypeDesc',classes[0],'canonical-dated-calendar');}
     if(approved){const approvedMinutes=window.to>window.from?count(intersect(approved,[window],4320),4320):0;decimal('ApproveZone'+zone+'OT',approvedMinutes,'canonical-positioned-approval');}
    }
    if(approved)decimal('OTAssignmentInShift',count(intersect(approved,[{from:schedule.startAbs,to:schedule.endAbs}],4320),4320),'canonical-positioned-approval');
   }
   if(punch.spanMinutes!==null)decimal('OutOfOfficeDurationMins',Math.max(0,punch.spanMinutes-count(work,4320)),'canonical-positioned-work');
  }
  return {date,values};
 });
 const eligibilityFacts=p.includeEligibility?dates.map(date=>{
  const snapshot=snapshots.get(date),facts=snapshot?.input.facts;
  const field=(key:keyof NonNullable<typeof facts>)=>{const value=facts?.[key];return value?.state==='known'?value.value:null;};
  const end=[subject.row.resignationDate,subject.row.lastWorkingDate,subject.row.terminatedOn].filter((value):value is string=>!!value).sort()[0];
  return {date,facts:{companyId:p.companyId,departmentId:field('departmentId'),businessUnitId:field('businessUnitId'),positionId:field('positionId'),gradeId:field('gradeId'),employmentType:field('employmentType'),employmentCategory:field('employmentCategory'),branch:field('orgBranch'),division:field('orgDivision'),status:end&&end<date?'terminated':'active'}};
 }):[];
 return {days,sourceDigest,eligibilityFacts};
}
