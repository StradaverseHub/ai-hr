/** Ordinary chat continuation carries human intent only. Every earlier question remains owned by its
 * original exchange and 30-day deadline; prior answers and HR reads never become current evidence. */
import {createHash} from 'node:crypto';
import {openAssistantAnswerDisclosure,type AssistantThreadMetadata} from '../lib/ai/assistant-disclosure';
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
type SourceRow=Readonly<{id:string;question:string;answer?:string;receipt?:string}>;
type Source=Readonly<{tenantId:string;userId:string;exchangeId:string;rows:readonly SourceRow[];conversationScope:string;principal:string;threadId?:string}>;
const sources=new WeakMap<object,Source>();
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const assistantConversationScopeDigest=(ctx:SessionContext,conversationScope='assistant-service')=>createHash('sha256').update(JSON.stringify([ctx.tenantId,ctx.userId,ctx.personId??null,ctx.roles??null,ctx.grants??null,conversationScope])).digest('hex');
const scope=assistantConversationScopeDigest;
const aad=(ctx:SessionContext)=>JSON.stringify(['ai-hr.assistant-chat-context.v1',ctx.tenantId,ctx.userId]);
/** Ordinary requests still require this opaque client token. Legacy rows have no stored scope and
 * remain view-only after reload; v3 saved rows can obtain a fresh token only through the owner resume
 * operation below. A company/employment filter switch must discard the client token. */
function openConversationToken(ctx:SessionContext,id:string,token:unknown,conversationScope:string):readonly string[]{
 try{
  if(!isSecretStorable()||typeof token!=='string'||token.length>4096||!/^[A-Za-z0-9_-]+$/.test(token)||Buffer.from(token,'base64url').toString('base64url')!==token)return unavailable();
  const proof:unknown=JSON.parse(decryptSecret(token,aad(ctx)));
  if(!proof||typeof proof!=='object'||Array.isArray(proof))return unavailable();
  const value=proof as Record<string,unknown>,ids=value.exchanges;
  if(Object.keys(value).length!==3||value.version!==1||value.scope!==assistantConversationScopeDigest(ctx,conversationScope)||!Array.isArray(ids)||ids.length<1||ids.length>ASSISTANT_CHAT_CONTEXT_LIMITS.exchanges||!ids.every(uuid)||new Set(ids).size!==ids.length||ids.at(-1)!==id)return unavailable();
  return Object.freeze(ids.slice());
 }catch{return unavailable();}
}
/** Called only after the actual new exchange has committed. The token authenticates row identities
 * and the calling scope, contains no human content, and grants no tool or business-write authority. */
export function issueAssistantConversationToken(ctx:SessionContext,id:string,context:OwnAssistantConversationContext|null=null,conversationScope='assistant-service'):string|undefined{
 try{
  if(!ctx.userId||!uuid(id)||typeof conversationScope!=='string'||conversationScope.length>4096||!isSecretStorable())return undefined;
  const source=context===null?null:sources.get(context);
  if(context!==null&&(!source||source.tenantId!==ctx.tenantId||source.userId!==ctx.userId||source.conversationScope!==conversationScope||source.principal!==assistantConversationScopeDigest(ctx,conversationScope)))return undefined;
  const exchanges=[...(source?.rows.map(row=>row.id)??[]),id].slice(-ASSISTANT_CHAT_CONTEXT_LIMITS.exchanges);
  return sealConversationToken(ctx,exchanges,conversationScope);
 }catch{return undefined;}
}
function sealConversationToken(ctx:SessionContext,exchanges:readonly string[],conversationScope:string):string|undefined{
 if(!exchanges.length||exchanges.length>ASSISTANT_CHAT_CONTEXT_LIMITS.exchanges||!exchanges.every(uuid)||new Set(exchanges).size!==exchanges.length||!isSecretStorable())return undefined;
 return encryptSecret(JSON.stringify({version:1,scope:scope(ctx,conversationScope),exchanges}),aad(ctx));
}
/** Only this owner's genuine context may carry durable thread identity into a new committed turn. */
export function assistantConversationThreadId(context:OwnAssistantConversationContext|null):string|undefined{return context===null?undefined:sources.get(context)?.threadId;}
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
  const rows:SourceRow[]=[];let used=current.length;let threadId:string|undefined;
  for(let index=ids.length-1;index>=0;index--){
   const next=ids[index]!;
   const [row]=await tx.select({id:assistantExchange.id,question:assistantExchange.question,continues:assistantExchange.continuesExchangeId,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt})
    .from(assistantExchange).where(and(eq(assistantExchange.id,next),eq(assistantExchange.tenantId,ctx.tenantId),eq(assistantExchange.appUserId,userId),
     isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
   if(!row?.question?.trim()||(index>0&&row.continues!==ids[index-1]))return unavailable();
   if(used+row.question.length+2>ASSISTANT_CHAT_CONTEXT_LIMITS.characters){if(rows.length===0)return unavailable();break;}
   const proof=row.answer?openAssistantAnswerDisclosure({tenantId:ctx.tenantId,userId,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt):null;
   if(index===ids.length-1&&proof?.thread?.scopeDigest===scope(ctx,conversationScope))threadId=proof.thread.threadId;
   rows.unshift(Object.freeze({id:row.id,question:row.question,...(proof?.thread&&row.answer&&row.receipt?{answer:row.answer,receipt:row.receipt}:{})}));used+=row.question.length+2;
  }
  const issued:OwnAssistantConversationContext=Object.freeze({questions:Object.freeze(rows.map(row=>row.question))});
  sources.set(issued,Object.freeze({tenantId:ctx.tenantId,userId,exchangeId:id,rows:Object.freeze(rows),conversationScope,principal:assistantConversationScopeDigest(ctx,conversationScope),...(threadId?{threadId}:{})}));
  return issued;
 });}catch{return unavailable();}
}

/** Same access interval as history erasure. The strategy owner calls this in its marker transaction,
 * and every provider admission. Copied objects have no authority. */
export async function assertOwnAssistantConversationContextCurrentTx(tx:Tx,ctx:SessionContext,context:OwnAssistantConversationContext):Promise<void>{
 const source=sources.get(context);
 if(!source||source.tenantId!==ctx.tenantId||source.userId!==ctx.userId||source.principal!==assistantConversationScopeDigest(ctx,source.conversationScope))return unavailable();
 let current=false;
 try{
  await lockAccessConfigurationTx(tx,source.tenantId);
  const found=await tx.select({id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt}).from(assistantExchange)
   .where(and(inArray(assistantExchange.id,source.rows.map(row=>row.id)),eq(assistantExchange.tenantId,source.tenantId),eq(assistantExchange.appUserId,source.userId),
    isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`));
  const byId=new Map(found.map(row=>[row.id,row]));
  current=source.rows.length>0&&source.rows.every((row,index)=>{const current=byId.get(row.id);return current?.question===row.question&&context.questions[index]===row.question&&(row.receipt===undefined||(current.answer===row.answer&&current.receipt===row.receipt));})&&context.questions.length===source.rows.length;
 }catch{/* A database failure is never current source authority. */}
 if(!current)return unavailable();
}

/** Resume is a fresh own-row read. The durable receipt supplies scope proof, never a stored token.
 * Only the selected branch's recent whole-question suffix is issued; historical answers stay local. */
export async function resumeOwnAssistantConversation(supplied:SessionContext,exchangeId:unknown,conversationScope='assistant-service'):Promise<Readonly<{exchangeId:string;conversationToken:string;threadId:string;scopeDigest:string}>>{
 const ctx={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(row=>({...row}))};
 if(!ctx.userId||!uuid(exchangeId)||typeof conversationScope!=='string'||conversationScope.length>4096)return unavailable();
 const userId=ctx.userId,scopeDigest=scope(ctx,conversationScope);
 try{return await withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);
  const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};if(!(await mayUseAssistant(fresh,tx)).allowed)return unavailable();
  const rows:SourceRow[]=[];let next:string|null=exchangeId,thread:AssistantThreadMetadata|undefined,used=ASSISTANT_CHAT_CONTEXT_LIMITS.question;
  const seen=new Set<string>();
  while(next&&rows.length<ASSISTANT_CHAT_CONTEXT_LIMITS.exchanges&&!seen.has(next)){
   const [row]=await tx.select({id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt,continues:assistantExchange.continuesExchangeId,stop:assistantExchange.stop,error:assistantExchange.error})
    .from(assistantExchange).where(and(eq(assistantExchange.id,next),eq(assistantExchange.tenantId,ctx.tenantId),eq(assistantExchange.appUserId,userId),isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`)).limit(1);
   const proof=row?.answer?openAssistantAnswerDisclosure({tenantId:ctx.tenantId,userId,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt):null;
   const valid=row?.question?.trim()&&row.stop==='end'&&!row.error&&proof?.plan!==null&&proof?.plan!==undefined&&proof.thread?.scopeDigest===scopeDigest&&(!thread||proof.thread.threadId===thread.threadId);
   if(!valid){if(!rows.length)return unavailable();break;}
   if(used+row!.question.length+2>ASSISTANT_CHAT_CONTEXT_LIMITS.characters)break;
   thread=proof!.thread!;seen.add(row!.id);used+=row!.question.length+2;
   rows.unshift(Object.freeze({id:row!.id,question:row!.question,answer:row!.answer!,receipt:row!.receipt!}));next=row!.continues;
  }
  if(!thread||!rows.length)return unavailable();
  const issued:OwnAssistantConversationContext=Object.freeze({questions:Object.freeze(rows.map(row=>row.question))});
  sources.set(issued,Object.freeze({tenantId:ctx.tenantId,userId,exchangeId,rows:Object.freeze(rows),conversationScope,principal:scopeDigest,threadId:thread.threadId}));
  await assertOwnAssistantConversationContextCurrentTx(tx,ctx,issued);
  const conversationToken=sealConversationToken(ctx,rows.map(row=>row.id),conversationScope);if(!conversationToken)return unavailable();
  return Object.freeze({exchangeId,conversationToken,threadId:thread.threadId,scopeDigest});
 });}catch{return unavailable();}
}
