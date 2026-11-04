/** AI v2 R8 (where the seconds go): one live-chat turn through the production path, timed phase by phase, on fictional
 * data. The path and its setup are those of test/teras-conversation-turn.test.ts: the real switch and permit, the
 * tenant's provider resolved and admitted by the real gateway (allowances, question budget, spend root, the reviewed
 * `teras_harness_turn_v1` binding), the real native owners as tools, the Postgres task-memory store, the outcome record,
 * the retired accounting row and the stored chat. Only the provider adapter's network call is scripted, and it answers
 * at once, so every number here is the product's own server time WITHOUT the model. Model time is measured separately
 * by test/assistant-turn-timing.eval.test.ts against the real model.
 *
 * HOW IT TIMES. Each phase owner is wrapped, never replaced: the wrapper calls the real function with the same
 * arguments and returns its result unchanged, recording only the phase name and the milliseconds. Nothing the turn
 * reads, sends, checks or records changes, and each scripted turn asserts its own reply and reads, so a refused or
 * short-circuited turn cannot pass as a fast one. Spans carry phase names, tool names and counts only: no question,
 * reply, id or figure.
 *
 * Output: teras-turn-timing.json in the uploaded evidence folder and one AIHR_TERAS_TURN_TIMING line. The provider-data
 * review lookup is isolated exactly as in test/teras-conversation-turn.test.ts; no approval is claimed by this file. */
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

type Span=Readonly<{scenario:string;run:number;phase:string;ms:number}>;
const timing=vi.hoisted(()=>{
 const spans:Span[]=[];const state={scenario:'',run:0,on:false};
 const record=(phase:string,ms:number)=>{if(state.on)spans.push({scenario:state.scenario,run:state.run,phase,ms:Math.round(ms*100)/100});};
 // Times the real owner and returns its result unchanged; `this` is passed through for prototype methods.
 function wrap<A extends unknown[],R>(phase:string,fn:(...args:A)=>Promise<R>){
  return async function(this:unknown,...args:A):Promise<R>{const started=performance.now();try{return await fn.apply(this,args);}finally{record(phase,performance.now()-started);}};
 }
 return{spans,state,record,wrap};
});
const review=vi.hoisted(()=>({approved:true}));
vi.mock('../lib/ai/provider-data-reviews',async original=>{const actual=await original<typeof import('../lib/ai/provider-data-reviews')>();
 return{...actual,providerDataReviewStatus:(contractId:string)=>contractId==='teras_harness_turn_v1'?(review.approved?'approved':'pending'):actual.providerDataReviewStatus(contractId),
  assertProviderDataContractReviewed:(contractId:string,digest:string)=>{if(contractId==='teras_harness_turn_v1'&&review.approved)return;actual.assertProviderDataContractReviewed(contractId,digest);}};});
// getScopeIds reads the company-scope cookie; outside a request there is none, which is the default "all allowed".
vi.mock('next/headers',()=>({cookies:async()=>({get:()=>undefined}),headers:async()=>new Headers()}));
vi.mock('../core/ai-config',async original=>{const actual=await original<typeof import('../core/ai-config')>();
 return{...actual,resolveActiveAiConfig:timing.wrap('admission.resolve_config',actual.resolveActiveAiConfig)};});
vi.mock('../core/ai-spend-task',async original=>{const actual=await original<typeof import('../core/ai-spend-task')>();
 return{...actual,bindAiSpendTaskTx:timing.wrap('admission.question_budget',actual.bindAiSpendTaskTx)};});
vi.mock('../core/ai-governance',async original=>{const actual=await original<typeof import('../core/ai-governance')>();
 return{...actual,preparePrivateAiTask:timing.wrap('model.prepare_private_task',actual.preparePrivateAiTask)};});
vi.mock('../lib/ai',async original=>{const actual=await original<typeof import('../lib/ai')>();
 return{...actual,converse:timing.wrap('model.gateway_converse',actual.converse)};});
vi.mock('../core/harness/runner',async original=>{const actual=await original<typeof import('../core/harness/runner')>();
 return{...actual,runTurn:timing.wrap('harness.run_turn',actual.runTurn)};});
vi.mock('../core/harness/trace-persistence',async original=>{const actual=await original<typeof import('../core/harness/trace-persistence')>();
 return{...actual,persistTurnTrace:timing.wrap('record.outcome_record',actual.persistTurnTrace)};});
// The production store (core/teras-wiring/turn.ts builds it per turn), with its real load and save timed.
vi.mock('../core/harness/task-memory-store',async original=>{const actual=await original<typeof import('../core/harness/task-memory-store')>();
 class TimedPostgresTaskMemoryStore extends actual.PostgresTaskMemoryStore{
  override load(...args:Parameters<InstanceType<typeof actual.PostgresTaskMemoryStore>['load']>){return timing.wrap('harness.memory_load',(...a:typeof args)=>super.load(...a))(...args);}
  override save(...args:Parameters<InstanceType<typeof actual.PostgresTaskMemoryStore>['save']>){return timing.wrap('harness.memory_save',(...a:typeof args)=>super.save(...a))(...args);}
 }
 return{...actual,PostgresTaskMemoryStore:TimedPostgresTaskMemoryStore};});
// The offer is built by the real provider; each binding keeps every field and its real run, timed under its tool name.
vi.mock('../core/harness/tools',async original=>{const actual=await original<typeof import('../core/harness/tools')>();
 return{...actual,nativeToolProvider:async(...args:Parameters<typeof actual.nativeToolProvider>)=>{
  const started=performance.now(),candidates=await actual.nativeToolProvider(...args);timing.record('harness.offer_build',performance.now()-started);
  return Object.freeze({...candidates,bindings:Object.freeze(candidates.bindings.map(binding=>Object.freeze({...binding,run:timing.wrap('tool.'+binding.name,binding.run)})))});}};});

import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {conversationRoute} from '../core/teras-wiring/switch';
import {runConversationTurn} from '../core/teras-wiring/turn';
import {recordChatTurn} from '../core/teras-chats';
import {assistantBrowserConversationScope} from '../app/assistant/conversation-scope';
import {encryptSecret} from '../lib/ai/crypto';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import type {ConverseResult} from '../lib/ai/types';
import {todayInKualaLumpur} from '../lib/hr-date';
import {seedGuides} from '../db/seed-guides';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

const RUNS=7,WARMUP=1,CONCURRENT=4;
type Persona='employee'|'manager'|'hr_admin';
type Step=()=>Partial<ConverseResult>;
const call=(name:string,input:Record<string,unknown>={}):Partial<ConverseResult>=>({toolCalls:[{id:'p-'+randomUUID().slice(0,8),name,input}],stop:'tool_use'});
const calls=(...rows:readonly [string,Record<string,unknown>][]):Partial<ConverseResult>=>({toolCalls:rows.map(([name,input])=>({id:'p-'+randomUUID().slice(0,8),name,input})),stop:'tool_use'});
const final=(reply:string,mode='answer'):Partial<ConverseResult>=>call('final_answer',{mode,slot:null,reply});
/** Turn shapes seen in the scored evaluation (run 41534700953: 2 to 4 model steps, mostly one call per step, the context
 * tools most called), each with the reads it must report. */
const SCENARIOS:readonly Readonly<{id:string;persona:Persona;question:string;steps:readonly Step[];reads:readonly string[]}>[]=[
 {id:'hello.1-step',persona:'employee',question:'Hello',steps:[()=>final('Hello. Ask me about your leave, payslips or how to do something.','social')],reads:[]},
 {id:'leave-balance.2-step',persona:'employee',question:'How much annual leave do I have?',steps:[()=>call('my_leave_balances'),()=>final('Your leave balances are listed on your leave page.')],reads:['my_leave_balances']},
 {id:'how-to-apply.3-step',persona:'employee',question:'How do I apply for leave?',steps:[()=>call('available_actions'),()=>call('product_destinations'),()=>final('Open Leave and choose Apply.','guide')],reads:['available_actions','product_destinations']},
 {id:'how-to-apply.2-step-batched',persona:'employee',question:'How do I apply for leave?',steps:[()=>calls(['available_actions',{}],['product_destinations',{}]),()=>final('Open Leave and choose Apply.','guide')],reads:['available_actions','product_destinations']},
 {id:'guidance.2-step',persona:'employee',question:'How does overtime work here?',steps:[()=>call('product_guidance',{query:'overtime'}),()=>final('The overtime guide explains it.','guide')],reads:['product_guidance']},
 {id:'pending-for-me.2-step',persona:'manager',question:'What is pending for me?',steps:[()=>call('approval_queue'),()=>final('One leave request is waiting for your decision.')],reads:['approval_queue']},
 {id:'setup-readiness.2-step',persona:'hr_admin',question:'Is our payroll ready to run?',steps:[()=>call('setup_readiness'),()=>final('Some records still need details before payroll.')],reads:['setup_readiness']},
];

let b:Base;const people={} as Record<Persona,SessionContext>;
async function hire(base:Base,name:string,role:Persona){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:userId});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:hired.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'17.25',effectiveOn:todayInKualaLumpur()});
 return{ctx:{...await entitledCtx(base,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} as SessionContext,employmentId:hired.employmentId};
}
function script(steps:readonly Step[]){
 let index=0;
 return vi.spyOn(openrouterAdapter,'converse').mockImplementation(async()=>{const started=performance.now(),step=steps[index++]??(()=>final('Script ended.'));
  const result={text:'',toolCalls:[],stop:'tool_use' as const,usage:{inputTokens:120,outputTokens:30,cachedInputTokens:0},usageReported:true,...step()};
  timing.record('model.adapter_scripted',performance.now()-started);return result;});
}
/** One turn exactly as the chat command runs it (app/assistant/launcher-actions.ts askFromLauncherAction and
 * askThroughHarness), minus rendering: scope, switch, the turn, then the stored chat. */
async function chatCommandTurn(ctx:SessionContext,question:string){
 const started=performance.now(),phase=async<T>(name:string,work:()=>Promise<T>)=>timing.wrap(name,work)();
 const conversationScope=await phase('request.conversation_scope',()=>assistantBrowserConversationScope(ctx));
 const route=await phase('request.switch_and_permit',()=>conversationRoute(ctx));
 if(route.route!=='harness')throw Error('Expected the harness route.');
 const turn=await phase('turn.run_conversation_turn',()=>runConversationTurn(ctx,route,{question,companyId:b.companyId,locale:'en'}));
 const chatId=await phase('record.stored_chat',()=>recordChatTurn(ctx,{conversationId:turn.trace.conversationId,conversationScope,companyId:b.companyId,question,reply:turn.reply,
  modelRows:turn.modelTurn.map(row=>({role:row.role,content:row.content})),withheld:turn.sensitive||turn.refused}));
 timing.record('total.server_without_model_or_render',performance.now()-started);
 return{turn,chatId};
}

beforeAll(migrateTestDb);afterAll(closeAll);
afterEach(()=>{vi.restoreAllMocks();});
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-timing-passphrase-0123456789');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-timing-proposal-secret-0123456789abcdef');
 await resetDb();b=await seedBase();for(const code of ['assistant','claims','notifications'])await setModule(b.tenantId,code,'active');
 await seedGuides(owner.db,b.tenantId);
 await seedEntitlement(adminCtx(b),{leaveTypeId:b.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});
 people.hr_admin=(await hire(b,'Fictional Timing Administrator','hr_admin')).ctx;
 people.employee=(await hire(b,'Fictional Timing Employee','employee')).ctx;
 const boss=await hire(b,'Fictional Timing Manager','manager');people.manager=boss.ctx;
 const applicant=await hire(b,'Fictional Timing Applicant','employee');
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:applicant.employmentId,managerEmploymentId:boss.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));
 await requestLeave(applicant.ctx,{employmentId:applicant.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:next.toISOString().slice(0,10),endDate:next.toISOString().slice(0,10),durationType:'full_day',reason:'Fictional timing reason'});
 await setWorkerSwitch(people.hr_admin,{workerId:'conversation',enabled:true});
 await owner.db.insert(schema.aiProviderConfig).values({tenantId:b.tenantId,provider:'openrouter',model:'fictional/model',apiKeyCiphertext:encryptSecret('fictional-no-network-key',b.tenantId),keyLast4:'-key',isActive:true,
  providerOptions:{version:1,routing:{allowedProviders:['azure'],allowFallbacks:false,sort:'latency'}}});
});

const quantile=(values:readonly number[],q:number)=>{if(!values.length)return null;const sorted=[...values].sort((x,y)=>x-y);
 const at=(sorted.length-1)*q,low=Math.floor(at),high=Math.ceil(at);return Math.round((sorted[low]+(sorted[high]-sorted[low])*(at-low))*10)/10;};
/** Per scenario and phase: how often the phase ran per turn, and the median and p90 of its per-turn total. */
function summarise(spans:readonly Span[]){
 const out:Record<string,Record<string,{perTurn:number;p50:number|null;p90:number|null}>>={};
 for(const scenario of [...new Set(spans.map(span=>span.scenario))]){
  const mine=spans.filter(span=>span.scenario===scenario&&span.run>=WARMUP),runs=[...new Set(mine.map(span=>span.run))];
  out[scenario]={};
  for(const phase of [...new Set(mine.map(span=>span.phase))].sort()){
   const totals=runs.map(run=>mine.filter(span=>span.run===run&&span.phase===phase).reduce((sum,span)=>sum+span.ms,0));
   const count=mine.filter(span=>span.phase===phase).length/Math.max(1,runs.length);
   out[scenario][phase]={perTurn:Math.round(count*10)/10,p50:quantile(totals,0.5),p90:quantile(totals,0.9)};
  }
 }
 return out;
}

describe('where the server time of one live-chat turn goes, without the model',()=>{
 it('times every phase of the production path for each turn shape, and four turns at once',async()=>{
  // Warm the module graph and the database plans once, outside the record.
  script(SCENARIOS[1].steps);await chatCommandTurn(people.employee,SCENARIOS[1].question);vi.restoreAllMocks();
  timing.state.on=true;
  for(const scenario of SCENARIOS)for(let run=0;run<RUNS;run++){
   timing.state.scenario=scenario.id;timing.state.run=run;
   script(scenario.steps);
   const {turn,chatId}=await chatCommandTurn(people[scenario.persona],scenario.question);
   vi.restoreAllMocks();
   // The measured path really ran: the scripted reply, the expected reads, a stored chat and an outcome record.
   expect(turn.fallback,scenario.id).toBe(false);
   expect(turn.reads,scenario.id).toEqual(scenario.reads);
   expect(turn.trace.budgets.steps,scenario.id).toBe(scenario.steps.length);
   expect(chatId,scenario.id).toMatch(/^[0-9a-f-]{36}$/);
  }
  // Four people's turns at once on one database, as in the scored evaluation's concurrency.
  timing.state.scenario='leave-balance.2-step.x4-concurrent';
  for(let run=0;run<RUNS;run++){
   timing.state.run=run;
   // Each turn's first call reads and its second answers, decided by that turn's own request: no tool result yet means first.
   vi.spyOn(openrouterAdapter,'converse').mockImplementation(async(_cfg,args)=>({text:'',toolCalls:[],stop:'tool_use',usage:{inputTokens:120,outputTokens:30,cachedInputTokens:0},usageReported:true,
    ...(args.turns.some(row=>row.role==='tool')?final('Your leave balances are listed on your leave page.'):call('my_leave_balances'))}));
   const started=performance.now();
   const turns=await Promise.all(Array.from({length:CONCURRENT},()=>chatCommandTurn(people.employee,'How much annual leave do I have?')));
   timing.record('total.four_turns_wall',performance.now()-started);
   vi.restoreAllMocks();
   for(const row of turns){expect(row.turn.reads).toEqual(['my_leave_balances']);expect(row.turn.fallback).toBe(false);}
  }
  timing.state.on=false;

  const summary=summarise(timing.spans);
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'teras-turn-timing.json'),JSON.stringify({kind:'teras.turn-timing',version:1,runs:RUNS,warmup:WARMUP,concurrent:CONCURRENT,
   note:'Server time of the production chat path with the provider adapter scripted to answer at once; model time is not included.',
   ...(process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID}:{}),summary,spans:timing.spans},null,1));
  process.stdout.write('AIHR_TERAS_TURN_TIMING '+JSON.stringify(Object.fromEntries(Object.entries(summary).map(([scenario,phases])=>[scenario,Object.fromEntries(Object.entries(phases).map(([phase,row])=>[phase,row.p50]))])))+'\n');
  // Every scenario produced its spans, including the one each phase owner records.
  for(const scenario of SCENARIOS){
   expect(Object.keys(summary[scenario.id]??{})).toEqual(expect.arrayContaining(['request.switch_and_permit','admission.resolve_config','harness.run_turn','harness.offer_build','harness.memory_load','harness.memory_save','record.outcome_record','record.stored_chat','model.gateway_converse']));
   for(const read of scenario.reads)expect(summary[scenario.id]['tool.'+read]?.perTurn,scenario.id+' '+read).toBe(1);
  }
  expect(summary['leave-balance.2-step.x4-concurrent']['total.four_turns_wall'].p50).toBeGreaterThan(0);
 },240_000);
});
