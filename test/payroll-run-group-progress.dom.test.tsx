/** The Payroll Process wizard's result screen while its runs process: one progress row per company, a refused
 * company shown as failed, polling of the run group, and one refresh to the outcomes when every run has finished. */
import {describe,expect,it,vi,afterEach,beforeEach} from 'vitest';
import {render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import type {BulkJobProgress} from '../lib/bulk-job';
import type {RunGroupView} from '../core/payroll-run-group-store';

const refresh=vi.fn();
vi.mock('next/navigation',()=>({useRouter:()=>({refresh})}));
const {RunGroupProgressPanel}=await import('../app/payroll/process/result/run-group-progress');

const groupId='44444444-4444-4444-8444-444444444444';
const job=(state:BulkJobProgress['state'],stepsDone:number):BulkJobProgress=>({id:'11111111-1111-4111-8111-111111111111',kind:'payroll_process',state,phase:'employees',sourceName:'',stepsTotal:10,stepsDone,
 counters:{},error:null,errors:[],result:null,cancelRequested:false,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),finishedAt:null});
type Progress=Pick<RunGroupView,'done'|'companies'|'worker'>;
const running:Progress={done:false,worker:'running',companies:[
 {companyId:'a',companyName:'Fictional Alpha Sdn Bhd',status:'processing',job:job('completed',10)},
 {companyId:'b',companyName:'Fictional Beta Sdn Bhd',status:'processing',job:job('running',3)},
 {companyId:'c',companyName:'Fictional Gamma Sdn Bhd',status:'failed',job:null},
]};
const respond=(progress:Progress)=>Promise.resolve(new Response(JSON.stringify(progress),{status:200,headers:{'content-type':'application/json'}}));
type Copy={payroll:{batch:{processingJob:{state:Record<string,string>;backgroundHelp:string}};process:{companyFailed:string}}};
const harness=(messages:unknown,locale:string,initial:Progress)=>render(<NextIntlClientProvider locale={locale} messages={messages as never}><RunGroupProgressPanel groupId={groupId} initial={initial}/></NextIntlClientProvider>);

beforeEach(()=>{refresh.mockReset();});
afterEach(()=>{vi.unstubAllGlobals();});

describe('RunGroupProgressPanel',()=>{
 it('polls the run group and shows each company’s run, including one refused before it started',async()=>{
  const fetch=vi.fn(()=>respond(running));vi.stubGlobal('fetch',fetch);
  harness(en,'en',running);
  await waitFor(()=>expect(fetch).toHaveBeenCalledWith(`/payroll/process/result/status?g=${groupId}`,{cache:'no-store'}));
  const copy=(en as unknown as Copy).payroll;
  const rows=screen.getAllByRole('listitem');
  expect(within(rows[0]).getByRole('status')).toHaveTextContent(copy.batch.processingJob.state.completed);
  expect(within(rows[1]).getByRole('status')).toHaveTextContent(copy.batch.processingJob.state.running);
  expect(within(rows[1]).getByRole('progressbar')).toHaveAttribute('value','30');
  expect(within(rows[2]).getByRole('status')).toHaveTextContent(copy.process.companyFailed);
  expect(screen.getAllByRole('progressbar')).toHaveLength(1);
  expect(screen.getByText(copy.batch.processingJob.backgroundHelp)).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
 });

 it('refreshes to the outcomes once every company’s run has finished',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond({...running,done:true,companies:running.companies.map(c=>c.job?{...c,job:job('completed',10)}:c)})));
  harness(zh,'zh',running);
  await waitFor(()=>expect(refresh).toHaveBeenCalledTimes(1));
  expect(within(screen.getAllByRole('listitem')[1]).getByRole('status')).toHaveTextContent((zh as unknown as Copy).payroll.batch.processingJob.state.completed);
 });
});
