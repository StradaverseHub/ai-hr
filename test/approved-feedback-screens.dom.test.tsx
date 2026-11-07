import React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {DEFAULT_PAYROLL_COMPARISON,payrollComparisonFilters,ALL_RECORDED_PAY_ITEMS} from '../lib/payroll-period-comparison';
import {comparePayrollResults} from '../lib/payroll-comparison-result';
import type {runPayrollComparisonReport} from '../core/custom-reports';
const company='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',employee='00000000-0000-4000-8000-000000000003',reviewer='00000000-0000-4000-8000-000000000004';
const state=vi.hoisted(()=>({run:vi.fn(),search:vi.fn(),save:vi.fn(),preview:vi.fn(),push:vi.fn()}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');},useRouter:()=>({push:state.push,refresh:vi.fn()}),usePathname:()=>'/admin/attendance/approval-workflow/new'}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never,onError:error=>{throw error;}})}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'fictional'},scopeIds:[company,other]})}));
vi.mock('../core/custom-reports',()=>({listCustomReports:async()=>[],runPayrollComparisonReport:state.run,recordPayrollComparisonRun:async()=>{},getCustomReport:async()=>null}));
vi.mock('../core/report-payroll-comparison',()=>({payrollComparisonOptions:async()=>({companies:[{id:company,name:'Fictional Company A'},{id:other,name:'Fictional Company B'}],departments:[],businessUnits:[],positions:[],cycles:[],periods:['2026-10','2026-09'],payItems:[{code:ALL_RECORDED_PAY_ITEMS,name:'All recorded pay items'},{code:'BASIC',name:'Basic Salary'},{code:'__NETPAY__',name:'Net Pay'}]}),payrollReconciliationPeriods:async()=>[]}));
vi.mock('../app/reports/payroll-comparison/actions',()=>({savePayrollReconciliationRemarkAction:vi.fn(),saveReconciliationTemplateAction:vi.fn()}));
vi.mock('../app/admin/attendance/approval-workflow/actions',()=>({searchAttendanceApproversAction:state.search,saveAttendanceWorkflowAction:state.save,previewAttendanceWorkflowAction:state.preview}));
import ReconciliationPage from '../app/payroll/reconciliation/page';
import ComparisonPage from '../app/reports/payroll-comparison/[id]/page';
import {WorkflowForm} from '../app/admin/attendance/approval-workflow/workflow-form';
import {__resetUnsavedGuards} from '../lib/unsaved-changes';
function run():Awaited<ReturnType<typeof runPayrollComparisonReport>>{
 const definition={...DEFAULT_PAYROLL_COMPARISON,payItemCode:'__NETPAY__',onlyVariances:false,minVariance:'0.00',runType:'all' as const},filters=payrollComparisonFilters({currentPeriod:'2026-10'},definition);
 const runs=[{id:'previous',companyId:company,period:'2026-09',runType:'regular' as const,status:'closed' as const,stale:false},{id:'current',companyId:company,period:'2026-10',runType:'regular' as const,status:'processed' as const,stale:false}];
 const identities=[{employmentId:employee,companyId:company,employeeCode:'EMP-001',employeeName:'Fictional Adam',company:'Fictional Company A',departmentId:null,department:null,grade:null,costCentre:null,hireDate:'2025-01-01',exitDate:null,movements:[],verifiedTransferIds:[]}];
 const sources=runs.map((r,index)=>({id:'result-'+index,version:1,runId:r.id,employmentId:employee,companyId:company,currency:'MYR',amount:'5000.00',coverage:{from:r.period+'-01',to:r.period+(index?'-31':'-30')}}));
 const result=comparePayrollResults({definition,filters,companyIds:[company],runs,sources,identities,previousFrom:'2026-09-01',currentFrom:'2026-10-01',currentTo:'2026-10-31'});
 return {definition,filters,result,companyIds:[company],sourceRevisions:[],contextUnavailable:false,canEdit:false,canExport:false,reportId:null,version:null,spec:{datasetId:'payroll_period_comparison',payrollComparison:definition,columns:definition.columns},name:'Payroll Reconciliation',description:'',generatedAt:'2026-11-07T12:00:00Z',generatedBy:'Fictional HR'};
}
const show=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);
beforeEach(()=>{vi.clearAllMocks();state.run.mockImplementation(async()=>run());state.search.mockResolvedValue({ok:true,value:{rows:[{id:reviewer,name:'Fictional reviewer',employeeCode:'EMP-104',company:'Fictional Company B',eligible:true}],selected:[],more:false}});state.save.mockResolvedValue({ok:false,error:'Fictional save validation'});state.preview.mockResolvedValue({ok:true,preview:{total:1,rows:[{employmentId:employee,employeeCode:'EMP-001',name:'Fictional Adam',companyId:company,selectedCode:'SHARED',problem:null,routingVersion:4,resolvedStages:[],levelProblem:{code:'missing_superior',levelIndex:0,participantIndex:0}}],truncated:false}});});
afterEach(()=>{cleanup();__resetUnsavedGuards();});
describe('approved feedback rendered journeys',()=>{
 it('renders an unchanged employee summary and a usable detail link with retained filters',async()=>{
  const view=show(await ReconciliationPage({searchParams:Promise.resolve({})}));
  expect(screen.getByText('No Variance')).toBeVisible();expect(screen.getByText('EMP-001')).toBeVisible();
  const detail=screen.getByRole('link',{name:'Comparison results'});const url=new URL(detail.getAttribute('href')!,'https://fixture.invalid');
  expect(url.searchParams.get('employmentId')).toBe(employee);expect(url.searchParams.get('returnQuery')).toContain('currentPeriod=2026-10');
  expect(screen.getByLabelText('Company')).toHaveValue('');
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','feedback-reconciliation-summary','Actual reconciliation page; fictional recorded Net Pay results; no authenticated installation claim');
 },120000);
 it('restores a validated Back context and provides multiple Pay Item filtering in the detail view',async()=>{
  const result=run();result.definition.payItemCode=ALL_RECORDED_PAY_ITEMS;result.result.rows=result.result.rows.map(row=>({...row,payItemCode:'BASIC'}));state.run.mockResolvedValue(result);
  const returnQuery=new URLSearchParams({companyId:company,currentPeriod:'2026-10',previousPeriod:'2026-09',onlyVariances:'0',page:'2'}).toString();
  const view=show(await ComparisonPage({params:Promise.resolve({id:'reconciliation'}),searchParams:Promise.resolve({returnQuery,employmentId:employee,payItemCode:ALL_RECORDED_PAY_ITEMS})}));
  const back=new URL(screen.getByRole('link',{name:'Back to Payroll Reconciliation'}).getAttribute('href')!,'https://fixture.invalid');
  expect(back.pathname).toBe('/payroll/reconciliation');expect(back.searchParams.get('companyId')).toBe(company);expect(back.searchParams.get('page')).toBe('2');
  expect(screen.getByRole('button',{name:'Pay item'})).toBeVisible();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','feedback-reconciliation-detail','Actual comparison page with validated return context and fictional saved payroll items');
 },120000);
 it('keeps the shared company selection and allows saving after a missing-superior preview warning',async()=>{
  const view=show(<WorkflowForm lineageId={null} context={{companyId:company,applicationType:'irregularity'}} initial={null} options={{companies:[{id:company,name:'Fictional Company A'},{id:other,name:'Fictional Company B'}],departments:[],businessUnits:[],grades:[],divisions:[],approverEmployees:[]}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Company'}));fireEvent.click(screen.getByRole('checkbox',{name:'Fictional Company B'}));fireEvent.keyDown(screen.getByPlaceholderText(en.attendanceWorkflow.searchCompanies),{key:'Escape'});
  fireEvent.change(screen.getByLabelText('Workflow code'),{target:{value:'SHARED'}});fireEvent.change(screen.getByLabelText('Workflow name'),{target:{value:'Shared Attendance'}});
  fireEvent.click(screen.getByRole('button',{name:'Preview assignment'}));await screen.findByText(en.attendanceWorkflow.hierarchyWarning);
  expect(screen.getByRole('button',{name:'Save workflow'})).toBeEnabled();
  await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','feedback-shared-workflow','Actual shared-company WorkflowForm and missing-superior preview; fictional employees');
  fireEvent.click(screen.getByRole('button',{name:'Save workflow'}));await waitFor(()=>expect(state.save).toHaveBeenCalledWith(null,expect.objectContaining({companyIds:[company,other]}),true));
 },120000);
});
