/** Paired actual gateway execution of fixed independent synthetic expectations. Both arms share
 * the exact issued provider, source, suite and authorization; no model self-rating or HR data. */
import {generateDraft} from '../lib/ai';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {withAiAdmissionLifecycle,preparePrivateAiTask,type AiAdmissionLifecycle} from './ai-governance';
import type {GenerateArgs} from '../lib/ai/types';
import {adjudicatePromptReadPlan,capturePromptPlanCandidate,promptCandidateSystem,PROMPT_HOLDOUTS,PROMPT_BASELINE,
 PROMPT_SUITE_DIGEST,PROMPT_INPUT_DIGEST,PROMPT_HOLDOUT_REQUEST_LIMIT} from '../lib/ai/module-agent-prompt-candidate';
import {routingDigest} from '../lib/ai/module-agent-routing';
import {compareMeasuredQuality,type MeasuredEvaluationCase} from '../lib/ai/paired-evaluation';
export type PromptArm='baseline'|'candidate';
export type PromptCase=Readonly<{id:string;arm:PromptArm;state:'passed'|'failed'|'unavailable';outputDigest?:string;securityFailure?:boolean;retained?:boolean;measurement?:MeasuredEvaluationCase}>;
export type PromptHoldoutReport=Readonly<{version:2;coverage:'model-to-typed-read-plan-only';suiteDigest:string;inputDigest:string;baselineDigest:string;candidateConfigurationDigest:string;
 attemptedRequests:number;completedRequests:number;completedCases:number;state:'complete'|'incomplete';securityFailures:number|null;qualityFailures:number|null;
 elapsedMs:number;retainedPasses:number;retainedFailures:number;unavailableAttempts:number;cases:readonly PromptCase[];comparison:ReturnType<typeof compareMeasuredQuality>}>;
const key=(id:string,arm:PromptArm)=>arm+':'+id;
export function promptMeasuredComparison(cases:readonly PromptCase[]){return compareMeasuredQuality(cases.filter(row=>row.arm==='baseline'&&row.measurement).map(row=>row.measurement!),cases.filter(row=>row.arm==='candidate'&&row.measurement).map(row=>row.measurement!),PROMPT_HOLDOUTS.length);}
export async function executePromptHoldout(configuration:unknown,cfg:ResolvedAiConfig,authenticatedPrior?:PromptHoldoutReport):Promise<PromptHoldoutReport>{
 const candidate=capturePromptPlanCandidate(configuration),candidateConfigurationDigest=routingDigest(candidate),baselineDigest=routingDigest(PROMPT_BASELINE),started=performance.now();
 let attemptedRequests=0,completedRequests=0,unavailableAttempts=0;const outcomes=new Map<string,PromptCase>();
 if(authenticatedPrior?.version===2&&authenticatedPrior.suiteDigest===PROMPT_SUITE_DIGEST&&authenticatedPrior.inputDigest===PROMPT_INPUT_DIGEST&&authenticatedPrior.baselineDigest===baselineDigest&&authenticatedPrior.candidateConfigurationDigest===candidateConfigurationDigest){
  for(const fixture of PROMPT_HOLDOUTS)for(const arm of ['baseline','candidate'] as const){const previous=authenticatedPrior.cases.find(row=>row.id===fixture.id&&row.arm===arm);
   if(previous&&(previous.state==='passed'||previous.state==='failed')&&previous.measurement&&typeof previous.outputDigest==='string'&&/^[a-f0-9]{64}$/.test(previous.outputDigest))outcomes.set(key(fixture.id,arm),Object.freeze({...previous,retained:true}));}
 }
 const arms=PROMPT_HOLDOUTS.flatMap((fixture,index)=>(index%2?['candidate','baseline'] as const:['baseline','candidate'] as const).map(arm=>({fixture,arm})));
 // One shared budget across both arms; no silent doubling. Passing exact arms remain immutable.
 const queue=[...arms.filter(row=>!outcomes.has(key(row.fixture.id,row.arm))),...arms.filter(row=>outcomes.get(key(row.fixture.id,row.arm))?.state==='failed')];
 for(const {fixture,arm} of queue){
  if(attemptedRequests>=PROMPT_HOLDOUT_REQUEST_LIMIT)break;attemptedRequests++;
  const observation:{settled?:Parameters<NonNullable<AiAdmissionLifecycle['settled']>>[1]}={};let text:string;const callStarted=performance.now();
  try{
   // This wrapper accepts only the real server-issued capability and composes all existing checks.
   // Neither a copied raw config nor a posted observation can acquire admission authority.
   const observed=withAiAdmissionLifecycle(cfg,'module_agent_evaluation',{async settled(_tx,event){observation.settled=event;}});
   const task=await preparePrivateAiTask(observed,'synthetic_read_plan_v1',async()=>({candidate:arm==='baseline'?PROMPT_BASELINE:candidate,fixtureId:fixture.id}));
   try{if(task.operation!=='draft')throw Error('Synthetic evaluation operation unavailable.');text=await generateDraft(task.configuration,task.args as GenerateArgs);}finally{task.dispose();}
  }catch{unavailableAttempts++;if(!outcomes.has(key(fixture.id,arm)))outcomes.set(key(fixture.id,arm),{id:fixture.id,arm,state:'unavailable'});break;}
  completedRequests++;let passed=false,securityFailure=false;
  try{const plan=adjudicatePromptReadPlan(text);passed=plan.decision===fixture.decision&&[...plan.modules].sort().join(',')===[...fixture.modules].sort().join(',');if(!passed&&fixture.security)securityFailure=true;}catch{/* Malformed output is refused by the adjudicator and fails quality. */}
  const settled=observation.settled,tokens=settled?.succeeded===true?settled.actualTokens:null,costCredits=settled?.succeeded===true&&settled.accounting.providerObservationStatus==='reported'?settled.accounting.openrouterAccountCostCredits:null;
  const measurement:MeasuredEvaluationCase=Object.freeze({id:fixture.id,passed,securityFailure,elapsedMs:Math.max(0,performance.now()-callStarted),readCount:0,tokens:tokens??null,costCredits:costCredits??null});
  outcomes.set(key(fixture.id,arm),{id:fixture.id,arm,state:passed?'passed':'failed',outputDigest:routingDigest(text),securityFailure,measurement});
 }
 const cases=arms.flatMap(({fixture,arm})=>{const outcome=outcomes.get(key(fixture.id,arm));return outcome?[outcome]:[];}),comparison=promptMeasuredComparison(cases);
 const completedCases=PROMPT_HOLDOUTS.filter(fixture=>['baseline','candidate'].every(arm=>{const state=outcomes.get(key(fixture.id,arm as PromptArm))?.state;return state==='passed'||state==='failed';})).length;
 const incomplete=unavailableAttempts>0||completedCases!==PROMPT_HOLDOUTS.length;
 const candidateCases=cases.filter(row=>row.arm==='candidate');
 return Object.freeze({version:2,coverage:'model-to-typed-read-plan-only',suiteDigest:PROMPT_SUITE_DIGEST,inputDigest:PROMPT_INPUT_DIGEST,baselineDigest,candidateConfigurationDigest,
  attemptedRequests,completedRequests,completedCases,state:incomplete?'incomplete':'complete',securityFailures:incomplete?null:candidateCases.filter(row=>row.state==='failed'&&row.securityFailure===true).length,
  qualityFailures:incomplete?null:candidateCases.filter(row=>row.state==='failed').length,elapsedMs:Math.max(0,performance.now()-started),retainedPasses:cases.filter(row=>row.retained&&row.state==='passed').length,
  retainedFailures:cases.filter(row=>row.retained&&row.state==='failed').length,unavailableAttempts,cases:Object.freeze(cases.map(row=>Object.freeze(row))),comparison});
}
