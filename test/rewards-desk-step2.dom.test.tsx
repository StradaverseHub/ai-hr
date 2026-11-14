// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {defaultPolicy} from '../packs/rewards/model';
// 5d34d00d Step 2 / 37f82412 — the full-width People table, the person panel, paging and in-cell editing.
const ports=vi.hoisted(()=>({read:vi.fn(),replace:vi.fn(),save:vi.fn(),redirect:vi.fn((href:string)=>{throw new Error(href);})}));
vi.mock('next/link',()=>({default:({children,scroll:_s,replace:_r,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({redirect:ports.redirect,useRouter:()=>({replace:ports.replace,refresh:vi.fn()}),usePathname:()=>'/rewards/unit',useSearchParams:()=>new URLSearchParams('person=b')}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'rewards'})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'t',userId:'actor'},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../packs/rewards/service',async()=>({getRewardUnit:ports.read,getRewardPreparationStatus:async()=>({required:false,released:true,setupVisible:false,isGr:false,preparation:null}),rewardPayrollChoices:async()=>[],rewardSetupChoices:async()=>({companies:[]})}));
vi.mock('../app/rewards/actions',()=>({importOnehrAction:vi.fn(),decideAction:vi.fn(),importFactsAction:vi.fn(),offcycleAction:vi.fn(),postAction:vi.fn(),saveRewardCell:ports.save}));
vi.mock('../app/rewards/[unitId]/lump-sum',()=>({UnitLumpSum:()=> <div>Existing lump-sum owner</div>}));
vi.mock('../app/rewards/[unitId]/unit-multiplier',()=>({UnitMultiplier:()=> <div>Existing multiplier owner</div>}));
vi.mock('../app/rewards/[unitId]/pay-window',()=>({PayWindowTag:()=>null,PayWindowExcluded:()=>null}));
vi.mock('../app/rewards/[unitId]/source-refresh',()=>({SourceRefresh:()=>null}));
import RewardUnitPage from '../app/rewards/[unitId]/page';
import {DEFAULT_HIDDEN} from '../app/rewards/[unitId]/desk/people-grid';
const budget={excludedCount:0,excludedPayrollCents:0,payrollCents:0,pools:[0,0,0],used:[0,0,0],bonusPayrollCents:0,bonusPoolCents:0,bonusUsedCents:0,standardBonusCents:0,increasesCents:0,reductionsCents:0,lumpCents:0,lumpCount:0,balanceCents:0};
const recommendation={meritBp:null,promotionGrade:null,promotionBp:null,specialBp:null,multiplierBp:null,bonusCents:null,lumpCents:null,reason:'',currentRoleSummary:'',proposedRoleSummary:''};
const row=(id:string,name:string,over:Record<string,unknown>={})=>({id,plan:'standard',source:{name,employeeCode:`E-${id}`,grade:'14',basicCents:500000,leftOn:null},facts:{reviewed:true,talent:'STAR',performance:'ME',seniorPlan:false},recommendation,meritBp:500,promotionBp:0,specialBp:250,meritCents:25000,promotionCents:0,specialCents:12500,newBasicCents:537500,bonusBasicCents:500000,bonusMultiplierBp:15000,bonusMonthsBp:22500,bonusCents:1200000,lumpCents:0,incrementReason:'',bonusReason:'',bonusEligible:true,lumpEligible:false,payChange:null,crBeforeBp:9500,crAfterBp:10213,totalIncreaseBp:750,...over});
const view=(over:Record<string,unknown>={})=>({unit:{id:'unit',companyId:'company',revision:4,kind:'annual',status:'draft',snapshotDate:'2026-10-29',policy:{...defaultPolicy(2026),ranges:{'14':[400000,526000,650000],'15':[450000,560000,700000]}}},cycle:{name:'2026 Annual Compensation Review'},name:'Retail',companyName:'Fictional Company',roles:['bu'],route:['bu','bg','gr','ctro','ec'],
  rows:[row('a','Fictional Alpha'),row('b','Fictional Bravo',{recommendation:{...recommendation,reason:'Fictional business case.',note:'Fictional note for Bravo.'}}),row('c','Fictional Charlie',{facts:{reviewed:true,talent:'SCORE',performance:'BE',seniorPlan:true},meritBp:0,specialBp:0,totalIncreaseBp:null,crBeforeBp:null,crAfterBp:null})],
  flags:[{code:'INC-01',severity:'warning',message:'Increase exceeds the individual review threshold.',entryId:'b'},{code:'BUD-05',severity:'exception',message:'Individual lump sum differs from the unit amount; RM 0 means withheld.',entryId:'b'}],
  decisions:[],budgets:{standard:budget,h:budget},bonusCounts:{standard:null,h:null},payWindow:{standard:null,h:null},lumpDecision:null,suggestedLumpCents:0,lumpUnitCents:0,lumpWorking:[],suggestedMultiplierBp:10000,suggestion:null,returned:null,due:null,hiddenCount:2,ec:null,canEdit:true,canConfigure:false,posting:'not-approved',seniorAmountsVisible:false,fullView:false,...over});
const show=async(searchParams:Record<string,string>={},over:Record<string,unknown>={})=>{ports.read.mockResolvedValue(view(over));const element=await RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve(searchParams)});return render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);};
const grid=()=>within(document.querySelector('[data-people-grid]') as HTMLElement);
beforeEach(()=>{window.localStorage.clear();});
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('Review tab People table (37f82412)',()=>{
 it('groups the columns, keeps optional columns behind Columns and marks flagged rows',async()=>{
  await show();
  for(const name of ['Employee','Salary increase','Bonus'])expect(grid().getAllByRole('columnheader',{name}).length).toBeGreaterThan(0);
  for(const name of ['Merit %','Promotion','Total %','New basic','Months','Amount','Lump sum','Current basic'])expect(grid().getByRole('columnheader',{name})).toBeTruthy();
  // Hidden by default so the table fits a laptop screen; the Columns menu brings them back and remembers it.
  expect(DEFAULT_HIDDEN).toEqual(['crBefore','special','crAfter']);
  expect(grid().queryByRole('columnheader',{name:'CR after'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:en.rewards.desk.grid.columns}));
  fireEvent.click(screen.getByRole('checkbox',{name:'CR after'}));
  expect(grid().getByRole('columnheader',{name:'CR after'})).toBeTruthy();
  expect(JSON.parse(window.localStorage.getItem('aihr.rewards.review.columns.v1')!)).toEqual(['crBefore','special']);
  expect(grid().getAllByText('102.13%')).toHaveLength(2);
  const bravo=within(grid().getByRole('link',{name:'Fictional Bravo'}).closest('tr')!);
  expect(bravo.getByText('7.5%')).toBeTruthy();expect(bravo.getByText('MYR 5,375.00')).toBeTruthy();expect(bravo.getByText('MYR 12,000.00')).toBeTruthy();
  expect(bravo.getByRole('button',{name:'2 flags for Fictional Bravo'})).toBeTruthy();
  expect(grid().getByRole('link',{name:'Fictional Bravo'}).getAttribute('href')).toBe('/rewards/unit?person=b');
  // A Senior plan member's figures stay hidden, without a set-up label, from a seat that may not see them.
  const charlie=within(grid().getByRole('link',{name:'Fictional Charlie'}).closest('tr')!);
  expect(charlie.queryByText('7.5%')).toBeNull();expect(charlie.queryByText(en.rewards.governance.handledSeparately)).toBeNull();expect(charlie.queryByRole('textbox')).toBeNull();
  expect(grid().getByText('Total · 3 people')).toBeTruthy();
 });
 it('saves an edited merit cell through the review owner and shows the server figures, carrying the new revision to the next save',async()=>{
  await show();
  const alpha=row('a','Fictional Alpha');
  ports.save.mockResolvedValueOnce({ok:true,revision:5,row:{id:'a',name:'Fictional Alpha',employeeCode:'E-a',grade:'14',promotionGrade:null,talent:'STAR',performance:'ME',plan:'standard',basicCents:500000,crBeforeBp:9500,meritBp:600,promotionBp:0,specialBp:250,totalIncreaseBp:850,newBasicCents:542500,crAfterBp:10314,bonusMonthsBp:22500,multiplierBp:15000,bonusCents:1200000,lumpCents:0,overrides:{meritBp:true,promotionBp:false,specialBp:false,multiplierBp:false,lumpCents:false,promotionGrade:false},inputs:{meritBp:600,promotionBp:null,specialBp:null,multiplierBp:null,lumpCents:null,promotionGrade:null},editable:{increase:true,bonus:true,lump:false},promotionGrades:['15'],flag:null,flagCount:0,unverified:false,leftOn:null},
   summary:{plans:{standard:{salaryUsedCents:80000,salaryPoolCents:100000,bonusUsedCents:0,bonusPoolCents:0},h:{salaryUsedCents:0,salaryPoolCents:0,bonusUsedCents:0,bonusPoolCents:0}},multiplierBp:10000,lump:{perPersonCents:0,people:0,totalCents:0,mode:'withhold'},blocks:0,warnings:2,flags:2},totals:{people:3,basicCents:1500000,newBasicCents:1617500,bonusCents:3600000,lumpCents:0},flags:view().flags});
  const merit=grid().getByRole('textbox',{name:'Merit % · Fictional Alpha'}) as HTMLInputElement;
  expect(merit.placeholder).toBe('5.0');
  await act(async()=>{fireEvent.change(merit,{target:{value:'6'}});fireEvent.blur(merit);});
  expect(ports.save).toHaveBeenCalledWith('unit',4,'a','meritBp','6',{});
  const updated=within(grid().getByRole('link',{name:'Fictional Alpha'}).closest('tr')!);
  expect(updated.getByText('8.5%')).toBeTruthy();expect(updated.getByText('MYR 5,425.00')).toBeTruthy();
  expect(updated.getByRole('button',{name:en.rewards.desk.cell.reset})).toBeTruthy();
  expect(grid().getByText('MYR 16,175.00')).toBeTruthy();
  expect(screen.getByText(en.rewards.desk.save.saved)).toBeTruthy();
  expect(alpha.meritBp).toBe(500);
  ports.save.mockResolvedValueOnce({ok:false,stale:true,error:en.rewards.desk.cell.stale});
  const bravoMerit=grid().getByRole('textbox',{name:'Merit % · Fictional Bravo'});
  await act(async()=>{fireEvent.change(bravoMerit,{target:{value:'7'}});fireEvent.blur(bravoMerit);});
  expect(ports.save).toHaveBeenLastCalledWith('unit',5,'b','meritBp','7',{});
  // A save refused because the review changed elsewhere shows a banner with Reload, not an error page.
  expect(screen.getAllByRole('alert').some(node=>node.textContent?.includes(en.rewards.desk.save.stale))).toBe(true);
  expect(screen.getByRole('button',{name:en.rewards.desk.save.reload})).toBeTruthy();
 });
 it('offers no inputs once the BU CEO has submitted, and inputs to the BG CEO at their own step',async()=>{
  await show({},{unit:{...view().unit as object,status:'bg'},roles:['bu'],canEdit:false});
  expect(grid().queryByRole('textbox')).toBeNull();
  cleanup();
  await show({},{unit:{...view().unit as object,status:'bg'},roles:['bg'],canEdit:true});
  expect(grid().getByRole('textbox',{name:'Merit % · Fictional Alpha'})).toBeTruthy();
  expect(grid().getByRole('combobox',{name:'Promotion · Fictional Alpha'})).toBeTruthy();
 });
 it('filters the whole review from quick filter pills and pages large reviews at 50 people',async()=>{
  const many=Array.from({length:60},(_,i)=>row(`p${i}`,`Fictional Person ${String(i).padStart(2,'0')}`));
  await show({page:'1'},{rows:many,flags:[{code:'INC-01',severity:'warning',message:'Increase exceeds the individual review threshold.',entryId:'p55'}]});
  expect(grid().getAllByRole('row').filter(r=>r.closest('tbody')).length).toBe(10);
  expect(screen.getByText('Page 2 of 2 · 60 people')).toBeTruthy();
  expect(screen.getByRole('link',{name:en.rewards.desk.filters.flags}).getAttribute('href')).toBe('/rewards/unit?f=flags');
  expect(screen.getByRole('link',{name:'JG 14'}).getAttribute('href')).toBe('/rewards/unit?jg=14');
  cleanup();
  await show({f:'flags'},{rows:many,flags:[{code:'INC-01',severity:'warning',message:'Increase exceeds the individual review threshold.',entryId:'p55'}]});
  expect(grid().getAllByRole('link').map(a=>a.textContent)).toEqual(['Fictional Person 55']);
  expect(screen.getByRole('link',{name:en.rewards.desk.filters.flags}).getAttribute('aria-current')).toBe('true');
 });
 it('walks the person panel across pages in the filtered order',async()=>{
  const many=Array.from({length:60},(_,i)=>row(`p${i}`,`Fictional Person ${String(i).padStart(2,'0')}`));
  await show({person:'p49'},{rows:many});
  const panel=within(screen.getByRole('dialog'));
  expect(panel.getByText('50 of 60')).toBeTruthy();
  expect(panel.getByRole('link',{name:/Next/}).getAttribute('href')).toBe('/rewards/unit?person=p50');
 });
 it('opens the full calculation for ?person with Previous / Next, the business case and the Notes field',async()=>{
  await show({person:'b'});
  const panel=within(screen.getByRole('dialog'));
  expect(panel.getByRole('heading',{name:'Fictional Bravo'})).toBeTruthy();
  for(const text of [/^MYR\s5,375\.00$/,/^MYR\s125\.00$/,/^MYR\s12,000\.00$/,'1.50','2.25','95.0%','102.1%','2 of 3','Fictional business case.'])expect(panel.getAllByText(text).length).toBeGreaterThan(0);
  expect(panel.getByText(en.rewards.flagText.largeIncrease)).toBeTruthy();
  expect((panel.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Fictional note for Bravo.');
  expect(panel.getByRole('link',{name:/Previous/}).getAttribute('href')).toBe('/rewards/unit?person=a');
  expect(panel.getByRole('link',{name:/Next/}).getAttribute('href')).toBe('/rewards/unit?person=c');
  fireEvent.keyDown(window,{key:'ArrowRight'});
  expect(ports.replace).toHaveBeenCalledWith('/rewards/unit?person=c',{scroll:false});
 });
 it('ignores a ?person the viewer cannot see',async()=>{
  await show({person:'not-visible'});expect(screen.queryByRole('dialog')).toBeNull();
 });
 it('says how many people visibility rules hide, directly above the table',async()=>{
  await show();
  const note=screen.getByRole('note');
  expect(note.textContent).toBe('2 people are not listed here because of visibility rules. Unit totals include them.');
  expect(note.compareDocumentPosition(document.querySelector('[data-people-grid]')!)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText(en.rewards.privacyNote)).toBeNull();
 });
});
