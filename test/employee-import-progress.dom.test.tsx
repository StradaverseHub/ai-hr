/** Background employee import panel: polling, progress, completion and failure hand-off, under the shipping catalogues. */
import {describe,expect,it,vi,afterEach} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import {EmployeeImportJobPanel} from '../app/admin/personnel/import/employee-import-progress';
import type {EmployeeImportProgress} from '../lib/employee-import-job';

const base:EmployeeImportProgress={id:'11111111-1111-4111-8111-111111111111',sourceName:'staged.csv',state:'importing',phase:'employees',total:10,valid:10,invalid:0,stepsTotal:10,stepsDone:3,imported:3,attemptId:'22222222-2222-4222-8222-222222222222',error:null,errors:[],result:null,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
const completed:EmployeeImportProgress={...base,state:'completed',phase:'activation',stepsDone:10,imported:10,result:{companyId:'c',imported:10,failed:[],skipped:0,dependentsImported:0,registersImported:{qualification:0,emergency:0},superiorFailed:[],fileErrors:[],warnings:[],runId:null,attemptId:base.attemptId}};
const failed:EmployeeImportProgress={...base,state:'failed',error:'No employee rows were written.',errors:[{rowNum:4,email:'a@fixture.test',message:'Refused'}]};
const respond=(job:EmployeeImportProgress)=>Promise.resolve(new Response(JSON.stringify({job}),{status:200,headers:{'content-type':'application/json'}}));
const harness=(messages:Record<string,unknown>,locale:string,job:EmployeeImportProgress,onFinished=vi.fn())=>({onFinished,...render(<NextIntlClientProvider locale={locale} messages={messages}><EmployeeImportJobPanel job={job} onFinished={onFinished}/></NextIntlClientProvider>)});

afterEach(()=>{vi.unstubAllGlobals();});

describe('EmployeeImportJobPanel',()=>{
 it('shows phase progress while importing and stays in the importing state',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(base)));
  harness(en as never,'en',base);
  const j=(en as never as {people:{import:{employeeJob:Record<string,string>}}}).people.import.employeeJob as unknown as {importing:string;backgroundHelp:string;phase:{employees:string}};
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(j.importing));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value','30');
  expect(screen.getByText(new RegExp(j.phase.employees))).toBeInTheDocument();
  expect(screen.getByText(j.backgroundHelp)).toBeInTheDocument();
 });

 it('hands a completed job to the result panel exactly once',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(completed)));
  const {onFinished}=harness(en as never,'en',{...base});
  await waitFor(()=>expect(onFinished).toHaveBeenCalledTimes(1));
  expect(onFinished.mock.calls[0][0]).toMatchObject({imported:10,failed:[],attemptId:base.attemptId});
 });

 it('reports a failed job with row-level reasons and no imported employees',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(failed)));
  const {onFinished}=harness(en as never,'en',{...base});
  await waitFor(()=>expect(onFinished).toHaveBeenCalledTimes(1));
  expect(onFinished.mock.calls[0][0]).toMatchObject({imported:0,failed:[{rowNum:4,email:'a@fixture.test',message:'Refused'}],fileErrors:['No employee rows were written.']});
 });

 it('keeps a queued job visibly waiting for the import service when no worker is running',async()=>{
  const queued:EmployeeImportProgress={...base,state:'queued',phase:null,stepsTotal:0,stepsDone:0,imported:0,worker:'unavailable'};
  vi.stubGlobal('fetch',vi.fn(()=>respond(queued)));
  const {onFinished}=harness(en as never,'en',queued);
  const j=(en as never as {people:{import:{employeeJob:{queued:string;workerUnavailable:string;backgroundHelp:string}}}}).people.import.employeeJob;
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(j.queued));
  expect(screen.getByText(j.workerUnavailable)).toBeInTheDocument();
  expect(screen.queryByText(j.backgroundHelp)).toBeNull();
  expect(onFinished).not.toHaveBeenCalled();
 });

 it('renders the shipping translation for another locale',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(base)));
  harness(zh as never,'zh',base);
  const j=(zh as never as {people:{import:{employeeJob:{importing:string}}}}).people.import.employeeJob;
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(j.importing));
 });
});
