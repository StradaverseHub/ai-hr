// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {defaultPolicy} from '../packs/rewards/model';
const ports=vi.hoisted(()=>({read:vi.fn(),redirect:vi.fn((href:string)=>{throw new Error(href);})}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({redirect:ports.redirect}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'rewards'})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'t',userId:'actor'},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../packs/rewards/service',async()=>({getRewardUnit:ports.read,getRewardUnitGovernance:async()=>({managed:false}),listRewardUnits:async()=>[{id:'unit',holders:['Fictional CEO']}],defaultPolicy:(await import('../packs/rewards/model')).defaultPolicy,rewardPayrollChoices:async()=>[],rewardSetupChoices:async()=>({companies:[]})}));
vi.mock('../app/(app)/rewards/actions',()=>({importOnehrAction:vi.fn(),decideAction:vi.fn(),importFactsAction:vi.fn(),offcycleAction:vi.fn(),postAction:vi.fn()}));
vi.mock('../app/(app)/rewards/[unitId]/unit-governance',()=>({UnitGovernance:()=> <div>Unit budget owner</div>}));
vi.mock('../app/(app)/rewards/[unitId]/lump-sum',()=>({UnitLumpSum:()=> <div>Existing lump-sum owner</div>}));
vi.mock('../app/(app)/rewards/[unitId]/unit-multiplier',()=>({UnitMultiplier:()=> <div>Existing multiplier owner</div>}));
vi.mock('../app/(app)/rewards/[unitId]/pay-window',()=>({PayWindowTag:()=>null,PayWindowExcluded:()=>null}));
vi.mock('../app/(app)/rewards/[unitId]/source-refresh',()=>({SourceRefresh:()=>null}));
import RewardUnitPage from '../app/(app)/rewards/[unitId]/page';
const budget={excludedCount:0,excludedPayrollCents:0,payrollCents:0,pools:[0,0,0],used:[0,0,0],bonusPayrollCents:0,bonusPoolCents:0,bonusUsedCents:0,standardBonusCents:0,increasesCents:0,reductionsCents:0,lumpCents:0,lumpCount:0,balanceCents:0};
const view=()=>({unit:{id:'unit',companyId:'company',revision:1,kind:'annual',status:'draft',snapshotDate:'2026-10-29',policy:defaultPolicy(2026)},cycle:{name:'Fictional 2026 cycle'},name:'Retail',companyName:'Fictional Company',roles:['bu'],route:['bu','bg','gr','ctro','ec'],rows:[],flags:[{code:'POOL-03',severity:'block',message:'Promotion exceeds its separate pool.'}],decisions:[],budgets:{standard:budget,h:budget},bonusCounts:{standard:null,h:null},payWindow:{standard:null,h:null},lumpDecision:null,suggestedLumpCents:0,lumpWorking:[],suggestedMultiplierBp:10000,suggestion:null,returned:null,due:null,hiddenCount:0,ec:null,canEdit:true,canConfigure:false,posting:'not-approved'});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('annual Reward Desk page composition',()=>{
 it('renders every numbered review section on one page and puts all flags in the sidebar',async()=>{
  ports.read.mockResolvedValue(view());const element=await RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({})});render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
  for(const name of ['1 · Salary increase','2 · Bonus','People','Approvals'])expect(screen.getAllByRole('heading',{name}).length).toBeGreaterThan(0);
  expect(screen.getByRole('complementary',{name:'Flags'})).toBeTruthy();expect(screen.getByRole('link',{name:/Promotion exceeds/}).getAttribute('href')).toBe('#salary-increase');
  expect(screen.queryByRole('heading',{name:'3 · EC direct reports'})).toBeNull();expect(screen.queryByRole('navigation',{name:en.rewards.sections})).toBeNull();
  const details=document.querySelectorAll('details');expect(details.length).toBeGreaterThanOrEqual(3);expect([...details].every(node=>!node.open)).toBe(true);
  const salary=document.getElementById('salary-increase')!,bonus=document.getElementById('bonus')!,people=document.getElementById('people')!;
  expect(salary.compareDocumentPosition(bonus)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(bonus.compareDocumentPosition(people)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 });
 it('redirects old annual budget links to the canonical section while keeping search and check parameters',async()=>{
  ports.read.mockResolvedValue(view());await expect(RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({view:'budget',q:'Fictional person'})})).rejects.toThrow('/rewards/unit?q=Fictional+person#salary-increase');
  await expect(RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({view:'review',check:'BUD-05'})})).rejects.toThrow('/rewards/unit?check=BUD-05#checks');
 });
});
