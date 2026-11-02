/** AI Centre issue 8 (stored chats with retention) and issue 18 item 1 (the panel and Ask share one stored chat), on
 * fictional data through the real owners, roles and row-level security of migration 0952. Only the provider adapter's
 * network call is scripted in the shared-chat case; no provider is contacted. The provider-data review lookup is
 * isolated as in test/teras-conversation-turn.test.ts; no approval is claimed by this file.
 *
 * Proves: the owner reads their own chat and no other login, tenant, group administrator or agent can; gated turns store
 * no words; the encrypted round trip, and that a wrong binding fails; retention through the existing runner hard-deletes
 * expired chats only, with their turns and task memory, and a shortened setting applies at once; the setting refuses
 * non-group-administrators and values outside the list and audits each change; own and person erasure remove chats and
 * task memory; reopening re-authorises the caller and scope; the panel and Ask continue one stored chat.
 * The restricted-owner proofs (retention cannot read a turn under forced RLS) are in test/teras-chats-owner.test.ts. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();
 return{...actual,providerDataReviewStatus:(contractId:string)=>contractId==='teras_harness_turn_v1'?(review.approved?'approved':'pending'):actual.providerDataReviewStatus(contractId),
  assertProviderDataContractReviewed:(contractId:string,digest:string)=>{if(contractId==='teras_harness_turn_v1'&&review.approved)return;actual.assertProviderDataContractReviewed(contractId,digest);}};});
import * as schema from '../db/schema';
import {terasChat,terasChatRetention,terasChatTurn} from '../db/teras-chat-schema';
import {terasTaskMemory} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {erasePersonPii} from '../core/pdpa';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {conversationRoute} from '../core/teras-wiring/switch';
import {runConversationTurn} from '../core/teras-wiring/turn';
import {issueConversationContinuation,MAX_HISTORY_MESSAGES} from '../core/teras-wiring/history';
import {CHAT_LIMITS,ChatUnavailable,chatTurnAad,deleteOwnChat,eraseOwnChats,listOwnChats,readChatRetention,recordChatTurn,reopenOwnChat,setChatRetention,type ChatModelRow} from '../core/teras-chats';
import {isGroupAdmin} from '../lib/authz-model';
import {decryptSecret,encryptSecret} from '../lib/ai/crypto';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import type {ConverseArgs,ConverseResult} from '../lib/ai/types';
import {runAiRetentionTick} from '../scripts/ai-retention-runner';
import {adminCtx,closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base;
type Person={ctx:SessionContext&{userId:string};employmentId:string;personId:string};
async function hire(base:Base,name:string,role:'employee'|'manager'|'hr_admin'):Promise<Person>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 return{ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]},employmentId:hired.employmentId,personId:hired.personId};
}
const scope=()=>JSON.stringify([b.companyId]);
const MODEL:readonly ChatModelRow[]=[{role:'user',content:'How much annual leave do I have?'},{role:'assistant',content:'You have [an earlier figure] days of annual leave.'}];
async function chat(ctx:SessionContext,question='How much annual leave do I have?',options:{conversationId?:string;withheld?:boolean;reply?:string;conversationScope?:string}={}){
 const conversationId=options.conversationId??randomUUID();
 const chatId=await recordChatTurn(ctx,{conversationId,conversationScope:options.conversationScope??scope(),companyId:b.companyId,question,
  reply:options.reply??'You have 12 days of annual leave.',modelRows:MODEL,withheld:options.withheld??false});
 return{conversationId,chatId};
}
const turnsOf=(chatId:string)=>owner.db.select().from(terasChatTurn).where(eq(terasChatTurn.chatId,chatId)).orderBy(terasChatTurn.seq);
const chatsOf=(userId:string)=>owner.db.select({id:terasChat.id}).from(terasChat).where(eq(terasChat.appUserId,userId)).then(rows=>rows.map(row=>row.id).sort());
const memoryOf=(userId:string)=>owner.db.select({id:terasTaskMemory.conversationId}).from(terasTaskMemory).where(eq(terasTaskMemory.appUserId,userId)).then(rows=>rows.map(row=>row.id).sort());
const remember=(ctx:Person['ctx'],conversationId:string)=>owner.db.insert(terasTaskMemory).values({tenantId:ctx.tenantId,appUserId:ctx.userId,conversationId,memory:{fictional:true}});
/** Moves a chat's last message `days` into the past, as if written then under `keep` days (database triggers bypassed). */
async function backdate(chatId:string,days:number,keep=30){
 await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
  await tx.execute(sql`update public.teras_chat set created_at=now()-make_interval(days=>${days+1}),last_message_at=now()-make_interval(days=>${days}),
   expires_at=now()-make_interval(days=>${days})+make_interval(days=>${keep}) where id=${chatId}::uuid`);});
}
const listed=async(ctx:SessionContext,conversationScope=scope())=>(await listOwnChats(ctx,{},conversationScope)).chats.map(row=>row.chatId);
const tick=()=>runAiRetentionTick(owner as unknown as Parameters<typeof runAiRetentionTick>[0]);

beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 review.approved=true;
 vi.stubEnv('AI_CONFIG_SECRET','fictional-chat-store-passphrase-0123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-chat-proposal-secret-0123456789abcdef');
 await resetDb();b=await seedBase();for(const code of ['assistant','claims'])await setModule(b.tenantId,code,'active');
});

describe('isolation',()=>{
 it('the owner reads their own chat; no other login, tenant, group administrator or agent reads or writes it',async()=>{
  const me=await hire(b,'Fictional Chat Owner','employee'),peer=await hire(b,'Fictional Chat Neighbour','employee'),admin=await hire(b,'Fictional Chat Administrator','hr_admin');
  expect(isGroupAdmin(admin.ctx)).toBe(true);
  const stored=await chat(me.ctx);expect(stored.chatId).toBe(stored.conversationId);const chatId=stored.chatId!;
  const reopened=await reopenOwnChat(me.ctx,chatId,scope());
  expect(reopened.turns).toEqual([{seq:1,withheld:false,question:'How much annual leave do I have?',reply:'You have 12 days of annual leave.'}]);
  expect(reopened.history).toEqual(MODEL);
  expect(await listed(me.ctx)).toEqual([chatId]);
  expect(await withTenant(me.ctx,tx=>tx.select({id:terasChat.id}).from(terasChat))).toEqual([{id:chatId}]);
  for(const other of [peer.ctx,admin.ctx]){
   expect(await withTenant(other,tx=>tx.select().from(terasChat))).toEqual([]);
   expect(await withTenant(other,tx=>tx.select().from(terasChatTurn))).toEqual([]);
   await expect(reopenOwnChat(other,chatId,scope())).rejects.toBeInstanceOf(ChatUnavailable);
   expect(await listed(other)).toEqual([]);
   expect(await deleteOwnChat(other,chatId)).toBe(0);
   // Another login cannot add a turn to it, under its own id or by copying a stored row.
   expect(await recordChatTurn(other,{conversationId:chatId,conversationScope:scope(),companyId:b.companyId,question:'Fictional intrusion',reply:'x',modelRows:MODEL,withheld:false})).toBeNull();
   const [row]=await turnsOf(chatId);
   await expect(withTenant(other,tx=>tx.insert(terasChatTurn).values({...row,seq:2}))).rejects.toThrow();
   await expect(withTenant(other,tx=>tx.execute(sql`update public.teras_chat set turn_count=turn_count+1 where id=${chatId}::uuid returning id`))).resolves.toHaveLength(0);
  }
  // Another tenant, the same login id: nothing.
  const foreign=await seedBase();
  expect(await withTenant({...me.ctx,tenantId:foreign.tenantId},tx=>tx.select().from(terasChat))).toEqual([]);
  // The tenant's agent principal: nothing.
  const principal=await ensureAgentPrincipal(owner.db,b.tenantId),agent=agentContext(b.tenantId,principal,harnessSnapshot(b.tenantId));
  expect(await withTenant(agent,tx=>tx.select().from(terasChat))).toEqual([]);expect(await withTenant(agent,tx=>tx.select().from(terasChatTurn))).toEqual([]);
  await expect(reopenOwnChat(agent,chatId,scope())).rejects.toBeInstanceOf(ChatUnavailable);
  // Untouched: still exactly one turn, one chat.
  expect(await turnsOf(chatId)).toHaveLength(1);expect(await chatsOf(me.ctx.userId)).toEqual([chatId]);
  // The application role holds exactly the reviewed privileges.
  const [grants]=await owner.db.execute<Record<string,boolean>>(sql`select
   has_table_privilege('ai_hr_app','public.teras_chat','SELECT') as chat_select,has_table_privilege('ai_hr_app','public.teras_chat','DELETE') as chat_delete,
   has_column_privilege('ai_hr_app','public.teras_chat','turn_count','UPDATE') as chat_count,has_column_privilege('ai_hr_app','public.teras_chat','expires_at','UPDATE') as chat_expiry,
   has_column_privilege('ai_hr_app','public.teras_chat','app_user_id','UPDATE') as chat_owner,
   has_table_privilege('ai_hr_app','public.teras_chat_turn','UPDATE') as turn_update,has_table_privilege('ai_hr_app','public.teras_chat_turn','DELETE') as turn_delete,
   has_table_privilege('ai_hr_app','public.teras_chat_turn','TRUNCATE') as turn_truncate,has_table_privilege('ai_hr_app','public.teras_chat_retention','DELETE') as setting_delete,
   (select bool_and(relforcerowsecurity and relrowsecurity) from pg_class where oid in ('public.teras_chat'::regclass,'public.teras_chat_turn'::regclass,'public.teras_chat_retention'::regclass)) as forced`);
  expect(grants).toEqual({chat_select:true,chat_delete:true,chat_count:true,chat_expiry:false,chat_owner:false,turn_update:false,turn_delete:false,turn_truncate:false,setting_delete:false,forced:true});
 });

 it('gated sensitive turns store no words, only the marker that one happened',async()=>{
  const me=await hire(b,'Fictional Routed Asker','employee');
  const words='My manager keeps shouting at me and I feel unsafe';
  const {chatId}=await chat(me.ctx,words,{withheld:true,reply:'Please contact your HR team; this is the safe route.'});
  const [turn]=await turnsOf(chatId!);
  expect(turn).toMatchObject({seq:1,withheld:true,questionCiphertext:null,replyCiphertext:null,modelCiphertext:null});
  const everything=await owner.db.execute(sql`select c.*,t.* from public.teras_chat c join public.teras_chat_turn t on t.tenant_id=c.tenant_id and t.chat_id=c.id where c.id=${chatId}::uuid`);
  expect(everything).toHaveLength(1);expect(JSON.stringify(everything)).not.toMatch(/manager|shouting|unsafe|HR team|safe route/);
  expect((await reopenOwnChat(me.ctx,chatId,scope())).turns).toEqual([{seq:1,withheld:true}]);
  expect((await reopenOwnChat(me.ctx,chatId,scope())).history).toEqual([]);
  expect((await listOwnChats(me.ctx,{},scope())).chats).toEqual([expect.objectContaining({chatId,title:null,turns:1,withheldTurns:1})]);
  // The database refuses words on a withheld turn, a stored turn without its ciphertexts, and readable text.
  const token=encryptSecret('"fictional"','fixture-aad');
  for(const [seq,withheld,question,reply,model] of [[2,true,token,null,null],[3,false,null,null,null],[4,false,token,token,null],[5,false,'readable words are never stored here at all',token,token]] as const)
   await expect(owner.db.execute(sql`insert into public.teras_chat_turn(tenant_id,app_user_id,chat_id,seq,withheld,question_ciphertext,reply_ciphertext,model_ciphertext)
    values(${b.tenantId}::uuid,${me.ctx.userId}::uuid,${chatId}::uuid,${seq},${withheld},${question},${reply},${model})`),String(seq)).rejects.toThrow();
  expect(await turnsOf(chatId!)).toHaveLength(1);
 });

 it('encrypts each field bound to tenant, login, chat, sequence and field; a wrong binding or a moved ciphertext fails',async()=>{
  const me=await hire(b,'Fictional Cipher Owner','employee'),peer=await hire(b,'Fictional Cipher Peer','employee');
  const {chatId,conversationId}=await chat(me.ctx,'How much annual leave do I have?',{reply:'You have 12 days of annual leave.'});
  await chat(me.ctx,'And my medical leave?',{conversationId,reply:'You have 14 days of medical leave.'});
  const [first,second]=await turnsOf(chatId!);
  for(const value of [first.questionCiphertext,first.replyCiphertext,first.modelCiphertext])expect(value).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(JSON.stringify(await turnsOf(chatId!))).not.toMatch(/annual|medical|12 days|14 days|earlier figure/);
  const aad=(field:'question'|'reply'|'model',over:{tenant?:string;user?:string;chat?:string;seq?:number}={})=>chatTurnAad(over.tenant??b.tenantId,over.user??me.ctx.userId,over.chat??chatId!,over.seq??1,field);
  expect(JSON.parse(decryptSecret(first.questionCiphertext!,aad('question')))).toBe('How much annual leave do I have?');
  expect(JSON.parse(decryptSecret(first.replyCiphertext!,aad('reply')))).toBe('You have 12 days of annual leave.');
  expect(JSON.parse(decryptSecret(first.modelCiphertext!,aad('model')))).toEqual(MODEL);
  for(const wrong of [aad('question',{tenant:randomUUID()}),aad('question',{user:peer.ctx.userId}),aad('question',{chat:randomUUID()}),aad('question',{seq:2}),aad('reply'),aad('model')])
   expect(()=>decryptSecret(first.questionCiphertext!,wrong)).toThrow();
  // A ciphertext moved to another turn of the same chat no longer opens: the chat refuses to reopen.
  await owner.db.transaction(async tx=>{await tx.execute(sql`set local session_replication_role=replica`);
   await tx.execute(sql`update public.teras_chat_turn set reply_ciphertext=${first.replyCiphertext} where chat_id=${chatId}::uuid and seq=2`);});
  expect(second.seq).toBe(2);
  await expect(reopenOwnChat(me.ctx,chatId,scope())).rejects.toBeInstanceOf(ChatUnavailable);
  // Turns are immutable even for the owner.
  await expect(owner.db.execute(sql`update public.teras_chat_turn set withheld=withheld where chat_id=${chatId}::uuid`)).rejects.toThrow();
 });

 it('stores nothing without the encryption secret, never plaintext',async()=>{
  const me=await hire(b,'Fictional Unsealed Asker','employee');
  vi.stubEnv('AI_CONFIG_SECRET','');
  expect((await chat(me.ctx)).chatId).toBeNull();
  expect(await owner.db.select().from(terasChat)).toEqual([]);expect(await owner.db.select().from(terasChatTurn)).toEqual([]);
 });
});

describe('retention',()=>{
 it('the existing retention runner hard-deletes expired chats only, with their turns and task memory',async()=>{
  const me=await hire(b,'Fictional Retention Owner','employee'),peer=await hire(b,'Fictional Retention Peer','employee');
  const expired=await chat(me.ctx,'An old question'),live=await chat(me.ctx,'A new question'),other=await chat(peer.ctx,'A neighbour question');
  for(const [who,id] of [[me,expired.chatId!],[me,live.chatId!],[peer,other.chatId!]] as const)await remember(who.ctx,id);
  await backdate(expired.chatId!,40);
  // Expired: neither listed, reopened nor continued, even before the runner removes it.
  expect(await listed(me.ctx)).toEqual([live.chatId]);
  await expect(reopenOwnChat(me.ctx,expired.chatId,scope())).rejects.toBeInstanceOf(ChatUnavailable);
  expect((await chat(me.ctx,'Continue the old one',{conversationId:expired.conversationId})).chatId).toBeNull();
  const result=await tick();
  expect(result).toMatchObject({chats:1,backlog:false,oldestExpiredAgeSeconds:null});
  expect(await chatsOf(me.ctx.userId)).toEqual([live.chatId]);expect(await chatsOf(peer.ctx.userId)).toEqual([other.chatId]);
  expect(await turnsOf(expired.chatId!)).toEqual([]);expect(await turnsOf(live.chatId!)).toHaveLength(1);
  expect(await memoryOf(me.ctx.userId)).toEqual([live.chatId]);expect(await memoryOf(peer.ctx.userId)).toEqual([other.chatId]);
  expect((await tick()).chats).toBe(0);
 });

 it('a shorter setting brings every chat\'s expiry forward at once; a longer one applies from the next message and revives nothing',async()=>{
  const me=await hire(b,'Fictional Shortened Owner','employee'),peer=await hire(b,'Fictional Shortened Peer','employee'),admin=await hire(b,'Fictional Retention Administrator','hr_admin');
  const keptDays=async(id:string)=>(await owner.db.execute<{days:number}>(sql`select round(extract(epoch from expires_at-last_message_at)/86400)::int as days from public.teras_chat where id=${id}::uuid`))[0]?.days;
  const tenDays=await chat(me.ctx,'Ten days ago'),today=await chat(me.ctx,'Today'),theirs=await chat(peer.ctx,'Theirs');
  await backdate(tenDays.chatId!,10);
  expect(await keptDays(today.chatId!)).toBe(30);
  expect((await listed(me.ctx)).sort()).toEqual([tenDays.chatId,today.chatId].sort());
  await setChatRetention(admin.ctx,{keepDays:7});
  // Every chat of the tenant, every login: brought forward to its last message plus seven days.
  expect(await keptDays(today.chatId!)).toBe(7);expect(await keptDays(tenDays.chatId!)).toBe(7);expect(await keptDays(theirs.chatId!)).toBe(7);
  expect(await listed(me.ctx)).toEqual([today.chatId]);
  // Lengthening before the runner has passed does not revive the expired chat or extend the others.
  await setChatRetention(admin.ctx,{keepDays:365});
  expect(await listed(me.ctx)).toEqual([today.chatId]);expect(await keptDays(today.chatId!)).toBe(7);
  expect((await tick()).chats).toBe(1);expect(await chatsOf(me.ctx.userId)).toEqual([today.chatId]);
  // The next message is stamped with the longer setting, as is a new chat.
  await chat(me.ctx,'A second message',{conversationId:today.conversationId});
  expect(await keptDays(today.chatId!)).toBe(365);
  const fresh=await chat(me.ctx,'A new chat');expect(await keptDays(fresh.chatId!)).toBe(365);
  // Another tenant's chats keep their own setting.
  const foreign=await seedBase();await setModule(foreign.tenantId,'assistant','active');
  const outsider=await hire(foreign,'Fictional Foreign Asker','employee');
  const kept=await recordChatTurn(outsider.ctx,{conversationId:randomUUID(),conversationScope:JSON.stringify([foreign.companyId]),companyId:foreign.companyId,question:'Elsewhere',reply:'Elsewhere',modelRows:MODEL,withheld:false});
  await setChatRetention(admin.ctx,{keepDays:1});
  expect(await keptDays(kept!)).toBe(30);expect(await keptDays(today.chatId!)).toBe(1);
 });
});

describe('the "Keep chats for" setting',()=>{
 const events=()=>owner.db.execute<{actor_type:string;actor_id:string;payload:unknown}>(sql`select actor_type,actor_id,payload from public.domain_event
  where tenant_id=${b.tenantId}::uuid and event_type='teras-chat-retention.changed' order by occurred_at,id`);
 it('is changed only by a group administrator, only to a listed value, and every change is audited',async()=>{
  const me=await hire(b,'Fictional Setting Employee','employee'),manager=await hire(b,'Fictional Setting Manager','manager'),admin=await hire(b,'Fictional Setting Administrator','hr_admin');
  expect(await readChatRetention(me.ctx)).toEqual({keepDays:30,version:null,changedAt:null});
  for(const ctx of [me.ctx,manager.ctx,{...admin.ctx,grants:[{role:'hr_admin',companyId:b.companyId}]}])
   await expect(setChatRetention(ctx,{keepDays:7})).rejects.toMatchObject({name:'ChatRetentionRefused',reason:'not_administrator'});
  // The database refuses a non-administrator too, whatever the service does.
  await expect(withTenant(me.ctx,tx=>tx.insert(terasChatRetention).values({tenantId:b.tenantId,keepDays:7,changedByUserId:me.ctx.userId}))).rejects.toThrow();
  for(const keepDays of [0,2,14,31,366,365.5,'30',null,undefined])
   await expect(setChatRetention(admin.ctx,{keepDays}),String(keepDays)).rejects.toMatchObject({reason:'invalid'});
  await expect(owner.db.insert(terasChatRetention).values({tenantId:b.tenantId,keepDays:14,changedByUserId:admin.ctx.userId})).rejects.toThrow();
  // Choosing the default while none is set changes nothing and records nothing.
  expect(await setChatRetention(admin.ctx,{keepDays:30})).toEqual({keepDays:30,version:null,changedAt:null});
  expect(await events()).toEqual([]);
  await setChatRetention(admin.ctx,{keepDays:7});
  await setChatRetention(admin.ctx,{keepDays:365});
  await setChatRetention(admin.ctx,{keepDays:365});
  expect(await events()).toEqual([{actor_type:'user',actor_id:admin.ctx.userId,payload:{from:30,to:7,version:1}},{actor_type:'user',actor_id:admin.ctx.userId,payload:{from:7,to:365,version:2}}]);
  expect(await readChatRetention(me.ctx)).toMatchObject({keepDays:365,version:2});
  const [row]=await owner.db.select().from(terasChatRetention).where(eq(terasChatRetention.tenantId,b.tenantId));
  expect(row).toMatchObject({keepDays:365,version:2,changedByUserId:admin.ctx.userId});
  // Another tenant's setting is its own.
  const foreign=await seedBase();
  expect(await owner.db.select().from(terasChatRetention).where(eq(terasChatRetention.tenantId,foreign.tenantId))).toEqual([]);
 });
});

describe('erasure',()=>{
 it('a person deletes one chat or erases all of their own, with the linked task memory, even after access is removed',async()=>{
  const me=await hire(b,'Fictional Erasing Owner','employee'),peer=await hire(b,'Fictional Erasing Peer','employee');
  const one=await chat(me.ctx,'First'),two=await chat(me.ctx,'Second'),three=await chat(me.ctx,'Third'),theirs=await chat(peer.ctx,'Theirs');
  for(const [who,id] of [[me,one.chatId!],[me,two.chatId!],[me,three.chatId!],[peer,theirs.chatId!]] as const)await remember(who.ctx,id);
  await remember(me.ctx,'unrelated-conversation');
  expect(await deleteOwnChat(me.ctx,one.chatId)).toBe(1);
  expect(await chatsOf(me.ctx.userId)).toEqual([two.chatId,three.chatId].sort());expect(await turnsOf(one.chatId!)).toEqual([]);
  expect(await memoryOf(me.ctx.userId)).toEqual([three.chatId,two.chatId,'unrelated-conversation'].sort());
  await backdate(three.chatId!,40);
  await revokeAssistant(adminCtx(b),{appUserId:me.ctx.userId});
  await expect(listOwnChats(me.ctx,{},scope())).rejects.toBeInstanceOf(ChatUnavailable);
  // Erase all: the expired one too, without the Assistant grant.
  expect(await eraseOwnChats(me.ctx)).toBe(2);
  expect(await chatsOf(me.ctx.userId)).toEqual([]);expect(await memoryOf(me.ctx.userId)).toEqual(['unrelated-conversation']);
  expect(await chatsOf(peer.ctx.userId)).toEqual([theirs.chatId]);expect(await memoryOf(peer.ctx.userId)).toEqual([theirs.chatId]);
  expect(await turnsOf(theirs.chatId!)).toHaveLength(1);
 });

 it('person erasure deletes every chat and the task memory of the subject only, inside the audited erasure',async()=>{
  const subject=await hire(b,'Fictional Erased Subject','employee'),peer=await hire(b,'Fictional Kept Peer','employee');
  const mine=await chat(subject.ctx,'Subject question'),again=await chat(subject.ctx,'Subject routed',{withheld:true}),theirs=await chat(peer.ctx,'Peer question');
  for(const [who,id] of [[subject,mine.chatId!],[subject,again.chatId!],[peer,theirs.chatId!]] as const)await remember(who.ctx,id);
  await remember(subject.ctx,'subject-other-conversation');
  await erasePersonPii(adminCtx(b),{subjectEmploymentId:subject.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  expect(await chatsOf(subject.ctx.userId)).toEqual([]);expect(await turnsOf(mine.chatId!)).toEqual([]);expect(await memoryOf(subject.ctx.userId)).toEqual([]);
  expect(await chatsOf(peer.ctx.userId)).toEqual([theirs.chatId]);expect(await memoryOf(peer.ctx.userId)).toEqual([theirs.chatId]);
  const [event]=await owner.db.execute<{payload:{erasedFields?:unknown}}>(sql`select payload from public.domain_event where tenant_id=${b.tenantId}::uuid and event_type='pii.erased' and aggregate_type='person' and aggregate_id=${subject.personId}::uuid`);
  expect(event?.payload.erasedFields).toEqual(expect.arrayContaining(['assistantChatContent']));
  // Outside an admitted erasure the function refuses, and an administrator never reads a chat through it.
  await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.teras_chats_redact(${peer.employmentId}::uuid) as cleared`))).rejects.toThrow();
  expect(await chatsOf(peer.ctx.userId)).toEqual([theirs.chatId]);
 });
});

describe('reopening',()=>{
 it('re-authorises the caller and the scope the chat started under: another scope, role or a removed grant reads nothing',async()=>{
  const me=await hire(b,'Fictional Reopening Owner','employee');
  const {chatId,conversationId}=await chat(me.ctx);
  const otherScope=JSON.stringify([b.companyId,'ffffffff-0000-4000-8000-000000000000'].sort());
  await expect(reopenOwnChat(me.ctx,chatId,otherScope)).rejects.toBeInstanceOf(ChatUnavailable);
  expect(await listed(me.ctx,otherScope)).toEqual([]);
  // A turn under another scope is not added to it.
  expect((await chat(me.ctx,'Under another scope',{conversationId,conversationScope:otherScope})).chatId).toBeNull();
  // Another role on the same login is another scope.
  const widened={...me.ctx,roles:['employee','manager'],grants:[{role:'employee',companyId:null},{role:'manager',companyId:null}]};
  await expect(reopenOwnChat(widened,chatId,scope())).rejects.toBeInstanceOf(ChatUnavailable);
  expect(await turnsOf(chatId!)).toHaveLength(1);
  // A malformed id or cursor is refused, never queried.
  for(const bad of ['not-a-chat',chatId!.toUpperCase(),42,null])await expect(reopenOwnChat(me.ctx,bad,scope())).rejects.toBeInstanceOf(ChatUnavailable);
  await expect(listOwnChats(me.ctx,{cursor:'bm90LWEtY3Vyc29y'},scope())).rejects.toBeInstanceOf(ChatUnavailable);
  // Removing the Assistant grant closes reading at once.
  expect((await reopenOwnChat(me.ctx,chatId,scope())).chatId).toBe(chatId);
  await revokeAssistant(adminCtx(b),{appUserId:me.ctx.userId});
  await expect(reopenOwnChat(me.ctx,chatId,scope())).rejects.toBeInstanceOf(ChatUnavailable);
 });

 it('lists the caller\'s chats newest first, a page at a time',async()=>{
  const me=await hire(b,'Fictional Listing Owner','employee');
  const ids:string[]=[];for(let index=0;index<CHAT_LIMITS.chats+2;index++)ids.push((await chat(me.ctx,'Question '+index)).chatId!);
  const first=await listOwnChats(me.ctx,{},scope());
  expect(first.chats.map(row=>row.chatId)).toEqual(ids.slice().reverse().slice(0,CHAT_LIMITS.chats));
  expect(first.chats[0]).toMatchObject({title:'Question '+(CHAT_LIMITS.chats+1),turns:1,withheldTurns:0});
  expect(first.chats[0].expiresAt.getTime()-first.chats[0].lastMessageAt.getTime()).toBe(30*86_400_000);
  const second=await listOwnChats(me.ctx,{cursor:first.nextCursor},scope());
  expect(second.chats.map(row=>row.chatId)).toEqual(ids.slice(0,2).reverse());expect(second.nextCursor).toBeNull();
 });
});

describe('the floating panel and Ask share one stored chat',()=>{
 const sent:ConverseArgs[]=[];
 const final=(reply:string):Partial<ConverseResult>=>({toolCalls:[{id:'p-'+randomUUID().slice(0,8),name:'final_answer',input:{mode:'answer',slot:null,reply}}],stop:'tool_use'});
 function script(steps:readonly ((args:ConverseArgs)=>Partial<ConverseResult>)[]){
  sent.length=0;
  return vi.spyOn(openrouterAdapter,'converse').mockImplementation(async(_cfg,args)=>{const index=sent.length;sent.push(JSON.parse(JSON.stringify(args)));
   return{text:'',toolCalls:[],stop:'tool_use',usage:{inputTokens:100,outputTokens:20,cachedInputTokens:0},usageReported:true,...(steps[index]??(()=>final('Script ended.')))(args)};});
 }
 it('a chat started in the panel reopens in Ask from the stored model-side rows and continues as the same chat',async()=>{
  const me=await hire(b,'Fictional Panel Asker','employee'),admin=await hire(b,'Fictional Switch Administrator','hr_admin');
  await owner.db.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'openrouter',model:'fictional/model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true,
   providerOptions:{version:1,routing:{allowedProviders:['azure'],allowFallbacks:false,sort:'latency'}}});
  await setWorkerSwitch(admin.ctx,{workerId:'conversation',enabled:true});
  const record=(question:string,turn:Awaited<ReturnType<typeof runConversationTurn>>)=>recordChatTurn(me.ctx,{conversationId:turn.trace.conversationId,conversationScope:scope(),companyId:b.companyId,
   question,reply:turn.reply,modelRows:turn.modelTurn,withheld:turn.sensitive||turn.refused});
  // The panel: a first turn, stored under its conversation.
  const harness=async()=>{const route=await conversationRoute(me.ctx);if(route.route!=='harness')throw Error('Expected the harness route.');return route;};
  script([()=>final('Your leave balances are under Leave.')]);
  const panel=await runConversationTurn(me.ctx,await harness(),{question:'Where can I see my leave balance?',companyId:b.companyId,locale:'en'});
  const chatId=await record('Where can I see my leave balance?',panel);
  expect(chatId).toBe(panel.trace.conversationId);
  // Ask: "Open in AI Centre" reopens that chat and continues it from the stored model side, not the browser.
  const reopened=await reopenOwnChat(me.ctx,chatId,scope());
  expect(reopened.history).toEqual(panel.modelTurn.map(({role,content})=>({role,content})));
  expect(reopened.history.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);expect(CHAT_LIMITS.historyMessages).toBe(MAX_HISTORY_MESSAGES);
  const continuation=issueConversationContinuation(me.ctx,chatId!,reopened.history.map(row=>({...row,side:'model' as const})));
  script([args=>{expect(JSON.stringify(args.turns)).toContain('Where can I see my leave balance?');return final('Open Leave, then Balances.');}]);
  const ask=await runConversationTurn(me.ctx,await harness(),{question:'And how do I apply?',companyId:b.companyId,locale:'en',continuation});
  expect(sent.length).toBeGreaterThan(0);expect(ask.trace.conversationId).toBe(chatId);
  expect(await record('And how do I apply?',ask)).toBe(chatId);
  // A routed turn in the same chat joins as the marker only.
  script([()=>final('I am sorry to hear that.')]);
  const routed=await runConversationTurn(me.ctx,await harness(),{question:'My manager is harassing me at work.',companyId:b.companyId,locale:'en',continuation:ask.continuation});
  expect(routed.sensitive).toBe(true);expect(await record('My manager is harassing me at work.',routed)).toBe(chatId);
  const both=await reopenOwnChat(me.ctx,chatId,scope());
  expect(both.turns.map(turn=>turn.withheld?'withheld':turn.question)).toEqual(['Where can I see my leave balance?','And how do I apply?','withheld']);
  expect(JSON.stringify(both.history)).not.toContain('harassing');
  expect(await listed(me.ctx)).toEqual([chatId]);
  expect(JSON.stringify(await turnsOf(chatId!))).not.toMatch(/harass|leave balance/);
  expect(await owner.db.select({id:terasChat.id,turns:terasChat.turnCount}).from(terasChat).where(and(eq(terasChat.tenantId,b.tenantId),eq(terasChat.appUserId,me.ctx.userId)))).toEqual([{id:chatId,turns:3}]);
 },60000);
});
