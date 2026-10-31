/** A clarification continues only the actual caller's authenticated exchange. Historical model prose
 * and source rows are never reused as authority or copied into the next provider request. */
import {eq,and,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assistantExchange} from '../db/schema';
import {boundNativeOutcomeTransactionTx as boundClarificationReadTx} from './module-native-outcome-bounds';
import {assertAiPrincipalTx} from './ai-principal';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {mayUseAssistant} from './assistant-grant';
import {resolveEntitlementsTx} from './entitlements';
import {assistantConversationScopeDigest} from './assistant-conversation-context';
import {openAssistantAnswerDisclosure} from '../lib/ai/assistant-disclosure';
import type {AssistantClarificationSlot} from '../lib/ai/assistant-answer-plan';

export const ASSISTANT_CONVERSATION_LIMITS=Object.freeze({humanAnswer:500,history:8000});
/** `originalQuestion` is TRANSIENT provider context for the continuation and is never stored on the new
 * exchange: the original raw text must retire with its own exchange, 30 days from that question. */
export type OwnAssistantClarification=Readonly<{originalQuestion:string;slot:AssistantClarificationSlot;answer:string;
 /** Owner decision 28 Oct 2026: the earlier human turns of the same conversation, oldest first, each with the
  * slot it was asked. Linked through `continues_exchange_id` (0658); every row is still own, current and
  * within its own 30 days. Transient context exactly like `originalQuestion`; never stored again. */
 earlier:readonly Readonly<{question:string;slot:AssistantClarificationSlot}>[]}>;
/** How many earlier linked replies one continuation may carry, besides the exchange it answers. */
export const ASSISTANT_CONTINUATION_DEPTH=6;
type SourceRow=Readonly<{exchangeId:string;question:string;answer?:string;receipt?:string}>;
/** Server-only source binding of each clarification this owner issued. Never serialized or returned. */
const clarificationSources=new WeakMap<object,Readonly<{tenantId:string;userId:string;exchangeId:string;rows:readonly SourceRow[];scopeDigest:string;conversationScope:string;threadId?:string}>>();
/** The exchange this clarification answers, for the new row's `continues_exchange_id`. Only an object this
 * owner issued has one; anything else gets null and is stored without a link. */
export function assistantClarificationSourceExchangeId(clarification:OwnAssistantClarification|null):string|null{
 return clarification===null?null:clarificationSources.get(clarification)?.exchangeId??null;
}
/** Durable identity is exposed only from this owner's verified same-scope clarification. */
export function assistantClarificationThreadId(value:OwnAssistantClarification|null):string|undefined{return value===null?undefined:clarificationSources.get(value)?.threadId;}
/** A conservative UI offer: every allowed next human answer must fit, without truncation. */
export function canClarifyAssistantQuestion(question:unknown):boolean{
 return typeof question==='string'&&question.length+2+ASSISTANT_CONVERSATION_LIMITS.humanAnswer<=ASSISTANT_CONVERSATION_LIMITS.history;
}

export class AssistantClarificationError extends Error { constructor(){super('Current clarification unavailable.');this.name='AssistantClarificationError';} }

export async function ownAssistantClarification(ctx:SessionContext,exchangeId:unknown,response:unknown,conversationScope='assistant-service'):Promise<OwnAssistantClarification>{
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const id=exchangeId,answer=typeof response==='string'?response.trim():null;
 const refuse=():never=>{throw new AssistantClarificationError();};
 if(typeof conversationScope!=='string'||conversationScope.length>4096)return refuse();
 if(!captured.userId||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||!answer||answer.length>ASSISTANT_CONVERSATION_LIMITS.humanAnswer)return refuse();
 const userId=captured.userId,scopeDigest=assistantConversationScopeDigest(captured,conversationScope);
 try{return await withTenant(captured,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
  await boundClarificationReadTx(tx);
  await assertAiPrincipalTx(tx,captured);
  const fresh={...captured,entitlements:await resolveEntitlementsTx(tx,captured.tenantId)};
  if(!(await mayUseAssistant(fresh,tx)).allowed)return refuse();
  // Own, unretired and inside its own 30 days, with an authenticated clarify plan; null otherwise.
  const step=async(stepId:string)=>{
   const [row]=await tx.select({id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt,continues:assistantExchange.continuesExchangeId})
    .from(assistantExchange).where(and(eq(assistantExchange.id,stepId),eq(assistantExchange.tenantId,captured.tenantId),eq(assistantExchange.appUserId,userId),isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
   if(!row?.answer)return null;
   const proof=openAssistantAnswerDisclosure({tenantId:captured.tenantId,userId,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt);
   return proof?.plan?.mode==='clarify'&&(!proof.thread||proof.thread.scopeDigest===scopeDigest)?{id:row.id,question:row.question,answer:row.answer,receipt:row.receipt,threadId:proof.thread?.threadId,slot:proof.plan.slot,continues:row.continues}:null;
  };
  const row=await step(id);
  if(!row)return refuse();
  // Both text fields were human supplied. The authenticated slot is context, never an effect argument
  // or a source capability. The next real model turn must freshly query canonical tools as usual.
  let used=row.question.length+2+answer.length;
  if(used>ASSISTANT_CONVERSATION_LIMITS.history)return refuse();
  // Walk back through earlier replies of the same conversation. Stop, without refusing, at the depth or
  // history bound, a deleted link, or any row that is retired, foreign, expired or not a clarification:
  // the conversation simply starts later. Nothing older than a row's own 30 days is ever carried.
  const earlier:{question:string;slot:AssistantClarificationSlot}[]=[],rows:SourceRow[]=[{exchangeId:row.id,question:row.question,...(row.threadId&&row.receipt?{answer:row.answer,receipt:row.receipt}:{})}],seen=new Set([row.id]);
  for(let next=row.continues;next&&!seen.has(next)&&earlier.length<ASSISTANT_CONTINUATION_DEPTH;){
   const prior=await step(next);
   if(!prior||row.threadId&&prior.threadId!==row.threadId||used+prior.question.length+2>ASSISTANT_CONVERSATION_LIMITS.history)break;
   used+=prior.question.length+2;seen.add(prior.id);
   earlier.unshift({question:prior.question,slot:prior.slot});rows.unshift({exchangeId:prior.id,question:prior.question,...(prior.threadId&&prior.receipt?{answer:prior.answer,receipt:prior.receipt}:{})});
   next=prior.continues;
  }
  const issued:OwnAssistantClarification=Object.freeze({originalQuestion:row.question,slot:row.slot,answer,earlier:Object.freeze(earlier.map(e=>Object.freeze(e)))});
  clarificationSources.set(issued,Object.freeze({tenantId:captured.tenantId,userId,exchangeId:row.id,rows:Object.freeze(rows),scopeDigest,conversationScope,...(row.threadId?{threadId:row.threadId}:{})}));
  return issued;
 });}catch{return refuse();}
}

/** Re-run in every later transaction that admits `originalQuestion` towards a provider: the strategy-marker
 * transaction and each provider round trip. The caller must already hold the Access-configuration interval
 * that own-history erasure and PDPA redaction also join (taken again here; it is reentrant). A source
 * exchange erased, retired, past its own 30 days or changed since the read refuses exactly as the read
 * would. Nothing is reopened, recreated or stored, and only an object this owner issued for the same
 * tenant and login can pass: a copied or hand-built clarification has no source binding. */
export async function assertOwnAssistantClarificationCurrentTx(tx:Tx,ctx:SessionContext,clarification:OwnAssistantClarification):Promise<void>{
 const source=clarificationSources.get(clarification);
 if(!source||source.tenantId!==ctx.tenantId||source.userId!==ctx.userId||source.scopeDigest!==assistantConversationScopeDigest(ctx,source.conversationScope))throw new AssistantClarificationError();
 let current=false;
 try{
  await lockAccessConfigurationTx(tx,source.tenantId);
  // Every carried row, not only the answered one: an earlier reply erased or retired since the read
  // refuses the whole continuation rather than reaching a provider.
  const found=await tx.select({id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt}).from(assistantExchange)
   .where(and(inArray(assistantExchange.id,source.rows.map(r=>r.exchangeId)),eq(assistantExchange.tenantId,source.tenantId),eq(assistantExchange.appUserId,source.userId),
    isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`));
  const byId=new Map(found.map(r=>[r.id,r]));
  current=source.rows.at(-1)?.question===clarification.originalQuestion&&source.rows.every(r=>{const current=byId.get(r.exchangeId);return current?.question===r.question&&(r.receipt===undefined||current.answer===r.answer&&current.receipt===r.receipt);});
 }catch{/* A storage failure aborts the caller's transaction; it is never read as a current source. */}
 if(!current)throw new AssistantClarificationError();
}
