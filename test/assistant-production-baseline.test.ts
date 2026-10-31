/** Production-fidelity Assistant conversation baseline (phase 1). Real askAssistant, routing, source
 * reads, privacy projection, adjudication and stored exchange owners on fictional data. ONLY the
 * provider transport is replaced, by an oracle that selects every offered available reference: the
 * recorded quality is therefore an upper bound for the current architecture, not a model benchmark.
 * Safety gates are hard assertions; quality is recorded for comparison, never asserted as a target. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {askAssistant} from '../core/assistant';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {loadAiWorkspace} from '../core/ai-workspace';
import {openaiAdapter} from '../lib/ai/providers/openai';
import type {ConverseArgs,ConverseResult} from '../lib/ai/types';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ASSISTANT_PRODUCTION_BASELINE,scoreBaselineTurn,summarizeBaseline,type BaselineObservation,type BaselineScore} from './assistant-production-baseline-corpus';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-baseline-passphrase');vi.stubEnv('OPENAI_API_KEY','fictional-baseline-never-sent');
 for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
// Distinctive fictional values: none may ever appear in a provider request.
const SENTINELS=['Fictional Baseline Actor','Siti Fictional','17.25','11.5','Medical Leave','Annual Leave'];
async function actor(){
 const admin=adminCtx(base),[medical]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true}).returning({id:schema.leaveType.id});
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Baseline Actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await hireEmployee(admin,{person:{fullName:'Siti Fictional',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 for(const [leaveTypeId,days] of [[base.annualLeaveTypeId,'17.25'],[medical.id,'11.5']] as const)await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});
 const userId=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {admin,ctx,userId};
}
/** Oracle reference selector: every available fact/explanation the closed catalogue offers (max 16). */
function oracle(requests:ConverseArgs[]){
 return vi.spyOn(openaiAdapter,'converse').mockImplementation(async(_configuration:unknown,args:ConverseArgs):Promise<ConverseResult>=>{
  requests.push(args);const turn=args.turns[0],catalogue=JSON.parse(turn&&'content'in turn&&typeof turn.content==='string'?turn.content:'{}');
  const blocks:unknown[]=[];for(const read of catalogue.reads??[]){for(const card of read.cards)for(const fact of card.facts)if(fact.available)blocks.push({kind:'fact',read:read.read,card:card.card,fact:fact.fact});
   for(const item of read.explanations)blocks.push({kind:'explanation',read:read.read,card:item.card,code:item.code});}
  const plan=blocks.length?{version:1,mode:'answer',blocks:blocks.slice(0,16)}:{version:1,mode:'insufficient',code:'no_verified_facts'};
  return{text:JSON.stringify(plan),stop:'end',toolCalls:[],usageReported:true,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0}};
 } as never);
}
async function observe(ctx:SessionContext,question:string,previous:{exchangeId:string;token?:string;clarify:boolean}|null,requests:ConverseArgs[]){
 const before=requests.length;
 try{
  const answer=await askAssistant(ctx,{question,...(previous?previous.clarify?{clarificationExchangeId:previous.exchangeId}:{previousExchangeId:previous.exchangeId,previousConversationToken:previous.token}:{})});
  const workspace=await loadAiWorkspace(ctx,{selectedExchangeId:answer.exchangeId,includeGovernance:false});
  const plan=(workspace.history.find(row=>row.id===answer.exchangeId)?.grounded?.conversation?.plan??null) as BaselineObservation['plan'];
  return{observation:{plan:plan?{mode:plan.mode,...(plan.slot?{slot:plan.slot}:{}),...(plan.code?{code:plan.code}:{}),...(plan.action?{action:plan.action}:{})}:null,reads:answer.toolsUsed.slice(),providerCalls:requests.length-before} as BaselineObservation,
   next:{exchangeId:answer.exchangeId,token:answer.conversationToken,clarify:plan?.mode==='clarify'}};
 }catch(error){return{observation:{plan:null,reads:[],providerCalls:requests.length-before,error:(error as {code?:string}).code??'thrown'} as BaselineObservation,next:null};}
}
describe('Assistant production-fidelity conversation baseline',()=>{
 it('records every review conversation through the actual route without leaking words or values',async()=>{
  const {ctx}=await actor(),requests:ConverseArgs[]=[],transport=oracle(requests),scores:BaselineScore[]=[];
  for(const conversation of ASSISTANT_PRODUCTION_BASELINE){
   let previous:{exchangeId:string;token?:string;clarify:boolean}|null=null;
   for(const turn of conversation.turns){
    const {observation,next}=await observe(ctx,turn.question,turn.continues?previous:null,requests);previous=next;
    const score=scoreBaselineTurn(turn,observation);scores.push(score);
    // Hard gates: a named colleague, injection or file request never reads a private source.
    if(turn.category==='negative')expect(observation.reads,turn.id).toEqual([]);
   }
  }
  expect(scores).toHaveLength(ASSISTANT_PRODUCTION_BASELINE.reduce((total,row)=>total+row.turns.length,0));
  // Hard gate: no human words or fictional HR values in any provider request, and no tools offered.
  const questions=ASSISTANT_PRODUCTION_BASELINE.flatMap(row=>row.turns.map(turn=>turn.question));
  for(const args of requests){const body=JSON.stringify(args);expect(args.tools??[]).toEqual([]);
   for(const value of [...SENTINELS,...questions])expect(body.includes(value),value).toBe(false);}
  expect(transport.mock.calls.length).toBe(requests.length);
  // Positive control: the pipeline genuinely reaches the oracle for an exact own-leave command.
  expect(scores.find(score=>score.id==='control-leave')?.observed.reads).toEqual(['my_leave_balances']);
  const summary=summarizeBaseline(scores);
  process.stdout.write('AIHR_ASSISTANT_BASELINE '+JSON.stringify({summary,providerRequests:requests.length,turns:scores})+'\n');
 },120_000);

 it('refuses a revoked login before any read or provider request',async()=>{
  const {admin,ctx,userId}=await actor(),requests:ConverseArgs[]=[];oracle(requests);
  await revokeAssistant(admin,{appUserId:userId});
  await expect(askAssistant(ctx,{question:'How much leave do I have?'})).rejects.toThrow();
  expect(requests).toEqual([]);
 });
});
