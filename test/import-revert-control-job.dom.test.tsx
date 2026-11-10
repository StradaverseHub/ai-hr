/** The Import History revert control follows a background movement revert (core/movement-import-revert-job.ts): it
 * stays busy while the job runs, refreshes the page when it completes, shows the refusal and its blockers when it stops,
 * and rejoins a running revert after navigation. */
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
const mocks=vi.hoisted(()=>({preview:vi.fn(),revert:vi.fn(),refresh:vi.fn(),job:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/admin/personnel/import/history/actions',()=>({previewImportRevertAction:mocks.preview,revertImportAction:mocks.revert}));
import {ImportRevertControl} from '../app/admin/personnel/import/history/import-revert-control';
const r=en.people.importHistory.revert;
const response=(data:unknown,status=200)=>({ok:status<400,status,json:async()=>data});
const progress=(state:string,extra:Record<string,unknown>={})=>({id:'job-1',state,attemptId:'attempt-1',error:null,blockers:[],restored:null,...extra});
function mount(activeJobId?:string){render(<NextIntlClientProvider locale="en" messages={en}><ImportRevertControl attemptId="attempt-1" activeJobId={activeJobId??null}/></NextIntlClientProvider>);}
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('fetch',(url:string)=>mocks.job(url));
 mocks.preview.mockResolvedValue({ok:true,result:{attemptId:'attempt-1',kind:'movement',eligible:true,items:[{itemId:'i1',label:'AC001 · Fictional · Promotion',restore:{fields:[]}}],blockers:[],previewHash:'a'.repeat(64)}});});
afterEach(()=>vi.unstubAllGlobals());
async function confirm(){
 mount();fireEvent.click(screen.getByRole('button',{name:r.review}));
 await screen.findByText('AC001 · Fictional · Promotion');
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Fictional wrong batch'}});
 fireEvent.click(screen.getByRole('checkbox'));
 fireEvent.click(screen.getByRole('button',{name:r.confirm}));
}
describe('Import History revert control with a background revert',()=>{
 it('stays busy while the job runs and refreshes the page when it completes',async()=>{
  mocks.revert.mockResolvedValue({ok:true,result:{job:progress('queued')}});
  mocks.job.mockResolvedValueOnce(response({job:progress('running')})).mockResolvedValue(response({job:progress('completed',{restored:1})}));
  await confirm();
  await waitFor(()=>expect(mocks.refresh).toHaveBeenCalled(),{timeout:5000});
  expect(mocks.revert).toHaveBeenCalledWith('attempt-1','a'.repeat(64),'Fictional wrong batch');
  expect(mocks.job.mock.calls[0][0]).toBe('/admin/personnel/import/history/revert-jobs/job-1');
 },15_000);
 it('shows a stopped revert\'s refusal and blockers, and rejoins a running revert after navigation',async()=>{
  mocks.revert.mockResolvedValue({ok:true,result:{job:progress('queued')}});
  mocks.job.mockResolvedValue(response({job:progress('failed',{error:'This import cannot be reverted because some records changed after it.',blockers:[{itemId:'',label:'AC001 · Fictional',reason:'Grade has been changed since this import.'}]})}));
  await confirm();
  expect(await screen.findByText('This import cannot be reverted because some records changed after it.')).toBeInTheDocument();
  expect(screen.getByText(/Grade has been changed since this import/)).toBeInTheDocument();
 },15_000);
 it('rejoins a running revert after navigation and keeps the review closed while it runs',async()=>{
  mocks.job.mockResolvedValue(response({job:progress('running')}));
  mount('job-1');
  await waitFor(()=>expect(mocks.job).toHaveBeenCalled());
  expect(screen.getByRole('button',{name:r.working})).toBeDisabled();
 });
});
