/** Real browser/CSS, synthetic HTTP projections; DB/API security is checked in the companion suites. */
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react';
import {page} from 'vitest/browser';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {BankImportProgress} from '../app/(app)/admin/personnel/import/bank-import-progress';
import type {BankImportProgress as Progress} from '../lib/bank-import-job';
import '../app/globals.css';
const base:Progress={id:'11111111-1111-4111-8111-111111111111',sourceName:'bank-statutory-100001.csv',state:'importing',total:100001,validated:100001,valid:100001,invalid:0,unchanged:0,processed:50001,saved:50001,failed:0,uploadedBytes:2000000,sourceBytes:2000000,attemptId:null,error:null,updatedAt:new Date().toISOString(),createdAt:new Date().toISOString()};
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows durable 100k-row progress at mobile width and joins a duplicate upload without posting its contents',async()=>{
 await page.viewport(390,844);
 const original=globalThis.fetch,requests:{method:string;body:unknown}[]=[];
 vi.stubGlobal('fetch',async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);if(!url.startsWith('/admin/personnel/import/bank-statutory/jobs'))return original(input,init);
  requests.push({method:init?.method??'GET',body:init?.body});
  return Response.json(init?.method==='POST'?{job:base,existing:true}:url.endsWith('/jobs')?{jobs:[base]}:{job:base,rows:[]});
 });
 render(<NextIntlClientProvider locale="en" messages={en}><BankImportProgress/></NextIntlClientProvider>);
 expect(await screen.findByText('Importing')).toBeVisible();expect(screen.getByRole('progressbar')).toHaveAttribute('value','50');
 expect(screen.getByText('You can leave this page. Progress is saved and the import continues.')).toBeVisible();
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
 const csv='employee_code,tax_number\n'+Array.from({length:100001},(_,i)=>`EMP${i},T${i}\n`).join('');
 const transfer=new DataTransfer();transfer.items.add(new File([csv],'bank-statutory-100001.csv',{type:'text/csv'}));
 fireEvent.change(screen.getByLabelText(en.people.import.uploadFile),{target:{files:transfer.files}});
 expect(await screen.findByText('This file already has an active import. Showing its existing progress.')).toBeVisible();
 await waitFor(()=>expect(requests.filter(r=>r.method==='POST')).toHaveLength(1));
 expect(requests.some(r=>r.method==='PUT')).toBe(false);
 expect(JSON.parse(String(requests.find(r=>r.method==='POST')!.body)).bytes).toBe(new Blob([csv]).size);
 console.info('Bank import progress screenshot:',await page.screenshot({animations:'disabled',path:'../.vitest-attachments/bank-import-progress-mobile.png'}));
});
