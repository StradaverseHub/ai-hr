/** @vitest-environment jsdom */
/** Authored UNRUN DOM/canonical-view boundary cases. Native authorization, server action and actual
 * conversational browser/provider experience remain separate verification requirements. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en',data:{} as unknown}));
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,params?:Record<string,string|number>)=>{
 let value:unknown=copies[state.locale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing translated conversation copy');return value.replace(/\{(\w+)\}/g,(_whole,field:string)=>String(params?.[field]??''));
}}));
vi.mock('../app/assistant/actions',()=>({askAssistantAction:vi.fn()}));
vi.mock('../app/assistant/job-feedback-actions',()=>({saveGovernedJobFeedbackAction:vi.fn(),eraseGovernedJobFeedbackAction:vi.fn()}));
vi.mock('../app/assistant/governed-job-actions',()=>({runGovernedPlanAction:vi.fn()}));
vi.mock('../components/assistant/module-specialist-findings',()=>({ModuleSpecialistFindings:()=>null}));
vi.mock('../core/module-agent-releases',()=>({reopenGovernedModuleReadJobTx:vi.fn()}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>[]}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:vi.fn(async(_ctx:unknown,module:string,consume:(read:unknown)=>Promise<unknown>)=>consume({moduleWork:async()=>({module,capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1],scope:'current-caller',data:state.data})}))}));
import {askAssistantAction} from '../app/assistant/actions';
import {loadCanonicalModuleJob,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {GroundedWorkspaceReply} from '../components/assistant/module-jobs';
import {MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';
import type {AssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import type {GroundedWorkspaceAnswer} from '../core/workspace-grounded-answers';
import type {SessionContext} from '../db/client';
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const localeCopy=(locale:string)=>copies[locale] as typeof en;
const exchangeId='00000000-0000-4000-8000-000000000001';
type Selected=Readonly<{view:CanonicalModuleJobView;card:number;fact:number}>;
type Reply=GroundedWorkspaceAnswer&{conversation:{plan:AssistantAnswerPlan;facts:readonly Selected[]}|null};
function reply(plan:AssistantAnswerPlan,facts:readonly Selected[]=[]):Reply{return{mode:'generic',views:[],fallbackModules:[],partial:false,tools:[],conversation:{plan,facts}};}
function select(view:CanonicalModuleJobView,card:number,field:string):Selected{if(view.state!=='ready')throw Error('Expected actual issued canonical fixture');const fact=view.presentation.cards[card].facts.findIndex(value=>value.field===field);if(fact<0)throw Error('Missing canonical fixture field');return{view,card,fact};}
function answer(facts:readonly Selected[]):Reply{return reply({version:1,mode:'answer',blocks:facts.map(row=>({kind:'fact',read:0,card:row.card,fact:row.fact}))},facts);}
async function view(module:AgentModuleCode,data:unknown){state.data=data;return loadCanonicalModuleJob(ctx,{module});}
beforeEach(()=>{state.locale='en';vi.clearAllMocks();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('grounded conversation rendering',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('%s shows model-selected order using original canonical heading/field/value formatting with closed source details',async locale=>{
  state.locale=locale;const issued=await view('employees',{rows:[{employeeCode:'REC-FIRST',company:'Fictional first employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'},{employeeCode:'REC-SECOND',company:'Fictional second employer',hiredOn:'2021-01-01',terminatedOn:null,status:'active'}],truncated:false}),facts=[select(issued,1,'employeeCode'),select(issued,0,'employeeCode')];
  const result=render(await GroundedWorkspaceReply({ctx,reply:answer(facts)})),copy=localeCopy(locale).assistant.workspace;
  const region=screen.getByRole('region',{name:copy.conversation.answerLabel}),list=region.querySelector('ul')!;expect(within(list).getAllByRole('listitem').map(row=>row.textContent)).toEqual([`Fictional second employer — ${copy.jobs.field_employeeCode}: REC-SECOND`,`Fictional first employer — ${copy.jobs.field_employeeCode}: REC-FIRST`]);
  const details=result.container.querySelector('details')!;expect(details.open).toBe(false);expect(details.querySelector('summary')?.textContent).toBe(copy.conversation.sources);expect(details.textContent).toContain('REC-FIRST');expect(details.textContent).toContain('REC-SECOND');expect(askAssistantAction).not.toHaveBeenCalled();
 });
 it('copies canonical money decimals without model arithmetic, symbol substitution or rounding',async()=>{
  const issued=await view('payroll',{rows:[{payPeriod:'2026-01',company:'Fictional employer',gross:'1234.5600',deductions:'123.3300',net:'1111.2300',currency:'MYR',runType:'regular',runSeq:1}],truncated:false});render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'net'),select(issued,0,'gross')])}));
  const list=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}).querySelector('ul')!;expect(within(list).getAllByRole('listitem').map(row=>row.textContent)).toEqual([`2026-01 — ${en.assistant.workspace.jobs.field_net}: 1111.2300 MYR`,`2026-01 — ${en.assistant.workspace.jobs.field_gross}: 1234.5600 MYR`]);
 });
 it('refuses money without a valid recorded currency on the same card and never borrows another record unit',async()=>{
  for(const currency of [undefined,'myr','RM 1']){const issued=await view('payroll',{rows:[{payPeriod:'2026-01',company:'Fictional employer',gross:'1234.5600',currency},{payPeriod:'2026-02',company:'Other record',gross:'3.0000',currency:'USD'}],truncated:false});const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'gross')])}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.textContent).not.toContain('1234.5600');expect(shown.container.querySelector('details')).toBeNull();shown.unmount();}
 });
 it('refuses blank canonical fact text rather than showing an empty assertion',async()=>{const issued=await view('employees',{rows:[{employeeCode:'   ',company:'Fictional employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'employeeCode')])}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);});
 it('rejects copied and cross-caller views and mismatched selected indexes without falling back to their full cards',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'PRIVATE-CANONICAL',company:'PRIVATE-EMPLOYER',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}),selected=select(issued,0,'employeeCode');
  for(const input of [{principal:ctx,facts:[{...selected,view:JSON.parse(JSON.stringify(issued)) as CanonicalModuleJobView}],plan:answer([selected]).conversation!.plan},{principal:{...ctx,userId:'other'},facts:[selected],plan:answer([selected]).conversation!.plan},{principal:ctx,facts:[selected],plan:{version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:1,fact:selected.fact}]} as AssistantAnswerPlan}]){
   const shown=render(await GroundedWorkspaceReply({ctx:input.principal,reply:reply(input.plan,input.facts)}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.textContent).not.toContain('PRIVATE-');expect(shown.container.querySelector('details')).toBeNull();shown.unmount();
  }
 });
 it('refuses oversized or prose-bearing answer plans before disclosing canonical cards',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'BOUND-RECORD',company:'Fictional employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}),selected=select(issued,0,'employeeCode');
  for(const input of [answer(Array.from({length:17},()=>selected)),{...answer([selected]),conversation:{...answer([selected]).conversation!,plan:{...answer([selected]).conversation!.plan,text:'RAW-MODEL-PROSE'}}} as unknown as Reply]){const shown=render(await GroundedWorkspaceReply({ctx,reply:input}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.textContent).not.toContain('BOUND-RECORD');expect(shown.container.textContent).not.toContain('RAW-MODEL-PROSE');shown.unmount();}
 });
 it('refuses null/withheld selections and unsupported explanatory blocks rather than inventing an explanation',async()=>{
  const unknown=await view('employees',{rows:[{employeeCode:'NULL-RECORD',company:'Fictional employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}),hidden=await view('leave',{rows:[{company:'Fictional employer',balances:[{leaveType:'Annual',available:5,taken:1,pending:0,withheld:true}]}],truncated:false});
  for(const selected of [select(unknown,0,'terminatedOn'),select(hidden,0,'available')]){const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([selected])}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.querySelector('details')).toBeNull();shown.unmount();}
  const selected=select(unknown,0,'employeeCode'),bad={version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:0,fact:selected.fact},{kind:'explanation',read:0,card:0,code:'MODEL-INVENTED-WHY'}]} as unknown as AssistantAnswerPlan;
  const shown=render(await GroundedWorkspaceReply({ctx,reply:reply(bad,[selected,selected])}));expect(shown.container.textContent).not.toContain('MODEL-INVENTED-WHY');expect(shown.container.textContent).not.toContain('NULL-RECORD');expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s renders each closed clarification before generic mode and posts only bounded human reply plus server exchange identity',async locale=>{
  state.locale=locale;const copy=localeCopy(locale).assistant.workspace.conversation;
  for(const slot of ['employment','leave_type','period','module'] as const){const shown=render(await GroundedWorkspaceReply({ctx,exchangeId,reply:reply({version:1,mode:'clarify',slot})}));expect(screen.getByRole('heading').textContent).toBe(copy[`clarify_${slot}`]);const input=screen.getByRole('textbox',{name:copy.replyLabel}) as HTMLTextAreaElement;expect(input.required).toBe(true);expect(input.maxLength).toBe(500);fireEvent.change(input,{target:{value:'Fictional human reply'}});const form=input.closest('form')!,data=new FormData(form);expect([...data.keys()].sort()).toEqual(['clarificationAnswer','clarificationExchangeId']);expect(data.get('clarificationAnswer')).toBe('Fictional human reply');expect(data.get('clarificationExchangeId')).toBe(exchangeId);expect(screen.getByRole('button',{name:copy.continue}).className).toContain('min-h-11');expect(askAssistantAction).not.toHaveBeenCalled();shown.unmount();}
 });
 it('omits a clarification POST without a valid server exchange id',async()=>{for(const id of [undefined,'model-supplied-id']){const shown=render(await GroundedWorkspaceReply({ctx,exchangeId:id,reply:reply({version:1,mode:'clarify',slot:'period'})}));expect(shown.container.querySelector('form')).toBeNull();expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.reopenBeforeReply);shown.unmount();}});
 it.each(['en','ms','zh','ta','th','vi'])('%s keeps insufficient/refusal copy closed and legacy null fallback separate',async locale=>{
  state.locale=locale;const copy=localeCopy(locale).assistant.workspace;
  for(const plan of [{version:1,mode:'insufficient',code:'no_verified_facts'},{version:1,mode:'insufficient',code:'unsupported_explanation'},{version:1,mode:'refuse',code:'unsupported_request'},{version:1,mode:'refuse',code:'human_review_required'}] as const){const shown=render(await GroundedWorkspaceReply({ctx,reply:reply(plan)}));expect(screen.getByRole('status').textContent).toBe(copy.conversation[`${plan.mode}_${plan.code}` as keyof typeof copy.conversation]);expect(shown.container.querySelector('details')).toBeNull();shown.unmount();}
  const shown=render(await GroundedWorkspaceReply({ctx,reply:{...reply({version:1,mode:'clarify',slot:'period'}),conversation:null}}));expect(shown.container.textContent).toContain(copy.answers.generic);expect(shown.container.querySelector('form')).toBeNull();
 });
});
