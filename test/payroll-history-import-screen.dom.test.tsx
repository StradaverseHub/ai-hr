import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {HistoryWorkflow} from '../app/(app)/payroll/history-import/history-workflow';
import {RevisionPreview} from '../app/(app)/payroll/history-import/revision-preview';
import type {HistoryRevisionPlan,HistoryRevisionRow} from '../lib/payroll-history-revisions';
const confirm=vi.hoisted(()=>vi.fn());
vi.mock('../app/(app)/payroll/history-import/workflow-actions',()=>({confirmHistoryUploadAction:confirm}));
vi.mock('next/link',()=>({default:({href,children,...props}:any)=><a href={href} {...props}>{children}</a>}));
function row(i=0):HistoryRevisionRow{return {companyId:'company-a',companyName:'Company A',currency:'MYR',employmentId:'employee-a',employeeNo:String(i).padStart(4,'0'),period:'2024-01',cycleId:'cycle-a',cycleName:'Monthly',rowNums:[i+2],operation:'replace',reasons:[],recordId:'record-a',expectedRevisionId:'revision-a',expectedSnapshotId:'snapshot-a',valueHash:'hash',overwrite:true,beforeValues:{basicSalary:'5000.00',allowance:'0.00',overtimePay:'0.00',bonus:'0.00',grossPay:'5000.00',statutory:{pcb:0},otherDeductions:'0.00',totalDeductions:'0.00',netPay:'5000.00',employerCost:'5000.00'},values:{basicSalary:'6000.00',allowance:'0.00',overtimePay:'0.00',bonus:'0.00',grossPay:'6000.00',statutory:{pcb:0},otherDeductions:'0.00',totalDeductions:'0.00',netPay:'6000.00',employerCost:'6000.00'}};}
const plan=(rows=[row()]):HistoryRevisionPlan=>({version:1,rows,issues:[],counts:{created:0,replaced:rows.length,unchanged:0,invalid:0},companyIds:['company-a'],sourceHash:'source-hash',previewHash:'preview-hash'});
const wrap=(child:React.ReactNode)=><NextIntlClientProvider locale="en" messages={messages}>{child}</NextIntlClientProvider>;
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
describe('payroll history revision workflow',()=>{
 it('preserves the original upload bytes and requires both review and replacement confirmation',async()=>{
  const user=userEvent.setup(),fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({attemptId:'attempt-a',plan:plan()})});vi.stubGlobal('fetch',fetcher);confirm.mockResolvedValue({ok:true,result:{}});
  render(wrap(<HistoryWorkflow codes={[]}/>));
  const file=new File(['original workbook bytes'],'history.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  await user.upload(screen.getByLabelText('Source file'),file);await user.click(screen.getByRole('button',{name:'Validate file'}));
  expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('history.xlsx'),expect.objectContaining({body:file}));
  // d28501b8 r2 — replacements are ticked record by record, then acknowledged.
  const commit=screen.getByRole('button',{name:'Confirm overwrite and import'});expect(commit).toBeDisabled();
  expect(screen.getByText(/Tick the ones you want to overwrite/)).toBeVisible();
  // Nothing new in this file, so "Import new records only" is not offered.
  expect(screen.queryByRole('button',{name:'Import new records only'})).toBeNull();
  await user.click(screen.getByLabelText(/I have reviewed the companies/));expect(commit).toBeDisabled();
  await user.click(screen.getByLabelText('Overwrite 0000 2024-01'));
  expect(screen.getByText(/You have ticked 1 employee-month for overwrite/)).toBeVisible();expect(commit).toBeDisabled();
  await user.click(screen.getByLabelText(/I understand\. Replace the ticked records/));expect(commit).toBeEnabled();
  await user.click(commit);expect(confirm).toHaveBeenCalledWith({attemptId:'attempt-a',previewHash:'preview-hash',confirmReplacement:true,selectedRecordKeys:['company-a:employee-a:2024-01:cycle-a'],acknowledgeWarnings:true});expect(await screen.findByRole('status')).toHaveTextContent('Import committed');
 });
 it('renders source cycle, before-and-after money and bounded pages without truncating the record set',async()=>{
  const user=userEvent.setup();render(wrap(<RevisionPreview plan={plan(Array.from({length:51},(_,i)=>row(i)))}/>));
  expect(screen.getAllByText('Monthly - By Import')).toHaveLength(50);expect(screen.queryByText('0050')).toBeNull();
  await user.click(screen.getAllByText('Compare values')[0]);const table=screen.getAllByText('Compare values')[0].closest('details');expect(table).not.toBeNull();expect(within(table!).getAllByText('MYR 5,000.00').length).toBeGreaterThan(0);expect(within(table!).getAllByText('MYR 6,000.00').length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button',{name:'Next'}));expect(screen.getAllByText('Monthly - By Import')).toHaveLength(1);expect(screen.getByText('0050')).toBeVisible();expect(screen.getByText('Page 2 of 2')).toBeVisible();
 });
 it('prevents confirmation when any company has blocking errors',async()=>{
  const user=userEvent.setup(),invalid=plan();invalid.counts.invalid=1;invalid.issues=[{rowNum:3,reason:'Unknown company'}];vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({attemptId:'attempt-a',plan:invalid})}));
  render(wrap(<HistoryWorkflow codes={[]}/>));await user.upload(screen.getByLabelText('Source file'),new File(['x'],'history.csv',{type:'text/csv'}));await user.click(screen.getByRole('button',{name:'Validate file'}));await user.click(screen.getByLabelText(/I have reviewed the companies/));await user.click(screen.getByLabelText('Overwrite 0000 2024-01'));await user.click(screen.getByLabelText(/I understand\. Replace the ticked records/));expect(screen.getByRole('button',{name:'Confirm overwrite and import'})).toBeDisabled();expect(screen.getByRole('alert')).toHaveTextContent('Unknown company');expect(confirm).not.toHaveBeenCalled();
 });
 it('d28501b8 r2: new records import alone, and processed payroll says what has already gone out',async()=>{
  const user=userEvent.setup(),fresh={...row(1),operation:'create' as const,expectedSnapshotId:null,beforeValues:null,codes:['BASIC','EEEPF']};
  const processed={...row(),employeeName:'Sample Employee',overwriteSource:'processed' as const,warnings:['A bank payment file was already exported for this payroll. It is not re-sent.']};
  const mixed=plan([processed,fresh]);mixed.counts={created:1,replaced:1,unchanged:0,invalid:0};
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({attemptId:'attempt-a',plan:mixed})}));confirm.mockResolvedValue({ok:true,result:{skippedReplacements:1}});
  render(wrap(<HistoryWorkflow codes={[]}/>));await user.upload(screen.getByLabelText('Source file'),new File(['x'],'history.csv',{type:'text/csv'}));await user.click(screen.getByRole('button',{name:'Validate file'}));
  expect(screen.getByText('BASIC, EEEPF')).toBeVisible();expect(screen.getByText('Processed in AIHR')).toBeVisible();expect(screen.getByText(/· Sample Employee/)).toBeVisible();
  expect(screen.getByText('Overwrite confirmation required')).toBeVisible();expect(screen.getByText('New record')).toBeVisible();
  // Ticking the processed record lists what has already gone out for it, once, above the acknowledgement.
  await user.click(screen.getByLabelText('Overwrite 0000 2024-01'));
  expect(screen.getAllByText(/bank payment file was already exported/)).toHaveLength(2);
  await user.click(screen.getByLabelText('Overwrite 0000 2024-01'));
  await user.click(screen.getByLabelText(/I have reviewed the companies/));await user.click(screen.getByRole('button',{name:'Import new records only'}));
  expect(confirm).toHaveBeenCalledWith({attemptId:'attempt-a',previewHash:'preview-hash',confirmReplacement:false,skipReplacements:true});
  expect(await screen.findByRole('status')).toHaveTextContent('1 existing record was left unchanged');
  cleanup();render(wrap(<RevisionPreview plan={{...plan([{...row(2),operation:'invalid' as const,reasons:['Payroll for this period and Pay Cycle is still open in Payroll.']}]),counts:{created:0,replaced:0,unchanged:0,invalid:1}}}/>));
  expect(screen.getByText('Rejected')).toBeVisible();expect(screen.queryByRole('checkbox')).toBeNull();
 });
});
