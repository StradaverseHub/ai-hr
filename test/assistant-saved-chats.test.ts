/** Real own-row saved history/resume. Display is paged canonical replay, intent remains bounded. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {askAssistant} from '../core/assistant';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {assistantConversationScopeDigest,ownAssistantConversationContext,resumeOwnAssistantConversation} from '../core/assistant-conversation-context';
import {ownAssistantClarification} from '../core/assistant-clarification';
import {listOwnAssistantChats,loadOwnAssistantChat} from '../core/assistant-threads';
import {sealAssistantDisclosure} from '../lib/ai/assistant-disclosure';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-saved-chat-key');vi.stubEnv('OPENAI_API_KEY','fictional-saved-chat-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');});
afterEach(()=>vi.unstubAllEnvs());
async function actor(){const admin=adminCtx(b),employee=await hireEmployee(admin,{person:{fullName:'Fictional saved chat actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});const userId=await createAppUser(b.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};return{ctx,admin,userId};}
const plan={version:1 as const,mode:'social' as const,code:'greeting' as const};
async function row(ctx:SessionContext,p:{id?:string;threadId?:string;parent?:string;scope?:string;askedAt?:Date;legacy?:boolean;error?:boolean;corrupt?:boolean}={}){
 const id=p.id??randomUUID(),question='Hello',answer=p.error?null:JSON.stringify(plan),receipt=answer?sealAssistantDisclosure({tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:id,question,answer},[],plan,p.legacy?undefined:{threadId:p.threadId??id,scopeDigest:assistantConversationScopeDigest(ctx,p.scope)}):null;
 await owner.db.insert(s.assistantExchange).values({id,tenantId:ctx.tenantId,appUserId:ctx.userId!,question,answer:p.corrupt?'UNTRUSTED RAW MODEL TERMINAL':answer,disclosureReceipt:receipt,stop:p.error?'other':'end',error:p.error?'provider_error':null,continuesExchangeId:p.parent??null,...(p.askedAt?{askedAt:p.askedAt}:{})});return id;
}
describe('saved owned chats',()=>{
 it('persists and resumes a genuine new chat and its follow-up without a provider call or copied source text',async()=>{
  const {ctx}=await actor(),first=await askAssistant(ctx,{question:'Hello'}),second=await askAssistant(ctx,{question:'Thanks',previousExchangeId:first.exchangeId,previousConversationToken:first.conversationToken});
  const listed=await listOwnAssistantChats(ctx);expect(listed.chats).toHaveLength(1);expect(listed.chats[0].threadId).toBe(first.exchangeId);expect(listed.chats[0].exchangeId).toBe(second.exchangeId);
  const opened=await loadOwnAssistantChat(ctx,{exchangeId:second.exchangeId});expect(opened.turns.map(turn=>turn.id)).toEqual([first.exchangeId,second.exchangeId]);expect(opened.resume?.exchangeId).toBe(second.exchangeId);expect(opened.turns.every(turn=>turn.answer===null)).toBe(true);
  const context=await ownAssistantConversationContext(ctx,second.exchangeId,'Hello',opened.resume!.conversationToken);expect(context.questions).toEqual(['Hello','Thanks']);
 });
 it('shows more than ten retained turns through honest pagination while intent stays at most six; selected old branch is independent of recent rows',async()=>{
  const {ctx}=await actor(),root=await row(ctx,{askedAt:new Date(Date.now()-14000)});let tail=root;const ids=[root];for(let n=1;n<13;n++){tail=await row(ctx,{threadId:root,parent:tail,askedAt:new Date(Date.now()-13000+n*1000)});ids.push(tail);}
  // A different, newer chat does not change which leaf the selected thread resumes.
  const other=await row(ctx);const listed=await listOwnAssistantChats(ctx);expect(listed.chats.some(chat=>chat.threadId===root)).toBe(true);expect(listed.chats.some(chat=>chat.threadId===other)).toBe(true);
  const first=await loadOwnAssistantChat(ctx,{exchangeId:tail,limit:5});expect(first.turns).toHaveLength(5);expect(first.olderCursor).toBeTruthy();
  const second=await loadOwnAssistantChat(ctx,{exchangeId:tail,before:first.olderCursor!,limit:5}),third=await loadOwnAssistantChat(ctx,{exchangeId:tail,before:second.olderCursor!,limit:5});
  expect([...third.turns,...second.turns,...first.turns].map(turn=>turn.id)).toHaveLength(13);expect(third.olderCursor).toBeNull();
  const context=await ownAssistantConversationContext(ctx,tail,'Hello',first.resume!.conversationToken);expect(context.questions.length).toBeLessThanOrEqual(6);
  const branch=await row(ctx,{threadId:root,parent:ids[1]});const chosen=await loadOwnAssistantChat(ctx,{exchangeId:branch});expect(chosen.turns.map(turn=>turn.id)).toEqual([root,ids[1],branch]);
  await expect(loadOwnAssistantChat(ctx,{exchangeId:branch,before:first.olderCursor!})).rejects.toThrow('Saved chat unavailable.');
 });
 it('never invents legacy scope or resumes failed, foreign, expired, retired or changed-scope rows',async()=>{
  const mine=await actor(),other=await actor(),legacy=await row(mine.ctx,{legacy:true}),failed=await row(mine.ctx,{error:true}),id=await row(mine.ctx),expired=await row(mine.ctx,{askedAt:new Date(Date.now()-31*86400000)});
  expect((await loadOwnAssistantChat(mine.ctx,{exchangeId:legacy})).resume).toBeNull();expect((await loadOwnAssistantChat(mine.ctx,{exchangeId:failed})).resume).toBeNull();
  for(const ctx of [other.ctx,{...mine.ctx,personId:randomUUID()},{...mine.ctx,grants:[{role:'employee',companyId:b.companyId}]}])await expect(resumeOwnAssistantConversation(ctx,id)).rejects.toThrow('Current conversation unavailable.');
  await expect(resumeOwnAssistantConversation(mine.ctx,id,'other-company-selection')).rejects.toThrow();await expect(resumeOwnAssistantConversation(mine.ctx,expired)).rejects.toThrow();
  await owner.db.execute(sql`select app._assistant_transcripts_retire(${mine.ctx.tenantId}::uuid,array[${id}::uuid],true)`);await expect(resumeOwnAssistantConversation(mine.ctx,id)).rejects.toThrow();
  const latest=await row(mine.ctx);await revokeAssistant(mine.admin,{appUserId:mine.userId});await expect(resumeOwnAssistantConversation(mine.ctx,latest)).rejects.toThrow();
 });
 it('retains a valid newer suffix after its root expires, while expired text stays absent and metadata is not replaced by legacy parents',async()=>{
  const {ctx}=await actor(),root=await row(ctx,{askedAt:new Date(Date.now()-31*86400000)}),child=await row(ctx,{threadId:root,parent:root});const opened=await loadOwnAssistantChat(ctx,{exchangeId:child});
  expect(opened.turns.map(turn=>turn.id)).toEqual([child]);expect(opened.olderUnavailable).toBe(true);expect(opened.resume?.threadId).toBe(root);
  const legacy=await row(ctx,{legacy:true}),newRoot=await row(ctx,{parent:legacy});expect((await loadOwnAssistantChat(ctx,{exchangeId:newRoot})).turns.map(turn=>turn.id)).toEqual([newRoot]);
 });
 it('checks v3 scope before clarification inheritance and never returns raw historical terminal text',async()=>{
  const {ctx}=await actor(),id=randomUUID(),question='Fictional unclear question',clarify={version:1 as const,mode:'clarify' as const,slot:'module' as const},answer=JSON.stringify(clarify),receipt=sealAssistantDisclosure({tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:id,question,answer},[],clarify,{threadId:id,scopeDigest:assistantConversationScopeDigest(ctx)})!;
  await owner.db.insert(s.assistantExchange).values({id,tenantId:ctx.tenantId,appUserId:ctx.userId!,question,answer,disclosureReceipt:receipt,stop:'end'});
  await expect(ownAssistantClarification(ctx,id,'Hello','other-company-selection')).rejects.toThrow('Current clarification unavailable.');
  const next=await askAssistant(ctx,{question:'Hello',clarificationExchangeId:id}),listed=await listOwnAssistantChats(ctx);expect(listed.chats.some(chat=>chat.threadId===id&&chat.exchangeId===next.exchangeId)).toBe(true);
  const corrupt=await row(ctx,{corrupt:true});const opened=await loadOwnAssistantChat(ctx,{exchangeId:corrupt});expect(JSON.stringify(opened)).not.toContain('UNTRUSTED RAW MODEL TERMINAL');expect(opened.resume).toBeNull();expect(opened.turns[0].grounded?.mode).toBe('unavailable');
 });
});
