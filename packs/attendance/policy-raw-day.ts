/** One raw-day projection from canonical policy evidence. No OT approval or financial authority. */
import type {AttendanceTraceV1,DeductionTrace} from '../../core/attendance-trace';
import type {ResolvedAttendanceRule} from '../../core/attendance-rule';
import {deductionsApplyOn} from '../../core/attendance-calc';
import {exceptionRevisionOn} from '../../lib/schedule-exception';
import {attendancePolicyRawFigures} from './policy-raw-figures';
import type {attendancePolicyRawInputTx} from './policy-raw-input';
type Raw=Extract<Awaited<ReturnType<typeof attendancePolicyRawInputTx>>,{state:'policy'}>;
const label=(ms:number)=>{const second=Math.floor(ms/1000)%86400;return [Math.floor(second/3600),Math.floor(second/60)%60,second%60].map(v=>String(v).padStart(2,'0')).join(':');};
/** The template supplies the canonical schedule snapshot only. Its measured values are discarded.
 * Missing capture receipts retain visible raw labels but establish no work, arrival, deduction or
 * trace. Incomplete captured sets stay open; their original Out records remain in the punch log. */
export function attendancePolicyRawDay(raw:Raw,p:{rule:ResolvedAttendanceRule|null;template:AttendanceTraceV1|null;
 dayType:'workday'|'rest_day'|'holiday';halfDayBefore:number;fallbackIn:string|null;fallbackOut:string|null}){
 const figures=attendancePolicyRawFigures(raw,p.rule,p.dayType);
 if(figures.state!=='calculated')throw Error('Canonical raw Attendance rule is unavailable.');
 const proof=raw.clocks,first=proof?.checkInMillisecond??null,last=proof?.checkOutMillisecond??null;
 const captured=raw.source.state==='known'&&proof!==undefined;
 const complete=captured&&proof.complete&&!proof.requiresReview;
 const checkInAt=captured?(first===null?null:label(first)):p.fallbackIn;
 const checkOutAt=captured?(last!==null&&(complete||first===null)?label(last):null):checkInAt?null:p.fallbackOut;
 let trace:AttendanceTraceV1|null=null;
 let status:'present'|'late'|'half_day'=figures.lateMinutes!==null&&figures.lateMinutes>0?'late':'present';
 if(captured&&first!==null&&p.template){
  if(p.template.schedule.ruleId!==raw.context.schedule.ruleId||p.template.schedule.dayType!==p.dayType)
   throw Error('Canonical raw Attendance schedule changed.');
  trace=structuredClone(p.template);
  const boundary=raw.context.clockPlacement??raw.context.placement;
  trace.schedule.breakSpanned=figures.workedMinutes===null?null:
   proof.minuteIntervals.reduce((sum,row)=>sum+row.outAbs-row.inAbs,0)-figures.workedMinutes;
  trace.punch={inAbs:Math.floor(first/60000),outAbs:complete&&last!==null?Math.floor(last/60000):null,
   spanMinutes:complete?proof.minuteIntervals.reduce((sum,row)=>sum+row.outAbs-row.inAbs,0):null,
   workedMinutes:figures.workedMinutes,calculationIntervals:proof.minuteIntervals.map(row=>({...row})),
   intervalSource:raw.context.resolvedClock.pairing==='auto'?'closedPunchPairs':'elapsedEnvelope'};
  trace.lateness=figures.lateMinutes===null||boundary.state!=='known'?null:{startAbs:boundary.scheduled.from,
   graceMinutes:raw.context.resolvedClock.lateGraceMinutes,thresholdAbs:boundary.scheduled.from+raw.context.resolvedClock.lateGraceMinutes,
   checkInAbs:Math.floor(first/60000),includeGrace:boundary.includeGraceInLateness,minutes:figures.lateMinutes};
  trace.earlyOut=figures.earlyOutMinutes===null||boundary.state!=='known'||last===null?null:{endAbs:boundary.scheduled.to,
   graceMinutes:raw.context.resolvedClock.earlyGraceMinutes,thresholdAbs:boundary.scheduled.to-raw.context.resolvedClock.earlyGraceMinutes,
   checkOutAbs:Math.floor(last/60000),includeGrace:boundary.includeGraceInEarlyOut,minutes:figures.earlyOutMinutes};
  const applies=deductionsApplyOn(p.rule,raw.context.date)&&exceptionRevisionOn(p.rule?.exceptions,raw.context.date)?.enabled!==true;
  const deduction=(measured:number|null,minutes:number|null,every:number,block:number):DeductionTrace|null=>minutes===null?null:
   {applies,everyMinutes:applies?every:null,deductPerBlock:applies?block:null,blocks:applies&&every>0?Math.floor((measured??0)/every):0,minutes};
  trace.latenessDeduction=deduction(figures.lateMinutes,figures.lateDeductMinutes,p.rule!.lateAfterMinutes,p.rule!.lateDeductMinutes);
  trace.earlyOutDeduction=deduction(figures.earlyOutMinutes,figures.earlyOutDeductMinutes,p.rule!.earlyAfterMinutes,p.rule!.earlyDeductMinutes);
  trace.overtime=null;
  if(complete&&last!==null&&p.dayType==='workday'&&!raw.context.schedule.crossesMidnight&&!raw.context.schedule.flexiDuration
   &&!raw.context.schedule.durationOnly&&status!=='late'&&Math.floor(last/60000)<p.halfDayBefore)status='half_day';
 }
 return {checkInAt,checkOutAt,status,workedMinutes:figures.workedMinutes,otMinutes:null,lateMinutes:figures.lateMinutes,
  earlyOutMinutes:figures.earlyOutMinutes,underMinutes:figures.underMinutes,lateDeductMinutes:figures.lateDeductMinutes,
  earlyOutDeductMinutes:figures.earlyOutDeductMinutes,calcTrace:trace,
  otFlatMinutes:null,ot00Minutes:null,ot10Minutes:null,ot15Minutes:null,ot20Minutes:null,ot30Minutes:null};
}
