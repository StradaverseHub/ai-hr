/** "Make it smart" steps 1-2 (NOVERI-AI-CENTRE-HANDOFF §5): the scored AI Centre evaluation, one model per run, on
 * fictional data. Skipped exactly like the ceiling probe without the protected evaluation secret, so ordinary CI never
 * calls a model.
 *
 * ROUTE. Every turn runs through the product turn harness (core/harness/runner.ts runTurn, the current spec) with an
 * OpenRouter client supplied from this file: the direct path of the ceiling probe (run 41367210721), data collection
 * denied, zero retention, the allowed upstreams only and no fallbacks. It does not go through core/teras-wiring/turn.ts,
 * the gateway, the provider-data policy or the production OpenRouter adapter. The provider-data binding for the current
 * spec awaits the owner's approval; this file neither mocks nor rewrites that gate and writes no approval.
 * MEASURES what a model does with the product's instructions, tools, reads (their real owners on the fictional test
 * database), disclosure, reply checks, retries and budgets. DOES NOT MEASURE the production transport's request shape
 * (strict tool schemas, tool_choice auto, require_parameters), gateway admission and spend accounting, the stored
 * conversation, or the screen itself (approximated by the deterministic checks in core/improvement/smart-eval-score.ts).
 *
 * The question set is test/assistant-smart-eval-set.ts: the owner's staging questions reconstructed from the issue list,
 * plus role journeys. Each answer is scored on correctness, usefulness, doing rather than pointing, brevity and clarity,
 * and safety, by deterministic checks and a fixed-rubric judge (JUDGE: model, rubric, reasoning effort and seed are
 * recorded in the output with the rubric's digest). Up to two passes run in order; the second only when the budget
 * left covers it with room to spare, so the first pass is always complete before anything else is spent.
 *
 * Output: assistant-smart-eval.json in the uploaded evidence folder (every answer, its checks, verdict and score) and one
 * AIHR_ASSISTANT_SMART_EVAL summary line. scripts/teras/compare-smart-eval.ts compares runs. Hard assertions are only that
 * the run measured something (the first pass complete, at most 10% errored turns) and that no internal identifier
 * reached the model or a reply; quality and safety scores are reported, not asserted. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,readdirSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {hireEmployee,setReportingLine} from '../core/org';
import {seedGuides} from '../db/seed-guides';
import {HARNESS_TEST_ONLY,routeReply,runTurn,type ModelHistoryMessage} from '../core/harness/runner';
import {HARNESS_SPEC,harnessSpecDigest} from '../core/harness/spec';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {identifiersIn,overclaim} from '../core/harness/reply-checks';
import type {HarnessMessage,ModelClient,ModelResponse} from '../core/harness/model-client';
import {ACTION_PURPOSE} from '../core/product-context/actions';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {explainerFixture} from './explainer-corpus';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
import {JUDGE,JUDGE_SCHEMA,judgeMessages,parseVerdict,scoreTurn,type JudgeVerdict,type SmartEvalObservation,type SmartEvalRole,type SmartEvalTurn} from '../core/improvement/smart-eval-score';
import {summariseSmartRun,type SmartEvalOutput,type SmartEvalRow} from '../scripts/teras/compare-smart-eval';
import {SMART_EVAL_SET} from './assistant-smart-eval-set';

const KEY=process.env.AIHR_EVAL_OPENROUTER_KEY?.trim(),MODEL=process.env.AIHR_EVAL_MODEL?.trim();
/** The programme's per-run cap is USD 10, whatever the workflow input says. */
const BUDGET=Math.min(10,Number(process.env.AIHR_EVAL_BUDGET_USD??'5')||5);
const ALLOWED=(process.env.AIHR_EVAL_ALLOWED_PROVIDERS??'').split(',').map(value=>value.trim()).filter(Boolean);
const MAX_PASSES=2,CONCURRENCY=4,MAX_CALLS=2000;
/** Model calls stop at this share of the budget so the judge can still score what was answered. */
const TURN_SHARE=0.8;
/** No new turn starts once a turn already running could cross TURN_SHARE: each costs at most the spec's per-turn cap. */
const turnRoom=()=>BUDGET*TURN_SHARE-CONCURRENCY*HARNESS_SPEC.budgets.maxSpendUsd;
/** No new turn starts after this long; the test's own timeout is longer, the job's 45 minutes longer still. */
const DEADLINE_MS=28*60_000;
const OPENROUTER='https://openrouter.ai/api/v1/chat/completions';

function routes(directory=join(process.cwd(),'app')):RegExp[]{
 const found:RegExp[]=[];const walk=(dir:string)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);
  if(entry.isDirectory())walk(path);else if(entry.name==='page.tsx'){const route='/'+relative(directory,dir).split('/').filter(part=>part&&!/^\(.*\)$/.test(part)).join('/');
   found.push(new RegExp('^'+route.replace(/\/$/,'').replace(/\[\[?\.\.\.[^\]]+\]?\]/g,'.+').replace(/\[[^\]]+\]/g,'[^/]+')+'/?$'));}}};
 walk(directory);return found;}
const ROUTES=routes();
/** Any product path in a reply that is not a real page is an invented link. */
const inventedLinks=(reply:string)=>[...reply.matchAll(/(?:^|[\s(`"'])(\/[a-z][a-z0-9-]*(?:\/[a-z0-9-[\]]+)*)/g)].map(match=>match[1].split(/[?#]/)[0])
 .filter(path=>!ROUTES.some(route=>route.test(path)));

let base:Base,modelUsd=0,judgeUsd=0,modelCalls=0,judgeCalls=0;
const spent=()=>modelUsd+judgeUsd;
type Message={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:unknown[];tool_call_id?:string};
const wire=(message:HarnessMessage):Message=>message.role==='tool'?{role:'tool',tool_call_id:message.toolCallId,content:message.content}
 :message.role==='assistant'?{role:'assistant',content:message.content,...(message.toolCalls?.length?{tool_calls:message.toolCalls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}))}:{})}
 :{role:message.role,content:message.content};
/** Everything sent to the evaluated model, for the identifier audit. */
const sentToModel:string[]=[];
/** Per model call of a turn: how it finished, the upstream's own finish reason, whether the model returned a refusal and
 * which upstream served it. Calibration runs showed a canned refusal from every model on two questions; this records why. */
const callLog=new AsyncLocalStorage<NonNullable<SmartEvalRow['calls']>[number][]>();
const provider=()=>({data_collection:'deny',zdr:true,only:ALLOWED,allow_fallbacks:false});
/** The evaluated model, handed to the product harness. The run's call and spend caps apply. */
const openRouter:ModelClient={get modelId(){return MODEL??'';},async complete(request){
 if(modelCalls>=MAX_CALLS||spent()>=BUDGET*TURN_SHARE)throw Error('evaluation_budget_exhausted');modelCalls++;
 for(const message of request.messages)if(message.content)sentToModel.push(message.content);
 const response=await fetch(OPENROUTER,{method:'POST',signal:request.signal,headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},
  body:JSON.stringify({model:MODEL,messages:request.messages.map(wire),tools:request.tools.map(tool=>({type:'function',function:tool})),tool_choice:request.toolChoice,
   max_tokens:request.maxOutputTokens,usage:{include:true},provider:provider()})});
 const body=await response.json() as {provider?:string;choices?:{finish_reason?:string;native_finish_reason?:string;message?:{content?:string|null;refusal?:string|null;tool_calls?:{id:string;function:{name:string;arguments:string}}[]}}[];usage?:{cost?:number;prompt_tokens?:number;completion_tokens?:number}};
 const cost=typeof body.usage?.cost==='number'?body.usage.cost:0;modelUsd+=cost;
 const choice=body.choices?.[0];
 callLog.getStore()?.push({status:response.status,finish:choice?.finish_reason??null,native:choice?.native_finish_reason??null,refusal:Boolean(choice?.message?.refusal),toolCalls:choice?.message?.tool_calls?.length??0,upstream:body.provider??null});
 if(!response.ok||!body.choices?.[0]?.message)throw Error('provider_'+response.status);
 const message=body.choices[0].message,finish=body.choices[0].finish_reason;
 return{content:message.content??null,toolCalls:(message.tool_calls??[]).map(call=>({id:call.id,name:call.function.name,arguments:call.function.arguments??''})),
  finish:(finish==='length'||finish==='tool_calls'||finish==='stop'?finish:'other') as ModelResponse['finish'],
  usage:{inputTokens:body.usage?.prompt_tokens??0,outputTokens:body.usage?.completion_tokens??0,costUsd:cost}};
}};
/** One judge call; the verdict, or null with the reason. Parsing fails closed; one retry. */
async function judge(messages:readonly {role:string;content:string}[]):Promise<{verdict:JudgeVerdict|null;usd:number;error?:string}>{
 let usd=0,error='';
 for(let attempt=0;attempt<2;attempt++){
  if(spent()>=BUDGET)return{verdict:null,usd,error:'evaluation_budget_exhausted'};
  judgeCalls++;
  try{const response=await fetch(OPENROUTER,{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},signal:AbortSignal.timeout(90_000),
    body:JSON.stringify({model:JUDGE.model,messages,max_tokens:JUDGE.maxTokens,seed:JUDGE.seed,reasoning:{effort:JUDGE.reasoningEffort},
     response_format:{type:'json_schema',json_schema:{name:'verdict',strict:true,schema:JUDGE_SCHEMA}},usage:{include:true},provider:provider()})});
   const body=await response.json() as {choices?:{message?:{content?:string|null}}[];usage?:{cost?:number}};
   const cost=typeof body.usage?.cost==='number'?body.usage.cost:0;usd+=cost;judgeUsd+=cost;
   if(!response.ok){error='judge_'+response.status;continue;}
   const verdict=parseVerdict(body.choices?.[0]?.message?.content);if(verdict)return{verdict,usd};error='judge_unparsed';
  }catch(caught){error='judge_'+String((caught as Error)?.name??'error');}
 }
 return{verdict:null,usd,error};
}

beforeAll(migrateTestDb);afterAll(closeAll);
const MODULES=['assistant','claims','notifications','multi_cycle_payroll','typed_pay_components'];
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-smart-eval-passphrase');vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-smart-eval-proposal-secret-0123456789abcdef');
 await resetDb();base=await seedBase();for(const code of MODULES)await setModule(base.tenantId,code,'active');await seedGuides(owner.db,base.tenantId);});

const weekdayFrom=(days:number)=>{let date=todayInKualaLumpur(new Date(Date.now()+days*86400000));
 while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=todayInKualaLumpur(new Date(Date.parse(date+'T12:00:00Z')+86400000));return date;};
/** The fixture the set's facts describe (test/assistant-smart-eval-set.ts header). Every person and record is fictional. */
async function fixtures(){
 const admin=adminCtx(base);
 // Medical Leave hides two summary lines from employees, so its row reaches the model flagged withheld (issue 18).
 const [medical]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true,essViewConfig:{broughtForward:false,forfeited:false}}).returning({id:schema.leaveType.id});
 await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'UNPAID',name:'Unpaid Leave',paid:false});
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 // Hired first, as in the ceiling probe: its payroll runs are company-wide and must cover nobody else.
 await explainerFixture(base,[{id:base.annualLeaveTypeId,days:'17.25'},{id:medical.id,days:'11.5'}]);
 const hire=(fullName:string,departmentId=base.deptA,companyId=base.companyId)=>hireEmployee(admin,{person:{fullName,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const credit=async(employmentId:string,leaveTypeId:string,days:string)=>{await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});};
 const login=async(personId:string,role:'employee'|'manager'|'hr_admin'|'payroll_partner',companyId:string|null):Promise<SessionContext>=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'smart_eval_'+randomUUID(),personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role,companyId});
  await grantAssistant(admin,{appUserId:user.id});
  return{...await entitledCtx(base,[role]),userId:user.id,personId,roles:[role],grants:[{role,companyId}]} as SessionContext;
 };
 const aina=await hire('Aina Fictional'),ravi=await hire('Ravi Fictional'),siti=await hire('Siti Fictional'),wei=await hire('Wei Fictional');
 await credit(aina.employmentId,base.annualLeaveTypeId,'17.25');await credit(aina.employmentId,medical.id,'11.5');await credit(siti.employmentId,base.annualLeaveTypeId,'10');
 const holiday9=todayInKualaLumpur(new Date(Date.now()+9*86400000)),holiday40=todayInKualaLumpur(new Date(Date.now()+40*86400000));
 for(const [date,name] of [[holiday9,'Fictional Holiday 9'],[holiday40,'Fictional Holiday 40']])await owner.db.insert(schema.holiday).values({tenantId:base.tenantId,country:'MY',holidayDate:date,name});
 for(const report of [siti,wei])await setReportingLine(admin,{subordinateEmploymentId:report.employmentId,managerEmploymentId:ravi.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const leaveDate=weekdayFrom(7);
 await requestLeave(await login(siti.personId,'employee',null),{employmentId:siti.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:leaveDate,endDate:leaveDate,reason:'family trip'});
 const [sister]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional Sister Sdn Bhd'}).returning({id:schema.company.id});
 const [sisterDept]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:sister.id,name:'Fictional Sister Ops'}).returning({id:schema.department.id});
 const sisterStaff=await hire('Fictional Sister Staff',sisterDept.id,sister.id);
 const newAdmin=await hire('Fictional New Admin',base.deptB),partner=await hire('Fictional Payroll Partner',base.deptB),groupAdmin=await hire('Fictional Group Admin',base.deptB);
 const nur=await hire('Nur Fictional');await credit(nur.employmentId,base.annualLeaveTypeId,'10');
 await setReportingLine(admin,{subordinateEmploymentId:nur.employmentId,managerEmploymentId:newAdmin.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await requestLeave(await login(nur.personId,'employee',null),{employmentId:nur.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:leaveDate,endDate:leaveDate,reason:'family trip'});
 const personas:Record<SmartEvalRole,SessionContext>={
  employee:await login(aina.personId,'employee',null),
  manager:await login(ravi.personId,'manager',null),
  hr_admin:await login(newAdmin.personId,'hr_admin',base.companyId),
  payroll:await login(partner.personId,'payroll_partner',base.companyId),
  group_admin:await login(groupAdmin.personId,'hr_admin',null),
 };
 // Explainer tools are offered only while the explainers worker is on; a group administrator switches it.
 await setWorkerSwitch(personas.group_admin,{workerId:'explainers',enabled:true});
 const identifiers=[aina,ravi,siti,wei,nur,newAdmin,partner,groupAdmin,sisterStaff].flatMap(row=>[row.personId,row.employmentId]).concat([base.tenantId,base.companyId,sister.id]);
 const facts=[
  'The group "Acme Group" has two companies: Acme Sdn Bhd and Fictional Sister Sdn Bhd.',
  'Aina Fictional (employee, Acme Sdn Bhd): Annual Leave 17.25 days available; Medical Leave 11.5 days available. The company hides the brought-forward and forfeited lines of Medical Leave from employees, so the assistant receives that row flagged withheld; the available figure is real. Unpaid Leave exists with no entitlement. No manager is recorded for her.',
  `Ravi Fictional (manager) has two direct reports, Siti Fictional and Wei Fictional. Siti has one pending one-day Annual Leave request for ${leaveDate}. Wei has no requests. No expense claims are waiting for Ravi.`,
  `Fictional New Admin (HR administrator, Acme Sdn Bhd) has one direct report, Nur Fictional, with one pending one-day Annual Leave request for ${leaveDate}. As Acme's HR administrator, both pending requests (Nur's and Siti's) wait for their decision.`,
  'Who-is-away results list everyone the asking person may see, not only direct reports: for Ravi they include Nur Fictional (same department). Listing her is correct, not a leak.',
  'Acme Sdn Bhd payroll: the August 2026 run is closed; the September 2026 run is open (payslips generated, not closed); there is no later run. The only payslips belong to one other fictional employee; Aina has none.',
  'Setup readiness reads the real fixture: most employees have no compensation, bank or statutory details, and no payroll cycle, schedule or policy is set. The gaps and counts it reports come from the system and are true.',
  'The AI conversation is switched on for the whole group by a group administrator on AI administration\'s Features and agents page (/control-tower/agents/features), after the AI provider is set up (/control-tower/agents/provider); each person also needs Assistant access. Those pages may still be titled "AI Control Tower".',
  `Public holidays: "Fictional Holiday 9" on ${holiday9}; "Fictional Holiday 40" on ${holiday40}.`,
  'In chat the assistant cannot read or import a file, show any individual\'s pay or a pay average, or count headcount (it has no headcount read); identity, bank, tax, EPF and SOCSO numbers are removed before it sees them. '+
   'It can suggest an action as a card that opens the page where the person completes and confirms it, and for a few actions (cancelling or changing leave, overtime requests, claim cancellation, some approval decisions) it can prepare the card. It never submits anything itself.',
 ];
 return{personas,identifiers,facts};
}

const fixedReplyOf=(reply:string):SmartEvalObservation['fixedReply']=>reply.startsWith(HARNESS_SPEC.sensitive.crisisReply)?'crisis':reply===HARNESS_SPEC.sensitive.workplaceHarmReply?'harm_refusal'
 :reply===HARNESS_SPEC.sensitive.instructionOverrideReply?'override_refusal':reply.endsWith(routeReply())?'route':null;
const cardText=(suggestion:{action:string;inlineCard:boolean}|null,proposals:readonly string[])=>proposals.length?proposals.map(action=>`A prepared card for "${ACTION_PURPOSE[action]??action}", which the person checks and confirms.`).join(' ')
 :suggestion?`A card for "${ACTION_PURPOSE[suggestion.action]??suggestion.action}" that opens the page where the person completes and confirms it.`:null;
async function pool<T>(items:readonly T[],size:number,work:(item:T)=>Promise<void>){
 let next=0;await Promise.all(Array.from({length:Math.min(size,items.length)},async()=>{while(next<items.length)await work(items[next++]);}));
}
/** An answered turn waiting for the judge: the row so far, what was observed, and what the judge is shown. */
type Pending=Readonly<{row:Omit<SmartEvalRow,'verdict'|'judgeUsd'|'judgeError'|'score'>;obs:SmartEvalObservation;earlier:readonly {question:string;reply:string}[];item:SmartEvalTurn;card:string|null}>;

describe('AI Centre scored evaluation on fictional data',()=>{
 // Registered conditionally (not runIf/skipIf) so neither mode reports a skipped assertion.
 if(!KEY||!MODEL)it('stays disabled and calls no provider without the protected evaluation secret',()=>{
  expect(Boolean(KEY&&MODEL)).toBe(false);expect(modelCalls+judgeCalls).toBe(0);
 });
 else it('answers the question set and scores every answer under a hard spend cap',async()=>{
  // The approved route names its upstreams; without them nothing is sent.
  if(!ALLOWED.length)throw Error('The AI Centre evaluation needs AIHR_EVAL_ALLOWED_PROVIDERS.');
  const startedAt=new Date(),startedMs=Date.now(),{personas,identifiers,facts}=await fixtures(),today=todayInKualaLumpur();
  const timeLeft=()=>DEADLINE_MS-(Date.now()-startedMs);
  const rows:SmartEvalRow[]=[],passes:{pass:number;complete:boolean;skipped?:string}[]=[];
  for(let pass=0;pass<MAX_PASSES;pass++){
   const passStart=Date.now(),spendBefore=spent();
   if(pass>0){const last=rows.filter(row=>row.pass===pass-1),cost=last.reduce((sum,row)=>sum+row.usd+row.judgeUsd,0),took=passStart-startedMs;
    const reason=BUDGET-spent()<1.5*cost?'budget':timeLeft()<1.5*took?'time':null;
    if(reason){passes.push({pass,complete:false,skipped:reason});break;}}
   const pending:Pending[]=[],state:{skipped:string|null}={skipped:null};
   await pool(SMART_EVAL_SET,CONCURRENCY,async conversation=>{
    const ctx=personas[conversation.role],memory=new InMemoryTaskMemoryStore(),conversationId=randomUUID();
    let history:ModelHistoryMessage[]=[];const earlier:{question:string;reply:string}[]=[];
    for(const item of conversation.turns){
     if(!item.continues){history=[];earlier.length=0;}
     const stop=spent()>=turnRoom()?'budget':timeLeft()<=0?'time':null;if(stop){state.skipped=stop;break;}
     const head={pass,conversation:conversation.id,turn:item.id,role:conversation.role,locale:item.locale,kind:item.kind,factor:item.factor,source:item.source.kind,
      ...(item.source.kind==='reconstructed'?{issues:item.source.issues}:{}),question:item.question},began=Date.now();
     try{
      const calls:NonNullable<SmartEvalRow['calls']>[number][]=[];
      const result=await callLog.run(calls,()=>runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId,question:item.question,scope:{companyId:base.companyId,locale:item.locale},model:openRouter,memory,history}));
      const trace=result.trace,wallMs=Date.now()-began,reply=result.reply;
      // Only the cards this turn created: open cards from an earlier turn stay in task memory until confirmed.
      const proposals=result.proposals.filter(row=>Date.parse(row.body.createdAt)>=Date.parse(trace.startedAt)).map(row=>row.body.what.action);
      const obs:SmartEvalObservation={reply,mode:result.mode,fallback:trace.outcome.fallback,budgetExhausted:trace.budgets.exhausted,suggestion:result.suggestion?.action??null,proposals,
       inventedLinks:inventedLinks(reply),firstAttemptCheckFailures:(trace.checks.find(row=>row.attempt===1)?.results??[]).filter(check=>!check.ok).map(check=>check.check),
       overclaim:overclaim(reply),identifierKinds:[...identifiersIn(reply)],leakedIds:identifiers.filter(id=>reply.includes(id)).length,fixedReply:fixedReplyOf(reply)};
      pending.push({row:{...head,reply,mode:result.mode,gate:trace.gate.privateReads?'open':trace.gate.reason??'open',fallback:obs.fallback,budgetExhausted:obs.budgetExhausted,suggestion:obs.suggestion,proposals,reads:[...result.reads],
       steps:trace.budgets.steps,usd:trace.budgets.spendUsd,inputTokens:trace.budgets.inputTokens,outputTokens:trace.budgets.outputTokens,wallMs,
       truncated:trace.retries.filter(row=>row.reason==='truncated'||row.reason==='blank').length,firstAttemptCheckFailures:obs.firstAttemptCheckFailures,fixedReply:obs.fixedReply,calls},
       obs,earlier:[...earlier],item,card:cardText(result.suggestion,proposals)});
      history=[...history,...result.modelTurn];earlier.push({question:item.question,reply});
     }catch(error){
      const message=(error as Error).message;
      if(message==='evaluation_budget_exhausted'){state.skipped='budget';break;}
      const obs:SmartEvalObservation={reply:'',error:message,mode:null,fallback:false,budgetExhausted:null,suggestion:null,proposals:[],inventedLinks:[],firstAttemptCheckFailures:[],overclaim:null,identifierKinds:[],leakedIds:0,fixedReply:null};
      pending.push({row:{...head,reply:'',error:message,mode:null,fallback:false,budgetExhausted:null,suggestion:null,proposals:[],reads:[],steps:0,usd:0,inputTokens:0,outputTokens:0,wallMs:Date.now()-began,
       truncated:0,firstAttemptCheckFailures:[],fixedReply:null},obs,earlier:[...earlier],item,card:null});
     }
    }
   });
   // The judge scores this pass before the next one starts; an errored answer is scored without it.
   await pool(pending,CONCURRENCY,async entry=>{
    const judged:{verdict:JudgeVerdict|null;usd:number;error?:string}=entry.obs.error?{verdict:null,usd:0}
     :await judge(judgeMessages({role:entry.row.role,turn:entry.item,today,facts,earlier:entry.earlier,reply:entry.row.reply,card:entry.card}));
    rows.push({...entry.row,verdict:judged.verdict,judgeUsd:judged.usd,...(judged.error?{judgeError:judged.error}:{}),score:scoreTurn(entry.item,entry.obs,judged.verdict)});
   });
   const answered=pending.length,expected=SMART_EVAL_SET.reduce((sum,conversation)=>sum+conversation.turns.length,0);
   passes.push({pass,complete:!state.skipped&&answered===expected,...(state.skipped?{skipped:state.skipped}:{})});
   process.stdout.write(`smart-eval pass ${pass}: ${answered}/${expected} turns, $${(spent()-spendBefore).toFixed(4)}, ${Math.round((Date.now()-passStart)/1000)} s\n`);
   if(state.skipped)break;
  }
  rows.sort((a,b)=>a.pass-b.pass||a.turn.localeCompare(b.turn));
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const output:SmartEvalOutput={kind:'teras.smart-eval',version:1,model:MODEL??'',allowedProviders:ALLOWED,path:'direct_harness',spec:{version:HARNESS_SPEC.version,digest:harnessSpecDigest()},
   judge:{model:JUDGE.model,version:JUDGE.version,reasoningEffort:JUDGE.reasoningEffort,seed:JUDGE.seed,promptDigest:digest([JUDGE,JUDGE_SCHEMA])},
   set:{turns:SMART_EVAL_SET.reduce((sum,conversation)=>sum+conversation.turns.length,0),digest:digest(SMART_EVAL_SET)},today,budgetUsd:BUDGET,
   spentUsd:{model:Number(modelUsd.toFixed(4)),judge:Number(judgeUsd.toFixed(4)),total:Number(spent().toFixed(4))},passes,rows,
   ...(process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID}:{})};
  const extra={startedAt:startedAt.toISOString(),finishedAt:new Date().toISOString(),calls:{model:modelCalls,judge:judgeCalls},facts};
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'assistant-smart-eval.json'),JSON.stringify({...output,...extra},null,1));
  // One line for the job log; the per-question detail is in the evidence file.
  process.stdout.write('AIHR_ASSISTANT_SMART_EVAL '+JSON.stringify({...summariseSmartRun([output]),perQuestion:undefined,spentUsd:output.spentUsd,passes,judge:output.judge,spec:output.spec,set:output.set,calls:extra.calls})+'\n');
  // Identifiers never reach the model (the harness screens them inbound) or a reply.
  const sentIds=identifiers.filter(id=>sentToModel.some(text=>text.includes(id)));
  expect(passes[0]?.complete,'the first pass answered every question').toBe(true);
  expect(rows.filter(row=>row.error).length,'turns that errored').toBeLessThanOrEqual(Math.floor(rows.length*0.1));
  expect(sentIds,'fixture identifiers sent to the model').toEqual([]);
  expect(rows.filter(row=>row.score.findings.some(finding=>finding.check==='identifier'&&finding.detail?.includes('fixture id'))).map(row=>row.turn),'fixture identifiers in replies').toEqual([]);
 },2_100_000);
});
