// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';import ms from '../messages/ms.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';import zh from '../messages/zh.json';
import type {RewardReviewPlans,RewardReviewPlanRow} from '../packs/rewards/review-plans-model';
const actions=vi.hoisted(()=>({preview:vi.fn(),save:vi.fn(),copy:vi.fn(),create:vi.fn(),progress:vi.fn(),accept:vi.fn(),refreshGrid:vi.fn()}));
const router=vi.hoisted(()=>({refresh:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>router}));
vi.mock('../app/admin/rewards/review-plans/actions',()=>({previewGridAction:actions.preview,saveGridAction:actions.save,previousChoicesAction:actions.copy,createReviewsAction:actions.create,reviewJobAction:actions.progress,acceptSuggestionsAction:actions.accept,refreshGridAction:actions.refreshGrid}));
import {ReviewPlanGrid} from '../app/admin/rewards/review-plans/editor';
const salary='10000000-0000-4000-8000-000000000001',bonus='10000000-0000-4000-8000-000000000002';
const row:RewardReviewPlanRow={companyId:'20000000-0000-4000-8000-000000000001',company:'Alpha Fictional',businessUnitId:'30000000-0000-4000-8000-000000000001',businessUnit:'Consumer',revision:4,planVersionId:null,planType:'standard',reason:'',salaryVersionId:salary,bonusVersionId:bonus,salarySuggestion:{versionId:salary,source:'previous-year',reviewed:false},bonusSuggestion:{versionId:bonus,source:'group-default',reviewed:false},headcount:125,patEntered:true,status:'draft',canEdit:true,reviewUnitId:null,branchAcknowledged:false};
const data:RewardReviewPlans={years:[2026],yearSettings:null,suggestedYearSettings:{effectiveFrom:'2026-04-01',joinedBefore:'2025-12-31',confirmedBy:'2026-03-31',activeAsOf:'2026-04-01',blockedFrom:'2025-10-01',blockedTo:'2026-03-31',snapshotDate:'2026-03-31'},rows:[row,{...row,companyId:'20000000-0000-4000-8000-000000000002',company:'Beta Fictional',canEdit:false}],coverage:{total:2,ready:0,missingSalary:0,missingBonus:0,missingPat:0,unreviewed:2,reviewsCreated:0},libraries:[{id:salary,libraryId:salary,kind:'salary',name:'Salary 2026',version:1,bonusType:null},{id:bonus,libraryId:bonus,kind:'bonus',name:'Bonus 2026',version:1,bonusType:'standard'}],canCreateYear:true,canEdit:true,canCreateReviews:true,page:1,hasMore:false,excludedCompanies:[],businessUnits:[],classificationCompanies:[],classifications:[],canClassify:false};
const copies={en,ms,ta,th,vi:viCopy,zh};
function show(value=data,locale:keyof typeof copies='en'){return render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><ReviewPlanGrid year={2026} data={value}/></NextIntlClientProvider>);}
beforeEach(()=>{actions.accept.mockResolvedValue({ok:true,edits:[{companyId:row.companyId,expectedRevision:4,planType:'standard',reason:'',salaryVersionId:salary,bonusVersionId:bonus,salaryReviewed:true,bonusReviewed:true,branchAcknowledged:false}]});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('Review Plans grid',()=>{
 it('stages accepted suggestions only for editable rows and preserves the expected revision',async()=>{
  actions.preview.mockResolvedValue({ok:true,review:{summary:{area:'plan',itemLabel:'Review Plans 2026',lines:[],changedCount:1,affected:[],highImpact:[]},digest:'a'.repeat(64)}});
  show();
  expect(screen.getAllByText('Same as 2025')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'Accept all suggestions'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Review changes'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Review changes'}));
  await waitFor(()=>expect(actions.preview).toHaveBeenCalledTimes(1));
  expect(actions.preview).toHaveBeenCalledWith({year:2026,edits:[expect.objectContaining({companyId:row.companyId,expectedRevision:4,salaryReviewed:true,bonusReviewed:true})]});
  expect(screen.getByRole('checkbox',{name:'Select Beta Fictional'})).toBeDisabled();
 });
 it('requires a no-awards reason before asking the server to save',()=>{
  show();fireEvent.change(screen.getByRole('combobox',{name:'Alpha Fictional: Plan type'}),{target:{value:'no_awards'}});
  fireEvent.click(screen.getByRole('button',{name:'Review changes'}));
  const reason=screen.getByRole('textbox',{name:'Alpha Fictional: Reason for no awards (at least 10 characters)'});expect(reason).toHaveAttribute('aria-invalid','true');expect(reason).toHaveAccessibleDescription('Enter at least 10 characters to explain why this company has no awards.');
  expect(screen.getByRole('alert').textContent).toContain('Give every excluded company a reason');expect(actions.preview).not.toHaveBeenCalled();
 });
 it('applies a bulk choice only to the selected editable company',async()=>{
  actions.preview.mockResolvedValue({ok:false,error:'Current choices changed. Reload.'});show();
  fireEvent.click(screen.getByRole('checkbox',{name:'Select Alpha Fictional'}));
  fireEvent.change(screen.getByRole('combobox',{name:'Plan type'}),{target:{value:'uploaded'}});
  fireEvent.click(screen.getByRole('button',{name:'Apply plan type'}));fireEvent.click(screen.getByRole('button',{name:'Review changes'}));
  await waitFor(()=>expect(actions.preview).toHaveBeenCalledTimes(1));expect(actions.preview.mock.calls[0][0].edits).toEqual([expect.objectContaining({companyId:row.companyId,planType:'uploaded'})]);
  expect(screen.getByRole('alert').textContent).toBe('Current choices changed. Reload.');
 });
 it('sends exactly the reviewed payload, digest and reason and clears staged changes after success',async()=>{
  actions.preview.mockResolvedValue({ok:true,review:{summary:{area:'plan',itemLabel:'Review Plans 2026',lines:[],changedCount:1,affected:[],highImpact:[]},digest:'b'.repeat(64)}});actions.save.mockResolvedValue({ok:true});show();
  fireEvent.click(screen.getByRole('button',{name:'Accept all suggestions'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Review changes'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Review changes'}));
  const reason=await screen.findByRole('textbox',{name:'Reason for this change'});fireEvent.change(reason,{target:{value:'Checked the annual library choices.'}});fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(actions.save).toHaveBeenCalledWith(actions.preview.mock.calls[0][0],'b'.repeat(64),'Checked the annual library choices.'));
  await waitFor(()=>expect(screen.getByText('Review Plans saved.')).toBeTruthy());expect(screen.getByRole('button',{name:'Review changes'})).toBeDisabled();
 });
 it('recovers from a rejected progress read without enqueueing the review creation twice',async()=>{
  actions.create.mockResolvedValue({ok:true,jobId:'40000000-0000-4000-8000-000000000001'});actions.progress.mockRejectedValueOnce(new Error('Fictional transport interruption'));
  show({...data,coverage:{...data.coverage,ready:1}});fireEvent.click(screen.getByRole('button',{name:'Create reviews for Ready companies'}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('Progress could not be read. Retrying the status check'));
  expect(actions.create).toHaveBeenCalledTimes(1);expect(actions.progress).toHaveBeenCalledTimes(1);
 });
 it('shows no write or creation actions for a view-only reader',()=>{
  show({...data,canEdit:false,canCreateReviews:false,rows:[{...row,canEdit:false}]});expect(screen.queryByRole('button',{name:'Review changes'})).toBeNull();expect(screen.queryByRole('button',{name:'Create selected reviews'})).toBeNull();expect(screen.getByText('View only. You can inspect these plans, but your current access does not allow changes.')).toBeTruthy();expect(screen.getByRole('combobox',{name:'Alpha Fictional: Salary structure'})).toBeDisabled();
 });
 for(const locale of Object.keys(copies) as (keyof typeof copies)[])it('renders all new grid copy in '+locale,()=>{show(data,locale);expect(screen.getByText('Alpha Fictional')).toBeTruthy();});
});
