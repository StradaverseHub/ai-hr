/** Real native question issuer, app-role quota admission and accounting. Only provider transport is
 * mocked. No hosted provider or invoice claim. Run after the coordinated quota migration is present. */
import {sql,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {askAssistant} from '../core/assistant';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {eraseOwnAssistantHistory} from '../core/assistant-history-retention';
import {resolveActiveAiConfig} from '../core/ai-config';
import {bindAiSpendTaskTx} from '../core/ai-spend-task';
import {assistantQuestionBudgetBinding} from '../core/assistant-question-budget';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,ctx:SessionContext;
const end={text:'{"version":1,"mode":"insufficient","code":"no_verified_facts"}',stop:'end' as const,toolCalls:[],usage:{inputTokens:5,outputTokens:7,cachedInputTokens:0},usageReported:true};
beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');
 ctx={...await entitledCtx(base,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 await grantAssistant(ctx,{appUserId:base.adminUserId});
 vi.stubEnv('AI_CONFIG_SECRET','fictional-assistant-quota-marker-secret');vi.stubEnv('OPENAI_API_KEY','fictional-never-sent');
 for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_cfg,args)=>{const first=args.turns[0];if(first?.role!=='user')throw Error('Expected one fixed native catalogue turn');const catalogue=JSON.parse(first.content) as {reads:{read:number;cards:{card:number;facts:{fact:number;available:boolean}[]}[]}[]};for(const read of catalogue.reads)for(const card of read.cards){const fact=card.facts.find(fact=>fact.available);if(fact)return {...end,text:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:read.read,card:card.card,fact:fact.fact}]})};}throw Error('Expected a nonempty native capability catalogue');});
});
async function budget(daily:number,monthly=1_000_000){
 await owner.db.insert(s.assistantBudget).values({tenantId:base.tenantId,monthlyTokenCeiling:monthly,perUserDailyQuestions:daily,effectiveFrom:todayInKualaLumpur()})
  .onConflictDoUpdate({target:[s.assistantBudget.tenantId,s.assistantBudget.effectiveFrom],targetWhere:sql`archived_at is null`,set:{monthlyTokenCeiling:monthly,perUserDailyQuestions:daily}});
}
const transport=()=>{const converse=openaiAdapter.converse;if(!converse)throw Error('Missing fictional conversation adapter');return vi.mocked(converse);};
const ask=()=>askAssistant(ctx,{question:'show assistant capabilities'});
const quotaRows=()=>owner.db.execute<{root_id:string;period:string;question_day:string;exchange_id:string|null;accounted_tokens:string}>(sql`select root_id,period,question_day::text,exchange_id,accounted_tokens::text from app.assistant_question_budget where tenant_id=${base.tenantId}::uuid order by reserved_at,root_id`);
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
describe('atomic Malaysia-day Assistant question quota',()=>{
 it('counts an in-flight question before transport finishes, so a concurrent same-user question cannot cross the daily ceiling',async()=>{
  await budget(1);const entered=deferred(),release=deferred();
  transport().mockImplementationOnce(async()=>{entered.resolve();await release.promise;return end;});
  const first=ask();try{
   await Promise.race([entered.promise,first.then(()=>{throw Error('Fictional provider was not reached');})]);
   await expect(ask()).rejects.toMatchObject({code:'budget_daily'});
   expect(openaiAdapter.converse).toHaveBeenCalledOnce();
   const rows=await quotaRows();expect(rows).toHaveLength(1);expect(rows[0].exchange_id).toBeNull();
  }finally{release.resolve();await first;}
  const call=transport().mock.calls[0][1];expect(call.tools).toEqual([]);expect(call.cacheKey).toBeUndefined();expect(JSON.stringify(call.turns)).not.toContain('show assistant capabilities');
  const [row]=await quotaRows();expect(row.exchange_id).toBeTruthy();expect(row.accounted_tokens).toBe('12');
  expect(row.question_day).toBe(todayInKualaLumpur());expect(row.period).toBe(row.question_day.slice(0,7));
 });
 it('counts existing model-run token holds even in unpriced mode before admitting another question',async()=>{
  await budget(10);const entered=deferred(),release=deferred();
  transport().mockImplementationOnce(async()=>{entered.resolve();await release.promise;return end;});
  const first=ask();try{
   await Promise.race([entered.promise,first.then(()=>{throw Error('Fictional provider was not reached');})]);
   const [run]=await owner.db.select().from(s.aiModelRun).where(eq(s.aiModelRun.tenantId,base.tenantId));
   expect(Number(run.reservedTokens)).toBeGreaterThan(12);
   await budget(10,Number(run.reservedTokens));
   await expect(ask()).rejects.toMatchObject({code:'budget_monthly'});
   expect(openaiAdapter.converse).toHaveBeenCalledOnce();
  }finally{release.resolve();await first;}
  // The settled actual replaces the estimate. Its accounted exchange must not be added twice.
  await budget(10,1_000_000);await ask();
  const [usage]=await owner.db.select().from(s.assistantUsage).where(eq(s.assistantUsage.tenantId,base.tenantId));
  expect(usage.inputTokens+usage.outputTokens+usage.cachedInputTokens).toBe(24);
  expect((await quotaRows()).map(row=>row.accounted_tokens)).toEqual(['12','12']);
 });
 it('retains unknown failed-call exposure after metadata-only exchange accounting instead of treating zero reported tokens as free',async()=>{
  await budget(10);transport().mockRejectedValueOnce(Error('Fictional unknown provider outcome'));
  await expect(ask()).rejects.toMatchObject({code:'provider_error'});
  const [run]=await owner.db.select().from(s.aiModelRun).where(eq(s.aiModelRun.tenantId,base.tenantId));
  expect(run.actualTokens).toBeNull();expect(Number(run.reservedTokens)).toBeGreaterThan(0);
  expect((await quotaRows())[0].accounted_tokens).toBe('0');
  await budget(10,Number(run.reservedTokens));
  await expect(ask()).rejects.toMatchObject({code:'budget_monthly'});expect(openaiAdapter.converse).toHaveBeenCalledOnce();
 });
 it('refuses a single request larger than remaining monthly capacity before transport, with the correct user-facing budget code',async()=>{
  await budget(10,1);await expect(ask()).rejects.toMatchObject({code:'budget_monthly'});
  expect(openaiAdapter.converse).not.toHaveBeenCalled();
  expect(await owner.db.select().from(s.aiModelRun).where(eq(s.aiModelRun.tenantId,base.tenantId))).toEqual([]);
 });
 it('includes pre-migration retired transcripts in the daily count and never needs their content',async()=>{
  await budget(1);await owner.db.insert(s.assistantExchange).values({tenantId:base.tenantId,appUserId:base.adminUserId,question:'',contentRetiredAt:new Date(),toolCalls:[]});
  await expect(ask()).rejects.toMatchObject({code:'budget_daily'});expect(openaiAdapter.converse).not.toHaveBeenCalled();expect(await quotaRows()).toEqual([]);
 });
 it('clearing history and revoking access in flight keeps accounting without restoring content or replenishing the daily place',async()=>{
  await budget(1);transport().mockImplementationOnce(async()=>{
   await eraseOwnAssistantHistory(ctx);await revokeAssistant(ctx,{appUserId:base.adminUserId});return end;
  });
  await expect(ask()).rejects.toMatchObject({code:'provider_error'});
  const [quota]=await quotaRows();expect(quota.accounted_tokens).toBe('12');expect(quota.exchange_id).toBeTruthy();
  const [exchange]=await owner.db.select().from(s.assistantExchange).where(eq(s.assistantExchange.tenantId,base.tenantId));
  expect(exchange).toMatchObject({question:'',answer:null,toolCalls:[],disclosureReceipt:null});expect(exchange.contentRetiredAt).not.toBeNull();
  await grantAssistant(ctx,{appUserId:base.adminUserId});await expect(ask()).rejects.toMatchObject({code:'budget_daily'});
  expect(openaiAdapter.converse).toHaveBeenCalledOnce();expect(await quotaRows()).toEqual([quota]);
 });
 it('reconciles an already accounted own exchange idempotently and cannot reuse its completed root',async()=>{
  await budget(10);await ask();const [quota]=await quotaRows();
  if(!quota.exchange_id)throw Error('Expected fictional completed exchange');
  const usage=await owner.db.select().from(s.assistantUsage).where(eq(s.assistantUsage.tenantId,base.tenantId));
  await withTenant(ctx,tx=>tx.execute(sql`select app.assistant_question_budget_complete(${quota.root_id}::uuid,${quota.exchange_id}::uuid)`));
  expect(await quotaRows()).toEqual([quota]);expect(await owner.db.select().from(s.assistantUsage).where(eq(s.assistantUsage.tenantId,base.tenantId))).toEqual(usage);
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.assistant_question_budget_complete(${quota.root_id}::uuid,${base.companyId}::uuid)`))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.assistant_question_budget_admit(${quota.root_id}::uuid,1)`))).rejects.toThrow();
 });
 it('does not let caller-supplied dates move quota day or usage period',async()=>{
  await budget(1);await askAssistant(ctx,{question:'show assistant capabilities',now:new Date(Date.now()+86_400_000)});
  const [row]=await quotaRows();expect(row.question_day).toBe(todayInKualaLumpur());
  const [usage]=await owner.db.select().from(s.assistantUsage).where(eq(s.assistantUsage.tenantId,base.tenantId));expect(usage.period).toBe(row.period);
 });
 it('keeps quota metadata private and refuses foreign roots, duplicate reservations and forged configuration copies',async()=>{
  await budget(10);const configured=await withTenant(ctx,async tx=>{const cfg=await resolveActiveAiConfig(tx,ctx,'hr_assistant');if(!cfg)throw Error('Missing fixture config');return bindAiSpendTaskTx(tx,ctx,cfg,{kind:'assistant_question'});});
  expect(()=>assistantQuestionBudgetBinding(ctx,{...configured})).toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.assistant_question_budget`))).rejects.toThrow();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.assistant_question_budget_reserve(${base.companyId}::uuid)`))).rejects.toThrow();
  const other=await seedBase(),foreign=await entitledCtx(other);
  const [row]=await quotaRows();
  await expect(withTenant(foreign,tx=>tx.execute(sql`select * from app.assistant_question_budget_admit(${row.root_id}::uuid,1)`))).rejects.toThrow();
  // The issued root belongs to an earlier committed transaction, so it cannot reserve a second question.
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.assistant_question_budget_reserve(${row.root_id}::uuid)`))).rejects.toThrow();
  expect(JSON.stringify(row)).not.toContain('Fictional');
 });
});
