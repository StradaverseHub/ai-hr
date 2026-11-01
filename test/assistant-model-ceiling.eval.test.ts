/** Real-model REDESIGN CEILING probe on fictional data (Assistant conversational phase 1). Skipped
 * unless the protected evaluation secret is present, so ordinary CI never calls a model.
 *
 * This is NOT the production path and NOT an approved egress contract. Since ADR-0170 step 1 every turn runs
 * through the product turn harness (core/harness/runner.ts): its gate, offer, budgets, retries, per-call
 * authorisation, semantic-model disclosure, fencing, reply checks, restoration, task memory and trace. The
 * model may call the caller-authorized Assistant reads (executed by their real owners on the fictional test
 * database), the phase-B context tools and suggest_action, and must finish with final_answer. The model
 * client is supplied HERE, from test code: it calls OpenRouter directly, with data collection denied and
 * zero retention required, so no provider code enters the product. Nothing touches tenant configuration,
 * governance ledgers or promotion. Only fictional records exist.
 * The corpus runs in AIHR_EVAL_REPEATS concurrent passes (default 3) so single-run variance is measured, not guessed. */
import {randomUUID} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {join,relative} from 'node:path';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {seedGuides} from '../db/seed-guides';
import {actionCatalogueFor} from '../core/product-context/actions';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {HarnessMessage,ModelClient,ModelResponse} from '../core/harness/model-client';
import {overclaim,scoreBehaviour,summarizeBehaviour,type BehaviourScore} from './assistant-behaviour-score';
import {REVIEWED_OUTCOMES} from './assistant-corpus-review';
import {setReportingLine} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ASSISTANT_COMPLEX_BASELINE,ASSISTANT_PARITY_ACTIONS,ASSISTANT_PRODUCTION_BASELINE,conversationRun,scoreBaselineTurn,summarizeBaseline,type BaselineObservation,type BaselineScore} from './assistant-production-baseline-corpus';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
const KEY=process.env.AIHR_EVAL_OPENROUTER_KEY?.trim(),MODEL=process.env.AIHR_EVAL_MODEL?.trim();
const BUDGET=Math.min(50,Number(process.env.AIHR_EVAL_BUDGET_USD??'20')||20),REPEATS=Math.max(1,Math.min(5,Math.trunc(Number(process.env.AIHR_EVAL_REPEATS??'3'))||3));
// About 200 calls per pass; the dollar cap still governs.
const MAX_CALLS=Math.min(1500,Number(process.env.AIHR_EVAL_MAX_CALLS??String(250*REPEATS))||250*REPEATS);
const ALLOWED=(process.env.AIHR_EVAL_ALLOWED_PROVIDERS??'').split(',').map(value=>value.trim()).filter(Boolean);
/** PRODUCT CONTEXT comes from the phase-B owners (core/product-context): the destination registry, the
 * tenant's published guides and the minimized setup-readiness summary, all run as the caller. */
function routes(directory=join(process.cwd(),'app')):RegExp[]{
 const found:RegExp[]=[];const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())walk(path);else if(entry.name==='page.tsx'){const route='/'+relative(directory,dir).split('/').filter(part=>part&&!/^\(.*\)$/.test(part)).join('/');
   found.push(new RegExp('^'+route.replace(/\/$/,'').replace(/\[\[?\.\.\.[^\]]+\]?\]/g,'.+').replace(/\[[^\]]+\]/g,'[^/]+')+'/?$'));}}};
 walk(directory);return found;}
const ROUTES=routes();
/** Any product path in a reply that is not a real page is an invented link (deterministic hard finding). */
const inventedLinks=(reply:string)=>[...reply.matchAll(/(?:^|[\s(`"'])(\/[a-z][a-z0-9-]*(?:\/[a-z0-9-[\]]+)*)/g)].map(match=>match[1].split(/[?#]/)[0])
 .filter(path=>!ROUTES.some(route=>route.test(path)));
let base:Base;let spentUsd=0,calls=0;
const ledger:{pass:number;conversation:string;turn:string;question:string;gate?:string;mode:string|null;reads:string[];proposed:string|null;reply:string;usd:number;steps:number;inventedLinks?:string[];truncated?:number;error?:string;
 /** Harness outcomes: reply-check failures (before any retry), whether the shown reply is the spec fallback, and the spec version. */
 checkFailures?:string[];fallback?:boolean;budgetExhausted?:string|null;undeclaredRemoved?:number;spec?:number}[]=[];
beforeAll(migrateTestDb);afterAll(closeAll);
// The optional pay and notification modules are switched on so a missing suggestion measures the model, not the fixture.
const MODULES=['assistant','claims','notifications','multi_cycle_payroll','typed_pay_components'];
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-ceiling-passphrase');await resetDb();base=await seedBase();for(const code of MODULES)await setModule(base.tenantId,code,'active');await seedGuides(owner.db,base.tenantId);});
async function fixtures(){
 const admin=adminCtx(base),[medical]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true}).returning({id:schema.leaveType.id});
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Baseline Actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const siti=await hireEmployee(admin,{person:{fullName:'Siti Fictional',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 for(const [leaveTypeId,days] of [[base.annualLeaveTypeId,'17.25'],[medical.id,'11.5']] as const)await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});
 for(const days of [9,40])await owner.db.insert(schema.holiday).values({tenantId:base.tenantId,country:'MY',holidayDate:todayInKualaLumpur(new Date(Date.now()+days*86400000)),name:'Fictional Holiday '+days});
 const employeeUser=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:employeeUser});
 const employee:SessionContext={...await entitledCtx(base,['employee']),userId:employeeUser,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const person=await hireEmployee(admin,{person:{fullName:'Fictional New Admin',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const adminUser=await createAppUser(base.tenantId,person.personId,'hr_admin');await grantAssistant(admin,{appUserId:adminUser});
 // The administrator has real assigned work: Siti reports to them and has one pending leave request.
 await setReportingLine(admin,{subordinateEmploymentId:siti.employmentId,managerEmploymentId:person.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:siti.employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'10',effectiveOn:todayInKualaLumpur()});
 let leaveDate=todayInKualaLumpur(new Date(Date.now()+5*86400000));while([0,6].includes(new Date(leaveDate+'T12:00:00Z').getUTCDay()))leaveDate=todayInKualaLumpur(new Date(Date.parse(leaveDate+'T12:00:00Z')+86400000));
 const sitiCtx:SessionContext={...await entitledCtx(base,['employee']),userId:await createAppUser(base.tenantId,siti.personId,'employee'),personId:siti.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 await requestLeave(sitiCtx,{employmentId:siti.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:leaveDate,endDate:leaveDate});
 const hr:SessionContext={...await entitledCtx(base,['hr_admin']),userId:adminUser,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 return{employee,hr};
}
type Message={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:unknown[];tool_call_id?:string};
const wire=(message:HarnessMessage):Message=>message.role==='tool'?{role:'tool',tool_call_id:message.toolCallId,content:message.content}
 :message.role==='assistant'?{role:'assistant',content:message.content,...(message.toolCalls?.length?{tool_calls:message.toolCalls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}))}:{})}
 :{role:message.role,content:message.content};
/** The evaluation's own OpenRouter client, handed to the product harness. Global call and spend caps apply across passes. */
const openRouter:ModelClient={get modelId(){return MODEL??'';},async complete(request){
 if(calls>=MAX_CALLS||spentUsd>=BUDGET)throw Error('evaluation_budget_exhausted');calls++;
 const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',signal:request.signal,
  headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},
  body:JSON.stringify({model:MODEL,messages:request.messages.map(wire),tools:request.tools.map(tool=>({type:'function',function:tool})),tool_choice:request.toolChoice,
   max_tokens:request.maxOutputTokens,usage:{include:true},provider:{data_collection:'deny',zdr:true,...(ALLOWED.length?{only:ALLOWED,allow_fallbacks:false}:{})}})});
 const body=await response.json() as {choices?:{finish_reason?:string;message?:{content?:string|null;tool_calls?:{id:string;function:{name:string;arguments:string}}[]}}[];usage?:{cost?:number;prompt_tokens?:number;completion_tokens?:number};error?:{message?:string}};
 const cost=typeof body.usage?.cost==='number'?body.usage.cost:0;spentUsd+=cost;
 if(!response.ok||!body.choices?.[0]?.message)throw Error('provider_'+response.status);
 const message=body.choices[0].message,finish=body.choices[0].finish_reason;
 return{content:message.content??null,toolCalls:(message.tool_calls??[]).map(call=>({id:call.id,name:call.function.name,arguments:call.function.arguments??''})),
  finish:(finish==='length'||finish==='tool_calls'||finish==='stop'?finish:'other') as ModelResponse['finish'],
  usage:{inputTokens:body.usage?.prompt_tokens??0,outputTokens:body.usage?.completion_tokens??0,costUsd:cost}};
}};
/** Context tools that hold nothing about the person; the only ones a gated turn keeps. */
const PUBLIC_CONTEXT=new Set(['product_destinations','product_guidance','available_actions']);
/** One person turn through the product harness. `conversationId` keys its task memory. */
async function turn(ctx:SessionContext,history:Message[],question:string,companyId:string,conversationId:string,memory:InMemoryTaskMemoryStore){
 const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId,question,scope:{companyId,locale:'en'},model:openRouter,memory,
  history:history.filter((row):row is Message&{role:'user'|'assistant';content:string}=>(row.role==='user'||row.role==='assistant')&&typeof row.content==='string')});
 const trace=result.trace;
 return{mode:result.mode,slot:result.slot??undefined,reply:result.reply,reads:[...result.reads],proposed:result.suggestion?.action??null,usd:trace.budgets.spendUsd,steps:trace.budgets.steps,
  truncated:trace.retries.filter(row=>row.reason==='truncated'||row.reason==='blank').length,gate:trace.gate.privateReads?'open':trace.gate.reason??'open',
  checkFailures:trace.checks.flatMap(row=>row.results.filter(check=>!check.ok).map(check=>check.check+': '+(check.finding??''))),fallback:trace.outcome.fallback,
  budgetExhausted:trace.budgets.exhausted,undeclaredRemoved:trace.disclosure.reduce((sum,row)=>sum+row.undeclared.length,0),spec:trace.spec.version};
}
// Ordinary suites reject skipped assertions, so without the protected secret this proves the probe is inert.
describe('real-model redesign ceiling on fictional data',()=>{
 // Registered conditionally (not runIf/skipIf) so neither mode reports a skipped assertion.
 if(!KEY||!MODEL)it('stays disabled and calls no provider without the protected evaluation secret',()=>{
  expect(Boolean(KEY&&MODEL)).toBe(false);expect(calls).toBe(0);
 });
 else it('runs every corpus in repeated concurrent passes under a hard spend cap',async()=>{
  const {employee,hr}=await fixtures(),catalogues={employee:(await actionCatalogueFor(employee)).map(row=>row.id),admin:(await actionCatalogueFor(hr)).map(row=>row.id)};
  const conversations=[...ASSISTANT_PRODUCTION_BASELINE,...ASSISTANT_COMPLEX_BASELINE,...ASSISTANT_PARITY_ACTIONS];
  /** One full pass. Every tool here is read-only, so passes share the fixture and run concurrently. */
  async function pass(index:number){
   const breaches:{pass:number;turn:string;plan:string|null;reads:readonly string[]}[]=[],scores:BaselineScore[]=[],runs:Record<string,ReturnType<typeof conversationRun>>={};
   for(const conversation of conversations){
    const ctx=conversation.persona==='admin'?hr:employee,rows:BaselineScore[]=[],memory=new InMemoryTaskMemoryStore();let history:Message[]=[],conversationId=randomUUID();
    for(const item of conversation.turns){
     if(!item.continues){history=[];conversationId=randomUUID();}let observation:BaselineObservation;
     try{const result=await turn(ctx,history,item.question,base.companyId,conversationId,memory);
      observation={plan:result.proposed&&result.mode!=='refuse'?{mode:'propose',action:result.proposed}:result.mode?{mode:result.mode==='honest_gap'?'insufficient':result.mode,...(result.slot?{slot:result.slot}:{})}:null,reads:result.reads,providerCalls:result.steps};
      ledger.push({pass:index,conversation:conversation.id,turn:item.id,question:item.question,gate:result.gate,mode:result.mode,reads:result.reads,proposed:result.proposed,reply:result.reply.slice(0,1200),usd:result.usd,steps:result.steps,truncated:result.truncated,inventedLinks:inventedLinks(result.reply),
       checkFailures:result.checkFailures,fallback:result.fallback,budgetExhausted:result.budgetExhausted,undeclaredRemoved:result.undeclaredRemoved,spec:result.spec});
      history=[...history,{role:'user',content:item.question},{role:'assistant',content:result.reply}];
     }catch(error){observation={plan:null,reads:[],providerCalls:0,error:(error as Error).message};ledger.push({pass:index,conversation:conversation.id,turn:item.id,question:item.question,mode:null,reads:[],proposed:null,reply:'',usd:0,steps:0,error:(error as Error).message});}
     const score=scoreBaselineTurn(item,observation);rows.push(score);scores.push(score);
     // Hard gates: a negative never yields a proposed effect, and the fixed pre-read gate leaves it no private read.
     // Collected and asserted after the ledger is printed, so a breach keeps its evidence.
     if(item.category==='negative'&&(observation.plan?.mode==='propose'||observation.reads.some(read=>!PUBLIC_CONTEXT.has(read))))breaches.push({pass:index,turn:item.id,plan:observation.plan?.mode??null,reads:observation.reads});
     if(spentUsd>=BUDGET)break;
    }
    runs[conversation.id]=conversationRun(rows);if(spentUsd>=BUDGET)break;
   }
   return{breaches,scores,runs};
  }
  const passes=await Promise.all(Array.from({length:REPEATS},(_,index)=>pass(index)));
  const breaches=passes.flatMap(row=>row.breaches),ids=conversations.flatMap(conversation=>conversation.turns.map(item=>item.id));
  // Stability: how many passes understood each turn. Only turns every pass completed are compared.
  const perTurn=ids.map(id=>{const rows=passes.map(row=>row.scores.find(score=>score.id===id)).filter(Boolean) as BaselineScore[];return{id,passes:rows.length,understood:rows.filter(score=>score.understood).length};});
  const group=(filter:(id:string)=>boolean)=>{const rows=perTurn.filter(row=>filter(row.id)&&row.passes===REPEATS);
   const totals=passes.map((_,index)=>passes[index].scores.filter(score=>filter(score.id)&&score.understood).length);
   return{turns:rows.length,perPass:totals,always:rows.filter(row=>row.understood===REPEATS).length,sometimes:rows.filter(row=>row.understood>0&&row.understood<REPEATS).length,never:rows.filter(row=>row.understood===0).length,
    flaky:rows.filter(row=>row.understood>0&&row.understood<REPEATS).map(row=>row.id),never_ids:rows.filter(row=>row.understood===0).map(row=>row.id)};};
  const parity=new Set(ASSISTANT_PARITY_ACTIONS.flatMap(conversation=>conversation.turns.map(item=>item.id)));
  // Behaviour scoring ignores the model's own mode label (test/assistant-behaviour-score.ts); the baseline label
  // score above is kept for comparison with earlier runs.
  const turnById=new Map(conversations.flatMap(conversation=>conversation.turns).map(item=>[item.id,item]));
  const behaviourOf=(reviewed:boolean):BehaviourScore[][]=>passes.map((_,index)=>ledger.filter(row=>row.pass===index).map(row=>scoreBehaviour(turnById.get(row.turn)!,{reads:row.reads,proposed:row.proposed,reply:row.reply,inventedLinks:row.inventedLinks??[],error:row.error},reviewed?REVIEWED_OUTCOMES[row.turn]:undefined)));
  const behaviourGroup=(behaviour:BehaviourScore[][],filter:(id:string)=>boolean)=>{const rows=behaviour.map(scores=>scores.filter(score=>filter(score.id)));
   const met=(id:string)=>rows.filter(scores=>scores.find(score=>score.id===id)?.verdict==='met').length,ids=[...new Set(rows.flat().map(score=>score.id))];
   return{perPass:rows.map(scores=>summarizeBehaviour(scores)),always:ids.filter(id=>met(id)===REPEATS).length,sometimes:ids.filter(id=>met(id)>0&&met(id)<REPEATS),
    never:ids.filter(id=>met(id)===0).map(id=>id+': '+rows[0].find(score=>score.id===id)?.reason),failed:rows.flat().filter(score=>score.verdict==='failed').map(score=>score.id+': '+score.reason)};};
  const stability={repeats:REPEATS,behaviour:{corpusIdeals:{original:behaviourGroup(behaviourOf(false),id=>!parity.has(id)),parity:behaviourGroup(behaviourOf(false),id=>parity.has(id))},
   reviewedIdeals:{original:behaviourGroup(behaviourOf(true),id=>!parity.has(id)),parity:behaviourGroup(behaviourOf(true),id=>parity.has(id))}},original:group(id=>!parity.has(id)),parity:group(id=>parity.has(id)),
   blankReplies:ledger.filter(row=>!row.reply).length,fallbackReplies:ledger.filter(row=>row.fallback).length,checkFailures:ledger.flatMap(row=>(row.checkFailures??[]).map(failure=>row.pass+':'+row.turn+': '+failure)),truncationRetries:ledger.reduce((sum,row)=>sum+(row.truncated??0),0),errors:ledger.filter(row=>row.error).map(row=>row.pass+':'+row.turn+':'+row.error)};
  const guidance=ledger.filter(row=>passes[row.pass].scores.find(score=>score.id===row.turn)?.ideal.mode==='guide');
  const context={inventedLinks:ledger.flatMap(row=>row.inventedLinks??[]),overclaims:ledger.flatMap(row=>{const claim=overclaim(row.reply);return claim?[row.pass+':'+row.turn+': '+claim]:[];}),guidanceTurns:guidance.length,
   guidanceGroundedInProduct:guidance.filter(row=>row.reads.some(read=>['product_guidance','setup_readiness','product_destinations'].includes(read))).length,routes:ROUTES.length};
  process.stdout.write('AIHR_ASSISTANT_MODEL_CEILING '+JSON.stringify({variant:'teras_harness_v'+(ledger.find(row=>row.spec)?.spec??'?'),stability,context,catalogues,negativeGateBreaches:breaches,model:MODEL,allowedProviders:ALLOWED,budgetUsd:BUDGET,spentUsd:Number(spentUsd.toFixed(4)),calls,
   summaries:passes.map(row=>summarizeBaseline(row.scores)),runs:passes.map(row=>row.runs),turns:passes.map(row=>row.scores),ledger})+'\n');
  expect(passes.every(row=>row.scores.length>0)).toBe(true);expect(breaches).toEqual([]);
  // A run whose model calls mostly failed measured nothing; it must not read as a pass (run 41283142733: 222 provider_400, $0).
  const failedTurns=ledger.filter(row=>row.error).length;expect(failedTurns,'turns that errored').toBeLessThanOrEqual(Math.floor(ledger.length*0.05));
 },1_800_000);
});
