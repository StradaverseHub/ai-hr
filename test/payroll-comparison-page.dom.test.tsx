import * as React from 'react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {DEFAULT_PAYROLL_COMPARISON,payrollComparisonFilters} from '../lib/payroll-period-comparison';
import {comparePayrollResults} from '../lib/payroll-comparison-result';
import {todayInKualaLumpur} from '../lib/hr-date';
import PayrollComparisonPage from '../app/(app)/reports/payroll-comparison/[id]/page';
import {MasterReportAccessError} from '../core/employee-master-access';
import {runPayrollComparisonReport,recordPayrollComparisonRun} from '../core/custom-reports';

const state=vi.hoisted(()=>({canExport:false,denied:false}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NEXT_NOT_FOUND');},useRouter:()=>({refresh:vi.fn()})}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never,onError:error=>{throw error;}})}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'fictional'},scopeIds:['00000000-0000-0000-0000-000000000001']})}));
vi.mock('../core/employee-master-access',()=>({MasterReportAccessError:class extends Error{}}));
vi.mock('../core/report-payroll-comparison',()=>({payrollComparisonOptions:async()=>{
 if(state.denied)throw new MasterReportAccessError();
 return {companies:[],departments:[],periods:[],payItems:[]};
}}));
vi.mock('../core/custom-reports',()=>({runPayrollComparisonReport:vi.fn(),recordPayrollComparisonRun:vi.fn(),getCustomReport:vi.fn()}));
// The editor is not part of this read/denial journey; its submit/retry tests cover that action boundary.
vi.mock('../app/(app)/reports/payroll-comparison/PayrollComparisonEditor',()=>({PayrollComparisonEditor:()=>null}));

function run():Awaited<ReturnType<typeof runPayrollComparisonReport>>{
 const companyId='00000000-0000-0000-0000-000000000001',definition=structuredClone(DEFAULT_PAYROLL_COMPARISON);
 const filters=payrollComparisonFilters({currentPeriod:todayInKualaLumpur().slice(0,7)},definition);
 const result=comparePayrollResults({definition,filters,companyIds:[companyId],runs:[],sources:[],identities:[],
  previousFrom:filters.previousPeriod!+'-01',currentFrom:filters.currentPeriod!+'-01',currentTo:todayInKualaLumpur()});
 return {definition,filters,result,companyIds:[companyId],sourceRevisions:[],contextUnavailable:false,canEdit:false,canExport:state.canExport,
  reportId:'00000000-0000-0000-0000-000000000002',version:1,spec:{datasetId:'payroll_period_comparison',payrollComparison:definition,columns:definition.columns},
  name:'Fictional permitted comparison',description:'',generatedAt:new Date().toISOString(),generatedBy:'Fictional HR'};
}
beforeEach(()=>{state.canExport=false;state.denied=false;vi.mocked(runPayrollComparisonReport).mockReset().mockImplementation(async()=>run());vi.mocked(recordPayrollComparisonRun).mockReset();});
afterEach(cleanup);
async function show(){render(<NextIntlClientProvider locale="en" messages={en}>{await PayrollComparisonPage({params:Promise.resolve({id:'00000000-0000-0000-0000-000000000002'}),searchParams:Promise.resolve({})})}</NextIntlClientProvider>);}
describe('Payroll comparison reflects saved authority',()=>{
 it('keeps a view-only report usable without offering forbidden downloads',async()=>{
  await show();expect(screen.getByRole('heading',{name:'Fictional permitted comparison'})).toBeVisible();
  expect(screen.queryByRole('link',{name:'Export PDF'})).not.toBeInTheDocument();expect(screen.queryByRole('link',{name:'Export Excel'})).not.toBeInTheDocument();
  expect(screen.getByRole('region',{name:'Comparison results'})).toHaveAttribute('tabindex','0');
 });
 it('offers downloads when the canonical owner confirms the export verb',async()=>{
  state.canExport=true;await show();expect(screen.getByRole('link',{name:'Export PDF'})).toHaveAttribute('href',expect.stringContaining('format=pdf'));
  expect(screen.getByRole('link',{name:'Export Excel'})).toHaveAttribute('href',expect.stringContaining('format=xlsx'));
 });
 it('turns a revoked financial option read into unavailable navigation before executing or recording the report',async()=>{
  state.denied=true;
  await expect(PayrollComparisonPage({params:Promise.resolve({id:'00000000-0000-0000-0000-000000000002'}),searchParams:Promise.resolve({})})).rejects.toThrow('NEXT_NOT_FOUND');
  expect(runPayrollComparisonReport).not.toHaveBeenCalled();expect(recordPayrollComparisonRun).not.toHaveBeenCalled();
 });
});
