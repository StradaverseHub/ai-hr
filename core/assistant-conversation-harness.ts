/** Actual bounded provider conversation over independent synthetic canonical sources. No production
 * HR, source callbacks, models' ratings, effects or arbitrary provider config enter this evaluator. */
import {converse} from '../lib/ai';
import type {AiToolSpec,AiTurn,AiToolResult,ResolvedAiConfig} from '../lib/ai/types';
import {ASSISTANT_TOOLS} from './assistant-tools';
import {buildAssistantConversationSystem} from '../lib/ai/assistant-conversation-system';
import {withAiAdmissionLifecycle,type AiAdmissionLifecycle} from './ai-governance';
import {captureAgentReadBatch} from '../lib/ai/agent-read-batch';
import {routingDigest} from '../lib/ai/module-agent-routing';
import {ASSISTANT_CONVERSATION_HOLDOUTS} from '../lib/ai/assistant-conversation-holdouts';
import {ASSISTANT_CONVERSATION_BASELINE,assistantConversationCandidateSystem,captureAssistantConversationCandidate,nextAssistantConversationArms,scoreAssistantConversationTrial,type ConversationArm,type ConversationToolObservation,type ConversationCaseResult} from '../lib/ai/assistant-conversation-candidate';
import type {AssistantAnswerRead} from '../lib/ai/assistant-answer-plan';
import {assistantProposalCatalogue,syntheticAssistantProposalCaller} from '../lib/ai/assistant-action-catalogue';
// The actual product metadata is offered, but its executable tools are NEVER called here.
// Each fixture's closed synthetic dispatch supplies only its permitted canonical source.
const tools:AiToolSpec[]=ASSISTANT_TOOLS.map(tool=>({...tool.spec,inputSchema:structuredClone(tool.spec.inputSchema)}));
export type ConversationHarnessBinding=Readonly<{candidateDigest:string;providerFingerprint:string}>;
export type ConversationHarnessCheckpoint=Readonly<{arm:'baseline'|'candidate';case:ConversationCaseResult;calls:number}>;
/** Checkpoint is a private source-owner closure, not an HTTP argument. Its storage write rechecks
 * actual actor/provider/candidate and independently seals this exact bounded arm before continuing. */
export async function executeAssistantConversationHoldout(configuration:unknown,cfg:ResolvedAiConfig,binding:ConversationHarnessBinding,prior:readonly ConversationArm[],checkpoint:(value:ConversationHarnessCheckpoint)=>Promise<void>){
 const candidate=captureAssistantConversationCandidate(configuration),queue=nextAssistantConversationArms(ASSISTANT_CONVERSATION_HOLDOUTS,prior,binding);
 let calls=0,completed=0,unavailable=0;
 for(const request of queue){
  // Three actual round trips cover balance->explanation->terminal. Reserve remaining CALL capacity,
  // not money, before starting an arm; no arm receives an independent twelve-call allowance.
  if(calls+3>12)break;
  const fixture=ASSISTANT_CONVERSATION_HOLDOUTS.find(row=>row.id===request.id)!;
  const turns:AiTurn[]=[{role:'user',content:JSON.stringify({locale:fixture.locale,question:fixture.question,evaluationClock:'2026-10-01',fictionalSource:true})}],reads:AssistantAnswerRead[]=[],observedTools:ConversationToolObservation[]=[];
  let terminal:unknown,failed=false,inputTokens=0,outputTokens=0,costCredits=0,costKnown=true,tokensKnown=true;const started=performance.now(),firstCall=calls;
  for(let step=0;step<3;step++){
   const usage:{settled?:Parameters<NonNullable<AiAdmissionLifecycle['settled']>>[1]}={};
   try{
    const observed=withAiAdmissionLifecycle(cfg,'module_agent_evaluation',{async settled(_tx,event){usage.settled=event;}});calls++;
    const response=await converse(observed,{system:buildAssistantConversationSystem(assistantConversationCandidateSystem(request.arm==='baseline'?ASSISTANT_CONVERSATION_BASELINE:candidate),assistantProposalCatalogue(syntheticAssistantProposalCaller(fixture.readableModules??[]))),turns,tools,maxTokens:2048,timeoutMs:15000});
    if(response.usageReported===false||!usage.settled?.succeeded||usage.settled.actualTokens===null)tokensKnown=false;inputTokens+=response.usage.inputTokens+response.usage.cachedInputTokens;outputTokens+=response.usage.outputTokens;
    const charge=usage.settled?.accounting.providerObservationStatus==='reported'?usage.settled.accounting.openrouterAccountCostCredits:null;
    if(charge===null||charge===undefined)costKnown=false;else costCredits+=charge;
    if(response.stop!=='tool_use'){terminal=response.stop==='end'?response.text:undefined;break;}
    const batch=captureAgentReadBatch(response.toolCalls);turns.push({role:'assistant',content:response.text,toolCalls:[...batch],providerState:response.providerState});
    const results:AiToolResult[]=[];
    for(const call of batch){const observation={name:call.name,input:call.input??null};observedTools.push(observation);
     const index=reads.length,expected=fixture.expectedTools[index],read=fixture.reads[index];
     if(!read||!expected||routingDigest(observation)!==routingDigest(expected)){results.push({id:call.id,name:call.name,content:JSON.stringify({ok:false,message:'This source is unavailable for this request.'}),isError:true});continue;}
     reads.push(read);
     const canonical=fixture.source&&typeof fixture.source==='object'?fixture.source as Record<string,unknown>:{};
     // A fixed fixture's exact permitted source is returned only after the matching declared tool.
     // Expected terminal selectors and expected quality scores never leave this evaluator.
     const context=call.name==='my_leave_balances'?canonical.balance:call.name==='leave_entitlement_explain'?canonical.explanation:undefined;
     results.push({id:call.id,name:call.name,content:JSON.stringify({ok:true,canonicalRead:read,...(context?{context}:{})})});
    }
    turns.push({role:'tool',results});
   }catch{failed=true;unavailable++;break;}
  }
  if(failed)break; // A failed admission/provider/checkpoint never creates passing arm evidence.
  const scored=scoreAssistantConversationTrial(fixture,{terminal,reads,tools:observedTools,observation:{elapsedMs:Math.max(0,performance.now()-started),inputTokens:tokensKnown?inputTokens:null,outputTokens:tokensKnown?outputTokens:null,costCredits:costKnown?costCredits:null}});
  // Persist only exact fixed source arguments or a closed rejection marker. Never retain arbitrary
  // model argument text/tool names. This normalization preserves failed/blocked flags and counts.
  const result:ConversationCaseResult=Object.freeze({...scored,tools:Object.freeze(scored.tools.map(tool=>fixture.expectedTools.find(expected=>routingDigest(expected)===routingDigest(tool))??Object.freeze({name:'unavailable_source',input:null})))});
  await checkpoint({arm:request.arm,case:result,calls:calls-firstCall});completed++;
 }
 return Object.freeze({attemptedCalls:calls,completedArms:completed,unavailable});
}
