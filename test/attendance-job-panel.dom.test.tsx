/** The attendance background-job panel (Import Clocking Data, Recompute Attendance; draft 9940): polling, progress,
 * the waiting states and a single hand-off of the finished job, under the shipping catalogues. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {render,screen,waitFor} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import th from '../messages/th.json';
import {AttendanceJobPanel} from '../app/attendance/attendance-job-panel';
import type {AttendanceJobProgress} from '../lib/attendance-bulk-job';

type Job=AttendanceJobProgress<{runId:string}>;
const now=new Date().toISOString();
const running:Job={id:'11111111-1111-4111-8111-111111111111',kind:'clocking_import',state:'running',phase:'employees',sourceName:'device.csv',stepsTotal:40,stepsDone:10,
 counters:{},error:null,errors:[],result:null,cancelRequested:false,createdAt:now,updatedAt:now,finishedAt:null,errorCode:null,worker:'running'};
const completed:Job={...running,state:'completed',stepsDone:40,result:{runId:'22222222-2222-4222-8222-222222222222'}};
const respond=(job:Job)=>Promise.resolve(new Response(JSON.stringify({job}),{status:200,headers:{'content-type':'application/json'}}));
const tOf=(messages:Record<string,unknown>,locale:string,namespace:string)=>{const t=createTranslator({locale,messages,namespace:namespace as never});return (key:string,values?:Record<string,string|number>)=>(t as unknown as (k:string,v?:Record<string,string|number>)=>string)(key,values);};

afterEach(()=>{vi.unstubAllGlobals();});

describe('AttendanceJobPanel',()=>{
 it('shows the clocking import\'s state, employees done and what to expect while it runs',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>respond(running)));
  const t=tOf(en as never,'en','clockingFile.import.job');
  render(<AttendanceJobPanel job={running} endpoint="/attendance/import/jobs" title={running.sourceName} t={t} onFinished={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByRole('status')).toHaveTextContent(t('running')));
  expect(screen.getByRole('progressbar')).toHaveAttribute('value','25');
  expect(screen.getByText(t('progressCount',{done:10,total:40}))).toBeInTheDocument();
  expect(screen.getByText(t('backgroundHelp'))).toBeInTheDocument();
 });
 it('says a queued job waits for the import service when no worker is reporting in',async()=>{
  const queued:Job={...running,state:'queued',stepsDone:0,stepsTotal:0,worker:'unavailable'};
  vi.stubGlobal('fetch',vi.fn(()=>respond(queued)));
  const t=tOf(th as never,'th','attendance.recompute.job');
  render(<AttendanceJobPanel job={queued} endpoint="/attendance/recompute/jobs" title={t('previewTitle')} t={t} onFinished={vi.fn()}/>);
  await waitFor(()=>expect(screen.getByText(t('workerUnavailable'))).toBeInTheDocument());
  expect(screen.getByRole('status')).toHaveTextContent(t('queued'));
 });
 it('hands the finished job back exactly once and stops polling',async()=>{
  const fetch=vi.fn(()=>respond(completed));vi.stubGlobal('fetch',fetch);
  const onFinished=vi.fn();
  render(<AttendanceJobPanel job={running} endpoint="/attendance/import/jobs" title={running.sourceName} t={tOf(en as never,'en','clockingFile.import.job')} onFinished={onFinished}/>);
  await waitFor(()=>expect(onFinished).toHaveBeenCalledTimes(1));
  expect(onFinished.mock.calls[0][0]).toMatchObject({state:'completed',result:{runId:completed.result!.runId}});
  expect(fetch).toHaveBeenCalledWith(`/attendance/import/jobs/${running.id}`,{cache:'no-store'});
  await new Promise(resolve=>setTimeout(resolve,50));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('progressbar')).toBeNull();
 });
});
