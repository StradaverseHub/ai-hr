/** Actual screen component, fictional data owners. Optional HTML capture supports rendered review. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
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
vi.mock('next/navigation',()=>({redirect:vi.fn()}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>true,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true}));
vi.mock('../core/ai-management',()=>({AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>({provider:null,mayWriteUsers:true,features:[],usage:[],policies:[],userDefault:null,companies:[],companyUsage:[],users:[],moreUsers:false,groups:[],attention:{companies:[],users:[],blocked:[]},runs:[],runFilter:{},legacyBudget:null,spend:null}),bulkAssistantDepartments:async()=>[],previewBulkAssistantAccess:async()=>({matched:0,changing:0})}));
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../app/control-tower/agents/actions',()=>({applyBulkAssistantAction:vi.fn(),clearGroupAllowanceAction:vi.fn(),setGroupAllowanceAction:vi.fn(),clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAssistantPermissionAction:vi.fn()}));
import {AiManagementScreen} from '../app/control-tower/agents/screen';
afterEach(cleanup);
const queueNames={en:'HR work queue',ms:'Baris kerja HR',zh:'HR 工作队列',vi:'Hàng đợi công việc HR',th:'คิวงาน HR',ta:'HR பணிவரிசை'};
describe('approved AI vocabulary in six rendered locales',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders read capabilities and the HR work queue without implying model availability',async locale=>{
  state.locale=locale;
  const renderSection=async(section:'overview'|'orchestrator')=>{
   const page=await AiManagementScreen({session:{tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never,section,searchParams:Promise.resolve({})});
   return render(<NextIntlClientProvider locale={locale} messages={copies[locale] as any}>{page}</NextIntlClientProvider>);
  };
  await renderSection('overview');expect(screen.getByText(copies[locale].aiManagement.mapAssistant)).toBeInTheDocument();
  const overview=document.body.innerHTML;cleanup();
  await renderSection('orchestrator');expect(screen.getByRole('heading',{level:2,name:queueNames[locale]})).toBeInTheDocument();
  expect(screen.getByText(copies[locale].aiManagement.orchestratorHelp)).toBeInTheDocument();
  if(locale==='en')expect(document.body.textContent).not.toMatch(/feature switches above|module agent|specialist/i);
  const out=process.env.AIHR_SCREENSHOT_HTML_DIR;
  if(out){mkdirSync(out,{recursive:true});for(const [name,html] of [['overview',overview],['queue',document.body.innerHTML]])writeFileSync(`${out}/${locale}-${name}.html`,`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="bg-background text-foreground p-4">${html}</body></html>`);}
 });
});
