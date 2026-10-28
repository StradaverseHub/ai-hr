/** Walkthrough 28 October 2026 on /control-tower/agents: USD amounts printed as raw nano-USD, the USD
 * inputs were reported unnamed, and a company with a zero cap was missing from "Needs attention".
 * Renders the real page with its data owners stubbed; no database is touched.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

const data=vi.hoisted(()=>({view:undefined as unknown}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({
  getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:en,namespace}),
  getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),
}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'fixture-tenant',userId:'fixture-user',roles:['group_admin'],grants:[]}),isGroupAdmin:()=>true}));
vi.mock('../core/ai-management',()=>({AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>data.view}));
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../lib/ai/spend-allocation',()=>({nanosToUsd:(value:string)=>value}));
vi.mock('../app/control-tower/agents/actions',()=>({clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAssistantPermissionAction:vi.fn()}));
import AiManagementPage from '../app/control-tower/agents/page';
import { usdDisplay } from '../app/control-tower/agents/usd-display';

const ZERO='11111111-1111-4111-8111-111111111111',CAPPED='33333333-3333-4333-8333-333333333333';
const use=(daily:number|null,maxConcurrent:number|null=null)=>({daily:{used:0,limit:daily,level:daily===0?'at':null},tokens:{used:0,limit:null,level:null},recorded:0,held:0,enabled:true,maxConcurrent,blocked:0,failed:0});
function view(spend:{heldNanos:string;confirmedNanos:string|null}){
  const zero={id:ZERO,label:'Fictional Zero Cap Sdn Bhd',...use(0)},capped={id:CAPPED,label:'Fictional Capped Sdn Bhd',...use(5)};
  return {provider:null,mayWriteUsers:true,features:[],usage:[],policies:[],userDefault:null,companies:[zero,capped],companyUsage:[],users:[],moreUsers:false,
    attention:{companies:[zero],users:[],blocked:[]},runs:[],runFilter:{},legacyBudget:null,
    spend:{currency:'USD',unit:'nano_usd',semantics:'application_inference_allocation',certifiedLiveRoutes:0,reviewedCarrierRecords:0,liveCapability:'not_verified_here',
      budgets:[{scopeKey:'tenant',monthlyNanos:null,rootNanos:null}],unpricedUnknownRuns:0,breached:false,...spend}};
}
async function show(spend:{heldNanos:string;confirmedNanos:string|null}){
  data.view=view(spend);
  const page=await AiManagementPage({searchParams:Promise.resolve({})});
  return render(<NextIntlClientProvider locale="en" messages={en}>{page}</NextIntlClientProvider>);
}

describe('USD display of stored nano-USD',()=>{
  it('rounds to cents for display only, keeps unknown explicit and never shows a non-zero amount as zero',()=>{
    expect(usdDisplay('0')).toEqual({kind:'amount',value:0});
    expect(usdDisplay('1')).toEqual({kind:'belowCent'});
    expect(usdDisplay('4999999')).toEqual({kind:'belowCent'});
    expect(usdDisplay('5000000')).toEqual({kind:'amount',value:0.01});
    expect(usdDisplay('2500000000')).toEqual({kind:'amount',value:2.5});
    expect(usdDisplay('1234567890')).toEqual({kind:'amount',value:1.23});
    for(const unknown of [null,undefined,'','-5','1.5','abc'])expect(usdDisplay(unknown)).toEqual({kind:'unknown'});
  });
});

describe('AI management page',()=>{
  it('shows USD amounts in dollars and keeps an unknown charge unknown',async()=>{
    const {container}=await show({heldNanos:'0',confirmedNanos:null});
    expect(screen.getByText('Awaiting confirmation: US$0.00 · Confirmed charges: unknown')).toBeTruthy();
    expect(container.textContent).not.toContain('nano-USD');
  });
  it('says "less than US$0.01" rather than rounding a non-zero amount to zero',async()=>{
    await show({heldNanos:'1',confirmedNanos:'2500000000'});
    expect(screen.getByText('Awaiting confirmation: less than US$0.01 · Confirmed charges: US$2.50')).toBeTruthy();
  });
  it('names both USD inputs through their labels',async()=>{
    await show({heldNanos:'0',confirmedNanos:null});
    expect(screen.getByLabelText(en.aiManagement.spendMonthly).getAttribute('name')).toBe('monthlyUsd');
    expect(screen.getByLabelText(en.aiManagement.spendRoot).getAttribute('name')).toBe('rootUsd');
  });
  it('marks a company paused by a zero cap and gives each saved form an anchor to return to',async()=>{
    const {container}=await show({heldNanos:'0',confirmedNanos:null});
    // Once in "Needs attention" and once on the company's own row; the company with a positive cap has none.
    expect(screen.getAllByText(en.aiManagement.zeroCapPaused)).toHaveLength(2);
    expect(container.querySelector(`#ai-company-${ZERO}`)).not.toBeNull();
    expect(container.querySelector(`#ai-company-${CAPPED}`)).not.toBeNull();
    expect(container.querySelector('#ai-spend')).not.toBeNull();
    expect(container.querySelector('#ai-user-default')).not.toBeNull();
  });
});
