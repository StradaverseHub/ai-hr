/** 2f803985 — the Schedule Group › Overtime › Overtime Setting section, as a client-safe contract.
 *
 * The section is a view over the dated group policy (lib/attendance-group-policy.ts). It never stores a
 * second copy: saving writes one future-dated, append-only policy revision per in-scope company
 * (core/attendance-overtime-setting.ts), and Attendance applies that revision from its start date through
 * the shared policy execution owner (ADR-0134). Manual is stored as a policy whose overtime is not enabled:
 * attendance then creates no payable overtime, clockings are kept, and HR enters overtime in Payroll.
 * No figure here is money; formulas stay with Overtime Patterns. */
import {ATTENDANCE_POLICY_DAY_CLASSES,validateAttendanceGroupPolicy,type AttendanceGroupPolicy,type AttendancePolicyDayClass} from './attendance-group-policy';

export const SCHEDULE_OVERTIME_ROUNDING_STEPS=[15,30,45] as const;
export const SCHEDULE_OVERTIME_AUTO_METHODS=['intersect','actual','preApproved'] as const;
export type ScheduleOvertimeSetting={
 beforeShift:boolean;afterShift:boolean;allowBackdatedWithoutClock:boolean;splitAtMidnight:boolean;
 offsetLateness:boolean;showLatenessExceptionAfterOffset:boolean;
 approval:'manual'|'auto';autoMethod:typeof SCHEDULE_OVERTIME_AUTO_METHODS[number];
 roundingMode:'up'|'down';roundingStep:typeof SCHEDULE_OVERTIME_ROUNDING_STEPS[number];
 /** The activated Overtime Pattern formula used for each day type. Required for Auto only. */
 patternVersionIds:Record<AttendancePolicyDayClass,string|null>;
};
export function defaultScheduleOvertimeSetting(defaultVersionId:string|null=null):ScheduleOvertimeSetting{
 return {beforeShift:false,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,
  showLatenessExceptionAfterOffset:false,approval:defaultVersionId?'auto':'manual',autoMethod:'actual',roundingMode:'down',roundingStep:15,
  patternVersionIds:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,defaultVersionId])) as ScheduleOvertimeSetting['patternVersionIds']};
}
/** Reopens a saved policy exactly as saved. A stored step or mode the section does not offer (5, 10, 60,
 * none, nearest — only reachable through older direct writers) is reported, never silently remapped. */
export function scheduleOvertimeSettingFromPolicy(policy:AttendanceGroupPolicy):{setting:ScheduleOvertimeSetting;unsupportedRounding:boolean}{
 const ot=policy.overtime,step=ot.rounding.step,mode=ot.rounding.mode;
 const supported=(mode==='up'||mode==='down')&&(SCHEDULE_OVERTIME_ROUNDING_STEPS as readonly unknown[]).includes(step);
 return {unsupportedRounding:!supported,setting:{beforeShift:ot.beforeShift,afterShift:ot.afterShift,allowBackdatedWithoutClock:ot.allowBackdatedWithoutClock,
  splitAtMidnight:ot.splitAtMidnight,offsetLateness:ot.offsetLateness,showLatenessExceptionAfterOffset:ot.offsetLateness&&ot.showLatenessExceptionAfterOffset===true,
  // A disabled stored policy is Manual: it creates no attendance overtime.
  approval:ot.enabled&&ot.approval==='auto'?'auto':'manual',autoMethod:ot.autoMethod,
  roundingMode:supported?mode as 'up'|'down':'down',roundingStep:supported?step as ScheduleOvertimeSetting['roundingStep']:15,
  patternVersionIds:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,ot.days[key].patternVersionId])) as ScheduleOvertimeSetting['patternVersionIds']}};
}
const uuidRe=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Read the section's own fields by VALUE. Checkboxes are absent when unticked; selects always post. */
export function parseScheduleOvertimeSetting(fd:FormData):ScheduleOvertimeSetting{
 const on=(key:string)=>{const v=fd.get(key);return v!=null&&v!=='';};
 const approval=fd.get('otApproval');
 if(approval!=='manual'&&approval!=='auto')throw new Error('Choose an Overtime Approval Method.');
 const autoMethod=String(fd.get('otAutoMethod')??'actual');
 if(!(SCHEDULE_OVERTIME_AUTO_METHODS as readonly string[]).includes(autoMethod))throw new Error('Choose an Auto Overtime Approval Method.');
 const roundingMode=fd.get('otRoundingMode'),roundingStep=Number(fd.get('otRoundingStep'));
 if(roundingMode!=='up'&&roundingMode!=='down')throw new Error('Choose an Overtime Rounding Method.');
 if(!(SCHEDULE_OVERTIME_ROUNDING_STEPS as readonly number[]).includes(roundingStep))throw new Error('Choose 15, 30 or 45 minutes for Overtime Rounding to Minute.');
 const offsetLateness=on('otOffsetLateness');
 const patternVersionIds=Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>{
  const raw=String(fd.get(`otPattern_${key}`)??'').trim();
  if(raw&&!uuidRe.test(raw))throw new Error('Choose an Overtime Pattern for each day type.');
  return [key,raw?raw.toLowerCase():null];
 })) as ScheduleOvertimeSetting['patternVersionIds'];
 const setting:ScheduleOvertimeSetting={beforeShift:on('otBeforeShift'),afterShift:on('otAfterShift'),
  allowBackdatedWithoutClock:on('otAllowBackdated'),splitAtMidnight:on('otSplitAtMidnight'),offsetLateness,
  // The dependent option is meaningful only with the offset; a stale tick on a hidden field is dropped.
  showLatenessExceptionAfterOffset:offsetLateness&&on('otShowLatenessException'),
  approval,autoMethod:autoMethod as ScheduleOvertimeSetting['autoMethod'],roundingMode,roundingStep:roundingStep as ScheduleOvertimeSetting['roundingStep'],patternVersionIds};
 if(setting.approval==='auto'&&ATTENDANCE_POLICY_DAY_CLASSES.some(key=>!setting.patternVersionIds[key]))
  throw new Error('Auto overtime needs an active Overtime Pattern for each day type. Choose one, or use Manual.');
 return setting;
}
/** The stored policy for one company. Clock pairing and grace are not part of this section: they carry
 * forward from the company's saved revision, or start from the group's own grace periods. Day-type
 * minimum and maximum carry forward too (no minimum or maximum for a first revision). */
export function scheduleOvertimeSettingPolicy(setting:ScheduleOvertimeSetting,base:{previous:AttendanceGroupPolicy|null;
 lateGraceMinutes:number;earlyGraceMinutes:number}):AttendanceGroupPolicy{
 const auto=setting.approval==='auto';
 const policy:AttendanceGroupPolicy={version:1,
  clock:base.previous?{...base.previous.clock}:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:Math.max(0,Math.trunc(base.lateGraceMinutes)),
   earlyGraceMinutes:Math.max(0,Math.trunc(base.earlyGraceMinutes)),skipLatenessIfIncomplete:false},
  overtime:{enabled:auto,beforeShift:setting.beforeShift,afterShift:setting.afterShift,allowBackdatedWithoutClock:setting.allowBackdatedWithoutClock,
   splitAtMidnight:setting.splitAtMidnight,offsetLateness:setting.offsetLateness,
   showLatenessExceptionAfterOffset:setting.offsetLateness&&setting.showLatenessExceptionAfterOffset,
   approval:setting.approval,autoMethod:setting.autoMethod,rounding:{mode:setting.roundingMode,step:setting.roundingStep},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>{const previous=base.previous?.overtime.days[key];
    return [key,{minimumMinutes:previous?.minimumMinutes??0,maximumMinutes:previous?.maximumMinutes??null,patternVersionId:auto?setting.patternVersionIds[key]:null}];
   })) as AttendanceGroupPolicy['overtime']['days']}};
 return validateAttendanceGroupPolicy(policy,4320);
}
