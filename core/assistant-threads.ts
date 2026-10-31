/** Saved chats are owned retained exchanges, never a second transcript or provider history store.
 * V3 receipts authenticate grouping/scope. Display pagination and six-turn intent context are separate. */
import {and,desc,eq,isNull,lt,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {assistantExchange} from '../db/schema';
import {assertAiPrincipalTx} from './ai-principal';
import {mayUseAssistant} from './assistant-grant';
import {resolveEntitlementsTx} from './entitlements';
import {boundNativeOutcomeTransactionTx} from './module-native-outcome-bounds';
import {assistantConversationScopeDigest,resumeOwnAssistantConversation} from './assistant-conversation-context';
import {openAssistantAnswerDisclosure} from '../lib/ai/assistant-disclosure';
import {decryptSecret,encryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {withAssistantReadTx} from './assistant-read-session';
import {workspaceGroundedAnswers} from './workspace-grounded-answers';
export const ASSISTANT_THREAD_LIMITS=Object.freeze({chats:20,scan:100,turns:50});
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export class AssistantThreadError extends Error{constructor(){super('Saved chat unavailable.');this.name='AssistantThreadError';}}
const refuse=():never=>{throw new AssistantThreadError();};
const capturedContext=(ctx:SessionContext)=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(row=>({...row}))});
function validateScope(ctx:SessionContext,scope:string){if(!ctx.userId||typeof scope!=='string'||scope.length>4096)return refuse();return assistantConversationScopeDigest(ctx,scope);}
async function authorize(tx:Tx,ctx:SessionContext){await tx.execute(sql`SET TRANSACTION READ ONLY`);await boundNativeOutcomeTransactionTx(tx);await assertAiPrincipalTx(tx,ctx);const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};if(!(await mayUseAssistant(fresh,tx)).allowed)return refuse();return fresh;}
const fields={id:assistantExchange.id,question:assistantExchange.question,answer:assistantExchange.answer,receipt:assistantExchange.disclosureReceipt,continues:assistantExchange.continuesExchangeId,askedAt:assistantExchange.askedAt,stop:assistantExchange.stop,hitTurnCap:assistantExchange.hitTurnCap,error:assistantExchange.error};
type Row={id:string;question:string;answer:string|null;receipt:string|null;continues:string|null;askedAt:Date;stop:string|null;hitTurnCap:boolean;error:string|null};
const owned=(ctx:SessionContext)=>and(eq(assistantExchange.tenantId,ctx.tenantId),eq(assistantExchange.appUserId,ctx.userId!),isNull(assistantExchange.contentRetiredAt),sql`${assistantExchange.askedAt}>clock_timestamp()-interval '30 days'`);
const proofFor=(ctx:SessionContext,row:Row)=>row.answer?openAssistantAnswerDisclosure({tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt):null;
const title=(question:string)=>question.replace(/\s+/g,' ').trim().slice(0,100);
type ListCursor={askedAt:string;id:string};
function listCursor(value:unknown):ListCursor|null{if(value===undefined||value===null)return null;if(typeof value!=='string'||value.length>256)return refuse();try{const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(!parsed||Object.keys(parsed).sort().join(',')!=='askedAt,id'||!uuid(parsed.id)||typeof parsed.askedAt!=='string'||new Date(parsed.askedAt).toISOString()!==parsed.askedAt)return refuse();return parsed;}catch{return refuse();}}
const encodeListCursor=(row:Row)=>Buffer.from(JSON.stringify({askedAt:row.askedAt.toISOString(),id:row.id})).toString('base64url');
export type OwnAssistantChatSummary=Readonly<{threadId:string;exchangeId:string;title:string;updatedAt:Date;resumable:boolean}>;
/** A page scans at most 100 retained own exchanges and returns distinct authenticated chats. A long
 * chat can occupy a scan page: nextCursor preserves progress and clients deduplicate thread IDs. */
export async function listOwnAssistantChats(supplied:SessionContext,options:{cursor?:string;limit?:number}={},conversationScope='assistant-service'){
 const ctx=capturedContext(supplied),scopeDigest=validateScope(ctx,conversationScope),cursor=listCursor(options.cursor),limit=options.limit??ASSISTANT_THREAD_LIMITS.chats;
 if(!Number.isInteger(limit)||limit<1||limit>ASSISTANT_THREAD_LIMITS.chats)return refuse();
 try{return await withTenant(ctx,async tx=>{await authorize(tx,ctx);
  const rows=await tx.select(fields).from(assistantExchange).where(and(owned(ctx),cursor?or(lt(assistantExchange.askedAt,new Date(cursor.askedAt)),and(eq(assistantExchange.askedAt,new Date(cursor.askedAt)),lt(assistantExchange.id,cursor.id))):undefined)).orderBy(desc(assistantExchange.askedAt),desc(assistantExchange.id)).limit(ASSISTANT_THREAD_LIMITS.scan);
  const chats:OwnAssistantChatSummary[]=[],seen=new Set<string>();let last:Row|undefined;
  for(const row of rows){last=row;const proof=proofFor(ctx,row);if(proof?.thread&&proof.thread.scopeDigest!==scopeDigest)continue;
   const threadId=proof?.thread?.threadId??row.id;if(seen.has(threadId))continue;seen.add(threadId);
   let label=title(row.question);
   if(proof?.thread&&threadId!==row.id){const [root]=await tx.select(fields).from(assistantExchange).where(and(owned(ctx),eq(assistantExchange.id,threadId))).limit(1);const rootProof=root?proofFor(ctx,root):null;if(root&&rootProof?.thread?.threadId===threadId&&rootProof.thread.scopeDigest===scopeDigest)label=title(root.question);}
   chats.push(Object.freeze({threadId,exchangeId:row.id,title:label,updatedAt:row.askedAt,resumable:Boolean(proof?.thread&&proof.plan&&row.stop==='end'&&!row.error)}));
   if(chats.length===limit)break;
  }
  return Object.freeze({chats:Object.freeze(chats),scopeDigest,nextCursor:last&&(rows.length===ASSISTANT_THREAD_LIMITS.scan||last.id!==rows.at(-1)?.id)?encodeListCursor(last):null});
 });}catch{return refuse();}
}
const pageAad=(ctx:SessionContext,tail:string,scopeDigest:string)=>JSON.stringify(['ai-hr.assistant-thread-page.v1',ctx.tenantId,ctx.userId,tail,scopeDigest]);
function openPage(ctx:SessionContext,tail:string,scopeDigest:string,value:unknown):string|null{if(value===undefined||value===null)return null;try{if(!isSecretStorable()||typeof value!=='string'||value.length>4096)return refuse();const parsed=JSON.parse(decryptSecret(value,pageAad(ctx,tail,scopeDigest)));if(!parsed||Object.keys(parsed).join(',')!=='nextId'||!uuid(parsed.nextId))return refuse();return parsed.nextId;}catch{return refuse();}}
/** Selected exchange owns the branch. Earlier-page cursors are bound to that exact tail and scope,
 * so another concurrent leaf cannot be substituted as an earlier page. Legacy rows stay view-only. */
export async function loadOwnAssistantChat(supplied:SessionContext,options:{exchangeId:string;before?:string;limit?:number},conversationScope='assistant-service'){
 const ctx=capturedContext(supplied),scopeDigest=validateScope(ctx,conversationScope),limit=options.limit??ASSISTANT_THREAD_LIMITS.turns;
 if(!uuid(options.exchangeId)||!Number.isInteger(limit)||limit<1||limit>ASSISTANT_THREAD_LIMITS.turns)return refuse();
 const from=openPage(ctx,options.exchangeId,scopeDigest,options.before);
 try{
  const page=await withTenant(ctx,async tx=>{const fresh=await authorize(tx,ctx);
   const get=async(id:string)=>(await tx.select(fields).from(assistantExchange).where(and(owned(ctx),eq(assistantExchange.id,id))).limit(1))[0];
   const tail=await get(options.exchangeId);if(!tail)return refuse();const tailProof=proofFor(ctx,tail),metadata=tailProof?.thread;
   if(metadata&&metadata.scopeDigest!==scopeDigest)return refuse();if(from&&!metadata)return refuse();
   const rows:Row[]=[],seen=new Set<string>();let next:string|null=from??tail.id,olderUnavailable=false;
   while(next&&rows.length<limit&&!seen.has(next)){
    const row=next===tail.id?tail:await get(next);if(!row){olderUnavailable=true;next=null;break;}
    const proof=proofFor(ctx,row);
    if(metadata&&(!proof?.thread||proof.thread.scopeDigest!==scopeDigest||proof.thread.threadId!==metadata.threadId)){olderUnavailable=true;next=null;break;}
    rows.push(row);seen.add(row.id);next=metadata?row.continues:null;
   }
   // Probe the next row without rendering it, so an expired parent never produces a dead continuation.
   if(next){const prior=await get(next),priorProof=prior?proofFor(ctx,prior):null;if(!prior||!priorProof?.thread||priorProof.thread.scopeDigest!==scopeDigest||priorProof.thread.threadId!==metadata?.threadId||seen.has(next)){olderUnavailable=true;next=null;}}
   const olderCursor=next?encryptSecret(JSON.stringify({nextId:next}),pageAad(ctx,tail.id,scopeDigest)):null;
   // Traversal follows the selected branch from tail to parent. Those immutable links own display
   // order even when timestamps tie or skew; random UUID order must never reorder a conversation.
   rows.reverse();
   const turns=await withAssistantReadTx(fresh,tx,async session=>{const replay=workspaceGroundedAnswers(fresh,session,tx);const turns=[];
    for(const row of rows){const grounded=row.answer?await replay({tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:row.id,question:row.question,answer:row.answer},row.receipt):null;
     turns.push({id:row.id,question:row.question,answer:null,hasAnswer:Boolean(row.answer),grounded,answerVisibility:row.answer?((grounded?.mode==='grounded'||grounded?.conversation)?'current' as const:'unavailable' as const):'none' as const,stop:row.stop,hitTurnCap:row.hitTurnCap,askedAt:row.askedAt,toolCalls:(grounded?.tools??[]).map(name=>({name})),error:row.error});
    }return turns;});
   return {threadId:metadata?.threadId??tail.id,turns,olderCursor,olderUnavailable,scopeDigest};
  });
  // Resume is a separate fresh owner check, after the display read. A failure never silently selects
  // an earlier successful leaf or manufactures scope for a legacy/failed exchange.
  const resume=await resumeOwnAssistantConversation(ctx,options.exchangeId,conversationScope).catch(()=>null);
  return Object.freeze({...page,turns:Object.freeze(page.turns),resume});
 }catch{return refuse();}
}
