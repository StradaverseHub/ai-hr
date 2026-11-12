// @vitest-environment jsdom
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,cleanup,fireEvent,act,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const copies={en,ms,zh,ta,th,vi:viCopy};
import {RewardsDashboard} from '../app/rewards/dashboard';
import {aggregateRewardDashboardFigures} from '../packs/rewards/dashboard-model';
import type {RewardDashboard} from '../packs/rewards/service';
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
const save=vi.hoisted(()=>vi.fn());
vi.mock('../app/rewards/dashboard-actions',()=>({saveDashboardAction:save}));

const BU='11111111-1111-4111-8111-111111111111',C1='aaaaaaaa-0000-4000-8000-000000000001',C2='aaaaaaaa-0000-4000-8000-000000000002',C3='aaaaaaaa-0000-4000-8000-000000000003';
const plan=(used:number[],pools:number[],bonusUsedCents:number,bonusPoolCents:number)=>({used,pools,bonusUsedCents,bonusPoolCents});
const figures=aggregateRewardDashboardFigures([
 {company:'Fictional Alpha',budgets:{standard:plan([10000,2000,3000],[50000,10000,10000],130000,200000),h:plan([0,0,0],[0,0,0],0,0)}},
 {company:'Fictional Beta',budgets:{standard:plan([30000,0,0],[20000,0,0],0,0),h:plan([0,0,0],[0,0,0],0,0)}},
]);
const value={kind:'annual',year:2026,choice:{version:2,kind:'annual',period:'monthly',businessUnit:BU,companies:[]},canSelectAll:false,
 businessUnits:[{id:BU,label:'CHCE'}],
 companies:[{id:C1,label:'Fictional Alpha',headcount:12,blocked:false,preparing:false},{id:C2,label:'Fictional Beta',headcount:1,blocked:true,preparing:false},{id:C3,label:'Fictional Gamma',headcount:null,blocked:false,preparing:true}],
 context:{businessUnit:'CHCE',companies:2,cycle:'2026 Annual Compensation Review',cycleVaries:false,snapshot:'2026-11-04',snapshotVaries:false},
 figures,excluded:[],preparing:[{unitId:'pending',company:'Fictional Gamma',expectedRelease:'2026-11-30'}],
 waiting:[{id:'w1',company:'Fictional Alpha',name:'CHCE',due:'2026-12-01',daysUntilDue:19,blocking:1,exceptions:0}],roles:['bu'],emptyReason:null} as unknown as RewardDashboard;
const show=(v:RewardDashboard)=>render(<NextIntlClientProvider locale="en" messages={en}><RewardsDashboard value={v}/></NextIntlClientProvider>);
const d=en.rewardDashboard;
beforeEach(()=>{save.mockReset();save.mockResolvedValue(undefined);});
afterEach(cleanup);

describe('Reviewing Team Rewards dashboard',()=>{
 it('shows one context line and combined bars without names, cycle lines, set-up notes or box Open buttons (81a7b286, 4de410ed)',()=>{
  const view=show(value);
  expect(screen.getByTestId('reward-dashboard-context').textContent).toBe('Showing: CHCE · 2 companies · 2026 Annual Compensation Review · Snapshot 4 Nov 2026');
  const [salary,bonus]=screen.getAllByRole('heading',{level:2}).filter(h=>[d.salary,d.bonus].includes(h.textContent!)).map(h=>h.closest('div.min-w-0') as HTMLElement);
  for(const box of [salary,bonus]){
   expect(within(box).queryByRole('link')).toBeNull();
   expect(within(box).queryByText(/Fictional Alpha ·|2026 Annual Compensation Review|Snapshot/)).toBeNull();
  }
  // Standard merit 400.00 / 700.00 combined; Beta is over its own merit pool even though the total is within.
  expect(within(salary).getByText('MYR 400.00 / MYR 700.00 · 57.1%')).toBeTruthy();
  expect(within(salary).getByText('MYR 300.00 left')).toBeTruthy();
  expect(within(salary).getByText('Over its own pool: Fictional Beta')).toBeTruthy();
  expect(within(salary).getAllByRole('meter')).toHaveLength(6);
  expect(within(bonus).getByText('MYR 1,300.00 / MYR 2,000.00 · 65.0%')).toBeTruthy();
  expect(within(bonus).getAllByRole('meter')).toHaveLength(2);
  expect(view.container.textContent).not.toMatch(/Review missing budget inputs|One-off award|not annualized|Not set/);
  expect(screen.queryByRole('button',{name:en.rewards.reviewList.apply})).toBeNull();
 });
 it('keeps the Open links in Waiting on you',()=>{
  show(value);
  const box=screen.getByRole('heading',{name:'Waiting on you · 1'}).closest('div.min-w-0') as HTMLElement;
  expect(within(box).getByRole('link',{name:d.open})).toHaveAttribute('href','/rewards/approvals');
  expect(within(box).getByRole('link',{name:'Fictional Alpha · CHCE'})).toHaveAttribute('href','/rewards/w1');
 });
 it('annualizes salary only, preserves zero pools and leaves bonus a one-off award',()=>{
  show({...value,choice:{...value.choice,period:'annual'}});
  expect(screen.getByText('MYR 4,800.00 / MYR 8,400.00 · 57.1%')).toBeTruthy();
  expect(screen.getByText('MYR 1,300.00 / MYR 2,000.00 · 65.0%')).toBeTruthy();
  expect(screen.getAllByText('MYR 0.00 / MYR 0.00 · —').length).toBe(4);
 });
 it('shows a fixed Business unit for a single-unit reviewer and company pills with headcount and an accessible blocker dot',()=>{
  show(value);
  expect(screen.queryByRole('combobox')).toBeNull();expect(screen.getByText('CHCE',{selector:'span.font-medium'})).toBeTruthy();
  const pills=within(screen.getByRole('group',{name:d.companies})).getAllByRole('button');
  expect(pills.map(p=>[p.textContent,p.getAttribute('aria-pressed')])).toEqual([[d.allCompanies,'true'],['Fictional Alpha12 people','false'],['Fictional Beta1 person','false'],['Fictional GammaBeing prepared','false']]);
  expect(within(pills[2]).getByRole('img',{name:d.hasBlockers})).toBeTruthy();expect(within(pills[1]).queryByRole('img')).toBeNull();
 });
 it('offers All business units only to Group Rewards, CTRO and EC, and clears companies when the unit changes',async()=>{
  show({...value,canSelectAll:true,businessUnits:[...value.businessUnits,{id:'22222222-2222-4222-8222-222222222222',label:'Second unit'}],choice:{...value.choice,companies:[C1]}});
  const select=screen.getByRole('combobox',{name:en.rewards.unit}) as HTMLSelectElement;
  expect([...select.options].map(o=>o.textContent)).toEqual([d.allBusinessUnits,'CHCE','Second unit']);
  await act(async()=>{fireEvent.change(select,{target:{value:'all'}});});
  expect(save).toHaveBeenCalledWith({period:'monthly',businessUnit:'all',companies:[]});
 });
 it('applies pill and salary display changes immediately and saves them in the order they were made',async()=>{
  let release!:()=>void;save.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  show(value);
  const group=screen.getByRole('group',{name:d.companies});
  await act(async()=>{fireEvent.click(within(group).getByRole('button',{name:/Fictional Alpha/}));});
  await act(async()=>{fireEvent.click(within(group).getByRole('button',{name:/Fictional Beta/}));});
  // The second change waits for the first save; the pills already show both choices.
  expect(save).toHaveBeenCalledTimes(1);expect(save).toHaveBeenNthCalledWith(1,{period:'monthly',businessUnit:BU,companies:[C1]});
  expect(within(group).getByRole('button',{name:/Fictional Beta/})).toHaveAttribute('aria-pressed','true');
  await act(async()=>{release();});
  expect(save).toHaveBeenCalledTimes(2);expect(save).toHaveBeenNthCalledWith(2,{period:'monthly',businessUnit:BU,companies:[C1,C2]});
  await act(async()=>{fireEvent.click(within(screen.getByRole('group',{name:d.salaryPeriod})).getByRole('button',{name:d.annual}));});
  expect(save).toHaveBeenNthCalledWith(3,{period:'annual',businessUnit:BU,companies:[C1,C2]});
  await act(async()=>{fireEvent.click(within(group).getByRole('button',{name:d.allCompanies}));});
  expect(save).toHaveBeenNthCalledWith(4,{period:'annual',businessUnit:BU,companies:[]});
 });
 it('reports a failed save without discarding the visible choice',async()=>{
  save.mockRejectedValueOnce(new Error('offline'));show(value);
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/Fictional Alpha/}));});
  expect(screen.getByRole('alert').textContent).toBe(d.saveFailed);
 });
 it('names companies withheld for restricted records and shows no redacted figures',()=>{
  show({...value,figures:null,context:{...value.context!,companies:1},excluded:[{company:'Fictional Alpha',reason:'restricted'}],preparing:[]});
  expect(screen.getByText(/restricted records: Fictional Alpha/)).toBeTruthy();expect(screen.queryByRole('meter')).toBeNull();expect(screen.queryByText(/MYR 100.00/)).toBeNull();
  expect(screen.queryByRole('group',{name:d.salaryPeriod})).toBeNull();
 });
});

it.each(Object.keys(copies) as (keyof typeof copies)[])('renders the dashboard in %s at desktop and phone sizes',async locale=>{
 const view=render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><main className="space-y-5 p-5"><h1 className="text-2xl font-semibold">{copies[locale].rewardDashboard.greeting}</h1><RewardsDashboard value={value}/></main></NextIntlClientProvider>);
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'rewards-dashboard');
},60000);

it('shows the year-specific preparing message without any budget or action figures before release (4de410ed)',async()=>{
 const pending={...value,companies:[value.companies[2]],context:null,figures:null,waiting:[],roles:[],preparing:[{unitId:'pending',company:'Fictional Gamma',expectedRelease:'2026-11-30'}]} as RewardDashboard;
 const view=show(pending);
 expect(screen.getAllByText('Your 2026 review is being prepared by Group Rewards.').length).toBeGreaterThan(0);
 expect(screen.getByRole('status').textContent).toBe('Your 2026 review is being prepared by Group Rewards.');
 expect(screen.getByRole('link',{name:'Fictional Gamma'})).toHaveAttribute('href','/rewards/pending');
 expect(screen.getByText('Expected release: 30 Nov 2026')).toBeTruthy();
 expect(screen.queryByRole('meter')).toBeNull();expect(screen.queryByTestId('reward-dashboard-context')).toBeNull();
 expect(view.container.textContent).not.toMatch(/MYR|people/);
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-preparing-notice');
},60000);
