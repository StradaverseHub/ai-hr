// @vitest-environment jsdom
/** CI visual witnesses render the actual Review Plans page, grid and New reward year components. Services and
 * principal capabilities are fictional projections; database principal proofs and installed acceptance are separate.
 * Keyboard/edit/error behavior runs in jsdom; Chrome renders that exact source DOM with the application CSS. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import type {RewardReviewPlans,RewardReviewPlanRow,RewardYearSettings} from '../packs/rewards/review-plans-model';
import type {RewardConfigSummary} from '../packs/rewards/config-change-model';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const ports=vi.hoisted(()=>{const refresh=vi.fn(),push=vi.fn();return{router:{refresh,push},read:vi.fn(),preview:vi.fn(),save:vi.fn(),copy:vi.fn(),accept:vi.fn(),create:vi.fn(),progress:vi.fn(),previewYear:vi.fn(),createYear:vi.fn(),classify:vi.fn(),refreshGrid:vi.fn(),refresh,push};});
vi.mock('next/navigation',()=>({useRouter:()=>ports.router,notFound:()=>{throw new Error('not found');}}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:any)=>createTranslator({locale:'en',messages:en,namespace})}));
vi.mock('../lib/authz',()=>({requireModule:async()=>({tenantId:'11111111-1111-4111-8111-111111111111',userId:'11111111-1111-4111-8111-111111111112'})}));
vi.mock('../packs/rewards/review-plans',()=>({rewardReviewPlans:ports.read}));
vi.mock('../app/admin/rewards/review-plans/actions',()=>({previewGridAction:ports.preview,saveGridAction:ports.save,previousChoicesAction:ports.copy,acceptSuggestionsAction:ports.accept,createReviewsAction:ports.create,reviewJobAction:ports.progress,previewYearAction:ports.previewYear,createYearAction:ports.createYear,classifyCompanyAction:ports.classify,refreshGridAction:ports.refreshGrid}));
import ReviewPlansPage from '../app/admin/rewards/review-plans/page';

const id=(value:number)=>`10000000-0000-4000-8000-${String(value).padStart(12,'0')}`;
const salary=id(1),bonus=id(2),branch=id(3),bu1=id(4),bu2=id(5);
const settings:RewardYearSettings={effectiveFrom:'2026-04-01',joinedBefore:'2025-12-31',confirmedBy:'2026-03-31',activeAsOf:'2026-04-01',blockedFrom:'2025-10-01',blockedTo:'2026-03-31',snapshotDate:'2026-03-31'};
const alpha:RewardReviewPlanRow={companyId:id(11),company:'Alpha Fictional Sdn Bhd',businessUnitId:bu1,businessUnit:'Consumer',revision:4,planVersionId:id(21),planType:'standard',reason:'',salaryVersionId:salary,bonusVersionId:bonus,salarySuggestion:{versionId:salary,source:'previous-year',reviewed:false},bonusSuggestion:{versionId:bonus,source:'group-default',reviewed:false},headcount:125,patEntered:true,status:'draft',canEdit:true,reviewUnitId:null,branchAcknowledged:false};
const beta:RewardReviewPlanRow={...alpha,companyId:id(12),company:'Beta Fictional Sdn Bhd',revision:2,businessUnitId:bu2,businessUnit:'Services',bonusVersionId:null,bonusSuggestion:{versionId:null,source:'multiple-matches',reviewed:false},headcount:86,patEntered:false};
const reviewSummary:RewardConfigSummary={area:'plan',itemLabel:'Review Plans 2026',lines:[{key:'alpha:planType',label:'Alpha Fictional Sdn Bhd · Plan type',before:'Standard plan',after:'Uploaded awards'}],changedCount:1,affected:[],highImpact:[]};
const evidence='Actual Review Plans page, ReviewPlanGrid and NewRewardYear source components. Fictional company metadata and mocked Group Rewards/EC/scoped-HR service capability projections. Keyboard interaction in jsdom and inert Chromium source-DOM capture; no authenticated installed journey, database authorization or financial acceptance claim.';
function projection(overrides:Partial<RewardReviewPlans>={}):RewardReviewPlans{return{years:[2026,2025],classificationCompanies:[],classifications:[],canClassify:false,businessUnits:[{id:bu1,name:'Consumer'},{id:bu2,name:'Services'}],excludedCompanies:[{id:id(99),name:'Fictional Group of Companies',reason:'grouping'}],yearSettings:settings,suggestedYearSettings:settings,rows:[alpha,beta],coverage:{total:2,ready:0,missingSalary:0,missingBonus:1,missingPat:1,unreviewed:2,reviewsCreated:0},libraries:[{id:salary,libraryId:salary,kind:'salary',name:'Standard salary 2026',version:2,bonusType:null},{id:bonus,libraryId:bonus,kind:'bonus',name:'Group bonus 2026',version:1,bonusType:'standard'},{id:branch,libraryId:branch,kind:'bonus',name:'Branch bonus 2026',version:1,bonusType:'branch'}],canCreateYear:true,canEdit:true,canCreateReviews:true,page:1,hasMore:false,...overrides};}
async function element(data:RewardReviewPlans,params:Record<string,string>={}){ports.read.mockResolvedValue(data);return<NextIntlClientProvider locale="en" messages={en} onError={error=>{throw error;}}>{await ReviewPlansPage({searchParams:Promise.resolve({year:'2026',...params})})}</NextIntlClientProvider>;}
async function show(data=projection(),params:Record<string,string>={}){return render(await element(data,params));}
async function capture(view:ReturnType<typeof render>,section:`rewards-${string}`){await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en',section,evidence,'atelier');}
beforeEach(()=>{vi.resetAllMocks();ports.preview.mockResolvedValue({ok:true,review:{summary:reviewSummary,digest:'a'.repeat(64)}});ports.save.mockResolvedValue({ok:true});ports.createYear.mockResolvedValue({ok:true});});
afterEach(cleanup);

describe('Review Plans source-rendered journeys',()=>{
 // The CI-only helper compiles the full application CSS once, loads shipped fonts and captures two Chrome viewports.
 // Use the established source-capture budget, not a relaxed interaction timeout.
 it('captures the Group Rewards grid, complete Business Unit facets and localized company exclusions',async()=>{
  const view=await show();expect(screen.getByRole('heading',{name:'Review Plans',level:1})).toBeTruthy();
  expect(screen.getByRole('button',{name:'New reward year'})).toBeEnabled();expect(screen.getByRole('button',{name:'Create selected reviews'})).toBeDisabled();
  expect(screen.getByText('0 of 2 companies ready · 0 missing salary structure · 1 missing bonus matrix · 1 missing PAT')).toBeTruthy();
  expect(screen.getByRole('combobox',{name:'Business Unit'}).querySelectorAll('option')).toHaveLength(3);
  fireEvent.click(screen.getByText('Companies left out',{selector:'summary'}));expect(screen.getByText('Grouping record')).toBeVisible();
  expect(screen.queryByText('grouping',{exact:true})).toBeNull();await capture(view,'rewards-review-plans-gr');
 },120_000);

 it('uses keyboard selection, retains an invalid exclusion, reviews a corrected edit and renders the saved/job result',async()=>{
  const user=userEvent.setup(),view=await show();
  const select=screen.getByRole('checkbox',{name:'Select Alpha Fictional Sdn Bhd'});select.focus();expect(select).toHaveFocus();await user.keyboard('[Space]');expect(select).toBeChecked();
  await user.tab();const planType=screen.getByRole('combobox',{name:'Alpha Fictional Sdn Bhd: Plan type'});expect(planType).toHaveFocus();
  await user.selectOptions(planType,'no_awards');const reason=screen.getByRole('textbox',{name:'Alpha Fictional Sdn Bhd: Reason for no awards (at least 10 characters)'});await user.type(reason,'Short');
  const review=screen.getByRole('button',{name:'Review changes'});review.focus();await user.keyboard('[Enter]');
  expect(screen.getByRole('alert')).toHaveTextContent('Give every excluded company a reason');expect(reason).toHaveValue('Short');expect(reason).toHaveAttribute('aria-invalid','true');expect(reason).toHaveAccessibleDescription('Enter at least 10 characters to explain why this company has no awards.');expect(ports.preview).not.toHaveBeenCalled();
  await capture(view,'rewards-review-plans-invalid-exclusion');
  await user.selectOptions(planType,'uploaded');review.focus();await user.keyboard('[Enter]');
  const dialog=await screen.findByRole('dialog',{name:'Review before saving'});expect(within(dialog).getByText('Uploaded awards')).toBeTruthy();
  const reviewReason=within(dialog).getByRole('textbox',{name:'Reason for this change'});await user.type(reviewReason,'Approved annual company plan choice.');
  ports.save.mockResolvedValueOnce({ok:false,error:'Fictional source revision changed. Reload before saving.'});await user.click(within(dialog).getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(within(dialog).getByRole('alert')).toHaveTextContent('Fictional source revision changed'));
  expect(reviewReason).toHaveValue('Approved annual company plan choice.');await waitFor(()=>expect(within(dialog).getByRole('button',{name:'Refresh comparison'})).toBeEnabled());await capture(view,'rewards-review-plans-save-error');
  ports.refreshGrid.mockImplementation(async(input:any)=>({ok:true,review:{input:{...input,edits:input.edits.map((edit:any)=>({...edit,expectedRevision:5}))},summary:reviewSummary,digest:'c'.repeat(64)}}));
  await user.click(within(dialog).getByRole('button',{name:'Refresh comparison'}));await waitFor(()=>expect(ports.refreshGrid).toHaveBeenCalledTimes(1));expect(reviewReason).toHaveValue('Approved annual company plan choice.');
  await user.click(within(dialog).getByRole('button',{name:'Save changes'}));await screen.findByText('Review Plans saved.');expect(screen.queryByText('Fictional source revision changed. Reload before saving.')).toBeNull();
  expect(ports.save).toHaveBeenLastCalledWith(expect.objectContaining({year:2026,edits:[expect.objectContaining({companyId:alpha.companyId,planType:'uploaded',expectedRevision:5})]}),'c'.repeat(64),'Approved annual company plan choice.');
  const ready={...alpha,planType:'uploaded' as const,salarySuggestion:{...alpha.salarySuggestion,reviewed:true},bonusSuggestion:{...alpha.bonusSuggestion,reviewed:true},status:'ready' as const,revision:6};
  // The router refresh is represented by a new mocked owner projection; the native grid is not replaced by a sketch.
  view.rerender(await element(projection({rows:[ready,beta],coverage:{...projection().coverage,ready:1,unreviewed:1}})));
  expect(screen.getByText('Review Plans saved.')).toBeTruthy();await capture(view,'rewards-review-plans-saved');
  ports.create.mockResolvedValue({ok:true,jobId:id(50)});ports.progress.mockResolvedValue({ok:true,progress:{id:id(50),kind:'reward_plan_reviews',state:'completed',phase:'complete',sourceName:'Review Plans 2026',stepsTotal:1,stepsDone:1,counters:{created:1},error:null,errors:[],result:{created:1},cancelRequested:false,createdAt:'2026-11-17T10:00:00Z',updatedAt:'2026-11-17T10:00:01Z',finishedAt:'2026-11-17T10:00:01Z'}});
  await user.click(screen.getByRole('button',{name:'Create reviews for Ready companies'}));await screen.findByText('1 of 1 companies processed · Completed');
  expect(screen.queryByText('Review creation is running in the background. You can keep working.')).toBeNull();
  view.rerender(await element(projection({rows:[{...ready,status:'reviews-created',reviewUnitId:id(60)},beta],coverage:{...projection().coverage,reviewsCreated:1,unreviewed:1}})));
  expect(screen.getByText('Reviews created')).toBeTruthy();expect(screen.getByRole('link',{name:'Open review'})).toHaveAttribute('href','/rewards/'+id(60));
  expect(ports.create).toHaveBeenCalledExactlyOnceWith(2026,undefined);expect(ports.progress).toHaveBeenCalledExactlyOnceWith(id(50));
  await capture(view,'rewards-review-plans-job-completed');
 },120_000);

 it('captures EC read-only presentation without edit, year creation or review creation controls',async()=>{
  const view=await show(projection({rows:[{...alpha,canEdit:false},{...beta,canEdit:false}],canCreateYear:false,canEdit:false,canCreateReviews:false}));
  expect(screen.queryByRole('button',{name:'New reward year'})).toBeNull();expect(screen.queryByRole('button',{name:'Review changes'})).toBeNull();expect(screen.queryByRole('button',{name:'Create selected reviews'})).toBeNull();
  expect(screen.getByRole('combobox',{name:'Alpha Fictional Sdn Bhd: Salary structure'})).toBeDisabled();expect(screen.getAllByText('View only')).toHaveLength(2);
  await capture(view,'rewards-review-plans-ec-read-only');
 },120_000);

 it('captures company-scoped HR with only its projected company editable and group actions hidden',async()=>{
  const scoped=projection({rows:[alpha],businessUnits:[{id:bu1,name:'Consumer'}],excludedCompanies:[],canCreateYear:false,canEdit:true,canCreateReviews:false,coverage:{total:1,ready:0,missingSalary:0,missingBonus:0,missingPat:0,unreviewed:1,reviewsCreated:0}});
  const view=await show(scoped);expect(screen.queryByText(beta.company)).toBeNull();expect(screen.getByRole('combobox',{name:'Alpha Fictional Sdn Bhd: Salary structure'})).toBeEnabled();
  expect(screen.queryByRole('button',{name:'New reward year'})).toBeNull();expect(screen.queryByRole('button',{name:'Create reviews for Ready companies'})).toBeNull();
  await capture(view,'rewards-review-plans-scoped-hr');
 },120_000);

 it('renders the no-year state and actual New reward year form, retains a date on error and submits the reviewed dates',async()=>{
  const user=userEvent.setup(),data=projection({yearSettings:null,rows:[],years:[2026],suggestedYearSettings:{...settings,effectiveFrom:'2027-04-01',joinedBefore:'2026-12-31',confirmedBy:'2027-03-31',activeAsOf:'2027-04-01',blockedFrom:'2026-10-01',blockedTo:'2027-03-31',snapshotDate:'2026-11-17'}});
  const view=await show(data,{year:'2027'});expect(screen.getByText('No reward year has been created for 2027.')).toBeTruthy();await capture(view,'rewards-review-plans-no-year');
  const newYear=screen.getByRole('button',{name:'New reward year'});newYear.focus();await user.keyboard('[Enter]');
  const effective=screen.getByLabelText('Salary effective date');fireEvent.change(effective,{target:{value:'2027-05-01'}});expect(effective).toHaveValue('2027-05-01');
  ports.previewYear.mockResolvedValueOnce({ok:false,error:'Fictional reward-year population changed. Review the dates again.'});await user.click(screen.getByRole('button',{name:'Review new reward year'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Fictional reward-year population changed');expect(effective).toHaveValue('2027-05-01');await capture(view,'rewards-review-plans-new-year-error');
  ports.previewYear.mockResolvedValueOnce({ok:true,review:{summary:{...reviewSummary,itemLabel:'Review Plans 2027'},digest:'b'.repeat(64),companyCount:2}});await user.click(screen.getByRole('button',{name:'Review new reward year'}));
  const dialog=await screen.findByRole('dialog',{name:'Review before saving'});await user.type(within(dialog).getByRole('textbox',{name:'Reason for this change'}),'Prepared the new annual reward year.');await user.click(within(dialog).getByRole('button',{name:'Create reward year and draft plans'}));
  await waitFor(()=>expect(ports.push).toHaveBeenCalledWith('/admin/rewards/review-plans?year=2027'));
  expect(ports.createYear).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({year:2027,settings:expect.objectContaining({effectiveFrom:'2027-05-01',snapshotDate:'2026-11-17'})}),'b'.repeat(64),'Prepared the new annual reward year.');
 },120_000);
});
