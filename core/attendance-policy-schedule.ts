/** Positioned schedule inputs for the canonical dated-policy reader. No approval or financial effect. */
import type {AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {unionAttendancePolicyIntervals as union,intersectAttendancePolicyIntervals as intersect,type AttendancePolicyInterval} from '../lib/attendance-policy-intervals';
import {anchorAttendanceClockMinute} from './attendance-timeline';
import {shiftOvertimeWindowBounds,type ShiftOtWindowSpec} from './shift-ot-window';

type Break={start:string;end:string;paid?:boolean;flexible?:boolean;flexibleMinutes?:number};
export type PolicySchedulePlacement=
 |{state:'unavailable';authority:'sourceOnly';reason:'durationOwner'|'scheduleBoundaryUnavailable'|'unpositionedBreak'|'windowCountAttributionRequired'}
 |{state:'known';authority:'sourceOnly';periodMinutes:4320;scheduled:AttendancePolicyInterval;
   unpaidWindows:AttendancePolicyInterval[];eligibilityWindows:AttendancePolicyInterval[];
   fixedClock:boolean;includeGraceInLateness:boolean;includeGraceInEarlyOut:boolean};
export type PolicySchedulePlacementInput={
 start:string|null;end:string|null;crossesMidnight:boolean;dailyCutoffMinutes:number|null;
 durationOnly:boolean;flexiDuration:boolean;dayType:'workday'|'rest_day'|'holiday';
 breakMinutes:number;breakPeriods:readonly Break[]|null;flexibleBreakMinutes:number|null;
 otWindows:readonly ShiftOtWindowSpec[]|null;includeGraceInLateness:boolean;includeGraceInEarlyOut:boolean;
};
const clock=(value:string|null):number|null=>{
 if(value===null||!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.0+)?)?$/.test(value))return null;
 return Number(value.slice(0,2))*60+Number(value.slice(3,5));
};
/** A scalar allowance cannot be converted into a fictional break window. Retain that owner's
 * refusal until an explicit count-attribution contract can account for it through all consumers. */
export function attendancePolicySchedulePlacement(s:PolicySchedulePlacementInput,policy:AttendanceGroupPolicy):PolicySchedulePlacement{
 const unavailable=(reason:Extract<PolicySchedulePlacement,{state:'unavailable'}>['reason']):PolicySchedulePlacement=>({state:'unavailable',authority:'sourceOnly',reason});
 if(s.durationOnly||s.flexiDuration)return unavailable('durationOwner');
 const start=clock(s.start),last=clock(s.end),end=last===null?null:last+(s.crossesMidnight?1440:0);
 if(start===null||end===null||end<=start||!Number.isSafeInteger(s.breakMinutes)||s.breakMinutes<0||s.breakMinutes>4320)
  return unavailable('scheduleBoundaryUnavailable');
 if(s.flexibleBreakMinutes!==null||s.breakPeriods?.some(row=>!row.paid&&row.flexible&&row.flexibleMinutes!==undefined))
  return unavailable('unpositionedBreak');
 const breaks:AttendancePolicyInterval[]=[];
 for(const row of s.breakPeriods??[]){
  if(row.paid)continue;
  const a=clock(row.start),b=clock(row.end);
  if(a===null||b===null)return unavailable('unpositionedBreak');
  // Exactly the existing fixed-shift break owner's anchor, including its explicit daily cutoff.
  const from=anchorAttendanceClockMinute(a,start,s.dailyCutoffMinutes),to=anchorAttendanceClockMinute(b,start,s.dailyCutoffMinutes);
  if(to<=from||to>4320)return unavailable('unpositionedBreak');
  breaks.push({from,to});
 }
 const unpaidWindows=union(breaks,4320);
 // Existing scalar/capped allowances have a count, but no independent physical placement proof.
 if(unpaidWindows.reduce((n,row)=>n+row.to-row.from,0)!==s.breakMinutes)return unavailable('unpositionedBreak');
 let eligibilityWindows:AttendancePolicyInterval[]=[];
 if(policy.overtime.enabled){
  if(s.dayType!=='workday')eligibilityWindows=[{from:0,to:4320}];
  else{
   if(policy.overtime.beforeShift&&start>0)eligibilityWindows.push({from:0,to:start});
   if(policy.overtime.afterShift&&end<4320)eligibilityWindows.push({from:end,to:4320});
   if(s.otWindows?.length){
    if(s.otWindows.some(row=>(row.minMinutes??0)!==0||row.maxMinutes!==null&&row.maxMinutes!==undefined
      ||(row.adjustAfterMinutes!==null&&row.adjustAfterMinutes!==undefined)||(row.adjustDeltaMinutes??0)!==0))
     return unavailable('windowCountAttributionRequired');
    const windows=s.otWindows.map(row=>shiftOvertimeWindowBounds(row,start));
    if(windows.some(row=>!Number.isSafeInteger(row.from)||!Number.isSafeInteger(row.to)||row.from<0||row.to<=row.from||row.to>4320))
     return unavailable('scheduleBoundaryUnavailable');
    eligibilityWindows=intersect(eligibilityWindows,windows,4320);
   }
  }
 }
 return {state:'known',authority:'sourceOnly',periodMinutes:4320,scheduled:{from:start,to:end},unpaidWindows,
  eligibilityWindows,fixedClock:s.dayType==='workday',includeGraceInLateness:s.includeGraceInLateness,includeGraceInEarlyOut:s.includeGraceInEarlyOut};
}
