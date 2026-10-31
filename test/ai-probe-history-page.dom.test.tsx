import {captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
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
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/control-tower/agents',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../app/(app)/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>true,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true,isModuleEnabled:()=>true}));
vi.mock('../core/ai-inventory',()=>({aiInventoryView:async()=>({scope:'registry',rows:[]}),aiManagementAlerts:async()=>({status:'ok',alerts:[]}),aiRunHistory:async()=>({range:{from:'2026-10-01',to:'2026-10-30',page:1},hasMore:false,rows:[{id:'fictional-probe',actor:'Fictional reviewer',feature:'provider_evaluation',operation:'probe',provider:'openai',model:'fictional-model',state:'completed',reason:null,actual:null,reserved:0,startedAt:new Date('2026-10-29T00:00:00Z'),reportedCredits:null,roundTripMs:null,observationStatus:null}]})}));
vi.mock('../core/ai-management',()=>({AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>({provider:null,mayWriteUsers:true,features:[],usage:[],policies:[],userDefault:null,companies:[],companyUsage:[],users:[],moreUsers:false,groups:[],attention:{companies:[],users:[],blocked:[]},runs:[{id:'fictional-probe',actor:'Fictional reviewer',feature:'provider_evaluation',operation:'probe',provider:'openai',model:'fictional-model',state:'completed',reason:null,actual:null,reserved:0,startedAt:new Date('2026-10-29T00:00:00Z'),reportedCredits:null,roundTripMs:null,observationStatus:null}],runFilter:{},legacyBudget:null,spend:null}),bulkAssistantDepartments:async()=>[],previewBulkAssistantAccess:async()=>({matched:0,changing:0})}));
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/(app)/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../app/(app)/control-tower/agents/actions',()=>({applyBulkAssistantAction:vi.fn(),clearGroupAllowanceAction:vi.fn(),setGroupAllowanceAction:vi.fn(),clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAssistantPermissionAction:vi.fn()}));
import {AiManagementScreen} from '../app/(app)/control-tower/agents/screen';
afterEach(cleanup);
describe('connection probe history in six rendered locales',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s shows a recorded connection check distinctly from a model exchange',async locale=>{
  state.locale=locale;
  const page=await AiManagementScreen({session:{tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never,section:'runs',searchParams:Promise.resolve({})});
  render(<NextIntlClientProvider locale={locale} messages={copies[locale] as any}>{page}</NextIntlClientProvider>);
  expect(screen.getByText(copies[locale].aiManagement.operations.probe,{exact:false})).toBeInTheDocument();
  expect(screen.getByText('Fictional reviewer')).toBeInTheDocument();
  await captureAiReviewScreenshots(document.body.innerHTML,locale,'probe');
  const out=process.env.AIHR_SCREENSHOT_HTML_DIR;
  if(out){mkdirSync(out,{recursive:true});writeFileSync(`${out}/${locale}-probe.html`,`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="bg-background text-foreground p-4">${document.body.innerHTML}</body></html>`);}
 },60000);
});
