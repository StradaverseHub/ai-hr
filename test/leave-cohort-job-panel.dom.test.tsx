import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,type IntlError} from 'next-intl';
import en from '../messages/en.json';
import type {LeaveCohortJobProgress} from '../lib/leave-cohort-job';

const refresh=vi.fn();
vi.mock('next/navigation',()=>({useRouter:()=>({refresh,push:vi.fn(),replace:vi.fn()})}));
const success=vi.fn(),failure=vi.fn();
vi.mock('sonner',()=>({toast:{success:(m:string)=>success(m),error:(m:string)=>failure(m)}}));
import {LeaveCohortJobPanel} from '../components/leave/leave-cohort-job-panel';

afterEach(()=>{cleanup();vi.unstubAllGlobals();success.mockReset();failure.mockReset();refresh.mockReset();});
const running:LeaveCohortJobProgress={id:'00000000-0000-4000-8000-000000000002',kind:'leave_accrual',state:'running',total:3000,done:600,failedEmployees:0,error:null,
 updatedAt:new Date().toISOString(),result:null,worker:'running'};
function panel(job:LeaveCohortJobProgress,onDone=vi.fn()){
 const errors:string[]=[];
 render(<NextIntlClientProvider locale="en" messages={en} onError={(e:IntlError)=>errors.push(e.message)}><LeaveCohortJobPanel job={job} onDone={onDone}/></NextIntlClientProvider>);
 expect(errors).toEqual([]);
 return onDone;
}
const respond=(job:LeaveCohortJobProgress)=>vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({job}),{status:200})));

describe('background leave processing panel',()=>{
 it('shows the run and its progress in the viewer language',async()=>{
  respond({...running,done:1500});
  panel(running);
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(screen.getByText(en.admin.leave.processingJob.title.leave_accrual)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(en.admin.leave.processingJob.state.running);
  expect(screen.getByText('1500 of 3000 employees processed')).toBeTruthy();
 });
 it('ends Run Earned Accrual with the same toast the synchronous run showed, and reports employees left unchanged',async()=>{
  respond({...running,state:'completed',done:3000,failedEmployees:20,error:'Leave source is unavailable; review it again.',result:{granted:2950,forfeits:12}});
  const done=panel(running);
  await vi.waitFor(()=>expect(done).toHaveBeenCalled());
  expect(success).toHaveBeenCalledWith('2950 entitlement top-up(s) generated, 12 carry-forfeit(s).');
  expect(failure).toHaveBeenCalledWith('20 employee(s) could not be processed and were left unchanged: Leave source is unavailable; review it again. Run it again to complete them.');
  expect(refresh).toHaveBeenCalled();
  expect(screen.queryByRole('status')).toBeNull();
 });
 it('ends Generate Entitlement with the generation message composed from the job result',async()=>{
  const result={year:2027,employeesSelected:2,employeesReached:2,employeesPassed:2,employeesFailed:0,granted:4,skipped:0,forfeits:1,lines:[],decidedBy:[],accrual:null};
  respond({...running,kind:'leave_generation',state:'completed',done:2,total:2,result});
  panel({...running,kind:'leave_generation'});
  await vi.waitFor(()=>expect(success).toHaveBeenCalled());
  expect(success.mock.calls[0][0]).toContain('Leave year 2027: 4 entitlement record(s) granted');
  expect(failure).not.toHaveBeenCalled();
 });
 it('says a queued run is waiting when no background service serves it',async()=>{
  const queued={...running,state:'queued' as const,done:0,worker:'unavailable' as const};
  respond(queued);
  panel(queued);
  await act(async()=>{await Promise.resolve();await Promise.resolve();});
  expect(screen.getByText(en.admin.leave.processingJob.waiting)).toBeTruthy();
 });
});
