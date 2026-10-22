/** Canonical source projection only. Final-effect receipts and the financial replay remain separate. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import {attendancePolicyClockMeasurements} from './policy-clock-measurements';
import {attendancePolicyIntervalMinutes as minutes,subtractAttendancePolicyIntervals as subtract,intersectAttendancePolicyIntervals as intersect,unionAttendancePolicyIntervals as union,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';
import type {PolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';

export type PolicyWorkInput=
 |{state:'unavailable';authority:'sourceOnly';reason:'scheduleUnavailable'|'clockEvidenceUnavailable'|'incompleteClockEvidence'|'positionedScheduleUnavailable'}
 |{state:'known';authority:'sourceOnly';periodMinutes:4320;workedIntervals:AttendancePolicyInterval[];
   eligibleActualIntervals:AttendancePolicyInterval[];unpaidIntervals:AttendancePolicyInterval[];
   lateOffsetIntervals:AttendancePolicyInterval[];lateMinutes:number|null;earlyOutMinutes:number|null};

/** Net physical work for formula facts, not eligible/approved/payable OT. Remove only the proved
 * unpaid overlap, once; a scalar legacy aggregate cannot fill a missing positioned policy source. */
export function attendancePolicyNetWorkedMinutes(work:PolicyWorkInput|undefined):number|null{
 if(work?.state!=='known')return null;
 return minutes(subtract(work.workedIntervals,work.unpaidIntervals,work.periodMinutes),work.periodMinutes);
}

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
 const measured=attendancePolicyClockMeasurements(context,clocks);
 if(measured.state!=='measured')return refuse('positionedScheduleUnavailable');
 if(measured.lateOffsetIntervals===null)return refuse('incompleteClockEvidence');
 return {state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals,
  eligibleActualIntervals:intersect(workedIntervals,placement.eligibilityWindows,4320),unpaidIntervals:placement.unpaidWindows.map(row=>({...row})),
  lateOffsetIntervals:measured.lateOffsetIntervals,lateMinutes:measured.lateIn.minutes,earlyOutMinutes:measured.earlyOut.minutes};
}
