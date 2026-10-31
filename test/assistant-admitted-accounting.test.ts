/** Admitted-question accounting and continuation retention in core/assistant.ts, with NO database.
 *
 * Every collaborator that reaches Postgres, a provider or a sealed receipt is mocked. The transaction
 * double keeps a callback's writes only when the callback resolves, so a thrown strategy completion is a
 * real rollback here, exactly as it is in Postgres. What this proves: the control flow of askAssistant and
 * its persistence (which rows and usage increments survive each outcome). What it does NOT prove: RLS, the
 * retirement CHECK, the transcript triggers or the real erasure fence — those need the unjournaled
 * transcript-retention migration and remain DB-only.
 */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AiAllowanceError} from '../lib/ai/types';

type Row=Record<string,unknown>;
type Pending={exchanges:Row[];usage:Row[]};
type Then=(ok?:(value:unknown)=>unknown,no?:(error:unknown)=>unknown)=>Promise<unknown>;
type SelectChain={from(source:object):SelectChain;where():SelectChain;orderBy():SelectChain;limit():SelectChain;then:Then};
type InsertChain={values(v:Row):InsertChain;onConflictDoNothing():InsertChain;onConflictDoUpdate():InsertChain;returning():InsertChain;then:Then};

const h=vi.hoisted(()=>{
 const TABLE=Symbol.for('drizzle:Name');
 const tableName=(table:object)=>String(Reflect.get(table,TABLE));
 const state={
  committed:{exchanges:[],usage:[]} as Pending,
  budget:null as null|{monthlyTokenCeiling:number;perUserDailyQuestions:number},
  configured:true,
  prepareFails:false,
  /** The strategy-use marker no longer completes: history cleared, PDPA erasure or access change. */
  erased:false,
  /** Clear history while the provider call is in flight. */
  eraseDuringProvider:false,
  continuationRetired:false,
  retireContinuationDuringProvider:false,
  providerFailure:null as unknown,
  /** Acknowledgements lost AFTER a commit that wrote an exchange (connection reset after COMMIT). */
  lostCommitAcks:0,
  clarification:null as null|{originalQuestion:string;slot:string;answer:string},
 };
 function fakeTx(pending:Pending){
  const all=()=>[...state.committed.exchanges,...pending.exchanges];
  return {
   select(projection:Row){
    let table='';
    const result=()=>{
     if(table==='assistant_budget')return state.budget?[state.budget]:[];
     if(table==='assistant_exchange'&&'n' in projection)return [{n:all().length}];
     if(table==='assistant_usage')return [];
     throw Error('unexpected select from '+table);
    };
    const then:Then=(ok,no)=>Promise.resolve().then(result).then(ok,no);
    const chain:SelectChain={from(source:object){table=tableName(source);return chain;},where:()=>chain,orderBy:()=>chain,limit:()=>chain,then};
    return chain;
   },
   insert(target:object){
    const table=tableName(target);let values:Row={},ignoreDuplicate=false;
    const run=()=>{
     if(table==='assistant_exchange'){
      if(all().some(row=>row.id===values.id)){if(ignoreDuplicate)return [];throw Error('duplicate key value violates unique constraint');}
      pending.exchanges.push(values);return [{id:values.id}];
     }
     if(table==='assistant_usage'){pending.usage.push(values);return [];}
     throw Error('unexpected insert into '+table);
    };
    const then:Then=(ok,no)=>Promise.resolve().then(run).then(ok,no);
    const chain:InsertChain={values(v:Row){values={...v};return chain;},onConflictDoNothing(){ignoreDuplicate=true;return chain;},onConflictDoUpdate:()=>chain,returning:()=>chain,then};
    return chain;
   },
  };
 }
 /** A thrown callback discards its pending writes: rollback. */
 async function runInTenant(_ctx:unknown,fn:(tx:unknown)=>Promise<unknown>){
  const pending:Pending={exchanges:[],usage:[]};
  const value=await fn(fakeTx(pending));
  state.committed.exchanges.push(...pending.exchanges);state.committed.usage.push(...pending.usage);
  if(state.lostCommitAcks>0&&pending.exchanges.length>0){state.lostCommitAcks--;throw Error('connection reset after COMMIT');}
  return value;
 }
 const converse=vi.fn(async(_configuration:unknown,_args:{turns:Row[]})=>{
  if(state.eraseDuringProvider)state.erased=true;
  if(state.retireContinuationDuringProvider)state.continuationRetired=true;
  if(state.providerFailure)throw state.providerFailure;
  return {text:'{"version":1,"mode":"insufficient","code":"no_verified_facts"}',toolCalls:[],stop:'end',usage:{inputTokens:5,outputTokens:7,cachedInputTokens:0}};
 });
 const prepareStrategy=vi.fn(async(_tx:unknown,_ctx:unknown,configuration:unknown,_question:string,_continuationSourceTx?:unknown)=>{
  if(state.prepareFails)throw Error('Agent review could not be confirmed.');
  return {configuration,system:'fixture-strategy',variant:'baseline_v1',capability:{},provenance:{mode:'baseline',version:0,configurationDigest:'fixture'}};
 });
 const recheckContinuation=vi.fn(async()=>{if(state.continuationRetired)throw Error('Current clarification unavailable.');});
 const completeStrategy=vi.fn(async(_tx:unknown,_ctx:unknown,_capability:unknown,_exchangeId:string)=>{
  if(state.erased)throw Error('Agent review could not be confirmed.');
  return {mode:'baseline',version:0,configurationDigest:'fixture'};
 });
 const retireStrategy=vi.fn();
 const completeBudget=vi.fn(async()=>undefined);
 const seal=vi.fn((_binding:{question:string;answer:string},_reads?:unknown,_plan?:unknown,_thread?:unknown)=>'sealed-fixture-receipt');
 // This double issues no genuine WeakMap custody or inherited thread/context capability.
 const bridge=vi.fn((_ctx:unknown,_clarification:unknown,_scope?:string)=>null),thread=vi.fn(()=>undefined),sourceId=vi.fn(()=>null),contextSource=vi.fn(()=>{throw Error('No genuine clarification source in accounting double');});
 return {state,runInTenant,converse,prepareStrategy,recheckContinuation,completeStrategy,retireStrategy,completeBudget,seal,bridge,thread,sourceId,contextSource};
});

vi.mock('../db/client',()=>({withTenant:h.runInTenant}));
vi.mock('../lib/ai',()=>({converse:h.converse}));
vi.mock('../core/assistant-grant',()=>({assertMayUseAssistant:async()=>undefined}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:async()=>h.state.configured?{provider:'anthropic',model:'fixture-model'}:null}));
vi.mock('../core/ai-spend-task',()=>({bindAiSpendTaskTx:async(_tx:unknown,_ctx:unknown,configuration:unknown)=>configuration}));
// This is deliberately a quota control-flow double, not proof of SQL atomicity or RLS. The real
// reservation/admission/concurrency cases live in assistant-question-budget.test.ts.
vi.mock('../core/assistant-question-budget',async()=>{
 const {AiAllowanceError}=await import('../lib/ai/types');
 class AssistantQuestionBudgetError extends AiAllowanceError{
  constructor(readonly budgetCode:'budget_daily'|'budget_monthly'){super(budgetCode==='budget_daily'?'daily_limit':'monthly_limit');}
 }
 return {AssistantQuestionBudgetError,completeAssistantQuestionBudgetTx:h.completeBudget,
  assistantQuestionBudgetBinding:()=>{
   const budget=h.state.budget;
   if(budget&&h.state.committed.exchanges.length>=budget.perUserDailyQuestions)throw new AssistantQuestionBudgetError('budget_daily');
   if(budget&&budget.monthlyTokenCeiling===0)throw new AssistantQuestionBudgetError('budget_monthly');
   return {period:'2026-10',reservation:{}};
  }};
});
vi.mock('../core/module-agent-releases',()=>({prepareAssistantConversationStrategyTx:h.prepareStrategy,completeAssistantConversationStrategyTx:h.completeStrategy,
 retireAssistantConversationStrategyCapability:h.retireStrategy,withGovernedSpecialistReadBatch:async()=>{throw Error('no specialist reads in this fixture');}}));
vi.mock('../core/ai-governance',async()=>({preparePrivateAiTask:async(configuration:unknown,_contract:string,readSource:(tx:unknown,ctx:unknown)=>Promise<unknown>)=>{const {capturePrivateAssistantTask}=await import('../lib/ai/provider-assistant-policy');const prepared=capturePrivateAssistantTask(await readSource({},ctx));return{...prepared,configuration,operation:prepared.local.operation,dispose:()=>undefined};}}));
vi.mock('../core/entitlements',()=>({resolveEntitlementsTx:async()=>({})}));
vi.mock('../core/assistant-disclosure-read',()=>({assistantSourceReplay:()=>async()=>true}));
vi.mock('../core/assistant-clarification',()=>({ownAssistantClarification:async()=>{if(!h.state.clarification)throw Error('Current clarification unavailable.');return Object.freeze({earlier:[],...h.state.clarification});},assistantClarificationSourceExchangeId:h.sourceId,assistantClarificationThreadId:h.thread,assistantClarificationContextSource:h.contextSource,assertOwnAssistantClarificationCurrentTx:h.recheckContinuation}));
// Preserve the real context module except this explicit fake-owner boundary. Real custody is DB-tested.
vi.mock('../core/assistant-conversation-context',async importOriginal=>({...await importOriginal<typeof import('../core/assistant-conversation-context')>(),assistantConversationContextFromClarification:h.bridge}));
vi.mock('../core/assistant-tools',()=>{const tool={module:'leave',sensitivity:'ordinary',spec:{name:'my_leave_balances',description:'Fictional bounded own read',inputSchema:{type:'object',properties:{},additionalProperties:false}},run:async()=>({ok:true,employments:[{employmentId:'fixture-employment',company:'Fixture Company',balances:[{leaveType:'Annual leave',available:113.75,taken:0,pending:0}]}]})};return{ASSISTANT_TOOLS:[tool],toolsFor:()=>[tool],specsFor:()=>[tool.spec]};});
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:async(_ctx:unknown,_module:unknown,read:(session:unknown)=>Promise<unknown>)=>read({}),withAssistantAdmissionReadsTx:async(_ctx:unknown,_tx:unknown,read:(session:unknown)=>Promise<unknown>)=>read({})}));
vi.mock('../lib/ai/assistant-disclosure',()=>({sealAssistantDisclosure:h.seal,assistantSourceDigest:()=>'fixture-digest'}));
vi.mock('../lib/ai/assistant-tool-answer-evidence',()=>({assistantToolAnswerExplanations:()=>[]}));
vi.mock('../lib/ai/assistant-answer-explanations',()=>({assistantAnswerExplanationAvailability:()=>[]}));

import {askAssistant,AssistantError} from '../core/assistant';

const ctx:Parameters<typeof askAssistant>[0]={tenantId:'00000000-0000-4000-8000-0000000000a1',userId:'00000000-0000-4000-8000-0000000000b2',
 personId:'00000000-0000-4000-8000-0000000000c3',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const QUESTION='How much leave do I have?';
/** The refusal the caller sees: an AssistantError code, or a description of anything else. */
async function outcome(promise:Promise<unknown>):Promise<string>{try{await promise;}catch(error){return error instanceof AssistantError?error.code:'not an AssistantError: '+String(error);}return 'answered';}
const rawText=(row:Row)=>[row.question,row.answer,row.disclosureReceipt,JSON.stringify(row.toolCalls),row.error].join('|');
const exchanges=()=>h.state.committed.exchanges,usage=()=>h.state.committed.usage;
/** The retired-at-birth shape the transcript retirement CHECK requires, with accounting intact. */
function expectAccountingOnly(row:Row|undefined){
 expect(row).toBeDefined();
 expect(row).toMatchObject({appUserId:ctx.userId,question:'',answer:null,disclosureReceipt:null,toolCalls:[],error:null,provider:'anthropic',model:'fixture-model'});
 expect(row?.contentRetiredAt).toBeDefined();expect(row?.contentRetiredAt).not.toBeNull();
}

beforeEach(()=>{
 Object.assign(h.state,{committed:{exchanges:[],usage:[]},budget:null,configured:true,prepareFails:false,erased:false,eraseDuringProvider:false,continuationRetired:false,retireContinuationDuringProvider:false,providerFailure:null,lostCommitAcks:0,clarification:null});
 vi.clearAllMocks();
});
afterEach(()=>{expect(h.contextSource).not.toHaveBeenCalled();vi.clearAllMocks();});

describe('every admitted Assistant question counts exactly once',()=>{
 it('ask, clear history mid-flight, repeat: the cleared question still counts and the repeat meets the daily ceiling',async()=>{
  h.state.budget={monthlyTokenCeiling:1_000_000,perUserDailyQuestions:1};h.state.eraseDuringProvider=true;
  expect(await outcome(askAssistant(ctx,{question:QUESTION}))).toBe('provider_error');
  expect(h.completeStrategy).toHaveBeenCalledTimes(1);
  expect(exchanges()).toHaveLength(1);expectAccountingOnly(exchanges()[0]);
  expect(exchanges()[0]).toMatchObject({turnCount:1,inputTokens:5,outputTokens:7,cachedInputTokens:0,stop:'end'});
  expect(rawText(exchanges()[0])).not.toContain(QUESTION);
  expect(usage()).toEqual([expect.objectContaining({tenantId:ctx.tenantId,inputTokens:5,outputTokens:7,cachedInputTokens:0,exchangeCount:1})]);
  expect(h.retireStrategy).toHaveBeenCalledTimes(1);
  expect(h.completeBudget).toHaveBeenCalledTimes(1);
  // A fresh marker for the repeat: only the daily counter can stop it now.
  h.state.eraseDuringProvider=false;h.state.erased=false;
  expect(await outcome(askAssistant(ctx,{question:QUESTION}))).toBe('budget_daily');
  expect(h.converse).toHaveBeenCalledTimes(1);expect(exchanges()).toHaveLength(1);expect(usage()).toHaveLength(1);
 });
 it('an answered question keeps its content, completes its marker once and adds one usage increment',async()=>{
  const answer=await askAssistant(ctx,{question:QUESTION});
  expect(exchanges()).toHaveLength(1);const [row]=exchanges();
  expect(row).toMatchObject({id:answer.exchangeId,question:QUESTION,disclosureReceipt:'sealed-fixture-receipt',error:null});
  expect(row.contentRetiredAt).toBeUndefined();
  expect(h.completeStrategy).toHaveBeenCalledTimes(1);expect(h.completeStrategy.mock.calls[0][3]).toBe(answer.exchangeId);
  // A new question has no transient continuation source to recheck.
  expect(h.prepareStrategy.mock.calls[0][4]).toBeUndefined();expect(h.recheckContinuation).not.toHaveBeenCalled();
  expect(usage()).toEqual([expect.objectContaining({inputTokens:5,outputTokens:7,exchangeCount:1})]);expect(h.retireStrategy).toHaveBeenCalledTimes(1);
 });
 it('a provider failure with the marker intact is recorded once with its generic error',async()=>{
  h.state.providerFailure=Error('upstream 529 with a raw provider body');
  expect(await outcome(askAssistant(ctx,{question:QUESTION}))).toBe('provider_error');
  expect(exchanges()).toHaveLength(1);expect(exchanges()[0]).toMatchObject({question:QUESTION,error:'provider_error',answer:null});
  expect(rawText(exchanges()[0])).not.toContain('529');expect(usage()).toHaveLength(1);
 });
 it('a provider failure after the history was cleared is counted once and keeps no raw content',async()=>{
  h.state.eraseDuringProvider=true;h.state.providerFailure=Error('upstream failure');
  expect(await outcome(askAssistant(ctx,{question:QUESTION}))).toBe('provider_error');
  expect(exchanges()).toHaveLength(1);expectAccountingOnly(exchanges()[0]);expect(rawText(exchanges()[0])).not.toContain(QUESTION);
  expect(usage()).toEqual([expect.objectContaining({exchangeCount:1})]);
 });
 it('an AI-control refusal after erasure keeps its own refusal code and is counted once',async()=>{
  h.state.eraseDuringProvider=true;h.state.providerFailure=new AiAllowanceError('paused');
  expect(await outcome(askAssistant(ctx,{question:QUESTION}))).toBe('ai_control');
  expect(exchanges()).toHaveLength(1);expectAccountingOnly(exchanges()[0]);expect(usage()).toHaveLength(1);
 });
 it('a lost commit acknowledgement is not counted twice and the committed answer stands',async()=>{
  h.state.lostCommitAcks=1;
  const answer=await askAssistant(ctx,{question:QUESTION});
  expect(exchanges()).toHaveLength(1);expect(exchanges()[0]).toMatchObject({id:answer.exchangeId,question:QUESTION});
  expect(usage()).toHaveLength(1);expect(h.retireStrategy).toHaveBeenCalledTimes(1);
 });
 const beforeAdmission:[string,()=>void,string][]=[
  ['the daily ceiling',()=>{h.state.budget={monthlyTokenCeiling:1_000_000,perUserDailyQuestions:0};},'budget_daily'],
  ['the monthly ceiling',()=>{h.state.budget={monthlyTokenCeiling:0,perUserDailyQuestions:10};},'budget_monthly'],
  ['no provider',()=>{h.state.configured=false;},'not_configured'],
  ['the strategy admission',()=>{h.state.prepareFails=true;},'not an AssistantError: Error: Agent review could not be confirmed.'],
 ];
 for(const [name,arrange,refusal] of beforeAdmission)it(`a question refused before admission by ${name} counts nothing`,async()=>{
  arrange();
  expect(await outcome(askAssistant(ctx,{question:QUESTION}))).toBe(refusal);
  expect(h.converse).not.toHaveBeenCalled();expect(exchanges()).toEqual([]);expect(usage()).toEqual([]);
 });
});

describe('a clarification continuation cannot carry the original question past its own 30 days',()=>{
 it('stores only the new human reply; original question and local slot label never reach the provider',async()=>{
  const original='My leave balance';
  h.state.clarification={originalQuestion:original,slot:'leave_type',answer:'Annual leave'};
  const answer=await askAssistant(ctx,{question:'  Annual leave  ',clarificationExchangeId:'00000000-0000-4000-8000-0000000000d4'});
  expect(exchanges()).toHaveLength(1);const [row]=exchanges();
  expect(row).toMatchObject({id:answer.exchangeId,question:'Annual leave'});
  expect(rawText(row)).not.toContain(original);
  // The marker digest and the sealed receipt bind the STORED question, so completion still verifies.
  expect(h.prepareStrategy.mock.calls[0][3]).toBe('Annual leave');
  // The original question is transient context: its own source is handed to the strategy owner to
  // recheck in the marker transaction and at every provider admission (DB-proven in assistant-clarification).
  expect(typeof h.prepareStrategy.mock.calls[0][4]).toBe('function');
  expect(h.seal.mock.calls[0][0].question).toBe('Annual leave');
  expect(h.bridge).toHaveBeenCalledExactlyOnceWith(ctx,expect.objectContaining({originalQuestion:original,slot:'leave_type',answer:'Annual leave',earlier:[]}),undefined);expect(h.bridge).toHaveReturnedWith(null);expect(h.thread).toHaveReturnedWith(undefined);expect(h.sourceId).toHaveReturnedWith(null);
  expect(row.continuesExchangeId).toBeNull();expect(h.seal.mock.calls[0][0]).toMatchObject({exchangeId:answer.exchangeId});expect(h.seal.mock.calls[0][3]).toMatchObject({threadId:answer.exchangeId});
  const turns=h.converse.mock.calls[0][1].turns;
  expect(turns).toHaveLength(1);expect(turns[0]).toMatchObject({role:'user'});expect(JSON.parse(String(turns[0].content))).toMatchObject({operation:'conversation',intent:'leave_available',strategy:'baseline_v1'});
  expect(JSON.stringify(turns)).not.toContain(original);expect(JSON.stringify(turns)).not.toContain('Annual leave');
  expect(usage()).toHaveLength(1);
 });
});


describe('post-provider authenticated continuation custody',()=>{
 const id='00000000-0000-4000-8000-0000000000d4';
 const prepare=()=>{h.state.clarification={originalQuestion:'My leave balance',slot:'leave_type',answer:'Annual leave'};};
 it.each(['success','error'] as const)('retains only accounting when source retires during provider %s although strategy marker remains intact',async terminal=>{
  prepare();h.state.retireContinuationDuringProvider=true;if(terminal==='error')h.state.providerFailure=Error('PRIVATE_PROVIDER_BODY');
  expect(await outcome(askAssistant(ctx,{question:'Annual leave',clarificationExchangeId:id}))).toBe('provider_error');
  expect(h.state.erased).toBe(false);expect(h.recheckContinuation).toHaveBeenCalledOnce();expect(h.completeStrategy).not.toHaveBeenCalled();
  expect(exchanges()).toHaveLength(1);expectAccountingOnly(exchanges()[0]);expect(rawText(exchanges()[0])).not.toContain('Annual leave');expect(rawText(exchanges()[0])).not.toContain('PRIVATE');
  expect(usage()).toHaveLength(1);expect(usage()[0]).toMatchObject({exchangeCount:1,inputTokens:terminal==='success'?5:0,outputTokens:terminal==='success'?7:0});expect(h.completeBudget).toHaveBeenCalledOnce();expect(h.retireStrategy).toHaveBeenCalledOnce();
 });
 it('retains the committed valid continuation once after a lost commit acknowledgement',async()=>{
  prepare();h.state.lostCommitAcks=1;const result=await askAssistant(ctx,{question:'Annual leave',clarificationExchangeId:id});
  expect(h.recheckContinuation).toHaveBeenCalledOnce();expect(h.completeStrategy).toHaveBeenCalledOnce();expect(exchanges()).toHaveLength(1);expect(exchanges()[0]).toMatchObject({id:result.exchangeId,question:'Annual leave'});expect(usage()).toEqual([expect.objectContaining({exchangeCount:1,inputTokens:5,outputTokens:7})]);expect(h.completeBudget).toHaveBeenCalledOnce();expect(h.retireStrategy).toHaveBeenCalledOnce();
 });
});
