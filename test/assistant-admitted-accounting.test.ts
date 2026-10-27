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
  if(state.providerFailure)throw state.providerFailure;
  return {text:'{"version":1,"mode":"insufficient","code":"no_verified_facts"}',toolCalls:[],stop:'end',usage:{inputTokens:5,outputTokens:7,cachedInputTokens:0}};
 });
 const prepareStrategy=vi.fn(async(_tx:unknown,_ctx:unknown,configuration:unknown,_question:string)=>{
  if(state.prepareFails)throw Error('Agent review could not be confirmed.');
  return {configuration,system:'fixture-strategy',capability:{},provenance:{mode:'baseline',version:0,configurationDigest:'fixture'}};
 });
 const completeStrategy=vi.fn(async(_tx:unknown,_ctx:unknown,_capability:unknown,_exchangeId:string)=>{
  if(state.erased)throw Error('Agent review could not be confirmed.');
  return {mode:'baseline',version:0,configurationDigest:'fixture'};
 });
 const retireStrategy=vi.fn();
 const seal=vi.fn((_binding:{question:string;answer:string})=>'sealed-fixture-receipt');
 return {state,runInTenant,converse,prepareStrategy,completeStrategy,retireStrategy,seal};
});

vi.mock('../db/client',()=>({withTenant:h.runInTenant}));
vi.mock('../lib/ai',()=>({converse:h.converse}));
vi.mock('../core/assistant-grant',()=>({assertMayUseAssistant:async()=>undefined}));
vi.mock('../core/ai-config',()=>({resolveActiveAiConfig:async()=>h.state.configured?{provider:'anthropic',model:'fixture-model'}:null}));
vi.mock('../core/ai-spend-task',()=>({bindAiSpendTaskTx:async(_tx:unknown,_ctx:unknown,configuration:unknown)=>configuration}));
vi.mock('../core/module-agent-releases',()=>({prepareAssistantConversationStrategyTx:h.prepareStrategy,completeAssistantConversationStrategyTx:h.completeStrategy,
 retireAssistantConversationStrategyCapability:h.retireStrategy,withGovernedSpecialistReadBatch:async()=>{throw Error('no specialist reads in this fixture');}}));
vi.mock('../core/assistant-provider-input',()=>({prepareAssistantConversation:(_ctx:unknown,configuration:unknown,args:unknown)=>({configuration,args})}));
vi.mock('../core/assistant-clarification',()=>({ownAssistantClarification:async()=>{if(!h.state.clarification)throw Error('Current clarification unavailable.');return Object.freeze({...h.state.clarification});}}));
vi.mock('../core/assistant-tools',()=>({ASSISTANT_TOOLS:[],toolsFor:()=>[]}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:async()=>{throw Error('no reads in this fixture');}}));
vi.mock('../lib/ai/assistant-disclosure',()=>({sealAssistantDisclosure:h.seal,assistantSourceDigest:()=>'fixture-digest'}));
vi.mock('../lib/ai/assistant-conversation-system',()=>({buildAssistantConversationSystem:(system:string)=>system}));
vi.mock('../lib/ai/assistant-answer-plan',()=>({parseAssistantAnswerPlan:()=>{throw Error('no plan in this fixture');},adjudicateAssistantAnswerPlan:()=>undefined}));
vi.mock('../lib/ai/assistant-tool-answer-evidence',()=>({assistantToolAnswerExplanations:()=>[]}));
vi.mock('../lib/ai/assistant-answer-explanations',()=>({assistantAnswerExplanationAvailability:()=>[]}));
vi.mock('../lib/ai/grounded-tool-presentation',()=>({isGroundedToolName:()=>false,presentGroundedToolOutcome:()=>null}));

import {askAssistant,AssistantError} from '../core/assistant';

const ctx:Parameters<typeof askAssistant>[0]={tenantId:'00000000-0000-4000-8000-0000000000a1',userId:'00000000-0000-4000-8000-0000000000b2',
 personId:'00000000-0000-4000-8000-0000000000c3',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const QUESTION='How many annual leave days do I have left?';
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
 Object.assign(h.state,{committed:{exchanges:[],usage:[]},budget:null,configured:true,prepareFails:false,erased:false,eraseDuringProvider:false,providerFailure:null,lostCommitAcks:0,clarification:null});
 vi.clearAllMocks();
});
afterEach(()=>{vi.clearAllMocks();});

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
 it('stores only the new human reply; the original question reaches the provider as transient context',async()=>{
  const original='ORIGINAL-QUESTION-READ-ON-DAY-29: which leave should I take next month?';
  h.state.clarification={originalQuestion:original,slot:'leave_type',answer:'Annual leave'};
  const answer=await askAssistant(ctx,{question:'  Annual leave  ',clarificationExchangeId:'00000000-0000-4000-8000-0000000000d4'});
  expect(exchanges()).toHaveLength(1);const [row]=exchanges();
  expect(row).toMatchObject({id:answer.exchangeId,question:'Annual leave'});
  expect(rawText(row)).not.toContain('ORIGINAL-QUESTION');
  // The marker digest and the sealed receipt bind the STORED question, so completion still verifies.
  expect(h.prepareStrategy.mock.calls[0][3]).toBe('Annual leave');
  expect(h.seal.mock.calls[0][0].question).toBe('Annual leave');
  const turns=h.converse.mock.calls[0][1].turns;
  expect(turns[0]).toEqual({role:'user',content:original});
  expect(JSON.parse(String(turns[1].content))).toEqual({humanClarification:{slot:'leave_type',answer:'Annual leave'}});
  expect(usage()).toHaveLength(1);
 });
});
