/** A selective reprocess running in the background: the panel polls the reprocess job, counts the employees done
 * under the shipping catalogues, and refreshes the screen to its results exactly once when the job ends. */
import {describe,expect,it,vi,afterEach,beforeEach} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import th from '../messages/th.json';

const refresh=vi.fn();
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
vi.mock('@/components/ui',()=>({Card:({children,...props}:React.HTMLAttributes<HTMLDivElement>)=><div {...props}>{children}</div>}));
const {ReprocessJobPanel}=await import('../app/payroll/[batchId]/reprocess/reprocess-progress');

const jobId='55555555-5555-4555-8555-555555555555';
const ids=['a','b','c','d'];
type Job={status:string;employmentIds:string[];result:{outcomes?:unknown[]}|null};
const respond=(job:Job)=>Promise.resolve(new Response(JSON.stringify(job),{status:200,headers:{'content-type':'application/json'}}));
const copy=(messages:unknown)=>(messages as {payroll:{batch:{reprocessJob:Record<string,string>}}}).payroll.batch.reprocessJob;
const harness=(messages:unknown,locale:string,initial:Job)=>render(<NextIntlClientProvider locale={locale} messages={messages as never}><ReprocessJobPanel jobId={jobId} initial={initial}/></NextIntlClientProvider>);
beforeEach(()=>{refresh.mockReset();});
afterEach(()=>{vi.unstubAllGlobals();});

describe('ReprocessJobPanel',()=>{
 it('polls the reprocess job and counts the employees done while it runs',async()=>{
  const fetch=vi.fn(()=>respond({status:'running',employmentIds:ids,result:{outcomes:[{},{},{}]}}));vi.stubGlobal('fetch',fetch);
  harness(en,'en',{status:'queued',employmentIds:ids,result:null});
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(copy(en).running));
  expect(fetch).toHaveBeenCalledWith(`/api/payroll/reprocess-job/${jobId}`,{cache:'no-store'});
  expect(screen.getByRole('progressbar')).toHaveAttribute('value','75');
  expect(screen.getByText('3 of 4 employees done')).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
 });
 it('refreshes to the results once when the job ends, completed or stopped',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond({status:'failed',employmentIds:ids,result:{outcomes:[{}]}})));
  harness(th,'th',{status:'running',employmentIds:ids,result:{outcomes:[]}});
  await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));
  expect(screen.getByText(copy(th).help)).toBeInTheDocument();
 });
});
