/** Source-owned answer rendering, not a model-prose adjudicator. Raw answers stay audit-only.
 * Sealed executed lookups nominate reads; current canonical tool/RLS/field policy owns every card.
 * Cache lifetime is this one actor's actual read transaction only. No provider, effect or ambient query.
 */
import type {SessionContext,Tx} from '../db/client';
import {withAssistantRead,type AssistantReadSession} from './assistant-read-session';
import {openAssistantAnswerDisclosure,type AssistantDisclosureBinding} from '../lib/ai/assistant-disclosure';
import {loadCanonicalToolJob,loadGovernedSpecialistToolJob,type CanonicalModuleJobView} from './workspace-module-jobs';
import {isGroundedToolName,GROUNDED_TOOL_MODULES} from '../lib/ai/grounded-tool-presentation';
import {adjudicateAssistantAnswerPlan,type AssistantAnswerPlan,type AssistantAnswerRead} from '../lib/ai/assistant-answer-plan';
import {isAgentModuleCode,type AgentModuleCode} from '../lib/ai/module-agents';
export type AssistantConversationView=Readonly<{plan:AssistantAnswerPlan;facts:readonly Readonly<{view:CanonicalModuleJobView;card:number;fact:number}>[]}>;
export type GroundedWorkspaceAnswer=Readonly<{mode:'grounded'|'generic'|'unavailable';views:readonly CanonicalModuleJobView[];fallbackModules:readonly AgentModuleCode[];partial:boolean;tools:readonly string[];conversation?:AssistantConversationView|null}>;
export function workspaceGroundedAnswers(ctx:SessionContext,session:AssistantReadSession,tx?:Tx){
 let remaining=32;const cache=new Map<string,Promise<CanonicalModuleJobView>>();
 return async(binding:AssistantDisclosureBinding,receipt:unknown):Promise<GroundedWorkspaceAnswer>=>{
  const empty=(mode:'generic'|'unavailable'):GroundedWorkspaceAnswer=>Object.freeze({mode,views:Object.freeze([]),fallbackModules:Object.freeze([]),partial:false,tools:Object.freeze([])});
  try{await withAssistantRead(ctx,null,async()=>undefined,session);}catch{return empty('unavailable');}
  if(binding.tenantId!==ctx.tenantId||binding.userId!==ctx.userId)return empty('unavailable');
  const disclosure=openAssistantAnswerDisclosure(binding,receipt);if(disclosure===null)return empty('unavailable');
  const {reads,plan}=disclosure;
  if(reads.length===0){if(plan)try{return Object.freeze({...empty('generic'),conversation:Object.freeze({plan:adjudicateAssistantAnswerPlan(plan,[]),facts:Object.freeze([])})});}catch{return empty('unavailable');}return empty('generic');}
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
   if(view.state==='ready'){views.push(view);tools.push(source.name);indexedViews.set(read,view);answerReads.push(Object.freeze({read,presentation:view.presentation,explanations:Object.freeze([])}));}else{partial=true;fallback.add(fallbackModule);}
  }
  let conversation:AssistantConversationView|null=null;
  if(plan)try{const checked=adjudicateAssistantAnswerPlan(plan,answerReads);
   const facts=checked.mode==='answer'?checked.blocks.flatMap(block=>{if(block.kind!=='fact')return [];const view=indexedViews.get(block.read);if(!view)throw Error();return [Object.freeze({view,card:block.card,fact:block.fact})];}):[];
   conversation=Object.freeze({plan:checked,facts:Object.freeze(facts)});
  }catch{return empty('unavailable');}
  return Object.freeze({conversation,mode:views.length?'grounded':'unavailable',views:Object.freeze(views),fallbackModules:Object.freeze([...fallback]),partial,tools:Object.freeze(tools)});
 };
}
