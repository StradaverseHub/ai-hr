/** Real application-role continuation and admission. Only provider transport is mocked; historical
 * answers, receipts and tool results are deliberately hostile sentinels and never provider inputs. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {askAssistant} from '../core/assistant';
import {loadAiWorkspace} from '../core/ai-workspace';
import {eraseOwnAssistantHistory} from '../core/assistant-history-retention';
import {ownAssistantConversationContext as readOwnedContext,issueAssistantConversationToken,assertOwnAssistantConversationContextCurrentTx,assistantConversationSourceExchangeId,ASSISTANT_CHAT_CONTEXT_LIMITS} from '../core/assistant-conversation-context';
import * as contextOwner from '../core/assistant-conversation-context';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let b:Base;
const tokens=new Map<string,string>();
const ownAssistantConversationContext=(ctx:SessionContext,id:unknown,question:unknown)=>readOwnedContext(ctx,id,question,typeof id==='string'?tokens.get(id):undefined);
const staleAnswer='UNTRUSTED_OLD_ANSWER_PAY_987654';
const staleRead='UNTRUSTED_OLD_READ_BANK_876543';
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{tokens.clear();vi.stubEnv('AI_CONFIG_SECRET','fictional-chat-context-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function actor(base:Base=b){
 const admin=adminCtx(base),employee=await hireEmployee(admin,{person:{fullName:'Fictional chat actor',primaryEmail:randomUUID()+'@fixture.test'},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {ctx,admin,userId,employmentId:employee.employmentId};
}
async function exchange(ctx:SessionContext,question='What leave can I take next week?',continues:string|null=null,askedAt?:Date){
 const id=randomUUID();await owner.db.insert(s.assistantExchange).values({id,tenantId:ctx.tenantId,appUserId:ctx.userId!,question,
  answer:staleAnswer,toolCalls:[{name:'employee_profile',input:{staleRead},rowCount:1}],stop:'end',continuesExchangeId:continues,...(askedAt?{askedAt}:{})});
 const context=continues?await ownAssistantConversationContext(ctx,continues,question):null;
 const token=issueAssistantConversationToken(ctx,id,context);expect(token).toBeTruthy();tokens.set(id,token!);return id;
}
const refused=(ctx:SessionContext,id:unknown,question:unknown='What about tomorrow?')=>expect(ownAssistantConversationContext(ctx,id,question)).rejects.toThrow(/^Current conversation unavailable\.$/);
const ownRows=(ctx:SessionContext)=>owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.appUserId,ctx.userId!)).orderBy(s.assistantExchange.id);
const provider=()=>{vi.stubEnv('OPENAI_API_KEY','fictional-chat-never-sent');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');};
const usage={inputTokens:0,outputTokens:0,cachedInputTokens:0};
const end={text:JSON.stringify({version:1,mode:'insufficient',code:'no_verified_facts'}),stop:'end' as const,toolCalls:[],usage,usageReported:true};
const tool={...end,text:'',stop:'tool_use' as const,toolCalls:[{id:'fictional-chat-call',name:'unknown_fictional_tool',input:{}}]};

describe('same-login human chat context owner',()=>{
 it('carries chronological human questions without historical answers, source reads, receipts or new persisted text',async()=>{
  const {ctx}=await actor(),first=await exchange(ctx),second=await exchange(ctx,'Which dates are public holidays?',first),before=await ownRows(ctx);
  const context=await ownAssistantConversationContext(ctx,second,'What about tomorrow?');
  expect(context).toEqual({questions:['What leave can I take next week?','Which dates are public holidays?']});
  expect(Object.isFrozen(context)).toBe(true);expect(Object.isFrozen(context.questions)).toBe(true);
  expect(JSON.stringify(context)).not.toContain(staleAnswer);expect(JSON.stringify(context)).not.toContain(staleRead);
  expect(assistantConversationSourceExchangeId(context)).toBe(second);
  expect(assistantConversationSourceExchangeId({...context})).toBeNull();
  await withTenant(ctx,tx=>assertOwnAssistantConversationContextCurrentTx(tx,ctx,context));
  await expect(withTenant(ctx,tx=>assertOwnAssistantConversationContextCurrentTx(tx,ctx,{...context}))).rejects.toThrow('Current conversation unavailable.');
  expect(await ownRows(ctx)).toEqual(before);
 });
 it('uniformly refuses foreign users and tenants, missing, expired, retired and malformed immediate exchanges',async()=>{
  const mine=await actor(),other=await actor(),foreignBase=await seedBase();await setModule(foreignBase.tenantId,'assistant','active');
  const foreign=await actor(foreignBase),id=await exchange(mine.ctx),foreignId=await exchange(foreign.ctx),expired=await exchange(mine.ctx,'Old question',null,new Date(Date.now()-31*86400000));
  const retired=await exchange(mine.ctx,'Retired question');await owner.db.execute(sql`select app._assistant_transcripts_retire(${mine.ctx.tenantId}::uuid,array[${retired}::uuid],true)`);
  for(const ctx of [other.ctx,foreign.ctx])await refused(ctx,id);
  for(const bad of [foreignId,expired,retired,randomUUID(),'bad-id',null,undefined])await refused(mine.ctx,bad);
  for(const question of ['', ' ', 'x'.repeat(2001),null,undefined,{}])await expect(ownAssistantConversationContext(mine.ctx,id,question)).rejects.toThrow(/^Current conversation unavailable\.$/);
  let invoked=false;await refused(mine.ctx,{toString(){invoked=true;return id;}});expect(invoked).toBe(false);
 });
 it('requires an authentic scope-bound token and rejects tampering, another exchange, principal or company selection before provider use',async()=>{
  provider();const {ctx}=await actor(),id=await exchange(ctx),other=await exchange(ctx),token=tokens.get(id)!;
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  for(const proof of [undefined,null,'',token+'!',tokens.get(other)])await expect(readOwnedContext(ctx,id,'And tomorrow?',proof)).rejects.toThrow('Current conversation unavailable.');
  const changed={...ctx,grants:[{role:'employee',companyId:b.companyId}]};
  await expect(readOwnedContext(changed,id,'And tomorrow?',token)).rejects.toThrow('Current conversation unavailable.');
  const companyToken=issueAssistantConversationToken(ctx,id,null,JSON.stringify([b.companyId]))!;
  const allowed=await readOwnedContext(ctx,id,'And tomorrow?',companyToken,JSON.stringify([b.companyId]));expect(allowed.questions).toEqual(['What leave can I take next week?']);
  await expect(readOwnedContext(ctx,id,'And tomorrow?',companyToken,'[]')).rejects.toThrow('Current conversation unavailable.');
  await expect(askAssistant(ctx,{question:'And tomorrow?',previousExchangeId:id})).rejects.toMatchObject({code:'invalid_question'});
  await expect(askAssistant(ctx,{question:'And tomorrow?',previousExchangeId:id,previousConversationToken:companyToken,conversationScope:'[]'})).rejects.toMatchObject({code:'invalid_question'});
  await expect(askAssistant(ctx,{question:'And tomorrow?',previousExchangeId:id,previousConversationToken:token+'!'})).rejects.toMatchObject({code:'invalid_question'});
  expect(transport).not.toHaveBeenCalled();
 });
 it('refuses unavailable older linked context and rechecks every carried row after an erasure',async()=>{
  const {ctx}=await actor(),first=await exchange(ctx),second=await exchange(ctx,'What about next month?',first);
  const context=await ownAssistantConversationContext(ctx,second,'And tomorrow?');
  await owner.db.execute(sql`select app._assistant_transcripts_retire(${ctx.tenantId}::uuid,array[${first}::uuid],true)`);
  await refused(ctx,second);
  await expect(withTenant(ctx,tx=>assertOwnAssistantConversationContextCurrentTx(tx,ctx,context))).rejects.toThrow('Current conversation unavailable.');
 });
 it('rechecks a live grant and rejects a capability under another principal',async()=>{
  const {ctx,admin,userId}=await actor(),other=await actor(),id=await exchange(ctx),context=await ownAssistantConversationContext(ctx,id,'And tomorrow?');
  await expect(withTenant(other.ctx,tx=>assertOwnAssistantConversationContextCurrentTx(tx,other.ctx,context))).rejects.toThrow('Current conversation unavailable.');
  const changed={...ctx,grants:[{role:'employee',companyId:b.companyId}]};
  await expect(withTenant(ctx,tx=>assertOwnAssistantConversationContextCurrentTx(tx,changed,context))).rejects.toThrow('Current conversation unavailable.');
  await revokeAssistant(admin,{appUserId:userId});await refused(ctx,id);
 });
 it('keeps at most six recent exchanges and whole questions within the 8000-character budget',async()=>{
  const {ctx}=await actor();let latest:string|null=null;
  for(let n=0;n<8;n++)latest=await exchange(ctx,`Human question ${n}`,latest);
  const context=await ownAssistantConversationContext(ctx,latest,'Current question');
  expect(context.questions).toEqual(Array.from({length:6},(_,n)=>`Human question ${n+2}`));
  expect(ASSISTANT_CHAT_CONTEXT_LIMITS).toEqual({exchanges:6,characters:8000,question:2000});
  latest=null;const question='q'.repeat(2000);
  for(let n=0;n<5;n++)latest=await exchange(ctx,question,latest);
  const bounded=await ownAssistantConversationContext(ctx,latest,'x'.repeat(2000));
  expect(bounded.questions).toEqual([question,question]);
  expect(bounded.questions.join('\n\n').length+2+2000).toBe(6004);
  const tooLong=await exchange(ctx,'q'.repeat(8000));await refused(ctx,tooLong,'x');
 });
});

describe('ordinary follow-up admission uses current human context only',()=>{
 async function providerActor(){const result=await actor();await seedEntitlement(result.admin,{leaveTypeId:b.annualLeaveTypeId,annualDays:113.75,validFrom:'2020-01-01'});await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:result.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'113.75',effectiveOn:todayInKualaLumpur()});return result;}
 it('records and reopens a genuine greeting without reading HR records or claiming missing facts',async()=>{
  provider();const {ctx}=await providerActor();const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue({...end,text:JSON.stringify({version:1,mode:'social',code:'greeting'})});
  const answer=await askAssistant(ctx,{question:'Hello!'});expect(answer.toolsUsed).toEqual([]);expect(transport).not.toHaveBeenCalled();
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:answer.exchangeId,includeGovernance:false});
  expect(workspace.history.find(row=>row.id===answer.exchangeId)?.grounded?.conversation).toEqual({plan:{version:1,mode:'social',code:'greeting'},facts:[]});
 });
 it('resolves follow-up intent locally, sends only closed references, stores only the new question and links the own exchange',async()=>{
  provider();const {ctx}=await providerActor(),first=await exchange(ctx,'My leave balance'),second=await exchange(ctx,'And pending?',first);
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValueOnce(end);
  const answer=await askAssistant(ctx,{question:'And taken?',previousExchangeId:second,previousConversationToken:tokens.get(second)});
  expect(transport).toHaveBeenCalledOnce();
  for(const [,args] of transport.mock.calls){
   expect(args.turns).toHaveLength(1);expect(args.turns[0]).toMatchObject({role:'user'});expect(JSON.stringify(args)).toContain('leave_taken');
   for(const human of ['My leave balance','And pending?','And taken?'])expect(JSON.stringify(args)).not.toContain(human);
   expect(JSON.stringify(args)).not.toContain(staleAnswer);expect(JSON.stringify(args)).not.toContain(staleRead);
  }
  const row=(await ownRows(ctx)).find(row=>row.id===answer.exchangeId)!;
  expect(row.question).toBe('And taken?');expect(row.continuesExchangeId).toBe(second);
  expect(answer.conversationToken).toBeTruthy();const continued=await readOwnedContext(ctx,answer.exchangeId,'And Friday?',answer.conversationToken);
  expect(continued.questions).toEqual(['My leave balance','And pending?','And taken?']);
 });
 it('sends no historical context for a new conversation and refuses mixed continuation modes before any provider admission',async()=>{
  provider();const {ctx}=await providerActor(),first=await exchange(ctx);
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  await askAssistant(ctx,{question:'My leave balance'});
  expect(transport.mock.calls[0][1].turns).toHaveLength(1);expect(JSON.stringify(transport.mock.calls[0][1])).toContain('leave_available');expect(JSON.stringify(transport.mock.calls[0][1])).not.toContain('My leave balance');
  await expect(askAssistant(ctx,{question:'Next',previousExchangeId:first,previousConversationToken:tokens.get(first),clarificationExchangeId:first})).rejects.toMatchObject({code:'invalid_question'});
  await expect(askAssistant(ctx,{question:'Next',previousExchangeId:randomUUID(),previousConversationToken:'not-a-token'})).rejects.toMatchObject({code:'invalid_question'});
  expect(transport).toHaveBeenCalledOnce();
 });
 it('refuses the marker transaction if history is erased after it was read, without reaching a provider',async()=>{
  provider();const {ctx}=await providerActor(),id=await exchange(ctx),read=contextOwner.ownAssistantConversationContext;
  const transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue(end);
  vi.spyOn(contextOwner,'ownAssistantConversationContext').mockImplementationOnce(async(supplied,previous,question,token,conversationScope)=>{
   const context=await read(supplied,previous,question,token,conversationScope);expect(await eraseOwnAssistantHistory(ctx)).toEqual({retired:1});return context;
  });
  await expect(askAssistant(ctx,{question:'And tomorrow?',previousExchangeId:id,previousConversationToken:tokens.get(id)})).rejects.toThrow('Current conversation unavailable.');
  expect(transport).not.toHaveBeenCalled();expect(await ownRows(ctx)).toHaveLength(1);
 });
 it('makes no additional dispatch and retires content when any carried question retires during the sole call',async()=>{
  provider();const {ctx}=await providerActor(),first=await exchange(ctx,'My leave balance'),second=await exchange(ctx,'And pending?',first);
  const transport=vi.spyOn(openaiAdapter,'converse').mockImplementationOnce(async()=>{
   await owner.db.execute(sql`select app._assistant_transcripts_retire(${ctx.tenantId}::uuid,array[${first}::uuid],true)`);return tool;
  }).mockResolvedValue(end);
  await expect(askAssistant(ctx,{question:'And taken?',previousExchangeId:second,previousConversationToken:tokens.get(second)})).rejects.toMatchObject({code:'provider_error'});
  expect(transport).toHaveBeenCalledOnce();
  const rows=await ownRows(ctx);expect(rows.find(row=>row.id===first)?.contentRetiredAt).not.toBeNull();
  const accounting=rows.filter(row=>row.id!==first&&row.id!==second);expect(accounting).toHaveLength(1);expect(accounting[0]).toMatchObject({question:'',answer:null,disclosureReceipt:null,toolCalls:[],error:null,turnCount:1,stop:'other'});expect(accounting[0].contentRetiredAt).not.toBeNull();
 });
});
