/** Canonical source-to-central-price composition only; not financial approval or settlement. */
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyDurationReplay} from './policy-duration-replay';
import {evaluateOvertimePolicyAllocatedPrice,type OvertimePolicyAllocatedPrice} from '../../lib/overtime-pattern-evaluate';
import type {OvertimeInput,OvertimeFact} from '../../lib/overtime-pattern-model';
import type {OvertimePolicyBinding} from '../../lib/overtime-pattern-binding';
export type PolicyPricingProposal=
 |{state:'unavailable';authority:'policyPricingProposalOnly';reason:'durationUnavailable'|'formulaUnavailable'|'sourcePlacementUnavailable'|'pricingScopeUnavailable'|'partPricingUnavailable'|'datedFactsUnavailable'}
 |{state:'proposed';authority:'policyPricingProposalOnly';durationDigest:string;currency:{code:string;minorScale:number};amountMinorUnits:string;
   parts:{sequence:number;date:string;definitionDigest:string;pricing:Extract<OvertimePolicyAllocatedPrice,{state:'proposed'}>}[]};
export function attendancePolicyPricingProposal(snapshot:CanonicalOvertimeSnapshot):PolicyPricingProposal{
 const refuse=(reason:Extract<PolicyPricingProposal,{state:'unavailable'}>['reason']):PolicyPricingProposal=>({state:'unavailable',authority:'policyPricingProposalOnly',reason});
 try{
  const replay=attendancePolicyDurationReplay(snapshot),proposal=snapshot.policyExecutionProposal,formulas=snapshot.policyFormulaInput;
  if(replay.state!=='known'||proposal?.state!=='proposed'||proposal.duration.status!=='calculated')return refuse('durationUnavailable');
  if(formulas?.state!=='known')return refuse('formulaUnavailable');
  if(snapshot.input.layer!=='raw'||snapshot.input.sessionGranularity!=='recorded')return refuse('sourcePlacementUnavailable');
  const base=Date.parse(snapshot.input.source.date+'T00:00:00+08:00')/1000,parts:Extract<PolicyPricingProposal,{state:'proposed'}>['parts']=[];
  const pricedPartCount=proposal.duration.parts.filter(part=>part.allocatedPayableMinutes>0).length;
  let total=BigInt('0');
  for(const [sequence,part]of proposal.duration.parts.entries()){
   if(part.allocatedPayableMinutes===0)continue;
   const refs=formulas.references.filter(row=>row.date===part.date),formula=refs[0];
   if(refs.length!==1||formula.state!=='known'||formula.dayClass!==part.dayClass||formula.moneyDay!==part.moneyDay)return refuse('formulaUnavailable');
   // Parent caps, mapping-total rounding, session charges/counters and shared monetary
   // resources must run in one central money scope. Separate child evaluations cannot
   // establish that scope, even when each child is independently valid.
   if(pricedPartCount>1&&(formula.definition.paymentCap!==null||formula.definition.moneyRounding.stage==='dayMapping'
    ||formula.definition.deductions.some(r=>r.unit==='money')
    ||formula.definition.rates.some(r=>r.accumulation==='session'||r.tiers.some(t=>t.payment.method!=='hourly'&&t.payment.basis==='session'))))return refuse('pricingScopeUnavailable');
   const fact=<T>(value:T):OvertimeFact<T>=>({state:'known',value,provenance:{owner:'attendance',reference:snapshot.input.source.attendanceId+':policy:'+part.date,asOf:snapshot.input.source.date,basis:'recorded'}});
   const segments:Extract<OvertimeInput<OvertimePolicyBinding>,{layer:'raw'}>['segments']=[];
   for(const allocation of part.allocations){
    let covered=0;
    for(const original of snapshot.input.segments){
     if(original.clock.state!=='known')return refuse('sourcePlacementUnavailable');
     const clock=original.clock.value,start=(Number(clock.startEpochSeconds)-base)/60,end=start+clock.elapsedSeconds/60;
     if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end))return refuse('sourcePlacementUnavailable');
     const from=Math.max(start,allocation.from),to=Math.min(end,allocation.to);if(to<=from)continue;
     const count=to-from;covered+=count;
     const localDate=new Date(Date.parse(snapshot.input.source.date+'T00:00:00Z')+Math.floor(from/1440)*86400000).toISOString().slice(0,10);
     segments.push({id:original.id+':policy:'+sequence+':'+from+':'+to,sessionId:original.sessionId,dayType:fact(part.moneyDay),
      clock:fact({startEpochSeconds:String(base+from*60),localDate,localStartSecond:from%1440*60,elapsedSeconds:count*60}),
      rawMinutes:fact(String(count)),approvedMinutes:fact(String(count))});
    }
    if(covered!==allocation.to-allocation.from)return refuse('sourcePlacementUnavailable');
   }
   if(segments.reduce((sum,s)=>sum+(s.rawMinutes.state==='known'?Number(s.rawMinutes.value):0),0)!==part.allocatedPayableMinutes)return refuse('sourcePlacementUnavailable');
   const sessions=new Set(segments.map(s=>s.sessionId)),salary=snapshot.policyPricingFacts?.[part.date];
   if(!salary||!Object.hasOwn(salary,'basicSalary')||!Object.hasOwn(salary,'calculationBase'))return refuse('datedFactsUnavailable');
   const input:OvertimeInput<OvertimePolicyBinding>={...snapshot.input,mode:'actual',layer:'raw',sessionGranularity:'recorded',patternVersionId:formula.versionId,assignmentId:null,
    policyBinding:{kind:'attendanceGroupPolicy',revisionId:proposal.policyRevisionId,dayClass:part.dayClass,calendarDate:part.date,
     dayOffset:(Date.parse(part.date+'T00:00:00Z')-Date.parse(snapshot.input.source.date+'T00:00:00Z'))/86400000 as 0|1|2},
    facts:{...snapshot.input.facts,...salary,dayType:fact(part.moneyDay)},segments,
    resources:snapshot.input.resources.filter(r=>r.basis==='day'||sessions.has(r.sessionId!)),
    approval:{status:'notRequired',minutes:fact(String(part.allocatedPayableMinutes)),provenance:{owner:'attendance',reference:proposal.policyRevisionId,asOf:snapshot.input.source.date,basis:'recorded'}}};
   const pricing=evaluateOvertimePolicyAllocatedPrice(formula.definition,input);
   if(pricing.state!=='proposed')return refuse('partPricingUnavailable');
   total+=BigInt(pricing.amountMinorUnits);parts.push({sequence,date:part.date,definitionDigest:formula.definitionDigest,pricing});
  }
  return {state:'proposed',authority:'policyPricingProposalOnly',durationDigest:replay.digest,currency:{...snapshot.input.currency},amountMinorUnits:String(total),parts};
 }catch{return refuse('sourcePlacementUnavailable');}
}
