/** Real askAssistant/native own reads and sealed clarification; only provider transport is mocked.
 * Authored UNRUN: exact-SHA Actions must establish runtime evidence after integration. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {grantAssistant} from '../core/assistant-grant';
import {askAssistant} from '../core/assistant';
import {ASSISTANT_TOOLS} from '../core/assistant-tools';
import {sealAssistantDisclosure,openAssistantAnswerDisclosure} from '../lib/ai/assistant-disclosure';
import {capturePrivateAssistantTask} from '../lib/ai/provider-assistant-policy';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-private-chat-receipt');vi.stubEnv('OPENAI_API_KEY','fictional-private-chat-transport');for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
async function fixture(){
 const admin=adminCtx(base);await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:113.75,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'PRIVATE Clarification Person',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 await owner.db.insert(s.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'113.75',effectiveOn:todayInKualaLumpur()});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};return{ctx,mine};
}
async function clarify(ctx:SessionContext,question='My leave balance',slot:'leave_type'|'module'='leave_type'){
 const binding={tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:randomUUID(),question,answer:'PRIVATE HISTORICAL MODEL TEXT'};
 const receipt=sealAssistantDisclosure(binding,[],{version:1,mode:'clarify',slot});expect(receipt).toBeTruthy();
 await owner.db.insert(s.assistantExchange).values({id:binding.exchangeId,tenantId:ctx.tenantId,appUserId:ctx.userId!,question,answer:binding.answer,disclosureReceipt:receipt,stop:'end'});return binding.exchangeId;
}
async function recorded(ctx:SessionContext,id:string){const [row]=await owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.id,id));expect(row).toBeTruthy();const proof=openAssistantAnswerDisclosure({tenantId:ctx.tenantId,userId:ctx.userId!,exchangeId:id,question:row.question,answer:row.answer??''},row.disclosureReceipt);expect(proof).toBeTruthy();return{row,proof:proof!};}
const usage={inputTokens:7,outputTokens:11,cachedInputTokens:0};
describe('private conversational native Assistant integration',()=>{
 it('accepts an authenticated Annual Leave answer, uses fresh native own facts and sends neither labels nor question/history/values',async()=>{
  const {ctx,mine}=await fixture(),prior=await clarify(ctx);
  const native=await ASSISTANT_TOOLS.find(tool=>tool.spec.name==='my_leave_balances')!.run(ctx,{});expect(native.ok).toBe(true);expect(JSON.stringify(native)).toContain('113.75');
  const transport=vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_cfg,args)=>{
   expect(args.turns).toHaveLength(1);const turn=args.turns[0];if(turn.role!=='user')throw Error('Expected closed metadata');
   const parsed=capturePrivateAssistantTask(JSON.parse(turn.content)).local;if(parsed.operation!=='conversation')throw Error('Expected conversation');
   const read=parsed.reads.find(read=>read.module==='leave'),card=read?.cards.find(card=>card.facts.some(fact=>fact.field==='available'&&fact.available)),fact=card?.facts.find(fact=>fact.field==='available'&&fact.available);
   expect(read).toBeTruthy();expect(card).toBeTruthy();expect(fact).toBeTruthy();
   const text=JSON.stringify(args);for(const secret of ['Annual Leave','My leave balance','PRIVATE','113.75',mine.personId,mine.employmentId,base.companyId,'Acme Sdn Bhd'])expect(text).not.toContain(secret);
   return{text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:read!.read,card:card!.card,fact:fact!.fact}]}),stop:'end',toolCalls:[],usage,usageReported:true};
  });
  const result=await askAssistant(ctx,{question:'Annual Leave',clarificationExchangeId:prior});expect(transport).toHaveBeenCalledOnce();expect(result.toolsUsed).toEqual(['my_leave_balances']);expect(result.stop).toBe('end');
  const {row,proof}=await recorded(ctx,result.exchangeId);expect(row.question).toBe('Annual Leave');expect(row.continuesExchangeId).toBe(prior);expect(proof.plan).toMatchObject({mode:'answer',blocks:[{kind:'fact',read:0}]});
 });
 it.each(['Alice Annual Leave','not Annual Leave','Annual Leave and Sick Leave','Unknown Leave'])('keeps invalid slot answer %s at leave_type without calling a provider',async question=>{
  const {ctx}=await fixture(),prior=await clarify(ctx),transport=vi.spyOn(openaiAdapter,'converse');
  const result=await askAssistant(ctx,{question,clarificationExchangeId:prior});expect(transport).not.toHaveBeenCalled();expect((await recorded(ctx,result.exchangeId)).proof.plan).toEqual({version:1,mode:'clarify',slot:'leave_type'});
 });
 it('accepts a corrected leave-type reply after an earlier invalid answer',async()=>{
  const {ctx}=await fixture(),prior=await clarify(ctx);const transport=vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_cfg,args)=>{
   const turn=args.turns[0];if(turn.role!=='user')throw Error('Expected metadata');const parsed=capturePrivateAssistantTask(JSON.parse(turn.content)).local;if(parsed.operation!=='conversation')throw Error('Expected conversation');const read=parsed.reads.find(read=>read.module==='leave')!,card=read.cards.find(card=>card.facts.some(fact=>fact.field==='available'&&fact.available))!,fact=card.facts.find(fact=>fact.field==='available'&&fact.available)!;return{text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:read.read,card:card.card,fact:fact.fact}]}),stop:'end',toolCalls:[],usage,usageReported:true};
  });
  const invalid=await askAssistant(ctx,{question:'Unknown Leave',clarificationExchangeId:prior});expect(transport).not.toHaveBeenCalled();
  const corrected=await askAssistant(ctx,{question:'Annual Leave',clarificationExchangeId:invalid.exchangeId});expect(transport).toHaveBeenCalledOnce();expect((await recorded(ctx,corrected.exchangeId)).proof.plan).toMatchObject({mode:'answer'});
 });
 it('never turns a named original question plus bare module into an own read',async()=>{
  const {ctx}=await fixture(),prior=await clarify(ctx,'Alice leave balance','module'),transport=vi.spyOn(openaiAdapter,'converse');
  const result=await askAssistant(ctx,{question:'leave',clarificationExchangeId:prior});expect(transport).not.toHaveBeenCalled();expect(result.toolsUsed).toEqual([]);expect((await recorded(ctx,result.exchangeId)).proof.plan).toEqual({version:1,mode:'clarify',slot:'module'});
 });
 it.each(['refusal','max_tokens','other'] as const)('retains truthful %s stop and observed usage rather than hiding terminal feedback',async stop=>{
  const {ctx}=await fixture(),prior=await clarify(ctx),transport=vi.spyOn(openaiAdapter,'converse').mockResolvedValue({text:'PRIVATE UNDISPLAYABLE TERMINAL',stop,toolCalls:[],usage,usageReported:true});
  const result=await askAssistant(ctx,{question:'Annual Leave',clarificationExchangeId:prior});expect(transport).toHaveBeenCalledOnce();expect(result.stop).toBe(stop);const {row,proof}=await recorded(ctx,result.exchangeId);expect(row.stop).toBe(stop);expect(proof.plan).toBeNull();
  const rows=await owner.db.select().from(s.assistantUsage).where(eq(s.assistantUsage.tenantId,ctx.tenantId));expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({inputTokens:7,outputTokens:11});
 });
 it('retains local action proposal and the existing separate human confirmation boundary',async()=>{
  const {ctx}=await fixture(),transport=vi.spyOn(openaiAdapter,'converse');const result=await askAssistant(ctx,{question:'cancel my leave'});expect(transport).not.toHaveBeenCalled();expect(result.toolsUsed).toEqual([]);expect((await recorded(ctx,result.exchangeId)).proof.plan).toEqual({version:1,mode:'propose',action:'leave.cancel',hints:{}});
 });
 it('reports unsupported pay cause locally without substituting payslip totals or inventing a causal explanation',async()=>{
  const {ctx}=await fixture(),transport=vi.spyOn(openaiAdapter,'converse');const result=await askAssistant(ctx,{question:'Why did my pay change?'});expect(transport).not.toHaveBeenCalled();expect(result.toolsUsed).toEqual([]);expect((await recorded(ctx,result.exchangeId)).proof.plan).toEqual({version:1,mode:'insufficient',code:'unsupported_explanation'});
 });
});
