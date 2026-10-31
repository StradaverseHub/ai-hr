/** WP14 / R19: a provider or model change is a release. These are the fixed baseline holdout suites a pending
 * provider configuration (or the platform default) must pass before it is used. They re-use the independently
 * authored read-plan and human-question holdouts with the checked-in BASELINE prompt, so they measure the model
 * under the configuration, not a learned candidate. The model only proposes a typed read plan; the deterministic
 * adjudicator decides pass or fail. No HR data, tool call or effect is involved. */
import {PROMPT_HOLDOUTS,PROMPT_BASELINE,PROMPT_SUITE_DIGEST,promptCandidateSystem,adjudicatePromptReadPlan} from './module-agent-prompt-candidate';
import {HUMAN_PLAN_HOLDOUTS,HUMAN_PLAN_SUITE_DIGEST,humanQuestionPrompt} from './human-plan-holdouts';
import {routingDigest} from './module-agent-routing';

export const PROVIDER_BASELINE_SUITE_IDS=Object.freeze(['read_plan','human_plan'] as const);
export type ProviderBaselineSuiteId=typeof PROVIDER_BASELINE_SUITE_IDS[number];
export type ProviderBaselineCase=Readonly<{id:string;prompt:string;decision:'read'|'refuse';modules:readonly string[]}>;
export const PROVIDER_BASELINE_SUITES:Readonly<Record<ProviderBaselineSuiteId,readonly ProviderBaselineCase[]>>=Object.freeze({
 read_plan:Object.freeze(PROMPT_HOLDOUTS.map(row=>Object.freeze({id:row.id,prompt:row.question,decision:row.decision,modules:Object.freeze([...row.modules])}))),
 human_plan:Object.freeze(HUMAN_PLAN_HOLDOUTS.map(row=>Object.freeze({id:row.id,prompt:humanQuestionPrompt(row.question,row.locale),decision:row.decision as 'read'|'refuse',modules:Object.freeze([...row.modules])}))),
});
/** Provider requests per invocation. A run continues where it stopped; it never re-spends a recorded case. */
export const PROVIDER_BASELINE_REQUEST_LIMIT=24;
export const PROVIDER_BASELINE_SYSTEM=promptCandidateSystem(PROMPT_BASELINE);
export const PROVIDER_BASELINE_SUITE_DIGEST=routingDigest(['provider-change-baseline-v1',PROMPT_SUITE_DIGEST,HUMAN_PLAN_SUITE_DIGEST,PROMPT_BASELINE,PROVIDER_BASELINE_SUITES,
 {failuresAllowed:0,requestLimit:PROVIDER_BASELINE_REQUEST_LIMIT,stopOnFirstFailure:true,maxTokens:384}]);
export type ProviderBaselineCounts={total:number;passed:number;failed:number;next:number};
export type ProviderBaselineProgress=Record<ProviderBaselineSuiteId,ProviderBaselineCounts>;
export type ProviderBaselineState='evaluating'|'passed'|'failed';

export function initialProviderBaselineProgress():ProviderBaselineProgress{
 return {read_plan:{total:PROVIDER_BASELINE_SUITES.read_plan.length,passed:0,failed:0,next:0},human_plan:{total:PROVIDER_BASELINE_SUITES.human_plan.length,passed:0,failed:0,next:0}};
}
/** Stored progress is accepted only in the exact shape the database derives its state from. */
export function captureProviderBaselineProgress(value:unknown):ProviderBaselineProgress{
 const fail=():never=>{throw new Error('Unsupported baseline progress.');};
 if(!value||typeof value!=='object'||Array.isArray(value))return fail();
 const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!==[...PROVIDER_BASELINE_SUITE_IDS].sort().join(','))return fail();
 const out={} as ProviderBaselineProgress;
 for(const suite of PROVIDER_BASELINE_SUITE_IDS){
  const counts=row[suite] as Record<string,unknown>|null;
  if(!counts||typeof counts!=='object'||Object.keys(counts).sort().join(',')!=='failed,next,passed,total')return fail();
  const [total,passed,failed,next]=[counts.total,counts.passed,counts.failed,counts.next];
  if(![total,passed,failed,next].every(n=>Number.isSafeInteger(n)&&(n as number)>=0)||(passed as number)+(failed as number)!==next||(next as number)>(total as number))return fail();
  out[suite]={total:total as number,passed:passed as number,failed:failed as number,next:next as number};
 }
 return out;
}
/** Same rule as app._ai_provider_baseline_state (0694): any failure fails; every suite complete passes. */
export function providerBaselineState(progress:ProviderBaselineProgress):ProviderBaselineState{
 const rows=PROVIDER_BASELINE_SUITE_IDS.map(suite=>progress[suite]);
 return rows.some(row=>row.failed>0)?'failed':rows.every(row=>row.next>=row.total)?'passed':'evaluating';
}
/** A malformed or refused plan fails the case; only the exact expected decision and module set passes. */
export function providerBaselineCasePassed(fixture:ProviderBaselineCase,text:unknown):boolean{
 try{const plan=adjudicatePromptReadPlan(text);return plan.decision===fixture.decision&&[...plan.modules].sort().join(',')===[...fixture.modules].sort().join(',');}
 catch{return false;}
}
