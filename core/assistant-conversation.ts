/** Shared Home/AI session conversation. Never accepts an actor, scope or source facts from a client. */
import {and,desc,eq,isNull,sql} from 'drizzle-orm';
import {withTenant,type Tx} from '../db/client';
import * as schema from '../db/schema';
import {resolveAssistantSession,type AssistantSession} from '../lib/assistant-session';
import {resolveEntitlementsTx} from './entitlements';
import {mayUseAssistantTx} from './assistant-grant';
import {AssistantConversationError,assistantScopeFingerprint,assistantConversationId,assistantCapabilityReply,CONVERSATION_LIMITS,type AssistantCapabilityReply} from '../lib/assistant-conversation-model';

export type ConversationIdentity=AssistantSession&{authorityStamp:string};
export type ConversationView={id:string;revision:number;messages:{id:string;question:string;reply:AssistantCapabilityReply}[]};
/** Resolve the actual module/grant owner freshly in the same scoped transaction as the opaque
 * stamp. Report/notification entitlement is deliberately irrelevant to basic conversation. */
export async function conversationAuthorityTx(tx:Tx,session:AssistantSession):Promise<ConversationIdentity>{
 const ctx={...session.ctx,entitlements:await resolveEntitlementsTx(tx,session.ctx.tenantId),entitlementsExempt:undefined,entitlementsError:undefined};
 if(!(await mayUseAssistantTx(tx,ctx)).allowed)throw new AssistantConversationError('unavailable');
 const [row]=await tx.execute(sql`select app.assistant_authority_stamp(${session.scopeIds}::uuid[]) value`);
 const authorityStamp=assistantScopeFingerprint.parse((row as {value?:unknown})?.value);
 return {...session,ctx,authorityStamp};
}
export async function freshConversationIdentity():Promise<ConversationIdentity>{
 const session=await resolveAssistantSession();return withTenant(session.ctx,tx=>conversationAuthorityTx(tx,session));
}
export async function assertSameConversationIdentity(expected:ConversationIdentity):Promise<ConversationIdentity>{
 const current=await freshConversationIdentity();
 if(current.ctx.tenantId!==expected.ctx.tenantId||current.ctx.userId!==expected.ctx.userId||current.ctx.personId!==expected.ctx.personId||current.signInHash!==expected.signInHash||current.authorityStamp!==expected.authorityStamp||JSON.stringify(current.scopeIds)!==JSON.stringify(expected.scopeIds))throw new AssistantConversationError('scopeChanged');
 return current;
}
async function invalidateTx(tx:Tx,id:string){
 await tx.update(schema.assistantConversation).set({invalidatedAt:sql`now()`}).where(and(eq(schema.assistantConversation.id,id),isNull(schema.assistantConversation.invalidatedAt)));
 await tx.update(schema.assistantConfirmation).set({status:'refused'}).where(and(eq(schema.assistantConfirmation.conversationId,id),eq(schema.assistantConfirmation.status,'awaiting')));
}
export async function readConversationTx(tx:Tx,identity:ConversationIdentity,id:string,lock=false){
 assistantConversationId.parse(id);
 const query=tx.select().from(schema.assistantConversation).where(and(eq(schema.assistantConversation.id,id),eq(schema.assistantConversation.appUserId,identity.ctx.userId!),eq(schema.assistantConversation.tenantId,identity.ctx.tenantId))).limit(1);
 const [row]=await (lock?query.for('update'):query);
 if(!row)throw new AssistantConversationError('notFound');
 if(row.invalidatedAt||row.expiresAt.getTime()<=Date.now()||row.signInHash!==identity.signInHash||row.authorityStamp!==identity.authorityStamp||JSON.stringify(row.companyIds)!==JSON.stringify(identity.scopeIds)){
  await invalidateTx(tx,row.id);return null;
 }
 return row;
}
async function viewTx(tx:Tx,row:typeof schema.assistantConversation.$inferSelect):Promise<ConversationView>{
 const turns=await tx.select({id:schema.assistantExchange.id,question:schema.assistantExchange.question,answer:schema.assistantExchange.answer}).from(schema.assistantConversationTurn)
  .innerJoin(schema.assistantExchange,eq(schema.assistantExchange.id,schema.assistantConversationTurn.exchangeId))
  .where(eq(schema.assistantConversationTurn.conversationId,row.id)).orderBy(desc(schema.assistantConversationTurn.revision)).limit(CONVERSATION_LIMITS.historyTurns);
 const messages:ConversationView['messages']=[];let characters=0;
 for(const turn of turns){let reply:AssistantCapabilityReply;try{reply=assistantCapabilityReply.parse(JSON.parse(turn.answer??''));}catch{continue;}characters+=turn.question.length+reply.text.length;if(characters>CONVERSATION_LIMITS.historyChars)break;messages.push({id:turn.id,question:turn.question,reply});}
 return {id:row.id,revision:row.revision,messages:messages.reverse()};
}
export async function startAssistantConversation():Promise<ConversationView>{
 const session=await resolveAssistantSession();
 return withTenant(session.ctx,async tx=>{
  const identity=await conversationAuthorityTx(tx,session);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['assistant-session-v1',session.ctx.tenantId,session.ctx.userId,session.signInHash])},0))`);
  const [existing]=await tx.select().from(schema.assistantConversation).where(and(eq(schema.assistantConversation.appUserId,session.ctx.userId!),eq(schema.assistantConversation.signInHash,session.signInHash),isNull(schema.assistantConversation.invalidatedAt))).limit(1).for('update');
  if(existing){const valid=await readConversationTx(tx,identity,existing.id);if(valid)return viewTx(tx,valid);}
  const [row]=await tx.insert(schema.assistantConversation).values({tenantId:session.ctx.tenantId,appUserId:session.ctx.userId!,signInHash:session.signInHash,authorityStamp:identity.authorityStamp,companyIds:identity.scopeIds}).returning();
  return viewTx(tx,row!);
 });
}
/** Deterministic capabilities share the existing audit, never a second transcript or usage ledger. */
export async function recordConversationReplyTx(tx:Tx,identity:ConversationIdentity,question:string,raw:unknown){
 const reply=assistantCapabilityReply.parse(raw);
 const [exchange]=await tx.insert(schema.assistantExchange).values({tenantId:identity.ctx.tenantId,appUserId:identity.ctx.userId!,question,answer:JSON.stringify(reply),stop:'end',toolCalls:[],turnCount:0}).returning({id:schema.assistantExchange.id});
 return {exchangeId:exchange!.id,reply};
}
