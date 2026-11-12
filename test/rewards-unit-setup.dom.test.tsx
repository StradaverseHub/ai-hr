// @vitest-environment jsdom
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,cleanup,within} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {resolveServerTree} from './helpers/server-tree';
import {emptyRewardPreparation} from '../packs/rewards/preparation-model';
// 70d5e7c5 — Configuration › Review Set-up for one review: checklist, one step at a time, release bar.
const copies={en,ms,zh,ta,th,vi:viCopy};
const state=vi.hoisted(()=>({locale:'en' as keyof typeof copies,canEdit:true,isGr:true,required:true,outsideYear:false,checks:true,steps:{} as Record<string,unknown>,previews:0}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()}),redirect:vi.fn()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:'rewards')=>createTranslator({locale:state.locale,messages:copies[state.locale],namespace})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{tenantId:'fictional-tenant',userId:'fictional-gr'}})}));
vi.mock('../app/rewards/preparation-actions',()=>({preparationAction:vi.fn()}));
vi.mock('../app/rewards/actions',()=>({importOnehrAction:vi.fn(),importFactsAction:vi.fn(),previewSourceRefreshAction:vi.fn(),saveSourceRefreshAction:vi.fn(),payWindowKeepAction:vi.fn(),previewSeniorMembershipAction:vi.fn(),saveSeniorMembershipAction:vi.fn()}));
vi.mock('../app/rewards/governance-actions',()=>({adoptCompanyPatAction:vi.fn(),refreshCompanyPatBasisAction:vi.fn(),unitInputsAction:vi.fn(),exemptionAction:vi.fn(),confirmGovernanceAction:vi.fn(),seniorAwardAction:vi.fn()}));
vi.mock('../packs/rewards/service',()=>({
 RewardError:class RewardError extends Error{},
 getRewardPreparationChecklist:async()=>({unitId:'unit',revision:8,snapshotDate:'2026-01-01',basis:'a'.repeat(64),canEdit:state.canEdit,canReopen:false,needsReopen:false,branch:false,budgetInputs:{forecastCents:10000000,actualCents:11000000,targetCents:10000000,targetMonthsBp:20000,multiplierBp:10000,branchRatings:{}},status:'draft',year:2026,
  exclusionWindow:{from:state.outsideYear?'2025-10-01':'2026-10-01',to:state.outsideYear?'2025-12-31':'2026-12-31',outsideYear:state.outsideYear},
  preparation:{...emptyRewardPreparation(),expectedRelease:'2026-11-30',steps:state.steps},checks:state.isGr?{snapshot:state.checks,data:true,excluded:!state.outsideYear,senior:true,budget:true,applied:true}:null,
  access:{required:state.required,setupVisible:true,isGr:state.isGr,independentChecker:false,actorNames:{'person-doer':'Fictional Doer'},history:[{id:'h1',kind:'preparation-confirm',reason:'Group Rewards preparation confirm',actorName:'Fictional Doer',at:'2026-11-01T02:00:00Z'}],applied:{salary:{name:'Fictional salary structure',version:2,confirmed:true},bonus:{name:'Fictional bonus matrix',version:3,confirmed:true}},origin:{name:'Fictional shared configuration',revision:4}}}),
 getRewardUnitGovernance:async()=>({available:true,unitId:'unit',revision:8,isGr:state.isGr,canEdit:state.canEdit,canAmounts:true,inputs:{forecastCents:10000000,actualCents:11000000,targetCents:10000000,multiplierBp:10000,branchRatings:{},targetMonthsBp:20000},legacyInputs:null,pools:{standard:200000,h:50000},poolStatus:'final',branches:[],history:[],selection:{confirmedBy:null},exemption:null,senior:[],companyPatBound:false}),
 getRewardSeniorMembership:async()=>({unitId:'unit',revision:8,canEdit:true,mode:'named-members',rows:[]}),
 // 60f1fdcd: the release preview is the server-computed "Review before saving" summary; only asked for once every step is done.
 previewRewardPreparationRelease:async()=>{state.previews++;return{summary:{area:'preparation',itemLabel:'Release to BU CEO · Fictional Company 2026',lines:[{key:'state',label:'Unit set-up',before:'Preparing',after:'Released to BU CEO'}],changedCount:1,affected:[{reviewId:'unit',label:'Fictional Company 2026',stage:'draft',consequence:'released-to-bu'}],highImpact:['release-review']},digest:'d'.repeat(64)};},
 getRewardUnit:async()=>({companyName:'Fictional Company',name:'Fictional Unit',cycle:{name:'2026 Annual Compensation Review'},unit:{policy:{blockedFrom:'2026-10-01',blockedTo:'2026-12-31',payWindowKeep:{}}},rows:[]}),
}));
import SetupPage from '../app/admin/rewards/review-setup/[unitId]/page';
afterEach(()=>{cleanup();Object.assign(state,{locale:'en',canEdit:true,isGr:true,required:true,outsideYear:false,checks:true,steps:{},previews:0});});
async function show(searchParams:Record<string,string>={}){const tree=await resolveServerTree(await SetupPage({params:Promise.resolve({unitId:'unit'}),searchParams:Promise.resolve(searchParams)}));return render(<NextIntlClientProvider locale={state.locale} messages={copies[state.locale]} onError={error=>{throw error;}}>{tree}</NextIntlClientProvider>);}
describe('Review Set-up detail (70d5e7c5)',()=>{
 it.each(Object.keys(copies) as (keyof typeof copies)[])('lists six numbered steps and opens one at a time in %s',async locale=>{
  state.locale=locale;const view=await show();const copy=copies[locale].rewardsPreparation;
  const checklist=within(screen.getByRole('navigation',{name:copy.checklist}));
  expect(checklist.getAllByRole('link')).toHaveLength(6);
  expect(checklist.getByRole('link',{name:new RegExp(copy.steps.snapshot)}).getAttribute('aria-current')).toBe('step');
  // Only the open step offers its confirm button; release stays unavailable until every step is done.
  expect(screen.getAllByRole('button',{name:copy.confirm})).toHaveLength(1);
  expect(screen.getByRole('button',{name:copy.release})).toBeDisabled();
  expect(screen.queryByText(/predates preparation history/)).toBeNull();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'rewards-review-setup');
 },60000);
 it('says why release is unavailable, step first, then the expected date',async()=>{
  state.checks=false;await show();
  expect(screen.getByRole('status').textContent).toBe('Step 1: the employee snapshot has changes to review');
  cleanup();state.checks=true;state.steps={snapshot:{basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'},data:{basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'},excluded:{basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'},senior:{basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'},budget:{basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'},applied:{basis:'b'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'}};
  await show({step:'applied'});
  expect(screen.getAllByText(en.rewardsPreparation.done)).toHaveLength(5);
  expect(screen.getByRole('status').textContent).toBe('Step 6: not confirmed yet');
  expect(screen.getAllByText('Fictional Doer').length).toBeGreaterThan(0);
  expect(screen.getByText('Fictional salary structure · Version 2')).toBeTruthy();
 });
 it('releases directly with the Review before saving summary and a reason once every step is done (60f1fdcd)',async()=>{
  const proof={basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'};
  state.steps={snapshot:proof,data:proof,excluded:proof,senior:proof,budget:proof,applied:proof};
  await show({step:'applied'});
  expect(state.previews).toBe(1);
  expect(screen.getByRole('status').textContent).toBe(en.rewardsPreparation.ready);
  expect(screen.getByRole('button',{name:en.rewardsPreparation.release})).toBeEnabled();
  const form=document.querySelector('input[name="summaryDigest"]')!.closest('form')!;
  expect((form.querySelector('input[name="summaryDigest"]') as HTMLInputElement).value).toBe('d'.repeat(64));
  expect((form.querySelector('input[name="kind"]') as HTMLInputElement).value).toBe('release');
  expect((form.querySelector('input[name="returnStep"]') as HTMLInputElement).value).toBe('applied');
  const reason=form.querySelector('textarea[name="reason"]') as HTMLTextAreaElement;expect(reason.required).toBe(true);expect(reason.minLength).toBe(10);
  expect(within(form).getByText(en.rewardConfig.highImpact['release-review'])).toBeTruthy();
  expect(within(form).getByText('Released to BU CEO')).toBeTruthy();
  // No second-person checker: the same Group Rewards user who confirmed the steps may release.
  expect(document.body.textContent).not.toContain(en.rewardsPreparation.independent);
 });
 it('does not ask for a release summary while a step is open or for a read-only viewer',async()=>{
  await show();expect(state.previews).toBe(0);cleanup();
  const proof={basis:'a'.repeat(64),actorId:'u',actorPersonId:'person-doer',at:'2026-11-01T02:00:00Z'};
  state.steps={snapshot:proof,data:proof,excluded:proof,senior:proof,budget:proof,applied:proof};state.canEdit=false;state.isGr=false;
  await show();expect(state.previews).toBe(0);expect(screen.getByRole('button',{name:en.rewardsPreparation.release})).toBeDisabled();
 });
 it('flags an exclusion window outside the review year as blocking',async()=>{
  state.outsideYear=true;await show({step:'excluded'});
  expect(screen.getByRole('alert').textContent).toContain('outside the 2026 review year');
  const day=(iso:string)=>new Intl.DateTimeFormat('en',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${iso}T00:00:00Z`));
  expect(screen.getByText(`Exclusion window: ${day('2025-10-01')} – ${day('2025-12-31')}`)).toBeTruthy();
  expect(screen.getByRole('button',{name:en.rewardsPreparation.confirm})).toBeDisabled();
  expect(screen.getByText(en.rewardsPreparation.reasons.window)).toBeTruthy();
 });
 it('keeps PAT read-only in Budget inputs with a link to PAT Inputs, and amounts in MYR',async()=>{
  await show({step:'budget'});
  expect(screen.getByRole('link',{name:en.nav.rewardsPatInputs}).getAttribute('href')).toBe('/admin/rewards/pat-inputs');
  for(const name of ['forecast','actual','target','targetMonths'])expect((document.querySelector(`input[name="${name}"]`) as HTMLInputElement).readOnly).toBe(true);
  expect((document.querySelector('input[name="multiplier"]') as HTMLInputElement).readOnly).toBe(false);
  expect(screen.getByText(/MYR 2,000\.00/)).toBeTruthy();expect(document.body.textContent).not.toMatch(/RM\s?\d/);
 });
 it('labels the Senior plan check "Confirm Senior plan selection"',async()=>{
  await show({step:'senior'});
  expect(screen.getByRole('button',{name:en.rewards.governance.confirmSenior})).toBeTruthy();
 });
 it('renders CTRO/EC set-up as read-only without doer or release actions',async()=>{
  state.canEdit=false;state.isGr=false;await show();
  expect(screen.queryByRole('button',{name:en.rewardsPreparation.confirm})).toBeNull();
  expect(screen.getByRole('button',{name:en.rewardsPreparation.release})).toBeDisabled();
  expect(screen.getByText(en.rewardsPreparation.readOnly)).toBeTruthy();
 });
 it('shows a review released before tracking as done before tracking, read only',async()=>{
  state.required=false;await show();
  expect(screen.getAllByText(en.rewardsPreparation.beforeTracking)).toHaveLength(7);
  expect(screen.queryByRole('button',{name:en.rewardsPreparation.release})).toBeNull();
  expect(screen.queryByText(/Not recorded/)).toBeNull();
 });
 it('opens the change log as its own step',async()=>{
  await show({step:'history'});
  expect(screen.getByRole('heading',{name:en.rewardsPreparation.changeLog})).toBeTruthy();
  expect(screen.getByText('Group Rewards preparation confirm')).toBeTruthy();
 });
});
