/** Content-filter probe (claude/noveri-filter-fix): why the upstream stops "how much leave do i have left" and
 * "apply leave for me". In evaluation runs 41514801515, 41514916769, 41516696371, 41517912894 and 41519237260 the first
 * model call of both questions finished with finish_reason content_filter (native content_filter, upstream Azure) on
 * gpt-6-luna, gpt-6-luna-pro, gpt-6.1-sol and gpt-6-astra, on every pass, and the person saw only a canned refusal.
 *
 * The probe captures the exact first request the turn harness (core/harness/runner.ts) builds for a question, as the
 * fictional employee of the AI Centre evaluation: the capturing client records it and stops, so that capture calls no
 * model. It then sends that request, and variants that change one thing at a time, straight to OpenRouter on the
 * allowed upstreams only (data collection denied, zero retention, no fallbacks), and records every finish reason:
 * the whole request; the question alone; without tools; without the system text; tool_choice auto and the production
 * request shape (strict tool schemas); the live staging spec (v8, main dfbcf85b1) read from git; each instruction left
 * out in turn, and each alone; each tool left out in turn; rewordings of the question; and candidate fixes that frame
 * the question (a neutral label, a quotation, a domain label) or add a system note. Another model than the current one
 * runs only the whole request, the question alone and the candidate fixes, to keep the spend small. Fictional data only.
 * Skipped exactly like the other probes without the protected evaluation secret; one hard budget for the file.
 * Output: assistant-content-filter.json in the evidence folder and one CONTENT_FILTER_PROBE line per request. */
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {hireEmployee} from '../core/org';
import {seedGuides} from '../db/seed-guides';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {HARNESS_SPEC} from '../core/harness/spec';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {HarnessMessage,ModelClient,ModelRequest} from '../core/harness/model-client';
import {strictToolSchema} from '../lib/ai/teras-harness-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

const KEY=process.env.AIHR_EVAL_OPENROUTER_KEY?.trim(),MODEL=process.env.AIHR_EVAL_MODEL?.trim();
const BUDGET=Math.min(2,Number(process.env.AIHR_EVAL_BUDGET_USD??'1')||1);
const ALLOWED=(process.env.AIHR_EVAL_ALLOWED_PROVIDERS??'').split(',').map(value=>value.trim()).filter(Boolean);
const LIVE_STAGING='dfbcf85b1';
const BLOCKED=['how much leave do i have left','apply leave for me'] as const;
const CONTROL='how many MC days do I have?';
const CURRENT_MODEL='openai/gpt-6-luna';
/** Candidate fixes in our own request structure: the person's words are unchanged, only labelled or quoted. */
const FRAMES:Readonly<Record<string,(question:string)=>string>>={
 'frame: neutral label':question=>'Message from the signed-in person to the HR assistant:\n'+question,
 'frame: quoted':question=>'The signed-in person wrote: "'+question+'"',
 'frame: domain label':question=>'HR question about the person\'s own work records (leave means time off work):\n'+question,
};
const SYSTEM_NOTE=' In this application "leave" always means time off work.';
const REWORDINGS:Readonly<Record<string,readonly string[]>>={
 'how much leave do i have left':['How much leave do I have left?','how much leave do i have','how much annual leave do i have left','what is my leave balance'],
 'apply leave for me':['Apply for leave for me.','please apply leave for me','apply for leave','i want to apply leave'],
};
let base:Base,spentUsd=0,calls=0;

beforeAll(migrateTestDb);afterAll(closeAll);
const MODULES=['assistant','claims','notifications','multi_cycle_payroll','typed_pay_components'];
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-filter-probe-passphrase');vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-filter-probe-proposal-secret-0123456789abcdef');
 await resetDb();base=await seedBase();for(const code of MODULES)await setModule(base.tenantId,code,'active');await seedGuides(owner.db,base.tenantId);});

/** The evaluation's employee (test/assistant-smart-eval-set.ts facts): Annual 17.25, Medical 11.5 with two lines hidden. */
async function employee():Promise<SessionContext>{
 const admin=adminCtx(base);
 const [medical]=await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'MEDICAL',name:'Medical Leave',paid:true,essViewConfig:{broughtForward:false,forfeited:false}}).returning({id:schema.leaveType.id});
 await owner.db.insert(schema.leaveType).values({tenantId:base.tenantId,code:'UNPAID',name:'Unpaid Leave',paid:false});
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:17.25,validFrom:'2020-01-01'});await seedEntitlement(admin,{leaveTypeId:medical.id,annualDays:11.5,validFrom:'2020-01-01'});
 const hire=(fullName:string)=>hireEmployee(admin,{person:{fullName,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const login=async(personId:string,role:'employee'|'hr_admin',companyId:string|null):Promise<SessionContext>=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'filter_probe_'+randomUUID(),personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role,companyId});
  await grantAssistant(admin,{appUserId:user.id});
  return{...await entitledCtx(base,[role]),userId:user.id,personId,roles:[role],grants:[{role,companyId}]} as SessionContext;
 };
 const aina=await hire('Aina Fictional'),groupAdmin=await hire('Fictional Group Admin');
 for(const [leaveTypeId,days] of [[base.annualLeaveTypeId,'17.25'],[medical.id,'11.5']] as const)
  await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:aina.employmentId,leaveTypeId,entryType:'accrual',days,effectiveOn:todayInKualaLumpur()});
 await setWorkerSwitch(await login(groupAdmin.personId,'hr_admin',null),{workerId:'explainers',enabled:true});
 return login(aina.personId,'employee',null);
}
class Captured extends Error{constructor(readonly request:ModelRequest){super('captured');}}
/** The first request the harness sends for a question; no model is called. */
async function firstRequest(ctx:SessionContext,question:string):Promise<ModelRequest>{
 const capture:ModelClient={modelId:'capture',async complete(request){throw new Captured(request);}};
 try{await runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},model:capture,memory:new InMemoryTaskMemoryStore(),history:[]});}
 catch(error){if(error instanceof Captured)return error.request;throw error;}
 throw Error('The harness answered without a model call.');
}
type Wire={role:string;content:string|null;tool_calls?:unknown[];tool_call_id?:string};
const wire=(message:HarnessMessage):Wire=>message.role==='tool'?{role:'tool',tool_call_id:message.toolCallId,content:message.content}:{role:message.role,content:message.content};
type Tool=Readonly<{name:string;description:string;parameters:Record<string,unknown>}>;
type Variant=Readonly<{question:string;label:string;system:string|null;user:string;tools:readonly Tool[];toolChoice:'required'|'auto'|null;strict?:boolean}>;
type Outcome=Readonly<{question:string;label:string;status:number;finish:string|null;native:string|null;filtered:boolean;tools:readonly string[];content:string;usd:number;error?:string;
 /** The response body without the content, for any filter category the upstream passes through (first filtered request only). */
 raw?:string}>;
let rawKept=false;
async function send(variant:Variant):Promise<Outcome>{
 if(spentUsd>=BUDGET||calls>=400)return{question:variant.question,label:variant.label,status:0,finish:null,native:null,filtered:false,tools:[],content:'',usd:0,error:'probe_budget_exhausted'};
 calls++;
 const messages=[...(variant.system===null?[]:[{role:'system',content:variant.system}]),{role:'user',content:variant.user}];
 const tools=variant.tools.map(tool=>({type:'function',function:variant.strict?{name:tool.name,description:tool.description,parameters:strictToolSchema(tool.parameters as never),strict:true}:tool}));
 const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+KEY,'content-type':'application/json'},signal:AbortSignal.timeout(60_000),
  body:JSON.stringify({model:MODEL,messages,...(tools.length?{tools,tool_choice:variant.toolChoice??'auto'}:{}),max_tokens:HARNESS_SPEC.budgets.maxOutputTokensPerCall,usage:{include:true},
   provider:{data_collection:'deny',zdr:true,only:ALLOWED,allow_fallbacks:false}})});
 const text=await response.text();let body:{choices?:{finish_reason?:string;native_finish_reason?:string;message?:{content?:string|null;tool_calls?:{function:{name:string}}[]}}[];usage?:{cost?:number}}={};
 try{body=JSON.parse(text);}catch{/* reported below */}
 const usd=typeof body.usage?.cost==='number'?body.usage.cost:0;spentUsd+=usd;
 const choice=body.choices?.[0],finish=choice?.finish_reason??null,native=choice?.native_finish_reason??null;
 return{question:variant.question,label:variant.label,status:response.status,finish,native,filtered:finish==='content_filter'||native==='content_filter'||/content.?filter/i.test(response.ok?'':text),
  tools:(choice?.message?.tool_calls??[]).map(call=>call.function.name),content:(choice?.message?.content??'').slice(0,120),usd,...(response.ok?{}:{error:text.slice(0,300)}),
  ...(finish==='content_filter'&&!rawKept&&(rawKept=true)?{raw:JSON.stringify({...body,choices:body.choices?.map(row=>({...row,message:{...row.message,content:'[omitted]'}}))}).slice(0,1500)}:{})};
}
async function pool<T,R>(items:readonly T[],size:number,work:(item:T)=>Promise<R>):Promise<R[]>{
 const out:R[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(size,items.length)},async()=>{while(next<items.length){const index=next++;out[index]=await work(items[index]);}}));return out;
}
/** A string array literal in a source file at a commit, read from git (the instructions or a description). */
function sourceAt(commit:string,path:string){return execFileSync('git',['show',commit+':'+path],{encoding:'utf8',maxBuffer:8_000_000});}
function liveStagingInstructions():readonly string[]{
 const source=sourceAt(LIVE_STAGING,'core/harness/spec.ts'),start=source.indexOf(' instructions:['),end=source.indexOf('\n ],',start);
 if(start<0||end<0)throw Error('The live staging spec has no instruction list.');
 const list=new Function('return ['+source.slice(start+' instructions:['.length,end)+']')() as unknown;
 if(!Array.isArray(list)||!list.every(item=>typeof item==='string'))throw Error('The live staging instructions are not strings.');
 return list;
}
function liveStagingSuggestDescription():string{
 const match=/const SUGGEST_DESCRIPTION='((?:[^'\\]|\\.)*)'/.exec(sourceAt(LIVE_STAGING,'core/harness/tools.ts'));
 if(!match)throw Error('The live staging suggest_action description was not found.');
 return new Function('return \''+match[1]+'\'')() as string;
}

describe('content-filter probe on fictional data',()=>{
 if(!KEY||!MODEL)it('stays disabled and calls no provider without the protected evaluation secret',()=>{expect(Boolean(KEY&&MODEL)).toBe(false);expect(calls).toBe(0);});
 else it('finds which part of the first request the upstream filters',async()=>{
  if(!ALLOWED.length)throw Error('The probe needs AIHR_EVAL_ALLOWED_PROVIDERS.');
  const ctx=await employee(),today=todayInKualaLumpur(),roleNote=HARNESS_SPEC.roleNote.employee;
  const variants:Variant[]=[];
  for(const question of [...BLOCKED,CONTROL]){
   const request=await firstRequest(ctx,question),messages=request.messages.map(wire);
   const system=messages.find(row=>row.role==='system')?.content??'',user=messages.filter(row=>row.role==='user').at(-1)?.content??'';
   const tools:Tool[]=request.tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters as Record<string,unknown>}));
   const instructions=[...HARNESS_SPEC.instructions].map(line=>line.replace('{today}',today));
   // The rebuilt system text must be the captured one, so each instruction variant changes exactly one line.
   expect(system.startsWith(instructions.join(' ')+' '+roleNote),'rebuilt system text').toBe(true);
   const tail=system.slice(instructions.join(' ').length);
   const v=(label:string,change:Partial<Variant>={}):Variant=>({question,label,system,user,tools,toolChoice:request.toolChoice as 'required'|'auto',...change});
   const frames=Object.entries(FRAMES).flatMap(([label,frame])=>[v(label,{user:user.replace(question,frame(question))}),v(label+', production shape',{user:user.replace(question,frame(question)),toolChoice:'auto',strict:true})]);
   variants.push(v('full'),v('question only',{system:null,tools:[],toolChoice:null}),...frames,v('system note',{system:system+SYSTEM_NOTE}));
   if(MODEL!==CURRENT_MODEL)continue;
   variants.push(v('no tools',{tools:[],toolChoice:null}),v('no system',{system:null}),v('tool_choice auto',{toolChoice:'auto'}),v('production shape',{toolChoice:'auto',strict:true}));
   if(question===CONTROL)continue;
   // Repeats of the whole request and of each frame show whether an outcome is stable.
   variants.push(v('full again'),v('full third'),...frames.map(row=>({...row,label:row.label+' again'})));
   const live=liveStagingInstructions().map(line=>line.replace('{today}',today)),liveSuggest=liveStagingSuggestDescription();
   const liveTools=tools.map(tool=>tool.name===HARNESS_SPEC.offer.suggestTool?{...tool,description:liveSuggest}:tool);
   variants.push(v('live staging spec v8',{system:live.join(' ')+tail,tools:liveTools}),v('live staging spec v8, production shape',{system:live.join(' ')+tail,tools:liveTools,toolChoice:'auto',strict:true}));
   instructions.forEach((_,index)=>{
    variants.push(v('without instruction '+index,{system:instructions.filter((__,other)=>other!==index).join(' ')+tail}));
    variants.push(v('only instruction '+index,{system:instructions[index]+tail}));
   });
   tools.forEach((tool,index)=>variants.push(v('without tool '+tool.name,{tools:tools.filter((__,other)=>other!==index)})));
   for(const wording of REWORDINGS[question]??[])variants.push(v('reworded: '+wording,{user:user.replace(question,wording)}));
  }
  const outcomes=await pool(variants,6,send);
  for(const row of outcomes)process.stdout.write('CONTENT_FILTER_PROBE '+JSON.stringify({q:row.question,v:row.label,status:row.status,finish:row.finish,native:row.native,tools:row.tools,content:row.content.slice(0,60),...(row.error?{error:row.error.slice(0,160)}:{})})+'\n');
  const dir=process.env.RUNNER_TEMP?join(process.env.RUNNER_TEMP,'aihr-focused'):join(process.cwd(),'.review-evidence');mkdirSync(dir,{recursive:true});
  const instructionCount=HARNESS_SPEC.instructions.length;
  writeFileSync(join(dir,'assistant-content-filter.json'),JSON.stringify({kind:'teras.content-filter-probe',version:1,model:MODEL,allowedProviders:ALLOWED,spec:HARNESS_SPEC.version,liveStaging:LIVE_STAGING,
   instructions:instructionCount,spentUsd:Number(spentUsd.toFixed(4)),calls,outcomes},null,1));
  process.stdout.write('CONTENT_FILTER_PROBE_SUMMARY '+JSON.stringify({model:MODEL,calls,spentUsd:Number(spentUsd.toFixed(4)),filtered:outcomes.filter(row=>row.filtered).length,errors:outcomes.filter(row=>row.error).length})+'\n');
  expect(outcomes.filter(row=>row.error).length,'probe requests that failed').toBeLessThanOrEqual(Math.floor(outcomes.length*0.1));
 },900_000);
});
