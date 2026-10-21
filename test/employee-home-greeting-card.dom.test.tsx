import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
vi.mock('../components/employee-home/knowledge-search',()=>({HomeKnowledgeSearch:()=> <p>Permission-filtered search</p>}));
import {HomeGreetingCard} from '../components/employee-home/greeting-card';
const catalogues={en,ms,zh,ta,th,vi:viMessages},employmentId='d2614245-dd04-4c2e-a892-45e2ab29a192';
const value={version:1,employmentId,serverNow:new Date().toISOString(),displayDate:new Date().toISOString().slice(0,10),timeZone:'Asia/Kuala_Lumpur',message:'Recorded greeting, Fictional Amina.',templateKey:'greetingMorning',photoHref:null};
const fetcher=vi.fn();
beforeEach(()=>{fetcher.mockReset();fetcher.mockImplementation(async()=>Response.json(value));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(locale:keyof typeof catalogues='en'){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><HomeGreetingCard employmentId={employmentId}/></NextIntlClientProvider>);
}
describe('Home personal greeting card',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders the saved sentence as text with an independently delivered server clock',async locale=>{
  mount(locale);await screen.findByText(value.message);expect(screen.getByRole('heading',{name:catalogues[locale].employeeHome.greeting.title})).toBeVisible();
  expect(screen.getByText('Permission-filtered search')).toBeVisible();expect(document.querySelector('time')).toHaveAttribute('datetime',value.serverNow);
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store',credentials:'same-origin'});
 });
 it('does not render an untrusted photo URL or guess another personal name after a refused read',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,photoHref:'https://foreign.invalid/private.png'}));mount();await screen.findByRole('alert');
  expect(document.querySelector('img')).toBeNull();expect(screen.queryByText(value.message)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.greeting.retry+': '+en.employeeHome.greeting.title}));await screen.findByText(value.message);
 });
 it('uses a localized impersonal fallback when no personal sentence is recorded',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,message:null,templateKey:null}));mount('ms');await screen.findByText(ms.employeeHome.greeting.welcome);
  expect(screen.queryByText(value.message)).toBeNull();
 });
});
