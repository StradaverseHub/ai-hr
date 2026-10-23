/** Date-specific TOIL qualification over the existing independently replayed policy
 * duration. This establishes no accrual, settlement or financial permission. */
import {attendancePolicyIndependentDurationReplay,type IndependentPolicyDurationSource} from './policy-duration-replay';
import {attendancePolicyCountAttribution} from './policy-count-attribution';
import type {DatedToilCreditInput} from '../../lib/toil-dated-credit';
export type PolicyDatedToilQualification=
 |{state:'unavailable';authority:'qualifiedDatedToilProposalOnly';reason:'durationUnavailable'|'datedShiftUnavailable'|'partitionMismatch'}
 |{state:'prepared';authority:'qualifiedDatedToilProposalOnly';durationDigest:string;minutes:number;parts:DatedToilCreditInput[]};
export function attendancePolicyDatedToilQualification(source:IndependentPolicyDurationSource):PolicyDatedToilQualification{
 const refuse=(reason:Extract<PolicyDatedToilQualification,{state:'unavailable'}>['reason']):PolicyDatedToilQualification=>
  ({state:'unavailable',authority:'qualifiedDatedToilProposalOnly',reason});
 try{
  const duration=attendancePolicyIndependentDurationReplay(source),proposal=source.policyExecutionProposal,context=source.policyExecutionContext;
  if(duration.state!=='known'||context?.state!=='policy'||proposal?.state!=='proposed'||proposal.duration.status!=='calculated')return refuse('durationUnavailable');
  const counts=attendancePolicyCountAttribution(proposal.duration);if(counts.state!=='known'||counts.minutes!==duration.minutes)return refuse('partitionMismatch');
  const parts:DatedToilCreditInput[]=[];
  for(const [sequence,part]of proposal.duration.parts.entries()){
   const count=counts.parts[sequence],calendar=context.calendar.filter(row=>row.date===part.date);
   if(!count||count.calendarDate!==part.date||count.dayClass!==part.dayClass||calendar.length!==1
    ||calendar[0].state!=='known'||calendar[0].dayClass!==part.dayClass||calendar[0].companyId!==context.companyId)return refuse('partitionMismatch');
   let afterShiftMinutes:number|null=null;
   if(part.dayClass==='normal'&&count.minutes>0){
    const own=calendar[0].toilQualification;
    if(own?.state!=='known'||own.basis!=='datedScheduleOnly'||!calendar[0].references.includes('attendance-rule:'+own.ruleId)
     ||own.shiftId!==null&&!calendar[0].references.includes('shift:'+own.shiftId)
     ||!Number.isSafeInteger(own.scheduled.from)||!Number.isSafeInteger(own.scheduled.to)
     ||own.scheduled.from<0||own.scheduled.to<=own.scheduled.from||own.scheduled.to>4320)return refuse('datedShiftUnavailable');
    const offset=(Date.parse(part.date+'T00:00:00Z')-Date.parse(source.source.date+'T00:00:00Z'))/86400000;
    if(!Number.isSafeInteger(offset)||offset<0||offset>2)return refuse('partitionMismatch');
    const lower=offset*1440+own.scheduled.to;
    afterShiftMinutes=part.allocations.reduce((n,row)=>n+Math.max(0,row.to-Math.max(row.from,lower)),0)
     +count.roundingCountAttributions.reduce((n,row)=>{
      // A rounded count follows its existing selected anchor; it never creates work
      // at a later instant or borrows another date's scheduled shift end.
      const point=row.direction==='earliest'?row.anchor.from:row.anchor.to-1;
      return n+(point>=lower?row.minutes:0);
     },0);
    if(afterShiftMinutes>count.minutes)return refuse('partitionMismatch');
   }
   if(count.minutes>0)parts.push({sequence,date:part.date,dayClass:part.dayClass,minutes:count.minutes,afterShiftMinutes});
  }
  if(!parts.length||parts.reduce((n,row)=>n+row.minutes,0)!==duration.minutes)return refuse('partitionMismatch');
  return {state:'prepared',authority:'qualifiedDatedToilProposalOnly',durationDigest:duration.digest,minutes:duration.minutes,parts};
 }catch{return refuse('partitionMismatch');}
}
