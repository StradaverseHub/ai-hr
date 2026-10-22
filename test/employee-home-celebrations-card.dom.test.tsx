import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import userEvent from '@testing-library/user-event';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {HomeCelebrationsCard} from '../components/employee-home/celebrations-card';
import {todayInKualaLumpur} from '../lib/hr-date';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const id='62063128-fdc5-4a0e-87d7-1892257dbb10',today=todayInKualaLumpur();
const to=new Date(Date.parse(today+'T12:00:00Z')+7*86400000).toISOString().slice(0,10);
const cursor=today+'|anniversary|'+id,fetcher=vi.fn();
const envelope=(employmentId='own')=>({version:1,employmentId,page:{scope:'department',from:today,to,total:3,
 items:[{employmentId:id,name:'Fictional birthday',date:today,kind:'birthday',years:null},
  {employmentId:id,name:'Fictional anniversary',date:today,kind:'anniversary',years:4},
  {employmentId:'62063128-fdc5-4a0e-87d7-1892257dbb11',name:null,date:to,kind:'anniversary',years:null}],nextCursor:null}});
function view(locale:keyof typeof catalogues='en',employmentId='own',greetingsEnabled=false){
 return <NextIntlClientProvider locale={locale} messages={catalogues[locale]} timeZone="Asia/Kuala_Lumpur" onError={error=>{throw error;}}><HomeCelebrationsCard key={employmentId} employmentId={employmentId} greetingsEnabled={greetingsEnabled}/></NextIntlClientProvider>;
}
beforeEach(()=>{fetcher.mockReset();fetcher.mockImplementation(async()=>Response.json(envelope()));vi.stubGlobal('fetch',fetcher);});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('minimal person-private Home celebrations',()=>{
 it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('%s renders a birthday, known service years and an unknown anniversary without inventing an age',async locale=>{
  render(view(locale));const t=catalogues[locale].employeeHome.celebrations;
  expect(await screen.findByText(t.birthday)).toBeVisible();expect(screen.getByText(t.anniversary)).toBeVisible();
  expect(screen.getByText(t.unnamed)).toBeVisible();expect(screen.getByText('Fictional anniversary')).toBeVisible();
  expect(screen.getByRole('region',{name:t.title})).toHaveAttribute('aria-busy','false');
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]).toMatchObject({cache:'no-store',credentials:'same-origin'});
  expect(document.querySelector('time[datetime="'+today+'"]')).not.toBeNull();
 });
 it('mounts the actual editable composer and sends only after explicit Send through the canonical transport',async()=>{
  const employmentId='00000000-0000-4000-8000-000000000001',greetingId='00000000-0000-4000-8000-000000000004';
  fetcher.mockImplementation(async(url,options)=>{
   if(options?.method!=='POST')return Response.json(envelope(employmentId));
   const command=JSON.parse(options.body);
   return Response.json({version:1,employmentId:command.employmentId,nonce:command.nonce,greetingId,state:'sent'});
  });
  const user=userEvent.setup();render(view('en',employmentId,true));await screen.findByText('Fictional birthday');
  await user.click(screen.getByRole('button',{name:en.employeeHome.greetingSend.sayHi}));
  const editor=screen.getByRole('textbox');await user.clear(editor);await user.type(editor,'Edited private fictional greeting');
  expect(fetcher).toHaveBeenCalledOnce();await user.click(screen.getByRole('button',{name:en.employeeHome.greetingSend.cancel}));
  expect(fetcher).toHaveBeenCalledOnce();await user.click(screen.getByRole('button',{name:en.employeeHome.greetingSend.sayHi}));
  await user.click(screen.getByRole('button',{name:en.employeeHome.greetingSend.send}));
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(en.employeeHome.greetingSend.sent));
  expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1][0]).toBe('/api/home/greetings');
  expect(fetcher.mock.calls[1][1]).toMatchObject({method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'}});
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({version:1,employmentId,recipientEmploymentId:id,kind:'birthday',occurrenceDate:today,
   nonce:expect.any(String),message:'Edited private fictional greeting'});
 });
 it('keeps discovery available but offers no Send control when the page cannot establish notification delivery',async()=>{
  render(view());await screen.findByText('Fictional birthday');
  expect(screen.getByText(en.employeeHome.celebrations.deliveryUnavailable)).toBeVisible();
  expect(screen.queryByRole('button',{name:en.employeeHome.greetingSend.sayHi})).toBeNull();
  expect(screen.queryByRole('button',{name:en.employeeHome.greetingSend.cheer})).toBeNull();expect(fetcher).toHaveBeenCalledOnce();
 });
 it('keeps a failed privacy read distinct from off and empty, then clears old content on refresh',async()=>{
  render(view());await screen.findByText('Fictional birthday');
  fetcher.mockResolvedValueOnce(new Response('unavailable',{status:503}));
  fireEvent.click(screen.getByRole('button',{name:'Refresh: '+en.employeeHome.celebrations.title}));
  expect(screen.queryByText('Fictional birthday')).toBeNull();await screen.findByRole('alert');
  expect(screen.queryByText(en.employeeHome.celebrations.off)).toBeNull();expect(screen.queryByText(en.employeeHome.celebrations.empty)).toBeNull();
  fetcher.mockResolvedValueOnce(Response.json({...envelope(),page:{scope:'off',from:today,to,total:0,items:[],nextCursor:null}}));
  fireEvent.click(screen.getByRole('button',{name:'Retry: '+en.employeeHome.celebrations.title}));
  expect(await screen.findByText(en.employeeHome.celebrations.off)).toBeVisible();
 });
 it('rechecks privacy at pagination, refuses a revoked cursor, and recovers from the first page',async()=>{
  const page={...envelope().page,items:[envelope().page.items[1]],nextCursor:cursor};
  fetcher.mockResolvedValueOnce(Response.json({...envelope(),page}));render(view());await screen.findByText('Fictional anniversary');
  fetcher.mockResolvedValueOnce(new Response('privacy changed',{status:503}));
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.celebrations.next}));
  expect(document.activeElement).toBe(screen.getByRole('region',{name:en.employeeHome.celebrations.title}));
  await screen.findByRole('alert');expect(screen.queryByText('Fictional anniversary')).toBeNull();
  expect(Object.fromEntries(new URL(fetcher.mock.calls[1][0],'http://localhost').searchParams)).toEqual({employmentId:'own',after:cursor});
  fetcher.mockResolvedValueOnce(Response.json({...envelope(),page:{...envelope().page,total:0,items:[]}}));
  fireEvent.click(screen.getByRole('button',{name:en.employeeHome.celebrations.firstPage}));
  expect(await screen.findByText(en.employeeHome.celebrations.empty)).toBeVisible();
  expect(new URL(fetcher.mock.calls[2][0],'http://localhost').searchParams.has('after')).toBe(false);
 });
 it('removes an earlier company’s names while another own employment loads',async()=>{
  const mounted=render(view());await screen.findByText('Fictional birthday');
  fetcher.mockImplementation(()=>new Promise(()=>{}));mounted.rerender(view('en','second-own'));
  expect(screen.queryByText('Fictional birthday')).toBeNull();await waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1][0]).toContain('employmentId=second-own');
 });
 it('renders names as text and refuses richer or foreign envelopes',async()=>{
  const value=envelope();value.page.items[0].name='<script>fictional</script>';
  fetcher.mockResolvedValueOnce(Response.json(value));const mounted=render(view());await screen.findByText('<script>fictional</script>');
  expect(document.querySelector('script')).toBeNull();
  fetcher.mockResolvedValueOnce(Response.json({...envelope('foreign'),dateOfBirth:'2000-01-01'}));mounted.rerender(view('en','second-own'));
  await screen.findByRole('alert');expect(screen.queryByText('<script>fictional</script>')).toBeNull();
 });
});
