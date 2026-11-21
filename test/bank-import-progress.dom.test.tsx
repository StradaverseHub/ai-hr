import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {BankImportProgress} from '../app/admin/personnel/import/bank-import-progress';
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
 it('d3ba1e9f: shows the Error Log lines with Excel rows and hidden bank values, and downloads the localized Error Log',async()=>{
  const ready={...job,state:'ready' as const,total:3,validated:3,valid:1,invalid:2,unchanged:0,processed:0,saved:0};
  const rows=[{ordinal:1,state:'invalid',error:null,preview:{employeeCode:'EMP-0001',employeeName:'Fictional Aina',changes:[],errors:['bank_name and bank_account_no must be provided together']}},{ordinal:2,state:'valid',error:null,preview:{employeeCode:'EMP-0002',employeeName:'Fictional Wei',changes:['tax_number'],errors:[]}}];
  const problems={rows:[{ordinal:1,state:'invalid',error:null,record:{employee_code:'EMP-0001',bank_account_no:'*'},preview:rows[0].preview},{ordinal:3,state:'invalid',error:'Duplicate Employee ID in this file; first used at row 1.',record:{employee_code:'EMP-0001'},preview:{employeeCode:'EMP-0001',employeeName:'Fictional Aina',errors:[]}}],total:2,error:null};
  const fetch=vi.fn((url:string)=>response(url.endsWith('/jobs')?{jobs:[ready]}:url.endsWith('/problems')?problems:{job:ready,rows}));vi.stubGlobal('fetch',fetch);view();
  const fix=await screen.findByText(en.importErrorLogDataBankCostInfo.corrections.bankPair);
  const table=fix.closest('table')!;
  expect(within(table).getAllByRole('columnheader').map(h=>h.textContent)).toEqual(['Excel row','Reference','Employee name','Field','Value entered','What is wrong','How to fix it','Found while','Result']);
  const [first,second]=within(table).getAllByRole('row').slice(1).map(r=>within(r).getAllByRole('cell').map(c=>c.textContent));
  expect(first[0]).toBe('2');expect(first[4]).toBe('(hidden)');expect(first[5]).toBe('bank_name and bank_account_no must be provided together');expect(first[8]).toBe('Not imported');
  expect(second[0]).toBe('4');expect(second[5]).toBe('Duplicate Employee ID in this file; first used at Excel row 2.');
  expect(document.body.textContent).not.toContain('first used at row 1.');
  expect(screen.getByRole('link',{name:'Download Error Log'})).toHaveAttribute('href',`/admin/personnel/import/bank-statutory/jobs/${job.id}/error-log`);
  // The preview's row column is the Excel row too.
  expect(screen.getByText('Fictional Wei').closest('tr')!.firstElementChild!.textContent).toBe('3');
  expect(fetch.mock.calls.filter(([url])=>url.endsWith('/problems'))).toHaveLength(1);
 });
});
