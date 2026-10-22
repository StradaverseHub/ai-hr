import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const nav=vi.hoisted(()=>({entries:[{href:'/leave'},{href:'/claims'},{href:'/me'},{href:'/notices'}]}));
vi.mock('../components/nav-index-context',()=>({useNavIndex:()=>nav}));
vi.mock('../components/employee-home/knowledge-search',()=>({HomeKnowledgeSearch:()=> <p>Permission-filtered search</p>}));
import {HomeSummaryOverview} from '../components/employee-home/summary-overview';
import {HomeGreetingCard} from '../components/employee-home/greeting-card';
const catalogues={en,ms,zh,ta,th,vi:viMessages},employmentId='second-own',serverNow=new Date().toISOString();
const data=()=>({version:1,employmentId,serverNow,items:[{key:'tasks',message:'Waiting for you: 2 tasks.',destination:'tasks'},
 {key:'holiday',message:'Fictional <script>literal</script> holiday.',destination:'calendar'}],calm:null,
 quickActions:[{key:'leave',reason:null},{key:'claim',reason:null},{key:'payslip',reason:'noPayslip'},{key:'profile',reason:'detailsLocked'}]});
const fetcher=vi.fn();
beforeEach(()=>{nav.entries=[{href:'/leave'},{href:'/claims'},{href:'/me'},{href:'/notices'}];fetcher.mockReset();fetcher.mockImplementation(async()=>Response.json(data()));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(locale:keyof typeof catalogues='en',children:React.ReactNode=<HomeSummaryOverview employmentId={employmentId}/>){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}>{children}</NextIntlClientProvider>);
}
describe('Home summary and configured quick actions',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders minimal sentences and exact own links with localized disabled reasons',async locale=>{
  mount(locale);await screen.findByText('Waiting for you: 2 tasks.');
  expect(screen.getByRole('link',{name:catalogues[locale].employeeHome.quickActions.leave})).toHaveAttribute('href','/leave?apply=1&employmentId=second-own');
  expect(screen.getByRole('link',{name:catalogues[locale].employeeHome.quickActions.claim})).toHaveAttribute('href','/claims?employmentId=second-own');
  expect(screen.getByRole('button',{name:catalogues[locale].employeeHome.quickActions.payslip})).toBeDisabled();expect(screen.getByText(catalogues[locale].employeeHome.summary.noPayslip)).toBeVisible();
  expect(screen.getByRole('button',{name:catalogues[locale].employeeHome.quickActions.profile})).toBeDisabled();expect(screen.getByText(catalogues[locale].employeeHome.summary.detailsLocked)).toBeVisible();
  expect(screen.getByText('Fictional <script>literal</script> holiday.')).toBeVisible();expect(document.querySelector('script')).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store',credentials:'same-origin'});
 });
 it('uses the live rail result rather than inventing another client role map',async()=>{
  nav.entries=[{href:'/me'}];mount();await screen.findByText('Waiting for you: 2 tasks.');
  expect(screen.queryByRole('link',{name:en.employeeHome.quickActions.leave})).toBeNull();expect(screen.queryByRole('link',{name:en.employeeHome.quickActions.claim})).toBeNull();
 });
 it('does not assert calm after a failed reader and recovers with an explicit retry',async()=>{
  fetcher.mockResolvedValueOnce(new Response('unavailable',{status:503}));mount();await screen.findByRole('alert');expect(screen.queryByText('Nothing needs your attention today.')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.summary.retry+': '+en.employeeHome.summary.title}));await screen.findByText('Waiting for you: 2 tasks.');
 });
 it('cannot keep the old employer links visible while a new employer response is pending',async()=>{
  const mounted=mount();await screen.findByRole('link',{name:en.employeeHome.quickActions.claim});fetcher.mockImplementation(()=>new Promise(()=>{}));
  mounted.rerender(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur"><HomeSummaryOverview employmentId="another-own"/></NextIntlClientProvider>);
  expect(screen.queryByRole('link',{name:en.employeeHome.quickActions.claim})).toBeNull();await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
 });
 it('loads summary even when the independent greeting fails',async()=>{
  fetcher.mockImplementation(async(url:string)=>url.includes('/greeting-message?')?new Response('unavailable',{status:503}):Response.json(data()));
  mount('en',<HomeGreetingCard employmentId={employmentId}><HomeSummaryOverview employmentId={employmentId}/></HomeGreetingCard>);
  await screen.findByText('Waiting for you: 2 tasks.');await screen.findByText(en.employeeHome.greeting.failed);expect(screen.getByRole('link',{name:en.employeeHome.quickActions.claim})).toBeVisible();
 });
 it('summary failure leaves the recorded greeting and search available',async()=>{
  fetcher.mockImplementation(async(url:string)=>url.includes('/summary?')?new Response('unavailable',{status:503}):Response.json({version:1,employmentId,serverNow,displayDate:serverNow.slice(0,10),timeZone:'Asia/Kuala_Lumpur',message:'Recorded fictional greeting',photoHref:null}));
  mount('en',<HomeGreetingCard employmentId={employmentId}><HomeSummaryOverview employmentId={employmentId}/></HomeGreetingCard>);
  await screen.findByText(en.employeeHome.summary.failed);await screen.findByText('Recorded fictional greeting');expect(screen.getByText('Permission-filtered search')).toBeVisible();
 });
});
