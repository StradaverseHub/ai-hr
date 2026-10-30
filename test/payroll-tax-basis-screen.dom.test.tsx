import type {ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider,createFormatter,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {TaxBasisWorkflow,type TaxBasisOptions} from '../app/payroll/income-tax-recalculation/workflow';
import {TaxBasisResults} from '../app/payroll/income-tax-recalculation/results';
import TaxBasisPage from '../app/payroll/income-tax-recalculation/page';
import TaxBasisBatchPage from '../app/payroll/income-tax-recalculation/[id]/page';
import type {TaxBasisBatch,TaxBasisEmployee,TaxBasisPreview,TaxBasisSelection} from '../lib/payroll-tax-basis';

const mocks=vi.hoisted(()=>({preview:vi.fn(),confirm:vi.fn(),push:vi.fn(),refresh:vi.fn(),options:vi.fn(),list:vi.fn(),get:vi.fn()}));
vi.mock('../app/payroll/income-tax-recalculation/actions',()=>({previewTaxBasisAction:mocks.preview,confirmTaxBasisAction:mocks.confirm}));
vi.mock('../packs/payroll/service',()=>({taxBasisOptions:mocks.options,listTaxBasisBatches:mocks.list,getTaxBasisBatch:mocks.get}));
vi.mock('../lib/authz',()=>({requirePayrollAccess:async()=>({tenantId:'tenant-a',userId:'actor-a'})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push,refresh:mocks.refresh}),notFound:()=>{throw Error('NEXT_NOT_FOUND');}}));
vi.mock('next/link',()=>({default:({href,children,...props}:any)=><a href={href} {...props}>{children}</a>}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never}),getFormatter:async()=>createFormatter({locale:'en',timeZone:'Asia/Kuala_Lumpur'})}));
const catalogs={en,ms,zh,ta,th,vi:viMessages};
const batchId='b1111111-1111-4111-8111-111111111111';
const options:TaxBasisOptions={companies:[{id:'company-a',name:'Example Company'},{id:'company-b',name:'Other Company'}],employees:[{id:'employee-a',companyId:'company-a',employeeNo:'E001',name:'Aina'},{id:'employee-b',companyId:'company-a',employeeNo:'E002',name:'Daniel'},{id:'employee-c',companyId:'company-b',employeeNo:'X001',name:'Outside company'}],years:[2026,2025],canRecalculate:true};
function employee(overrides:Partial<TaxBasisEmployee>={}):TaxBasisEmployee{return {id:'employee-a',employeeNo:'E001',name:'Aina',status:'ready',reason:null,recordCount:1,beforeTaxable:5000,taxable:5500,difference:500,beforeExempt:500,exempt:0,months:[{payslipId:'slip-a',period:'2026-01',sourceHash:'source-a',beforeTaxable:5000,taxable:5500,difference:500,beforeExempt:500,exempt:0,ytdTaxable:5500,ytdExempt:0,items:[{code:'TRV',name:'Travel',amount:500,previousTreatment:'Non-Taxable',latestTreatment:'Taxable',taxable:500,exempt:0}],basis:{version:1,pcb:5500,exemptionUsed:{},items:[],rulesHash:'rules-a'}}],...overrides};}
function preview():TaxBasisPreview{return {previewId:'preview-a',previewHash:'hash-a',companyId:'company-a',companyName:'Example Company',year:2026,upToMonth:3,selection:'all',createdAt:'2026-10-30T08:00:00Z',expiresAt:'2026-10-30T09:00:00Z',settingsHash:'settings-a',eligibleCount:1,unchangedCount:0,blockedCount:1,recordCount:1,totals:{beforeTaxable:5000,taxable:5500,difference:500,beforeExempt:500,exempt:0},employees:[employee(),employee({id:'employee-b',employeeNo:'E002',name:'Daniel',status:'blocked',reason:'Original item evidence is missing.',recordCount:0,beforeTaxable:null,taxable:null,difference:null,beforeExempt:null,exempt:null,months:[]})]};}
function batch():TaxBasisBatch{return {id:batchId,reference:'TAX-2026-0001',companyId:'company-a',companyName:'Example Company',year:2026,upToMonth:3,selection:'selected',status:'completed_with_errors',createdAt:'2026-10-30T08:00:00Z',completedAt:'2026-10-30T08:05:00Z',actorName:'Payroll Admin',employeeCount:2,recordCount:1,completedCount:1,failedCount:1,employees:[employee({status:'completed'}),employee({id:'employee-b',employeeNo:'E002',name:'Daniel',status:'failed',reason:'Source changed.',recordCount:0,months:[]})]};}
function wrap(child:ReactNode,locale:keyof typeof catalogs='en'){return <NextIntlClientProvider locale={locale} messages={catalogs[locale]} timeZone="Asia/Kuala_Lumpur">{child}</NextIntlClientProvider>;}
function show(locale:keyof typeof catalogs='en',props:{options?:TaxBasisOptions;initialSelection?:TaxBasisSelection}={}){render(wrap(<TaxBasisWorkflow options={props.options??options} initialSelection={props.initialSelection}/>,locale));return catalogs[locale].payrollTaxBasis;}
afterEach(()=>{cleanup();vi.resetAllMocks();});

describe('historical income tax basis review and confirmation',()=>{
  it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('requires consent and names the exact eligible subset in %s',async locale=>{
    const user=userEvent.setup();mocks.preview.mockResolvedValue({ok:true,preview:preview()});mocks.confirm.mockResolvedValue({ok:true,result:{id:batchId}});
    const t=show(locale);await user.click(screen.getByRole('button',{name:t.previewAction}));
    await user.click(await screen.findByRole('button',{name:createTranslator({locale,messages:catalogs[locale],namespace:'payrollTaxBasis'})('recalculateAction',{count:1})}));
    const dialog=screen.getByRole('alertdialog');
    expect(within(dialog).getByText('E001 · Aina')).toBeVisible();
    expect(within(dialog).queryByText('E002 · Daniel')).toBeNull();
    const confirm=within(dialog).getByRole('button',{name:t.confirmAction});expect(confirm).toBeDisabled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('checkbox',{name:t.acknowledge}));
    await user.click(confirm);
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({previewId:'preview-a',previewHash:'hash-a'});
    expect(mocks.push).toHaveBeenCalledWith('/payroll/income-tax-recalculation/'+batchId);
  });
  it('invalidates reviewed results on period, company, selection and employee changes',async()=>{
    const user=userEvent.setup();mocks.preview.mockResolvedValue({ok:true,preview:preview()});show();
    async function generate(){await user.click(screen.getByRole('button',{name:en.payrollTaxBasis.previewAction}));await screen.findByRole('heading',{name:en.payrollTaxBasis.summary});}
    const absent=()=>expect(screen.queryByRole('button',{name:'Recalculate 1 eligible employee'})).toBeNull();
    await generate();await user.selectOptions(screen.getByLabelText('Calculate up to month'),'2');absent();
    await generate();await user.selectOptions(screen.getByLabelText('Year'),'2025');absent();
    await generate();await user.click(screen.getByRole('radio',{name:'Selected employees'}));absent();
    expect(screen.queryByLabelText('X001 · Outside company')).toBeNull();
    await user.click(screen.getByRole('checkbox',{name:'E001 · Aina'}));await generate();
    await user.click(screen.getByRole('checkbox',{name:'E002 · Daniel'}));absent();
    await generate();await user.selectOptions(screen.getByLabelText('Company'),'company-b');absent();
    expect(screen.queryByRole('checkbox',{name:'E001 · Aina'})).toBeNull();
    expect(screen.getByRole('checkbox',{name:'X001 · Outside company'})).toBeVisible();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('does not allow a view-only user to request a preview or a write',async()=>{
    const user=userEvent.setup();show('en',{options:{...options,canRecalculate:false}});
    expect(screen.getByText(en.payrollTaxBasis.readOnly)).toBeVisible();
    const previewButton=screen.getByRole('button',{name:'Preview Recalculation'});expect(previewButton).toBeDisabled();
    await user.click(previewButton);expect(mocks.preview).not.toHaveBeenCalled();expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it('keeps unknown previous values unavailable and displays exact server-owned amounts',async()=>{
    const row=employee({beforeTaxable:null,difference:null,beforeExempt:null,months:[{...employee().months[0],beforeTaxable:null,beforeExempt:null,difference:null,items:[{...employee().months[0].items[0],previousTreatment:null}]}]});
    render(wrap(<TaxBasisResults employees={[row]}/>));
    const user=userEvent.setup();await user.click(screen.getByText('E001 · Aina'));
    const details=screen.getByText('E001 · Aina').closest('details')!;
    expect(within(details).getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(within(details).getAllByText('MYR 5,500.00').length).toBeGreaterThan(0);
    expect(within(details).queryByText('MYR 5,000.00')).toBeNull();
    await user.click(within(details).getByText('View Pay Items and settings'));
    expect(within(details).getByText('TRV · Travel')).toBeVisible();
    expect(within(details).getByText('Taxable',{exact:true})).toBeVisible();
  });
  it('clears stale confirmation after service refusal and requires a fresh preview and acknowledgement',async()=>{
    const user=userEvent.setup();mocks.preview.mockResolvedValue({ok:true,preview:preview()});mocks.confirm.mockResolvedValueOnce({ok:false,error:'Pay Item settings changed; preview again.'});show();
    await user.click(screen.getByRole('button',{name:'Preview Recalculation'}));await user.click(await screen.findByRole('button',{name:'Recalculate 1 eligible employee'}));
    await user.click(screen.getByRole('checkbox',{name:en.payrollTaxBasis.acknowledge}));await user.click(screen.getByRole('button',{name:'Yes — Recalculate'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pay Item settings changed');
    expect(screen.queryByRole('alertdialog')).toBeNull();expect(screen.queryByRole('heading',{name:'Recalculation summary'})).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
    mocks.preview.mockResolvedValue({ok:true,preview:{...preview(),previewId:'preview-b',previewHash:'hash-b'}});
    await user.click(screen.getByRole('button',{name:'Preview Recalculation'}));await user.click(await screen.findByRole('button',{name:'Recalculate 1 eligible employee'}));
    expect(screen.getByRole('checkbox',{name:en.payrollTaxBasis.acknowledge})).not.toBeChecked();
    expect(screen.getByRole('button',{name:'Yes — Recalculate'})).toBeDisabled();
  });
  it('shows partial results and routes failed-only retry through a new preview',async()=>{
    const user=userEvent.setup();mocks.get.mockResolvedValue(batch());mocks.options.mockResolvedValue(options);mocks.list.mockResolvedValue([]);
    render(wrap(await TaxBasisBatchPage({params:Promise.resolve({id:batchId})})));
    expect(screen.getByRole('status')).toHaveTextContent('Completed with errors');
    expect(screen.getByRole('link',{name:'Preview failed employees again'})).toHaveAttribute('href','/payroll/income-tax-recalculation?retry='+batchId);
    expect(screen.getByText(en.payrollTaxBasis.partialHint)).toBeVisible();cleanup();
    mocks.preview.mockResolvedValue({ok:true,preview:preview()});
    render(wrap(await TaxBasisPage({searchParams:Promise.resolve({retry:batchId})})));
    expect(screen.getByRole('radio',{name:'Selected employees'})).toBeChecked();
    expect(screen.getByRole('checkbox',{name:'E002 · Daniel'})).toBeChecked();
    expect(screen.getByRole('checkbox',{name:'E001 · Aina'})).not.toBeChecked();
    expect(screen.queryByRole('button',{name:'Yes — Recalculate'})).toBeNull();
    await user.click(screen.getByRole('button',{name:'Preview Recalculation'}));
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({companyId:'company-a',year:2026,upToMonth:3,employmentIds:['employee-b']});
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
