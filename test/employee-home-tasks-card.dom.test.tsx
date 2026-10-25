import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vietnamese from '../messages/vi.json';
import {HomeTasksCard} from '../components/employee-home/tasks-card';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTasks} from '../lib/employee-home-tasks';
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
const employmentId='e17dbd09-a9a1-448c-b609-fcd74566baf6',asOf=todayInKualaLumpur();
const value:EmployeeHomeTasks={version:1,employmentId,grain:'account',asOf,total:2,overdue:0,effortMinutes:4,unestimated:1,page:1,pages:1,pageSize:12,
 items:[{id:'notice:employment:1',kind:'noticeAcknowledgement',subjectName:'Fictional required notice',createdAt:new Date().toISOString(),linkPath:'/notices/one?employmentId='+employmentId,overdue:false},
  {id:'feedback',kind:'feedback',subjectName:'Fictional assigned feedback',createdAt:new Date().toISOString(),linkPath:'/me/performance#feedback-one',overdue:false}]};
const catalogues={en,ms,zh,ta,th,vi:vietnamese};
let fetcher=vi.fn();
beforeEach(()=>{fetcher=vi.fn().mockImplementation(async()=>Response.json(value));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const mount=(locale:keyof typeof catalogues='en')=>render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><HomeTasksCard employmentId={employmentId}/></NextIntlClientProvider>);
describe('Home Waiting for You independent delivery',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders assigned actions and keeps missing deadlines unknown',async locale=>{
  mount(locale);const labels=catalogues[locale].employeeHome.tasks;
  await screen.findByText('Fictional required notice');
  expect(screen.getByRole('heading',{name:labels.title})).toBeVisible();
  expect(screen.getByRole('link',{name:labels.acknowledge})).toHaveAttribute('href',value.items[0].linkPath);
  expect(screen.getByRole('link',{name:labels.feedback})).toHaveAttribute('href',value.items[1].linkPath);
  expect(screen.getAllByRole('link')).toHaveLength(2);
  expect(screen.queryByText(/Overdue|已逾期|Lewat|காலக்கெடு கடந்தது|เกินกำหนด|Quá hạn/)).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();const [target,options]=fetcher.mock.calls[0];
  expect(new URL(target,'https://fixture.invalid').searchParams.get('employmentId')).toBe(employmentId);
  expect(options).toMatchObject({cache:'no-store',credentials:'same-origin'});expect(options.signal).toBeInstanceOf(AbortSignal);
 });
 it('refreshes current ownership on focus and removes completed work only after the owner returns an empty result',async()=>{
  mount();await screen.findByText('Fictional required notice');
  fetcher.mockResolvedValueOnce(Response.json({...value,total:0,overdue:0,effortMinutes:0,unestimated:0,items:[]}));
  fireEvent.focus(window);
  await screen.findByText(en.employeeHome.tasks.empty);
  expect(screen.queryByRole('link')).toBeNull();await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 });
 it('pages the visible rows without changing the all-assignment total',async()=>{
  const first={...value,total:13,pages:2,items:Array.from({length:12},(_,i)=>({...value.items[0],id:'notice-'+i,subjectName:'Fictional notice '+i}))};
  fetcher.mockResolvedValueOnce(Response.json(first)).mockResolvedValueOnce(Response.json({...value,total:13,pages:2,page:2,items:[value.items[1]]}));
  mount();await screen.findByText('Fictional notice 0');expect(screen.getAllByRole('link')).toHaveLength(12);
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.tasks.next}));
  await screen.findByText('Fictional assigned feedback');expect(screen.getAllByRole('link')).toHaveLength(1);expect(screen.getByText('13 actions waiting')).toBeVisible();
  expect(new URL(fetcher.mock.calls[1][0],'https://fixture.invalid').searchParams.get('page')).toBe('2');
 });
 it('keeps a failed or mismatched response distinct from an empty queue, then retries the one card',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,employmentId:'foreign'}));mount();
  await screen.findByRole('alert');expect(screen.queryByText(en.employeeHome.tasks.empty)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.tasks.retry+': '+en.employeeHome.tasks.title}));
  await screen.findByText('Fictional required notice');expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
