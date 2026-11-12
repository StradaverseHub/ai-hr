// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
// 70d5e7c5 — Configuration › Review Set-up list.
const ports=vi.hoisted(()=>({list:vi.fn()}));
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'nav'})}));
vi.mock('../lib/authz',()=>({requireModule:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:async()=>({tenantId:'t',userId:'fictional'})}));
vi.mock('../packs/rewards/service',()=>({rewardReviewSetupList:ports.list}));
import ReviewSetupList from '../app/admin/rewards/review-setup/page';
const show=async(searchParams:Record<string,string>={})=>render(<NextIntlClientProvider locale="en" messages={en}>{await ReviewSetupList({searchParams:Promise.resolve(searchParams)})}</NextIntlClientProvider>);
afterEach(()=>{cleanup();vi.clearAllMocks();});
const cycle='11111111-1111-4111-8111-111111111111';
describe('Review Set-up list (70d5e7c5)',()=>{
 it('says "You don\'t have access" to seats outside Group Rewards, CTRO and EC',async()=>{
  ports.list.mockResolvedValue({allowed:false});await show();
  expect(screen.getByRole('status').textContent).toBe(en.rewardsPreparation.list.noAccess);
  expect(screen.queryByRole('table')).toBeNull();
 });
 it('lists one row per unit review with progress, status, expected date and last updater, and passes valid filters only',async()=>{
  ports.list.mockResolvedValue({allowed:true,editor:true,total:2,page:0,pageSize:50,cycles:[{id:cycle,name:'2026 Annual Compensation Review'}],units:[],rows:[
   {unitId:'u1',company:'Fictional Company',unit:'Retail',cycle:'2026 Annual Compensation Review',snapshotDate:'2026-10-29',stepsDone:4,status:'preparing',legacy:false,expectedRelease:'2026-11-30',lastUpdatedBy:'Fictional Doer',lastUpdatedAt:'2026-11-01T00:00:00Z',windowOutsideYear:true},
   {unitId:'u2',company:'Fictional Company',unit:'Treasury',cycle:'2025 Annual Compensation Review',snapshotDate:'2025-10-29',stepsDone:6,status:'released',legacy:true,expectedRelease:null,lastUpdatedBy:null,lastUpdatedAt:null,windowOutsideYear:false}]});
  await show({cycle,status:'preparing',unit:'not-a-uuid',page:'-3'});
  expect(ports.list).toHaveBeenCalledWith(expect.anything(),{cycle,status:'preparing',page:0});
  const rows=screen.getAllByRole('row').slice(1);
  const first=within(rows[0]);
  expect(first.getByRole('link',{name:'Retail'}).getAttribute('href')).toBe('/admin/rewards/review-setup/u1');
  for(const text of ['4 of 6 steps done','Preparing','2026-11-30','Fictional Doer',en.rewardsPreparation.window.outsideShort])expect(first.getByText(text)).toBeTruthy();
  const second=within(rows[1]);
  expect(second.getByText(en.rewardsPreparation.list.beforeTracking)).toBeTruthy();expect(second.getByText('Released')).toBeTruthy();
 });
});
