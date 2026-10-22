/** Independent captured-clock replay for canonical consumers; no approval, price or settlement. */
import {isDeepStrictEqual} from 'node:util';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {AttendanceTraceV1} from '../../core/attendance-trace';
import type {RecordedPolicyClockSource} from './policy-clock-input';
import {attendancePolicyClockMillisecondEvidence,type PolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';
import {attendancePolicyRawWorkedMinutes} from './policy-work-input';
import {attendancePolicyClockMeasurements} from './policy-clock-measurements';
export type PolicyRawClockReplay=
 |{state:'unavailable';authority:'proposalOnly';reason:'sourceUnavailable'|'scheduleOwnerUnavailable'|'rawSourceMismatch'}
 |{state:'known';authority:'proposalOnly';evidence:PolicyClockMillisecondEvidence};
type RawDay={checkInAt:string|null;checkOutAt:string|null;workedMinutes:number|null;lateMinutes:number|null;
 earlyOutMinutes:number|null;underMinutes:number|null;dayType:'workday'|'rest_day'|'holiday'|null};
const label=(milliseconds:number)=>{const seconds=Math.floor(milliseconds/1000)%86400;
 return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(n=>String(n).padStart(2,'0')).join(':');};
/** The canonical source reader first validates actual capture identities and recorded schedule.
 * Replay the selected pairing at original millisecond precision, then compare the stored minute
 * projection. A stored envelope alone cannot stand in for separated actual captured sessions.
 * The result proves only this raw geometry/count contract; final approval and financial replay
 * still need their own complete receipts, payable attribution and current-source checks. */
export function replayAttendancePolicyRawClocks(context:AttendancePolicyExecutionContext|undefined,
 source:RecordedPolicyClockSource|undefined,trace:AttendanceTraceV1|null,day:RawDay):PolicyRawClockReplay{
 const refuse=(reason:Extract<PolicyRawClockReplay,{state:'unavailable'}>['reason']):PolicyRawClockReplay=>({state:'unavailable',authority:'proposalOnly',reason});
 if(source?.state!=='known')return refuse('sourceUnavailable');
 if(context?.state!=='policy'||!trace||day.dayType===null||trace.schedule.ruleId!==context.schedule.ruleId||trace.schedule.dayType!==day.dayType)
  return refuse('scheduleOwnerUnavailable');
 const evidence=attendancePolicyClockMillisecondEvidence(source.clocks,context.resolvedClock,4320);
 const first=evidence.checkInMillisecond,last=evidence.checkOutMillisecond;
 if(first===null)return refuse('rawSourceMismatch');
 const complete=evidence.complete&&!evidence.requiresReview;
 const worked=attendancePolicyRawWorkedMinutes(context,evidence),measured=attendancePolicyClockMeasurements(context,evidence);
 const late=measured.state==='measured'&&measured.lateIn.state==='known'?measured.lateIn.minutes:null;
 const early=measured.state==='measured'&&measured.earlyOut.state==='known'?measured.earlyOut.minutes:null;
 const gross=evidence.minuteIntervals.reduce((sum,row)=>sum+row.outAbs-row.inAbs,0);
 if(day.checkInAt!==label(first)||day.checkOutAt!==(complete&&last!==null?label(last):null)
  ||day.workedMinutes!==worked||day.lateMinutes!==late||day.earlyOutMinutes!==early
  ||day.underMinutes!==(day.dayType==='workday'&&worked!==null?Math.max(0,context.schedule.normalMinutes-worked):null)
  ||trace.punch.inAbs!==Math.floor(first/60000)||trace.punch.outAbs!==(complete&&last!==null?Math.floor(last/60000):null)
  ||trace.punch.spanMinutes!==(complete?gross:null)||trace.punch.workedMinutes!==worked
  ||trace.schedule.breakSpanned!==(worked===null?null:gross-worked)
  ||trace.punch.intervalSource!==(context.resolvedClock.pairing==='auto'?'closedPunchPairs':'elapsedEnvelope')
  ||!isDeepStrictEqual(trace.punch.calculationIntervals,evidence.minuteIntervals))return refuse('rawSourceMismatch');
 return {state:'known',authority:'proposalOnly',evidence};
}
