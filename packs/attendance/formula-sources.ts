/** Native attendance source adapter. It neither changes attendance nor creates a payable claim. */
import {createHash} from 'node:crypto';
import {and,asc,eq,gte,inArray,isNull,isNotNull,lte,or,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,attendancePunch,attendanceCorrection,employment,leaveType,company} from '../../db/schema';
import {assertModuleGate} from '../../core/module-gate';
import {employmentInformationAt} from '../../core/information-correction-history';
import {assertWorkforceEmploymentTx} from '../../core/workforce-access';
import {provenCompanyDatesTx} from '../../core/employment-company';
import {isAttendanceTrace} from '../../core/attendance-trace';
import {attendanceFormulaToilSourceTx,approvedLeaveMeasurementsTx} from '../leave/service';
import {ATTENDANCE_FORMULA_VARIABLES,ATTENDANCE_FORMULA_FIELDS} from '../../lib/attendance-formula-catalog';
import type {AttendanceFormulaDay,AttendanceFormulaFact} from '../../lib/attendance-formula-language';
import type {FormulaValue} from '../../lib/pay-formula-registry';
import {addDaysIso,datesBetween,isoWeekdayOf} from '../../lib/roster-month';
import {isCalendarDate} from '../../lib/calendar-date';
import {attendanceFormulaOvertimeMeasurements} from '../../lib/attendance-formula-overtime';
import {attendanceFormulaLeaveMeasurements} from '../../core/attendance-formula-leave';
import {attendanceFormulaRecordedMeasurements} from '../../core/attendance-formula-measurements';
import {fullFlexiIntervals} from '../../lib/full-flexi-time';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {recordedOvertimeWorkIntervals,canonicalOvertimeInputTx} from './overtime-input';
import {OvertimeOwnerError,type CanonicalOvertimeSnapshot} from './overtime-patterns';
import {intersectAttendancePolicyIntervals as intersect,attendancePolicyIntervalMinutes as count,subtractAttendancePolicyIntervals as subtract,unionAttendancePolicyIntervals as union,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,entry)=>entry&&typeof entry==='object'&&!Array.isArray(entry)?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b))):entry)).digest('hex');
/** Authorization is checked against the real effective employer for every requested date. */
export async function readAttendanceFormulaDaysTx(tx:Tx,ctx:SessionContext,p:{companyId:string;employmentId:string;from:string;to:string;fields?:readonly {code:string;key:string}[];variables?:readonly string[];includeEligibility?:boolean}){
 assertModuleGate(ctx,'attendance');
 if(!isCalendarDate(p.from)||!isCalendarDate(p.to)||p.to<p.from||p.to>addDaysIso(p.from,61)||p.to>todayInKualaLumpur())throw Error('Choose a valid attendance period.');
 if((p.variables?.length??0)>128||p.variables?.some(id=>!ATTENDANCE_FORMULA_VARIABLES.some(variable=>variable.id===id)))throw Error('Choose variables from the Attendance library.');
 if((p.fields?.length??0)>32||p.fields?.some(request=>!ATTENDANCE_FORMULA_FIELDS.some(field=>field.function===request.code&&field.key===request.key)))throw Error('Choose fields from the Attendance variable library.');
 if(p.includeEligibility||p.fields?.some(request=>request.code.startsWith('Employee')&&request.key!=='basicSalary'))await assertWorkforceEmploymentTx(tx,ctx,p.employmentId,'view');
 let salaryAllowed=false;
 if(p.fields?.some(request=>request.code==='EmployeeInformation'&&request.key==='basicSalary')){const [permission]=await tx.execute<{allowed:boolean}>(sql`select app.pay_formula_trace_access(${p.companyId}::uuid,${p.employmentId}::uuid,'{"categories":["compensation"],"fieldIds":["payroll.basic_salary_and_salary_history.basicsalary"],"workforce":false}'::jsonb) as allowed`);salaryAllowed=permission?.allowed===true;}
 const dates=datesBetween(p.from,p.to);if(dates.length>62)throw Error('An attendance formula period is limited to 62 days.');
 const [subject]=await tx.select({row:employment,allowed:sql<boolean>`app.can_admin_employment(${employment.id}) and app.is_admin_for(${p.companyId}::uuid)`}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.id,p.employmentId))).limit(1);
 if(!subject?.allowed)throw Error('Attendance formula testing requires the employee and company administrative scope.');
 const adjacent=p.variables?.some(id=>id.startsWith('Yesterday')||id.startsWith('Tomorrow'))===true;
 const sourceDates=adjacent?datesBetween(addDaysIso(p.from,-1),p.to<todayInKualaLumpur()?addDaysIso(p.to,1):p.to):dates;
 const employers=await provenCompanyDatesTx(tx,sourceDates.map(date=>({employmentId:p.employmentId,date})));
 const readDates=sourceDates.filter(date=>{const proof=employers.get(p.employmentId+'|'+date);return proof&&!proof.reason&&proof.companyId===p.companyId;});
 const readableDate=new Set(readDates);
 if(dates.some(date=>{const proof=employers.get(p.employmentId+'|'+date);return !proof||proof.reason||proof.companyId!==p.companyId;}))throw Error('The entire formula period must belong to the selected effective company.');
 const from=readDates[0],to=readDates.at(-1)!;
 const records=await tx.select().from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,p.employmentId),inArray(attendance.attendanceDate,readDates))).orderBy(asc(attendance.attendanceDate),asc(attendance.id));
 if(new Set(records.map(row=>row.attendanceDate)).size!==records.length)throw Error('Attendance day identity is ambiguous.');
 const punches=await tx.select().from(attendancePunch).where(and(eq(attendancePunch.tenantId,ctx.tenantId),eq(attendancePunch.employmentId,p.employmentId),inArray(attendancePunch.attendanceDate,readDates),isNull(attendancePunch.voidedAt))).orderBy(asc(attendancePunch.attendanceDate),asc(attendancePunch.punchAt),asc(attendancePunch.id)).limit(8193);
 if(punches.length>8192)throw Error('The attendance clock source exceeds the supported review limit.');
 const leave=await approvedLeaveMeasurementsTx(tx,{employmentIds:[p.employmentId],from,to,today:todayInKualaLumpur(),positions:true});
 for(const key of leave.keys())if(!readableDate.has(key.slice(key.lastIndexOf(':')+1)))leave.delete(key);
 const typeIds=[...new Set([...leave.values()].flatMap(value=>value.types))];
 const types=typeIds.length?await tx.select({id:leaveType.id,code:leaveType.code}).from(leaveType).where(inArray(leaveType.id,typeIds)).orderBy(asc(leaveType.id)):[];
 const leaveCodes=(date:string,half:'AM'|'PM')=>{if(!readableDate.has(date))return null;const evidence=leave.get(p.employmentId+':'+date);if(evidence?.leave===null||evidence?.unknownTypes.length||evidence?.leave?.some(piece=>piece.session==='hourly'))return null;const rows=(evidence?.leave??[]).filter(piece=>piece.session==='full_day'||piece.session===half);const codes=rows.map(piece=>types.find(type=>type.id===piece.typeId)?.code);return codes.some(code=>!code)?null:[...new Set(codes as string[])].sort().join(',');};
 const snapshots=new Map<string,CanonicalOvertimeSnapshot>();
 for(const row of records){try{snapshots.set(row.attendanceDate,await canonicalOvertimeInputTx(tx,ctx,{employmentId:p.employmentId,date:row.attendanceDate}));}catch(error){if(!(error instanceof OvertimeOwnerError)||error.code!=='unavailable')throw error;}}
 const [companyFields]=p.fields?.some(field=>field.code==='CompanyCode')?await tx.select({code:company.companyLabel,name:company.legalName}).from(company).where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,p.companyId))):[];
 const datedEmployment=new Map<string,{hiredOn:string;joinDate:string|null}>();
 for(const date of readDates){const [row]=await tx.select({hiredOn:employmentInformationAt('hiredOn',sql`${date}::date`,sql`${employment.hiredOn}`),joinDate:employmentInformationAt('joinDate',sql`${date}::date`,sql`${employment.joinDate}`)}).from(employment).where(eq(employment.id,p.employmentId));if(row)datedEmployment.set(date,row);}
 const clockAdjustments=p.variables?.includes('ClockSrcAdjusted')?await tx.select({id:attendanceCorrection.id,date:attendanceCorrection.attendanceDate,decidedAt:attendanceCorrection.decidedAt}).from(attendanceCorrection).where(and(eq(attendanceCorrection.tenantId,ctx.tenantId),eq(attendanceCorrection.employmentId,p.employmentId),inArray(attendanceCorrection.attendanceDate,readDates),eq(attendanceCorrection.status,'approved'),or(isNotNull(attendanceCorrection.proposedCheckIn),isNotNull(attendanceCorrection.proposedCheckOut),isNotNull(attendanceCorrection.clockChanges)))).orderBy(asc(attendanceCorrection.attendanceDate),asc(attendanceCorrection.id)).limit(501):null;
 if(clockAdjustments&&clockAdjustments.length>500)throw Error('The clock adjustment source exceeds the supported review limit.');
 const needsToil=p.variables?.some(id=>id==='OTtoLeave_isUtilizeAll'||id==='OTtoLeave_TotalOTUsed')===true;
 const toilSource=needsToil?await attendanceFormulaToilSourceTx(tx,ctx,{employmentId:p.employmentId,from:p.from,to:p.to}):null;
 const sourceDigest=digest({toilSource,clockAdjustments,datedEmployment:[...datedEmployment],companyFields,snapshots:[...snapshots],companyId:p.companyId,employment:subject.row,employers:[...employers],records,punches,leave:[...leave],types});
 const projectedDays:AttendanceFormulaDay[]=readDates.map(date=>{
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
  for(const [half,suffix]of [['AM','1stHalf'],['PM','2ndHalf']] as const){const codes=leaveCodes(date,half);if(codes!==null){string('LeaveCode'+suffix,codes,'approved-leave');}const evidence=leave.get(p.employmentId+':'+date);if(!evidence?.unknownTypes.length&&evidence?.leave!==null&&!evidence?.leave?.some(piece=>piece.session==='hourly'||piece.session==='full_day'&&piece.days!==1))decimal('LeaveValue'+suffix,(evidence?.leave??[]).filter(piece=>piece.session===half||piece.session==='full_day').reduce((sum,piece)=>sum+(piece.session==='full_day'?piece.days/2:piece.days),0),'approved-leave');}
  const leaveEvidence=leave.get(p.employmentId+':'+date);if(leaveEvidence?.leave&&!leaveEvidence.unknownTypes.length){const pieces=leaveEvidence.leave;if(pieces.every(piece=>piece.minutes!==null))decimal('OnLeaveDurationMins',pieces.reduce((sum,piece)=>sum+piece.minutes!,0),'approved-leave');}else if(!leaveEvidence)decimal('OnLeaveDurationMins',0,'approved-leave-empty');
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
  if(clockAdjustments!==null)flag('ClockSrcAdjusted',clockAdjustments.some(row=>row.date===date),'approved-native-clock-corrections');
  decimal('ClockSrcCount',dayPunches.length,'canonical-active-punches');
  if(toilSource!==null){const used=toilSource.find(part=>part.date===date)?.minutes??0;decimal('OTtoLeave_TotalOTUsed',used,'native-retained-toil-accrual');if(row.otMinutes!==null&&used<=row.otMinutes)flag('OTtoLeave_isUtilizeAll',used>0&&used===row.otMinutes,'native-retained-toil-accrual-versus-recorded-ot');}
  decimal('TotalWorkingMins',row.workedMinutes);decimal('OTEntry',row.otMinutes);decimal('LateInShift',row.lateMinutes);decimal('EarlyOutFromShift',row.earlyOutMinutes);
  string('DayTypeToday',row.dayType);string('SysDetectDayType',row.dayType);string('FirstInTime',row.checkInAt);string('LastOutTime',row.checkOutAt);
  if(!trace)return {date,values};
  const {schedule,punch,lateness,earlyOut,overtime}=trace;
  if(trace.formulaSchedule?.weeklyPattern)string('DutyRosterPattern',JSON.stringify(trace.formulaSchedule.weeklyPattern),'frozen-native-shift-week-pattern');
  const snapshot=snapshots.get(date),context=snapshot?.policyExecutionContext,placement=context?.state==='policy'?(context.workPlacement??context.placement):undefined;
  const calendar=context?.state==='policy'?context.calendar.find(day=>day.date===date):undefined;
  if(calendar?.state==='known'){flag('GazettedPublicHoliday',calendar.dayClass==='publicHoliday','canonical-dated-calendar');string('DayCodeInfo',calendar.dayClass,'canonical-dated-calendar');}
  const review=snapshot?.policyClockReview;if(review?.state==='known')string('PairingRemark',review.evidence.flags.map(flag=>flag.kind).join(','),'canonical-pairing-review');
  const approvals=snapshot?.policyApprovalInput;
  const activePlans=approvals?.requests.filter(request=>request.status==='approved'&&!request.cancelledAt);
  const plans=activePlans?.every(request=>request.positionedPlan.state==='recorded')?union(activePlans.flatMap(request=>request.positionedPlan.state==='recorded'?request.positionedPlan.intervals:[]),4320):undefined;
  if(plans)decimal('ScheduleOT',count(plans,4320),'canonical-positioned-approved-plans');
  decimal('FirstIn',punch.inAbs);decimal('LastOut',punch.outAbs);decimal('FirstInLastOutMins',punch.spanMinutes);decimal('ShiftStart',schedule.startAbs);decimal('ShiftEnd',schedule.endAbs);
  if(schedule.shiftId)decimal('ShiftSeq',1,'native-single-shift-per-date-identity');
  string('ShiftID',schedule.shiftId);string('ShiftGroupID',schedule.ruleId);decimal('ScheduleWorkingTime',schedule.normalMinutesOverride??schedule.scheduledMinutes);
  if(schedule.startAbs!==null)string('ShiftStartTime',String(Math.floor(schedule.startAbs/60)%24).padStart(2,'0')+':'+String(schedule.startAbs%60).padStart(2,'0'));
  if(schedule.endAbs!==null)string('ShiftEndTime',String(Math.floor(schedule.endAbs/60)%24).padStart(2,'0')+':'+String(schedule.endAbs%60).padStart(2,'0'));
  if(lateness){decimal('InGracePeriod',lateness.graceMinutes);decimal('LateInShiftRaw',Math.max(0,lateness.checkInAbs-lateness.startAbs));decimal('LateWithinGracePeriod',Math.min(Math.max(0,lateness.checkInAbs-lateness.startAbs),lateness.graceMinutes));}
  if(earlyOut){decimal('OutGracePeriod',earlyOut.graceMinutes);decimal('EarlyOutFromShiftRaw',Math.max(0,earlyOut.endAbs-earlyOut.checkOutAbs));}
  if(schedule.startAbs!==null)decimal('EarlyInShift',Math.max(0,schedule.startAbs-punch.inAbs));
  if(punch.outAbs!==null&&schedule.endAbs!==null)decimal('LateOut',Math.max(0,punch.outAbs-schedule.endAbs));
  if(overtime){decimal('OTAdjustment',overtime.minutes-overtime.rawMinutes);}
  const rawPairs=fullFlexiIntervals(dayPunches,row.checkInAt,trace.schedule.dailyCutoffMinutes??null);
  if(dayPunches.length<=128&&rawPairs.complete&&new Set(dayPunches.map(part=>part.punchAt+':'+part.direction)).size===dayPunches.length&&!(review?.state==='known'&&review.evidence.requiresReview)){const ordered=rawPairs.intervals;decimal('UnproductiveTime',ordered.at(-1)!.outAbs-ordered[0].inAbs-ordered.reduce((sum,part)=>sum+part.outAbs-part.inAbs,0),'canonical-closed-pair-gap-measurement');}
  const rawPhysical=rawPairs.complete&&dayPunches.length<=128&&new Set(dayPunches.map(part=>part.punchAt+':'+part.direction)).size===dayPunches.length&&!(review?.state==='known'&&review.evidence.requiresReview)?rawPairs.intervals.map(part=>({from:part.inAbs,to:part.outAbs})):null;
  const captured=recordedOvertimeWorkIntervals(row,dayPunches);
  const positioned=captured?.every(part=>Number.isSafeInteger(Number(part.startEpochSeconds)/60)&&Number.isSafeInteger(part.elapsedSeconds/60))?captured:null;
  const base=Date.parse(date+'T00:00:00+08:00')/1000;
  const selectedPhysical=positioned?.map(interval=>({from:(Number(interval.startEpochSeconds)-base)/60,to:(Number(interval.startEpochSeconds)-base+interval.elapsedSeconds)/60}))??null;
  const recordedMeasurements=attendanceFormulaRecordedMeasurements(trace,rawPhysical,selectedPhysical);
  for(const [id,value]of Object.entries(recordedMeasurements.values))decimal(id,value,'native-frozen-schedule-and-closed-clocks');
  const leaveMeasurement=attendanceFormulaLeaveMeasurements(trace,leaveEvidence?.unknownTypes.length?null:leaveEvidence?.leave??(leaveEvidence?null:[]),recordedMeasurements.breaks);
  for(const [id,value]of Object.entries(leaveMeasurement.values))decimal(id,value,'approved-positioned-leave-and-frozen-schedule');
  if(leaveMeasurement.allCodes)for(const [half,suffix]of [['AM','1stHalf'],['PM','2ndHalf']] as const){const codes=leaveMeasurement.allCodes[half].map(id=>types.find(type=>type.id===id)?.code);if(codes.every(code=>code!=null))string('LeaveCode'+suffix+'All',codes.sort().join(','),'all-approved-positioned-leave-types');}
  if(positioned&&schedule.startAbs!==null&&schedule.endAbs!==null){
   const work=selectedPhysical!;
   const frozen=trace.formulaSchedule;
   const frozenMatches=frozen?.v===1&&context?.state==='policy'&&JSON.stringify(frozen.breakPeriods)===JSON.stringify(context.schedule.breakPeriods)&&frozen.flexibleBreakMinutes===context.schedule.flexibleBreakMinutes&&frozen.flexiDuration===context.schedule.flexiDuration;
   if(frozenMatches&&placement?.state==='known'&&placement.scheduled.from===schedule.startAbs&&placement.scheduled.to===schedule.endAbs){
    const net=subtract(work,placement.unpaidWindows,4320);
    decimal('ShiftWorkingMins',count(intersect(net,[{from:schedule.startAbs,to:schedule.endAbs}],4320),4320),'canonical-net-positioned-work');
    const approved=snapshot?.input.approval.status==='notRequired'&&!activePlans?.length?net:plans?intersect(net,plans,4320):undefined;
    for(const [id,value]of Object.entries(attendanceFormulaOvertimeMeasurements({net,approved:approved??null,start:schedule.startAbs,end:schedule.endAbs,crossesMidnight:schedule.crossesMidnight})))decimal(id,value,'canonical-positioned-work-and-approval');
    for(const [zone,window]of [['A',{from:0,to:schedule.startAbs}],['B',{from:schedule.endAbs,to:4320}]] as const){
     const covered=window.to>window.from?intersect(net,[window],4320):[];
     decimal('Zone'+zone+'WorkingMins',count(covered,4320),'canonical-net-positioned-work');if(zone==='A')decimal('EarlyIn',count(covered,4320),'canonical-net-before-shift-work');
     const classes=context?.state==='policy'?covered.flatMap(part=>{const output:string[]=[];for(let offset=Math.floor(part.from/1440);offset<=Math.floor((part.to-1)/1440);offset++){const proof=context.calendar.find(proof=>proof.date===addDaysIso(date,offset));if(proof?.state!=='known')return ['unavailable'];output.push(proof.dayClass);}return output;}):[];
     if(classes.length&&new Set(classes).size===1&&classes[0]!=='unavailable'){string('Zone'+zone+'DayType',classes[0],'canonical-dated-calendar');if(zone==='A')string('ZoneADayTypeDesc',classes[0],'canonical-dated-calendar');}
    }
    if(approved)decimal('OTAssignmentInShift',count(intersect(approved,[{from:schedule.startAbs,to:schedule.endAbs}],4320),4320),'canonical-positioned-approval');
   }
   if(punch.spanMinutes!==null)decimal('OutOfOfficeDurationMins',Math.max(0,punch.spanMinutes-count(work,4320)),'canonical-positioned-work');
  }
  return {date,values};
 });
 const days=dates.map(date=>projectedDays.find(day=>day.date===date)!);
 for(const day of days)for(const [prefix,offset]of [['Yesterday',-1],['Tomorrow',1]] as const){const neighbor=projectedDays.find(other=>other.date===addDaysIso(day.date,offset));if(!neighbor)continue;for(const id of ['ZoneADayType','ZoneAWorkingMins','ZoneBWorkingMins']){const fact=neighbor.values[id];if(fact?.state==='known')day.values={...day.values,[prefix+id]:fact};}}
 const eligibilityFacts=p.includeEligibility?dates.map(date=>{
  const snapshot=snapshots.get(date),facts=snapshot?.input.facts;
  const field=(key:keyof NonNullable<typeof facts>)=>{const value=facts?.[key];return value?.state==='known'?value.value:null;};
  const end=[subject.row.resignationDate,subject.row.lastWorkingDate,subject.row.terminatedOn].filter((value):value is string=>!!value).sort()[0];
  return {date,facts:{companyId:p.companyId,departmentId:field('departmentId'),businessUnitId:field('businessUnitId'),positionId:field('positionId'),gradeId:field('gradeId'),employmentType:field('employmentType'),employmentCategory:field('employmentCategory'),branch:field('orgBranch'),division:field('orgDivision'),region:field('orgRegion'),line:field('orgLine'),section:field('orgSection'),team:field('orgTeam'),base:field('orgBase'),status:end&&end<date?'terminated':'active'}};
 }):[];
 return {days,sourceDigest,eligibilityFacts};
}
