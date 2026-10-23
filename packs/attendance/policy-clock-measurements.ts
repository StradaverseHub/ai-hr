/** Boundary measurements from canonical positioned clocks. These are not approval or wage deductions. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import {earlyOutMinutes,latenessMinutes} from '../../core/attendance-calc';
import type {PolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';
import type {AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';

type Measurement=
 |{state:'known';minutes:number}
 |{state:'notApplicable';minutes:null}
 |{state:'suppressed';reason:'incompleteClock';minutes:null}
 |{state:'unavailable';reason:'missingBoundary'|'arrivalBoundaryUnavailable'|'incompleteClock';minutes:null};
export type PolicyClockMeasurements=
 |{state:'unavailable';authority:'sourceOnly';reason:'scheduleUnavailable'|'clockEvidenceUnavailable'|'positionedScheduleUnavailable'}
 |{state:'measured';authority:'sourceOnly';complete:boolean;requiresReview:boolean;
   lateIn:Measurement;earlyOut:Measurement;lateOffsetIntervals:AttendancePolicyInterval[]|null};

/** Skipping an incomplete day means unknown/suppressed, never an assertion of zero lateness.
 * With skipping disabled, only its proved first In can establish lateness. An earlier Out followed
 * by an unmatched In is not a final departure, so early-out still needs complete evidence.
 * Break-aware OT offset and actual wage deductions remain with their existing downstream owners. */
export function attendancePolicyClockMeasurements(context:AttendancePolicyExecutionContext|undefined,
 clocks:PolicyClockMillisecondEvidence|undefined):PolicyClockMeasurements{
 const unavailable=(reason:Extract<PolicyClockMeasurements,{state:'unavailable'}>['reason']):PolicyClockMeasurements=>({state:'unavailable',authority:'sourceOnly',reason});
 if(context?.state!=='policy')return unavailable('scheduleUnavailable');
 if(!clocks)return unavailable('clockEvidenceUnavailable');
 return attendancePolicyWorkBoundaryMeasurements(context,clocks);
}

/** Shared boundary arithmetic for independently proved work sources. The caller keeps the
 * source provenance: HR-entered actual instants never become captured-clock evidence. */
export function attendancePolicyWorkBoundaryMeasurements(context:AttendancePolicyExecutionContext|undefined,
 clocks:Pick<PolicyClockMillisecondEvidence,'complete'|'requiresReview'|'checkInMillisecond'|'checkOutMillisecond'|'firstInIsArrival'>):PolicyClockMeasurements{
 const unavailable=(reason:Extract<PolicyClockMeasurements,{state:'unavailable'}>['reason']):PolicyClockMeasurements=>({state:'unavailable',authority:'sourceOnly',reason});
 if(context?.state!=='policy')return unavailable('scheduleUnavailable');
 // Historical prepared contexts may carry only a positively known complete placement.
 // A new canonical context always supplies the independent boundary proof, including refusals.
 const placement=context.clockPlacement??context.placement;
 if(placement.state!=='known')return unavailable('positionedScheduleUnavailable');
 const complete=clocks.complete&&!clocks.requiresReview;
 if(!placement.fixedClock)return {state:'measured',authority:'sourceOnly',complete,requiresReview:clocks.requiresReview,
  lateIn:{state:'notApplicable',minutes:null},earlyOut:{state:'notApplicable',minutes:null},lateOffsetIntervals:[]};
 const first=clocks.checkInMillisecond===null?null:Math.floor(clocks.checkInMillisecond/60000);
 const last=clocks.checkOutMillisecond===null?null:Math.floor(clocks.checkOutMillisecond/60000);
 const lateIn:Measurement=!complete&&context.resolvedClock.skipLatenessIfIncomplete
  ?{state:'suppressed',reason:'incompleteClock',minutes:null}
  :first===null?{state:'unavailable',reason:'missingBoundary',minutes:null}
  :!clocks.firstInIsArrival?{state:'unavailable',reason:'arrivalBoundaryUnavailable',minutes:null}
  :{state:'known',minutes:latenessMinutes({checkInAbs:first,startAbs:placement.scheduled.from,
    graceMinutes:context.resolvedClock.lateGraceMinutes,includeGrace:placement.includeGraceInLateness})};
 const earlyOut:Measurement=!complete?{state:'unavailable',reason:'incompleteClock',minutes:null}
  :last===null?{state:'unavailable',reason:'missingBoundary',minutes:null}
  :{state:'known',minutes:earlyOutMinutes({checkOutAbs:last,endAbs:placement.scheduled.to,
    graceMinutes:context.resolvedClock.earlyGraceMinutes,includeGrace:placement.includeGraceInEarlyOut})};
 const lateStart=placement.scheduled.from+(placement.includeGraceInLateness?0:context.resolvedClock.lateGraceMinutes);
 const lateOffsetIntervals=lateIn.state==='known'
  ?lateIn.minutes>0&&first!==null?[{from:lateStart,to:first}]:[]:null;
 return {state:'measured',authority:'sourceOnly',complete,requiresReview:clocks.requiresReview,lateIn,earlyOut,lateOffsetIntervals};
}
