import {beforeEach,describe,expect,it,vi} from 'vitest';
import {validateTxnImportAction,commitTxnImportAction} from '../app/(app)/payroll/transactions/import-excel/actions';
import {buildTxnTemplateReference} from '../app/(app)/payroll/transactions/import-excel/reference';
import type {SessionContext} from '../db/client';
const mocks=vi.hoisted(()=>({scope:vi.fn(),employees:vi.fn(),components:vi.fn(),validate:vi.fn(),commit:vi.fn(),revalidate:vi.fn()}));
vi.mock('../lib/scope',()=>({scopedAdmin:mocks.scope}));
vi.mock('../core/read',()=>({listEmployees:mocks.employees}));
vi.mock('../core/pay-components',()=>({FIXED_TRANSACTION_CYCLES:['regular','off_cycle','bonus','adjustment'],listPayComponents:mocks.components}));
vi.mock('../core/payroll-individual-txn',()=>({TXN_KINDS:['earning','deduction','overtime','unpaid','leave']}));
vi.mock('../core/payroll-txn-import',()=>({validateTxnImport:mocks.validate,commitTxnImport:mocks.commit}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
const session={tenantId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002',roles:['hr_admin']} satisfies SessionContext;
beforeEach(()=>{vi.clearAllMocks();mocks.scope.mockResolvedValue({s:session,scopeIds:['00000000-0000-4000-8000-000000000003']});});
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
});
