/** @vitest-environment jsdom */
/** Authored UNRUN interaction/copy contracts. Actual browser/locale/a11y experience still required. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const state=vi.hoisted(()=>({locale:'en',data:{rows:[{employeeCode:'CANONICAL-01',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false} as unknown,fail:false,tools:[] as unknown[]}));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:string)=>(key:string,params?:Record<string,string|number>)=>{
 let value:unknown=copies[state.locale];for(const name of [...namespace.split('.'),...key.split('.')])value=(value as Record<string,unknown>)[name];
 if(typeof value!=='string')throw Error('Missing test translation '+namespace+'.'+key);
 return value.replace(/\{(\w+)\}/g,(_whole,field:string)=>String(params?.[field]??'{'+field+'}'));
}}));
vi.mock('../app/assistant/job-feedback-actions',()=>({saveGovernedJobFeedbackAction:vi.fn(),eraseGovernedJobFeedbackAction:vi.fn()}));
vi.mock('../app/assistant/governed-job-actions',()=>({runGovernedPlanAction:vi.fn()}));
vi.mock('../app/assistant/actions',()=>({askAssistantAction:vi.fn()}));
// The findings panel is an async server component (own coverage: module-specialist-review.dom). A client
// render cannot resolve a nested async component, so the whole card suspended and rendered nothing.
vi.mock('../components/assistant/module-specialist-findings',()=>({ModuleSpecialistFindings:()=>null}));
vi.mock('../core/module-agent-releases',()=>({reopenGovernedModuleReadJobTx:vi.fn()}));
vi.mock('../core/assistant-tools',()=>({toolsFor:()=>state.tools}));
vi.mock('../core/assistant-read-session',()=>({withAssistantRead:vi.fn(async(_ctx:unknown,module:string,consume:(read:unknown)=>Promise<unknown>)=>consume({moduleWork:async()=>{
 if(state.fail)throw Error('PRIVATE_DATABASE_ERROR_BODY');const binding=MODULE_AGENT_CAPABILITIES.find(row=>row[0]===module)!;
 return {module,capability:binding[1],scope:'current-caller',data:state.data};
}}))}));
import {withAssistantRead} from '../core/assistant-read-session';
import {loadCanonicalModuleJob,loadCanonicalToolJob,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {CanonicalModuleJob,ModuleJobChooser,GroundedWorkspaceReply,GovernedModuleJobComposer} from '../components/assistant/module-jobs';
import {AGENT_MODULE_CODES,MODULE_AGENT_CAPABILITIES} from '../lib/ai/module-agents';
import {MODULE_ACTION_ENTRIES} from '../lib/assistant-actions/module-action-entries';
import {moduleHumanActionHandoffs} from '../lib/ai/module-human-handoffs';
import {assistantSourceDigest} from '../lib/ai/assistant-disclosure';
import {compactSpecialistWork,executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import type {AssistantReadSession} from '../core/assistant-read-session';
import type {SessionContext} from '../db/client';
const copies:Record<string,unknown>={en,ms,zh,ta,th,vi:viMessages};
const ctx:SessionContext={tenantId:'fictional-tenant',userId:'fictional-user',personId:'fictional-person',roles:['employee'],grants:[{role:'employee',companyId:null}]};
beforeEach(()=>{vi.clearAllMocks();state.locale='en';state.fail=false;state.tools=[];state.data={rows:[{employeeCode:'CANONICAL-01',company:'Canonical employer',hiredOn:'2020-01-01',terminatedOn:null,status:'active'}],truncated:false};});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('native-action shortcuts follow the target action authorization',()=>{
 const gated=['/admin/personnel/import','/assistant/org','/assistant/payroll-close','/assistant/knowledge-base','/assistant/payroll-runs','/assistant/pay-codes','/assistant/approvals','/assistant/statutory','/assistant/rewards/calendar','/assistant/rewards/cancel','/assistant/rewards'];
 const hrefs=(container:HTMLElement)=>Array.from(container.querySelectorAll<HTMLAnchorElement>('a')).map(link=>link.getAttribute('href'));
 it('hides every administrative shortcut from an ordinary employee and keeps own-record shortcuts',async()=>{
  const view=render(await ModuleJobChooser({modules:AGENT_MODULE_CODES}));const shown=hrefs(view.container);
  for(const href of gated)expect(shown).not.toContain(href);
  for(const href of ['/assistant/leave','/assistant/profile','/assistant/claims','/assistant/attendance','/assistant/notifications'])expect(shown).toContain(href);
  expect(screen.queryByRole('link',{name:en.people.import.title})).toBeNull();expect(screen.queryByRole('link',{name:en.assistant.workspace.orgActions.title})).toBeNull();
  expect(screen.queryByRole('link',{name:en.assistant.workspace.payComponentActions.title})).toBeNull();expect(screen.queryByRole('link',{name:en.assistant.workspace.approvalActions.title})).toBeNull();expect(screen.queryByRole('link',{name:en.assistant.workspace.rewardsActions.title})).toBeNull();
  expect(withAssistantRead).not.toHaveBeenCalled();
 });
 it('shows a manager only the assigned-decision shortcut it was granted, and HR admin every one',async()=>{
  const manager=render(await ModuleJobChooser({modules:AGENT_MODULE_CODES,actions:['assigned_leave']}));const managerLinks=hrefs(manager.container);
  expect(managerLinks).toContain('/assistant/approvals');for(const href of gated.filter(href=>href!=='/assistant/approvals'))expect(managerLinks).not.toContain(href);manager.unmount();
  const admin=render(await ModuleJobChooser({modules:AGENT_MODULE_CODES,actions:MODULE_ACTION_ENTRIES}));for(const href of gated)expect(hrefs(admin.container)).toContain(href);
 });
 it('never offers a shortcut for a task card that is not shown',async()=>{
  const view=render(await ModuleJobChooser({modules:['leave'],actions:MODULE_ACTION_ENTRIES}));for(const href of gated)expect(hrefs(view.container)).not.toContain(href);
 });
});
describe('deterministic current-user job cards',()=>{
 it.each(['en','ms','zh','ta','th','vi'])('%s presents meaningful canonical facts with accessible headings and refresh controls',async locale=>{
  state.locale=locale;const view=await loadCanonicalModuleJob(ctx,{module:'employees'});render(await CanonicalModuleJob({view,ctx}));
  const copy=(copies[locale] as typeof en).assistant.workspace.jobs;
  expect(screen.getByRole('heading',{name:copy.module_employees})).toBeTruthy();expect(screen.getByText('CANONICAL-01')).toBeTruthy();
  expect(screen.getByText(copy.field_employeeCode)).toBeTruthy();expect(screen.getByRole('button',{name:copy.refresh})).toBeTruthy();
  const refresh=screen.getByRole('button',{name:copy.refresh}).closest('form')!;expect(refresh.getAttribute('method')).toBe('get');
  expect(new FormData(refresh).get('job')).toBe('employees');expect(screen.queryByText('fictional-user')).toBeNull();
 });
 it('discovers20 real tasks without reading any of them or placing HR facts/subjects into links',async()=>{
  const view=render(await ModuleJobChooser({modules:AGENT_MODULE_CODES,selected:'leave',actions:MODULE_ACTION_ENTRIES}));
  expect(screen.getAllByRole('link').map(link=>link.getAttribute('href')).sort()).toEqual([
   ...AGENT_MODULE_CODES.map(module=>'/assistant?job='+encodeURIComponent(module)),
   '/assistant/payroll-runs','/assistant/statutory','/assistant/payroll-close','/admin/personnel/import','/assistant/rewards/return','/assistant/rewards/calendar','/assistant/rewards/cancel','/assistant/rewards','/assistant/pay-codes','/assistant/attendance','/assistant/approvals','/assistant/leave','/assistant/profile','/assistant/notifications','/assistant/performance','/assistant/claims','/assistant/testing','/assistant/org','/assistant/knowledge-base','/assistant/lifecycle','/assistant/toil',
  ].sort());expect(withAssistantRead).not.toHaveBeenCalled();
  expect(screen.getByRole('link',{name:en.assistant.workspace.claimActions.title}).getAttribute('href')).toBe('/assistant/claims');
  expect(screen.getByRole('link',{name:en.assistant.workspace.knowledgeActions.title}).getAttribute('href')).toBe('/assistant/knowledge-base');
  expect(screen.getByRole('link',{name:en.assistant.workspace.lifecycleActions.title}).getAttribute('href')).toBe('/assistant/lifecycle');
  expect(screen.getByRole('link',{name:en.assistant.workspace.toilActions.title}).getAttribute('href')).toBe('/assistant/toil');
  expect(screen.getByRole('link',{name:en.assistant.workspace.attendanceActions.title}).getAttribute('href')).toBe('/assistant/attendance');
  expect(screen.getByRole('link',{name:en.assistant.workspace.payComponentActions.title}).getAttribute('href')).toBe('/assistant/pay-codes');
  expect(screen.getByRole('link',{name:en.assistant.workspace.rewardsActions.title}).getAttribute('href')).toBe('/assistant/rewards');
  expect(screen.getByRole('link',{name:en.people.import.title}).getAttribute('href')).toBe('/admin/personnel/import');
  expect(screen.getByRole('link',{name:en.assistant.workspace.payrollCloseActions.title}).getAttribute('href')).toBe('/assistant/payroll-close');
  expect(screen.getByRole('link',{name:en.assistant.workspace.countryStatutoryActions.title}).getAttribute('href')).toBe('/assistant/statutory');
  expect(screen.getByRole('link',{name:en.assistant.workspace.multiCycleRunActions.title}).getAttribute('href')).toBe('/assistant/payroll-runs');
  const action=screen.getByRole('link',{name:en.ownLeaveReview.workflow.title});expect(action.getAttribute('href')).toBe('/assistant/leave');
  expect(action.parentElement?.textContent).toContain(en.assistant.workspace.jobs.module_leave);
  for(const link of view.container.querySelectorAll<HTMLAnchorElement>('a[href^="/assistant?job="]')){const url=new URL(link.href);expect([...url.searchParams.keys()]).toEqual(['job']);expect(AGENT_MODULE_CODES).toContain(url.searchParams.get('job'));}
  expect(view.container.querySelector('[aria-current="page"]')?.textContent).toContain(en.assistant.workspace.jobs.module_leave);
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s keeps own-leave inside the Leave agent and omits its entry when the module is unavailable',async locale=>{
  state.locale=locale;const copy=(copies[locale] as typeof en).ownLeaveReview.workflow;
  const visible=render(await ModuleJobChooser({modules:['leave'],selected:'leave'}));
  expect(screen.getByRole('link',{name:copy.title}).getAttribute('href')).toBe('/assistant/leave');
  expect(visible.container.querySelectorAll<HTMLAnchorElement>('a[href^="/assistant?job="]')).toHaveLength(1);visible.unmount();
  render(await ModuleJobChooser({modules:['employees']}));expect(screen.queryByRole('link',{name:copy.title})).toBeNull();
  expect(withAssistantRead).not.toHaveBeenCalled();
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s keeps preference review inside Notifications without preparing or confirming on discovery',async locale=>{
  state.locale=locale;const copy=(copies[locale] as typeof en).assistant.workspace.moduleActions;
  const visible=render(await ModuleJobChooser({modules:['notifications'],selected:'notifications'}));
  const entry=screen.getByRole('link',{name:copy.title});expect(entry.getAttribute('href')).toBe('/assistant/notifications');
  expect(entry.parentElement?.textContent).toContain((copies[locale] as typeof en).assistant.workspace.jobs.module_notifications);
  expect(visible.container.querySelectorAll('form')).toHaveLength(0);expect(withAssistantRead).not.toHaveBeenCalled();visible.unmount();
  render(await ModuleJobChooser({modules:['leave']}));expect(screen.queryByRole('link',{name:copy.title})).toBeNull();
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s discovers profile review inside ESS without loading or preparing private fields',async locale=>{
  state.locale=locale;const copy=(copies[locale] as typeof en).assistant.workspace.profileActions;
  const visible=render(await ModuleJobChooser({modules:['ess'],selected:'ess'}));const entry=screen.getByRole('link',{name:copy.title});
  expect(entry.getAttribute('href')).toBe('/assistant/profile');expect(entry.parentElement?.textContent).toContain((copies[locale] as typeof en).assistant.workspace.jobs.module_ess);
  expect(visible.container.querySelectorAll('form')).toHaveLength(0);expect(withAssistantRead).not.toHaveBeenCalled();visible.unmount();
  render(await ModuleJobChooser({modules:['leave','notifications']}));expect(screen.queryByRole('link',{name:copy.title})).toBeNull();
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s keeps both acknowledgement engines inside the one Performance specialist',async locale=>{
  state.locale=locale;const copy=(copies[locale] as typeof en).assistant.workspace.performanceActions;
  const visible=render(await ModuleJobChooser({modules:['performance'],selected:'performance'}));const entry=screen.getByRole('link',{name:copy.title});
  expect(entry.getAttribute('href')).toBe('/assistant/performance');expect(entry.parentElement?.textContent).toContain((copies[locale] as typeof en).assistant.workspace.jobs.module_performance);
  expect(visible.container.querySelectorAll('a[href^="/assistant?job="]')).toHaveLength(1);expect(withAssistantRead).not.toHaveBeenCalled();visible.unmount();
  render(await ModuleJobChooser({modules:['leave','ess']}));expect(screen.queryByRole('link',{name:copy.title})).toBeNull();
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s renders only a source-owned human handoff from the grounded chat path',async locale=>{
  // The actual my_module_work contract (d7ff112ca): current-caller capability/scope and the baseline compact
  // specialist work the read session derives, which the answer-evidence owner reconstructs and compares.
  state.locale=locale;const source={module:'leave' as const,capability:MODULE_AGENT_CAPABILITIES.find(row=>row[0]==='leave')![1],scope:'current-caller',data:{rows:[],truncated:false},humanActions:moduleHumanActionHandoffs('leave')};
  const configuration={kind:'canonical_specialist_v1' as const,module:'leave' as const,playbook:'canonical_domain_v1' as const};
  const outcome={ok:true as const,...source,specialistWork:compactSpecialistWork(executeCanonicalSpecialist(configuration,source),{mode:'baseline',version:0,configuration})};
  state.tools=[{spec:{name:'my_module_work'},module:null,sensitivity:'ordinary',run:async()=>outcome}];
  const view=await loadCanonicalToolJob(ctx,'my_module_work',{module:'leave'},assistantSourceDigest(outcome),{} as AssistantReadSession),copy=(copies[locale] as typeof en).assistant.workspace.jobs;
  const shown=render(await CanonicalModuleJob({view,ctx}));expect(screen.getByRole('link',{name:copy.reviewAction}).getAttribute('href')).toBe('/assistant/leave');expect(screen.getByText(copy.humanReviewNote)).toBeTruthy();expect(shown.container.querySelectorAll('form[method="post"]')).toHaveLength(0);shown.unmount();
  render(await CanonicalModuleJob({view:JSON.parse(JSON.stringify(view)) as CanonicalModuleJobView,ctx}));expect(screen.queryByRole('link',{name:copy.reviewAction})).toBeNull();
 });
 it('refuses model-forged, serialized, cross-user and expired views before rendering their facts',async()=>{
  const issued=await loadCanonicalModuleJob(ctx,{module:'employees'});
  const fake=JSON.parse(JSON.stringify(issued)) as CanonicalModuleJobView;
  const view=render(await CanonicalModuleJob({view:fake,ctx}));expect(screen.queryByText('CANONICAL-01')).toBeNull();expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.jobs.unavailable);view.unmount();
  const cross=render(await CanonicalModuleJob({view:issued,ctx:{...ctx,userId:'different-user'}}));expect(screen.queryByText('CANONICAL-01')).toBeNull();cross.unmount();
  vi.spyOn(Date,'now').mockReturnValue(issued.checkedAt+31000);render(await CanonicalModuleJob({view:issued,ctx}));expect(screen.queryByText('CANONICAL-01')).toBeNull();
 });
 it('uses the same bounded public access wording for an inaccessible task or a private source error',async()=>{
  state.fail=true;const view=await loadCanonicalModuleJob(ctx,{module:'employees'});const rendered=render(await CanonicalModuleJob({view,ctx}));
  expect(screen.getByRole('status').textContent).toBe(en.assistant.workspace.jobs.unavailable);expect(rendered.container.textContent).not.toContain('PRIVATE_DATABASE_ERROR_BODY');
 });
 it('keeps hidden facts omitted and unknown monetary values distinct from recorded zero',async()=>{
  state.data={rows:[{balances:[{leaveType:'Canonical annual',available:null,taken:2,pending:null,withheld:true}]}],truncated:false};
  const mine=await loadCanonicalModuleJob(ctx,{module:'leave'});const first=render(await CanonicalModuleJob({view:mine,ctx}));
  expect(screen.queryByText(en.assistant.workspace.jobs.field_available)).toBeNull();expect(screen.getByText(en.assistant.workspace.jobs.withheld)).toBeTruthy();first.unmount();
  state.data={rows:[{payPeriod:'2026-10',gross:'0.00',deductions:null,net:null,currency:null}],truncated:false};
  const pay=await loadCanonicalModuleJob(ctx,{module:'payroll'});render(await CanonicalModuleJob({view:pay,ctx}));
  expect(screen.getByText('0.00')).toBeTruthy();expect(screen.getAllByText(en.assistant.workspace.jobs.unknown).length).toBeGreaterThan(0);
 });
 it.each(['en','ms','zh','ta','th','vi'])('%s gives fixed useful help for a source-free or withheld model answer',async locale=>{
  state.locale=locale;const reply={mode:'generic' as const,views:[],fallbackModules:[],partial:false,tools:[]};
  const first=render(await GroundedWorkspaceReply({reply,ctx}));expect(screen.getByText((copies[locale] as typeof en).assistant.workspace.answers.generic)).toBeTruthy();first.unmount();
  render(await GroundedWorkspaceReply({reply:{...reply,mode:'unavailable',fallbackModules:['leave']},ctx}));
  expect(screen.getByText((copies[locale] as typeof en).assistant.workspace.answers.unavailable)).toBeTruthy();
  expect(screen.getByRole('link').getAttribute('href')).toBe('/assistant?job=leave');
 });

 it.each(['en','ms','zh','ta','th','vi'])('%s makes grouped execution an explicit human submit with a stable form nonce',async locale=>{
  state.locale=locale;const result=render(await GovernedModuleJobComposer({modules:['employees','leave']}));
  const copy=(copies[locale] as typeof en).assistant.workspace.governed;expect(screen.getByRole('button',{name:copy.run})).toBeTruthy();
  expect(screen.getAllByRole('combobox')).toHaveLength(4);const fields=new FormData(result.container.querySelector('form')!);
  expect(fields.get('commandNonce')).toMatch(/^[a-f0-9-]{36}$/);expect(result.container.querySelectorAll('a')).toHaveLength(0);
  expect(withAssistantRead).not.toHaveBeenCalled();
 });

});
