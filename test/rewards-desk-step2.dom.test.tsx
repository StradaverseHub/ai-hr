// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {defaultPolicy} from '../packs/rewards/model';
// 5d34d00d Step 2 — person side panel, per-person flags, hidden-rows note and confirmed decisions.
const ports=vi.hoisted(()=>({read:vi.fn(),replace:vi.fn(),redirect:vi.fn((href:string)=>{throw new Error(href);})}));
vi.mock('next/link',()=>({default:({children,scroll:_s,replace:_r,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({redirect:ports.redirect,useRouter:()=>({replace:ports.replace}),usePathname:()=>'/rewards/unit',useSearchParams:()=>new URLSearchParams('person=b')}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'rewards'})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'t',userId:'actor'},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../packs/rewards/service',async()=>({getRewardUnit:ports.read,getRewardUnitGovernance:async()=>({managed:false}),listRewardUnits:async()=>[{id:'unit',holders:['Fictional CEO']}],defaultPolicy:(await import('../packs/rewards/model')).defaultPolicy,rewardPayrollChoices:async()=>[],rewardSetupChoices:async()=>({companies:[]})}));
vi.mock('../app/rewards/actions',()=>({importOnehrAction:vi.fn(),decideAction:vi.fn(),importFactsAction:vi.fn(),offcycleAction:vi.fn(),postAction:vi.fn()}));
vi.mock('../app/rewards/[unitId]/unit-governance',()=>({UnitGovernance:()=> <div>Unit budget owner</div>}));
vi.mock('../app/rewards/[unitId]/lump-sum',()=>({UnitLumpSum:()=> <div>Existing lump-sum owner</div>}));
vi.mock('../app/rewards/[unitId]/unit-multiplier',()=>({UnitMultiplier:()=> <div>Existing multiplier owner</div>}));
vi.mock('../app/rewards/[unitId]/pay-window',()=>({PayWindowTag:()=>null,PayWindowExcluded:()=>null}));
vi.mock('../app/rewards/[unitId]/source-refresh',()=>({SourceRefresh:()=>null}));
import RewardUnitPage from '../app/rewards/[unitId]/page';
const budget={excludedCount:0,excludedPayrollCents:0,payrollCents:0,pools:[0,0,0],used:[0,0,0],bonusPayrollCents:0,bonusPoolCents:0,bonusUsedCents:0,standardBonusCents:0,increasesCents:0,reductionsCents:0,lumpCents:0,lumpCount:0,balanceCents:0};
const row=(id:string,name:string,over:Record<string,unknown>={})=>({id,plan:'standard',source:{name,employeeCode:`E-${id}`,grade:'14',basicCents:500000,leftOn:null},facts:{reviewed:true,talent:'STAR',performance:'A',seniorPlan:false},recommendation:{promotionGrade:null},meritBp:500,promotionBp:0,specialBp:250,meritCents:25000,promotionCents:0,specialCents:12500,newBasicCents:537500,bonusBasicCents:500000,bonusMultiplierBp:15000,bonusCents:1200000,lumpCents:0,incrementReason:'',bonusReason:'',...over});
const view=(over:Record<string,unknown>={})=>({unit:{id:'unit',companyId:'company',revision:4,kind:'annual',status:'draft',snapshotDate:'2026-10-29',policy:defaultPolicy(2026)},cycle:{name:'Fictional 2026 cycle'},name:'Retail',companyName:'Fictional Company',roles:['bu'],route:['bu','bg','gr','ctro','ec'],
  rows:[row('a','Fictional Alpha'),row('b','Fictional Bravo'),row('c','Fictional Charlie',{facts:{reviewed:true,talent:'SCORE',performance:'B',seniorPlan:true}})],
  flags:[{code:'SAL-02',severity:'warning',message:'Increase above the guideline for this rating.',entryId:'b'},{code:'BUD-05',severity:'exception',message:'Individual lump sum amended.',entryId:'b'}],
  decisions:[],budgets:{standard:budget,h:budget},bonusCounts:{standard:null,h:null},payWindow:{standard:null,h:null},lumpDecision:null,suggestedLumpCents:0,lumpWorking:[],suggestedMultiplierBp:10000,suggestion:null,returned:null,due:null,hiddenCount:2,ec:null,canEdit:true,canConfigure:false,posting:'not-approved',seniorAmountsVisible:false,...over});
const show=async(searchParams:Record<string,string>={},over:Record<string,unknown>={})=>{ports.read.mockResolvedValue(view(over));const element=await RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve(searchParams)});return render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);};
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('Reward Desk step 2 — people and safe actions',()=>{
 it('shows the increase and each person\'s flags in the row, and a name opens that person in the side panel',async()=>{
  await show();
  const people=within(document.getElementById('people')!);
  expect(people.getByRole('columnheader',{name:'Increase %'})).toBeTruthy();expect(people.getByRole('columnheader',{name:'Flags'})).toBeTruthy();
  const bravo=people.getByRole('link',{name:'Fictional Bravo'});expect(bravo.getAttribute('href')).toBe('/rewards/unit?person=b');
  const cells=within(bravo.closest('tr')!);expect(cells.getByText('7.5%')).toBeTruthy();expect(cells.getByText('Warning 1')).toBeTruthy();expect(cells.getByText('Exception 1')).toBeTruthy();
  // A Senior plan member's figures stay hidden from a seat that may not see them.
  const charlie=within(people.getByRole('link',{name:'Fictional Charlie'}).closest('tr')!);expect(charlie.queryByText('7.5%')).toBeNull();expect(charlie.getAllByText(en.rewards.governance.handledSeparately).length).toBe(2);
  expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('opens the full calculation for ?person with Previous / Next in table order',async()=>{
  await show({person:'b'});
  const panel=within(screen.getByRole('dialog'));
  expect(panel.getByRole('heading',{name:'Fictional Bravo'})).toBeTruthy();
  for(const text of ['RM5,375.00','RM1,250.00','1.50','RM12,000.00','Increase above the guideline for this rating.','2 of 3'])expect(panel.getAllByText(text).length).toBeGreaterThan(0);
  expect(panel.getByRole('link',{name:/Previous/}).getAttribute('href')).toBe('/rewards/unit?person=a');
  expect(panel.getByRole('link',{name:/Next/}).getAttribute('href')).toBe('/rewards/unit?person=c');
  expect(panel.getByRole('link',{name:'Open full record to edit'}).getAttribute('href')).toBe('/rewards/unit/people/b');
 });
 it('ignores a ?person the viewer cannot see',async()=>{
  await show({person:'not-visible'});expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('says how many people visibility rules hide',async()=>{
  await show();expect(screen.getByRole('note').textContent).toBe('2 people are not listed here because of visibility rules. Unit totals include them.');
 });
 it('keeps Submit disabled while a Block is open and says why',async()=>{
  await show({},{flags:[{code:'SAL-01',severity:'block',message:'Salary reductions are not allowed in the salary review.',entryId:'a'}]});
  const submit=screen.getByRole('button',{name:en.rewards.submit}) as HTMLButtonElement;expect(submit.disabled).toBe(true);
  expect(screen.getByText('1 Block is still open. Clear every Block in Flags before you submit or approve.')).toBeTruthy();
 });
 it('needs a reason for open warnings, then confirms where the review goes before posting',async()=>{
  await show();
  const submit=screen.getByRole('button',{name:en.rewards.submit}) as HTMLButtonElement;expect(submit.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(en.rewards.decisionReason),{target:{value:'Guideline exceptions agreed with Group Rewards.'}});
  expect(submit.disabled).toBe(false);fireEvent.click(submit);
  const dialog=within(screen.getByRole('alertdialog'));
  expect(dialog.getByText('Submit this review?')).toBeTruthy();expect(dialog.getByText(`${en.rewards.stages.draft} → ${en.rewards.stages.bg}`)).toBeTruthy();
  expect((document.querySelector('input[name="action"]') as HTMLInputElement).value).toBe('submit');
 });
 it('offers Approve and Return to the stage holder, and Return needs its own reason',async()=>{
  await show({},{unit:{id:'unit',companyId:'company',revision:4,kind:'annual',status:'gr',snapshotDate:'2026-10-29',policy:defaultPolicy(2026)},roles:['gr'],flags:[],canEdit:false});
  const ret=screen.getByRole('button',{name:en.rewards.return}) as HTMLButtonElement,approve=screen.getByRole('button',{name:en.rewards.approve}) as HTMLButtonElement;
  expect(approve.disabled).toBe(false);expect(ret.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText(en.rewards.decisionReason),{target:{value:'Merit for two people needs a second look.'}});
  expect(ret.disabled).toBe(false);fireEvent.click(ret);
  expect(within(screen.getByRole('alertdialog')).getByText(`${en.rewards.stages.gr} → ${en.rewards.stages.draft}`)).toBeTruthy();
  expect((document.querySelector('input[name="action"]') as HTMLInputElement).value).toBe('return');
 });
});
