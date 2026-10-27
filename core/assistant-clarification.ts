/** A clarification continues only the actual caller's authenticated exchange. Historical model prose
 * and source rows are never reused as authority or copied into the next provider request. */
import {eq,and,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {assistantExchange} from '../db/schema';
import {boundNativeOutcomeTransactionTx as boundClarificationReadTx} from './module-native-outcome-bounds';
import {assertAiPrincipalTx} from './ai-principal';
import {mayUseAssistant} from './assistant-grant';
import {resolveEntitlementsTx} from './entitlements';
import {openAssistantAnswerDisclosure} from '../lib/ai/assistant-disclosure';
import type {AssistantClarificationSlot} from '../lib/ai/assistant-answer-plan';

export const ASSISTANT_CONVERSATION_LIMITS=Object.freeze({humanAnswer:500,history:8000});
export type OwnAssistantClarification=Readonly<{originalQuestion:string;slot:AssistantClarificationSlot;answer:string}>;
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
  return Object.freeze({originalQuestion:row.question,slot:proof.plan.slot,answer});
 });}catch{return refuse();}
}
