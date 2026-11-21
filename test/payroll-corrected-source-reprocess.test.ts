import {setPayrollBatchComponent} from '../core/pay-components';
import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as S from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createAdditionalRun,createBatch,generatePayslips,reprocessSelectedEmployees,getReprocessJob,reviewReprocessTaxReadiness} from '../core/payroll';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation,getTaxBasisBatch} from '../core/payroll-tax-basis';
import {readEffectiveTaxBasesTx,hashTaxBasisSource,taxBasisSourceRowsTx} from '../core/payroll-tax-basis-read';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,employmentId:string,travelId:string,batchId:string;
const slip=async(runId=batchId,employee=employmentId)=> (await owner.db.select().from(S.payslip).where(and(eq(S.payslip.batchId,runId),eq(S.payslip.employmentId,employee))))[0];
async function anotherEmployee(){
 const subject=await hireEmployee(ctx,{person:{fullName:'Fictional comparison employee',primaryEmail:'comparison@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
 await setCompensation(ctx,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:'2025-01-01'});
 await setStatutoryProfileMY(ctx,{personId:subject.personId,icNumber:'850202025556',taxCategory:1,numChildren:0});
 return subject.employmentId;
}
const tax=(row:Awaited<ReturnType<typeof slip>>)=>(row.statutory as {pcb:number;bases:{pcb:number};replayedTaxSources?:unknown});
async function correct(){const p=await previewTaxBasisRecalculation(ctx,{companyId:b.companyId,year:2026,upToMonth:1,employmentIds:[employmentId]});expect(p.blockedCount).toBe(0);expect(p.eligibleCount).toBe(1);const result=await confirmTaxBasisRecalculation(ctx,{previewId:p.previewId,previewHash:p.previewHash});const batch=await getTaxBasisBatch(ctx,result.id);expect(batch?.employees.map(e=>({status:e.status,reason:e.reason}))).toEqual([{status:'completed',reason:null}]);return result;}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','active');await setModule(b.tenantId,'multi_cycle_payroll','active');ctx=await entitledCtx(b);
 const subject=await hireEmployee(ctx,{person:{fullName:'Fictional corrected employee',primaryEmail:'corrected-source@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});employmentId=subject.employmentId;
 await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:'2025-01-01'});await setStatutoryProfileMY(ctx,{personId:subject.personId,icNumber:'850202025555',taxCategory:1,numChildren:0});
 const [item]=await owner.db.insert(S.payComponent).values({tenantId:b.tenantId,code:'TRV',name:'Fictional travel',kind:'allowance',displayCategory:'allowance',includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_NON-TAXABLE'}).returning();travelId=item.id;
 batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-01'})).batchId;
 await setPayrollBatchComponent(ctx,{batchId,employmentId,componentId:travelId,amount:500});await generatePayslips(ctx,{batchId});
 await owner.db.update(S.payComponent).set({pcbExemptionCode:'PCB_TAXABLE'}).where(eq(S.payComponent.id,travelId));
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
  const [fresh]=await owner.db.select().from(S.payrollBatch).where(eq(S.payrollBatch.id,batchId));expect(fresh.recalcEmploymentIds??[]).toEqual([]);
 });
 it('does not replay a completed old job after a distinct fresh tax correction',async()=>{
  await correct();const key=randomUUID();const first=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:key});
  await owner.db.update(S.payComponent).set({pcbExemptionCode:'PCB_NON-TAXABLE'}).where(eq(S.payComponent.id,travelId));await correct();
  const next=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:key});expect(next.jobId).not.toBe(first.jobId);expect((await slip()).version).toBe(3);expect(((await slip()).statutory as {bases:{pcb:number}}).bases.pcb).toBe(5000);
 });
 it('recalculates a changed locked current source and keeps the original correction hash',async()=>{
  await correct();
  const source=await slip();
  const revision=(await owner.db.select().from(S.payrollTaxBasisRevision))[0];
  await owner.db.execute(sql`update payslip set statutory=statutory || '{"fixtureMetadataChanged":true}'::jsonb where id=${source.id}::uuid`);
  const result=await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()});
  expect(result.status).toBe('completed');
  expect((await getReprocessJob(ctx,result.jobId))?.result).toMatchObject({outcomes:[{employmentId,status:'reprocessed',taxBasisRecalculated:true}]});
  const fresh=await slip();
  expect(fresh).toMatchObject({id:source.id,version:2});
  expect(fresh.statutory).not.toHaveProperty('fixtureMetadataChanged');
  expect(tax(fresh).bases.pcb).toBe(5500);
  expect(await owner.db.select().from(S.payrollTaxBasisRevision)).toEqual([revision]);
  const [receipt]=await owner.db.execute(sql`select before_hash,(before_source->'source'->'statutory'->>'fixtureMetadataChanged')::boolean as metadata_changed,recalculated from payroll_tax_basis_replacement`);
  expect(receipt).toMatchObject({recalculated:true,metadata_changed:true});
  expect(receipt.before_hash).not.toEqual(revision.sourceHash);
  expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[fresh.id]))).size).toBe(0);
 });
 it('keeps a changed current source eligible alongside a ready employee without writing payroll',async()=>{
  await correct();
  const source=await slip();
  const ready=await hireEmployee(ctx,{person:{fullName:'Fictional ready employee',primaryEmail:'ready-payroll@example.test'},
    companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  await owner.db.update(S.payslip).set({netPay:'1.00'}).where(eq(S.payslip.id,source.id));
  const review=await reviewReprocessTaxReadiness(ctx,batchId,[employmentId,ready.employmentId]);
  expect(review.employees).toHaveLength(2);
  expect(review.employees.find(e=>e.employmentId===employmentId)).toMatchObject({status:'ready'});
  expect(review.employees.find(e=>e.employmentId===ready.employmentId)).toMatchObject({status:'ready'});
  expect(await owner.db.select().from(S.payrollReprocessJob)).toEqual([]);
  expect((await slip()).version).toBe(1);
 });
 it('uses the normal PCB engine for changed cash and safely resumes or reruns',async()=>{
  await correct();
  const revision=(await owner.db.select().from(S.payrollTaxBasisRevision))[0];
  const comparison=await anotherEmployee();
  await setPayrollBatchComponent(ctx,{batchId,employmentId,componentId:travelId,amount:650});
  await setPayrollBatchComponent(ctx,{batchId,employmentId:comparison,componentId:travelId,amount:650});
  const key=randomUUID();
  const selection={batchId,employmentIds:[employmentId,comparison],idempotencyKey:key};
  const job=await reprocessSelectedEmployees(ctx,selection);
  expect(job.status).toBe('completed');
  const fresh=await slip(),ordinary=await slip(batchId,comparison);
  expect(fresh).toMatchObject({version:2,grossPay:'5650.00'});
  expect(tax(fresh).bases.pcb).toBe(5650);
  expect(tax(ordinary).pcb).toBeGreaterThan(0);
  expect(tax(fresh).pcb).toBe(tax(ordinary).pcb);
  expect((await reprocessSelectedEmployees(ctx,selection)).jobId).toBe(job.jobId);
  expect((await slip()).version).toBe(2);
  await reprocessSelectedEmployees(ctx,{...selection,idempotencyKey:randomUUID()});
  expect((await slip()).version).toBe(3);
  expect(await owner.db.select().from(S.payrollTaxBasisRevision)).toEqual([revision]);
  expect(await owner.db.execute(sql`select id from payroll_tax_basis_replacement`)).toHaveLength(2);
  expect(await owner.db.select().from(S.payslip).where(eq(S.payslip.batchId,batchId))).toHaveLength(2);
 });
 it('rebuilds changed prior-month inputs from exact history while preserving the older payslip and correction',async()=>{
  await correct();
  const feb=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-02'})).batchId;
  await generatePayslips(ctx,{batchId:feb});
  const old=await slip();
  const revision=(await owner.db.select().from(S.payrollTaxBasisRevision))[0];
  await owner.db.update(S.payslip).set({netPay:'1.00'}).where(eq(S.payslip.id,old.id));
  const changed=await slip();
  const [source]=await withTenant(ctx,tx=>taxBasisSourceRowsTx(tx,[old.id]));
  const originalFeb=await slip(feb);
  expect((await reviewReprocessTaxReadiness(ctx,feb,[employmentId])).employees).toMatchObject([{employmentId,status:'ready'}]);
  const result=await reprocessSelectedEmployees(ctx,{batchId:feb,employmentIds:[employmentId],idempotencyKey:randomUUID()});
  expect(result.status).toBe('completed');
  const refreshed=await slip(feb);
  expect(tax(refreshed).pcb).toBe(tax(originalFeb).pcb);
  expect(tax(refreshed).replayedTaxSources).toEqual([expect.objectContaining({payslipId:old.id,sourceHash:hashTaxBasisSource(source),rulesHash:expect.stringMatching(/^[a-f0-9]{64}$/),settingsHash:expect.stringMatching(/^[a-f0-9]{64}$/)})]);
  expect(await slip()).toEqual(changed);
  expect(await owner.db.select().from(S.payrollTaxBasisRevision)).toEqual([revision]);
 });
 it('replays an earlier cycle as same-month tax inputs and keeps its cash and paid PCB',async()=>{
  await correct();
  const [bonus]=await owner.db.insert(S.payComponent).values({tenantId:b.tenantId,code:'BONUS',name:'Fictional bonus',kind:'allowance',displayCategory:'bonus',includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE'}).returning();
  const additional=(await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:'2026-01',runType:'bonus'})).batchId;
  await setPayrollBatchComponent(ctx,{batchId:additional,employmentId,componentId:bonus.id,amount:1200});
  await generatePayslips(ctx,{batchId:additional});
  const earlier=await slip();
  await owner.db.execute(sql`update payslip set statutory=statutory || '{"fixtureMetadataChanged":true}'::jsonb where id=${earlier.id}::uuid`);
  const changed=await slip(),before=await slip(additional);
  expect((await reviewReprocessTaxReadiness(ctx,additional,[employmentId])).employees).toMatchObject([{employmentId,status:'ready'}]);
  const outcome=await reprocessSelectedEmployees(ctx,{batchId:additional,employmentIds:[employmentId],idempotencyKey:randomUUID()});
  expect(outcome.status).toBe('completed');
  const refreshed=await slip(additional);
  expect(refreshed.version).toBe(before.version+1);
  expect(tax(before).pcb).toBeGreaterThan(0);
  expect(tax(refreshed).pcb).toBe(tax(before).pcb);
  expect(tax(refreshed).replayedTaxSources).toEqual([expect.objectContaining({payslipId:earlier.id})]);
  expect(await slip()).toEqual(changed);
 });
 it('continues to refuse unauthorized and closed-run reprocess attempts',async()=>{
  const before=await slip();
  const selection={batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()};
  await expect(reprocessSelectedEmployees({...ctx,userId:randomUUID()},selection)).rejects.toThrow();
  await closeBatch(ctx,{batchId});
  const closed=await slip();
  await expect(reprocessSelectedEmployees(ctx,{...selection,idempotencyKey:randomUUID()})).rejects.toThrow();
  expect(await slip()).toEqual(closed);
  expect(closed.id).toBe(before.id);
 });
 it('keeps a prior result on genuine missing evidence and continues the selected employees',async()=>{
  await correct();
  const comparison=await anotherEmployee();
  const feb=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-02'})).batchId;
  await generatePayslips(ctx,{batchId:feb});
  const old=await slip(),oldFeb=await slip(feb);
  await owner.db.execute(sql`update payslip set statutory=statutory - 'componentLines' where id=${old.id}::uuid`);
  const review=await reviewReprocessTaxReadiness(ctx,feb,[employmentId,comparison]);
  expect(review.employees).toEqual(expect.arrayContaining([
   expect.objectContaining({employmentId,status:'blocked',reason:expect.stringContaining('original Pay Item detail')}),
   expect.objectContaining({employmentId:comparison,status:'ready'}),
  ]));
  const result=await reprocessSelectedEmployees(ctx,{batchId:feb,employmentIds:[employmentId,comparison],idempotencyKey:randomUUID()});
  expect(result.status).toBe('completed');
  expect((await getReprocessJob(ctx,result.jobId))?.result).toMatchObject({validationFailed:1,reprocessed:1,outcomes:expect.arrayContaining([
   expect.objectContaining({employmentId,status:'validation_failed',resultRetained:true,validationCode:'payroll_tax_evidence',validationDetails:[{gap:expect.stringContaining('original Pay Item detail')}] }),
   expect.objectContaining({employmentId:comparison,status:'reprocessed'}),
  ])});
  expect(await slip(feb)).toEqual(oldFeb);
  expect((await slip(feb,comparison)).version).toBe(2);
 });
 it('makes lineage immutable, tenant-bound and impossible to invent without a real replacement history',async()=>{
  await correct();await reprocessSelectedEmployees(ctx,{batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()});
  await withTenant(ctx,tx=>tx.execute(sql`delete from payroll_tax_basis_replacement`));expect(await owner.db.execute(sql`select id from payroll_tax_basis_replacement`)).toHaveLength(1);
  await expect(owner.db.execute(sql`delete from payroll_tax_basis_replacement`)).rejects.toThrow();
  const foreign={...ctx,tenantId:randomUUID()};expect(await withTenant(foreign,tx=>tx.execute(sql`select id from payroll_tax_basis_replacement`))).toHaveLength(0);
 });
});
