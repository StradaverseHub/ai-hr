/** Walkthrough 28 October 2026 on /control-tower/agents: USD amounts printed as raw nano-USD, the USD
 * inputs were reported unnamed, and a company with a zero cap was missing from "Needs attention".
 * Renders the real page with its data owners stubbed; no database is touched.
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createFormatter, createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';

const data=vi.hoisted(()=>({view:undefined as unknown,groupAdmin:true}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({
  getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:en,namespace}),
  getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),
}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'fixture-tenant',userId:'fixture-user',roles:['group_admin'],grants:[]}),isGroupAdmin:()=>data.groupAdmin,isAdmin:()=>true}));
vi.mock('../core/entitlements',()=>({isModuleEnabledOrFalse:(_ctx:unknown,code:string)=>['employees','leave','payroll'].includes(code)}));
vi.mock('../core/ai-inventory',()=>({aiInventoryView:async()=>({scope:'registry',rows:[]}),aiManagementAlerts:async()=>({status:'ok',alerts:[]}),aiRunHistory:async()=>({range:{from:'2026-10-01',to:'2026-10-30',page:1},hasMore:false,rows:[]})}));
vi.mock('../core/ai-management',()=>({AI_RUN_STATE_FILTERS:['blocked','failed'],aiManagementView:async()=>data.view,bulkAssistantDepartments:async()=>[{id:'44444444-4444-4444-8444-444444444444',label:'Fictional Finance · Fictional Zero Cap Sdn Bhd'}],previewBulkAssistantAccess:async()=>({matched:3,changing:2})}));
vi.mock('../core/hr-orchestrator',()=>({orchestrationQueue:async()=>({})}));
vi.mock('../app/control-tower/work-queue',()=>({OrchestrationWorkQueue:()=>null}));
vi.mock('../lib/ai/spend-allocation',()=>({nanosToUsd:(value:string)=>value}));
vi.mock('../app/control-tower/agents/actions',()=>({applyBulkAssistantAction:vi.fn(),setGroupAllowanceAction:vi.fn(),clearGroupAllowanceAction:vi.fn(),clearUserAllowanceAction:vi.fn(),setAiSpendBudgetAction:vi.fn(),setAiAllowanceAction:vi.fn(),setAiFeatureAction:vi.fn(),setAiFeatureCapAction:vi.fn(),setAssistantPermissionAction:vi.fn()}));
import { AiManagementScreen } from '../app/control-tower/agents/screen';
import type { AiManagementSection } from '../app/control-tower/agents/sections';
const navigation=vi.hoisted(()=>({redirect:vi.fn((location:string)=>{throw Object.assign(Error('fixture redirect'),{location});})}));
vi.mock('next/navigation',()=>({redirect:navigation.redirect}));
const providerScreen=vi.hoisted(()=>vi.fn(async()=>null));
vi.mock('../app/admin/ai/provider-screen',()=>({AiProviderScreen:providerScreen}));
vi.mock('../app/admin/ai/provider-baseline-panel',()=>({AiProviderBaselinePanel:async()=>null}));
import AiManagementProviderPage from '../app/control-tower/agents/provider/page';
import { usdDisplay } from '../app/control-tower/agents/usd-display';

const ZERO='11111111-1111-4111-8111-111111111111',CAPPED='33333333-3333-4333-8333-333333333333';
const use=(daily:number|null,maxConcurrent:number|null=null)=>({daily:{used:0,limit:daily,level:daily===0?'at':null},tokens:{used:0,limit:null,level:null},recorded:0,held:0,enabled:true,maxConcurrent,blocked:0,failed:0});
function view(spend:{heldNanos:string;confirmedNanos:string|null}){
  const zero={id:ZERO,label:'Fictional Zero Cap Sdn Bhd',...use(0)},capped={id:CAPPED,label:'Fictional Capped Sdn Bhd',...use(5)};
  return {provider:null,mayWriteUsers:true,features:[],agentSwitches:{},usage:[],policies:[],userDefault:null,companies:[zero,capped],companyUsage:[],users:[],moreUsers:false,groups:[],
    attention:{companies:[zero],users:[],blocked:[]},runs:[],runFilter:{},legacyBudget:null,
    spend:{currency:'USD',unit:'nano_usd',semantics:'application_inference_allocation',certifiedLiveRoutes:0,reviewedCarrierRecords:0,liveCapability:'not_verified_here',
      budgets:[{scopeKey:'tenant',monthlyNanos:null,rootNanos:null}],unpricedUnknownRuns:0,breached:false,...spend}};
}
const session={tenantId:'fixture-tenant',userId:'fixture-user',roles:['group_admin'],grants:[]};
async function show(spend:{heldNanos:string;confirmedNanos:string|null},section:AiManagementSection='spending',search:Record<string,string>={},mayWriteUsers=true){
  data.view={...view(spend),mayWriteUsers};
  const page=await AiManagementScreen({session:session as never,section,searchParams:Promise.resolve(search)});
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
    const spend={heldNanos:'0',confirmedNanos:null};
    // Once in "Needs attention" (linking to the company's row) and once on the company's own row; the
    // company with a positive cap has none.
    const attention=await show(spend,'overview');
    expect(screen.getAllByText(en.aiManagement.zeroCapPaused)).toHaveLength(1);
    expect(screen.getByRole('link',{name:'Fictional Zero Cap Sdn Bhd'}).getAttribute('href')).toBe(`/control-tower/agents/allowances#ai-company-${ZERO}`);attention.unmount();
    const companies=await show(spend,'allowances');
    expect(screen.getAllByText(en.aiManagement.zeroCapPaused)).toHaveLength(1);
    expect(companies.container.querySelector(`#ai-company-${ZERO}`)).not.toBeNull();
    expect(companies.container.querySelector(`#ai-company-${CAPPED}`)).not.toBeNull();companies.unmount();
    expect((await show(spend)).container.querySelector('#ai-spend')).not.toBeNull();cleanup();
    expect((await show(spend,'allowances')).container.querySelector('#ai-user-default')).not.toBeNull();
  });
  it('offers per-feature caps to group administrators only, for features without a module setting (WP14)',async()=>{
    data.view={...view({heldNanos:'0',confirmedNanos:null}),policies:[{scopeKey:'feature:pay_rule_draft',kind:'feature',featureId:'pay_rule_draft',subjectId:null,enabled:true,dailyRequests:0,monthlyTokens:5000,maxConcurrent:null}],
      usage:[{feature_id:'pay_rule_draft',daily_requests:'3',monthly_tokens:'1200',held_tokens:'0',blocked:'1',failed:'0'}]};
    const page=await AiManagementScreen({session:session as never,section:'allowances',searchParams:Promise.resolve({})});
    const {container,unmount}=render(<NextIntlClientProvider locale="en" messages={en}>{page}</NextIntlClientProvider>);
    const caps=container.querySelector('#feature-limits') as HTMLElement;
    expect(within(caps).getByText(en.aiManagement.featureCapsTitle)).toBeTruthy();
    expect([...caps.querySelectorAll('input[name="feature"]')].map(input=>(input as HTMLInputElement).value).sort()).toEqual(['hr_assistant','module_agent_evaluation','module_agent_planning','pay_rule_draft','payroll_explanation','performance_assistant','personnel_import_mapping','provider_evaluation','report_insight']);
    const row=caps.querySelector('#ai-feature-cap-pay_rule_draft') as HTMLElement;
    expect((within(row).getByLabelText(`${en.aiManagement.features.pay_rule_draft} · ${en.aiManagement.daily}`) as HTMLInputElement).value).toBe('0');
    expect((within(row).getByLabelText(`${en.aiManagement.features.pay_rule_draft} · ${en.aiManagement.monthly}`) as HTMLInputElement).value).toBe('5000');
    expect(within(row).getByText(en.aiManagement.zeroCapPaused)).toBeTruthy();
    expect(caps.querySelector('select[name="enabled"]')).toBeNull();
    unmount();
    const scoped=await show({heldNanos:'0',confirmedNanos:null},'allowances',{},false);
    expect(scoped.container.querySelector('#feature-limits')).toBeNull();
  });
});

describe('AI management sub-menu',()=>{
  it('has no in-page section tab row; the sidebar\u2019s AI management menu chooses the page',async()=>{
    const {container}=await show({heldNanos:'0',confirmedNanos:null},'features');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(container.querySelector('#ai-features')).not.toBeNull();
    for(const other of ['#ai-map','#ai-attention','#company-limits','#user-limits','#ai-spend','#orchestrator','#ai-runs'])expect(container.querySelector(other),other).toBeNull();
  });
  it('keeps user allowances off the Allowances page for a company administrator, and sends an unavailable section to the Overview',async()=>{
    const scoped=await show({heldNanos:'0',confirmedNanos:null},'allowances',{},false);
    expect(scoped.container.querySelector('#company-limits')).not.toBeNull();expect(scoped.container.querySelector('#user-limits')).toBeNull();scoped.unmount();
    data.view={...view({heldNanos:'0',confirmedNanos:null}),spend:null};
    await expect(AiManagementScreen({session:session as never,section:'spending',searchParams:Promise.resolve({})})).rejects.toMatchObject({location:'/control-tower/agents'});
  });
  it('withholds tenant-wide provider setup from a company administrator instead of linking to a refusal',async()=>{
    data.groupAdmin=false;
    try{
      data.view={...view({heldNanos:'0',confirmedNanos:null}),spend:null,mayWriteUsers:false};
      const page=await AiManagementScreen({session:session as never,section:'overview',searchParams:Promise.resolve({})});
      render(<NextIntlClientProvider locale="en" messages={en}>{page}</NextIntlClientProvider>);
      expect(screen.queryByRole('link',{name:en.aiManagement.configureProvider})).toBeNull();
      expect(document.querySelector('a[href^="/control-tower/agents/provider"]')).toBeNull();
      // The map still states which provider the company's calls would use.
      expect(document.querySelector('#ai-map')!.textContent).toContain(en.aiManagement.mapProvider);
      cleanup();
      await expect(AiManagementScreen({session:session as never,section:'provider',searchParams:Promise.resolve({})})).rejects.toMatchObject({location:'/control-tower/agents'});
      // The page itself leaves before the configuration read, which would refuse this administrator.
      await expect(AiManagementProviderPage({searchParams:Promise.resolve({})})).rejects.toMatchObject({location:'/control-tower/agents'});
      expect(providerScreen).not.toHaveBeenCalled();
    }finally{data.groupAdmin=true;cleanup();}
  });
  it('shows the AI map: every piece, whether it can run, and a Manage link to where it is changed',async()=>{
    data.view={...view({heldNanos:'0',confirmedNanos:null}),provider:null,features:[
      {id:'hr_assistant',kind:'assistant',state:'provider',enabled:true,mayWrite:true},
      {id:'readiness_reminders',kind:'agent',state:'ready',enabled:true,mayWrite:true},{id:'claims_triage',kind:'agent',state:'paused',enabled:false,mayWrite:true},
      {id:'payroll_explanation',kind:'feature',state:'provider',enabled:true,mayWrite:true}]};
    const page=await AiManagementScreen({session:session as never,section:'overview',searchParams:Promise.resolve({})});
    render(<NextIntlClientProvider locale="en" messages={en}>{page}</NextIntlClientProvider>);
    const map=document.querySelector('#ai-map')!;
    expect(map.textContent).toContain(en.aiManagement.noProvider);
    // Independent expectation: three of the twenty modules are enabled in this fixture.
    expect(map.textContent).toContain('3 of 20 capabilities available');
    expect(map.textContent).toContain('1 of 2 ready');expect(map.textContent).toContain('0 of 1 ready');
    expect(within(map as HTMLElement).getAllByRole('link').map(link=>link.getAttribute('href'))).toEqual(['/control-tower/agents/provider','/control-tower/agents/assistant','/control-tower/agents/features#ai-features','/control-tower/agents/features#ai-features','/control-tower/agents/allowances']);
  });
  it('names the administrator an agent runs under, and says when an agent is on without one (ADR-0151 §4.5)',async()=>{
    data.view={...view({heldNanos:'0',confirmedNanos:null}),features:[
      {id:'readiness_reminders',kind:'agent',state:'ready',enabled:true,mayWrite:true},
      {id:'claims_triage',kind:'agent',state:'ready',enabled:true,mayWrite:true},
      {id:'payroll_hypotheses',kind:'agent',state:'paused',enabled:false,mayWrite:true}],
      agentSwitches:{readiness_reminders:{state:'attributed',by:'Fictional Group Admin',at:new Date('2026-10-29T02:00:00Z')},claims_triage:{state:'unattributed'}}};
    const page=await AiManagementScreen({session:session as never,section:'features',searchParams:Promise.resolve({})});
    render(<NextIntlClientProvider locale="en" messages={en}>{page}</NextIntlClientProvider>);
    try{
      const row=(id:string)=>document.querySelector(`#ai-feature-${id}`)!.textContent!;
      expect(row('readiness_reminders')).toContain('Runs as the HR agent account, switched on by Fictional Group Admin on Oct 29, 2026.');
      expect(row('claims_triage')).toContain(en.aiManagement.agentUnattributed);
      // Payroll hypotheses is not run by the principal: no attribution line either way.
      expect(row('payroll_hypotheses')).not.toContain('HR agent account');
    }finally{cleanup();}
  });
  it('names the group allowance a login follows, and reviews a bulk change with its count before anything is written',async()=>{
  data.view={...view({heldNanos:'0',confirmedNanos:null}),users:[{id:'55555555-5555-4555-8555-555555555555',label:'Fictional Grouped Person',source:'group',group:{kind:'group_department',count:1,scopeKey:'group_department:44444444-4444-4444-8444-444444444444'},...use(10),assistantGranted:false}],
   groups:[{kind:'group_department',scopeKey:'group_department:44444444-4444-4444-8444-444444444444',subjectId:'44444444-4444-4444-8444-444444444444',enabled:true,dailyRequests:10,monthlyTokens:null,maxConcurrent:null}]};
  const page=await AiManagementScreen({session:session as never,section:'allowances',searchParams:Promise.resolve({bulk:'grant',bulkWho:'role:manager'})});
  render(<NextIntlClientProvider locale="en" messages={en}>{page}</NextIntlClientProvider>);
  expect(screen.getByText('Follows the Fictional Finance · Fictional Zero Cap Sdn Bhd (department) allowance')).toBeTruthy();
  expect(screen.getByText('This will give 2 people access to the HR assistant.')).toBeTruthy();
  const confirm=screen.getByRole('button',{name:'Give 2 people access'}).closest('form')!;
  expect(JSON.parse(String(new FormData(confirm).get('scope')))).toEqual({kind:'role',role:'manager'});expect(new FormData(confirm).get('confirmed')).toBe('2');
 });
 it('shows only closed save outcomes, never words carried in the address',async()=>{
    const saved=await show({heldNanos:'0',confirmedNanos:null},'allowances',{toast:'saved'});
    expect(screen.getByRole('status')).toHaveTextContent(en.aiManagement.saved);saved.unmount();
    await show({heldNanos:'0',confirmedNanos:null},'allowances',{toast:'Your account is locked. Call 555-0100.'});
    expect(screen.queryByText(/account is locked/)).toBeNull();expect(screen.queryByRole('status')).toBeNull();
  });
});
