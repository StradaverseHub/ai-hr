import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {HomeCalendarCard} from '../components/employee-home/calendar-card';
import {homeCalendarGrid,type EmployeeHomeCalendar} from '../lib/employee-home-calendar';

const fetcher=vi.fn();
function data(month='2024-02',employmentId='own'):EmployeeHomeCalendar{
 return {version:1,employmentId,month,today:'2024-02-12',weekStartsOn:1,payrollEnabled:true,
  days:homeCalendarGrid(month,1).map(date=>({date,canRequestLeave:date==='2024-02-14',entries:date==='2024-02-12'?[{kind:'leave',date,status:'pending',duration:'part_day'}]:[]}))};
}
function view(employmentId='own',full=false){return <NextIntlClientProvider locale="en" messages={messages}><HomeCalendarCard employmentId={employmentId} initialMonth="2024-02" full={full}/></NextIntlClientProvider>;}
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);fetcher.mockImplementation(async(url:string)=>{
 const query=new URL(url,'http://localhost').searchParams;
 return {ok:true,json:async()=>data(query.get('month')!,query.get('employmentId')!)};
});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('personal Home calendar interactions',()=>{
 it('shows pending text, opens a day with keyboard and restores focus after Escape',async()=>{
  render(view());
  const trigger=await screen.findByRole('button',{name:/Monday, February 12, 2024.*Pending/});
  expect(trigger.getAttribute('aria-current')).toBe('date');
  trigger.focus();await userEvent.setup().keyboard('{Enter}');
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(screen.getByText('My leave · Pending · Part day')).toBeTruthy();
  expect(screen.queryByRole('link',{name:'Request leave'})).toBeNull();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape',code:'Escape'});
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(()=>expect(document.activeElement).toBe(trigger));
 });
 it('prefills the existing request with the selected own subject and exact empty date',async()=>{
  render(view());fireEvent.click(await screen.findByRole('button',{name:'Wednesday, February 14, 2024'}));
  const link=await screen.findByRole('link',{name:'Request leave'});
  const url=new URL(link.getAttribute('href')!,'http://localhost');
  expect(url.pathname).toBe('/leave');expect(Object.fromEntries(url.searchParams)).toEqual({apply:'1',start:'2024-02-14',employmentId:'own'});
  expect(screen.getByText('No recorded events on this date.')).toBeTruthy();
 });
 it('changes month and opens a full calendar that retains subject and month',async()=>{
  render(view());await screen.findByRole('button',{name:/Monday, February 12, 2024/});
  fireEvent.click(screen.getByRole('button',{name:'Next'}));
  await waitFor(()=>expect(screen.getByRole('heading',{name:'March 2024'})).toBeTruthy());
  const link=screen.getByRole('link',{name:'View full calendar'}),url=new URL(link.getAttribute('href')!,'http://localhost');
  expect(url.pathname).toBe('/me/calendar');expect(Object.fromEntries(url.searchParams)).toEqual({employmentId:'own',month:'2024-03'});
  expect(fetcher.mock.calls.some(([url])=>String(url).includes('month=2024-03'))).toBe(true);
 });
 it('offers real week and list views over the same authorized month facts',async()=>{
  render(view('own',true));await screen.findByRole('button',{name:/Monday, February 12, 2024/});
  fireEvent.click(screen.getByRole('button',{name:'Week'}));
  expect(screen.getByText('Week 3')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/Monday, January 29, 2024/})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Next week'}));expect(screen.getByText('Week 4')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'List'}));
  expect(screen.getByRole('button',{name:/Monday, February 12, 2024.*Pending/})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'Wednesday, February 14, 2024'})).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('refuses a mismatched response instead of painting another subject’s events',async()=>{
  fetcher.mockResolvedValueOnce({ok:true,json:async()=>data('2024-02','foreign')});render(view());
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByRole('button',{name:/Monday, February 12, 2024/})).toBeNull();
  expect(screen.getByRole('button',{name:'Retry: My Calendar'})).toBeTruthy();
 });
});
