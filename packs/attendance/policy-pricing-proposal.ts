/** Canonical source-to-central-price composition only; not financial approval or settlement. */
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyDurationReplay} from './policy-duration-replay';
import {attendancePolicyCountAttribution} from './policy-count-attribution';
import {evaluateOvertimePolicyAllocatedPrice,evaluateOvertimePolicyAllocatedParentPrice,type OvertimePolicyAllocatedPrice,type OvertimePolicyRoundedCount} from '../../lib/overtime-pattern-evaluate';
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
  if(snapshot.policyMoneyScope!==undefined&&!['identicalDefinitions','datedRateExpressions'].includes(snapshot.policyMoneyScope))return refuse('pricingScopeUnavailable');
  const counts=attendancePolicyCountAttribution(proposal.duration);if(counts.state!=='known')return refuse('sourcePlacementUnavailable');
  if(snapshot.input.layer!=='raw'||snapshot.input.sessionGranularity!=='recorded')return refuse('sourcePlacementUnavailable');
  const base=Date.parse(snapshot.input.source.date+'T00:00:00+08:00')/1000,parts:Extract<PolicyPricingProposal,{state:'proposed'}>['parts']=[];
  const dated:{sequence:number;date:string;definitionDigest:string;pattern:OvertimePattern;input:OvertimeInput<OvertimePolicyBinding>;roundedCounts:OvertimePolicyRoundedCount[]}[]=[];
  let total=BigInt('0');
  for(const [sequence,part]of proposal.duration.parts.entries()){
   const countPart=counts.parts[sequence];
   if(!countPart||countPart.calendarDate!==part.date||countPart.physicalMinutes!==part.allocatedPayableMinutes)return refuse('sourcePlacementUnavailable');
   if(countPart.minutes===0)continue;
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
    approval:{status:'notRequired',minutes:fact(String(countPart.minutes)),provenance:{owner:'attendance',reference:proposal.policyRevisionId,asOf:snapshot.input.source.date,basis:'recorded'}}};
   const roundedCounts:OvertimePolicyRoundedCount[]=[];
   for(const attribution of countPart.roundingCountAttributions){
    const candidates=segments.filter(segment=>{
     if(segment.clock.state!=='known')return false;
     const start=(Number(segment.clock.value.startEpochSeconds)-base)/60,end=start+segment.clock.value.elapsedSeconds/60;
     return start>=attribution.anchor.from&&end<=attribution.anchor.to;
    });
    if(attribution.direction==='latest')candidates.reverse();
    const anchor=candidates[0];if(!anchor||anchor.clock.state!=='known')return refuse('sourcePlacementUnavailable');
    roundedCounts.push({segmentId:anchor.id,minutes:attribution.minutes,allocationPolicy:attribution.direction,
     source:{...input.source},policyBinding:{...input.policyBinding},anchor:{...anchor.clock.value}});
   }
   dated.push({sequence,date:part.date,definitionDigest:formula.definitionDigest,pattern:formula.definition,input,roundedCounts});
  }
  // An explicit multi-version scope cannot be attached to a single dated/version owner.
  if(snapshot.policyMoneyScope!==undefined&&(dated.length<2||new Set(dated.map(row=>row.input.patternVersionId)).size<2))return refuse('pricingScopeUnavailable');
  if(dated.length===1){
   const row=dated[0],pricing=evaluateOvertimePolicyAllocatedPrice(row.pattern,row.input,row.roundedCounts);
   if(pricing.state!=='proposed')return refuse('partPricingUnavailable');
   total=BigInt(pricing.amountMinorUnits);parts.push({sequence:row.sequence,date:row.date,definitionDigest:row.definitionDigest,pricing});
  }else if(dated.length>1){
   // Every dated allocation is independently checked. The SAME central money engine owns
   // parent counters, charges, resource consumption, cap and rounding once, with rate facts
   // scoped to each actual dated segment. Distinct formulas require an explicit central comparison of shared money rules.
   const first=dated[0],count=dated.reduce((n,row)=>n+(row.input.approval.minutes.state==='known'?Number(row.input.approval.minutes.value):0),0);
   // Version digests also bind immutable names/company metadata. A new explicit scope may
   // retain distinct version digests only when the SAME central owner proves byte-identical
   // validated computational definitions, or separately bind dated hourly expressions under identical shared money rules; every dated version/digest remains in the proof.
   const multipleVersions=new Set(dated.map(row=>row.input.patternVersionId)).size>1;
   if(snapshot.policyMoneyScope==='datedRateExpressions'&&new Set(dated.map(row=>JSON.stringify(row.pattern))).size<2)return refuse('pricingScopeUnavailable');
   if(dated.some(row=>row.definitionDigest!==first.definitionDigest)
    &&!((snapshot.policyMoneyScope==='identicalDefinitions'||snapshot.policyMoneyScope==='datedRateExpressions')&&multipleVersions))return refuse('pricingScopeUnavailable');
   const parent:OvertimeInput<OvertimePolicyBinding>={...first.input,layer:'raw',sessionGranularity:'recorded',facts:snapshot.input.facts,
    segments:dated.flatMap(row=>row.input.layer==='raw'?row.input.segments:[]),resources:snapshot.input.resources,
    approval:{...first.input.approval,minutes:{state:'known',value:String(count),provenance:{owner:'attendance',reference:proposal.policyRevisionId,asOf:snapshot.input.source.date,basis:'recorded'}}}};
   const priced=evaluateOvertimePolicyAllocatedParentPrice(parent,dated.map(row=>({pattern:row.pattern,input:row.input,roundedCounts:row.roundedCounts})),snapshot.policyMoneyScope??'sameVersion');
   if(priced.state!=='proposed')return refuse('pricingScopeUnavailable');
   total=BigInt(priced.amountMinorUnits);
   for(const [index,row]of dated.entries())parts.push({sequence:row.sequence,date:row.date,definitionDigest:row.definitionDigest,pricing:priced.parts[index]});
  }
  return {state:'proposed',authority:'policyPricingProposalOnly',durationDigest:replay.digest,currency:{...snapshot.input.currency},amountMinorUnits:String(total),parts};
 }catch{return refuse('sourcePlacementUnavailable');}
}
