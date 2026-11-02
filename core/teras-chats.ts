/** AI Centre issue 8 — stored chats: one Noveri conversation per row, its turns encrypted, removed on the tenant's
 * "Keep chats for" schedule (migration 0952). Issue 18 item 1: the floating panel and Ask write and reopen the same
 * stored chat, keyed by the conversation id (core/teras-wiring/history.ts), so a chat started in the panel continues
 * in Ask.
 *
 * What is stored, per turn: the person's words, the reply they were shown and the turn's model-side rows (the only
 * history a later turn accepts), each AES-256-GCM encrypted (lib/ai/crypto.ts) with additional data binding tenant,
 * login, chat, sequence and field, so a ciphertext copied to another tenant, login, chat, turn or column fails. A turn
 * the pre-read gate routed or refused stores no words: only withheld=true. Without the encryption secret nothing is
 * stored; plaintext is never written.
 *
 * Who reads: the login only, by forced row-level security. Listing and reopening also re-authorise the caller (current
 * AI principal, Assistant module and grant, from fresh entitlements) and require the scope the chat started under
 * (assistantConversationScopeDigest: tenant, login, person, roles, grants, company scope). A chat from another scope or
 * role is neither listed nor reopened: the person starts a new chat, as for saved closed-grammar chats
 * (core/assistant-threads.ts). Deleting one's own chats needs no grant, like own transcript erasure.
 *
 * Nothing here calls a model, reads an HR record or decides anything: storage only. The wiring (app/assistant/
 * launcher-actions.ts) turns a reopened chat's model rows into a signed continuation. */
import {sql,type SQL} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {isGroupAdmin} from '../lib/authz-model';
import {decryptSecret,encryptSecret,isSecretStorable} from '../lib/ai/crypto';
import {assertAiPrincipalTx} from './ai-principal';
import {mayUseAssistant} from './assistant-grant';
import {assistantConversationScopeDigest} from './assistant-conversation-context';
import {resolveEntitlementsTx} from './entitlements';

/** The owner's list (3 November 2026): 1, 7, 30, 90, 180 or 365 days; 30 when the tenant has chosen nothing. */
export const CHAT_KEEP_DAYS=Object.freeze([1,7,30,90,180,365] as const);
export type ChatKeepDays=typeof CHAT_KEEP_DAYS[number];
export const DEFAULT_CHAT_KEEP_DAYS:ChatKeepDays=30;
export const CHAT_LIMITS=Object.freeze({
 /** Chats per list page. */
 chats:20,
 /** Turns a reopened chat shows, newest last. */
 turns:50,
 /** Turns one chat holds (the 0952 CHECK). */
 maxTurns:500,
 /** Model-side messages sent back as history: core/teras-wiring/history.ts MAX_HISTORY_MESSAGES. */
 historyMessages:24,
 /** Characters kept per model-side message: core/teras-wiring/history.ts MAX_MESSAGE_CHARS. */
 messageChars:8000,
 questionChars:2000,
 replyChars:24000,
});

export class ChatUnavailable extends Error{constructor(){super('Stored chat unavailable.');this.name='ChatUnavailable';}}
export class ChatRetentionRefused extends Error{constructor(readonly reason:'not_administrator'|'invalid'){super('Chat retention refused: '+reason);this.name='ChatRetentionRefused';}}
const refuse=():never=>{throw new ChatUnavailable();};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const captured=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))});
const own=(ctx:SessionContext):ctx is SessionContext&{userId:string}=>Boolean(ctx.userId)&&!ctx.agent;
const iso=(value:unknown):Date=>{const at=new Date(String(value));return Number.isFinite(at.getTime())?at:refuse();};
const AT_SQL=(column:SQL)=>sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type Field='question'|'reply'|'model';
/** The additional data of one stored field. Exported for the tests' wrong-binding cases. */
export const chatTurnAad=(tenantId:string,userId:string,chatId:string,seq:number,field:Field)=>JSON.stringify(['ai-hr.teras-chat-turn.v1',tenantId,userId,chatId,seq,field]);
const seal=(value:unknown,aad:string)=>encryptSecret(JSON.stringify(value),aad);
const open=(token:unknown,aad:string):unknown=>{if(typeof token!=='string')return refuse();return JSON.parse(decryptSecret(token,aad));};

export type ChatModelRow=Readonly<{role:'user'|'assistant';content:string}>;
export type ChatTurnRecord=Readonly<{
 /** The conversation id the turn ran under (the turn trace's conversationId); it is the chat's id. */
 conversationId:string;
 /** The browser conversation scope the turn ran under (app/assistant/conversation-scope.ts). */
 conversationScope:string;companyId:string;
 question:string;reply:string;modelRows:readonly ChatModelRow[];
 /** The pre-read gate routed or refused the turn: nothing of it but this marker is stored. */
 withheld:boolean}>;

/** Appends one answered turn to the caller's stored chat, starting the chat on its first turn. Returns the chat id, or
 * null when the turn is not stored: no encryption secret, a chat of another scope, an expired or full chat. */
export async function recordChatTurn(supplied:SessionContext,input:ChatTurnRecord):Promise<string|null>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(input.conversationId)||!uuid(input.companyId)||typeof input.conversationScope!=='string'||input.conversationScope.length>4096)return null;
 if(!input.withheld&&(typeof input.question!=='string'||!input.question.trim()||typeof input.reply!=='string'||!Array.isArray(input.modelRows)))return null;
 // Fail closed: no secret, no storage. Never a plaintext fallback.
 if(!isSecretStorable())return null;
 const chatId=input.conversationId,userId=ctx.userId,scopeDigest=assistantConversationScopeDigest(ctx,input.conversationScope);
 const modelRows=input.withheld?[]:input.modelRows.filter(row=>row&&(row.role==='user'||row.role==='assistant')&&typeof row.content==='string')
  .map(row=>({role:row.role,content:row.content.slice(0,CHAT_LIMITS.messageChars)}));
 return withTenant(ctx,async tx=>{
  // The person on the chat is the login's person now, read by the database (the insert policy checks the same).
  await tx.execute(sql`insert into public.teras_chat(id,tenant_id,app_user_id,person_id,company_id,scope_digest)
   values(${chatId}::uuid,${ctx.tenantId}::uuid,${userId}::uuid,
    (select u.person_id from public.app_user u where u.id=${userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid),${input.companyId}::uuid,${scopeDigest})
   on conflict (id) do nothing`);
  // One turn at a time: the counter's row lock orders concurrent turns of one chat. Another login's chat, another
  // scope, an expired chat or a full one is not counted, and the turn is not stored.
  const [chat]=await tx.execute<{turn_count:number}>(sql`update public.teras_chat set turn_count=turn_count+1
   where id=${chatId}::uuid and tenant_id=${ctx.tenantId}::uuid and app_user_id=${userId}::uuid and scope_digest=${scopeDigest}
    and turn_count<${CHAT_LIMITS.maxTurns} and expires_at>now() returning turn_count`);
  if(!chat)return null;
  const seq=chat.turn_count,aad=(field:Field)=>chatTurnAad(ctx.tenantId,userId,chatId,seq,field);
  const words=input.withheld?null:{
   question:seal(input.question.trim().slice(0,CHAT_LIMITS.questionChars),aad('question')),
   reply:seal(input.reply.slice(0,CHAT_LIMITS.replyChars),aad('reply')),
   model:seal(modelRows,aad('model'))};
  await tx.execute(sql`insert into public.teras_chat_turn(tenant_id,app_user_id,chat_id,seq,withheld,question_ciphertext,reply_ciphertext,model_ciphertext)
   values(${ctx.tenantId}::uuid,${userId}::uuid,${chatId}::uuid,${seq},${input.withheld},${words?.question??null},${words?.reply??null},${words?.model??null})`);
  return chatId;
 });
}

/** Current principal, Assistant module and grant, from entitlements resolved in this transaction. */
async function authorizeTx(tx:Tx,ctx:SessionContext):Promise<void>{
 await assertAiPrincipalTx(tx,ctx);
 const fresh={...ctx,entitlements:await resolveEntitlementsTx(tx,ctx.tenantId)};
 if(!(await mayUseAssistant(fresh,tx)).allowed)return refuse();
}

export type OwnChatSummary=Readonly<{chatId:string;
 /** The first stored question, shortened; null when every turn so far was withheld. */
 title:string|null;startedAt:Date;lastMessageAt:Date;expiresAt:Date;turns:number;withheldTurns:number}>;
type ListCursor={at:string;id:string};
function listCursor(value:unknown):ListCursor|null{
 if(value===undefined||value===null)return null;
 if(typeof value!=='string'||value.length>256)return refuse();
 try{const parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as ListCursor;
  if(!parsed||Object.keys(parsed).sort().join(',')!=='at,id'||!uuid(parsed.id)||typeof parsed.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.at))return refuse();
  return parsed;}catch{return refuse();}
}

/** The caller's live chats in the current scope, most recent first. */
export async function listOwnChats(supplied:SessionContext,options:{cursor?:unknown;limit?:number},conversationScope:string):Promise<Readonly<{chats:readonly OwnChatSummary[];nextCursor:string|null}>>{
 const ctx=captured(supplied),limit=options.limit??CHAT_LIMITS.chats;
 if(!own(ctx)||typeof conversationScope!=='string'||conversationScope.length>4096||!Number.isInteger(limit)||limit<1||limit>CHAT_LIMITS.chats)return refuse();
 const cursor=listCursor(options.cursor),userId=ctx.userId,scopeDigest=assistantConversationScopeDigest(ctx,conversationScope);
 try{return await withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);await authorizeTx(tx,ctx);
  const rows=await tx.execute<{id:string;started:string;last:string;expires:string;turns:number;withheld:number;title_seq:number|null;title:string|null}>(sql`
   select c.id,${AT_SQL(sql`c.created_at`)} as started,${AT_SQL(sql`c.last_message_at`)} as last,
    ${AT_SQL(sql`c.expires_at`)} as expires,c.turn_count as turns,
    (select count(*)::int from public.teras_chat_turn t where t.tenant_id=c.tenant_id and t.chat_id=c.id and t.withheld) as withheld,
    f.seq as title_seq,f.question_ciphertext as title
   from public.teras_chat c
   left join lateral (select t.seq,t.question_ciphertext from public.teras_chat_turn t
    where t.tenant_id=c.tenant_id and t.chat_id=c.id and not t.withheld order by t.seq limit 1) f on true
   where c.tenant_id=${ctx.tenantId}::uuid and c.app_user_id=${userId}::uuid and c.scope_digest=${scopeDigest}
    and c.expires_at>now()
    ${cursor?sql`and (c.last_message_at,c.id)<(${cursor.at}::timestamptz,${cursor.id}::uuid)`:sql``}
   order by c.last_message_at desc,c.id desc limit ${limit+1}`);
  const page=rows.slice(0,limit);
  const chats=page.map(row=>{
   let title:string|null=null;
   if(row.title&&row.title_seq!==null){try{const text=open(row.title,chatTurnAad(ctx.tenantId,userId,row.id,row.title_seq,'question'));
    title=typeof text==='string'?text.replace(/\s+/g,' ').trim().slice(0,100):null;}catch{title=null;}}
   return Object.freeze({chatId:row.id,title,startedAt:iso(row.started),lastMessageAt:iso(row.last),expiresAt:iso(row.expires),turns:row.turns,withheldTurns:row.withheld});
  });
  const last=page.at(-1);
  return Object.freeze({chats:Object.freeze(chats),nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({at:last.last,id:last.id})).toString('base64url'):null});
 });}catch{return refuse();}
}

export type ReopenedTurn=Readonly<{seq:number;withheld:true}>|Readonly<{seq:number;withheld:false;question:string;reply:string}>;
export type ReopenedChat=Readonly<{chatId:string;companyId:string;
 /** The latest CHAT_LIMITS.turns turns, oldest first; earlier ones are not shown. */
 turns:readonly ReopenedTurn[];earlierTurns:number;
 /** The stored model-side rows of the shown turns, newest last, at most CHAT_LIMITS.historyMessages. */
 history:readonly ChatModelRow[]}>;

/** Reopens one of the caller's chats: re-authorised now, live, and started under the caller's current scope. */
export async function reopenOwnChat(supplied:SessionContext,chatId:unknown,conversationScope:string):Promise<ReopenedChat>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(chatId)||typeof conversationScope!=='string'||conversationScope.length>4096)return refuse();
 const userId=ctx.userId,scopeDigest=assistantConversationScopeDigest(ctx,conversationScope);
 if(!isSecretStorable())return refuse();
 try{return await withTenant(ctx,async tx=>{
  await tx.execute(sql`SET TRANSACTION READ ONLY`);await authorizeTx(tx,ctx);
  const [chat]=await tx.execute<{company_id:string;turns:number}>(sql`select company_id,turn_count as turns from public.teras_chat
   where id=${chatId}::uuid and tenant_id=${ctx.tenantId}::uuid and app_user_id=${userId}::uuid and scope_digest=${scopeDigest}
    and expires_at>now()`);
  if(!chat)return refuse();
  const rows=await tx.execute<{seq:number;withheld:boolean;question:string|null;reply:string|null;model:string|null}>(sql`
   select seq,withheld,question_ciphertext as question,reply_ciphertext as reply,model_ciphertext as model from public.teras_chat_turn
   where tenant_id=${ctx.tenantId}::uuid and app_user_id=${userId}::uuid and chat_id=${chatId}::uuid order by seq desc limit ${CHAT_LIMITS.turns}`);
  rows.reverse();
  const turns:ReopenedTurn[]=[],history:ChatModelRow[]=[];
  for(const row of rows){
   if(row.withheld){turns.push(Object.freeze({seq:row.seq,withheld:true as const}));continue;}
   const aad=(field:Field)=>chatTurnAad(ctx.tenantId,userId,chatId,row.seq,field);
   const question=open(row.question,aad('question')),reply=open(row.reply,aad('reply')),model=open(row.model,aad('model'));
   if(typeof question!=='string'||typeof reply!=='string'||!Array.isArray(model))return refuse();
   turns.push(Object.freeze({seq:row.seq,withheld:false as const,question,reply}));
   for(const item of model as unknown[]){
    const role=(item as {role?:unknown}|null)?.role,content=(item as {content?:unknown}|null)?.content;
    if((role!=='user'&&role!=='assistant')||typeof content!=='string')return refuse();
    history.push(Object.freeze({role,content:content.slice(0,CHAT_LIMITS.messageChars)}));
   }
  }
  return Object.freeze({chatId,companyId:chat.company_id,turns:Object.freeze(turns),earlierTurns:Math.max(0,chat.turns-rows.length),
   history:Object.freeze(history.slice(-CHAT_LIMITS.historyMessages))});
 });}catch{return refuse();}
}

/** Deletes one of the caller's chats now, with its turns and task memory. Needs no Assistant grant. Returns 0 or 1. */
export async function deleteOwnChat(supplied:SessionContext,chatId:unknown):Promise<number>{
 const ctx=captured(supplied);
 if(!own(ctx)||!uuid(chatId))return refuse();
 const userId=ctx.userId;
 try{return await withTenant(ctx,async tx=>{
  const erased=await tx.execute<{id:string}>(sql`delete from public.teras_chat where id=${chatId}::uuid and tenant_id=${ctx.tenantId}::uuid and app_user_id=${userId}::uuid returning id`);
  return erased.length;
 });}catch{return refuse();}
}

/** Erases every chat of the caller, expired or not, with turns and task memory. Needs no Assistant grant. */
export async function eraseOwnChats(supplied:SessionContext):Promise<number>{
 const ctx=captured(supplied);
 if(!own(ctx))return refuse();
 const userId=ctx.userId;
 try{return await withTenant(ctx,async tx=>{
  const erased=await tx.execute<{id:string}>(sql`delete from public.teras_chat where tenant_id=${ctx.tenantId}::uuid and app_user_id=${userId}::uuid returning id`);
  return erased.length;
 });}catch{return refuse();}
}

export type ChatRetention=Readonly<{keepDays:ChatKeepDays;
 /** null while the tenant has never chosen (the default applies). */
 version:number|null;changedAt:Date|null}>;

export async function readChatRetention(supplied:SessionContext):Promise<ChatRetention>{
 const ctx=captured(supplied);
 try{return await withTenant(ctx,async tx=>{
  const [row]=await tx.execute<{keep_days:number;version:number;changed_at:string}>(sql`select keep_days,version,${AT_SQL(sql`changed_at`)} as changed_at
   from public.teras_chat_retention where tenant_id=${ctx.tenantId}::uuid`);
  if(!row)return Object.freeze({keepDays:DEFAULT_CHAT_KEEP_DAYS,version:null,changedAt:null});
  const keepDays=CHAT_KEEP_DAYS.find(days=>days===row.keep_days)??refuse();
  return Object.freeze({keepDays,version:row.version,changedAt:iso(row.changed_at)});
 });}catch{return refuse();}
}

/** A group administrator sets "Keep chats for". Every change is audited (who, when, from, to, version); setting the
 * current value changes nothing and records nothing. A shorter value brings every chat's expiry forward at once (the
 * 0952 trigger on the setting); a longer one applies from each chat's next message, so no expired chat is revived. */
export async function setChatRetention(supplied:SessionContext,input:Readonly<{keepDays:unknown}>):Promise<ChatRetention>{
 const ctx=captured(supplied);
 if(!own(ctx)||!isGroupAdmin(ctx))throw new ChatRetentionRefused('not_administrator');
 const keepDays=CHAT_KEEP_DAYS.find(days=>days===input.keepDays);
 if(keepDays===undefined)throw new ChatRetentionRefused('invalid');
 const userId=ctx.userId;
 return withTenant(ctx,async tx=>{
  const locked=async()=>(await tx.execute<{keep_days:number;version:number;changed_at:string}>(sql`select keep_days,version,${AT_SQL(sql`changed_at`)} as changed_at
   from public.teras_chat_retention where tenant_id=${ctx.tenantId}::uuid for update`))[0];
  const audit=async(from:number,version:number)=>appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'teras-chat-retention',aggregateId:ctx.tenantId,
   eventType:'teras-chat-retention.changed',actor:actorOf(ctx),payload:{from,to:keepDays,version}});
  let before=await locked();
  if(!before){
   // No row is the default: choosing the default writes nothing.
   if(keepDays===DEFAULT_CHAT_KEEP_DAYS)return Object.freeze({keepDays,version:null,changedAt:null});
   // First change: ON CONFLICT waits for a concurrent first insert, so exactly one caller creates the row.
   const [inserted]=await tx.execute<{version:number;changed_at:string}>(sql`insert into public.teras_chat_retention(tenant_id,keep_days,changed_by_user_id)
    values(${ctx.tenantId}::uuid,${keepDays},${userId}::uuid) on conflict (tenant_id) do nothing returning version,${AT_SQL(sql`changed_at`)} as changed_at`);
   if(inserted){await audit(DEFAULT_CHAT_KEEP_DAYS,inserted.version);return Object.freeze({keepDays,version:inserted.version,changedAt:iso(inserted.changed_at)});}
   before=await locked();
   if(!before)throw new ChatRetentionRefused('not_administrator');
  }
  if(before.keep_days===keepDays)return Object.freeze({keepDays,version:before.version,changedAt:iso(before.changed_at)});
  const [row]=await tx.execute<{version:number;changed_at:string}>(sql`update public.teras_chat_retention set keep_days=${keepDays},changed_by_user_id=${userId}::uuid,changed_at=now()
   where tenant_id=${ctx.tenantId}::uuid returning version,${AT_SQL(sql`changed_at`)} as changed_at`);
  if(!row)throw new ChatRetentionRefused('not_administrator');
  await audit(before.keep_days,row.version);
  return Object.freeze({keepDays,version:row.version,changedAt:iso(row.changed_at)});
 }).catch(error=>{
  if(error instanceof ChatRetentionRefused)throw error;
  // A policy refusal (not a current group administrator in the database) is the same refusal.
  if((error as {cause?:{code?:unknown}}|null)?.cause?.code==='42501'||(error as {code?:unknown}|null)?.code==='42501')throw new ChatRetentionRefused('not_administrator');
  throw error;
 });
}

