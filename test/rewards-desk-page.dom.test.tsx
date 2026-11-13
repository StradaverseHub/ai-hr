// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {defaultPolicy} from '../packs/rewards/model';
const ports=vi.hoisted(()=>({read:vi.fn(),preparation:vi.fn<(...args:unknown[])=>Promise<{required:boolean;released:boolean;setupVisible:boolean;isGr:boolean;preparation:null|{releasedAt:string};expectedRelease?:string}>>(async()=>({required:false,released:true,setupVisible:false,isGr:false,preparation:null})),redirect:vi.fn((href:string)=>{throw new Error(href);})}));
vi.mock('next/link',()=>({default:({children,scroll:_s,replace:_r,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({redirect:ports.redirect,usePathname:()=>'/rewards/unit',useRouter:()=>({replace:vi.fn(),refresh:vi.fn()}),useSearchParams:()=>new URLSearchParams()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'rewards'})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'t',userId:'actor'},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../packs/rewards/service',async()=>({getRewardUnit:ports.read,getRewardPreparationStatus:ports.preparation,rewardPayrollChoices:async()=>[],rewardSetupChoices:async()=>({companies:[]})}));
vi.mock('../app/rewards/actions',()=>({importOnehrAction:vi.fn(),decideAction:vi.fn(),importFactsAction:vi.fn(),offcycleAction:vi.fn(),postAction:vi.fn(),saveRewardCell:vi.fn()}));
vi.mock('../app/rewards/[unitId]/lump-sum',()=>({UnitLumpSum:()=> <div>Existing lump-sum owner</div>}));
vi.mock('../app/rewards/[unitId]/unit-multiplier',()=>({UnitMultiplier:()=> <div>Existing multiplier owner</div>}));
vi.mock('../app/rewards/[unitId]/pay-window',()=>({PayWindowTag:()=>null,PayWindowExcluded:()=>null}));
vi.mock('../app/rewards/[unitId]/source-refresh',()=>({SourceRefresh:()=>null}));
import RewardUnitPage from '../app/rewards/[unitId]/page';
const budget={excludedCount:0,excludedPayrollCents:0,payrollCents:0,pools:[0,0,0],used:[0,0,0],bonusPayrollCents:0,bonusPoolCents:0,bonusUsedCents:0,standardBonusCents:0,increasesCents:0,reductionsCents:0,lumpCents:0,lumpCount:0,balanceCents:0};
const view=(over:Record<string,unknown>={})=>({unit:{id:'unit',companyId:'company',revision:1,kind:'annual',status:'draft',snapshotDate:'2026-10-29',policy:defaultPolicy(2026)},cycle:{name:'2026 Annual Compensation Review'},name:'Retail',companyName:'Fictional Company',roles:['bu'],route:['bu','bg','gr','ctro','ec'],rows:[],flags:[{code:'POOL-03',severity:'block',message:'Standard promotion exceeds its separate pool.'}],decisions:[],budgets:{standard:budget,h:budget},bonusCounts:{standard:null,h:null},payWindow:{standard:null,h:null},lumpDecision:null,suggestedLumpCents:0,lumpUnitCents:0,lumpWorking:[],suggestedMultiplierBp:10000,suggestion:null,returned:null,due:null,hiddenCount:0,ec:null,canEdit:true,canConfigure:false,posting:'not-approved',fullView:false,seniorAmountsVisible:false,...over});
const show=async(searchParams:Record<string,string>={})=>{const element=await RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve(searchParams)});return render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);};
afterEach(()=>{cleanup();vi.clearAllMocks();ports.preparation.mockResolvedValue({required:false,released:true,setupVisible:false,isGr:false,preparation:null});});

describe('annual Review tab (37f82412 simplified CEO view)',()=>{
 it('shows a compact header, the summary tiles first, the People table, then closed Budget details and Reference',async()=>{
  ports.read.mockResolvedValue(view({due:'2026-01-05'}));await show();
  expect(screen.getByRole('heading',{level:1,name:'Fictional Company · Retail · 2026 Annual Compensation Review'})).toBeTruthy();
  expect(screen.getByText(en.rewards.desk.status.draft)).toBeTruthy();
  expect(screen.getByText(/Due 2026-01-05 · overdue/).className).toContain('text-destructive');
  expect(screen.getByRole('button',{name:/Flags \(1\)/})).toBeTruthy();
  expect(screen.getByRole('link',{name:en.rewards.desk.approvalHistory}).getAttribute('href')).toBe('#approvals');
  for(const name of [en.rewards.desk.tiles.salary,en.rewards.desk.tiles.bonus,en.rewards.lumpSum])expect(screen.getAllByRole('heading',{name}).length).toBeGreaterThan(0);
  const tiles=screen.getAllByRole('heading',{name:en.rewards.desk.tiles.salary,level:2})[0],people=document.getElementById('people')!,budget=document.getElementById('budget-details') as HTMLDetailsElement,reference=document.getElementById('reference') as HTMLDetailsElement;
  expect(tiles.compareDocumentPosition(people)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(people.compareDocumentPosition(budget)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(budget.open).toBe(false);expect(reference.open).toBe(false);
  // The fixed Flags column is gone: flags open from the header as a drawer.
  expect(screen.queryByRole('complementary',{name:'Flags'})).toBeNull();
 });
 it('keeps the main action on the right, greyed out with the reason while a Block is open',async()=>{
  ports.read.mockResolvedValue(view({flags:[{code:'SAL-01',severity:'block',message:'Salary reductions are not allowed in the salary review.',entryId:'a'},{code:'POOL-03',severity:'block',message:'Standard merit exceeds its separate pool.'}]}));await show();
  expect((screen.getByRole('button',{name:en.rewards.submit}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Fix 2 blocking flags first')).toBeTruthy();
 });
 it('asks for a comment in a small window before approving with open warnings, and posts the current revision',async()=>{
  ports.read.mockResolvedValue(view({unit:{id:'unit',companyId:'company',revision:7,kind:'annual',status:'bg',snapshotDate:'2026-10-29',policy:defaultPolicy(2026)},roles:['bg'],flags:[{code:'BUD-07',severity:'warning',message:'Standard bonus budget is less than 80% utilised.'}]}));await show();
  expect(screen.getByText(en.rewards.desk.status.submitted)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:en.rewards.approve}));
  const dialog=within(screen.getByRole('alertdialog'));
  expect(dialog.getByText(`${en.rewards.stages.bg} → ${en.rewards.stages.gr}`)).toBeTruthy();
  const confirm=dialog.getByRole('button',{name:en.rewards.approve}) as HTMLButtonElement;expect(confirm.disabled).toBe(true);
  fireEvent.change(dialog.getByLabelText(en.rewards.decisionReason),{target:{value:'Fictional warning accepted for this unit.'}});
  expect(confirm.disabled).toBe(false);
  expect((document.querySelector('input[name="revision"]') as HTMLInputElement).value).toBe('7');
  expect((document.querySelector('input[name="action"]') as HTMLInputElement).value).toBe('approve');
 });
 it.each([
  ['BU CEO','bu','draft',true,false],['BG CEO','bg','bg',false,true],['Group Rewards','gr','gr',false,true],['CTRO','ctro','ctro',false,true],['Executive Chairman','ec','ec',false,true],['People Business Partner','pbp','bg',false,false],
 ] as const)('renders the %s decision controls at its stage',async(_label,role,stage,submit,approve)=>{
  ports.preparation.mockResolvedValue({required:false,released:true,setupVisible:['gr','ctro','ec'].includes(role),isGr:role==='gr',preparation:null});
  ports.read.mockResolvedValue(view({unit:{...view().unit as object,status:stage},roles:[role],flags:[],canEdit:role!=='pbp',fullView:['gr','ctro','ec'].includes(role)}));await show();
  expect(Boolean(screen.queryByRole('button',{name:en.rewards.submit}))).toBe(submit);
  expect(Boolean(screen.queryByRole('button',{name:en.rewards.approve}))).toBe(approve);
  expect(Boolean(screen.queryByRole('button',{name:en.rewards.return}))).toBe(approve);
  // 70d5e7c5: no Review / Unit set-up switch; only Group Rewards gets Open set-up in the header.
  expect(screen.queryByRole('link',{name:en.rewardsPreparation.setup})).toBeNull();
  expect(Boolean(screen.queryByRole('link',{name:en.rewards.desk.openSetup}))).toBe(role==='gr');
  if(role==='gr')expect(screen.getByRole('link',{name:en.rewards.desk.openSetup}).getAttribute('href')).toBe('/admin/rewards/review-setup/unit');
 });
 it('leaves the calculation workings, route text and the sections block out of the approver view',async()=>{
  ports.read.mockResolvedValue(view());await show();
  expect(screen.queryByText('Existing multiplier owner')).toBeNull();
  expect(screen.queryByText(en.rewards.desk.poolFormula)).toBeNull();
  const route=(['bu','bg','gr','ctro','ec'] as const).map(role=>en.rewards.roles[role]).join(' → ');
  expect(screen.queryByText(route)).toBeNull();
  expect(screen.queryByRole('heading',{name:en.rewards.sections})).toBeNull();
  expect(screen.queryByText(en.rewards.bonusPresentation.empty)).toBeNull();
 });
 it('keeps the workings, the route and Rules for Group Rewards in the same layout',async()=>{
  ports.preparation.mockResolvedValue({required:true,released:true,setupVisible:true,isGr:true,preparation:{releasedAt:'2026-11-08T00:00:00Z'}});
  ports.read.mockResolvedValue(view({roles:['gr'],fullView:true,ec:{count:0,referenceCents:0,incrementCents:0,bonusCents:0}}));await show();
  expect(screen.getByText('Existing multiplier owner')).toBeTruthy();
  expect(screen.getByText(en.rewards.desk.poolFormula)).toBeTruthy();
  expect(screen.getByText((['bu','bg','gr','ctro','ec'] as const).map(role=>en.rewards.roles[role]).join(' → '))).toBeTruthy();
  expect(screen.getByRole('heading',{name:en.rewards.desk.ec})).toBeTruthy();
  expect(screen.getByRole('link',{name:en.rewards.rules})).toBeTruthy();
  expect(screen.getByRole('link',{name:en.rewardsPreparation.changeLog}).getAttribute('href')).toBe('/admin/rewards/review-setup/unit?step=history');
 });
 it('renders only the preparation notice before asking the financial review owner for data',async()=>{
  ports.preparation.mockResolvedValue({required:true,released:false,setupVisible:false,isGr:false,preparation:null,expectedRelease:'2026-11-30'});await show();
  expect(screen.getByRole('status')).toHaveTextContent(en.rewardsPreparation.preparing);
  expect(screen.getByText('Expected release: 2026-11-30')).toBeTruthy();
  expect(ports.read).not.toHaveBeenCalled();
 });
 it('redirects old annual budget and set-up links to their new places',async()=>{
  ports.read.mockResolvedValue(view());
  await expect(RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({view:'budget',q:'Fictional person'})})).rejects.toThrow('/rewards/unit?q=Fictional+person#salary-increase');
  await expect(RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({view:'review',check:'BUD-05'})})).rejects.toThrow('/rewards/unit?check=BUD-05#checks');
  await expect(RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve({view:'excluded'})})).rejects.toThrow('/admin/rewards/review-setup/unit?step=excluded');
 });
});
