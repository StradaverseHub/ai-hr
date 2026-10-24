/** Shared, client-safe contract for explicitly activated Schedule Group policies.
 * Formula versions remain with Overtime Patterns. This contract neither authorizes nor approves work.
 * No old group receives these semantics merely because the new module exists. */
import {overtimeDate,overtimeInteger,overtimeKeys,overtimeObject,overtimeRefuse,overtimeUuid} from './overtime-pattern-schema';
export const ATTENDANCE_POLICY_DAY_CLASSES=['normal','off','rest','publicHoliday','replacementHoliday'] as const;
export type AttendancePolicyDayClass=typeof ATTENDANCE_POLICY_DAY_CLASSES[number];
export const ATTENDANCE_POLICY_ROUNDING_STEPS=[5,10,15,30,60] as const;
export type AttendanceGroupPolicy={
 version:1;
 clock:{pairing:'auto'|'firstInLastOut';minimumIntervalMinutes:number;lateGraceMinutes:number;earlyGraceMinutes:number;skipLatenessIfIncomplete:boolean};
 overtime:{enabled:boolean;beforeShift:boolean;afterShift:boolean;allowBackdatedWithoutClock:boolean;splitAtMidnight:boolean;offsetLateness:boolean;
  approval:'manual'|'auto';autoMethod:'actual'|'preApproved'|'intersect';rounding:{mode:'none'|'down'|'up'|'nearest';step:typeof ATTENDANCE_POLICY_ROUNDING_STEPS[number]|null};
  days:Record<AttendancePolicyDayClass,{minimumMinutes:number;maximumMinutes:number|null;patternVersionId:string|null}>};
};
function flag(value:unknown,path:string):boolean{
 if(typeof value!=='boolean')overtimeRefuse('invalid',path,'Choose an explicit on or off value.');return value;
}
function choice<T extends string>(value:unknown,values:readonly T[],path:string):T{
 if(typeof value!=='string'||!values.includes(value as T))overtimeRefuse('invalid',path,'Choose a supported policy option.');return value as T;
}
/** The server supplies the canonical attendance-period bound; a posted form cannot supply its own cap.
 * The expression timeline supports offsets zero through two, so no period may exceed three days. */
export function validateAttendanceGroupPolicy(raw:unknown,maxPeriodMinutes:number):AttendanceGroupPolicy{
 const max=overtimeInteger(maxPeriodMinutes,1,3*1440,'periodMinutes');
 const root=overtimeObject(raw,'policy');overtimeKeys(root,['version','clock','overtime'],'policy');
 if(root.version!==1)overtimeRefuse('invalid','policy.version','Unsupported attendance policy version.');
 const clock=overtimeObject(root.clock,'policy.clock');
 overtimeKeys(clock,['pairing','minimumIntervalMinutes','lateGraceMinutes','earlyGraceMinutes','skipLatenessIfIncomplete'],'policy.clock');
 const ot=overtimeObject(root.overtime,'policy.overtime');
 overtimeKeys(ot,['enabled','beforeShift','afterShift','allowBackdatedWithoutClock','splitAtMidnight','offsetLateness','approval','autoMethod','rounding','days'],'policy.overtime');
 const enabled=flag(ot.enabled,'policy.overtime.enabled'),rounding=overtimeObject(ot.rounding,'policy.overtime.rounding');
 overtimeKeys(rounding,['mode','step'],'policy.overtime.rounding');
 const mode=choice(rounding.mode,['none','down','up','nearest'] as const,'policy.overtime.rounding.mode');
 if(mode==='none'?rounding.step!==null:!ATTENDANCE_POLICY_ROUNDING_STEPS.includes(rounding.step as never))
  overtimeRefuse('invalid','policy.overtime.rounding.step','No rounding requires no step; otherwise choose 5, 10, 15, 30 or 60 minutes.');
 const rawDays=overtimeObject(ot.days,'policy.overtime.days');overtimeKeys(rawDays,[...ATTENDANCE_POLICY_DAY_CLASSES],'policy.overtime.days');
 const days={} as AttendanceGroupPolicy['overtime']['days'];
 for(const key of ATTENDANCE_POLICY_DAY_CLASSES){
  const path='policy.overtime.days.'+key,day=overtimeObject(rawDays[key],path);overtimeKeys(day,['minimumMinutes','maximumMinutes','patternVersionId'],path);
  const minimum=overtimeInteger(day.minimumMinutes,0,max,path+'.minimumMinutes'),maximum=day.maximumMinutes===null?null:overtimeInteger(day.maximumMinutes,0,max,path+'.maximumMinutes');
  if(maximum!==null&&minimum>maximum)overtimeRefuse('invalid',path,'Minimum overtime cannot exceed maximum overtime.');
  const patternVersionId=day.patternVersionId===null?null:overtimeUuid(day.patternVersionId,path+'.patternVersionId');
  if(enabled&&!patternVersionId)overtimeRefuse('invalid',path+'.patternVersionId','An enabled overtime policy needs a central pattern for each day classification.');
  days[key]={minimumMinutes:minimum,maximumMinutes:maximum,patternVersionId};
 }
 return {version:1,clock:{pairing:choice(clock.pairing,['auto','firstInLastOut'] as const,'policy.clock.pairing'),
  minimumIntervalMinutes:overtimeInteger(clock.minimumIntervalMinutes,0,max,'policy.clock.minimumIntervalMinutes'),
  lateGraceMinutes:overtimeInteger(clock.lateGraceMinutes,0,max,'policy.clock.lateGraceMinutes'),earlyGraceMinutes:overtimeInteger(clock.earlyGraceMinutes,0,max,'policy.clock.earlyGraceMinutes'),
  skipLatenessIfIncomplete:flag(clock.skipLatenessIfIncomplete,'policy.clock.skipLatenessIfIncomplete')},
  overtime:{enabled,beforeShift:flag(ot.beforeShift,'policy.overtime.beforeShift'),afterShift:flag(ot.afterShift,'policy.overtime.afterShift'),
   allowBackdatedWithoutClock:flag(ot.allowBackdatedWithoutClock,'policy.overtime.allowBackdatedWithoutClock'),splitAtMidnight:flag(ot.splitAtMidnight,'policy.overtime.splitAtMidnight'),offsetLateness:flag(ot.offsetLateness,'policy.overtime.offsetLateness'),
   approval:choice(ot.approval,['manual','auto'] as const,'policy.overtime.approval'),autoMethod:choice(ot.autoMethod,['actual','preApproved','intersect'] as const,'policy.overtime.autoMethod'),
   rounding:{mode,step:rounding.step as AttendanceGroupPolicy['overtime']['rounding']['step']},days}};
}
/** Activation is explicit and future-dated. Caller resolves today using the canonical HR timezone. */
export function attendanceGroupPolicyActivationDate(value:unknown,today:string){
 const date=overtimeDate(value,'effectiveFrom');overtimeDate(today,'today');
 if(date<=today)overtimeRefuse('invalid','effectiveFrom','Choose a future effective date; existing attendance and approvals keep their recorded policy.');
 return date;
}
export type EffectiveAttendanceGroupPolicy={id:string;effectiveFrom:string;effectiveTo:string|null;superseded:boolean;policy:AttendanceGroupPolicy};
/** An uncovered date is legacy mode. Ambiguous active versions refuse rather than choosing query order. */
export function attendanceGroupPolicyOn(versions:readonly EffectiveAttendanceGroupPolicy[],date:string){
 overtimeDate(date,'attendanceDate');
 const active=versions.filter(version=>!version.superseded&&version.effectiveFrom<=date&&(!version.effectiveTo||date<version.effectiveTo));
 if(active.length>1)overtimeRefuse('invalid','policy.history','Overlapping active attendance policies need correction.');
 return active[0]??null;
}
