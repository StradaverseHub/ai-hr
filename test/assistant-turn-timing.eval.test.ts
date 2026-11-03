/** AI v2 R8 (where the seconds go): the scored evaluation's questions through the product turn harness against the real
 * model, timed per model step and per tool read. Inert without the protected evaluation secret, exactly like
 * test/assistant-smart-eval.eval.test.ts, whose route, fixture and question set this reuses: the direct harness path
 * (core/harness/runner.ts runTurn), data collection denied, zero retention, the allowed upstreams only, no fallbacks.
 * There is no judge: nothing is scored, only timed.
 *
 * Two passes over the set:
 *  1. `sequential-stream`: one turn at a time, each model call STREAMED so the time to the first byte, the first token
 *     and the first word of the reply (inside final_answer) can be seen. The harness still receives the whole response
 *     before it acts, exactly as with the non-streaming client: streaming here only observes when tokens arrive.
 *  2. `concurrent-4`: four conversations at once with the non-streaming request the scored evaluation sends, so its
 *     9.6 s median can be reproduced and split.
 * Each tool binding is the native one, timed by a wrapper that calls its real run and returns its result unchanged.
 * Spend is capped at USD 2 (or the workflow budget, if lower); a pass stops starting turns at 80% of the cap.
 *
 * Output: assistant-turn-timing.json in the evidence folder (per turn: wall, steps, each call's latency and tokens, each
 * read's latency; no question text, reply text or id) and one AIHR_ASSISTANT_TURN_TIMING summary line. */
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {hireEmployee,setReportingLine} from '../core/org';
import {seedGuides} from '../db/seed-guides';
import {HARNESS_TEST_ONLY,runTurn,type ModelHistoryMessage} from '../core/harness/runner';
import {HARNESS_SPEC,harnessSpecDigest} from '../core/harness/spec';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import {nativeToolProvider,type ToolProvider} from '../core/harness/tools';
import type {HarnessMessage,ModelClient,ModelRequest,ModelResponse} from '../core/harness/model-client';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {explainerFixture} from './explainer-corpus';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
import type {SmartEvalRole} from '../core/improvement/smart-eval-score';
import {SMART_EVAL_SET} from './assistant-smart-eval-set';

const KEY=process.env.AIHR_EVAL_OPENROUTER_KEY?.trim(),MODEL=process.env.AIHR_EVAL_MODEL?.trim();
const BUDGET=Math.min(2,Number(process.env.AIHR_EVAL_BUDGET_USD??'2')||2);
const ALLOWED=(process.env.AIHR_EVAL_ALLOWED_PROVIDERS??'').split(',').map(value=>value.trim()).filter(Boolean);
const MAX_CALLS=1200,TURN_SHARE=0.8,DEADLINE_MS=30*60_000;
const OPENROUTER='https://openrouter.ai/api/v1/chat/completions';

type CallTiming={pass:string;turn:string;step:number;stream:boolean;status:number;ms:number;ttfbMs:number|null;firstTokenMs:number|null;firstReplyWordMs:number|null;
 finish:string|null;toolCalls:number;toolNames:string[];inputTokens:number;cachedInputTokens:number;outputTokens:number;usd:number;upstream:string|null;error?:string};
type ToolTiming={pass:string;turn:string;tool:string;ms:number;ok:boolean|null};
type TurnTiming={pass:string;conversation:string;turn:string;role:SmartEvalRole;locale:string;wallMs:number;steps:number;modelMs:number;toolMs:number;harnessMs:number;
 reads:number;callsPerStep:number[];gate:string;fallback:boolean;error?:string};

let base:Base,usd=0,modelCalls=0;
const callLog:CallTiming[]=[],toolLog:ToolTiming[]=[],turnLog:TurnTiming[]=[];
/** Which pass and turn a call or a read belongs to; turns of one conversation run in order, so one slot per conversation. */
const current=new Map<string,{pass:string;turn:string;step:number}>();
type Message={role:'system'|'user'|'assistant'|'tool';content:string|null;tool_calls?:unknown[];tool_call_id?:string};
const wire=(message:HarnessMessage):Message=>message.role==='tool'?{role:'tool',tool_call_id:message.toolCallId,content:message.content}
 :message.role==='assistant'?{role:'assistant',content:message.content,...(message.toolCalls?.length?{tool_calls:message.toolCalls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}))}:{})}
 :{role:message.role,content:message.content};
const sentToModel:string[]=[];
const provider=()=>({data_collection:'deny',zdr:true,only:ALLOWED,allow_fallbacks:false});
type Usage={cost?:number;prompt_tokens?:number;completion_tokens?:number;prompt_tokens_details?:{cached_tokens?:number}};
const finishOf=(finish:string|null|undefined):ModelResponse['finish']=>finish==='length'||finish==='tool_calls'||finish==='stop'?finish:'other';

/** One model call, streamed or not, recorded under the conversation's current turn. */
function timedClient(conversation:string,stream:boolean):ModelClient{
 return{get modelId(){return MODEL??'';},async complete(request:ModelRequest):Promise<ModelResponse>{
  if(modelCalls>=MAX_CALLS||usd>=BUDGET*TURN_SHARE)throw Error('evaluation_budget_exhausted');modelCalls++;
  for(const message of request.messages)if(message.content)sentToModel.push(message.content);
  const slot=current.get(conversation)!;slot.step++;
  const started=performance.now(),ms=()=>Math.round(performance.now()-started);
  const row:CallTiming={pass:slot.pass,turn:slot.turn,step:slot.step,stream,status:0,ms:0,ttfbMs:null,firstTokenMs:null,firstReplyWordMs:null,finish:null,toolCalls:0,toolNames:[],
   inputTokens:0,cachedInputTokens:0,outputTokens:0,usd:0,upstream:null};
  callLog.push(row);
  try{
   const response=await fetch(OPENROUTER,{method:'POST',signal:request.signal,headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},
    body:JSON.stringify({model:MODEL,messages:request.messages.map(wire),tools:request.tools.map(tool=>({type:'function',function:tool})),tool_choice:request.toolChoice,
     max_tokens:request.maxOutputTokens,usage:{include:true},provider:provider(),...(stream?{stream:true}:{})})});
   row.status=response.status;row.ttfbMs=ms();
   let content:string|null=null,finish:string|null=null,usage:Usage|undefined;const calls:{id:string;name:string;arguments:string}[]=[];
   if(stream&&response.ok&&response.body){
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
    for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
     let newline:number;while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);
      if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;
      const chunk=JSON.parse(data) as {provider?:string;error?:{message?:string};usage?:Usage;choices?:{finish_reason?:string|null;delta?:{content?:string|null;tool_calls?:{index:number;id?:string;function?:{name?:string;arguments?:string}}[]}}[]};
      if(chunk.error)throw Error('provider_stream_error');
      if(chunk.provider)row.upstream=chunk.provider;if(chunk.usage)usage=chunk.usage;
      const choice=chunk.choices?.[0];if(!choice)continue;
      if(choice.finish_reason)finish=choice.finish_reason;
      const delta=choice.delta;
      if(delta?.content){content=(content??'')+delta.content;row.firstTokenMs??=ms();}
      for(const part of delta?.tool_calls??[]){
       const call=calls[part.index]??={id:'',name:'',arguments:''};
       if(part.id)call.id=part.id;if(part.function?.name)call.name+=part.function.name;if(part.function?.arguments)call.arguments+=part.function.arguments;
       if(part.function?.name||part.function?.arguments)row.firstTokenMs??=ms();
       // The first word the person would read if the final answer were streamed to the screen.
       if(call.name===HARNESS_SPEC.offer.finalTool&&row.firstReplyWordMs===null&&/"reply"\s*:\s*"[^"\\]/.test(call.arguments))row.firstReplyWordMs=ms();
      }
     }}
   }else{
    const body=await response.json() as {provider?:string;usage?:Usage;choices?:{finish_reason?:string;message?:{content?:string|null;tool_calls?:{id:string;function:{name:string;arguments:string}}[]}}[]};
    row.upstream=body.provider??null;usage=body.usage;const choice=body.choices?.[0];
    if(!response.ok||!choice?.message)throw Error('provider_'+response.status);
    content=choice.message.content??null;finish=choice.finish_reason??null;
    for(const call of choice.message.tool_calls??[])calls.push({id:call.id,name:call.function.name,arguments:call.function.arguments??''});
   }
   if(!response.ok)throw Error('provider_'+response.status);
   const cost=typeof usage?.cost==='number'?usage.cost:0;usd+=cost;
   Object.assign(row,{ms:ms(),finish,toolCalls:calls.length,toolNames:calls.map(call=>call.name),inputTokens:usage?.prompt_tokens??0,cachedInputTokens:usage?.prompt_tokens_details?.cached_tokens??0,outputTokens:usage?.completion_tokens??0,usd:cost});
   return{content,toolCalls:calls.map((call,index)=>({id:call.id||'call-'+index,name:call.name,arguments:call.arguments})),finish:finishOf(finish),
    usage:{inputTokens:usage?.prompt_tokens??0,outputTokens:usage?.completion_tokens??0,costUsd:cost}};
  }catch(error){row.ms=ms();row.error=(error as Error).message?.slice(0,60)??'error';throw error;}
 }};
}
/** The native provider, each binding's real run timed under the conversation's current turn. */
const timedTools=(conversation:string):ToolProvider=>async(ctx,scope,actions)=>{
 const candidates=await nativeToolProvider(ctx,scope,actions);
 return Object.freeze({...candidates,bindings:Object.freeze(candidates.bindings.map(binding=>Object.freeze({...binding,async run(input:Record<string,unknown>){
  const slot=current.get(conversation)!,started=performance.now();let ok:boolean|null=null;
  try{const result=await binding.run(input);ok=result.ok;return result;}finally{toolLog.push({pass:slot.pass,turn:slot.turn,tool:binding.name,ms:Math.round(performance.now()-started),ok});}}})))});
};

beforeAll(migrateTestDb);afterAll(closeAll);
const MODULES=['assistant','claims','notifications','multi_cycle_payroll','typed_pay_components'];
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-smart-eval-passphrase');vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-smart-eval-proposal-secret-0123456789abcdef');
 await resetDb();base=await seedBase();for(const code of MODULES)await setModule(base.tenantId,code,'active');await seedGuides(owner.db,base.tenantId);});

const weekdayFrom=(days:number)=>{let date=todayInKualaLumpur(new Date(Date.now()+days*86400000));
 while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=todayInKualaLumpur(new Date(Date.parse(date+'T12:00:00Z')+86400000));return date;};
/** The scored evaluation's fixture (test/assistant-smart-eval.eval.test.ts fixtures(), without the judge's fact sheet), so
 * the same questions read the same records. Every person and record is fictional. */
async function fixtures(){
 const admin=adminCtx(base);
 const [medical]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true,essViewConfig:{broughtForward:false,forfeited:false}}).returning({id:schema.leaveType.id});
 await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'UNPAID',name:'Unpaid Leave',paid:false});
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 await explainerFixture(base,[{id:base.annualLeaveTypeId,days:'17.25'},{id:medical.id,days:'11.5'}]);
 const hire=(fullName:string,departmentId=base.deptA,companyId=base.companyId)=>hireEmployee(admin,{person:{fullName,primaryEmail:randomUUID()+'@fixture.test'},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
 const credit=async(employmentId:string,leaveTypeId:string,days:string)=>{await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});};
 const login=async(personId:string,role:'employee'|'manager'|'hr_admin'|'payroll_partner',companyId:string|null):Promise<SessionContext>=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'turn_timing_'+randomUUID(),personId}).returning({id:schema.appUser.id});
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
 await setWorkerSwitch(personas.group_admin,{workerId:'explainers',enabled:true});
 const identifiers=[aina,ravi,siti,wei,nur,newAdmin,partner,groupAdmin,sisterStaff].flatMap(row=>[row.personId,row.employmentId]).concat([base.tenantId,base.companyId,sister.id]);
 return{personas,identifiers};
}
async function pool<T>(items:readonly T[],size:number,work:(item:T)=>Promise<void>){
 let next=0;await Promise.all(Array.from({length:Math.min(size,items.length)},async()=>{while(next<items.length)await work(items[next++]);}));
}
const quantile=(values:readonly number[],q:number)=>{if(!values.length)return null;const sorted=[...values].sort((x,y)=>x-y);
 const at=(sorted.length-1)*q,low=Math.floor(at),high=Math.ceil(at);return Math.round(sorted[low]+(sorted[high]-sorted[low])*(at-low));};
const stats=(values:readonly number[])=>({n:values.length,p50:quantile(values,0.5),p90:quantile(values,0.9),p95:quantile(values,0.95),max:values.length?Math.max(...values):null});

describe('AI Centre turn timing against the real model, on fictional data',()=>{
 if(!KEY||!MODEL)it('stays disabled and calls no provider without the protected evaluation secret',()=>{
  expect(Boolean(KEY&&MODEL)).toBe(false);expect(modelCalls).toBe(0);
 });
 else it('times every model step and read of the scored question set, one at a time streamed and four at once',async()=>{
  if(!ALLOWED.length)throw Error('The turn timing run needs AIHR_EVAL_ALLOWED_PROVIDERS.');
  const startedMs=Date.now(),{personas,identifiers}=await fixtures();
  const passes:{pass:string;concurrency:number;stream:boolean;answered:number;expected:number;stopped:string|null;wallS:number}[]=[];
  for(const [pass,concurrency,stream] of [['sequential-stream',1,true],['concurrent-4',4,false]] as const){
   const passStart=Date.now(),state={stopped:null as string|null};let answered=0;
   await pool(SMART_EVAL_SET,concurrency,async conversation=>{
    const ctx=personas[conversation.role],memory=new InMemoryTaskMemoryStore(),conversationId=randomUUID(),key=pass+':'+conversation.id;
    const model=timedClient(key,stream),tools=timedTools(key);let history:ModelHistoryMessage[]=[];
    for(const item of conversation.turns){
     if(!item.continues)history=[];
     // No new turn once the turns already running could cross the cap: each costs at most the spec's per-turn cap.
     if(usd>=BUDGET*TURN_SHARE-concurrency*HARNESS_SPEC.budgets.maxSpendUsd){state.stopped='budget';break;}
     if(Date.now()-startedMs>DEADLINE_MS){state.stopped='time';break;}
     current.set(key,{pass,turn:item.id,step:0});
     const began=performance.now();
     try{
      const result=await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId,question:item.question,scope:{companyId:base.companyId,locale:item.locale},model,memory,history,tools});
      const wallMs=Math.round(performance.now()-began),trace=result.trace;
      const modelMs=callLog.filter(row=>row.pass===pass&&row.turn===item.id).reduce((sum,row)=>sum+row.ms,0);
      const toolMs=toolLog.filter(row=>row.pass===pass&&row.turn===item.id).reduce((sum,row)=>sum+row.ms,0);
      const callsPerStep=callLog.filter(row=>row.pass===pass&&row.turn===item.id).map(row=>row.toolNames.filter(name=>name!==HARNESS_SPEC.offer.finalTool).length);
      turnLog.push({pass,conversation:conversation.id,turn:item.id,role:conversation.role,locale:item.locale,wallMs,steps:trace.budgets.steps,modelMs,toolMs,harnessMs:Math.max(0,wallMs-modelMs-toolMs),
       reads:result.reads.length,callsPerStep,gate:trace.gate.privateReads?'open':trace.gate.reason??'open',fallback:trace.outcome.fallback});
      history=[...history,...result.modelTurn];answered++;
     }catch(error){
      const message=(error as Error).message;if(message==='evaluation_budget_exhausted'){state.stopped='budget';break;}
      turnLog.push({pass,conversation:conversation.id,turn:item.id,role:conversation.role,locale:item.locale,wallMs:Math.round(performance.now()-began),steps:0,modelMs:0,toolMs:0,harnessMs:0,reads:0,callsPerStep:[],gate:'error',fallback:false,error:message.slice(0,60)});
     }
    }
   });
   const expected=SMART_EVAL_SET.reduce((sum,conversation)=>sum+conversation.turns.length,0);
   passes.push({pass,concurrency,stream,answered,expected,stopped:state.stopped,wallS:Math.round((Date.now()-passStart)/1000)});
   process.stdout.write(`turn-timing ${pass}: ${answered}/${expected} turns, $${usd.toFixed(4)} so far, ${Math.round((Date.now()-passStart)/1000)} s\n`);
  }
  const summary=Object.fromEntries(passes.map(({pass})=>{
   const turns=turnLog.filter(row=>row.pass===pass&&!row.error),modelled=turns.filter(row=>row.steps>0),calls=callLog.filter(row=>row.pass===pass&&!row.error),reads=toolLog.filter(row=>row.pass===pass);
   const bySteps=Object.fromEntries([...new Set(modelled.map(row=>row.steps))].sort().map(steps=>[steps,stats(modelled.filter(row=>row.steps===steps).map(row=>row.wallMs))]));
   const byTool=Object.fromEntries([...new Set(reads.map(row=>row.tool))].sort().map(tool=>[tool,stats(reads.filter(row=>row.tool===tool).map(row=>row.ms))]));
   const finalCalls=calls.filter(row=>row.toolNames.includes(HARNESS_SPEC.offer.finalTool)),toolStepCalls=calls.filter(row=>!row.toolNames.includes(HARNESS_SPEC.offer.finalTool));
   const share=(part:number,whole:number)=>whole?Math.round(1000*part/whole)/10:null;
   const wall=modelled.reduce((sum,row)=>sum+row.wallMs,0);
   return[pass,{turns:turns.length,wall:stats(turns.map(row=>row.wallMs)),modelledWall:stats(modelled.map(row=>row.wallMs)),bySteps,
    stepsHistogram:Object.fromEntries([...new Set(modelled.map(row=>row.steps))].sort().map(steps=>[steps,modelled.filter(row=>row.steps===steps).length])),
    modelCall:stats(calls.map(row=>row.ms)),toolStepCall:stats(toolStepCalls.map(row=>row.ms)),finalAnswerCall:stats(finalCalls.map(row=>row.ms)),
    ttfb:stats(calls.map(row=>row.ttfbMs).filter((value):value is number=>value!==null)),firstToken:stats(calls.map(row=>row.firstTokenMs).filter((value):value is number=>value!==null)),
    firstReplyWordOfFinalCall:stats(finalCalls.map(row=>row.firstReplyWordMs).filter((value):value is number=>value!==null)),
    inputTokensPerCall:stats(calls.map(row=>row.inputTokens)),cachedInputShare:share(calls.reduce((sum,row)=>sum+row.cachedInputTokens,0),calls.reduce((sum,row)=>sum+row.inputTokens,0)),
    outputTokensPerCall:stats(calls.map(row=>row.outputTokens)),read:stats(reads.map(row=>row.ms)),byTool,
    shareOfModelledWall:{model:share(modelled.reduce((sum,row)=>sum+row.modelMs,0),wall),tools:share(modelled.reduce((sum,row)=>sum+row.toolMs,0),wall),harness:share(modelled.reduce((sum,row)=>sum+row.harnessMs,0),wall)},
    turnsWithAMultiReadStep:modelled.filter(row=>row.callsPerStep.some(count=>count>1)).length,
    errors:turnLog.filter(row=>row.pass===pass&&row.error).length}];
  }));
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'assistant-turn-timing.json'),JSON.stringify({kind:'teras.turn-timing-model',version:1,model:MODEL,allowedProviders:ALLOWED,path:'direct_harness',
   spec:{version:HARNESS_SPEC.version,digest:harnessSpecDigest()},budgetUsd:BUDGET,spentUsd:Number(usd.toFixed(4)),calls:modelCalls,passes,summary,
   ...(process.env.GITHUB_RUN_ID?{runId:process.env.GITHUB_RUN_ID}:{}),turns:turnLog,modelCalls:callLog,reads:toolLog},null,1));
  process.stdout.write('AIHR_ASSISTANT_TURN_TIMING '+JSON.stringify({model:MODEL,spentUsd:Number(usd.toFixed(4)),passes,summary:Object.fromEntries(Object.entries(summary).map(([pass,row])=>[pass,{...row,byTool:undefined,bySteps:undefined}]))})+'\n');
  const sentIds=identifiers.filter(id=>sentToModel.some(text=>text.includes(id)));
  expect(passes[0].answered,'the streamed pass timed most of the set').toBeGreaterThanOrEqual(Math.floor(passes[0].expected*0.9));
  expect(turnLog.filter(row=>row.error).length,'turns that errored').toBeLessThanOrEqual(Math.floor(turnLog.length*0.1));
  expect(sentIds,'fixture identifiers sent to the model').toEqual([]);
 },2_100_000);
});
