/** The revert control follows a background employee import revert to its outcome: it stays busy while the job runs,
 * refreshes the page when it completes, and shows the revert's own refusal and blockers when it fails. */
import {render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import en from '../messages/en.json';
import {ImportRevertControl} from '../app/admin/personnel/import/history/import-revert-control';

const mocks=vi.hoisted(()=>({refresh:vi.fn(),preview:vi.fn(),revert:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
vi.mock('../app/admin/personnel/import/history/actions',()=>({previewImportRevertAction:mocks.preview,revertImportAction:mocks.revert}));
const job=(state:string,extra:Record<string,unknown>={})=>({id:'00000000-0000-4000-8000-000000000009',state,attemptId:'a',error:null,blockers:[],restored:null,...extra});
function mount(){render(<NextIntlClientProvider locale="en" messages={en}><ImportRevertControl attemptId="a" activeJobId="00000000-0000-4000-8000-000000000009"/></NextIntlClientProvider>);}
beforeEach(()=>{vi.resetAllMocks();});

describe('ImportRevertControl with a background revert',()=>{
 it('stays busy while the revert runs and refreshes the page when it completes',async()=>{
  const responses=[job('finalizing'),job('completed',{restored:3})];
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({job:responses.shift()??job('completed')}),{status:200})));
  mount();
  expect(screen.getByRole('button',{name:en.people.importHistory.revert.working})).toBeDisabled();
  await waitFor(()=>expect(mocks.refresh).toHaveBeenCalledOnce(),{timeout:5000});
 });
 it('shows the revert\'s own refusal and its blockers when the job fails',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({job:job('failed',{error:'This import cannot be reverted because some records changed after it.',blockers:[{itemId:'',label:'RV001 · Fictional',reason:'has leave applications or leave balance entries'}]})}),{status:200})));
  mount();
  expect(await screen.findByText('This import cannot be reverted because some records changed after it.')).toBeInTheDocument();
  expect(screen.getByText('RV001 · Fictional')).toBeInTheDocument();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:en.people.importHistory.revert.review})).toBeEnabled();
 });
});
