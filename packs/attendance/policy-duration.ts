/** One arithmetic coordinator for dated group policies. Every interval and approval reference must
 * first be established by canonical Attendance owners. This proposal cannot authorize a final effect,
 * price a formula, record attendance, or reserve cash/TOIL. Legacy calculations do not enter here. */
import {validateAttendanceGroupPolicy,type AttendanceGroupPolicy,type AttendancePolicyDayClass} from '../../lib/attendance-group-policy';
import {attendancePolicyIntervalMinutes as minutes,unionAttendancePolicyIntervals as union,
 intersectAttendancePolicyIntervals as intersect,subtractAttendancePolicyIntervals as subtract,
 offsetAttendancePolicyIntervals as offset,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';
import {partitionAttendancePolicyWork,type AttendancePolicyPart,type PolicyCalendarProof} from './policy-partition';
import {attendancePolicyClockSecondEvidence,type PolicyClockSecond,type PolicyClockSecondEvidence} from '../../lib/attendance-policy-clocks';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';
import {finalizePolicyOvertimeDuration,type PolicyOvertimeDurationStep} from '../../core/attendance-calc';

export type PolicyDurationMethod='actual'|'preApproved'|'intersect';
export type PolicyDurationProposalInput={
 sourceDate:string;companyId:string;periodMinutes:number;policy:AttendanceGroupPolicy;
 /** Null is missing/incomplete evidence; an empty set is a known empty result. */
 workedIntervals:readonly AttendancePolicyInterval[]|null;
 eligibleActualIntervals:readonly AttendancePolicyInterval[]|null;
 eligiblePlannedIntervals:readonly AttendancePolicyInterval[]|null;
 unpaidIntervals:readonly AttendancePolicyInterval[];
 /** Measured lateness placement under the canonical grace rule, not an inferred duration window. */
 lateOffsetIntervals:readonly AttendancePolicyInterval[]|null;
 calendar:readonly PolicyCalendarProof[];
 /** A manual workflow supplies its frozen method. Auto must match the selected policy version. */
 method:PolicyDurationMethod;approval:'approved'|'policyAuto'|'pending'|'rejected'|'unknown';
 allocationByClass:Partial<Record<AttendancePolicyDayClass,'earliest'|'latest'>>;
};
export type PolicyDurationSelectionStep=
 |{kind:'disabled';before:number;after:0}
 |{kind:'breaks';basis:'actual'|'approvedPlan';before:number;after:number}
 |{kind:'lateOffset';before:number;after:number;requested:number;applied:number}
 |{kind:'method';method:PolicyDurationMethod;before:number;after:number};
export type PolicyDurationProposal=
 |{status:'unavailable';reason:'workedEvidenceUnavailable'|'eligibleEvidenceUnavailable'|'approvalUnavailable'|'plannedEvidenceUnavailable'|'lateEvidenceUnavailable'|'calendarUnavailable'|'holidayDesignationUnavailable'|'durationLimitExceeded'|'formulaAllocationUnavailable';date?:string;authority:'proposalOnly'}
 |{status:'calculated';authority:'proposalOnly';intervalBasis:'actual'|'approvedPlan';lateOffsetMinutes:number;selectionSteps:PolicyDurationSelectionStep[];
   parts:(AttendancePolicyPart&{allocatedPayableMinutes:number;allocations:AttendancePolicyInterval[]})[];
   classes:{dayClass:AttendancePolicyDayClass;eligibleMinutes:number;payableMinutes:number;
     /** Explicit count with no fabricated clock/date placement; pricing needs a separate bound contract. */
     unplacedPayableMinutes:number;steps:PolicyOvertimeDurationStep[]}[];payableMinutes:number};

export function deriveAttendancePolicyDurationProposal(input:PolicyDurationProposalInput):PolicyDurationProposal{
 overtimeDate(input.sourceDate,'sourceDate');overtimeUuid(input.companyId,'companyId');
 const bound=input.periodMinutes,policy=validateAttendanceGroupPolicy(input.policy,bound);
 if(!['actual','preApproved','intersect'].includes(input.method))throw Error('Choose an explicit evidenced approval method.');
 const refuse=(reason:Extract<PolicyDurationProposal,{status:'unavailable'}>['reason']):PolicyDurationProposal=>({status:'unavailable',reason,authority:'proposalOnly'});
 if(input.workedIntervals===null)return refuse('workedEvidenceUnavailable');
 const work=union(input.workedIntervals,bound),breaks=union(input.unpaidIntervals,bound);
 if(input.eligibleActualIntervals===null)return refuse('eligibleEvidenceUnavailable');
 const actual=union(input.eligibleActualIntervals,bound);
 if(subtract(actual,work,bound).length)throw Error('Eligible actual intervals require complete worked coverage.');
 const empty=():PolicyDurationProposal=>({status:'calculated',authority:'proposalOnly',intervalBasis:input.method==='preApproved'?'approvedPlan':'actual',lateOffsetMinutes:0,selectionSteps:[{kind:'disabled',before:minutes(actual,bound),after:0}],parts:[],classes:[],payableMinutes:0});
 if(!policy.overtime.enabled)return empty();
 if(policy.overtime.approval==='manual'?input.approval!=='approved':input.approval!=='policyAuto'||input.method!==policy.overtime.autoMethod)return refuse('approvalUnavailable');
 // An approved plan cannot establish that any work happened; a missing-clock HR exception must have
 // its separate immutable attestation before the canonical owner supplies worked-period evidence.
 if(input.method==='preApproved'&&!work.length)return refuse('workedEvidenceUnavailable');
 let planned:AttendancePolicyInterval[]|null=null;
 if(input.method!=='actual'){
  if(input.eligiblePlannedIntervals===null)return refuse('plannedEvidenceUnavailable');
  planned=subtract(input.eligiblePlannedIntervals,breaks,bound);
 }
 let lateMinutes=0;
 if(policy.overtime.offsetLateness){
  if(input.lateOffsetIntervals===null)return refuse('lateEvidenceUnavailable');
  // A measured minute removed as unpaid break cannot also consume an OT lateness offset.
  lateMinutes=minutes(subtract(input.lateOffsetIntervals,breaks,bound),bound);
 }
 const actualAfterBreaks=subtract(actual,breaks,bound);
 // Offset once on the selected candidate basis before the method's approval restriction. Actual and
 // Intersect use actual eligibility; Pre-Approved uses evidenced plan eligibility on an established day.
 const candidate=input.method==='preApproved'?planned!:actualAfterBreaks;
 const afterOffset=offset(candidate,lateMinutes,bound);
 const selected=input.method==='intersect'?intersect(afterOffset.intervals,planned!,bound):afterOffset.intervals;
 const selectionSteps:PolicyDurationSelectionStep[]=[
  {kind:'breaks',basis:input.method==='preApproved'?'approvedPlan':'actual',
   before:minutes(input.method==='preApproved'?input.eligiblePlannedIntervals!:actual,bound),after:minutes(candidate,bound)},
  {kind:'lateOffset',before:minutes(candidate,bound),after:minutes(afterOffset.intervals,bound),requested:lateMinutes,applied:afterOffset.removedMinutes},
  {kind:'method',method:input.method,before:minutes(afterOffset.intervals,bound),after:minutes(selected,bound)},
 ];
 const partition=(intervals:readonly AttendancePolicyInterval[])=>partitionAttendancePolicyWork({sourceDate:input.sourceDate,companyId:input.companyId,
  periodMinutes:bound,splitAtMidnight:policy.overtime.splitAtMidnight,intervals,calendar:input.calendar});
 const grouped=partition(selected);
 if(grouped.status==='unavailable')return {status:'unavailable',authority:'proposalOnly',date:grouped.date,reason:grouped.reason};
 const plannedParts=planned===null?null:partition(planned);
 if(plannedParts?.status==='unavailable')return {status:'unavailable',authority:'proposalOnly',date:plannedParts.date,reason:plannedParts.reason};
 const parts=grouped.parts.map(part=>({...part,allocatedPayableMinutes:0,allocations:[] as AttendancePolicyInterval[]}));
 const classes:Extract<PolicyDurationProposal,{status:'calculated'}>['classes']=[];
 for(const dayClass of [...new Set(parts.map(part=>part.dayClass))]){
  const direction=input.allocationByClass[dayClass];
  if(direction===undefined)return refuse('formulaAllocationUnavailable');
  if(!['earliest','latest'].includes(direction))throw Error('The selected central version must supply explicit count allocation.');
  const indexes=parts.map((part,index)=>({part,index})).filter(row=>row.part.dayClass===dayClass);
  const eligibleMinutes=indexes.reduce((sum,row)=>sum+row.part.minutes,0);
  const plannedLimit=plannedParts?.status==='ready'?plannedParts.parts.filter(part=>part.dayClass===dayClass).reduce((sum,part)=>sum+part.minutes,0):null;
  const finalized=finalizePolicyOvertimeDuration({policy:policy.overtime,dayClass,approvedEligibleMinutes:eligibleMinutes,preApprovedLimitMinutes:plannedLimit,periodMinutes:bound});
  if(finalized.status!=='known')throw Error('Known selected intervals must produce a known duration.');
  const slots=indexes.flatMap(({part,index})=>part.intervals.map(interval=>({index,interval}))).sort((a,b)=>a.interval.from-b.interval.from||a.interval.to-b.interval.to);
  if(direction==='latest')slots.reverse();
  let remaining=finalized.minutes;
  for(const {index,interval} of slots){
   const count=Math.min(remaining,interval.to-interval.from);remaining-=count;
   if(!count)continue;
   parts[index].allocations.push(direction==='earliest'?{from:interval.from,to:interval.from+count}:{from:interval.to-count,to:interval.to});
   parts[index].allocatedPayableMinutes+=count;
  }
  classes.push({dayClass,eligibleMinutes,payableMinutes:finalized.minutes,unplacedPayableMinutes:remaining,steps:finalized.steps});
 }
 const payableMinutes=classes.reduce((sum,row)=>sum+row.payableMinutes,0);
 if(payableMinutes>bound)return refuse('durationLimitExceeded');
 for(const part of parts)part.allocations.sort((a,b)=>a.from-b.from||a.to-b.to);
 return {status:'calculated',authority:'proposalOnly',intervalBasis:input.method==='preApproved'?'approvedPlan':'actual',lateOffsetMinutes:afterOffset.removedMinutes,
  selectionSteps,parts,classes,payableMinutes};
}

export type PolicyClockDurationProposalInput=Omit<PolicyDurationProposalInput,'workedIntervals'|'eligibleActualIntervals'>&{
 /** Already resolved absolute source-day seconds. Missing placement never becomes a guessed clock. */
 clocks:readonly PolicyClockSecond[]|null;
 /** Resolved schedule eligibility windows, before intersecting with actual closed work and breaks. */
 actualEligibilityWindows:readonly AttendancePolicyInterval[]|null;
};
export type PolicyClockDurationProposal={authority:'proposalOnly';clockEvidence:PolicyClockSecondEvidence|null;duration:PolicyDurationProposal};
/** Entry point for captured-clock policy arithmetic. Closed work is derived from clock evidence;
 * a caller cannot substitute a worked envelope while selecting Auto or suppress close-event flags.
 * A missing-clock exception must use its separate attestation owner, not this capture adapter. */
export function deriveAttendancePolicyClockDurationProposal(input:PolicyClockDurationProposalInput):PolicyClockDurationProposal{
 const policy=validateAttendanceGroupPolicy(input.policy,input.periodMinutes);
 const clockEvidence=input.clocks===null?null:attendancePolicyClockSecondEvidence(input.clocks,policy.clock,input.periodMinutes);
 const workedIntervals=clockEvidence?.complete?clockEvidence.minuteIntervals.map(interval=>({from:interval.inAbs,to:interval.outAbs})):null;
 const eligibleActualIntervals=workedIntervals===null||input.actualEligibilityWindows===null?null:
  intersect(workedIntervals,input.actualEligibilityWindows,input.periodMinutes);
 return {authority:'proposalOnly',clockEvidence,duration:deriveAttendancePolicyDurationProposal({...input,workedIntervals,eligibleActualIntervals})};
}
