/** Canonical source projection only. Final-effect receipts and the financial replay remain separate. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import {latenessMinutes,earlyOutMinutes} from '../../core/attendance-calc';
import {intersectAttendancePolicyIntervals as intersect,unionAttendancePolicyIntervals as union,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';
import type {PolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';

export type PolicyWorkInput=
 |{state:'unavailable';authority:'sourceOnly';reason:'scheduleUnavailable'|'clockEvidenceUnavailable'|'incompleteClockEvidence'|'positionedScheduleUnavailable'}
 |{state:'known';authority:'sourceOnly';periodMinutes:4320;workedIntervals:AttendancePolicyInterval[];
   eligibleActualIntervals:AttendancePolicyInterval[];unpaidIntervals:AttendancePolicyInterval[];
   lateOffsetIntervals:AttendancePolicyInterval[];lateMinutes:number|null;earlyOutMinutes:number|null};

/** The canonical snapshot reader supplies both inputs. A posted envelope or scalar approval is never
 * an alternative to the complete exact-clock view, and this projection establishes no approval. */
export function attendancePolicyWorkInput(context:AttendancePolicyExecutionContext|undefined,clocks:PolicyClockMillisecondEvidence|undefined):PolicyWorkInput{
 const refuse=(reason:Extract<PolicyWorkInput,{state:'unavailable'}>['reason']):PolicyWorkInput=>({state:'unavailable',authority:'sourceOnly',reason});
 if(context?.state!=='policy')return refuse('scheduleUnavailable');
 if(!clocks)return refuse('clockEvidenceUnavailable');
 if(!clocks.complete||clocks.requiresReview||clocks.checkInMillisecond===null||clocks.checkOutMillisecond===null)return refuse('incompleteClockEvidence');
 const placement=context.placement;
 if(placement.state!=='known')return refuse('positionedScheduleUnavailable');
 const workedIntervals=union(clocks.minuteIntervals.map(row=>({from:row.inAbs,to:row.outAbs})),4320);
 const first=Math.floor(clocks.checkInMillisecond/60000),last=Math.floor(clocks.checkOutMillisecond/60000);
 const lateMinutes=placement.fixedClock?latenessMinutes({checkInAbs:first,startAbs:placement.scheduled.from,
  graceMinutes:context.resolvedClock.lateGraceMinutes,includeGrace:placement.includeGraceInLateness}):null;
 const early=placement.fixedClock?earlyOutMinutes({checkOutAbs:last,endAbs:placement.scheduled.to,
  graceMinutes:context.resolvedClock.earlyGraceMinutes,includeGrace:placement.includeGraceInEarlyOut}):null;
 const lateStart=placement.scheduled.from+(placement.includeGraceInLateness?0:context.resolvedClock.lateGraceMinutes);
 return {state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals,
  eligibleActualIntervals:intersect(workedIntervals,placement.eligibilityWindows,4320),unpaidIntervals:placement.unpaidWindows.map(row=>({...row})),
  lateOffsetIntervals:lateMinutes&&first>lateStart?[{from:lateStart,to:first}]:[],lateMinutes,earlyOutMinutes:early};
}
