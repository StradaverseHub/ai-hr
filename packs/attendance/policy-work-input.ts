import {validateAttendancePolicyUnclockedWork,type AttendancePolicyUnclockedWork} from '../../lib/attendance-policy-unclocked-work';
/** Canonical source projection only. Final-effect receipts and the financial replay remain separate. */
import {perRowAttendanceBreakMinutes} from '../../lib/attendance-break-count';
import {fullFlexiBreakMinutes} from '../../lib/full-flexi-time';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import {attendancePolicyClockMeasurements,attendancePolicyWorkBoundaryMeasurements,type PolicyClockMeasurements} from './policy-clock-measurements';
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

/** Raw work does not depend on OT eligibility or lateness-offset allocation. Its independent
 * positive unpaid-window proof (or existing Full Flexi duration owner) must bind complete,
 * unflagged captured physical intervals.
 * Explicit refusal is never bypassed by the older full-placement compatibility fallback. */
export function attendancePolicyRawWorkedMinutes(context:AttendancePolicyExecutionContext|undefined,clocks:PolicyClockMillisecondEvidence|undefined):number|null{
 if(context?.state!=='policy'||!clocks||!clocks.complete||clocks.requiresReview
  ||clocks.checkInMillisecond===null||clocks.checkOutMillisecond===null)return null;
 // Full Flexi has no fixed shift anchors. Preserve its existing duration/break-count owner,
 // supplying captured absolute pairs/envelope selected by the explicit clock policy. A count
 // allowance does not become a positioned unpaid window or eligible/payable OT coverage.
 const placement=context.workPlacement??context.placement;
 if(context.schedule.durationOnly){
  if(placement.state!=='unavailable'||placement.reason!=='durationOwner')return null;
  const gross=clocks.minuteIntervals.reduce((sum,row)=>sum+row.outAbs-row.inAbs,0);
  return Math.max(0,gross-fullFlexiBreakMinutes(clocks.minuteIntervals,context.schedule.breakPeriods,
   context.schedule.breakMinutes,context.schedule.flexibleBreakMinutes));
 }
 if(placement.state!=='known'){
  // Existing whole allowance/scalar cliff is a duration count, not a positioned unpaid interval.
  // Reuse the existing shared per-row count owner with proved schedule anchors. Its allowance
  // contributes once, and its fixed rows intersect only captured work, never the gaps between pairs.
  const boundary=context.clockPlacement;
  if(placement.reason!=='unpositionedBreak'||boundary?.state!=='known')return null;
  const gross=clocks.minuteIntervals.reduce((sum,row)=>sum+row.outAbs-row.inAbs,0);
  const perRow=context.schedule.flexibleBreakMinutes===null?perRowAttendanceBreakMinutes(context.schedule.breakPeriods,
   context.schedule.breakMinutes,clocks.minuteIntervals,boundary.scheduled.from,context.schedule.dailyCutoffMinutes,gross):null;
  if(context.schedule.flexibleBreakMinutes===null&&context.schedule.breakPeriods?.length&&perRow===null)return null;
  return Math.max(0,gross-(perRow??fullFlexiBreakMinutes(clocks.minuteIntervals,context.schedule.breakPeriods,
   context.schedule.breakMinutes,context.schedule.flexibleBreakMinutes)));
 }
 const physical=union(clocks.minuteIntervals.map(row=>({from:row.inAbs,to:row.outAbs})),4320);
 return minutes(subtract(physical,placement.unpaidWindows,4320),4320);
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

/** Arithmetic comparison only for the separately owner-issued HR testimony. It establishes
 * neither HR authority nor a final approval. Its entered geometry remains distinct from clocks;
 * the same schedule, break, grace and late-offset owners serve the captured and attested paths. */
export function attendancePolicyUnclockedWorkComparison(context:AttendancePolicyExecutionContext|undefined,
 supplied:AttendancePolicyUnclockedWork,nowMillisecond=Date.now()):
 |{state:'unavailable';authority:'attestedWorkComparisonOnly'}
 |{state:'known';authority:'attestedWorkComparisonOnly';actualWork:AttendancePolicyUnclockedWork;
   work:Extract<PolicyWorkInput,{state:'known'}>;measurements:Extract<PolicyClockMeasurements,{state:'measured'}>}{
 const refuse=()=>({state:'unavailable' as const,authority:'attestedWorkComparisonOnly' as const});
 try{
  if(context?.state!=='policy'||!context.selected.policy.overtime.enabled
   ||!context.selected.policy.overtime.allowBackdatedWithoutClock||context.selected.activation.epoch<1
   ||supplied.sourceDate!==context.date||context.placement.state!=='known')return refuse();
  const actualWork=validateAttendancePolicyUnclockedWork(supplied,nowMillisecond),
   midnight=Date.parse(context.date+'T00:00:00+08:00');
  const workedIntervals=union(actualWork.intervals.map(span=>({
   from:Math.floor((span.fromEpochMillisecond-midnight)/60000),
   to:Math.floor((span.toEpochMillisecond-midnight)/60000)})).filter(span=>span.to>span.from),4320);
  const measurements=attendancePolicyWorkBoundaryMeasurements(context,{complete:true,requiresReview:false,firstInIsArrival:true,
   checkInMillisecond:actualWork.intervals[0].fromEpochMillisecond-midnight,
   checkOutMillisecond:actualWork.intervals.at(-1)!.toEpochMillisecond-midnight});
  if(measurements.state!=='measured'||measurements.lateOffsetIntervals===null)return refuse();
  const work:Extract<PolicyWorkInput,{state:'known'}>={state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals,
   eligibleActualIntervals:intersect(workedIntervals,context.placement.eligibilityWindows,4320),
   unpaidIntervals:context.placement.unpaidWindows.map(row=>({...row})),lateOffsetIntervals:measurements.lateOffsetIntervals,
   lateMinutes:measurements.lateIn.minutes,earlyOutMinutes:measurements.earlyOut.minutes};
  return {state:'known',authority:'attestedWorkComparisonOnly',actualWork,work,measurements};
 }catch{return refuse();}
}
