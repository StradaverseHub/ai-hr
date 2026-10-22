/** Canonical source-to-central-price composition only; not financial approval or settlement. */
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyDurationReplay} from './policy-duration-replay';
import {evaluateOvertimePolicyAllocatedPrice,evaluateOvertimePolicyAllocatedParentPrice,type OvertimePolicyAllocatedPrice} from '../../lib/overtime-pattern-evaluate';
import type {OvertimeInput,OvertimeFact,OvertimePattern} from '../../lib/overtime-pattern-model';
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
  const dated:{sequence:number;date:string;definitionDigest:string;pattern:OvertimePattern;input:OvertimeInput<OvertimePolicyBinding>}[]=[];
  let total=BigInt('0');
  for(const [sequence,part]of proposal.duration.parts.entries()){
   if(part.allocatedPayableMinutes===0)continue;
   const refs=formulas.references.filter(row=>row.date===part.date),formula=refs[0];
   if(refs.length!==1||formula.state!=='known'||formula.dayClass!==part.dayClass||formula.moneyDay!==part.moneyDay)return refuse('formulaUnavailable');
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
   dated.push({sequence,date:part.date,definitionDigest:formula.definitionDigest,pattern:formula.definition,input});
  }
  if(dated.length===1){
   const row=dated[0],pricing=evaluateOvertimePolicyAllocatedPrice(row.pattern,row.input);
   if(pricing.state!=='proposed')return refuse('partPricingUnavailable');
   total=BigInt(pricing.amountMinorUnits);parts.push({sequence:row.sequence,date:row.date,definitionDigest:row.definitionDigest,pricing});
  }else if(dated.length>1){
   // Every dated allocation is independently checked. The SAME central money engine owns
   // parent counters, charges, resource consumption, cap and rounding once, with rate facts
   // scoped to each actual dated segment. Distinct formula scopes remain explicit refusal.
   const first=dated[0],count=dated.reduce((n,row)=>n+(row.input.approval.minutes.state==='known'?Number(row.input.approval.minutes.value):0),0);
   if(dated.some(row=>row.definitionDigest!==first.definitionDigest))return refuse('pricingScopeUnavailable');
   const parent:OvertimeInput<OvertimePolicyBinding>={...first.input,facts:snapshot.input.facts,
    segments:dated.flatMap(row=>row.input.layer==='raw'?row.input.segments:[]),resources:snapshot.input.resources,
    approval:{...first.input.approval,minutes:{state:'known',value:String(count),provenance:{owner:'attendance',reference:proposal.policyRevisionId,asOf:snapshot.input.source.date,basis:'recorded'}}}};
   const priced=evaluateOvertimePolicyAllocatedParentPrice(parent,dated.map(row=>({pattern:row.pattern,input:row.input})));
   if(priced.state!=='proposed')return refuse('pricingScopeUnavailable');
   total=BigInt(priced.amountMinorUnits);
   for(const [index,row]of dated.entries())parts.push({sequence:row.sequence,date:row.date,definitionDigest:row.definitionDigest,pricing:priced.parts[index]});
  }
  return {state:'proposed',authority:'policyPricingProposalOnly',durationDigest:replay.digest,currency:{...snapshot.input.currency},amountMinorUnits:String(total),parts};
 }catch{return refuse('sourcePlacementUnavailable');}
}
