/** Actual gateway execution of immutable independent synthetic expectations.
 * Never called during source preparation. Only synthetic requests leave this evaluator.
 * Model responses are adjudicated as typed proposals; no self-rating or generated HR fact is accepted.
 */
import { generateDraft } from '../lib/ai';
import type { ResolvedAiConfig } from '../lib/ai/types';
import { adjudicatePromptReadPlan,capturePromptPlanCandidate,promptCandidateSystem,PROMPT_HOLDOUTS,
 PROMPT_SUITE_DIGEST,PROMPT_INPUT_DIGEST,PROMPT_HOLDOUT_REQUEST_LIMIT } from '../lib/ai/module-agent-prompt-candidate';
import { routingDigest } from '../lib/ai/module-agent-routing';
export type PromptHoldoutReport=Readonly<{version:1;coverage:'model-to-typed-read-plan-only';suiteDigest:string;inputDigest:string;
 attemptedRequests:number;completedRequests:number;completedCases:number;state:'complete'|'incomplete';securityFailures:number|null;qualityFailures:number|null;
 elapsedMs:number;retainedPasses:number;retainedFailures:number;unavailableAttempts:number;cases:readonly {id:string;state:'passed'|'failed'|'unavailable';outputDigest?:string;securityFailure?:boolean;retained?:boolean}[]}>;
export async function executePromptHoldout(configuration:unknown,cfg:ResolvedAiConfig,authenticatedPrior?:PromptHoldoutReport):Promise<PromptHoldoutReport>{
 const candidate=capturePromptPlanCandidate(configuration),system=promptCandidateSystem(candidate),started=Date.now();
 let attemptedRequests=0,completedRequests=0,unavailableAttempts=0;
 type Case=PromptHoldoutReport['cases'][number];const outcomes=new Map<string,Case>();
 if(authenticatedPrior?.suiteDigest===PROMPT_SUITE_DIGEST&&authenticatedPrior.inputDigest===PROMPT_INPUT_DIGEST){
  for(const fixture of PROMPT_HOLDOUTS){
   const previous=authenticatedPrior.cases.find(row=>row.id===fixture.id);
   if(previous&&(previous.state==='passed'||previous.state==='failed')&&typeof previous.outputDigest==='string'&&/^[a-f0-9]{64}$/.test(previous.outputDigest))
    outcomes.set(fixture.id,Object.freeze({...previous,retained:true}));
  }
 }
 // Finish the genuinely unrun coverage before spending another explicit permit on known failures.
 // A retained failure remains a failure, never PASS; source/provider/suite ownership authenticates it.
 const queue=[...PROMPT_HOLDOUTS.filter(row=>!outcomes.has(row.id)),
  ...PROMPT_HOLDOUTS.filter(row=>outcomes.get(row.id)?.state==='failed')];
 for(const fixture of queue){
  if(attemptedRequests>=PROMPT_HOLDOUT_REQUEST_LIMIT)break;
  attemptedRequests++;
  let text:string;
  try{text=await generateDraft(cfg,Object.freeze({system,prompt:fixture.question,maxTokens:384,timeoutMs:15000}));}
  catch{
   unavailableAttempts++;
   // An unsuccessful retry cannot erase an authenticated prior failure or its output fingerprint.
   if(!outcomes.has(fixture.id))outcomes.set(fixture.id,{id:fixture.id,state:'unavailable'});
   break;
  }
  completedRequests++;
  let passed=false,securityFailure=false;
  try{const plan=adjudicatePromptReadPlan(text);
   passed=plan.decision===fixture.decision&&[...plan.modules].sort().join(',')===[...fixture.modules].sort().join(',');
   if(!passed&&fixture.security)securityFailure=true;
  }catch{/* Adjudication refused malformed output; it still fails this quality case. */}
  outcomes.set(fixture.id,{id:fixture.id,state:passed?'passed':'failed',outputDigest:routingDigest(text),securityFailure});
 }
 const cases=PROMPT_HOLDOUTS.flatMap(row=>{const outcome=outcomes.get(row.id);return outcome?[outcome]:[];});
 const completedCases=cases.filter(row=>row.state==='passed'||row.state==='failed').length;
 const incomplete=unavailableAttempts>0||completedCases!==PROMPT_HOLDOUTS.length;
 const retainedPasses=cases.filter(row=>row.retained===true&&row.state==='passed').length;
 const retainedFailures=cases.filter(row=>row.retained===true&&row.state==='failed').length;
 const securityFailures=cases.filter(row=>row.state==='failed'&&row.securityFailure===true).length;
 const qualityFailures=cases.filter(row=>row.state==='failed').length;
 return Object.freeze({version:1,coverage:'model-to-typed-read-plan-only',suiteDigest:PROMPT_SUITE_DIGEST,inputDigest:PROMPT_INPUT_DIGEST,
  attemptedRequests,completedRequests,completedCases,state:incomplete?'incomplete':'complete',securityFailures:incomplete?null:securityFailures,
  qualityFailures:incomplete?null:qualityFailures,elapsedMs:Math.max(0,Date.now()-started),retainedPasses,retainedFailures,unavailableAttempts,cases:Object.freeze(cases.map(row=>Object.freeze(row)))});
}
