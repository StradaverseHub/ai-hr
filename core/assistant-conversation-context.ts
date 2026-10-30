/** Ordinary chat continuation carries human intent only. Every earlier question remains owned by its
 * original exchange and 30-day deadline; prior answers and HR reads never become current evidence. */
import {createHash} from 'node:crypto';
import {decryptSecret,encryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assistantExchange} from '../db/schema';
import {assertAiPrincipalTx} from './ai-principal';
import {mayUseAssistant} from './assistant-grant';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {resolveEntitlementsTx} from './entitlements';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';

export const ASSISTANT_CHAT_CONTEXT_LIMITS=Object.freeze({exchanges:6,characters:8000,question:2000});
export type OwnAssistantConversationContext=Readonly<{questions:readonly string[]}>;
type SourceRow=Readonly<{id:string;question:string}>;
type Source=Readonly<{tenantId:string;userId:string;exchangeId:string;rows:readonly SourceRow[];conversationScope:string;principal:string}>;
const sources=new WeakMap<object,Source>();
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const scope=(ctx:SessionContext,conversationScope='assistant-service')=>createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,ctx.roles??null,ctx.grants??null,conversationScope])).digest('hex');
const aad=(ctx:SessionContext)=>JSON.stringify(['ai-hr.assistant-chat-context.v1',ctx.tenantId,ctx.userId]);
/** Exchange rows predate a stored scope snapshot. Only this opaque in-memory-client token proves that
 * linked ordinary turns were made under the same principal. Legacy history can display but starts a
 * new chat; a company/employment UI-filter switch must likewise discard the client token. */
function openConversationToken(ctx:SessionContext,id:string,token:unknown,conversationScope:string):readonly string[]{
 try{
  if(!isSecretStorable()||typeof token!=='string'||token.length>4096||!/^[A-Za-z0-9_-]+$/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)return unavailable();
  const proof:unknown=JSON.parse(decryptSecret(token,aad(ctx)));
  if(!proof||typeof proof!=='object'||Array.isArray(proof))return unavailable();
  const value=proof as Record<string,unknown>,ids=value.exchanges;
  if(Object.keys(value).length!==3||value.version!==1||value.scope!==scope(ctx,conversationScope)||!Array.isArray(ids)||ids.length<1||ids.length>ASSISTANT_CHAT_CONTEXT_LIMITS.exchanges||!ids.every(uuid)||new Set(ids).size!==ids.length||ids.at(-1)!==id)return unavailable();
  return Object.freeze(ids.slice());
 }catch{return unavailable();}
}
/** Called only after the actual new exchange has committed. The token authenticates row identities
 * and the calling scope, contains no human content, and grants no tool or business-write authority. */
export function issueAssistantConversationToken(ctx:SessionContext,id:string,context:OwnAssistantConversationContext|null=null,conversationScope='assistant-service'):string|undefined{
 try{
  if(!ctx.userId||!uuid(id)||typeof conversationScope!=='string'||conversationScope.length>4096||!isSecretStorable())return undefined;
  const source=context===null?null:sources.get(context);
  if(context!==null&&(!source||source.tenantId!==ctx.tenantId||source.userId!==ctx.userId||source.conversationScope!==conversationScope||source.principal!==scope(ctx,conversationScope)))return undefined;
  const exchanges=[...(source?.rows.map(row=>row.id)??[]),id].slice(-ASSISTANT_CHAT_CONTEXT_LIMITS.exchanges);
  return encryptSecret(JSON.stringify({version:1,scope:scope(ctx,conversationScope),exchanges}),aad(ctx));
 }catch{return undefined;}
}
export class AssistantConversationContextError extends Error {
 constructor(){super('Current conversation unavailable.');this.name='AssistantConversationContextError';}
}
const unavailable=():never=>{throw new AssistantConversationContextError();};
export function assistantConversationSourceExchangeId(context:OwnAssistantConversationContext|null):string|null{
 return context===null?null:sources.get(context)?.exchangeId??null;
}

/** The caller supplies an exchange identity, never the contents of previous messages. The existing
 * immutable same-login link owns ordering. An unavailable linked row refuses the continuation; an
 * explicit depth/size bound keeps only the recent suffix, without truncating any question's text. */
export async function ownAssistantConversationContext(supplied:SessionContext,exchangeId:unknown,question:unknown,token:unknown,conversationScope='assistant-service'):Promise<OwnAssistantConversationContext>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 const id=exchangeId,current=typeof question==='string'?question.trim():null;
 if(!ctx.userId||!uuid(id)||typeof conversationScope!=='string'||conversationScope.length>4096||!current||current.length>ASSISTANT_CHAT_CONTEXT_LIMITS.question)return unavailable();
 const userId=ctx.userId,ids=openConversationToken(ctx,id,token,conversationScope);
 try{return await withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);
  await boundNativeOutcomeTransactionTx(tx);
  await assertAiPrincipalTx(tx,ctx);
  const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
  if(!(await mayUseAssistant(fresh,tx)).allowed)return unavailable();
  const rows:SourceRow[]=[];let used=current.length;
  for(let index=ids.length-1;index>=0;index--){
   const next=ids[index]!;
   const [row]=await tx.select({id:assistantExchange.id,question:assistantExchange.question,continues:assistantExchange.continuesExchangeId})
    .from(assistantExchange).where(and(eq(assistantExchange.id,next),eq(assistantExchange.tenantId,ctx.tenantId),eq(assistantExchange.appUserId,userId),
     isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
   if(!row?.question?.trim()||(index>0&&row.continues!==ids[index-1]))return unavailable();
   if(used+row.question.length+2>ASSISTANT_CHAT_CONTEXT_LIMITS.characters){if(rows.length===0)return unavailable();break;}
   rows.unshift(Object.freeze({id:row.id,question:row.question}));used+=row.question.length+2;
  }
  const issued:OwnAssistantConversationContext=Object.freeze({questions:Object.freeze(rows.map(row=>row.question))});
  sources.set(issued,Object.freeze({tenantId:ctx.tenantId,userId,exchangeId:id,rows:Object.freeze(rows),conversationScope,principal:scope(ctx,conversationScope)}));
  return issued;
 });}catch{return unavailable();}
}

/** Same access interval as history erasure. The strategy owner calls this in its marker transaction,
 * and every provider admission. Copied objects have no authority. */
export async function assertOwnAssistantConversationContextCurrentTx(tx:Tx,ctx:SessionContext,context:OwnAssistantConversationContext):Promise<void>{
 const source=sources.get(context);
 if(!source||source.tenantId!==ctx.tenantId||source.userId!==ctx.userId||source.principal!==scope(ctx,source.conversationScope))return unavailable();
 let current=false;
 try{
  await lockAccessConfigurationTx(tx,source.tenantId);
  const found=await tx.select({id:assistantExchange.id,question:assistantExchange.question}).from(assistantExchange)
   .where(and(inArray(assistantExchange.id,source.rows.map(row=>row.id)),eq(assistantExchange.tenantId,source.tenantId),eq(assistantExchange.appUserId,source.userId),
    isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`));
  const byId=new Map(found.map(row=>[row.id,row.question]));
  current=source.rows.length>0&&source.rows.every((row,index)=>byId.get(row.id)===row.question&&context.questions[index]===row.question)&&context.questions.length===source.rows.length;
 }catch{/* A database failure is never current source authority. */}
 if(!current)return unavailable();
}
