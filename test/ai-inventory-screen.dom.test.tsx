import {captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
/** WP12 (R8, R20, R21): the actual AI management screen's Inventory section, alert banner and paged run history,
 *  in six locales, for a group administrator (full inventory, pause control, data register) and a company HR
 *  administrator (read-only registry/tier view). Fictional data owners; on the selected GitHub runner it also
 *  captures desktop and mobile screenshots (test/helpers/ai-review-screenshots.ts). */
import {withAiCentre} from './helpers/ai-centre-messages';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {createFormatter,createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {aiInventoryComponents,registryRow,AI_DATA_REGISTER} from '../lib/ai/ai-inventory';
import {AI_FEATURES} from '../lib/ai/features';
import workerOverviewMessages from '../app/control-tower/agents/worker-overview-messages.json';
const copies={en,ms,zh,vi:viCopy,th,ta};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'th'|'ta',group:true,alertsUnavailable:false,inventoryUnavailable:false,actionActivity:true,reminders30:3}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:any)=>createTranslator({locale:state.locale,messages:withAiCentre(state.locale,copies[state.locale] as any),namespace}),getLocale: async () => state.locale, getFormatter:async()=>createFormatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})}));
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/control-tower/agents/inventory',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>state.group,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true,isModuleEnabled:()=>true}));
vi.mock('../core/ai-management',async()=>{
 const {AI_FEATURES}=await import('../lib/ai/features');
 return {
  AI_RUN_STATE_FILTERS:['blocked','failed'],
  aiManagementPageView:async()=>({
   provider:{provider:'openrouter',model:'fictional/model'},mayWriteUsers:state.group,
   features:AI_FEATURES.map(feature=>({...feature,state:'ready',enabled:true,mayWrite:state.group})),
   usage:[],policies:[],userDefault:null,
   agentSwitches:{},companies:[],companyUsage:[],groups:[],attention:{companies:[],users:[],blocked:[]},spend:null,allowances:null,
  }),
  bulkAssistantDepartments:async()=>[],previewBulkAssistantAccess:async()=>({matched:0,changing:0}),
 };
});
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../app/control-tower/agents/actions',()=>({applyBulkAssistantAction:vi.fn(),clearGroupAllowanceAction:vi.fn(),setGroupAllowanceAction:vi.fn(),clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAssistantPermissionAction:vi.fn(),setAgentActionPauseAction:vi.fn()}));
vi.mock('../core/ai-inventory',async()=>{
 const {aiInventoryComponents,registryRow,AI_DATA_REGISTER}=await import('../lib/ai/ai-inventory');
 const {AI_FEATURES}=await import('../lib/ai/features');
 const at=new Date('2026-10-29T01:30:00Z');
 const full=()=>({scope:'full',provider:{provider:'openrouter',model:'fictional/model'},
  alerts:[{kind:'failure_rate',level:'warning',count:4,detail:'40%'},{kind:'switch_drift',level:'warning',count:1,detail:'performance_pm'}],
  register:AI_FEATURES.map(f=>({featureId:f.id,entry:AI_DATA_REGISTER[f.id]})),
  rows:aiInventoryComponents().map(c=>({...c,runtime:{switch:{kind:c.outOfBand?'platform':c.featureId?'policy':'none',on:c.featureId?true:null,state:c.featureId?'ready':null},
   actionPaused:c.kind==='action'?c.id==='leave.cancel':null,allowance:c.featureId&&c.kind!=='action'?{dailyRequests:50,monthlyTokens:200000}:null,
   lastRun:c.id!=='payroll_explanation'&&c.id!=='pay_rule_draft'&&(c.featureId||c.id==='ai-alerts')?at:null,
   use30:c.id==='payroll_explanation'||c.id==='pay_rule_draft'?{runs:0,failed:0,blocked:c.id==='payroll_explanation'?1:0,tokens:0,reportedCredits:null}:
    c.featureId&&c.kind!=='action'&&c.kind!=='read_binding'?{runs:12,failed:1,blocked:0,tokens:5400,reportedCredits:0.0123}:null,
   reminders30:c.kind==='action'&&c.tier==='automatic'?(c.id==='attendance.missing_clock.remind'?state.reminders30:0):null,
   outcomes:c.kind==='action'&&c.tier!=='automatic'?{
    prepared:state.actionActivity?(c.id==='leave.cancel'?8:c.id==='leave.edit'?3:0):0,
    completed:state.actionActivity?(c.id==='leave.cancel'?6:c.id==='leave.edit'?1:0):0,
    refused:0,discarded:0,expired:0,reversed:null,
   }:null,audit:{count:c.id==='leave.cancel'?1:0,latestAt:c.id==='leave.cancel'?at:null}}}))});
 const registry=()=>({scope:'registry',rows:aiInventoryComponents().map(c=>({...registryRow(c),actionPaused:c.kind==='action'?c.id==='leave.cancel':null}))});
 return {
  aiInventoryView:async()=>{
   if(state.inventoryUnavailable)throw Error('Inventory unavailable');
   return state.group?full():registry();
  },
  aiManagementAlerts:async()=>(!state.group?{status:'not_shown'}:state.alertsUnavailable?{status:'unavailable'}:{status:'ok',alerts:full().alerts}),
  aiRunHistory:async()=>({range:{from:'2026-10-01',to:'2026-10-30',page:2},hasMore:true,rows:Array.from({length:3},(_,i)=>({id:`fictional-run-${i}`,actor:'Fictional reviewer',feature:'hr_assistant',operation:'conversation',provider:'openrouter',model:'fictional/model',state:i===1?'failed':'completed',reason:null,actual:120,reserved:400,startedAt:new Date(at.getTime()-i*60000),reportedCredits:'0.001',roundTripMs:900,observationStatus:'reported'}))}),
 };
});
import {AiManagementScreen} from '../app/control-tower/agents/screen';
afterEach(()=>{cleanup();state.group=true;state.alertsUnavailable=false;state.inventoryUnavailable=false;state.actionActivity=true;state.reminders30=3;});
const session={tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never;
const renderPage=async(locale:keyof typeof copies,section:'features'|'runs',searchParams={})=>{
 const workerControls=state.group&&section==='features'?{
  stop:<section id="ai-centre-stop">Pause control</section>,
  settings:<section id="ai-centre-jobs">Scheduled job controls</section>,
 }:undefined;
 const page=await AiManagementScreen({session,section,searchParams:Promise.resolve(searchParams),workerControls});
 return render(<NextIntlClientProvider locale={locale} messages={withAiCentre(locale,copies[locale] as any)}><main className="min-w-0 p-4">{page}</main></NextIntlClientProvider>);
};

describe('AI inventory in six rendered locales',()=>{
 it('distinguishes scheduler-owned status, empty history and a recorded run on desktop and mobile',async()=>{
  state.locale='en';
  const view=await renderPage('en','features');
  view.container.querySelector<HTMLDetailsElement>('[data-ai-worker-details]')!.open=true;
  const section=view.container.querySelector<HTMLElement>('section[aria-labelledby="ai-kind-scheduled_job"]')!;
  section.querySelector<HTMLDetailsElement>('details')!.open=true;
  expect(within(section).getAllByRole('columnheader').map(header=>header.textContent)).toEqual([
   en.aiManagement.inv.cols.component,en.aiManagement.inv.cols.lastRun,
  ]);
  for(const id of ['ai-retention','payroll-loops']){
   const desktop=section.querySelector<HTMLElement>(`#ai-component-scheduled_job-${id}`)!;
   const mobile=section.querySelector<HTMLElement>(`#ai-component-scheduled_job-${id}-card`)!;
   expect(mobile.querySelector('details')).toBeNull();
   for(const row of [desktop,mobile]){
    const link=within(row).getByRole('link',{name:/Check scheduler status/});
    expect(link).toHaveAttribute('href',`/admin/scheduled-actions#runner-${id}`);
    expect(within(row).queryByText(en.aiManagement.inv.never)).toBeNull();
   }
  }
  const empty=section.querySelector<HTMLElement>('#ai-component-scheduled_job-review-sweep')!;
  expect(within(empty).getByText('No recorded run')).toBeInTheDocument();
  expect(within(section.querySelector<HTMLElement>('#ai-component-scheduled_job-review-sweep-card')!).getByText('No recorded run')).toBeInTheDocument();
  const recorded=section.querySelector<HTMLElement>('#ai-component-scheduled_job-ai-alerts')!;
  expect(within(recorded).getByText(/Oct 29, 2026/)).toBeInTheDocument();
  expect(within(section.querySelector<HTMLElement>('#ai-component-scheduled_job-ai-alerts-card')!).getByText(/Oct 29, 2026/)).toBeInTheDocument();
  expect(within(recorded).queryByRole('link')).toBeNull();
  await captureAiReviewScreenshots(`<main class="p-4">${section.outerHTML}</main>`,'en','ai-centre-scheduled-evidence');
 },60000);

 it('puts recorded activity ahead of the collapsed controls',async()=>{
  state.locale='en';
  const view=await renderPage('en','features');
  const overview=screen.getByRole('region',{name:'Activity overview'});
  const details=view.container.querySelector<HTMLDetailsElement>('[data-ai-worker-details]')!;
  const pause=screen.getByText('Pause control');
  expect(details.open).toBe(false);
  expect(details).not.toContainElement(pause);
  expect(pause.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(details).toContainElement(screen.getByText('Scheduled job controls'));
  const moreFeatures=overview.querySelector<HTMLDetailsElement>('details')!;
  expect(moreFeatures.open).toBe(false);
  expect(moreFeatures.querySelectorAll('li').length).toBeGreaterThan(0);
  expect(moreFeatures.previousElementSibling?.children).toHaveLength(3);
  expect(within(overview).getByText(/features with admitted requests/)).toHaveTextContent('1 blocked attempt');
  expect(within(overview).getByText('Activity evidence unavailable')).toBeInTheDocument();
  expect(within(overview).getByRole('link',{name:en.aiManagement.features.hr_assistant})).toHaveAttribute('href','/control-tower/agents/runs?feature=hr_assistant');
  const blockedOnly=within(overview).getByText('Blocked attempts only (1)').closest('details')!;
  expect(blockedOnly.open).toBe(false);
  blockedOnly.open=true;
  expect(within(blockedOnly).getByRole('link',{name:en.aiManagement.features.payroll_explanation})).toHaveAttribute('href','/control-tower/agents/runs?feature=payroll_explanation&runs=blocked');
  const noAttempts=within(overview).getByText('No attempts recorded (1)').closest('details')!;
  expect(noAttempts.open).toBe(false);
  expect(within(noAttempts).queryByText(en.aiManagement.features.payroll_explanation)).toBeNull();
  noAttempts.open=true;
  const settingsLink=within(noAttempts).getByRole('link',{name:en.aiManagement.features.pay_rule_draft});
  expect(settingsLink).toHaveAttribute('href','#ai-feature-pay_rule_draft');
  expect(within(noAttempts).getByText(en.aiManagement.states.ready)).toBeInTheDocument();
  expect(view.container.querySelector('#ai-feature-pay_rule_draft')).toBeInTheDocument();
  await captureAiReviewScreenshots(overview.outerHTML,'en','ai-centre-feature-activity',undefined,'atelier');
  fireEvent.click(settingsLink);
  expect(details.open).toBe(true);
  details.open=false;
  expect(within(overview).getByRole('link',{name:'Candidate reviews'})).toHaveAttribute('href','/control-tower/agents/assistant#ai-reviews-heading');
  expect(within(overview).getByRole('link',{name:'Run history'})).toHaveAttribute('href','/control-tower/agents/runs');
  expect(within(overview).getByText('11 prepared · 7 completed')).toBeInTheDocument();
  const actionLink=within(overview).getByRole('link',{name:'View action outcomes'});
  expect(actionLink).toHaveAttribute('href','#ai-inventory-actions');
  expect(view.container.querySelector('#ai-inventory-actions')).toBeInTheDocument();
  fireEvent.click(actionLink);
  expect(details.open).toBe(true);
 },60000);

 it('shows separate evidence for admitted requests, blocked-only features and individual reads',async()=>{
  state.locale='en';
  const view=await renderPage('en','features');
  view.container.querySelector<HTMLDetailsElement>('[data-ai-worker-details]')!.open=true;
  const inventory=view.container.querySelector<HTMLElement>('#ai-inventory')!;
  const row=(id:string)=>within(inventory.querySelector<HTMLElement>(`#ai-component-${id}`)!);
  expect(row('chat-hr_assistant').getByText(/Latest admitted request.*Oct 29, 2026/)).toBeInTheDocument();
  expect(row('embedded_feature-payroll_explanation').getByText('No admitted request recorded')).toBeInTheDocument();
  const read=inventory.querySelector<HTMLElement>('tr[id^="ai-component-read_binding-"]')!;
  expect(within(read).getByText('Individual read activity unavailable')).toBeInTheDocument();
  expect(within(read).queryByText(/Oct 29, 2026/)).toBeNull();
 });

 it.each([false,true])('distinguishes empty from unavailable action evidence when inventory fails=%s',async inventoryUnavailable=>{
  state.locale='en';
  state.actionActivity=false;
  state.inventoryUnavailable=inventoryUnavailable;
  await renderPage('en','features');
  const title=screen.getByText('Assistant actions · Last 30 days');
  const row=within(title.parentElement!);
  expect(row.getByText(inventoryUnavailable?'Activity evidence unavailable':'No actions prepared in 30 days')).toBeInTheDocument();
  expect(Boolean(row.queryByRole('link',{name:'View action outcomes'}))).toBe(!inventoryUnavailable);
 });

 it.each([3,0,null])('reports scheduled reminder receipts separately from model requests (%s)',async count=>{
  state.locale='en';
  state.reminders30=count??0;
  state.inventoryUnavailable=count===null;
  await renderPage('en','features');
  const row=within(screen.getByText('Automatic reminders · Last 30 days').parentElement!);
  expect(row.getByText(count===null?'Activity evidence unavailable':count===0?'No reminders recorded':'3 reminders recorded')).toBeInTheDocument();
  if(count===null)expect(row.queryByRole('link')).toBeNull();
  else expect(row.getByRole('link',{name:'View reminder outcomes'})).toHaveAttribute('href','/assistant?view=insights&pdays=30#automatic-reminder-outcomes');
  if(count===3)expect(within(document.getElementById('ai-component-action-attendance-missing_clock-remind')!).getByText('3 reminders recorded')).toBeInTheDocument();
 });

 it.each(['#ai-inventory','#ai-centre-jobs'])('reveals a bookmarked worker section on entry at %s',async hash=>{
  const location=window.location.href;
  try {
   window.history.replaceState(null,'',hash);
   const view=await renderPage('en','features');
   expect(view.container.querySelector<HTMLDetailsElement>('[data-ai-worker-details]')?.open).toBe(true);
  } finally {
   window.history.replaceState(null,'',location);
  }
 });

 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: group administrator sees every component group, the pause control, alerts and the data register',async locale=>{
  state.locale=locale;state.group=true;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'features');
  expect(screen.getAllByText(workerOverviewMessages[locale].checkScheduler)).toHaveLength(4);
  expect(screen.getAllByText(workerOverviewMessages[locale].noScheduledRunRecorded)).toHaveLength(2);
  expect(screen.getByRole('link',{name:workerOverviewMessages[locale].actionDetails})).toBeInTheDocument();
  expect(screen.getByRole('link',{name:workerOverviewMessages[locale].reminderDetails})).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent(inv.alerts.title);
  for(const kind of Object.keys(inv.kinds) as (keyof typeof inv.kinds)[])expect(screen.getByRole('heading',{level:3,name:new RegExp(inv.kinds[kind].replace(/[()]/g,'\\$&'))})).toBeInTheDocument();
  expect(screen.getAllByText('hr_assistant:leave.cancel').length).toBeGreaterThan(0);
  // One control in the desktop table and one in the mobile card (CSS shows exactly one at a time).
  expect(screen.getAllByRole('button',{name:`${inv.resumeAction} · leave.cancel`}).length).toBe(2);
  expect(screen.getAllByRole('button',{name:`${inv.pauseAction} · leave.edit`}).length).toBe(2);
  expect(screen.getAllByText(inv.outOfBandHelp).length).toBeGreaterThan(0);
  // Mobile: paused actions listed first, every group collapsed by default, each row a compact expandable summary.
  expect(screen.getByRole('heading',{level:3,name:new RegExp(inv.pausedTitle)})).toBeInTheDocument();
  const groups=[...document.querySelectorAll('details.md\\:hidden')] as HTMLDetailsElement[];
  expect(groups.length).toBe(Object.keys(inv.kinds).length);expect(groups.every(g=>!g.open)).toBe(true);
  const actions=groups.find(g=>g.querySelector('summary')?.textContent?.includes(inv.kinds.action))!;
  expect(actions.querySelector('li details summary')?.textContent).toContain('leave.cancel');
  const register=screen.getByRole('table',{name:inv.register.title});
  expect(within(register).getAllByRole('row').length).toBe(AI_FEATURES.length+1);
  expect(within(register).getAllByText(inv.register.redaction.protected_contract).length).toBe(Object.values(AI_DATA_REGISTER).filter(e=>e.redaction==='protected_contract').length);
  expect(within(register).queryByText(inv.register.fields.full_names)).toBeNull();expect(within(register).queryByText(inv.register.imagesYes)).toBeNull();
  for(const entry of Object.values(AI_DATA_REGISTER))expect(within(register).getAllByText(inv.register.review[entry.review]).length).toBeGreaterThan(0);
  expect(document.body.textContent).not.toMatch(/MISSING_MESSAGE|aiManagement\.inv\./);
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'inventory-group');
 },60000);

 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: company HR sees the read-only registry and tier view only',async locale=>{
  state.locale=locale;state.group=false;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'features');
  expect(screen.queryByText(workerOverviewMessages[locale].checkScheduler)).toBeNull();
  expect(screen.queryByText(workerOverviewMessages[locale].automaticReminders)).toBeNull();
  expect(screen.getByRole('note')).toHaveTextContent(inv.registryNotice);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button',{name:new RegExp(inv.pauseAction)})).toBeNull();
  expect(screen.queryByRole('table',{name:inv.register.title})).toBeNull();
  expect(screen.queryByText(workerOverviewMessages[locale].assistantActions)).toBeNull();
  expect(screen.queryByText(/No attempts recorded/)).toBeNull();
  expect(screen.queryByText(inv.cols.use30)).toBeNull();
  expect(screen.getAllByText(inv.cols.tier).length).toBeGreaterThan(0);
  expect(screen.getAllByText(inv.actionPaused).length).toBeGreaterThan(0);
  expect(aiInventoryComponents().map(registryRow).length).toBeGreaterThan(40);
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'inventory-company');
 },60000);

 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: a failed alert check is shown as not checked, never as all clear',async locale=>{
  state.locale=locale;state.group=true;state.alertsUnavailable=true;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'features');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getAllByRole('status').some(node=>node.textContent===inv.alerts.unavailable)).toBe(true);
 },60000);

 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: run history shows the date range and pages',async locale=>{
  state.locale=locale;state.group=true;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'runs',{page:'2'});
  const nav=screen.getByRole('navigation',{name:inv.paging});
  expect(within(nav).getByRole('link',{name:inv.previous}).getAttribute('href')).toBe('/control-tower/agents/runs?from=2026-10-01&to=2026-10-30#ai-runs');
  expect(within(nav).getByRole('link',{name:inv.next}).getAttribute('href')).toBe('/control-tower/agents/runs?from=2026-10-01&to=2026-10-30&page=3#ai-runs');
  expect(screen.getByLabelText(inv.rangeFrom)).toHaveValue('2026-10-01');
  expect(screen.getByLabelText(inv.rangeTo)).toHaveValue('2026-10-30');
  expect(screen.getAllByText('Fictional reviewer').length).toBe(3);
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'runs-paged');
 },60000);
});
