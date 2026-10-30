/** Source-owned answer rendering, not a model-prose adjudicator. Raw answers stay audit-only.
 * Sealed executed lookups nominate reads; current canonical tool/RLS/field policy owns every card.
 * Cache lifetime is this one actor's actual read transaction only. No provider, effect or ambient query.
 */
import type {SessionContext,Tx} from '../db/client';
import {canClarifyAssistantQuestion} from './assistant-clarification';
import {withAssistantRead,type AssistantReadSession} from './assistant-read-session';
import {openAssistantAnswerDisclosure,type AssistantDisclosureBinding} from '../lib/ai/assistant-disclosure';
import {loadCanonicalToolJob,loadGovernedSpecialistToolJob,type CanonicalModuleJobView} from './workspace-module-jobs';
import {isGroundedToolName,GROUNDED_TOOL_MODULES} from '../lib/ai/grounded-tool-presentation';
import {assistantAnswerExplanationAvailability,type AssistantAnswerExplanation} from '../lib/ai/assistant-answer-explanations';
import {adjudicateAssistantAnswerPlan,type AssistantAnswerPlan,type AssistantAnswerRead} from '../lib/ai/assistant-answer-plan';
import {isAgentModuleCode,type AgentModuleCode} from '../lib/ai/module-agents';
import {assistantReadableModules} from './assistant-readable-modules';
export type AssistantConversationSegment=Readonly<{kind:'fact';view:CanonicalModuleJobView;card:number;fact:number}>|Readonly<{kind:'explanation';view:CanonicalModuleJobView;explanation:AssistantAnswerExplanation}>;
export type AssistantConversationView=Readonly<{plan:AssistantAnswerPlan;clarificationAllowed?:false;segments?:readonly AssistantConversationSegment[];facts:readonly Readonly<{view:CanonicalModuleJobView;card:number;fact:number}>[]}>;
export type GroundedWorkspaceAnswer=Readonly<{mode:'grounded'|'generic'|'unavailable';views:readonly CanonicalModuleJobView[];fallbackModules:readonly AgentModuleCode[];partial:boolean;tools:readonly string[];conversation?:AssistantConversationView|null}>;
export function workspaceGroundedAnswers(ctx:SessionContext,session:AssistantReadSession,tx?:Tx){
 let remaining=32;const cache=new Map<string,Promise<CanonicalModuleJobView>>();
 // A sealed proposal is re-adjudicated against the caller's CURRENT module read set on every replay.
 const caller=(plan:AssistantAnswerPlan,question:string)=>({question,...(plan.mode==='propose'?{readableModules:assistantReadableModules(ctx)}:{})});
 return async(binding:AssistantDisclosureBinding,receipt:unknown):Promise<GroundedWorkspaceAnswer>=>{
  const empty=(mode:'generic'|'unavailable'):GroundedWorkspaceAnswer=>Object.freeze({mode,views:Object.freeze([]),fallbackModules:Object.freeze([]),partial:false,tools:Object.freeze([])});
  try{await withAssistantRead(ctx,null,async()=>undefined,session);}catch{return empty('unavailable');}
  if(binding.tenantId!==ctx.tenantId||binding.userId!==ctx.userId)return empty('unavailable');
  const disclosure=openAssistantAnswerDisclosure(binding,receipt);if(disclosure===null)return empty('unavailable');
  const {reads,plan}=disclosure;
  if(reads.length===0){if(plan)try{return Object.freeze({...empty('generic'),conversation:Object.freeze({plan:adjudicateAssistantAnswerPlan(plan,[],caller(plan,binding.question)),...(plan.mode==='clarify'&&!canClarifyAssistantQuestion(binding.question)?{clarificationAllowed:false as const}:{}),facts:Object.freeze([])})});}catch{return empty('unavailable');}return empty('generic');}
  const answerReads:AssistantAnswerRead[]=[],indexedViews=new Map<number,CanonicalModuleJobView>();
  const views:CanonicalModuleJobView[]=[],fallback=new Set<AgentModuleCode>(),tools:string[]=[],seen=new Set<string>();let partial=reads.length>8;
  for(const [read,source] of reads.slice(0,8).entries()){
   if(!isGroundedToolName(source.name)){partial=true;continue;}
   const input=source.input&&typeof source.input==='object'&&!Array.isArray(source.input)?source.input as Record<string,unknown>:null;
   const fallbackModule=source.name==='my_module_work'&&isAgentModuleCode(input?.module)?input.module:GROUNDED_TOOL_MODULES[source.name];
   const key=JSON.stringify([source.name,source.input,source.digest,source.moduleJobId??null]);if(seen.has(key)&&!plan)continue;seen.add(key);
   let pending=cache.get(key);if(!pending){if(remaining--<=0){partial=true;fallback.add(fallbackModule);continue;}
    pending=source.moduleJobId&&tx&&source.name==='my_module_work'?loadGovernedSpecialistToolJob(ctx,tx,source.input,source.moduleJobId,source.digest):loadCanonicalToolJob(ctx,source.name,source.input,source.digest,session);cache.set(key,pending);}
   const view=await pending;
   if(view.state==='ready'){views.push(view);tools.push(source.name);indexedViews.set(read,view);answerReads.push(Object.freeze({read,presentation:view.presentation,explanations:assistantAnswerExplanationAvailability(view.answerExplanations??[])}));}else{partial=true;fallback.add(fallbackModule);}
  }
  let conversation:AssistantConversationView|null=null;
  if(plan)try{const checked=adjudicateAssistantAnswerPlan(plan,answerReads,caller(plan,binding.question));
   const segments:AssistantConversationSegment[]=checked.mode==='answer'?checked.blocks.map((block):AssistantConversationSegment=>{
    const view=indexedViews.get(block.read);if(!view||view.state!=='ready')throw Error();
    if(block.kind==='fact')return Object.freeze({kind:'fact',view,card:block.card,fact:block.fact});
    const explanation=view.answerExplanations?.find(row=>row.card===block.card&&row.code===block.code);if(!explanation)throw Error();
    return Object.freeze({kind:'explanation',view,explanation});
   }):[];
   const facts=segments.flatMap(segment=>segment.kind==='fact'?[Object.freeze({view:segment.view,card:segment.card,fact:segment.fact})]:[]);
   conversation=Object.freeze({plan:checked,...(checked.mode==='clarify'&&!canClarifyAssistantQuestion(binding.question)?{clarificationAllowed:false as const}:{}),
    ...(segments.some(segment=>segment.kind==='explanation')?{segments:Object.freeze(segments)}:{}),facts:Object.freeze(facts)});
  }catch{return empty('unavailable');}
  return Object.freeze({conversation,mode:views.length?'grounded':'unavailable',views:Object.freeze(views),fallbackModules:Object.freeze([...fallback]),partial,tools:Object.freeze(tools)});
 };
}
