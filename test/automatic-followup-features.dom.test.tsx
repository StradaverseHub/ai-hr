/** Real AI management screen, fictional data owner; six-locale desktop/mobile CI component evidence. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {createFormatter,createTranslator,NextIntlClientProvider} from 'next-intl';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import th from '../messages/th.json';import ta from '../messages/ta.json';import viCopy from '../messages/vi.json';
const copies={en,ms,zh,th,ta,vi:viCopy};
const state=vi.hoisted(()=>({locale:'en' as keyof typeof copies}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:any)=>createTranslator({locale:state.locale,messages:copies[state.locale] as any,namespace}),getFormatter:async()=>createFormatter({locale:state.locale,timeZone:'Asia/Kuala_Lumpur'})}));
vi.mock('next/navigation',()=>({redirect:vi.fn(),usePathname:()=>'/control-tower/agents/features',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../app/(app)/delegations/actions',()=>({loadDelegationContextAction:vi.fn()}));
vi.mock('../components/delegation-manager',()=>({DelegationManager:()=>null}));
vi.mock('../lib/authz',()=>({isGroupAdmin:()=>true,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:()=>true,isModuleEnabled:()=>true}));
vi.mock('../core/ai-management',()=>({AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>({provider:null,mayWriteUsers:true,features:['clock_reminders','document_reminders','lifecycle_chasers'].map(id=>({id,module:'notifications',kind:'agent',enabled:false,state:'paused',mayWrite:true})),agentSwitches:{},usage:[],policies:[],userDefault:null,companies:[],companyUsage:[],users:[],moreUsers:false,groups:[],attention:{companies:[],users:[],blocked:[]},runs:[],runFilter:{},legacyBudget:null,spend:null}),bulkAssistantDepartments:async()=>[],previewBulkAssistantAccess:async()=>({matched:0,changing:0})}));
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/(app)/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../app/(app)/control-tower/agents/actions',()=>({applyBulkAssistantAction:vi.fn(),clearGroupAllowanceAction:vi.fn(),setGroupAllowanceAction:vi.fn(),clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAssistantPermissionAction:vi.fn()}));
import {AiManagementScreen} from '../app/(app)/control-tower/agents/screen';
afterEach(cleanup);
describe('default-off scheduled reminder controls',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('%s renders the actual feature controls with named default-off actions',async locale=>{
  state.locale=locale;const page=await AiManagementScreen({session:{tenantId:'fictional',userId:'fictional',roles:['hr_admin']} as never,section:'features',searchParams:Promise.resolve({})});
  const view=render(<NextIntlClientProvider locale={locale} messages={copies[locale] as any}>{page}</NextIntlClientProvider>);
  for(const id of ['clock_reminders','document_reminders','lifecycle_chasers'] as const){
   expect(screen.getByText(copies[locale].aiManagement.features[id])).toBeTruthy();
   const row=view.container.querySelector('#ai-feature-'+id)!;expect(row.querySelector('input[name=feature]')?.getAttribute('value')).toBe(id);expect(row.querySelector('input[name=enabled]')?.getAttribute('value')).toBe('true');
  }
  expect(screen.getAllByRole('button',{name:new RegExp(copies[locale].aiManagement.enable)})).toHaveLength(3);
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'followup-features','real AI management feature table; fictional default-off rows; no authenticated server journey');
 },120000);
});
