/** ADR-0169 §5.1 and ADR-0170 §11.3 change 4 — the production ModelClient for a Noveri conversation turn.
 *
 * It calls the tenant's own active provider through the existing gateway: the configuration is the governed one
 * resolved for `hr_assistant` (core/ai-config.ts) and bound to the Assistant question root and budget
 * (core/ai-spend-task.ts), so every call passes the same admission as every other provider call: pauses,
 * per-company and per-user allowances, the monthly token ceiling, concurrency and any USD cap (ADR-0116), with
 * actual usage settled afterwards. Each call is prepared under the reviewed contract `teras_harness_turn_v1`
 * (lib/ai/teras-harness-policy.ts): the gateway refuses it unless the owner approval binds the current
 * provider-data source digest. No provider adapter is added; the route is the one the tenant chose. OpenRouter
 * requests carry data_collection=deny and zdr=true (lib/ai/providers/openrouter-policy.ts); the direct routes are
 * admitted only when the administrator attested their account terms (./turn.ts). */
import {converse} from '../../lib/ai';
import {fromStrictArguments,TERAS_HARNESS_CONTRACT} from '../../lib/ai/teras-harness-policy';
import type {ResolvedAiConfig} from '../../lib/ai/types';
import {preparePrivateAiTask,withAiRunObserver} from '../ai-governance';
import type {HarnessMessage,ModelClient,ModelRequest,ModelResponse} from '../harness/model-client';
import {HARNESS_SPEC} from '../harness/spec';

export type ModelClientTotals={calls:number;inputTokens:number;outputTokens:number;cachedInputTokens:number;costUsd:number};

/** The harness message in the contract's exact shape (an assistant message always lists its tool calls). */
function sourceMessage(message:HarnessMessage){
 if(message.role==='assistant')return{role:'assistant' as const,content:message.content??null,toolCalls:(message.toolCalls??[]).map(call=>({id:call.id,name:call.name,arguments:call.arguments}))};
 if(message.role==='tool')return{role:'tool' as const,toolCallId:message.toolCallId,content:message.content};
 return{role:message.role,content:message.content};
}

export function gatewayModelClient(configuration:ResolvedAiConfig,totals:ModelClientTotals):ModelClient{
 let lastCredits=0;
 // OpenRouter reports its account charge per call; it is the turn's spend figure for the harness budget.
 const observed=withAiRunObserver(configuration,{observation(value){lastCredits=value.accountCostCredits??0;}});
 return{
  modelId:configuration.provider+'/'+configuration.model,
  async complete(request:ModelRequest):Promise<ModelResponse>{
   if(request.signal.aborted)throw new Error('The turn time limit was reached.');
   const declared=new Map(request.tools.map(tool=>[tool.name,tool.parameters as Record<string,unknown>]));
   const source={version:1 as const,messages:request.messages.map(sourceMessage),tools:request.tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters})),
    maxOutputTokens:request.maxOutputTokens,timeoutMs:Math.min(HARNESS_SPEC.budgets.callTimeoutMs,120_000)};
   const prepared=await preparePrivateAiTask(observed,TERAS_HARNESS_CONTRACT,async()=>source);
   try{
    if(prepared.operation!=='conversation')throw new Error('The prepared AI request could not be confirmed.');
    lastCredits=0;totals.calls++;
    const result=await converse(prepared.configuration,prepared.args);
    totals.inputTokens+=result.usage.inputTokens;totals.outputTokens+=result.usage.outputTokens;totals.cachedInputTokens+=result.usage.cachedInputTokens;totals.costUsd+=lastCredits;
    return{content:result.text||null,
     toolCalls:result.toolCalls.map(call=>({id:call.id,name:call.name,arguments:call.input===undefined?'':JSON.stringify(fromStrictArguments(declared.get(call.name),call.input))})),
     finish:result.stop==='max_tokens'?'length':result.stop==='tool_use'?'tool_calls':result.stop==='end'?'stop':'other',
     usage:{inputTokens:result.usage.inputTokens+result.usage.cachedInputTokens,outputTokens:result.usage.outputTokens,costUsd:lastCredits}};
   }finally{prepared.dispose();}
  },
 };
}
