import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,type IntlError} from 'next-intl';
import en from '../messages/en.json';
import {LeaveImportJobPanel} from '../app/admin/leave/import/leave-import-progress';
import type {LeaveImportJobProgress} from '../lib/leave-import-job';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const running:LeaveImportJobProgress={id:'00000000-0000-4000-8000-000000000001',state:'importing',total:4,done:1,updatedAt:new Date().toISOString(),result:null,worker:'running'};
function panel(onFinished=vi.fn()){
 const errors:string[]=[];
 render(<NextIntlClientProvider locale="en" messages={en} onError={(e:IntlError)=>errors.push(e.message)}><LeaveImportJobPanel job={running} onFinished={onFinished}/></NextIntlClientProvider>);
 expect(errors).toEqual([]);
 return onFinished;
}
describe('background leave import panel',()=>{
 it('shows progress in the viewer language while the job runs',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({job:{...running,done:2}}),{status:200})));
  panel();
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(screen.getByRole('status')).toHaveTextContent(en.admin.leave.import.job.state.importing);
  expect(screen.getByText('2 of 4 rows processed')).toBeInTheDocument();
 });
 it('hands the finished result to the existing result panel',async()=>{
  const result={imported:4,failed:[],skipped:0,totalRows:4};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({job:{...running,state:'completed',done:4,result}}),{status:200})));
  const finished=panel();
  await vi.waitFor(()=>expect(finished).toHaveBeenCalledWith(result));
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
 });
});
describe('background leave import panel while no import service runs',()=>{
 it('says the queued import is waiting instead of running',async()=>{
  const queued={...running,state:'queued' as const,done:0,worker:'unavailable' as const};
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({job:queued}),{status:200})));
  render(<NextIntlClientProvider locale="en" messages={en}><LeaveImportJobPanel job={queued} onFinished={vi.fn()}/></NextIntlClientProvider>);
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(screen.getByText(en.admin.leave.import.job.waiting)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(en.admin.leave.import.job.state.queued);
 });
});
