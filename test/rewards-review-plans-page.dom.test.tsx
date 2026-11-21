// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import en from '../messages/en.json';
const read=vi.hoisted(()=>vi.fn());
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key.split('.').reduce((value:any,part)=>value[part],en.rewardsReviewPlans))}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('not found');}}));
vi.mock('../lib/authz',()=>({requireModule:async()=>({tenantId:'tenant',userId:'user'})}));
vi.mock('../packs/rewards/review-plans',()=>({rewardReviewPlans:read}));
vi.mock('../app/admin/rewards/review-plans/new-year',()=>({NewRewardYear:()=>null}));
vi.mock('../app/admin/rewards/review-plans/actions',()=>({classifyCompanyAction:vi.fn()}));
vi.mock('../app/admin/rewards/review-plans/editor',()=>({ReviewPlanGrid:()=>null}));
import ReviewPlansPage from '../app/admin/rewards/review-plans/page';
const settings={effectiveFrom:'2026-04-01',joinedBefore:'2025-12-31',confirmedBy:'2026-03-31',activeAsOf:'2026-04-01',blockedFrom:'2025-10-01',blockedTo:'2026-03-31',snapshotDate:'2026-03-31'};
afterEach(()=>{cleanup();vi.clearAllMocks();});
describe('Review Plans page facets',()=>{
 for(const page of [1,2])it('keeps every authorized Business Unit available on filtered page '+page,async()=>{
  // The current filtered page represents only one unit. The reader's authorized facet population includes both.
  read.mockResolvedValue({years:[2026],yearSettings:settings,suggestedYearSettings:settings,canCreateYear:false,canEdit:false,canCreateReviews:false,rows:[{businessUnitId:'unit-a',businessUnit:'Consumer'}],businessUnits:[{id:'unit-a',name:'Consumer'},{id:'unit-b',name:'Services'}],excludedCompanies:[],page,hasMore:page===1});
  render(await ReviewPlansPage({searchParams:Promise.resolve({year:'2026',businessUnitId:'unit-a',page:String(page)})}));
  const units=screen.getByRole('combobox',{name:'Business Unit'});
  expect(Array.from((units as HTMLSelectElement).options).map(option=>option.text)).toEqual(['All Business Units','Consumer','Services']);
  expect(units).toHaveValue('unit-a');
  expect(read).toHaveBeenCalledWith(expect.anything(),{year:2026,filters:{businessUnitId:'unit-a'},page});
 });
});
