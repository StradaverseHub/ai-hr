import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,type IntlError} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import type {ToilSweepJobProgress} from '../lib/toil-sweep-job';

const replace=vi.fn(),refresh=vi.fn();
vi.mock('next/navigation',()=>({useRouter:()=>({refresh,push:vi.fn(),replace})}));
const success=vi.fn(),failure=vi.fn();
vi.mock('sonner',()=>({toast:{success:(m:string)=>success(m),error:(m:string)=>failure(m)}}));
import {ToilSweepJobPanel} from '../components/leave/toil-sweep-job-panel';

afterEach(()=>{cleanup();vi.unstubAllGlobals();success.mockReset();failure.mockReset();refresh.mockReset();replace.mockReset();});
const running:ToilSweepJobProgress={id:'00000000-0000-4000-8000-000000000003',kind:'toil_expiry',state:'running',total:3000,done:600,failedEmployees:0,error:null,
 updatedAt:new Date().toISOString(),result:null,worker:'running'};
function panel(job:ToilSweepJobProgress,onDone=vi.fn(),locale:'en'|'ms'='en'){
 const errors:string[]=[];
 render(<NextIntlClientProvider locale={locale} messages={locale==='en'?en:ms} onError={(e:IntlError)=>errors.push(e.message)}><ToilSweepJobPanel job={job} onDone={onDone}/></NextIntlClientProvider>);
 expect(errors).toEqual([]);
 return onDone;
}
const respond=(job:ToilSweepJobProgress)=>{const fetch=vi.fn(async()=>new Response(JSON.stringify({job}),{status:200}));vi.stubGlobal('fetch',fetch);return fetch;};
const t=en.admin.toilPolicy.sweepJob;

describe('background replacement-leave sweep panel',()=>{
 it('shows the sweep and its progress in the viewer language, polling its own job',async()=>{
  const fetch=respond({...running,done:1500});
  panel(running);
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(fetch).toHaveBeenCalledWith('/admin/leave-config/leave-credit/jobs/00000000-0000-4000-8000-000000000003',{cache:'no-store'});
  expect(screen.getByText(t.title.toil_expiry)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(t.state.running);
  expect(screen.getByText('1500 of 3000 employees processed')).toBeTruthy();
  expect(screen.getByText(t.backgroundHelp)).toBeTruthy();
 });
 it('renders the year-end close in Malay without a missing message',async()=>{
  respond({...running,kind:'toil_year_close'});
  panel({...running,kind:'toil_year_close'},vi.fn(),'ms');
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(screen.getByText(ms.admin.toilPolicy.sweepJob.title.toil_year_close)).toBeTruthy();
  expect(screen.getByText('600 daripada 3000 pekerja diproses')).toBeTruthy();
 });
 it('ends Process expirations on the address the synchronous action redirected to, so the same banner reports it',async()=>{
  const result={processed:7,converted:4,lapsed:3,convertedDays:5.5,convertedAmount:612.4,skippedOutOfScope:2};
  respond({...running,state:'completed',done:3000,result});
  const done=panel(running);
  await vi.waitFor(()=>expect(done).toHaveBeenCalled());
  expect(replace).toHaveBeenCalledWith('/admin/leave-config/leave-credit?processed=7&converted=4&lapsed=3&skipped=2');
  expect(failure).not.toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
 });
 it('ends the year-end close on its banner address, and reports employees left unchanged',async()=>{
  const result={processed:9,converted:5,lapsed:4,convertedDays:6,convertedAmount:700,skippedOutOfScope:0,alreadyClosed:false,carriedForward:3};
  respond({...running,kind:'toil_year_close',state:'completed',done:3000,failedEmployees:5,error:'Leave source is unavailable; review it again.',result});
  const done=panel({...running,kind:'toil_year_close'});
  await vi.waitFor(()=>expect(done).toHaveBeenCalled());
  expect(replace).toHaveBeenCalledWith('/admin/leave-config/leave-credit?closed=1&closedAlready=0&closedProcessed=9&closedConverted=5&closedLapsed=4&closedCarried=3');
  expect(failure).toHaveBeenCalledWith('5 employee(s) could not be processed and their credits were left unchanged: Leave source is unavailable; review it again. Run it again to complete them.');
 });
 it('says an already-closed boundary the way the synchronous action did',async()=>{
  const result={processed:0,converted:0,lapsed:0,convertedDays:0,convertedAmount:0,skippedOutOfScope:0,alreadyClosed:true,carriedForward:0};
  respond({...running,kind:'toil_year_close',state:'completed',total:0,done:0,result});
  const done=panel({...running,kind:'toil_year_close'});
  await vi.waitFor(()=>expect(done).toHaveBeenCalled());
  expect(replace).toHaveBeenCalledWith('/admin/leave-config/leave-credit?closed=1&closedAlready=1&closedProcessed=0&closedConverted=0&closedLapsed=0&closedCarried=0');
 });
 it('reports a stopped sweep with its reason and leaves the job address',async()=>{
  respond({...running,state:'failed',error:'Your access to this job changed, so it was stopped.'});
  const done=panel(running);
  await vi.waitFor(()=>expect(done).toHaveBeenCalled());
  expect(failure).toHaveBeenCalledWith('The run stopped: Your access to this job changed, so it was stopped. Credits already settled stay settled. Run it again to settle the rest.');
  expect(replace).toHaveBeenCalledWith('/admin/leave-config/leave-credit');
 });
 it('hands a sweep that finished before the page drew straight to its banner, without polling',async()=>{
  const fetch=respond(running);
  const result={processed:1,converted:1,lapsed:0,convertedDays:1,convertedAmount:115.38,skippedOutOfScope:0};
  const done=panel({...running,state:'completed',done:3000,result});
  await vi.waitFor(()=>expect(done).toHaveBeenCalled());
  expect(fetch).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith('/admin/leave-config/leave-credit?processed=1&converted=1&lapsed=0&skipped=0');
 });
 it('says a queued sweep is waiting when no background service serves it',async()=>{
  const queued={...running,state:'queued' as const,done:0,worker:'unavailable' as const};
  respond(queued);
  panel(queued);
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(screen.getByText(t.waiting)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(t.state.queued);
 });
});
