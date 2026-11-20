import {beforeEach,describe,expect,it,vi} from 'vitest';
import {validateTxnImportAction,commitTxnImportAction} from '../app/payroll/transactions/import-excel/actions';
import {GET as template} from '../app/payroll/transactions/import-excel/template/route';
import {buildTxnTemplateReference} from '../app/payroll/transactions/import-excel/reference';
import type {SessionContext} from '../db/client';
const mocks=vi.hoisted(()=>({scope:vi.fn(),employees:vi.fn(),components:vi.fn(),cycles:vi.fn(),module:vi.fn(),validate:vi.fn(),commit:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:mocks.scope}));
vi.mock('../core/entitlements',()=>({assertModuleEnabled:mocks.module}));
vi.mock('../core/payroll-cycle',()=>({listPayrollCyclesForCompanies:mocks.cycles}));
vi.mock('../core/read',()=>({listEmployees:mocks.employees}));
vi.mock('../core/pay-components',()=>({FIXED_TRANSACTION_CYCLES:['regular','off_cycle','bonus','adjustment'],listPayComponents:mocks.components}));
vi.mock('../core/payroll-individual-txn',()=>({TXN_KINDS:['earning','deduction','overtime','unpaid','leave']}));
vi.mock('../core/payroll-txn-import',()=>({validateTxnImport:mocks.validate,commitTxnImport:mocks.commit}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
const session={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',roles:['hr_admin']} satisfies SessionContext;
beforeEach(()=>{vi.clearAllMocks();mocks.module.mockReset();mocks.scope.mockResolvedValue({s:session,scopeIds:['00000000-0000-4000-8000-000000000003']});});
describe('Individual import entrypoint custody',()=>{
 it('refuses stale Individual validation and confirmation without calling either legacy writer or reader',async()=>{
  expect(await validateTxnImportAction('old sheet','individual')).toMatchObject({valid:0,fileError:'individualImportMoved'});
  expect(await commitTxnImportAction('old sheet','individual')).toMatchObject({written:0,fileError:'individualImportMoved'});
  expect(mocks.validate).not.toHaveBeenCalled();expect(mocks.commit).not.toHaveBeenCalled();expect(mocks.revalidate).not.toHaveBeenCalled();expect(mocks.scope).toHaveBeenCalledTimes(2);
 });
 it('preserves the existing Fixed import action path',async()=>{
  mocks.validate.mockResolvedValue({kind:'fixed',total:1,valid:1,invalid:0,rows:[]});mocks.commit.mockResolvedValue({kind:'fixed',written:1,failed:[],recalcBatchIds:[]});
  expect((await validateTxnImportAction('Employee ID,Amount\nE1,100','fixed')).valid).toBe(1);expect((await commitTxnImportAction('Employee ID,Amount\nE1,100','fixed')).written).toBe(1);
  expect(mocks.validate).toHaveBeenCalledTimes(1);expect(mocks.commit).toHaveBeenCalledTimes(1);expect(mocks.revalidate).toHaveBeenCalledWith('/payroll/transactions/fixed');
 });
 it('builds no employee or pay-item reference data when the company scope is empty',async()=>{
  const reference=await buildTxnTemplateReference(session,[]);expect(reference.employees).toEqual([]);expect(reference.payItems).toEqual([]);expect(mocks.employees).not.toHaveBeenCalled();expect(mocks.components).not.toHaveBeenCalled();
 });

 it('loads the scoped workbook at download time and ignores an out-of-scope preferred company',async()=>{
  const company='00000000-0000-4000-8000-000000000003';
  const foreign='00000000-0000-4000-8000-000000000004';
  mocks.employees.mockResolvedValue([{employeeCode:'E1',name:'In scope',company:'Current company',companyId:company}]);
  mocks.components.mockResolvedValue([]);
  mocks.cycles.mockResolvedValue([
   {companyId:company,code:'BONUS',name:'Bonus',runType:'bonus'},
   {companyId:company,code:'REG',name:'Regular',runType:'regular'},
  ]);
  const request=(companyId:string)=>new Request('https://example.invalid/payroll/transactions/import-excel/template?'+new URLSearchParams({kind:'fixed',companyId}));
  const fallback=await template(request(foreign));
  expect(fallback.headers.get('Cache-Control')).toBe('private, no-store');
  expect((await fallback.json()).fixedExampleCycleCode).toBe('BONUS');
  const fixed=await (await template(request(company))).json();
  expect(fixed.fixedExampleCycleCode).toBe('REG');
  expect(fixed.employees.map((row:{code:string})=>row.code)).toEqual(['E1']);
  expect(mocks.module).toHaveBeenCalledWith(session,'payroll');
  expect(mocks.employees).toHaveBeenCalledWith(session,[company]);
  expect(mocks.cycles).toHaveBeenCalledWith(session,[company],{activeOnly:true});
 });

 it('refuses a disabled Payroll module before reading employee references',async()=>{
  mocks.module.mockImplementationOnce(()=>{throw new Error('Payroll unavailable');});
  const response=await template(new Request('https://example.invalid/payroll/transactions/import-excel/template?kind=individual'));
  expect(response.status).toBe(403);
  expect(mocks.employees).not.toHaveBeenCalled();
  expect(mocks.components).not.toHaveBeenCalled();
 });
});
