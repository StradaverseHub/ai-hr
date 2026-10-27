/** A clarification continues only the actual caller's authenticated exchange. Historical model prose
 * and source rows are never reused as authority or copied into the next provider request. */
import {eq,and,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {assistantExchange} from '../db/schema';
import {assertAiPrincipalTx} from './ai-principal';
import {mayUseAssistant} from './assistant-grant';
import {resolveEntitlementsTx} from './entitlements';
import {openAssistantAnswerDisclosure} from '../lib/ai/assistant-disclosure';

export class AssistantClarificationError extends Error { constructor(){super('Current clarification unavailable.');this.name='AssistantClarificationError';} }

export async function ownAssistantClarificationQuestion(ctx:SessionContext,exchangeId:unknown,response:unknown):Promise<string>{
 const captured={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};
 const id=exchangeId,answer=typeof response==='string'?response.trim():null;
 const refuse=():never=>{throw new AssistantClarificationError();};
 if(!captured.userId||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||!answer||answer.length>500)return refuse();
 const userId=captured.userId;
 return withTenant(captured,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
  await assertAiPrincipalTx(tx,captured);
  const fresh={...captured,entitlements:await resolveEntitlementsTx(tx,captured.tenantId)};
  if(!(await mayUseAssistant(fresh,tx)).allowed)return refuse();
  const [row]=await tx.select({id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt})
   .from(assistantExchange).where(and(eq(assistantExchange.id,id),eq(assistantExchange.appUserId,userId))).limit(1);
  if(!row?.answer)return refuse();
  const proof=openAssistantAnswerDisclosure({tenantId:captured.tenantId,userId,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt);
  if(proof?.plan?.mode!=='clarify')return refuse();
  // Both text fields were human supplied. The authenticated slot is context, never an effect argument
  // or a source capability. The next real model turn must freshly query canonical tools as usual.
  const question=JSON.stringify({originalQuestion:row.question,humanClarification:{slot:proof.plan.slot,answer}});
  if(question.length>2000)return refuse();
  return question;
 });
}
