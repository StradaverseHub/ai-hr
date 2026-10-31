import {captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {MODULE_JOBS} from '../lib/ai/module-jobs';
/** Actual screen component, fictional data owners. Optional HTML capture supports rendered review. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {createFormatter,createTranslator,NextIntlClientProvider} from 'next-intl';
import {mkdirSync,writeFileSync} from 'node:fs';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import viCopy from '../messages/vi.json';
import th from '../messages/th.json';
import ta from '../messages/ta.json';
const copies={en,ms,zh,vi:viCopy,th,ta};
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'vi'|'th'|'ta'}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:any)=>createTranslator({locale:state.locale,messages:copies[state.locale] as any,namespace}),getFormatter:async()=>createFormatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})}));
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/control-tower/agents',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../app/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>true,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true,isModuleEnabled:()=>true}));
vi.mock('../core/ai-inventory',()=>({aiInventoryView:async()=>({scope:'registry',rows:[]}),aiManagementAlerts:async()=>({status:'ok',alerts:[]}),aiRunHistory:async()=>({range:{from:'2026-10-01',to:'2026-10-30',page:1},hasMore:false,rows:[]})}));
vi.mock('../core/ai-management',async()=>{
 const {AI_FEATURES}=await import('../lib/ai/features');const assistant=AI_FEATURES.find(feature=>feature.id==='hr_assistant');if(!assistant)throw Error('Missing actual Assistant feature definition');
 // Match the native status owner: enabled module/switch, but no configured provider means provider-required.
 return {AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>({provider:null,mayWriteUsers:true,features:[{...assistant,enabled:true,state:'provider',mayWrite:true}],usage:[],policies:[],userDefault:null,companies:[],companyUsage:[],users:[],moreUsers:false,groups:[],attention:{companies:[],users:[],blocked:[]},runs:[],runFilter:{},legacyBudget:null,spend:null}),bulkAssistantDepartments:async()=>[],previewBulkAssistantAccess:async()=>({matched:0,changing:0})};
});
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../app/control-tower/agents/actions',()=>({applyBulkAssistantAction:vi.fn(),clearGroupAllowanceAction:vi.fn(),setGroupAllowanceAction:vi.fn(),clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAssistantPermissionAction:vi.fn()}));
import {Sidebar} from '../components/sidebar';
import {AiManagementScreen} from '../app/control-tower/agents/screen';
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
const queueNames={en:'HR work queue',ms:'Baris kerja HR',zh:'HR 工作队列',vi:'Hàng đợi công việc HR',th:'คิวงาน HR',ta:'HR பணிவரிசை'};
describe('approved AI vocabulary in six rendered locales',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders read capabilities and the HR work queue without implying model availability',async locale=>{
  state.locale=locale;document.documentElement.setAttribute('data-ui-theme','classic');
  const renderSection=async(section:'overview'|'orchestrator')=>{
   const page=await AiManagementScreen({session:{tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never,section,searchParams:Promise.resolve({})});
   return render(<NextIntlClientProvider locale={locale} messages={copies[locale] as any}><div className="flex min-h-screen max-sm:flex-col"><div className="h-screen shrink-0 max-sm:h-auto"><Sidebar isAdmin canAdministerAi canConfigureAiProvider canApprove canAccessTeam enabledModules={null} defaultCollapsed={false}/></div><main className="min-w-0 flex-1 p-4">{page}</main></div></NextIntlClientProvider>);
  };
  await renderSection('overview');expect(screen.getByText(copies[locale].aiManagement.mapAssistant)).toBeInTheDocument();
  const t=createTranslator({locale,messages:copies[locale] as any,namespace:'aiManagement'}),count=t('mapSpecialists',{available:MODULE_JOBS.length,total:MODULE_JOBS.length});
  expect(screen.getByText(`${copies[locale].aiManagement.states.provider} · ${count}`)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(`${copies[locale].aiManagement.states.module} · ${count}`);
  const overview=document.body.innerHTML;
  await captureAiReviewScreenshots(overview,locale,'overview');
  fireEvent.click(screen.getByRole('button',{name:copies[locale].nav.aiControlTower}));
  expect(screen.queryByRole('link',{name:copies[locale].nav.aiConfig})).toBeNull();
  cleanup();
  await renderSection('orchestrator');expect(screen.getByRole('heading',{level:2,name:queueNames[locale]})).toBeInTheDocument();
  expect(screen.getByText(copies[locale].aiManagement.orchestratorHelp)).toBeInTheDocument();
  if(locale==='en')expect(document.body.textContent).not.toMatch(/feature switches above|module agent|specialist/i);
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'queue');
  const out=process.env.AIHR_SCREENSHOT_HTML_DIR;
  if(out){mkdirSync(out,{recursive:true});for(const [name,html] of [['overview',overview],['queue',document.body.innerHTML]])writeFileSync(`${out}/${locale}-${name}.html`,`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="bg-background text-foreground p-4">${html}</body></html>`);}
 },60000);
});
