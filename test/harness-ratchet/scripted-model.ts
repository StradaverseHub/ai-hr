/** A scripted ModelClient for harness tests: each step returns the calls or final answer it is given, in
 * order, and records every request so a test can see exactly what the model was sent. No provider. */
import type {HarnessToolCall,ModelClient,ModelRequest,ModelResponse} from '../../core/harness/model-client';

export type ScriptStep=Readonly<{
 calls?:readonly Readonly<{name:string;args?:unknown;raw?:string}>[];
 final?:Readonly<{reply:string;mode?:string;slot?:string}>;
 /** Sends unreadable final_answer arguments. */
 rawFinal?:string;
 finish?:ModelResponse['finish'];
 content?:string|null;
 usage?:Partial<ModelResponse['usage']>;
}>|((request:ModelRequest,index:number)=>ScriptStep);
export type ScriptedModel=ModelClient&{readonly requests:ModelRequest[]};

export function scriptedModel(steps:readonly ScriptStep[],modelId='fictional/scripted-model'):ScriptedModel{
 const requests:ModelRequest[]=[];let callId=0;
 return{modelId,requests,async complete(request){
  const index=requests.length;requests.push({...request,messages:[...request.messages],tools:[...request.tools]});
  const entry=steps[index]??{final:{reply:'Script ended.',mode:'answer'}};const step=typeof entry==='function'?entry(request,index):entry;
  const toolCalls:HarnessToolCall[]=[...(step.calls??[]).map(call=>({id:'call-'+ ++callId,name:call.name,arguments:call.raw??JSON.stringify(call.args??{})})),
   ...(step.final?[{id:'call-'+ ++callId,name:'final_answer',arguments:JSON.stringify({mode:step.final.mode??'answer',...(step.final.slot?{slot:step.final.slot}:{}),reply:step.final.reply})}]:[]),
   ...(step.rawFinal!==undefined?[{id:'call-'+ ++callId,name:'final_answer',arguments:step.rawFinal}]:[])];
  return{content:step.content??null,toolCalls,finish:step.finish??(toolCalls.length?'tool_calls':'stop'),
   usage:{inputTokens:step.usage?.inputTokens??100,outputTokens:step.usage?.outputTokens??20,costUsd:step.usage?.costUsd??0.001}};
 }};
}
