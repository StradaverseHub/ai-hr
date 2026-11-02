import {setPayrollBatchComponent} from '../core/pay-components';
import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as S from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips,reprocessSelectedEmployees,getReprocessJob,PayrollReprocessStoppedError} from '../core/payroll';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {readEffectiveTaxBasesTx} from '../core/payroll-tax-basis-read';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,employmentId:string,travelId:string,batchId:string;
const slip=async()=> (await owner.db.select().from(S.payslip).where(eq(S.payslip.batchId,batchId)))[0];
async function correct(){const p=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year:2026,upToMonth:1,employmentIds:[employmentId]});expect(p.blockedCount).toBe(0);expect(p.eligibleCount).toBe(1);return confirmTaxBasisRecalculation(ctx,{previewId:p.previewId,previewHash:p.previewHash});}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','active');await setModule(b.tenantId,'multi_cycle_payroll','active');ctx=await entitledCtx(b);
 const subject=await hireEmployee(ctx,{person:{fullName:'Fictional corrected employee',primaryEmail:'corrected-source@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});employmentId=subject.employmentId;
 await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:'2025-01-01'});await setStatutoryProfileMY(ctx,{personId:subject.personId,icNumber:'850202025555',taxCategory:1,numChildren:0});
 const [item]=await owner.db.insert(S.payComponent).values({tenantId:b.tenantId,code:'TRV',name:'Fictional travel',kind:'allowance',displayCategory:'allowance',includedInPcb:false,includedInEpf:false,includedInSocsoEis:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE'}).returning();travelId=item.id;
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-01'})).batchId;
 await setPayrollBatchComponent(ctx,{batchId,employmentId,componentId:travelId,amount:500});await generatePayslips(ctx,{batchId});
 await owner.db.update(S.payComponent).set({includedInPcb:true}).where(eq(S.payComponent.id,travelId));
});
afterAll(closeAll);
describe('corrected native payslip replacement custody',()=>{
 it('retains corrected source identity, consumes its correction with exact history and can reprocess twice',async()=>{
  const before=await slip();await correct();
  const [marked]=await owner.db.select().from(S.payrollBatch).where(eq(S.payrollBatch.id,batchId));expect(marked.recalcEmploymentIds).toContain(employmentId);
  const revision=(await owner.db.select().from(S.payrollTaxBasisRevision))[0];
  const key=randomUUID(),job=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:key});expect(job.status).toBe('completed');
  const after=await slip();expect(after.id).toBe(before.id);expect(after.version).toBe(2);expect(Number(after.grossPay)).toBe(5500);expect((after.statutory as {bases:{pcb:number}}).bases.pcb).toBe(5500);
  expect(await owner.db.select().from(S.payrollTaxBasisRevision)).toEqual([revision]);
  const receipts=await owner.db.execute(sql`select * from payroll_tax_basis_replacement`);expect(receipts).toHaveLength(1);
  expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[after.id]))).size).toBe(0);
  await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:key});expect((await slip()).version).toBe(2);
  await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()});expect((await slip()).version).toBe(3);
  expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[after.id]))).size).toBe(0);expect(await owner.db.execute(sql`select id from payroll_tax_basis_replacement`)).toHaveLength(2);
  const [fresh]=await owner.db.select().from(S.payrollBatch).where(eq(S.payrollBatch.id,batchId));expect(fresh.recalcEmploymentIds).toEqual([]);
 });
 it('does not replay a completed old job after a distinct fresh tax correction',async()=>{
  await correct();const key=randomUUID();const first=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:key});
  await owner.db.update(S.payComponent).set({includedInPcb:false}).where(eq(S.payComponent.id,travelId));await correct();
  const next=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:key});expect(next.jobId).not.toBe(first.jobId);expect((await slip()).version).toBe(3);expect(((await slip()).statutory as {bases:{pcb:number}}).bases.pcb).toBe(5000);
 });
 it('keeps unrelated source mutations blocked and names the failed employee without inventing success',async()=>{
  await correct();const source=await slip();await owner.db.update(S.payslip).set({netPay:'1.00'}).where(eq(S.payslip.id,source.id));
  const error=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()}).catch(e=>e);expect(error).toBeInstanceOf(PayrollReprocessStoppedError);expect(error.code).toBe('TAX_BASIS_SOURCE_CHANGED');
  const job=await getReprocessJob(ctx,error.jobId);expect(job?.status).toBe('failed');expect(job?.stopCode).toBe('TAX_BASIS_SOURCE_CHANGED');expect(job?.result).toMatchObject({outcomes:[],stoppedEmployee:{employmentId,name:'Fictional corrected employee'}});
  expect((await slip()).version).toBe(1);expect(await owner.db.execute(sql`select id from payroll_tax_basis_replacement`)).toHaveLength(0);
 });
 it('makes lineage immutable, tenant-bound and impossible to invent without a real replacement history',async()=>{
  await correct();await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()});
  await expect(withTenant(ctx,tx=>tx.execute(sql`delete from payroll_tax_basis_replacement`))).rejects.toThrow();
  const foreign={...ctx,tenantId:randomUUID()};expect(await withTenant(foreign,tx=>tx.execute(sql`select id from payroll_tax_basis_replacement`))).toHaveLength(0);
 });
});
