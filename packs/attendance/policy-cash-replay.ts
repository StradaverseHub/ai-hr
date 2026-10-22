/** Exact cash-source replay through the shared duration and central price owners.
 * A known projection is not approval, a ready header, payment or settlement authority. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyDurationReplay} from './policy-duration-replay';
import {attendancePolicyPricingProposal} from './policy-pricing-proposal';

export type PolicyCashReplay=
 |{state:'unavailable';authority:'cashProposalReplayOnly';reason:'sourceUnavailable'|'durationUnavailable'|'pricingUnavailable'}
 |{state:'known';authority:'cashProposalReplayOnly';digest:string;minutes:number;amountMinorUnits:string;currency:{code:string;minorScale:number}};
/** Cash includes every dated salary, money mapping, formula definition and reference digest.
 * Equal totals do not excuse changed references. TOIL must use the separate salary-free owner. */
export function attendancePolicyCashReplay(snapshot:CanonicalOvertimeSnapshot):PolicyCashReplay{
 const refuse=(reason:Extract<PolicyCashReplay,{state:'unavailable'}>['reason']):PolicyCashReplay=>
  ({state:'unavailable',authority:'cashProposalReplayOnly',reason});
 try{
  if(!/^[0-9a-f]{64}$/.test(snapshot.referenceDigest)
   ||!/^[0-9a-f]{64}$/.test(snapshot.input.source.inputDigest)
   ||!/^[0-9a-f]{64}$/.test(snapshot.input.source.approvalDigest))return refuse('sourceUnavailable');
  const duration=attendancePolicyDurationReplay(snapshot);
  if(duration.state!=='known')return refuse('durationUnavailable');
  const pricing=attendancePolicyPricingProposal(snapshot);
  if(pricing.state!=='proposed'||pricing.durationDigest!==duration.digest
   ||pricing.parts.reduce((sum,part)=>sum+part.pricing.minutes,0)!==duration.minutes)return refuse('pricingUnavailable');
  const proof={version:1,input:{...snapshot.input,mode:'actual',patternVersionId:null,assignmentId:null},
   referenceDigest:snapshot.referenceDigest,formulas:snapshot.policyFormulaInput,datedFacts:snapshot.policyPricingFacts,duration,pricing};
  const encoded=JSON.stringify(proof,(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)
   ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)):value);
  return {state:'known',authority:'cashProposalReplayOnly',digest:createHash('sha256').update(encoded).digest('hex'),
   minutes:duration.minutes,amountMinorUnits:pricing.amountMinorUnits,currency:{...pricing.currency}};
 }catch{return refuse('sourceUnavailable');}
}
/** Caller supplies a fresh canonical read under its existing source/configuration locks.
 * Comparing a retained digest without that fresh read cannot establish current financial input. */
export function attendancePolicyCurrentCashMatches(snapshot:CanonicalOvertimeSnapshot,recorded:unknown):boolean{
 const current=attendancePolicyCashReplay(snapshot);
 return current.state==='known'&&isDeepStrictEqual(current,recorded);
}
