/** Payroll history confirm/revert committing in the background: the panel polls the creator's job, shows its state
 * and progress under the shipping catalogues, and hands the finished job back to the screen exactly once. */
import {describe,expect,it,vi,afterEach} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import type {BulkJobProgress} from '../lib/bulk-job';
import type {PayrollHistoryJobStatus} from '../lib/payroll-history-job';

const {HistoryJobPanel}=await import('../app/payroll/history-import/history-job-progress');

const jobId='44444444-4444-4444-8444-444444444444';
const job:BulkJobProgress={id:jobId,kind:'payroll_history',state:'running',phase:'writing',sourceName:'',stepsTotal:20,stepsDone:5,
 counters:{records:18},error:null,errors:[],result:null,cancelRequested:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finishedAt:null};
const status=(patch:Partial<BulkJobProgress>,worker:PayrollHistoryJobStatus['worker']='running'):PayrollHistoryJobStatus=>({job:{...job,...patch},operation:'confirm',attemptId:null,worker});
const respond=(s:PayrollHistoryJobStatus)=>Promise.resolve(new Response(JSON.stringify(s),{status:200,headers:{'content-type':'application/json'}}));
const copy=(messages:unknown)=>(messages as {payroll:{historyRevisions:{job:{title:string;state:Record<string,string>;backgroundHelp:string;workerUnavailable:string}}}}).payroll.historyRevisions.job;
const harness=(messages:unknown,locale:string,onFinished=vi.fn())=>({onFinished,...render(<NextIntlClientProvider locale={locale} messages={messages as never}><HistoryJobPanel jobId={jobId} onFinished={onFinished}/></NextIntlClientProvider>)});

afterEach(()=>{vi.unstubAllGlobals();});

describe('HistoryJobPanel',()=>{
 it('polls the job and shows its progress while it writes',async()=>{
  const fetch=vi.fn(()=>respond(status({})));vi.stubGlobal('fetch',fetch);
  const {onFinished}=harness(en,'en');
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(copy(en).state.running));
  expect(fetch).toHaveBeenCalledWith(`/payroll/history-import/job?id=${jobId}`,{cache:'no-store'});
  expect(screen.getByRole('progressbar')).toHaveAttribute('value','25');
  expect(screen.getByText(copy(en).backgroundHelp)).toBeInTheDocument();
  expect(onFinished).not.toHaveBeenCalled();
 });

 it('hands a finished job back once, committed or stopped',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(status({state:'completed',stepsDone:20,result:{skippedReplacements:2}}))));
  const done=harness(en,'en');
  await waitFor(()=>expect(done.onFinished).toHaveBeenCalledTimes(1));
  expect(done.onFinished.mock.calls[0][0]).toMatchObject({state:'completed',result:{skippedReplacements:2}});
  done.unmount();
  vi.stubGlobal('fetch',vi.fn(()=>respond(status({state:'failed',error:'The source, master data, permissions or target revisions changed. Validate a new attempt.'}))));
  const failed=harness(zh,'zh');
  await waitFor(()=>expect(failed.onFinished).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('status')).toHaveTextContent(copy(zh).state.failed);
  expect(failed.onFinished.mock.calls[0][0]).toMatchObject({state:'failed'});
 });

 it('says when the background service is not running yet',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(status({state:'queued',stepsTotal:0,stepsDone:0},'unavailable'))));
  harness(zh,'zh');
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(copy(zh).state.queued));
  expect(screen.getByText(copy(zh).workerUnavailable)).toBeInTheDocument();
 });
});
