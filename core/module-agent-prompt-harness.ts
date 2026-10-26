/** Actual gateway execution of immutable independent synthetic expectations.
 * Never called during source preparation. Only synthetic requests leave this evaluator.
 * Model responses are adjudicated as typed proposals; no self-rating or generated HR fact is accepted.
 */
import { generateDraft } from '../lib/ai';
import type { ResolvedAiConfig } from '../lib/ai/types';
import { adjudicatePromptReadPlan,capturePromptPlanCandidate,promptCandidateSystem,PROMPT_HOLDOUTS,
 PROMPT_SUITE_DIGEST,PROMPT_INPUT_DIGEST } from '../lib/ai/module-agent-prompt-candidate';
import { routingDigest } from '../lib/ai/module-agent-routing';
export type PromptHoldoutReport=Readonly<{version:1;coverage:'model-to-typed-read-plan-only';suiteDigest:string;inputDigest:string;
 attemptedRequests:number;completedRequests:number;completedCases:number;state:'complete'|'incomplete';securityFailures:number|null;qualityFailures:number|null;
 elapsedMs:number;retainedPasses:number;cases:readonly {id:string;state:'passed'|'failed'|'unavailable';outputDigest?:string;securityFailure?:boolean;retained?:boolean}[]}>;
export async function executePromptHoldout(configuration:unknown,cfg:ResolvedAiConfig,authenticatedPrior?:PromptHoldoutReport):Promise<PromptHoldoutReport>{
 const candidate=capturePromptPlanCandidate(configuration),system=promptCandidateSystem(candidate),started=Date.now();
 let attemptedRequests=0,completedRequests=0,securityFailures=0,qualityFailures=0,incomplete=false,retainedPasses=0;
 const cases:{id:string;state:'passed'|'failed'|'unavailable';outputDigest?:string;securityFailure?:boolean;retained?:boolean}[]=[];
 for(const fixture of PROMPT_HOLDOUTS){
  const retained=authenticatedPrior?.suiteDigest===PROMPT_SUITE_DIGEST&&authenticatedPrior.inputDigest===PROMPT_INPUT_DIGEST?
   authenticatedPrior.cases.find(row=>row.id===fixture.id&&row.state==='passed'&&typeof row.outputDigest==='string'&&/^[a-f0-9]{64}$/.test(row.outputDigest)):undefined;
  if(retained){retainedPasses++;cases.push({id:fixture.id,state:'passed',outputDigest:retained.outputDigest,retained:true});continue;}
  attemptedRequests++;
  let text:string;
  try{text=await generateDraft(cfg,Object.freeze({system,prompt:fixture.question,maxTokens:384,timeoutMs:15000}));}
  catch{incomplete=true;cases.push({id:fixture.id,state:'unavailable'});break;}
  completedRequests++;
  let passed=false,securityFailure=false;
  try{const plan=adjudicatePromptReadPlan(text);
   passed=plan.decision===fixture.decision&&[...plan.modules].sort().join(',')===[...fixture.modules].sort().join(',');
   if(!passed&&fixture.security){securityFailures++;securityFailure=true;}
  }catch{/* Adjudication refused malformed output; it still fails this quality case. */}
  if(!passed)qualityFailures++;
  cases.push({id:fixture.id,state:passed?'passed':'failed',outputDigest:routingDigest(text),securityFailure});
 }
 return Object.freeze({version:1,coverage:'model-to-typed-read-plan-only',suiteDigest:PROMPT_SUITE_DIGEST,inputDigest:PROMPT_INPUT_DIGEST,
  attemptedRequests,completedRequests,completedCases:completedRequests+retainedPasses,state:incomplete?'incomplete':'complete',securityFailures:incomplete?null:securityFailures,
  qualityFailures:incomplete?null:qualityFailures,elapsedMs:Math.max(0,Date.now()-started),retainedPasses,cases:Object.freeze(cases.map(row=>Object.freeze(row)))});
}
