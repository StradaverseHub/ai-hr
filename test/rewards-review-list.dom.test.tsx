// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {RewardReviewList} from '../app/(app)/rewards/review-list';
import {filterRewardReviews,rewardReviewUpcoming} from '../packs/rewards/review-list-model';
import type {RewardReviewListRow} from '../packs/rewards/service';
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
const base={id:'r1',cycleId:'cycle',cycle:'Fictional 2026 cycle',year:2026,kind:'annual',companyId:'co',company:'Fictional Trading',businessUnitId:'bu',unit:'Retail',status:'draft',returnedTo:null,roles:['bu'],seat:'bu',holders:['Fictional Reviewer'],due:'2026-10-27',daysUntilDue:-2,waiting:true,salary:{poolShareBp:7623},bonus:{budgetShareBp:5050},blocking:2,exceptions:1,laterSeats:[]} as unknown as RewardReviewListRow;
const second={...base,id:'r2',companyId:'co2',company:'Fictional Industries',businessUnitId:'bu2',unit:'Wholesale',status:'bg',roles:['ec'],seat:'bg',waiting:false,laterSeats:['ec']} as RewardReviewListRow;
const show=(rows:RewardReviewListRow[],filters={},emptyReason:null|'noScope'|'noCycle'|'noRole'|'otherScope'=null,canConfigure=false)=>render(<NextIntlClientProvider locale="en" messages={en}><RewardReviewList rows={rows} filters={filters} emptyReason={emptyReason} canConfigure={canConfigure} year={2026}/></NextIntlClientProvider>);
afterEach(cleanup);
describe('Rewards review overview',()=>{
 it('renders role, holder, overdue date, exact one-decimal percentages and blocks without company totals',()=>{
  show([base,second]);const row=screen.getAllByRole('row')[1];
  for(const text of ['Fictional Reviewer','76.2%','50.5%','2 blocks','1 exception'])expect(within(row).getByText(text)).toBeTruthy();
  expect(within(row).getByText('2 days overdue').className).toContain('text-destructive');
  expect(screen.getByRole('link',{name:'Waiting for my action: 1'}).getAttribute('href')).toBe('/rewards?waiting=1');
  expect(screen.getByText(/1 review is in progress.*Executive Chairman/)).toBeTruthy();
 });
 it('keeps the walkthrough anchor on the rendered review table and empty state',()=>{
  const populated=show([base]);
  const tableAnchor=populated.container.querySelector('[data-tour="rewards-review-units"]');
  expect(tableAnchor).not.toBeNull();
  expect(within(tableAnchor as HTMLElement).getByRole('table')).toBeTruthy();
  expect(within(tableAnchor as HTMLElement).getByRole('link',{name:'Open review'}).getAttribute('href')).toBe('/rewards/r1');
  populated.unmount();
  const empty=show([],{},'noRole');
  const emptyAnchor=empty.container.querySelector('[data-tour="rewards-review-units"]');
  expect(emptyAnchor).not.toBeNull();
  expect(within(emptyAnchor as HTMLElement).getByText(en.rewards.reviewList.empty.noRole)).toBeTruthy();
 });
 it('narrows by every URL filter and preserves filter choices',()=>{
  for(const filters of [{cycle:'cycle',company:'co',unit:'bu',stage:'draft',waiting:'1'}])expect(filterRewardReviews([base,second],filters).map(row=>row.id)).toEqual(['r1']);
  show([base,second],{company:'co2'});expect(screen.getAllByRole('row')).toHaveLength(2);expect(within(screen.getAllByRole('row')[1]).getByText('Wholesale')).toBeTruthy();
  expect(screen.getByRole<HTMLSelectElement>('combobox',{name:'Company'}).value).toBe('co2');
  expect(rewardReviewUpcoming([second,{...second,id:'r3',laterSeats:['ec','ec']}])).toEqual([{seat:'ec',count:2}]);
 });
 it('shows a truthful filter miss and never substitutes no-role for it',()=>{show([base],{unit:'missing'});expect(screen.getByText(en.rewards.reviewList.noMatches)).toBeTruthy();expect(screen.queryByText(en.rewards.reviewList.empty.noRole)).toBeNull();});
 it.each(['noScope','noCycle','noRole','otherScope'] as const)('explains %s without disclosing inaccessible cycle names',reason=>{
  show([],{},reason,reason==='noCycle');const words=en.rewards.reviewList.empty[reason].replace('{year}','2026');expect(screen.getByText(words)).toBeTruthy();
  expect(screen.queryByText(base.cycle)).toBeNull();expect(screen.queryByRole('link',{name:'Create unit review'})!==null).toBe(reason==='noCycle');
 });
 it('marks an administrator without a seat as unavailable, and never formats null as zero',()=>{
  show([{...base,roles:[],salary:null,bonus:null,blocking:null,exceptions:null,waiting:false}]);expect(screen.getAllByText(en.rewards.reviewList.unavailable)).toHaveLength(4);expect(screen.queryByText('0.0%')).toBeNull();
 });
});
