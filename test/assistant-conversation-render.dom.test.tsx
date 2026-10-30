/** @vitest-environment jsdom */
/** Authored UNRUN DOM/canonical-view boundary cases. Native authorization, server action and actual
 * conversational browser/provider experience remain separate verification requirements. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en',data:{} as unknown,reviewLinks:vi.fn(),proposalCard:vi.fn()}));
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,params?:Record<string,string|number>)=>{
 let value:unknown=copies[state.locale];for(const part of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[part];if(typeof value!=='string')throw Error('Missing translated conversation copy');return value.replace(/\{(\w+)\}/g,(_whole,field:string)=>String(params?.[field]??''));
}}));
vi.mock('../app/assistant/actions',()=>({askAssistantAction:vi.fn()}));
vi.mock('../app/assistant/job-feedback-actions',()=>({saveGovernedJobFeedbackAction:vi.fn(),eraseGovernedJobFeedbackAction:vi.fn()}));
vi.mock('../app/assistant/governed-job-actions',()=>({runGovernedPlanAction:vi.fn()}));
// This spy tests the parent composition condition only; separate real-view footer cases own route boundaries.
vi.mock('../components/assistant/conversation-review-links',()=>({ConversationReviewLinks:async(props:unknown)=>{state.reviewLinks(props);return null;}}));
vi.mock('../components/assistant/module-specialist-findings',()=>({ModuleSpecialistFindings:()=>null}));
// The inline review card is a client component with its own DOM tests; here only the composition is checked.
vi.mock('../components/assistant/conversation-action-proposal',async()=>{const React=await import('react');return {ConversationActionProposal:(props:{action:string;hints:unknown})=>{state.proposalCard(props);return React.createElement('div',{'data-proposal-card':props.action});}};});
vi.mock('../core/module-agent-releases',()=>({reopenGovernedModuleReadJobTx:vi.fn(),readGovernedSpecialistToolResultTx:vi.fn()}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>[]}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:vi.fn(async(_ctx:unknown,module:string,consume:(read:unknown)=>Promise<unknown>)=>consume({moduleWork:async()=>({module,capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)![1],scope:'current-caller',data:state.data})}))}));
import {askAssistantAction} from '../app/assistant/actions';
import {loadCanonicalModuleJob,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {GroundedWorkspaceReply} from '../components/assistant/module-jobs';
import {projectMineLeaveBalance} from '../core/assistant-leave-projection';
import {resolveEssView} from '../core/ess-view';
import {MODULE_AGENT_CAPABILITIES,type AgentModuleCode} from '../lib/ai/module-agents';
import type {AssistantAnswerPlan} from '../lib/ai/assistant-answer-plan';
import type {AssistantAnswerExplanation} from '../lib/ai/assistant-answer-explanations';
import type {GroundedWorkspaceAnswer} from '../core/workspace-grounded-answers';
import type {SessionContext} from '../db/client';
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]};
const localeCopy=(locale:string)=>copies[locale] as typeof en;
const exchangeId='00000000-0000-4000-8000-000000000001';
type Selected=Readonly<{view:CanonicalModuleJobView;card:number;fact:number}>;
type Segment=Readonly<{kind:'fact';view:CanonicalModuleJobView;card:number;fact:number}>|Readonly<{kind:'explanation';view:CanonicalModuleJobView;explanation:AssistantAnswerExplanation}>;
type Reply=GroundedWorkspaceAnswer&{conversation:{plan:AssistantAnswerPlan;facts:readonly Selected[];segments?:readonly Segment[];clarificationAllowed?:false}|null};
function reply(plan:AssistantAnswerPlan,facts:readonly Selected[]=[]):Reply{return{mode:'generic',views:[],fallbackModules:[],partial:false,tools:[],conversation:{plan,facts}};}
function select(view:CanonicalModuleJobView,card:number,field:string):Selected{if(view.state!=='ready')throw Error('Expected actual issued canonical fixture');const fact=view.presentation.cards[card].facts.findIndex(value=>value.field===field);if(fact<0)throw Error('Missing canonical fixture field');return{view,card,fact};}
function answer(facts:readonly Selected[]):Reply{return reply({version:1,mode:'answer',blocks:facts.map(row=>({kind:'fact',read:0,card:row.card,fact:row.fact}))},facts);}
async function view(module:AgentModuleCode,data:unknown){state.data=data;return loadCanonicalModuleJob(ctx,{module});}
beforeEach(()=>{state.locale='en';vi.clearAllMocks();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('grounded conversation rendering',()=>{
 it('answers agent switch counts directly and exposes only the source-owned group administration link',async()=>{
  const principal={...ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  state.data={capabilities:[{module:'assistant',capability:'current-caller'}],adminAgentStatus:{total:3,switchesOn:1,effectiveSwitchesOn:0,managementHref:'/control-tower/agents/features#ai-features'}};
  const issued=await loadCanonicalModuleJob(principal,{module:'assistant'}),selected=[select(issued,0,'backgroundAgentsTotal'),select(issued,0,'backgroundAgentSwitchesOn')];
  const shown=render(await GroundedWorkspaceReply({ctx:principal,reply:answer(selected)}));
  expect(shown.container).toHaveTextContent('There are 3 scheduled-agent switches in this view.');expect(shown.container).toHaveTextContent('1 scheduled-agent switch is on.');
  expect(screen.getByRole('link',{name:en.assistant.workspace.conversation.manageAgentSwitches})).toHaveAttribute('href','/control-tower/agents/features#ai-features');
  expect(shown.container).toHaveTextContent(en.assistant.workspace.conversation.backgroundSwitchNote);expect(shown.container).not.toHaveTextContent('3 agents are running');
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s shows model-selected order using original canonical heading/field/value formatting with closed source details',async locale=>{
  state.locale=locale;const issued=await view('employees',{rows:[{employeeCode:'REC-FIRST',company:'Fictional first employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'},{employeeCode:'REC-SECOND',company:'Fictional second employer',hiredOn:'2021-01-01',terminatedOn:null,status:'active'}],truncated:false}),facts=[select(issued,1,'employeeCode'),select(issued,0,'employeeCode')];
  const result=render(await GroundedWorkspaceReply({ctx,reply:answer(facts)})),copy=localeCopy(locale).assistant.workspace;
  const region=screen.getByRole('region',{name:copy.conversation.answerLabel}),table=within(region).getByRole('table',{name:copy.conversation.comparison});
  expect(within(table).getAllByRole('columnheader').map(row=>[row.textContent,row.getAttribute('scope')])).toEqual([[copy.conversation.recordColumn,'col'],[copy.jobs.field_employeeCode,'col']]);
  expect(within(table).getAllByRole('rowheader').map(row=>[row.textContent,row.getAttribute('scope')])).toEqual([['Fictional second employer','row'],['Fictional first employer','row']]);
  expect(within(table).getAllByRole('cell').map(row=>row.textContent)).toEqual(['REC-SECOND','REC-FIRST']);expect(table.parentElement?.className).toContain('overflow-x-auto');
  expect(region.querySelector(':scope > ul')).toBeNull();
  const details=result.container.querySelector('details')!;expect(details.open).toBe(false);expect(details.querySelector('summary')?.textContent).toBe(copy.conversation.sources);expect(details.textContent).toContain('REC-FIRST');expect(details.textContent).toContain('REC-SECOND');expect(askAssistantAction).not.toHaveBeenCalled();
 });
 it('renders mixed facts and an original canonical explanation in exact plan order with only paired facts in the fact subset',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'MIXED-RECORD',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});
  if(issued.state!=='ready')throw Error('Actual canonical view unavailable');const explanation=issued.answerExplanations?.find(row=>row.code==='specialist_finding:employment_active');if(!explanation)throw Error('Actual owner must attach source explanations before issuance');
  const first=select(issued,0,'employeeCode'),last=select(issued,0,'company'),segments:readonly Segment[]=[{kind:'fact',...first},{kind:'explanation',view:issued,explanation},{kind:'fact',...last}],plan:AssistantAnswerPlan={version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:0,fact:first.fact},{kind:'explanation',read:0,card:explanation.card,code:explanation.code},{kind:'fact',read:0,card:0,fact:last.fact}]};
  const shown=render(await GroundedWorkspaceReply({ctx,reply:{...reply(plan,[first,last]),conversation:{plan,facts:[first,last],segments}}}));const region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}),list=region.querySelector('[data-conversation-paragraphs]')!;expect(list).not.toBeNull();expect(region.querySelector(':scope > ol')).toBeNull();expect(region.querySelector('table')).toBeNull();
  expect([...list.children].map(row=>row.textContent)).toEqual(['The employee code recorded for Canonical employer is MIXED-RECORD.',en.assistant.workspace.specialistFindings.employment_active,'This record is with Canonical employer.']);
  expect(shown.container.querySelectorAll('details')).toHaveLength(1);expect(state.reviewLinks).not.toHaveBeenCalled();
 });
 it('answers in full sentences and keeps technical provenance inside closed Sources',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'COMPACT-REC',company:'Only employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});
  const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'employeeCode'),select(issued,0,'company')])})),region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}),list=region.querySelector('[data-conversation-paragraphs]')!;
  expect([...list.children].map(row=>row.textContent)).toEqual(['The employee code recorded for Only employer is COMPACT-REC.','This record is with Only employer.']);
  expect(list.querySelector('ul,ol,dl')).toBeNull();
  expect([...region.querySelectorAll(':scope > p')].map(row=>row.textContent)).not.toContain(en.assistant.workspace.conversation.canonicalNote);
  const details=region.querySelector('details')!;expect(details.open).toBe(false);expect(details.textContent).toContain(en.assistant.workspace.conversation.canonicalNote);expect(shown.container.textContent).not.toContain(' — ');
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s answers an actual available-area catalogue with useful source guidance and a concise permission boundary',async locale=>{
  state.locale=locale;const modules=['leave','payroll','claims','org','employees','attendance','performance'] as const,issued=await view('assistant',{capabilities:modules.map(module=>({module,capability:'fictional-binding',secret:'PRIVATE-PAYLOAD'})),effects:'human-confirmation-only'}),copy=localeCopy(locale).assistant.workspace;
  const shown=render(await GroundedWorkspaceReply({ctx,reply:{mode:'grounded',views:[issued],fallbackModules:[],partial:false,tools:['my_module_work'],conversation:null}}));
  const root=shown.container.firstElementChild!,summary=root.firstElementChild!;expect(summary.textContent).toContain(copy.conversation.catalogueIntro);expect(summary.textContent).toContain(copy.conversation.catalogueScope);
  expect([...summary.querySelectorAll(':scope > ul > li')].map(row=>row.textContent)).toEqual([copy.conversation.example_leave,copy.conversation.example_payroll,copy.conversation.example_claims]);
  const more=summary.querySelector('details')!;expect(more.open).toBe(false);expect(more.querySelector('summary')?.textContent).toBe(copy.conversation.allAreas);expect(more.textContent).toContain(copy.jobs.module_performance);
  expect(summary.textContent).not.toContain(copy.jobs.module_rewards);expect(root.textContent).not.toContain('PRIVATE-PAYLOAD');expect(root.textContent).not.toContain('fictional-binding');
  const sources=[...root.children].find(row=>row.tagName==='DETAILS') as HTMLDetailsElement;expect(sources.open).toBe(false);expect(sources.querySelector('summary')?.textContent).toBe(copy.conversation.sources);shown.unmount();
 });
 it('renders the same helpful catalogue for an original checked catalogue explanation',async()=>{
  const issued=await view('assistant',{capabilities:[{module:'leave',capability:'own_leave_balances'}],effects:'human-confirmation-only'});if(issued.state!=='ready')throw Error('Expected canonical catalogue');
  const explanation=issued.answerExplanations?.find(row=>row.code==='specialist_finding:catalogue_not_permission');if(!explanation)throw Error('Expected original catalogue descriptor');
  const plan:AssistantAnswerPlan={version:1,mode:'answer',blocks:[{kind:'explanation',read:0,card:explanation.card,code:explanation.code}]};
  const shown=render(await GroundedWorkspaceReply({ctx,reply:{mode:'grounded',views:[issued],fallbackModules:[],partial:false,tools:['my_module_work'],conversation:{plan,facts:[],segments:[{kind:'explanation',view:issued,explanation}]}}}));
  expect(shown.container.textContent).toContain(en.assistant.workspace.conversation.catalogueIntro);expect(shown.container.textContent).toContain(en.assistant.workspace.conversation.example_leave);expect(shown.container.textContent).toContain(en.assistant.workspace.conversation.catalogueScope);expect(screen.queryByRole('status')).toBeNull();
 });
 it('does not turn a cloned or foreign catalogue into capability claims',async()=>{
  const issued=await view('assistant',{capabilities:[{module:'payroll',capability:'own_released_payslips'}],effects:'human-confirmation-only'});
  for(const [source,principal] of [[JSON.parse(JSON.stringify(issued)) as CanonicalModuleJobView,ctx],[issued,{...ctx,userId:'another-user'}]] as const){
   const shown=render(await GroundedWorkspaceReply({ctx:principal,reply:{mode:'grounded',views:[source],fallbackModules:[],partial:false,tools:['my_module_work'],conversation:null}}));
   expect(shown.container.textContent).not.toContain(en.assistant.workspace.conversation.catalogueIntro);expect(shown.container.textContent).not.toContain(en.assistant.workspace.conversation.example_payroll);expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.jobs.unavailable);shown.unmount();
  }
 });
 it('keeps unselected legacy records under Sources and does not present them as a verified answer',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'LEGACY-SOURCE',company:'Legacy employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:true});
  const shown=render(await GroundedWorkspaceReply({ctx,reply:{mode:'grounded',views:[issued],fallbackModules:[],partial:true,tools:['my_module_work'],conversation:null}})),root=shown.container.firstElementChild!,details=root.querySelector('details')!;
  expect(root.firstElementChild?.textContent).toBe(en.assistant.workspace.answers.grounded);expect(details.open).toBe(false);expect(details.textContent).toContain('LEGACY-SOURCE');expect([...root.children].filter(row=>row.tagName!=='DETAILS').map(row=>row.textContent).join('')).not.toContain('LEGACY-SOURCE');expect(root.textContent).toContain(en.assistant.workspace.answers.partial);
 });
 it('refuses a whole mixed answer before disclosing facts for a cloned, foreign or plan-mismatched explanation',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'MIXED-PRIVATE-RECORD',company:'MIXED-PRIVATE-COMPANY',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}),other=await view('employees',{rows:[{employeeCode:'OTHER-PRIVATE',company:'OTHER-PRIVATE-COMPANY',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});
  if(issued.state!=='ready'||other.state!=='ready')throw Error('Actual canonical views unavailable');const explanation=issued.answerExplanations?.find(row=>row.code==='specialist_finding:employment_active'),foreign=other.answerExplanations?.find(row=>row.code==='specialist_finding:employment_active');if(!explanation||!foreign)throw Error('Missing original source explanations');const selected=select(issued,0,'employeeCode');
  for(const selectedExplanation of [JSON.parse(JSON.stringify(explanation)) as AssistantAnswerExplanation,foreign,explanation]){
   const mismatch=selectedExplanation===explanation,plan:AssistantAnswerPlan={version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:0,fact:selected.fact},{kind:'explanation',read:0,card:explanation.card,code:mismatch?'specialist_finding:scope_current_caller':explanation.code}]},segments:readonly Segment[]=[{kind:'fact',...selected},{kind:'explanation',view:issued,explanation:selectedExplanation}];
   const shown=render(await GroundedWorkspaceReply({ctx,reply:{...reply(plan,[selected]),conversation:{plan,facts:[selected],segments}}}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.textContent).not.toMatch(/MIXED-PRIVATE|OTHER-PRIVATE/);expect(shown.container.querySelector('details')).toBeNull();shown.unmount();
  }
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s removes the clarification form when the sealed human context cannot accept another reply',async locale=>{
  state.locale=locale;const plan:AssistantAnswerPlan={version:1,mode:'clarify',slot:'period'},shown=render(await GroundedWorkspaceReply({ctx,exchangeId,reply:{...reply(plan),conversation:{plan,facts:[],clarificationAllowed:false}}}));expect(screen.getByRole('status').textContent).toBe(localeCopy(locale).assistant.workspace.conversation.contextLimit);expect(shown.container.querySelector('form')).toBeNull();expect(screen.queryByRole('textbox')).toBeNull();expect(askAssistantAction).not.toHaveBeenCalled();expect(state.reviewLinks).not.toHaveBeenCalled();
 });
 it('composes the source-owned handoff footer only for human_review_required, without claiming route or effect authorization',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'CONDITION-RECORD',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}),selected=select(issued,0,'employeeCode'),views=[issued];
  for(const input of [answer([selected]),reply({version:1,mode:'clarify',slot:'module'}),reply({version:1,mode:'refuse',code:'unsupported_request'}),reply({version:1,mode:'insufficient',code:'no_verified_facts'}),reply({version:1,mode:'insufficient',code:'unsupported_explanation'})]){const shown=render(await GroundedWorkspaceReply({ctx,exchangeId,reply:{...input,views}}));expect(state.reviewLinks).not.toHaveBeenCalled();shown.unmount();}
  const shown=render(await GroundedWorkspaceReply({ctx,reply:{...reply({version:1,mode:'refuse',code:'human_review_required'}),views}}));expect(state.reviewLinks).toHaveBeenCalledTimes(1);expect(state.reviewLinks).toHaveBeenCalledWith({views,ctx});expect(shown.container.querySelector('a')).toBeNull();expect(askAssistantAction).not.toHaveBeenCalled();
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s greets and acknowledges thanks conversationally without a factual lookup or effect',async locale=>{
  state.locale=locale;const copy=localeCopy(locale).assistant.workspace.conversation;
  for(const code of ['greeting','thanks'] as const){const shown=render(await GroundedWorkspaceReply({ctx,reply:reply({version:1,mode:'social',code})}));expect(shown.container.textContent).toBe(copy[`social_${code}`]);expect(shown.container.querySelector('form,details,a')).toBeNull();expect(screen.queryByRole('status')).toBeNull();expect(state.reviewLinks).not.toHaveBeenCalled();expect(state.proposalCard).not.toHaveBeenCalled();shown.unmount();}
 });
 it('refuses invented social text, effects, codes or attached record selectors',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'SOCIAL-PRIVATE',company:'Social employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});
  for(const [plan,facts] of [[{version:1,mode:'social',code:'greeting',text:'MODEL-HR-CLAIM'},[]],[{version:1,mode:'social',code:'approve_leave'},[]],[{version:1,mode:'social',code:'thanks'},[select(issued,0,'employeeCode')]]] as const){
   const shown=render(await GroundedWorkspaceReply({ctx,reply:reply(plan as unknown as AssistantAnswerPlan,facts)}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.textContent).not.toMatch(/SOCIAL-PRIVATE|MODEL-HR-CLAIM/);shown.unmount();
  }
 });
 it('answers a leave-balance question directly without guessing days or showing unrelated figures',async()=>{
  const issued=await view('leave',{rows:[{company:'Balance employer',balances:[{leaveType:'Annual',available:7.25,taken:2,pending:1,withheld:false}]}],truncated:false});
  render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'available')])}));const region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}),line=region.querySelector(':scope > p')!;
  expect(line.textContent).toBe('Your Annual balance is 7.25.');expect(line.textContent).not.toMatch(/days|hours|pending|Available:/);expect(region.querySelector('details')?.open).toBe(false);
 });
 it('answers a claim-status question in a sentence without calling approval a payment',async()=>{
  const issued=await view('claims',{hasEmployment:true,claims:[{claimType:'Travel',status:'approved',incurredOn:'2026-10-01',createdAt:null,decidedAt:null,paidAt:null}],truncated:false});
  render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'status')])}));const line=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}).querySelector(':scope > p')!;
  expect(line.textContent).toBe('The Travel claim is marked Approved.');expect(line.textContent).not.toMatch(/paid|payment|your/i);
 });
 it('copies canonical money decimals without model arithmetic, symbol substitution or rounding',async()=>{
  const issued=await view('payroll',{rows:[{payPeriod:'2026-01',company:'Fictional employer',gross:'1234.5600',deductions:'123.3300',net:'1111.2300',currency:'MYR',runType:'regular',runSeq:1}],truncated:false});render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'net'),select(issued,0,'gross')])}));
  const list=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}).querySelector('[data-conversation-paragraphs]')!;expect([...list.children].map(row=>row.textContent)).toEqual(['The net pay recorded for 2026-01 is 1111.2300 MYR.','The gross pay recorded for 2026-01 is 1234.5600 MYR.']);
 });
 it('keeps mismatched selected fields and interleaved records as exact-order sentences, never a false comparison table',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'FIELD-A',company:'Employer A',hiredOn:'2020-01-01',terminatedOn:null,status:'active'},
   {employeeCode:'FIELD-B',company:'Employer B',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});
  for(const [facts,expected] of [
   [[select(issued,0,'employeeCode'),select(issued,1,'company')],['The employee code recorded for Employer A is FIELD-A.','This record is with Employer B.']],
   [[select(issued,0,'employeeCode'),select(issued,1,'employeeCode'),select(issued,0,'company')],['The employee code recorded for Employer A is FIELD-A.','The employee code recorded for Employer B is FIELD-B.','This record is with Employer A.']],
  ] as const){
   const shown=render(await GroundedWorkspaceReply({ctx,reply:answer(facts)})),region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel});
   expect(region.querySelector('table')).toBeNull();expect([...region.querySelector('[data-conversation-paragraphs]')!.children].map(row=>row.textContent)).toEqual(expected);shown.unmount();
  }
 });
 it('never compares unlike recorded money units or recomputes their values into a common currency',async()=>{
  const issued=await view('payroll',{rows:[{payPeriod:'2026-01',company:'Employer A',net:'9.0010',currency:'MYR'},
   {payPeriod:'2026-02',company:'Employer B',net:'8.0020',currency:'USD'}],truncated:false});
  render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,1,'net'),select(issued,0,'net')])}));
  const region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel});expect(region.querySelector('table')).toBeNull();
  expect([...region.querySelector('[data-conversation-paragraphs]')!.children].map(row=>row.textContent)).toEqual(['The net pay recorded for 2026-02 is 8.0020 USD.','The net pay recorded for 2026-01 is 9.0010 MYR.']);
 });
 it('renders one original recorded fact as a concise paragraph with closed source details',async()=>{
  const issued=await view('employees',{rows:[{employeeCode:'SINGLE-REC',company:'Only employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false});
  const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'employeeCode')])})),region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel});
  expect([...region.querySelectorAll(':scope > p')].map(row=>row.textContent)).toContain('The employee code recorded for Only employer is SINGLE-REC.');
  expect(region.querySelector(':scope > ul,:scope > ol,:scope > table')).toBeNull();expect(region.querySelector('progress')).toBeNull();
  const details=shown.container.querySelector('details')!;expect(details.open).toBe(false);expect(details.textContent).toContain('SINGLE-REC');
 });
 it.each([0,37,100])('uses the exact engine progressPercent %s in an accessible native progress bar without deriving a new percent',async percent=>{
  const issued=await view('lifecycle',{status:'active',progress:{done:1,total:3,percent},steps:[]});
  render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'progressPercent')])}));
  const region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel}),bar=within(region).getByRole('progressbar',{name:en.assistant.workspace.jobs.field_progressPercent}) as HTMLProgressElement;
  expect(bar.getAttribute('value')).toBe(String(percent));expect(bar.getAttribute('max')).toBe('100');expect(bar.textContent).toBe(percent+'%');
  expect(region.querySelector(':scope > ul,:scope > ol')).toBeNull();expect(askAssistantAction).not.toHaveBeenCalled();
 });
 it('does not fabricate a progress percentage from recorded done/total when the engine percentage is null',async()=>{
  const issued=await view('lifecycle',{status:'active',progress:{done:1,total:3,percent:null},steps:[]});
  const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'progressDone'),select(issued,0,'progressTotal')])})),region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel});
  expect(within(region).queryByRole('progressbar')).toBeNull();expect(region.querySelector('table')).toBeNull();expect(region.textContent).not.toMatch(/33(?:\.3+)?%/);shown.unmount();
  const refused=render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'progressPercent')])}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(refused.container.querySelector('progress')).toBeNull();
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
  const unknown=await view('employees',{rows:[{employeeCode:'NULL-RECORD',company:'Fictional employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false}),hidden=await view('leave',{rows:[{company:'Fictional employer',balances:[projectMineLeaveBalance({leaveTypeId:'fictional-type',leaveType:'Annual',accrued:9876,taken:1,pending:0,balance:8765,available:5,essView:resolveEssView({available:false})})]}],truncated:false});
  if(hidden.state!=='ready')throw Error('Actual fieldwise Mine fixture unavailable');expect(hidden.presentation.cards[0].facts.some(row=>row.field==='available')).toBe(false);
  for(const selected of [select(unknown,0,'terminatedOn'),{view:hidden,card:0,fact:hidden.presentation.cards[0].facts.length}]){const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([selected])}));expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.querySelector('details')).toBeNull();shown.unmount();}
  const selected=select(unknown,0,'employeeCode'),bad={version:1,mode:'answer',blocks:[{kind:'fact',read:0,card:0,fact:selected.fact},{kind:'explanation',read:0,card:0,code:'MODEL-INVENTED-WHY'}]} as unknown as AssistantAnswerPlan;
  const shown=render(await GroundedWorkspaceReply({ctx,reply:reply(bad,[selected,selected])}));expect(shown.container.textContent).not.toContain('MODEL-INVENTED-WHY');expect(shown.container.textContent).not.toContain('NULL-RECORD');expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);
 });
 it('renders an actually permitted Mine fact when another field is hidden, without restoring its ledger aliases',async()=>{
  const balance=projectMineLeaveBalance({leaveTypeId:'fictional-type',leaveType:'Annual',accrued:9876,taken:2.5,pending:1,balance:8765,available:7,
   essView:resolveEssView({available:false})}),issued=await view('leave',{rows:[{company:'Fieldwise employer',balances:[balance]}],truncated:false});
  if(issued.state!=='ready')throw Error('Actual fieldwise Mine fixture unavailable');
  expect(issued.presentation.cards[0].withheld).toBe(true);expect(issued.presentation.cards[0].facts.map(row=>row.field)).toEqual(['company','taken','pending']);
  const shown=render(await GroundedWorkspaceReply({ctx,reply:answer([select(issued,0,'taken')])})),region=screen.getByRole('region',{name:en.assistant.workspace.conversation.answerLabel});
  const answerLine=[...region.querySelectorAll(':scope > p')].find(row=>row.querySelector('.tabular-nums'));
  expect(answerLine?.textContent).toContain('Your Annual record shows 2.5 taken.');
  expect(answerLine?.querySelector('.tabular-nums')?.textContent).toBe('Your Annual record shows 2.5 taken.');
  expect(answerLine?.textContent).toContain(en.assistant.workspace.jobs.withheld);
  expect(screen.queryByRole('status')).toBeNull();expect(shown.container.textContent).not.toMatch(/9876|8765/);expect(region.querySelector('table')).toBeNull();
  expect(region.querySelector('details')?.open).toBe(false);
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
describe('ADR-0151 §4.3 inline proposal card',()=>{
 it('renders the card for an adjudicated proposal inside the exchange, with no review links or facts',async()=>{
  state.proposalCard.mockClear();state.reviewLinks.mockClear();
  const plan:AssistantAnswerPlan={version:1,mode:'propose',action:'leave.cancel',hints:{startDate:'2026-11-03'}};
  const shown=render(await GroundedWorkspaceReply({ctx,exchangeId,reply:reply(plan)}));
  expect(shown.container.querySelector('[data-proposal-card="leave.cancel"]')).not.toBeNull();
  expect(state.proposalCard).toHaveBeenCalledWith({action:'leave.cancel',hints:{startDate:'2026-11-03'}});expect(state.reviewLinks).not.toHaveBeenCalled();
 });
 it('refuses a widened, fact-carrying or undeclared proposal before rendering any card',async()=>{
  state.proposalCard.mockClear();
  for(const [plan,facts] of [
   [{version:1,mode:'propose',action:'leave.cancel',hints:{},actionId:'00000000-0000-4000-8000-000000000009'},[]],
   [{version:1,mode:'propose',action:'payroll.close',hints:{}},[]],
  ] as const){
   const shown=render(await GroundedWorkspaceReply({ctx,exchangeId,reply:reply(plan as unknown as AssistantAnswerPlan,facts)}));
   expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.conversation.unavailable);expect(shown.container.querySelector('[data-proposal-card]')).toBeNull();cleanup();
  }
  expect(state.proposalCard).not.toHaveBeenCalled();
 });
});
