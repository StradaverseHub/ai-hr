// @vitest-environment jsdom
import {afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viCopy from '../messages/vi.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const copies={en,ms,zh,ta,th,vi:viCopy};
import {RewardsDashboard} from '../app/rewards/dashboard';
import type {RewardDashboard} from '../packs/rewards/service';
vi.mock('next/link',()=>({default:({children,...props}:any)=><a {...props}>{children}</a>}));
vi.mock('../app/rewards/dashboard-actions',()=>({saveDashboardAction:vi.fn()}));
const budget={used:[10000,2000,3000],pools:[50000,10000,10000],bonusUsedCents:130000,lumpCents:10000,bonusPoolCents:200000};
const unit={id:'a',companyId:'co',company:'Fictional Company',name:'Fictional unit',cycle:'Fictional cycle',snapshotDate:'2026-01-01',roles:['bu'],budgets:{standard:budget,h:{...budget,used:[0,0,0],pools:[0,0,0]}},restricted:false,uploaded:false,poolStatus:'final',waiting:false,action:null,due:null,daysUntilDue:null,blocking:0,exceptions:0,setupVisible:false};
const value={choice:{period:'monthly',scope:'a'},canSelectAll:false,scopes:[{id:'a',label:'Fictional unit'}],units:[unit],waiting:[],emptyReason:null,year:2026} as unknown as RewardDashboard;
const show=(v:RewardDashboard)=>render(<NextIntlClientProvider locale="en" messages={en}><RewardsDashboard value={v}/></NextIntlClientProvider>);
afterEach(cleanup);
describe('short Rewards dashboard',()=>{
 it('shows three tiles, recurring salary and one-off bonus without a personal table',()=>{
  show(value);expect(screen.getAllByRole('heading',{level:2})).toHaveLength(3);
  expect(screen.getAllByText(/100.00.*500.00/)).toHaveLength(1);expect(screen.getAllByText(/1,300.00.*2,000.00/)).toHaveLength(2);
  expect(screen.queryByText(/1,400.00/)).toBeNull();expect(screen.queryByRole('table')).toBeNull();expect(screen.queryByRole('option',{name:en.rewardDashboard.allAssigned})).toBeNull();
 });
 it('annualizes salary only and preserves zero pools',()=>{
  show({...value,choice:{period:'annual',scope:'a'}});expect(screen.getByText(/1,200.00.*6,000.00/)).toBeTruthy();expect(screen.getAllByText(/1,300.00.*2,000.00/)).toHaveLength(2);expect(screen.getAllByText(/0.00.*0.00/).length).toBeGreaterThan(0);
 });
 it('shows a confidentiality explanation without balances, bars or redacted zero figures',()=>{
  show({...value,units:[{...value.units[0],restricted:true,budgets:null}]});expect(screen.getAllByText(en.rewardDashboard.restricted)).toHaveLength(2);expect(screen.queryByRole('meter')).toBeNull();expect(screen.queryByText(/100.00/)).toBeNull();
 });
});

it.each(Object.keys(copies) as (keyof typeof copies)[])('renders short dashboard in %s at desktop and phone sizes',async locale=>{
 const view=render(<NextIntlClientProvider locale={locale} messages={copies[locale]} onError={error=>{throw error;}}><main className="space-y-5 p-5"><h1 className="text-2xl font-semibold">{copies[locale].rewardDashboard.greeting}</h1><RewardsDashboard value={value}/></main></NextIntlClientProvider>);
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),locale,'rewards-dashboard');
},60000);

it('keeps a preparing review discoverable without any budget or action figures',async()=>{
 const pending={...value,scopes:[],units:[],waiting:[],notices:[{unitId:'pending',companyId:'co',company:'Fictional Company',unit:'Pending Unit',cycle:'Fictional cycle',expectedRelease:'2026-11-30'}]};
 const view=show(pending);expect(screen.getByText(en.rewardsPreparation.preparing)).toBeTruthy();expect(screen.getByRole('link',{name:en.rewards.openReview})).toHaveAttribute('href','/rewards/pending');expect(screen.queryByRole('meter')).toBeNull();
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','rewards-preparing-notice');
},60000);
