/** Source-owned answer rendering, not a model-prose adjudicator. Raw answers stay audit-only.
 * Sealed executed lookups nominate reads; current canonical tool/RLS/field policy owns every card.
 * Cache lifetime is this one actor's actual read transaction only. No provider, effect or ambient query.
 */
import type {SessionContext} from '../db/client';
import {withAssistantRead,type AssistantReadSession} from './assistant-read-session';
import {openAssistantDisclosure,type AssistantDisclosureBinding} from '../lib/ai/assistant-disclosure';
import {loadCanonicalToolJob,type CanonicalModuleJobView} from './workspace-module-jobs';
import {isGroundedToolName,GROUNDED_TOOL_MODULES} from '../lib/ai/grounded-tool-presentation';
import {isAgentModuleCode,type AgentModuleCode} from '../lib/ai/module-agents';
export type GroundedWorkspaceAnswer=Readonly<{mode:'grounded'|'generic'|'unavailable';views:readonly CanonicalModuleJobView[];fallbackModules:readonly AgentModuleCode[];partial:boolean;tools:readonly string[]}>;
export function workspaceGroundedAnswers(ctx:SessionContext,session:AssistantReadSession){
 let remaining=32;const cache=new Map<string,Promise<CanonicalModuleJobView>>();
 return async(binding:AssistantDisclosureBinding,receipt:unknown):Promise<GroundedWorkspaceAnswer>=>{
  const empty=(mode:'generic'|'unavailable'):GroundedWorkspaceAnswer=>Object.freeze({mode,views:Object.freeze([]),fallbackModules:Object.freeze([]),partial:false,tools:Object.freeze([])});
  try{await withAssistantRead(ctx,null,async()=>undefined,session);}catch{return empty('unavailable');}
  if(binding.tenantId!==ctx.tenantId||binding.userId!==ctx.userId)return empty('unavailable');
  const reads=openAssistantDisclosure(binding,receipt);if(reads===null)return empty('unavailable');if(reads.length===0)return empty('generic');
  const views:CanonicalModuleJobView[]=[],fallback=new Set<AgentModuleCode>(),tools:string[]=[],seen=new Set<string>();let partial=reads.length>8;
  for(const source of reads.slice(0,8)){
   if(!isGroundedToolName(source.name)){partial=true;continue;}
   const input=source.input&&typeof source.input==='object'&&!Array.isArray(source.input)?source.input as Record<string,unknown>:null;
   const fallbackModule=source.name==='my_module_work'&&isAgentModuleCode(input?.module)?input.module:GROUNDED_TOOL_MODULES[source.name];
   const key=JSON.stringify([source.name,source.input,source.digest]);if(seen.has(key))continue;seen.add(key);
   let pending=cache.get(key);if(!pending){if(remaining--<=0){partial=true;fallback.add(fallbackModule);continue;}
    pending=loadCanonicalToolJob(ctx,source.name,source.input,source.digest,session);cache.set(key,pending);}
   const view=await pending;
   if(view.state==='ready'){views.push(view);tools.push(source.name);}else{partial=true;fallback.add(fallbackModule);}
  }
  return Object.freeze({mode:views.length?'grounded':'unavailable',views:Object.freeze(views),fallbackModules:Object.freeze([...fallback]),partial,tools:Object.freeze(tools)});
 };
}
