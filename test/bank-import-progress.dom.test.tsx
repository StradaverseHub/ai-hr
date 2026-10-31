import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {BankImportProgress} from '../app/(app)/admin/personnel/import/bank-import-progress';
import type {BankImportProgress as Progress} from '../lib/bank-import-job';
const job:Progress={id:'11111111-1111-4111-8111-111111111111',sourceName:'bank.csv',state:'importing',total:100001,validated:100001,valid:100000,invalid:0,unchanged:1,processed:50001,saved:50000,failed:0,uploadedBytes:100,sourceBytes:100,attemptId:null,error:null,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
const response=(data:unknown)=>Promise.resolve({ok:true,json:()=>Promise.resolve(data)} as Response);
const view=()=>render(<NextIntlClientProvider locale="en" messages={en}><BankImportProgress/></NextIntlClientProvider>);
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('background import progress',()=>{
 it('reopens durable progress after a page reload and explains that work continues',async()=>{
  const fetch=vi.fn((url:string)=>response(url.endsWith('/jobs')?{jobs:[job]}:{job,rows:[]}));vi.stubGlobal('fetch',fetch);view();
  expect(await screen.findByText('Importing')).toBeVisible();expect(await screen.findByText('You can leave this page. Progress is saved and the import continues.')).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute('value','50');expect(screen.getByText(/50,?000 rows saved/)).toBeVisible();
 });
 it('never confirms automatically and exposes a separate explicit confirmation after validation',async()=>{
  const ready={...job,state:'ready',processed:0,saved:0};const fetch=vi.fn((url:string,init?:RequestInit)=>response(url.endsWith('/jobs')?{jobs:[ready]}:{job:init?.method==='POST'?job:ready,rows:[]}));vi.stubGlobal('fetch',fetch);view();
  const confirm=await screen.findByRole('button',{name:/Confirm 100,?000 updates/});
  expect(fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);fireEvent.click(confirm);
  await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>init?.body===JSON.stringify({command:'confirm'}))).toBe(true));
 });
 it('caps preview rendering at the server page and exposes next-page controls',async()=>{
  const rows=Array.from({length:100},(_,i)=>({ordinal:i+1,state:'valid',error:null,preview:{employeeCode:`E${i}`,employeeName:`Employee ${i}`,changes:['tax_number'],errors:[]}}));
  const fetch=vi.fn((url:string)=>response(url.endsWith('/jobs')?{jobs:[{...job,state:'ready'}]}:{job:{...job,state:'ready'},rows}));vi.stubGlobal('fetch',fetch);view();
  expect(await screen.findByText('Employee 99')).toBeVisible();expect(screen.getAllByRole('row')).toHaveLength(101);
  fireEvent.click(screen.getByRole('button',{name:'Next'}));await waitFor(()=>expect(fetch.mock.calls.some(([url])=>url.endsWith('?page=1'))).toBe(true));
 });
});
