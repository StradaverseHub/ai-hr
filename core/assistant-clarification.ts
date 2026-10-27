/** A clarification continues only the actual caller's authenticated exchange. Historical model prose
 * and source rows are never reused as authority or copied into the next provider request. */
import {eq,and,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assistantExchange} from '../db/schema';
import {boundNativeOutcomeTransactionTx as boundClarificationReadTx} from './module-native-outcome-bounds';
import {assertAiPrincipalTx} from './ai-principal';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {mayUseAssistant} from './assistant-grant';
import {resolveEntitlementsTx} from './entitlements';
import {openAssistantAnswerDisclosure} from '../lib/ai/assistant-disclosure';
import type {AssistantClarificationSlot} from '../lib/ai/assistant-answer-plan';

export const ASSISTANT_CONVERSATION_LIMITS=Object.freeze({humanAnswer:500,history:8000});
/** `originalQuestion` is TRANSIENT provider context for the continuation and is never stored on the new
 * exchange: the original raw text must retire with its own exchange, 30 days from that question. */
export type OwnAssistantClarification=Readonly<{originalQuestion:string;slot:AssistantClarificationSlot;answer:string}>;
/** Server-only source binding of each clarification this owner issued. Never serialized or returned. */
const clarificationSources=new WeakMap<object,Readonly<{tenantId:string;userId:string;exchangeId:string}>>();
/** A conservative UI offer: every allowed next human answer must fit, without truncation. */
export function canClarifyAssistantQuestion(question:unknown):boolean{
 return typeof question==='string'&&question.length+2+ASSISTANT_CONVERSATION_LIMITS.humanAnswer<=ASSISTANT_CONVERSATION_LIMITS.history;
}

export class AssistantClarificationError extends Error { constructor(){super('Current clarification unavailable.');this.name='AssistantClarificationError';} }

export async function ownAssistantClarification(ctx:SessionContext,exchangeId:unknown,response:unknown):Promise<OwnAssistantClarification>{
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const id=exchangeId,answer=typeof response==='string'?response.trim():null;
 const refuse=():never=>{throw new AssistantClarificationError();};
 if(!captured.userId||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||!answer||answer.length>ASSISTANT_CONVERSATION_LIMITS.humanAnswer)return refuse();
 const userId=captured.userId;
 try{return await withTenant(captured,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
  await boundClarificationReadTx(tx);
  await assertAiPrincipalTx(tx,captured);
  const fresh={...captured,entitlements:await resolveEntitlementsTx(tx,captured.tenantId)};
  if(!(await mayUseAssistant(fresh,tx)).allowed)return refuse();
  const [row]=await tx.select({id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt})
   .from(assistantExchange).where(and(eq(assistantExchange.id,id),eq(assistantExchange.appUserId,userId),isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
  if(!row?.answer)return refuse();
  const proof=openAssistantAnswerDisclosure({tenantId:captured.tenantId,userId,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt);
  if(proof?.plan?.mode!=='clarify')return refuse();
  // Both text fields were human supplied. The authenticated slot is context, never an effect argument
  // or a source capability. The next real model turn must freshly query canonical tools as usual.
  if(row.question.length+2+answer.length>ASSISTANT_CONVERSATION_LIMITS.history)return refuse();
  const issued:OwnAssistantClarification=Object.freeze({originalQuestion:row.question,slot:proof.plan.slot,answer});
  clarificationSources.set(issued,Object.freeze({tenantId:captured.tenantId,userId,exchangeId:row.id}));
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
 if(!source||source.tenantId!==ctx.tenantId||source.userId!==ctx.userId)throw new AssistantClarificationError();
 let current=false;
 try{
  await lockAccessConfigurationTx(tx,source.tenantId);
  const [row]=await tx.select({question:assistantExchange.question}).from(assistantExchange)
   .where(and(eq(assistantExchange.id,source.exchangeId),eq(assistantExchange.tenantId,source.tenantId),eq(assistantExchange.appUserId,source.userId),
    isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
  current=row?.question===clarification.originalQuestion;
 }catch{/* A storage failure aborts the caller's transaction; it is never read as a current source. */}
 if(!current)throw new AssistantClarificationError();
}
