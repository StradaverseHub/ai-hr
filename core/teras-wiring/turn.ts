/** ADR-0169 §5.1 and ADR-0170 §11.3 change 4 — one live-chat turn through the Teras harness.
 *
 * Reached only from the chat command when ./switch.ts routed this caller to the harness (the tenant's Noveri
 * conversation switch is on and not stopped, and the caller holds the Assistant grant). In order:
 *  1. the continuation, if any, is verified (./history.ts): history is the model-side transcript only;
 *  2. the tenant's active provider is resolved for `hr_assistant` and must be compliant (below), else the turn
 *     is refused before any read or model call;
 *  3. the Assistant question root and the per-user daily question allowance are reserved, as for the closed
 *     grammar (core/ai-spend-task.ts), and every model call is admitted by the gateway under ADR-0116;
 *  4. runTurn with the switch's single-use permit, task memory in the step 5a store keyed by the conversation;
 *  5. the turn's outcome record (core/harness/trace-persistence.ts), kinds and counts only;
 *  6. accounting in all cases: one assistant_exchange row born retired (no question, answer or tool input, the
 *     shape the retirement check pins) with the turn's tokens, the period usage and the question budget
 *     completion, in one transaction, so the allowances count a harness turn exactly like a closed-grammar one.
 * Nothing here confirms or writes an HR change: a card links to its review page, where the owner re-checks. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {assistantExchange,assistantUsage} from '../../db/schema';
import type {TerasAttestedProvider} from '../../db/teras-schema';
import {isSensitiveReason} from '../../lib/product-context/request-gate';
import {AiAllowanceError,type AiProvider} from '../../lib/ai/types';
import {AiPrivacyGateError} from '../../lib/ai/provider-privacy-request';
import {resolveActiveAiConfig} from '../ai-config';
import {bindAiSpendTaskTx} from '../ai-spend-task';
import {assistantQuestionBudgetBinding,AssistantQuestionBudgetError,completeAssistantQuestionBudgetTx,type AssistantQuestionBudget} from '../assistant-question-budget';
import type {HarnessPermit} from '../harness/permit';
import {runTurn,type TurnResult} from '../harness/runner';
import {PostgresTaskMemoryStore} from '../harness/task-memory-store';
import {nativeToolProvider,type ToolProvider} from '../harness/tools';
import {registeredWorker} from '../agent-registry/workers';
import {persistTurnTrace} from '../harness/trace-persistence';
import {PRIVATE_CASE_START_PATH,privateCaseRouteAvailable} from '../private-case-route';
import {ContinuationRefused,issueConversationContinuation,newConversation,verifyConversationContinuation} from './history';
import {gatewayModelClient,type ModelClientTotals} from './model-client';
import type {ChatImportFile} from '../../lib/chat-import';

export type ConversationErrorCode='invalid_question'|'continuation_invalid'|'not_configured'|'provider_not_compliant'|'budget_daily'|'budget_monthly'|'ai_control'|'protected_input'|'provider_error';
export class ConversationTurnError extends Error{constructor(readonly code:ConversationErrorCode){super('conversation:'+code);this.name='ConversationTurnError';}}

const MAX_QUESTION_CHARS=2000;
const DIRECT:readonly AiProvider[]=Object.freeze(['anthropic','openai','google']);

/** Zero data retention and no training, decided from configuration alone. An OpenRouter route sends both on every
 * request; a direct upstream route is compliant only when an administrator attested that provider's account terms
 * on switching on; an OpenAI-style gateway's upstream is unknown, so it is not. */
export function compliantProvider(provider:AiProvider,attested:TerasAttestedProvider|null):boolean{
 if(provider==='openrouter')return true;
 return DIRECT.includes(provider)&&attested===provider;
}

export type ConversationTurn=Readonly<{
 turnId:string;reply:string;mode:string|null;slot:string|null;
 suggestion:TurnResult['suggestion'];
 /** Proposals this turn prepared, each verified by the harness for this caller. */
 proposals:TurnResult['proposals'];reads:readonly string[];
 /** The pre-read gate routed the turn to the HR contact (any sensitive topic), refused a judgement about someone, or met a crisis. */
 sensitive:boolean;refused:boolean;crisis:boolean;fallback:boolean;
 /** AI v2 W11: on a routed sensitive turn where the protected case route is set up for this person and company, the
  * intake form's path ("Start a private case with HR"); otherwise null. The AI never opens or fills that form. */
 caseRoute:string|null;
 continuation:string;
 /** For the server only (outcome evaluation): the turn's trace and its model-side transcript. Never rendered. */
 trace:TurnResult['trace'];modelTurn:TurnResult['modelTurn']}>;

/** The native tool provider, without the explainers worker's tools while its switch is off or the tenant is stopped. */
export function conversationTools(explainers:boolean):ToolProvider{
 const record=registeredWorker('explainers')?.record,withheld=new Set(record?.kind==='outcome_record'?record.tools??[]:[]);
 return explainers?nativeToolProvider:async(ctx,scope,actions)=>{const candidates=await nativeToolProvider(ctx,scope,actions);
  return Object.freeze({...candidates,bindings:Object.freeze(candidates.bindings.filter(binding=>!withheld.has(binding.name)))});};
}

export async function runConversationTurn(supplied:SessionContext,route:Readonly<{permit:HarnessPermit;attestedProvider:TerasAttestedProvider|null;explainers:boolean}>,
 input:Readonly<{question:unknown;continuation?:unknown;companyId:string;locale:string;
  /** AI v2 slice 3: a file attached to this turn for an import (lib/chat-import.ts). Only prepare_import's native
   * preparer reads it; it is never sent to the model, stored with the chat or traced. */
  importFile?:ChatImportFile}>):Promise<ConversationTurn>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 const question=typeof input.question==='string'?input.question.trim():'';
 if(!ctx.userId||!question||question.length>MAX_QUESTION_CHARS||!input.companyId)throw new ConversationTurnError('invalid_question');
 const appUserId=ctx.userId;
 let conversation;
 try{conversation=input.continuation===undefined?newConversation():verifyConversationContinuation(ctx,input.continuation);}
 catch(error){if(error instanceof ContinuationRefused)throw new ConversationTurnError('continuation_invalid');throw error;}

 const admitted=await withTenant(ctx,async tx=>{
  const cfg=await resolveActiveAiConfig(tx,ctx,'hr_assistant');
  if(!cfg)throw new ConversationTurnError('not_configured');
  if(!compliantProvider(cfg.provider,route.attestedProvider))throw new ConversationTurnError('provider_not_compliant');
  const rooted=await bindAiSpendTaskTx(tx,ctx,cfg,{kind:'assistant_question'});
  return{configuration:rooted,...assistantQuestionBudgetBinding(ctx,rooted),provider:cfg.provider,model:cfg.model};
 }).catch(error=>{
  if(error instanceof ConversationTurnError)throw error;
  if(error instanceof AssistantQuestionBudgetError)throw new ConversationTurnError(error.budgetCode);
  if(error instanceof AiAllowanceError)throw new ConversationTurnError('ai_control');
  throw new ConversationTurnError('provider_error');
 });

 const totals:ModelClientTotals={calls:0,inputTokens:0,outputTokens:0,cachedInputTokens:0,costUsd:0};
 let result:TurnResult|undefined,failure:ConversationErrorCode|null=null;
 try{
  result=await runTurn({enabled:route.permit,ctx,conversationId:conversation.conversationId,question,history:conversation.history,
   scope:{companyId:input.companyId,locale:input.locale,...(input.importFile?{importFile:input.importFile}:{})},model:gatewayModelClient(admitted.configuration,totals),memory:new PostgresTaskMemoryStore(ctx),
   tools:conversationTools(route.explainers),caseRouteAvailable:()=>privateCaseRouteAvailable(ctx,input.companyId)});
  await persistTurnTrace(ctx,result.trace,{companyId:input.companyId});
 }catch(error){
  failure=error instanceof AssistantQuestionBudgetError?error.budgetCode:error instanceof AiAllowanceError?'ai_control':error instanceof AiPrivacyGateError?'protected_input':'provider_error';
 }finally{
  await recordAccounting(ctx,appUserId,admitted,totals,result);
 }
 if(failure||!result)throw new ConversationTurnError(failure??'provider_error');
 const reason=result.trace.gate.reason;
 // Cards for what this turn prepared; proposals from earlier turns were shown with those turns.
 const started=Date.parse(result.trace.startedAt);
 return Object.freeze({turnId:result.trace.turnId,reply:result.reply,mode:result.mode,slot:result.slot,suggestion:result.suggestion,trace:result.trace,modelTurn:result.modelTurn,
  proposals:result.proposals.filter(proposal=>Date.parse(proposal.body.createdAt)>=started),reads:result.reads,
  sensitive:isSensitiveReason(reason),refused:reason==='workplace_harm',crisis:reason==='sensitive_crisis',fallback:result.trace.outcome.fallback,
  caseRoute:result.caseRoute&&isSensitiveReason(reason)?PRIVATE_CASE_START_PATH:null,
  continuation:issueConversationContinuation(ctx,conversation.conversationId,[...conversation.history,...result.modelTurn])});
}

/** One retired exchange row, the period usage and the question budget completion, in one transaction. The row
 * keeps counts, tokens, provider and model only: the harness turn's words live nowhere in assistant_exchange. */
async function recordAccounting(ctx:SessionContext,appUserId:string,admitted:Readonly<{period:string;reservation:AssistantQuestionBudget;provider:string;model:string}>,
 totals:ModelClientTotals,result:TurnResult|undefined):Promise<void>{
 const id=randomUUID(),budgets=result?.trace.budgets;
 await withTenant(ctx,async tx=>{
  await tx.insert(assistantExchange).values({tenantId:ctx.tenantId,appUserId,id,question:'',answer:null,disclosureReceipt:null,toolCalls:[],
   contentRetiredAt:sql`clock_timestamp()`,turnCount:totals.calls,hitTurnCap:budgets?.exhausted==='steps',
   stop:result&&!result.trace.outcome.fallback?'end':'other',provider:admitted.provider,model:admitted.model,
   inputTokens:totals.inputTokens,outputTokens:totals.outputTokens,cachedInputTokens:totals.cachedInputTokens,error:null});
  await tx.insert(assistantUsage).values({tenantId:ctx.tenantId,period:admitted.period,inputTokens:totals.inputTokens,outputTokens:totals.outputTokens,cachedInputTokens:totals.cachedInputTokens,exchangeCount:1})
   .onConflictDoUpdate({target:[assistantUsage.tenantId,assistantUsage.period],set:{
    inputTokens:sql`${assistantUsage.inputTokens} + ${totals.inputTokens}`,outputTokens:sql`${assistantUsage.outputTokens} + ${totals.outputTokens}`,
    cachedInputTokens:sql`${assistantUsage.cachedInputTokens} + ${totals.cachedInputTokens}`,exchangeCount:sql`${assistantUsage.exchangeCount} + 1`,updatedAt:sql`now()`}});
  await completeAssistantQuestionBudgetTx(tx,ctx,admitted.reservation,id);
 });
}
