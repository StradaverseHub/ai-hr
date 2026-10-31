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
import {ASSISTANT_COMPLEX_BASELINE,ASSISTANT_PRODUCTION_BASELINE,conversationRun,scoreBaselineTurn,summarizeBaseline,type BaselineObservation,type BaselineScore} from './assistant-production-baseline-corpus';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-baseline-passphrase');vi.stubEnv('OPENAI_API_KEY','fictional-baseline-never-sent');
 for(const key of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');});
// Distinctive fictional values: none may ever appear in a provider request.
const SENTINELS=['Fictional Baseline Actor','Fictional New Admin','Fictional Holiday','Siti Fictional','17.25','11.5','Medical Leave','Annual Leave'];
/** A human question is present when it appears as an exact JSON string, or verbatim when long enough to
 * be distinctive (a two-letter "Hi" occurs inside ordinary prompt words). Fictional values stay raw. */
const leaks=(body:string,value:string)=>body.includes(JSON.stringify(value))||(value.length>=12&&body.includes(value));
async function actor(medicalType=true){
 const admin=adminCtx(base),medical=medicalType?(await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true}).returning({id:schema.leaveType.id}))[0]:null;
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});if(medical)await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Baseline Actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await hireEmployee(admin,{person:{fullName:'Siti Fictional',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 for(const [leaveTypeId,days] of [[base.annualLeaveTypeId,'17.25'],...(medical?[[medical.id,'11.5']]:[])] as [string,string][])await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});
 const userId=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {admin,ctx,userId};
}
/** A real new administrator: own person record, hr_admin login and an Assistant grant. */
async function adminActor(){
 const admin=adminCtx(base),person=await hireEmployee(admin,{person:{fullName:'Fictional New Admin',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,person.personId,'hr_admin');await grantAssistant(admin,{appUserId:userId});
 return{...await entitledCtx(base,['hr_admin']),userId,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
}
/** Two upcoming national holidays, dated through the HR date owner. */
async function holidays(){for(const days of [9,40]){const date=todayInKualaLumpur(new Date(Date.now()+days*86400000));
 await owner.db.insert(schema.holiday).values({tenantId:base.tenantId,country:'MY',holidayDate:date,name:'Fictional Holiday '+days});}}
/** Oracle reference selector: every available fact/explanation the closed catalogue offers (max 16). */
function oracle(requests:ConverseArgs[]){
 return vi.spyOn(openaiAdapter,'converse').mockImplementation((async(_configuration:unknown,args:ConverseArgs):Promise<ConverseResult>=>{
  requests.push(args);const turn=args.turns[0],catalogue=JSON.parse(turn&&'content'in turn&&typeof turn.content==='string'?turn.content:'{}');
  const blocks:unknown[]=[];for(const read of catalogue.reads??[]){for(const card of read.cards)for(const fact of card.facts)if(fact.available)blocks.push({kind:'fact',read:read.read,card:card.card,fact:fact.fact});
   for(const item of read.explanations)blocks.push({kind:'explanation',read:read.read,card:item.card,code:item.code});}
  const plan=blocks.length?{version:1,mode:'answer',blocks:blocks.slice(0,16)}:{version:1,mode:'insufficient',code:'no_verified_facts'};
  return{text:JSON.stringify(plan),stop:'end',toolCalls:[],usageReported:true,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0}};
 }) as never);
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
   for(const value of SENTINELS)expect(body.includes(value),value).toBe(false);for(const value of questions)expect(leaks(body,value),value).toBe(false);}
  expect(transport.mock.calls.length).toBe(requests.length);
  // Positive control: the pipeline genuinely reaches the oracle for an exact own-leave command.
  expect(scores.find(score=>score.id==='control-leave')?.observed.reads).toEqual(['my_leave_balances']);
  const summary=summarizeBaseline(scores);
  process.stdout.write('AIHR_ASSISTANT_BASELINE '+JSON.stringify({summary,providerRequests:requests.length,turns:scores})+'\n');
 },120_000);

 it('sends only closed ordinal references when an own-leave answer genuinely reaches the provider',async()=>{
  // One leave type, so no type clarification stops the route before the provider: the egress gate is non-vacuous.
  const {ctx}=await actor(false),requests:ConverseArgs[]=[];oracle(requests);const question='How much leave do I have?';
  const {observation}=await observe(ctx,question,null,requests);
  expect(observation.reads).toEqual(['my_leave_balances']);expect(observation.providerCalls).toBe(1);expect(observation.plan?.mode).toBe('answer');
  const body=JSON.stringify(requests[0]);expect(requests[0].tools??[]).toEqual([]);
  for(const value of SENTINELS)expect(body.includes(value),value).toBe(false);expect(leaks(body,question),question).toBe(false);
  process.stdout.write('AIHR_ASSISTANT_BASELINE_EGRESS '+JSON.stringify({providerCalls:observation.providerCalls,plan:observation.plan,requestBytes:Buffer.byteLength(body)})+'\n');
 });

 it('records long-running admin, employee, multi-domain and approver conversations with the same hard gates',async()=>{
  await holidays();const {ctx}=await actor(),adminContext=await adminActor(),requests:ConverseArgs[]=[];oracle(requests);
  const scores:BaselineScore[]=[],runs:Record<string,ReturnType<typeof conversationRun>>={};
  for(const conversation of ASSISTANT_COMPLEX_BASELINE){
   const caller=conversation.persona==='admin'?adminContext:ctx,rows:BaselineScore[]=[];
   let previous:{exchangeId:string;token?:string;clarify:boolean}|null=null;
   for(const turn of conversation.turns){
    const {observation,next}=await observe(caller,turn.question,turn.continues?previous:null,requests);previous=next??previous;
    const score=scoreBaselineTurn(turn,observation);rows.push(score);scores.push(score);
    if(turn.category==='negative')expect(observation.reads,turn.id).toEqual([]);
    // Hard gate: no action request is ever answered by anything but a native proposal card or a non-effect reply.
    if(turn.category==='action')expect(['propose','clarify','insufficient','refuse','answer',undefined],turn.id).toContain(observation.plan?.mode);
   }
   runs[conversation.id]=conversationRun(rows);
  }
  expect(scores).toHaveLength(ASSISTANT_COMPLEX_BASELINE.reduce((total,row)=>total+row.turns.length,0));
  const questions=ASSISTANT_COMPLEX_BASELINE.flatMap(row=>row.turns.map(turn=>turn.question));
  for(const args of requests){const body=JSON.stringify(args);expect(args.tools??[]).toEqual([]);
   for(const value of SENTINELS)expect(body.includes(value),value).toBe(false);for(const value of questions)expect(leaks(body,value),value).toBe(false);}
  process.stdout.write('AIHR_ASSISTANT_COMPLEX_BASELINE '+JSON.stringify({summary:summarizeBaseline(scores),runs,providerRequests:requests.length,turns:scores})+'\n');
 },180_000);

 it('refuses a revoked login before any read or provider request',async()=>{
  const {admin,ctx,userId}=await actor(),requests:ConverseArgs[]=[];oracle(requests);
  await revokeAssistant(admin,{appUserId:userId});
  await expect(askAssistant(ctx,{question:'How much leave do I have?'})).rejects.toThrow();
  expect(requests).toEqual([]);
 });
});
