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
import {HomeTimeOffCard} from '../components/employee-home/time-off-card';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {EmployeeHomeTimeOff} from '../lib/employee-home-read-model';
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
const employmentId='e17dbd09-a9a1-448c-b609-fcd74566baf6';
const value:EmployeeHomeTimeOff={version:1,employmentId,asOf:todayInKualaLumpur(),canApply:true,
 balances:[{id:'annual',name:'Fictional Annual Leave',annualLeave:true,available:17,pending:3},{id:'medical',name:'Fictional Medical Leave',annualLeave:false,available:null,pending:null}],nextApproved:null};
const catalogues={en,ms,zh,ta,th,vi:vietnamese};
let fetcher=vi.fn();
beforeEach(()=>{fetcher=vi.fn().mockImplementation(async()=>Response.json(value));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(locale:keyof typeof catalogues='en'){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}><HomeTimeOffCard employmentId={employmentId}/></NextIntlClientProvider>);
}
describe('Home Time Off independent card',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders real figures once, preserves hidden values and links the selected leave form',async locale=>{
  mount(locale);const labels=catalogues[locale].employeeHome.timeOff;
  await screen.findByText('17.00');
  expect(screen.queryByText('14.00')).toBeNull();expect(screen.getByText(labels.notShown)).toBeVisible();
  expect(screen.getByRole('heading',{name:labels.title})).toBeVisible();
  expect(screen.getByText(labels.noNext)).toBeVisible();
  const link=screen.getByRole('link',{name:labels.plan}),url=new URL(link.getAttribute('href')!,'https://fixture.invalid');
  expect(url.pathname).toBe('/leave');expect(url.searchParams.get('apply')).toBe('1');expect(url.searchParams.get('employmentId')).toBe(employmentId);
  expect(fetcher).toHaveBeenCalledOnce();const [target,options]=fetcher.mock.calls[0];
  expect(new URL(target,'https://fixture.invalid').searchParams.get('employmentId')).toBe(employmentId);
  expect(options).toMatchObject({cache:'no-store',credentials:'same-origin'});expect(options.signal).toBeInstanceOf(AbortSignal);
 });
 it('shows an honest empty state and omits apply when the canonical menu offers no leave',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,balances:[],canApply:false}));mount();
  await screen.findByText(en.employeeHome.timeOff.empty);expect(screen.queryByRole('link',{name:en.employeeHome.timeOff.plan})).toBeNull();
  expect(screen.queryByText('0.00')).toBeNull();
 });
 it('rejects a mismatched subject, then retries only this read and recovers',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,employmentId:'foreign'}));mount();
  await screen.findByRole('alert');expect(screen.getByRole('alert')).toHaveTextContent(en.employeeHome.timeOff.failed);
  expect(screen.queryByText('17.00')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.timeOff.retry+': '+en.employeeHome.timeOff.title}));
  await screen.findByText('17.00');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('reloads the localized leave names when the locale changes',async()=>{
  const result=mount();await screen.findByText('Fictional Annual Leave');
  fetcher.mockResolvedValueOnce(Response.json({...value,balances:[{...value.balances[0],name:'Fictional recorded Malay name'}]}));
  result.rerender(<NextIntlClientProvider locale="ms" messages={ms}><HomeTimeOffCard employmentId={employmentId}/></NextIntlClientProvider>);
  await screen.findByText('Fictional recorded Malay name');await waitFor(()=>expect(screen.queryByText('Fictional Annual Leave')).toBeNull());
 });
});
