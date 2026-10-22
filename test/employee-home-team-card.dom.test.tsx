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
import {HomeTeamCard} from '../components/employee-home/team-card';
import {todayInKualaLumpur} from '../lib/hr-date';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const first='62063128-fdc5-4a0e-87d7-1892257dbb10',second='62063128-fdc5-4a0e-87d7-1892257dbb11';
const fetcher=vi.fn(),date=todayInKualaLumpur();
const envelope=(employmentId='own')=>({version:1,employmentId,page:{scope:'department',date,totalPeople:2,
 items:[{employmentId:first,name:'Fictional on leave',presence:'leave'},{employmentId:second,name:'Fictional unknown',presence:null}],nextCursor:null}});
function view(locale:keyof typeof catalogues='en',employmentId='own'){
 return <NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><HomeTeamCard key={employmentId} employmentId={employmentId}/></NextIntlClientProvider>;
}
beforeEach(()=>{fetcher.mockReset();fetcher.mockImplementation(async()=>Response.json(envelope()));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('minimal shared-team Home card',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders leave and unknown distinctly without an office/WFH inference',async locale=>{
  render(view(locale));const t=catalogues[locale].employeeHome.team;
  expect(await screen.findByText(t.onLeave.replace('{name}','Fictional on leave'))).toBeVisible();
  expect(screen.getByText(t.unknown.replace('{name}','Fictional unknown'))).toBeVisible();
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store',credentials:'same-origin'});
  expect(screen.getByRole('region',{name:t.title})).toHaveAttribute('aria-busy','false');
 });
 it('keeps configured-off separate from failure and permits an explicit retry',async()=>{
  fetcher.mockResolvedValueOnce(new Response('unavailable',{status:503}));render(view());
  await screen.findByRole('alert');expect(screen.queryByText(en.employeeHome.team.off)).toBeNull();
  fetcher.mockResolvedValueOnce(Response.json({...envelope(),page:{scope:'off',date,totalPeople:0,items:[],nextCursor:null}}));
  fireEvent.click(screen.getByRole('button',{name:'Retry: '+en.employeeHome.team.title}));
  expect(await screen.findByText(en.employeeHome.team.off)).toBeVisible();expect(screen.queryByText(/Fictional on leave/)).toBeNull();
 });
 it('pages with the selected subject, moves focus to the region and can recover a revoked cursor from the first page',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({...envelope(),page:{...envelope().page,items:[envelope().page.items[0]],nextCursor:first}}));
  render(view());await screen.findByText('Fictional on leave has approved leave.');
  fetcher.mockResolvedValueOnce(new Response('changed',{status:503}));
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.team.next}));
  expect(document.activeElement).toBe(screen.getByRole('region',{name:en.employeeHome.team.title}));
  await screen.findByRole('alert');expect(screen.queryByText('Fictional on leave has approved leave.')).toBeNull();
  const url=new URL(fetcher.mock.calls[1][0],'http://localhost');
  expect(Object.fromEntries(url.searchParams)).toEqual({employmentId:'own',after:first});
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.team.firstPage}));
  expect(await screen.findByText('Fictional on leave has approved leave.')).toBeVisible();
  expect(new URL(fetcher.mock.calls[2][0],'http://localhost').searchParams.has('after')).toBe(false);
 });
 it('removes the old company page while the selected employment changes',async()=>{
  const mounted=render(view());await screen.findByText('Fictional on leave has approved leave.');
  fetcher.mockImplementation(()=>new Promise(()=>{}));mounted.rerender(view('en','second-own'));
  expect(screen.queryByText('Fictional on leave has approved leave.')).toBeNull();
  await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));expect(fetcher.mock.calls[1][0]).toContain('employmentId=second-own');
 });
 it('renders a recorded name as text and refuses a richer or foreign response',async()=>{
  const value=envelope();value.page.items[0].name='<script>fictional</script>';
  fetcher.mockResolvedValueOnce(Response.json(value));const mounted=render(view());
  await screen.findByText('<script>fictional</script> has approved leave.');expect(document.querySelector('script')).toBeNull();
  fetcher.mockResolvedValueOnce(Response.json({...envelope('foreign'),salary:1000}));mounted.rerender(view('en','second-own'));
  await screen.findByRole('alert');expect(screen.queryByText('<script>fictional</script> has approved leave.')).toBeNull();
 });
});
