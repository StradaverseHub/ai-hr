// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import {deskRow,deskSummary,deskTotals} from '../app/rewards/[unitId]/desk/desk-model';
import {defaultPolicy} from '../packs/rewards/model';
// 5d34d00d Step 2 / 37f82412 — the full-width People table, the person panel, paging and in-cell editing.
const ports=vi.hoisted(()=>({read:vi.fn(),history:vi.fn(),replace:vi.fn(),save:vi.fn(),redirect:vi.fn((href:string)=>{throw new Error(href);})}));
vi.mock('next/link',()=>({default:({children,scroll:_s,replace:_r,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({redirect:ports.redirect,notFound:()=>{throw new Error('not-found');},useRouter:()=>({replace:ports.replace,refresh:vi.fn()}),usePathname:()=>'/rewards/unit',useSearchParams:()=>new URLSearchParams('person=b')}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'rewards'})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'t',userId:'actor'},scopeIds:['company']})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../packs/rewards/service',async()=>({getRewardUnit:ports.read,getRewardPreparationStatus:async()=>({required:false,released:true,setupVisible:false,isGr:false,preparation:null}),rewardPayrollChoices:async()=>[],rewardPersonHistory:ports.history,rewardSetupChoices:async()=>({companies:[]})}));
vi.mock('../app/rewards/actions',()=>({entryAction:vi.fn(),importOnehrAction:vi.fn(),decideAction:vi.fn(),importFactsAction:vi.fn(),offcycleAction:vi.fn(),postAction:vi.fn(),saveRewardCell:ports.save}));
vi.mock('../app/rewards/[unitId]/lump-sum',()=>({UnitLumpSum:()=> <div>Existing lump-sum owner</div>}));
vi.mock('../app/rewards/[unitId]/unit-multiplier',()=>({UnitMultiplier:()=> <div>Existing multiplier owner</div>}));
vi.mock('../app/rewards/[unitId]/pay-window',()=>({PayWindowTag:()=>null,PayWindowExcluded:()=>null}));
vi.mock('../app/rewards/[unitId]/source-refresh',()=>({SourceRefresh:()=>null}));
import RewardUnitPage from '../app/rewards/[unitId]/page';
import RewardPersonPage from '../app/rewards/[unitId]/people/[entryId]/page';
import {DEFAULT_HIDDEN} from '../app/rewards/[unitId]/desk/people-grid';
const budget={excludedCount:0,excludedPayrollCents:0,payrollCents:0,pools:[0,0,0],used:[0,0,0],bonusPayrollCents:0,bonusPoolCents:0,bonusUsedCents:0,standardBonusCents:0,increasesCents:0,reductionsCents:0,lumpCents:0,lumpCount:0,balanceCents:0};
const recommendation={meritBp:null,promotionGrade:null,promotionBp:null,specialBp:null,multiplierBp:null,bonusCents:null,lumpCents:null,reason:'',currentRoleSummary:'',proposedRoleSummary:''};
const row=(id:string,name:string,over:Record<string,unknown>={})=>({id,plan:'standard',source:{name,employeeCode:`E-${id}`,grade:'14',basicCents:500000,leftOn:null},facts:{reviewed:true,talent:'STAR',performance:'ME',seniorPlan:false},recommendation,meritBp:500,promotionBp:0,specialBp:250,meritCents:25000,promotionCents:0,specialCents:12500,newBasicCents:537500,bonusBasicCents:500000,bonusMultiplierBp:15000,bonusMonthsBp:22500,bonusCents:1200000,paidBonusMonthsBp:24000,suggestedMeritBp:500,suggestedPromotionBp:1000,suggestedSpecialBp:250,suggestedSpecialCents:12500,suggestedMultiplierBp:15000,suggestedLumpCents:0,allowedPromotionGrades:['15'],rangePosition:'in',lumpCents:0,incrementReason:'',bonusReason:'',bonusEligible:true,lumpEligible:false,payChange:null,crBeforeBp:9500,crAfterBp:10213,totalIncreaseBp:750,...over});
const view=(over:Record<string,unknown>={})=>({unit:{id:'unit',companyId:'company',revision:4,kind:'annual',status:'draft',snapshotDate:'2026-10-29',policy:{...defaultPolicy(2026),ranges:{'14':[400000,526000,650000],'15':[450000,560000,700000]}}},cycle:{name:'2026 Annual Compensation Review'},name:'Retail',companyName:'Fictional Company',roles:['bu'],route:['bu','bg','gr','ctro','ec'],
  rows:[row('a','Fictional Alpha'),row('b','Fictional Bravo',{recommendation:{...recommendation,reason:'Fictional business case.',note:'Fictional note for Bravo.'}}),row('c','Fictional Charlie',{facts:{reviewed:true,talent:'SCORE',performance:'BE',seniorPlan:true},meritBp:0,specialBp:0,totalIncreaseBp:null,crBeforeBp:null,crAfterBp:null})],
  flags:[{code:'INC-01',severity:'warning',message:'Increase exceeds the individual review threshold.',entryId:'b'},{code:'BUD-05',severity:'exception',message:'Individual lump sum differs from the unit amount; RM 0 means withheld.',entryId:'b'}],
  decisions:[],budgets:{standard:budget,h:budget},bonusCounts:{standard:null,h:null},payWindow:{standard:null,h:null},lumpDecision:null,suggestedLumpCents:0,lumpUnitCents:0,lumpWorking:[],suggestedMultiplierBp:10000,suggestion:null,returned:null,due:null,hiddenCount:2,ec:null,canEdit:true,canConfigure:false,posting:'not-approved',seniorAmountsVisible:false,fullView:false,...over});
const show=async(searchParams:Record<string,string>={},over:Record<string,unknown>={})=>{ports.read.mockResolvedValue(view(over));const element=await RewardUnitPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve(searchParams)});return render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);};
const grid=()=>within(document.querySelector('[data-people-grid]') as HTMLElement);
beforeEach(()=>{window.localStorage.clear();ports.history.mockResolvedValue([]);});
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
  for(const text of [/^MYR\s5,375\.00$/,/^MYR\s125\.00$/,/^MYR\s12,000\.00$/,'2.25','95.0%','102.1%','2 of 3','Fictional business case.'])expect(panel.getAllByText(text).length).toBeGreaterThan(0);
  expect((panel.getByRole('textbox',{name:`${en.rewards.bonusMultiplier} · Fictional Bravo`}) as HTMLInputElement).placeholder).toBe('1.50');
  expect(panel.getByText(en.rewards.flagText.largeIncrease)).toBeTruthy();
  expect((panel.getByRole('textbox',{name:en.rewards.desk.person.notes}) as HTMLTextAreaElement).value).toBe('Fictional note for Bravo.');
  expect(panel.getByRole('link',{name:/Previous/}).getAttribute('href')).toBe('/rewards/unit?person=a');
  expect(panel.getByRole('link',{name:/Next/}).getAttribute('href')).toBe('/rewards/unit?person=c');
  fireEvent.keyDown(window,{key:'ArrowRight'});
  expect(ports.replace).toHaveBeenCalledWith('/rewards/unit?person=c',{scroll:false});
 });

 it('keeps table and panel edits synchronized, including a person outside the current table page',async()=>{
  const many=Array.from({length:60},(_,i)=>row(`p${i}`,`Fictional Person ${String(i).padStart(2,'0')}`));
  await show({person:'p55'},{rows:many});
  const panel=within(screen.getByRole('dialog'));
  const source=many[55];
  ports.save.mockResolvedValueOnce({ok:true,revision:5,row:{id:'p55',name:source.source.name,employeeCode:source.source.employeeCode,grade:'14',promotionGrade:null,talent:'STAR',performance:'ME',plan:'standard',basicCents:500000,meritBp:700,promotionBp:0,specialBp:250,totalIncreaseBp:950,newBasicCents:547500,crBeforeBp:9500,crAfterBp:10409,bonusMonthsBp:22500,multiplierBp:15000,bonusCents:1200000,lumpCents:0,inputs:{meritBp:700,promotionBp:null,specialBp:null,multiplierBp:null,lumpCents:null,promotionGrade:null},overrides:{meritBp:true,promotionBp:false,specialBp:false,multiplierBp:false,lumpCents:false,promotionGrade:false},editable:{increase:true,bonus:true,lump:false},promotionGrades:['15'],suggested:{meritBp:500,promotionBp:1000,specialBp:250,multiplierBp:15000,lumpCents:0},differences:{meritBp:200,promotionBp:0,specialBp:0,multiplierBp:0,lumpCents:0},rangePosition:'in',meritCents:35000,promotionCents:0,specialCents:12500,incrementCents:47500,bonusBasicCents:500000,paidBonusMonthsBp:24000,incrementReason:'',bonusReason:'',businessCase:'',note:'',withhold:{},erCase:false,pipCase:false,erDecision:'pending',pipDecision:'pending',caseReason:'',notesEditable:true,casesEditable:true,viewOnlyStage:null,flag:null,flagCount:0,unverified:false,leftOn:null},summary:{plans:{standard:{salaryUsedCents:47500,salaryPoolCents:100000},h:{salaryUsedCents:0,salaryPoolCents:0}},multiplierBp:15000,lump:{perPersonCents:0,people:0,totalCents:0,mode:'auto'},blocks:0,warnings:0,flags:0},totals:{people:60,basicCents:30000000,newBasicCents:32260000,bonusCents:72000000,lumpCents:0},flags:[]});
  const merit=panel.getByRole('textbox',{name:'Merit % · Fictional Person 55'});
  await act(async()=>{fireEvent.change(merit,{target:{value:'7'}});fireEvent.blur(merit);});
  expect(ports.save).toHaveBeenCalledWith('unit',4,'p55','meritBp','7',{});
  expect(panel.getAllByText('MYR 5,475.00')).toHaveLength(1);
  expect(panel.getByText(/Difference \+2%/)).toBeTruthy();
  expect(panel.getByRole('button',{name:'Use suggested'})).toBeTruthy();
  expect(panel.queryByRole('link',{name:en.rewards.desk.person.openRecord})).toBeNull();
 });
 it('autosaves the panel note on blur without a Save note button and exposes a three-year history',async()=>{
  await show({person:'b'});
  const panel=within(screen.getByRole('dialog'));
  expect(panel.getByRole('heading',{name:en.rewards.desk.panel.history})).toBeTruthy();
  expect(panel.getByText('This review – not final')).toBeTruthy();
  expect(panel.getAllByText('— · Not on record')).toHaveLength(2);
  expect(panel.queryByRole('button',{name:en.rewards.desk.person.saveNote})).toBeNull();
  ports.save.mockResolvedValueOnce({ok:false,stale:false,error:'Fictional save refused; correct the note.'});
  const note=panel.getByRole('textbox',{name:en.rewards.desk.person.notes});
  await act(async()=>{fireEvent.change(note,{target:{value:'Updated fictional note'}});fireEvent.blur(note);});
  expect(ports.save).toHaveBeenCalledWith('unit',4,'b','note','Updated fictional note',{});
  expect((note as HTMLTextAreaElement).value).toBe('Updated fictional note');
  expect(panel.getByRole('alert').textContent).toContain('Fictional save refused');
 });

 it.each(['bu','bg','proxy_bg'])('refuses annual full-person routes for %s reviewers',async role=>{
  ports.read.mockResolvedValue(view({roles:[role],fullView:false}));
  await expect(RewardPersonPage({params:Promise.resolve({unitId:'unit',entryId:'b'})})).rejects.toThrow('not-found');
 });
 it.each(['gr','ctro','ec'])('retains full-person routes and a bounded grade dropdown for %s',async role=>{
  ports.read.mockResolvedValue(view({roles:[role],fullView:true}));
  const element=await RewardPersonPage({params:Promise.resolve({unitId:'unit',entryId:'b'})});
  render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
  expect(screen.getByRole('heading',{name:'Fictional Bravo'})).toBeTruthy();
  const grade=screen.getByRole('combobox',{name:en.rewards.promotionGrade});
  expect(within(grade).getByRole('option',{name:'To JG 15'})).toBeTruthy();
 });
 it('preserves the separate off-cycle person page for reviewers',async()=>{
  ports.read.mockResolvedValue(view({fullView:false,unit:{...view().unit,kind:'adhoc'}}));
  const element=await RewardPersonPage({params:Promise.resolve({unitId:'unit',entryId:'b'})});
  render(<NextIntlClientProvider locale="en" messages={en}>{element}</NextIntlClientProvider>);
  expect(screen.getByRole('heading',{name:'Fictional Bravo'})).toBeTruthy();
 });

 it.each(['bu','bg','gr'] as const)('renders and edits the real panel as %s at their own step with desktop and mobile evidence',async role=>{
  ports.history.mockResolvedValue([
   {id:'past-annual',year:2025,kind:'annual',source:'review',talent:'STAR',performance:'AE',meritBp:500,promotionBp:0,specialBp:0,incrementCents:25000,totalIncreaseBp:500,promoted:false,promotionGrade:null,bonusCents:500000,bonusMonthsBp:10000,lumpCents:0,withheld:{}},
   {id:'past-offcycle',year:2025,kind:'offcycle',source:'review',talent:'STAR',performance:'AE',meritBp:100,promotionBp:0,specialBp:0,incrementCents:5000,totalIncreaseBp:100,promoted:false,promotionGrade:null,bonusCents:0,bonusMonthsBp:0,lumpCents:0,withheld:{}},
   {id:'past-upload',year:2024,kind:'annual',source:'upload',talent:'SCORE',performance:'ME',meritBp:400,promotionBp:0,specialBp:0,incrementCents:20000,totalIncreaseBp:400,promoted:false,promotionGrade:null,bonusCents:400000,bonusMonthsBp:8000,lumpCents:0,withheld:{}},
  ]);
  const initial=view({roles:[role],fullView:role==='gr',unit:{...view().unit,status:role==='bg'?'bg':role==='gr'?'gr':'draft'},canEdit:true,approvalStageEdit:role==='gr',budgets:{standard:{...budget,payrollCents:1000000,pools:[100000,20000,50000],used:[50000,0,25000],bonusPayrollCents:1000000,bonusPoolCents:3000000,bonusUsedCents:2400000,standardBonusCents:2400000},h:budget}});
  await show({person:'b'},initial);
  const panel=within(screen.getByRole('dialog'));
  expect(panel.getByRole('heading',{name:en.rewards.desk.panel.history})).toBeTruthy();
  expect(panel.getByText('Off-cycle')).toBeTruthy();
  const changed=row('b','Fictional Bravo',{...initial.rows[1],recommendation:{...initial.rows[1].recommendation,meritBp:600},meritBp:600,meritCents:30000,totalIncreaseBp:850,newBasicCents:542500,crAfterBp:10314});
  const next={...initial,unit:{...initial.unit,revision:5},rows:[initial.rows[0],changed,initial.rows[2]],budgets:{...initial.budgets,standard:{...initial.budgets.standard,used:[55000,0,25000]}}};
  const rows=next.rows.map(item=>deskRow(next as any,item as any,next.flags as any));
  ports.save.mockResolvedValueOnce({ok:true,revision:5,row:rows[1],summary:deskSummary(next as any),totals:deskTotals(rows),flags:next.flags});
  const merit=panel.getByRole('textbox',{name:'Merit % · Fictional Bravo'});
  await act(async()=>{fireEvent.change(merit,{target:{value:'6'}});fireEvent.blur(merit);});
  // Radix correctly removes the background table from the accessibility tree while the modal is open.
  // Inspect that intentionally inert DOM state without making its controls accessible behind the drawer.
  const backgroundMerit=grid().getByDisplayValue('6') as HTMLInputElement;
  expect(backgroundMerit.getAttribute('aria-label')).toBe('Merit % · Fictional Bravo');
  expect(backgroundMerit.value).toBe('6');
  expect(panel.getByText('MYR 5,425.00')).toBeTruthy();
  if(role==='gr')expect(panel.getByRole('link',{name:en.rewards.desk.person.openRecord})).toBeTruthy();
  else expect(panel.queryByRole('link',{name:en.rewards.desk.person.openRecord})).toBeNull();
  const content=document.querySelector<HTMLElement>('[data-reward-person-panel="b"]')!;
  expect(content).not.toBeNull();
  await captureAiReviewScreenshots('<section class="mx-auto max-w-3xl">'+aiReviewDomHtml(content)+'</section>','en',`rewards-person-panel-${role}`,'Actual editable Rewards person panel after shared table/panel save; fictional service projection and history; DB authority checked separately; no installed application acceptance.','atelier');
  await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en',`rewards-person-drawer-${role}`,'Actual Rewards page and portaled person drawer at the reviewer’s own step, after a shared-state edit; fictional data owners; no installed application acceptance.','atelier');
 },120000); // Two bounded source-rendered captures per role use hosted Chrome and real application CSS/fonts.

 it('keeps review decisions disabled until an automatic save succeeds',async()=>{
  let release!:(result:unknown)=>void;
  ports.save.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  await show();
  const merit=grid().getByRole('textbox',{name:'Merit % · Fictional Alpha'});
  await act(async()=>{fireEvent.change(merit,{target:{value:'6'}});fireEvent.blur(merit);});
  expect((screen.getByRole('button',{name:en.rewards.submit}) as HTMLButtonElement).disabled).toBe(true);
  await act(async()=>{release({ok:false,stale:false,error:'Fictional save failure. Retry before deciding.'});});
  expect((screen.getByRole('button',{name:en.rewards.submit}) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button',{name:en.rewards.desk.save.retry})).toBeTruthy();
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
