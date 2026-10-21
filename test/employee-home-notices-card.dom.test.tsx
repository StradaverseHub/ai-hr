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
import {HomeNoticesCard} from '../components/employee-home/notices-card';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const employmentId='d2614245-dd04-4c2e-a892-45e2ab29a192',id='21d29ae1-dc1c-4479-a7bf-cb882f12ef66';
const value={version:1,employmentId,total:23,unread:22,acknowledgementRequired:1,items:[{id,title:'Fictional policy',summary:'Recorded summary',category:'Policy',pinned:true,
 requiresAcknowledgement:true,publishedAt:'2026-09-01T08:00:00Z',publishedBy:'Fictional HR',firstViewedAt:null,acknowledgedAt:null}]};
const fetcher=vi.fn();
beforeEach(()=>{fetcher.mockReset();fetcher.mockImplementation(async()=>Response.json(value));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
function mount(locale:keyof typeof catalogues='en'){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><HomeNoticesCard employmentId={employmentId}/></NextIntlClientProvider>);
}
describe('Home Notice card',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders actual metadata and routes review without acknowledging anything',async locale=>{
  mount(locale);await screen.findByText('Fictional policy');const messages=catalogues[locale];
  expect(screen.getByText(messages.notices.pinnedBadge)).toBeVisible();expect(screen.getByText(messages.notices.newBadge)).toBeVisible();
  expect(screen.getByText('Recorded summary')).toBeVisible();expect(screen.getByText('Fictional HR',{exact:false})).toBeVisible();
  // Counts are the complete owner population; the card is not claiming its one example is all notices.
  expect(screen.getByRole('status').textContent).toContain('23');
  for(const link of [screen.getByRole('link',{name:'Fictional policy'}),screen.getByRole('link',{name:messages.employeeHome.notices.reviewAcknowledge})]){
   const url=new URL(link.getAttribute('href')!,'https://fixture.invalid');expect(url.pathname).toBe('/notices/'+id);expect(url.searchParams.get('employmentId')).toBe(employmentId);
  }
  const all=new URL(screen.getByRole('link',{name:messages.employeeHome.notices.seeAll}).getAttribute('href')!,'https://fixture.invalid');
  expect(all.pathname).toBe('/notices');expect(all.searchParams.get('employmentId')).toBe(employmentId);
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store',credentials:'same-origin'});
  expect(fetcher.mock.calls[0][1].method).toBeUndefined();
 });
 it('shows true empty separately from a failed card and recovers after an explicit retry',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,employmentId:'foreign'}));mount();await screen.findByRole('alert');
  expect(screen.queryByText(en.notices.myEmpty)).toBeNull();expect(screen.queryByText('Fictional policy')).toBeNull();
  fetcher.mockResolvedValueOnce(Response.json({...value,total:0,unread:0,acknowledgementRequired:0,items:[]}));
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.notices.retry+': '+en.notices.myTitle}));await screen.findByText(en.notices.myEmpty);
 });
 it('refreshes canonical read and acknowledgement state on return from the full reader',async()=>{
  mount();await screen.findByRole('link',{name:en.employeeHome.notices.reviewAcknowledge});
  fetcher.mockResolvedValueOnce(Response.json({...value,unread:21,acknowledgementRequired:0,items:[{...value.items[0],firstViewedAt:new Date().toISOString(),acknowledgedAt:new Date().toISOString()}]}));
  fireEvent(window,new Event('focus'));await screen.findByText(en.notices.acknowledgedOn.replace('{date}',''),{exact:false});
  await waitFor(()=>expect(screen.queryByRole('link',{name:en.employeeHome.notices.reviewAcknowledge})).toBeNull());
  expect(screen.queryByText(en.notices.newBadge)).toBeNull();
 });
 it('refuses an unbounded metadata response instead of silently trimming it',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...value,items:Array.from({length:6},(_,i)=>({...value.items[0],id:id.slice(0,-1)+i}))}));
  mount();await screen.findByRole('alert');expect(screen.queryByText('Fictional policy')).toBeNull();
 });
});
