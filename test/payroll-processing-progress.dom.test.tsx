/** Background payroll processing panel on the run screen: polling, progress, settle refresh and failure reason, under
 * the shipping catalogues. */
import {describe,expect,it,vi,afterEach,beforeEach} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import type {BulkJobProgress} from '../lib/bulk-job';
import type {PayrollProcessingStatus} from '../lib/payroll-processing-job';

const refresh=vi.fn();
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
const {PayrollProcessingPanel}=await import('../app/payroll/[batchId]/processing-progress');

const batchId='33333333-3333-4333-8333-333333333333';
const job:BulkJobProgress={id:'11111111-1111-4111-8111-111111111111',kind:'payroll_process',state:'running',phase:'employees',sourceName:'',stepsTotal:10,stepsDone:4,
 counters:{employees:90,paid:30},error:null,errors:[],result:null,cancelRequested:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finishedAt:null};
const running:PayrollProcessingStatus={status:'processing',job,worker:'running'};
const respond=(status:PayrollProcessingStatus)=>Promise.resolve(new Response(JSON.stringify(status),{status:200,headers:{'content-type':'application/json'}}));
const copy=(messages:unknown)=>(messages as {payroll:{batch:{processingJob:{state:Record<string,string>;backgroundHelp:string;othersRun:string;workerUnavailable:string}}}}).payroll.batch.processingJob;
const harness=(messages:unknown,locale:string,initial:PayrollProcessingStatus)=>render(<NextIntlClientProvider locale={locale} messages={messages as never}><PayrollProcessingPanel batchId={batchId} initial={initial}/></NextIntlClientProvider>);

beforeEach(()=>{refresh.mockReset();});
afterEach(()=>{vi.unstubAllGlobals();});

describe('PayrollProcessingPanel',()=>{
 it('polls the run and shows the job’s progress while the run is processing',async()=>{
  const fetch=vi.fn(()=>respond(running));vi.stubGlobal('fetch',fetch);
  harness(en,'en',running);
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith(`/payroll/${batchId}/processing`,{cache:'no-store'}));
  expect(screen.getByRole('status')).toHaveTextContent(copy(en).state.running);
  expect(screen.getByRole('progressbar')).toHaveAttribute('value','40');
  expect(screen.getByText(copy(en).backgroundHelp)).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
 });

 it('refreshes the run screen once when the run settles as processed',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond({status:'processed',job:{...job,state:'completed',stepsDone:10},worker:'running'})));
  harness(en,'en',running);
  await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));
 });

 it('shows why a stopped job returned the run to draft, without polling',async()=>{
  const fetch=vi.fn(()=>respond(running));vi.stubGlobal('fetch',fetch);
  harness(en,'en',{status:'draft',job:{...job,state:'failed',error:'1 employee(s) are not ready for processing.',finishedAt:new Date().toISOString()},worker:'running'});
  expect(screen.getByRole('status')).toHaveTextContent(copy(en).state.failed);
  expect(screen.getByRole('alert')).toHaveTextContent('1 employee(s) are not ready for processing.');
  expect(fetch).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
 });

 it('tells another payroll operator the run is being processed, and a queued job that the service is not running',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond({status:'processing',job:null,worker:'running'})));
  const {unmount}=harness(en,'en',{status:'processing',job:null,worker:'running'});
  expect(screen.getByRole('status')).toHaveTextContent(copy(en).othersRun);
  unmount();
  const queued:PayrollProcessingStatus={status:'processing',job:{...job,state:'queued',stepsTotal:0,stepsDone:0},worker:'unavailable'};
  vi.stubGlobal('fetch',vi.fn(()=>respond(queued)));
  harness(ms,'ms',queued);
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(copy(ms).state.queued));
  expect(screen.getByText(copy(ms).workerUnavailable)).toBeInTheDocument();
 });
});
