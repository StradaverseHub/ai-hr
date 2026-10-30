import {captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
/** WP12 (R8, R20, R21): the actual AI management screen's Inventory section, alert banner and paged run history,
 *  in six locales, for a group administrator (full inventory, pause control, data register) and a company HR
 *  administrator (read-only registry/tier view). Fictional data owners; on the selected GitHub runner it also
 *  captures desktop and mobile screenshots (test/helpers/ai-review-screenshots.ts). */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createFormatter,createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
import {aiInventoryComponents,registryRow,AI_DATA_REGISTER} from '../lib/ai/ai-inventory';
import {AI_FEATURES} from '../lib/ai/features';
const copies={en,ms,zh,vi:viCopy,th,ta};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'th'|'ta',group:true,alertsUnavailable:false}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:any)=>createTranslator({locale:state.locale,messages:copies[state.locale] as any,namespace}),getFormatter:async()=>createFormatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})}));
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/control-tower/agents/inventory',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>state.group,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true,isModuleEnabled:()=>true}));
vi.mock('../core/ai-management',()=>({AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>({provider:{provider:'openrouter',model:'fictional/model'},mayWriteUsers:true,features:[],usage:[],policies:[],userDefault:null,companies:[],companyUsage:[],users:[],moreUsers:false,groups:[],attention:{companies:[],users:[],blocked:[]},runs:[],runFilter:{},legacyBudget:null,spend:null}),bulkAssistantDepartments:async()=>[],previewBulkAssistantAccess:async()=>({matched:0,changing:0})}));
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
   lastRun:c.featureId?at:null,use30:c.featureId&&c.kind!=='action'&&c.kind!=='read_binding'?{runs:12,failed:1,blocked:0,tokens:5400,reportedCredits:0.0123}:null,
   outcomes:c.kind==='action'?{prepared:8,completed:6,refused:1,discarded:1,expired:0,reversed:null}:null,audit:{count:c.id==='leave.cancel'?1:0,latestAt:c.id==='leave.cancel'?at:null}}}))});
 const registry=()=>({scope:'registry',rows:aiInventoryComponents().map(c=>({...registryRow(c),actionPaused:c.kind==='action'?c.id==='leave.cancel':null}))});
 return {
  aiInventoryView:async()=>(state.group?full():registry()),
  aiManagementAlerts:async()=>(!state.group?{status:'not_shown'}:state.alertsUnavailable?{status:'unavailable'}:{status:'ok',alerts:full().alerts}),
  aiRunHistory:async()=>({range:{from:'2026-10-01',to:'2026-10-30',page:2},hasMore:true,rows:Array.from({length:3},(_,i)=>({id:`fictional-run-${i}`,actor:'Fictional reviewer',feature:'hr_assistant',operation:'conversation',provider:'openrouter',model:'fictional/model',state:i===1?'failed':'completed',reason:null,actual:120,reserved:400,startedAt:new Date(at.getTime()-i*60000),reportedCredits:'0.001',roundTripMs:900,observationStatus:'reported'}))}),
 };
});
import {AiManagementScreen} from '../app/control-tower/agents/screen';
afterEach(()=>{cleanup();state.group=true;state.alertsUnavailable=false;});
const session={tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never;
const renderPage=async(locale:keyof typeof copies,section:'inventory'|'runs',searchParams={})=>{
 const page=await AiManagementScreen({session,section,searchParams:Promise.resolve(searchParams)});
 return render(<NextIntlClientProvider locale={locale} messages={copies[locale] as any}><main className="min-w-0 p-4">{page}</main></NextIntlClientProvider>);
};

describe('AI inventory in six rendered locales',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: group administrator sees every component group, the pause control, alerts and the data register',async locale=>{
  state.locale=locale;state.group=true;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'inventory');
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
  expect(within(register).getAllByText(inv.register.redaction.none).length).toBe(Object.values(AI_DATA_REGISTER).filter(e=>e.redaction==='none').length);
  expect(document.body.textContent).not.toMatch(/MISSING_MESSAGE|aiManagement\.inv\./);
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'inventory-group');
 },60000);

 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: company HR sees the read-only registry and tier view only',async locale=>{
  state.locale=locale;state.group=false;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'inventory');
  expect(screen.getByRole('note')).toHaveTextContent(inv.registryNotice);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button',{name:new RegExp(inv.pauseAction)})).toBeNull();
  expect(screen.queryByRole('table',{name:inv.register.title})).toBeNull();
  expect(screen.queryByText(inv.cols.use30)).toBeNull();
  expect(screen.getAllByText(inv.cols.tier).length).toBeGreaterThan(0);
  expect(screen.getAllByText(inv.actionPaused).length).toBeGreaterThan(0);
  expect(aiInventoryComponents().map(registryRow).length).toBeGreaterThan(40);
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'inventory-company');
 },60000);

 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s: a failed alert check is shown as not checked, never as all clear',async locale=>{
  state.locale=locale;state.group=true;state.alertsUnavailable=true;const inv=copies[locale].aiManagement.inv;
  await renderPage(locale,'inventory');
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
