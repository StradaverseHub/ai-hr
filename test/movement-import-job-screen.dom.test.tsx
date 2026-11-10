/** The Movement import screen follows a background confirmation (bulk-job kernel): progress while it runs, the same
 * result panel once it finishes, its refusal when it stops, and it rejoins a running import after navigation. */
import {fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import {MovementImport} from '../app/admin/personnel/import/movement-import';
import {MOVEMENT_IMPORT_ALREADY_RUNNING,type MovementImportJobProgress} from '../lib/movement-import-job';
const mocks=vi.hoisted(()=>({post:vi.fn(),jobs:vi.fn(),job:vi.fn()}));
const row=(row:number,employeeCode:string,status:'valid'|'imported')=>({row,employeeCode,eventType:'transfer',effectiveDate:'2026-11-01',status,errors:[],source:{sheet:'Movements',row},sourceRows:[row],companyCode:'EXT'});
const employee=(status:'valid'|'imported')=>({key:'company-a|GOOD',companyId:'company-a',companyName:'EXT · Fictional A',employeeCode:'GOOD',employmentId:'good',name:'Fictional valid',fingerprint:'good-fingerprint',rows:[row(2,'GOOD',status)]});
const preview={inputHash:'file-bound',selection:[2],fileErrors:[],valid:1,excluded:0,employees:[employee('valid')]};
const result={attemptId:'attempt-1',alreadyCommitted:false,imported:1,failed:0,excluded:0,byEventType:[],employees:[employee('imported')]};
const job=(state:MovementImportJobProgress['state'],extra:Partial<MovementImportJobProgress>={}):MovementImportJobProgress=>({id:'0b7c1c52-5a3e-4c55-9d7f-0c1d2e3f4a5b',sourceName:'movements.xlsx',state,stepsTotal:1,stepsDone:state==='completed'?1:0,imported:0,failed:0,attemptId:'attempt-1',error:null,result:null,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString(),worker:'running',...extra});
const response=(data:unknown,status=200)=>({ok:status<400,status,headers:new Headers({'content-type':'application/json'}),json:async()=>data});
function mount(){render(<NextIntlClientProvider locale="en" messages={en}><MovementImport/></NextIntlClientProvider>);}
beforeEach(()=>{
 vi.resetAllMocks();
 vi.stubGlobal('fetch',(url:string,init?:RequestInit)=>url==='/admin/personnel/import/movement/jobs'?mocks.jobs(url,init):url.startsWith('/admin/personnel/import/movement/jobs/')?mocks.job(url,init):mocks.post(url,init));
 mocks.jobs.mockResolvedValue(response({jobs:[]}));
 vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{fn();return 1;});
});
afterEach(()=>vi.unstubAllGlobals());
async function confirmCheckedFile(){
 mocks.post.mockResolvedValueOnce(response({ok:true,attemptId:'attempt-1',previewHash:'hash-1',preview}));
 mount();fireEvent.change(screen.getByLabelText(en.people.import.movement.file),{target:{files:[new File(['fictional bytes'],'movements.xlsx')]}});
 fireEvent.click(screen.getByRole('button',{name:'Check file'}));await screen.findByRole('heading',{name:'Review events before importing'});
 return screen.getByRole('button',{name:'Confirm and import selected events'});
}
describe('Movement import screen with a background confirmation',()=>{
 it('shows the job while it runs and then the same result panel, with a fresh operation key per confirmation',async()=>{
  const save=await confirmCheckedFile();
  mocks.post.mockResolvedValueOnce(response({ok:true,job:job('queued'),existing:false},202));
  mocks.job.mockResolvedValueOnce(response({job:job('importing')})).mockResolvedValue(response({job:job('completed',{result,imported:1})}));
  fireEvent.click(save);
  expect(await screen.findByText(en.people.import.movementJob.importing)).toBeInTheDocument();
  expect(screen.getByText('0 of 1 employees processed')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Confirm and import selected events'})).toBeDisabled();
  const body=mocks.post.mock.calls[1][1].body as FormData;expect(body.get('operation')).toBe('apply');expect(String(body.get('operationKey'))).toMatch(/^[0-9a-f-]{36}$/);
  expect(await screen.findByRole('heading',{name:'Import result'},{timeout:5000})).toBeInTheDocument();
  expect(screen.getByRole('link',{name:'View this import in Import History'})).toHaveAttribute('href','/admin/personnel/import/history/attempt-1');
 },15_000);
 it('shows why a stopped job saved nothing more, and names another running import of the same person',async()=>{
  const save=await confirmCheckedFile();
  mocks.post.mockResolvedValueOnce(response({ok:false,error:MOVEMENT_IMPORT_ALREADY_RUNNING},409));
  fireEvent.click(save);expect(await screen.findByText(en.people.import.movementJob.otherRunning)).toBeInTheDocument();
  mocks.post.mockResolvedValueOnce(response({ok:true,job:job('queued'),existing:false},202));
  mocks.job.mockResolvedValue(response({job:job('failed',{error:'Your permission for a company in this file has changed. Upload the file again.'})}));
  fireEvent.click(screen.getByRole('button',{name:'Confirm and import selected events'}));
  expect(await screen.findByText('Your permission for a company in this file has changed. Upload the file again.')).toBeInTheDocument();
 });
 it('rejoins a running import after navigation',async()=>{
  mocks.jobs.mockResolvedValue(response({jobs:[job('importing',{stepsTotal:4,stepsDone:1})]}));
  mocks.job.mockResolvedValue(response({job:job('importing',{stepsTotal:4,stepsDone:2})}));
  mount();
  expect(await screen.findByText('2 of 4 employees processed')).toBeInTheDocument();
  expect(screen.getByLabelText(en.people.import.movement.file)).toBeDisabled();
 });
});
