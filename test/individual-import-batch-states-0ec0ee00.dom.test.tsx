/**
 * Board 0ec0ee00, stage 2 — the Import Log batch page as the reviewer will see it: a large upload in progress, completed,
 * stopped part-way (with Revert), being reverted, and refused for too many rows. Rendered with the real English
 * catalogue; the readers are stubbed with fictional figures.
 */
import {cloneElement,isValidElement,type ReactElement,type ReactNode} from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';

const m=vi.hoisted(()=>({readJob:vi.fn(),summary:vi.fn()}));
vi.mock('next-intl/server',async()=>{
 const {createTranslator:tr,createFormatter:fmt}=await import('next-intl');const messages=(await import('../messages/en.json')).default;
 return {getTranslations:async(namespace?:string)=>tr({locale:'en',messages,namespace:namespace as never}),getFormatter:async()=>fmt({locale:'en',timeZone:'Asia/Kuala_Lumpur'}),getLocale:async()=>'en'};
});
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('notFound');},useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:{userId:'viewer'},scopeIds:['company-a']})}));
vi.mock('@/packs/payroll/service',()=>({readIndividualImportJob:m.readJob,readIndividualImportSummary:m.summary}));
vi.mock('../app/payroll/transactions/individual/imports/[attemptId]/result-rows',()=>({IndividualImportRows:()=>null}));
vi.mock('../app/payroll/transactions/individual/imports/batches/[jobId]/batch-controls',()=>({ImportBatchControls:()=>null}));
vi.mock('../app/payroll/transactions/import-excel/individual-actions',()=>({revertIndividualImportAction:vi.fn()}));

import ImportBatchPage from '../app/payroll/transactions/individual/imports/batches/[jobId]/page';

async function resolveAsync(node:ReactNode):Promise<ReactNode>{
 if(Array.isArray(node))return Promise.all(node.map(resolveAsync));
 if(!isValidElement(node))return node;
 const element=node as ReactElement<{children?:ReactNode}>;
 if(typeof element.type==='function'&&element.type.constructor.name==='AsyncFunction')return resolveAsync(await (element.type as (props:unknown)=>Promise<ReactNode>)(element.props));
 return element.props.children===undefined?element:cloneElement(element,undefined,await resolveAsync(element.props.children));
}
const JOB='7f21c0a4-4b8e-4d21-9a6f-0c5e8b13d7a2',ATTEMPT='9e01b7c4-3c2a-4f00-8a1b-5d6e7f809a1b';
const t=en.payroll.individualImport;
const job=(over:Record<string,unknown>={})=>({id:JOB,source_name:'individual-monthly-transactions-nov.xlsx',created_by:'creator',created_at:new Date('2026-11-30T01:02:00Z'),
 started_at:new Date('2026-11-30T01:02:00Z'),finished_at:null,attempt_id:ATTEMPT,state:'importing',processed:3_780,total:9_000,written:3_768,failed_rows:12,reverted_rows:0,
 method:'monthly',error:null,created_by_actor:{kind:'person',name:'Sample User',employeeCode:'100900'},...over});
const summary=(over:Record<string,unknown>={})=>({id:ATTEMPT,sourceName:'individual-monthly-transactions-nov.xlsx',method:'monthly',createdAt:'2026-11-30T01:02:00.000Z',state:'importing',
 total:9_000,valid:8_988,invalid:12,processed:3_780,written:3_768,failed:12,revertedCount:0,fileError:null,revertedAt:null,periods:['2026-11'],cycles:['M1'],hasErrors:true,
 createdByActor:{kind:'person',name:'Sample User',employeeCode:'100900'},revertedByActor:null,jobId:JOB,events:[],...over});
const page=async()=>render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur">{await resolveAsync(await ImportBatchPage({params:Promise.resolve({jobId:JOB}),searchParams:Promise.resolve({})}))}</NextIntlClientProvider>);
const cell=(label:string)=>screen.getByText(label,{selector:'dt'}).nextElementSibling?.textContent;

beforeEach(()=>{vi.clearAllMocks();});
afterEach(cleanup);

describe('Import Log batch at scale (0ec0ee00)',()=>{
 it('shows a large upload in progress: percent, rows done, the four counts and that the page may be left',async()=>{
  m.readJob.mockResolvedValue(job());m.summary.mockResolvedValue(summary());
  await page();
  expect(screen.getByRole('status')).toHaveTextContent(t.batchState.importing);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow','42');
  expect(screen.getByText('42% · 3,780 of 9,000 rows done')).toBeInTheDocument();
  expect([cell(t.totalRows),cell(t.importedRows),cell(t.failedRows),cell(t.remainingRows)]).toEqual(['9,000','3,768','12','5,220']);
  expect(screen.getByText(t.leavePage)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:t.revert})).toBeNull();
 });
 it('shows a completed import at 100% with nothing remaining',async()=>{
  m.readJob.mockResolvedValue(job({state:'completed',processed:9_000,written:8_988,finished_at:new Date('2026-11-30T01:20:00Z')}));
  m.summary.mockResolvedValue(summary({state:'completed',processed:9_000,written:8_988}));
  await page();
  expect(screen.getByRole('status')).toHaveTextContent(t.completedWithErrors);
  expect(screen.getByText('100% · 9,000 of 9,000 rows done')).toBeInTheDocument();
  expect(cell(t.remainingRows)).toBe('0');
  expect(screen.queryByText(t.leavePage)).toBeNull();
  expect(screen.getByRole('button',{name:t.revert})).toBeDisabled();
 });
 it('says a stopped import kept the rows it wrote, and offers Revert for exactly those rows',async()=>{
  m.readJob.mockResolvedValue(job({state:'stopped',processed:3_780,error:'importFailed',finished_at:new Date('2026-11-30T01:10:00Z')}));
  m.summary.mockResolvedValue(summary({state:'stopped'}));
  await page();
  expect(screen.getByRole('status')).toHaveTextContent(t.batchState.stopped);
  expect(screen.getByRole('alert')).toHaveTextContent('This import stopped before it finished. 3,768 rows were imported and stay in payroll');
  expect(screen.getByText(/Only its 3768 imported transactions will be reversed/)).toBeInTheDocument();
  expect(screen.getByRole('button',{name:t.revert})).toBeInTheDocument();
 });
 it('shows a revert in progress as rows removed out of the rows imported',async()=>{
  m.readJob.mockResolvedValue(job({state:'reverting',processed:9_000,written:8_988,reverted_rows:2_000}));
  m.summary.mockResolvedValue(summary({state:'reverting',processed:9_000,written:8_988,revertedCount:2_000}));
  await page();
  expect(screen.getByRole('status')).toHaveTextContent(t.batchState.reverting);
  expect(screen.getByText('22% · 2,000 of 8,988 imported rows removed')).toBeInTheDocument();
  expect(screen.getByText(t.leavePageRevert)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:t.revert})).toBeNull();
 });
 it('refuses a file with too many transactions with its own message, never as too large',async()=>{
  m.readJob.mockResolvedValue(job({state:'failed',attempt_id:null,processed:0,total:0,written:0,failed_rows:0,error:'tooManyRows',source_name:'full-year-transactions.xlsx'}));
  await page();
  expect(screen.getByRole('status')).toHaveTextContent(t.batchState.failed);
  expect(screen.getByRole('alert')).toHaveTextContent('This file has more than 10,000 transactions. One upload can hold at most 10,000.');
  expect(screen.queryByText(/larger than 10 MB/)).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.getByRole('link',{name:t.downloadWorkbook})).toHaveAttribute('href',`/payroll/transactions/individual/imports/batches/${JOB}/workbook`);
 });
});
