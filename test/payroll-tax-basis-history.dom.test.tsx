/** a16382b4 — Recalculate Income Tax Value: history as the page's history view (same route, no new linkable page), searchable company picker and progress from
 * recorded work. Service reads are mocked here; their SQL is proven in payroll-tax-basis(-history).test.ts. */
import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider,createFormatter,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {TaxBasisWorkflow,type TaxBasisOptions} from '../app/payroll/income-tax-recalculation/workflow';
import {TaxBasisHistory} from '../app/payroll/income-tax-recalculation/history-table';
import TaxBasisPage from '../app/payroll/income-tax-recalculation/page';
import type {TaxBasisHistoryRow} from '../lib/payroll-tax-basis';

const mocks=vi.hoisted(()=>({groupPreview:vi.fn(),groupConfirm:vi.fn(),groupProgress:vi.fn(),push:vi.fn(),refresh:vi.fn(),options:vi.fn(),get:vi.fn(),history:vi.fn(),queued:vi.fn()}));
vi.mock('../app/payroll/income-tax-recalculation/actions',()=>({queueTaxBasisGroupPreviewAction:mocks.groupPreview,taxBasisGroupProgressAction:mocks.groupProgress,queueTaxBasisGroupConfirmationAction:mocks.groupConfirm,searchCurrentTaxBasisEmployeesAction:vi.fn(async()=>[])}));
vi.mock('../packs/payroll/service',()=>({taxBasisOptions:mocks.options,getTaxBasisBatch:mocks.get,listTaxBasisHistory:mocks.history,listQueuedTaxBasisRuns:mocks.queued}));
vi.mock('../lib/authz',()=>({requirePayrollAccess:async()=>({tenantId:'tenant-a',userId:'actor-a'})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push,refresh:mocks.refresh}),notFound:()=>{throw Error('NEXT_NOT_FOUND');}}));
vi.mock('next/link',()=>({default:({href,children,...props}:any)=><a href={href} {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never}),getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'})}));
const catalogs={en,ms,zh,ta,th,vi:viMessages};
const T=en.payrollTaxBasis;
function wrap(child:ReactNode,locale:keyof typeof catalogs='en'){return <NextIntlClientProvider locale={locale} messages={catalogs[locale]} timeZone="Asia/Kuala_Lumpur">{child}</NextIntlClientProvider>;}
const companies:TaxBasisOptions['companies']=[
 {id:'company-a',name:'Harbour Foods Sdn Bhd',code:'HFD01'},
 {id:'company-b',name:'Harbourview Properties Sdn Bhd',code:'HBX02'},
 {id:'company-c',name:'Northwind Logistics Sdn Bhd',code:'NWL03'},
 {id:'company-d',name:'Coastal Retail Sdn Bhd',code:null,canRecalculate:false},
];
const options:TaxBasisOptions={companies,employees:[],years:[2026],canRecalculate:true};
function row(overrides:Partial<TaxBasisHistoryRow>={}):TaxBasisHistoryRow{
 return {id:'run-1:company-a',kind:'batch',reference:'TAX-B1',companyId:'company-a',companyName:'Harbour Foods Sdn Bhd',year:2026,upToMonth:8,status:'completed',
  createdAt:'2026-11-23 14:10:00+08',completedAt:'2026-11-23 14:14:00+08',actorName:'Payroll Admin A',employeeCount:96,processedCount:96,completedCount:96,failedCount:0,
  notIncludedCount:2,interrupted:false,batches:[{id:'b1111111-1111-4111-8111-111111111111',reference:'TAX-B1'}],...overrides};
}
afterEach(()=>{cleanup();vi.useRealTimers();vi.resetAllMocks();});
/** MultiSelectPopover filters rows with the `hidden` class on the row label; jsdom loads no stylesheet (see r287 test). */
const offered=(name:string)=>!screen.getByRole('checkbox',{name}).closest('label')!.className.split(/\s+/).includes('hidden');

describe('history navigation',()=>{
 it('opens history from a button at the top of the page and no longer lists it below the workflow',async()=>{
  mocks.options.mockResolvedValue(options);
  render(wrap(await TaxBasisPage({searchParams:Promise.resolve({})})));
  expect(screen.getByRole('link',{name:T.history})).toHaveAttribute('href','/payroll/income-tax-recalculation?view=history');
  expect(screen.queryByRole('table')).toBeNull();
 });
 it('shows queued rows first on the first page, a back link, and keyset paging without queued rows on later pages',async()=>{
  mocks.queued.mockResolvedValue([row({id:'queued:run-2:company-c',kind:'queued',reference:null,companyId:'company-c',companyName:'Northwind Logistics Sdn Bhd',status:'pending',completedAt:null,employeeCount:152,processedCount:0,completedCount:0,notIncludedCount:4,batches:[]})]);
  mocks.history.mockResolvedValue({rows:[row()],next:{createdAt:'2026-11-20 09:02:00.123+08',id:'run-0:company-a'}});
  render(wrap(await TaxBasisPage({searchParams:Promise.resolve({view:'history'})})));
  expect(mocks.history).toHaveBeenCalledExactlyOnceWith(expect.anything(),{cursor:null});
  expect(screen.getByRole('link',{name:'← '+T.backRecalculation})).toHaveAttribute('href','/payroll/income-tax-recalculation');
  const rows=screen.getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText(T.queuedReference)).toBeVisible();
  expect(within(rows[0]).getByText(T.waitingToStart)).toBeVisible();
  expect(within(rows[1]).getByText('TAX-B1')).toBeVisible();
  const next=screen.getByRole('link',{name:T.historyNextPage});
  const nextUrl=new URL(next.getAttribute('href')!,'https://example.test');
  expect(nextUrl.pathname).toBe('/payroll/income-tax-recalculation');
  expect(nextUrl.searchParams.get('view')).toBe('history');
  expect(nextUrl.searchParams.get('after')).toBe('2026-11-20 09:02:00.123+08');
  expect(nextUrl.searchParams.get('key')).toBe('run-0:company-a');
  // The history view reads no workflow options.
  expect(mocks.options).not.toHaveBeenCalled();
  expect(screen.queryByRole('link',{name:T.historyFirstPage})).toBeNull();
  cleanup();mocks.queued.mockClear();mocks.history.mockResolvedValue({rows:[row()],next:null});
  render(wrap(await TaxBasisPage({searchParams:Promise.resolve({view:'history',after:'2026-11-20 09:02:00.123+08',key:'run-0:company-a'})})));
  expect(mocks.queued).not.toHaveBeenCalled();
  expect(mocks.history).toHaveBeenLastCalledWith(expect.anything(),{cursor:{createdAt:'2026-11-20 09:02:00.123+08',id:'run-0:company-a'}});
  expect(screen.getByRole('link',{name:T.historyFirstPage})).toHaveAttribute('href','/payroll/income-tax-recalculation?view=history');
 });
});

describe('history rows',()=>{
 it('shows actual progress, never 100% while a run is unfinished, and refreshes only while something is moving',async()=>{
  vi.useFakeTimers();
  render(wrap(<TaxBasisHistory rows={[
   row({id:'run-3:company-c',companyName:'Northwind Logistics Sdn Bhd',status:'processing',completedAt:null,employeeCount:152,processedCount:17,completedCount:16,failedCount:1,
    batches:[{id:'b2',reference:'TAX-B2'},{id:'b3',reference:'TAX-B3'}]}),
   row({id:'run-4:company-b',companyName:'Harbourview Properties Sdn Bhd',status:'processing',completedAt:null,employeeCount:20,processedCount:20,completedCount:20}),
   row(),
  ]}/>));
  const bars=screen.getAllByRole('progressbar');
  expect(bars.map(bar=>bar.getAttribute('aria-valuenow'))).toEqual(['11','99','100']);
  expect(screen.getByText('17 of 152')).toBeVisible();
  expect(screen.getByText('1 failed · 2 skipped')).toBeVisible();
  expect(screen.getByText('2 employee groups')).toBeVisible();
  expect(screen.getByRole('link',{name:'Employee group 2'})).toHaveAttribute('href','/payroll/income-tax-recalculation/b3');
  act(()=>{vi.advanceTimersByTime(5000);});
  expect(mocks.refresh).toHaveBeenCalledTimes(1);
  cleanup();mocks.refresh.mockClear();
  render(wrap(<TaxBasisHistory rows={[row(),row({id:'x',status:'processing',interrupted:true,completedAt:null})]}/>));
  expect(screen.getByText(T.interruptedStatus)).toBeVisible();
  act(()=>{vi.advanceTimersByTime(15000);});
  expect(mocks.refresh).not.toHaveBeenCalled();
 });
 it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('renders every history label in %s',locale=>{
  render(wrap(<TaxBasisHistory rows={[row({status:'completed_with_errors',failedCount:3})]}/>,locale));
  for(const header of screen.getAllByRole('columnheader').slice(0,9))expect(header.textContent?.trim()).not.toMatch(/^$|payrollTaxBasis\./);
  expect(document.body.textContent).not.toMatch(/payrollTaxBasis\.|\{(count|failed|processed|total)/);
 });
});

describe('company search',()=>{
 it('finds companies by name or code, keeps ticks across searches and selects every permitted company',async()=>{
  const user=userEvent.setup();
  render(wrap(<TaxBasisWorkflow options={options} initialSelection={{companyId:'company-c',year:2026,upToMonth:8,employmentIds:null}}/>));
  await user.click(screen.getByRole('button',{name:/^Company/}));
  const search=screen.getByRole('textbox',{name:T.searchCompanies});
  await user.type(search,'harb');
  expect(offered('HFD01 · Harbour Foods Sdn Bhd')).toBe(true);expect(offered('HBX02 · Harbourview Properties Sdn Bhd')).toBe(true);
  expect(offered('NWL03 · Northwind Logistics Sdn Bhd')).toBe(false);
  await user.click(screen.getByRole('checkbox',{name:'HFD01 · Harbour Foods Sdn Bhd'}));
  await user.clear(search);await user.type(search,'hbx0');
  expect(offered('HBX02 · Harbourview Properties Sdn Bhd')).toBe(true);
  expect(offered('HFD01 · Harbour Foods Sdn Bhd')).toBe(false);
  await user.clear(search);
  expect(screen.getByRole('checkbox',{name:'HFD01 · Harbour Foods Sdn Bhd'})).toBeChecked();
  expect(screen.getByRole('checkbox',{name:'NWL03 · Northwind Logistics Sdn Bhd'})).toBeChecked();
  await user.type(search,'zzz');
  expect(screen.getByText('No company matches “zzz”.')).toBeVisible();
  await user.click(screen.getByRole('button',{name:T.selectAllCompanies}));
  await user.clear(search);
  for(const name of ['HFD01 · Harbour Foods Sdn Bhd','HBX02 · Harbourview Properties Sdn Bhd','NWL03 · Northwind Logistics Sdn Bhd'])expect(screen.getByRole('checkbox',{name})).toBeChecked();
  expect(screen.getByRole('checkbox',{name:'Coastal Retail Sdn Bhd'})).not.toBeChecked();
  expect(screen.getByRole('checkbox',{name:'Coastal Retail Sdn Bhd'})).toBeDisabled();
  mocks.groupPreview.mockResolvedValue('preview-job');mocks.groupProgress.mockResolvedValue({progress:{state:'running',stepsDone:0,stepsTotal:3}});
  await user.click(screen.getByRole('button',{name:T.previewAction}));
  expect(mocks.groupPreview.mock.calls[0][0].map((s:{companyId:string})=>s.companyId).sort()).toEqual(['company-a','company-b','company-c']);
 });
});

describe('background progress',()=>{
 it('shows a bar, employee counts and per-company status from the job, capped below 100% until it finishes',async()=>{
  const user=userEvent.setup();
  mocks.groupPreview.mockResolvedValue('preview-job');
  mocks.groupProgress.mockResolvedValue({progress:{state:'running',stepsDone:1,stepsTotal:4},counts:{processed:45,total:100,failures:1},companies:[
   {companyId:'company-a',name:'Harbour Foods Sdn Bhd',state:'completed',processed:20,total:20,failures:0},
   {companyId:'company-c',name:'Northwind Logistics Sdn Bhd',state:'processing',processed:25,total:80,failures:1}]});
  render(wrap(<TaxBasisWorkflow options={options} initialSelection={{companyId:'company-c',year:2026,upToMonth:8,employmentIds:null}}/>));
  await user.click(screen.getByRole('button',{name:T.previewAction}));
  expect(await screen.findByText('45 of 100 employees processed · 1 failed so far')).toBeVisible();
  const section=screen.getByRole('region',{name:T.previewProgressTitle});
  expect(within(section).getAllByRole('progressbar').map(bar=>bar.getAttribute('aria-valuenow'))).toEqual(['45','100','31']);
  expect(within(section).getByText('25 of 80 · 1 failed')).toBeVisible();
  expect(within(section).getAllByText(T.batchStates.processing).length).toBeGreaterThan(0);
  expect(within(section).getByRole('status')).toHaveTextContent(T.previewInBackground);
 });
 it('shows a queued job as pending at 0%',async()=>{
  const user=userEvent.setup();
  mocks.groupPreview.mockResolvedValue('preview-job');
  mocks.groupProgress.mockResolvedValue({progress:{state:'queued',stepsDone:0,stepsTotal:0},counts:{processed:0,total:0,failures:0},companies:[]});
  render(wrap(<TaxBasisWorkflow options={options} initialSelection={{companyId:'company-c',year:2026,upToMonth:8,employmentIds:null}}/>));
  await user.click(screen.getByRole('button',{name:T.previewAction}));
  const section=await screen.findByRole('region',{name:T.previewProgressTitle});
  await within(section).findByText(T.batchStates.pending);
  expect(within(section).getByRole('progressbar')).toHaveAttribute('aria-valuenow','0');
 });
});
