import {beforeEach,describe,expect,it,vi} from 'vitest';
const source=vi.hoisted(()=>({batches:vi.fn(),enabled:vi.fn(),setting:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('../packs/payroll/service',()=>({listBatches:source.batches}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:source.enabled,settingEnabledOrDefault:source.setting}));
vi.mock('../lib/hr-date',()=>({todayInKualaLumpur:()=> '2026-10-30'}));
import {readPayrollRecoveryHandoffs} from '../core/assistant-actions/payroll-recovery-handoff';
import type {SessionContext} from '../db/client';
const ctx=(role='hr_admin')=>({tenantId:'tenant',userId:'user',roles:[role],grants:[{role,companyId:null}]} as SessionContext);
const row=(status:string,id=status)=>({id,status,companyId:'company',company:'Company',payPeriod:'2026-10',payrollCycleName:'Monthly',historyImportAttemptId:null,totals:{net:999},employeeCount:4});
beforeEach(()=>{vi.clearAllMocks();source.enabled.mockReturnValue(true);source.setting.mockReturnValue(true);source.batches.mockResolvedValue([row('draft'),row('processed'),row('closed'),{...row('closed','history'),historyImportAttemptId:'import'}]);});
describe('Payroll recovery native handoff',()=>{
 it('admits a real unlinked USER and returns only native destinations and identity labels, never pay values or an execution receipt',async()=>{
  expect(await readPayrollRecoveryHandoffs(ctx())).toEqual([
   {batchId:'processed',company:'Company',payPeriod:'2026-10',cycle:'Monthly',operation:'reset',href:'/payroll/processed/reset'},
   {batchId:'closed',company:'Company',payPeriod:'2026-10',cycle:'Monthly',operation:'reopen',href:'/payroll/closed'},
  ]);expect(source.batches).toHaveBeenCalledWith(ctx(),undefined,'2026-10');
 });
 it('does not nominate reset for a payroll partner, matching the native reset page admin floor',async()=>{
  const result=await readPayrollRecoveryHandoffs(ctx('payroll_partner'));expect(result.map(r=>r.operation)).toEqual(['reopen']);
 });
 it('refuses employee, manager, SYSTEM and missing-module paths before reading payroll',async()=>{
  for(const role of ['employee','manager'])expect(await readPayrollRecoveryHandoffs(ctx(role))).toEqual([]);
  expect(await readPayrollRecoveryHandoffs({...ctx(),userId:undefined})).toEqual([]);
  source.enabled.mockReturnValue(false);expect(await readPayrollRecoveryHandoffs(ctx())).toEqual([]);expect(source.batches).not.toHaveBeenCalled();
 });
 it('honors each risk switch separately and never offers imported history or drafts',async()=>{
  source.setting.mockImplementation((_ctx:unknown,key:string)=>key==='payroll.reset_enabled');
  expect((await readPayrollRecoveryHandoffs(ctx())).map(r=>r.operation)).toEqual(['reset']);
  source.setting.mockReturnValue(false);source.batches.mockClear();expect(await readPayrollRecoveryHandoffs(ctx())).toEqual([]);expect(source.batches).not.toHaveBeenCalled();
 });
 it('does not advertise a readable run outside the actor payroll company grant',async()=>{
  expect(await readPayrollRecoveryHandoffs({...ctx(),grants:[{role:'hr_admin',companyId:'another-company'}]})).toEqual([]);
 });
 it('bounds rendered choices and propagates native source refusal rather than inventing an empty successful result',async()=>{
  source.batches.mockResolvedValue(Array.from({length:40},(_,i)=>row('processed',String(i))));expect(await readPayrollRecoveryHandoffs(ctx())).toHaveLength(25);
  source.batches.mockRejectedValue(Error('scope revoked'));await expect(readPayrollRecoveryHandoffs(ctx())).rejects.toThrow('scope revoked');
 });
});
