/** Exact native receipt custody over a detached baseline, with real eligible YTD consumers. */
import {afterAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {createBatch,generatePayslips,resetProcessedBatch} from '../core/payroll';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation} from '../core/payroll-tax-basis';
import {readEffectiveTaxBasesTx,taxBasisSourceRowsTx} from '../core/payroll-tax-basis-read';
import {nativePayrollPayslip} from '../core/payroll-history-native-baseline';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,employmentId:string,batchId:string;
const selection=()=>({companyId:b.companyId,year:2026,upToMonth:1,employmentIds:[employmentId]});
const effective=()=>withTenant(ctx,tx=>tx.select().from(s.payslip).where(eq(s.payslip.employmentId,employmentId)));
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','active');await setSetting(b.tenantId,'payroll.reset_enabled',true);ctx=await entitledCtx(b);
 await owner.db.update(s.company).set({companyLabel:'CUSTODY'}).where(eq(s.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
 const hire=await hireEmployee(ctx,{person:{fullName:'Fictional native tax custody',primaryEmail:'native-tax-custody@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'C001',hiredOn:'2025-01-01'});employmentId=hire.employmentId;
 await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:'2025-01-01'});await setStatutoryProfileMY(ctx,{personId:hire.personId,icNumber:'850202025555',taxCategory:1,numChildren:0});batchId=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-01'})).batchId;await generatePayslips(ctx,{batchId});
});
afterAll(closeAll);
it('supersedes only proven old native inputs, preserves the preexisting reset hold, and freshly reviews restored native history without relabelling an old hash',async()=>{
 const [original]=await effective();expect(original).toBeTruthy();const initial=await previewTaxBasisRecalculation(ctx,selection());expect(initial.employees[0].reason).toBeNull();expect(initial.eligibleCount).toBe(1);await confirmTaxBasisRecalculation(ctx,{previewId:initial.previewId,previewHash:initial.previewHash});
 const [receipt]=await owner.db.select().from(s.payrollTaxBasisRevision).where(eq(s.payrollTaxBasisRevision.payslipId,original.id));expect(receipt.basis.pcb).toBe(5000);const oldHash=receipt.sourceHash;
 const review=await previewPayrollHistoryUpload(ctx,{name:'fictional-native-listed.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),['C001','2026-01','ME','BASIC','CUSTODY','6000.00']])),maintenance:{version:1,mode:'update_listed',reason:'Reviewed listed total over an already tax-reviewed native run'}});expect(review.plan.counts.invalid).toBe(0);const applied=await confirmPayrollHistoryUpload(ctx,{attemptId:review.attemptId,previewHash:review.plan.previewHash,confirmReplacement:true}),currentId=applied.changes[0].snapshotId!;
 const projected=await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[currentId],{includeImported:true}));expect(projected.get(currentId)?.basis.pcb).toBe(6000);expect(projected.get(currentId)?.correction).toBeNull();
 const predecessor=await withTenant(ctx,tx=>tx.execute<{sourceId:string;id:string}>(sql`select * from app.payroll_history_native_tax_predecessors(ARRAY[${currentId}::uuid])`));expect(predecessor).toEqual([{sourceId:currentId,id:receipt.id}]);expect(await withTenant(ctx,tx=>tx.execute(sql`select * from app.payroll_history_native_tax_predecessors(ARRAY[${original.id}::uuid])`))).toEqual([]);
 const foreign=await seedBase();await setModule(foreign.tenantId,'payroll','active');expect(await withTenant(await entitledCtx(foreign),tx=>tx.execute(sql`select * from app.payroll_history_native_tax_predecessors(ARRAY[${currentId}::uuid])`))).toEqual([]);
 const future=(await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-02'})).batchId;await generatePayslips(ctx,{batchId:future});const [firstFuture]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,future));expect((firstFuture.statutory as {pcbMeta:{ytdGross:number}}).pcbMeta.ytdGross).toBe(6000);
 // This receipt FK already prohibited deleting the reviewed native source before maintenance.
 // Maintenance preserves that immutable-source refusal instead of cascading or moving the receipt.
 await expect(resetProcessedBatch(ctx,{batchId,reason:'Attempt to reset an already reviewed native source'})).rejects.toThrow(/foreign key|payroll_tax_basis_revision|constraint/i);
 expect(await withTenant(ctx,tx=>tx.select().from(nativePayrollPayslip).where(eq(nativePayrollPayslip.id,original.id)))).toEqual([original]);expect((await owner.db.select().from(s.payrollTaxBasisRevision).where(eq(s.payrollTaxBasisRevision.id,receipt.id)))[0]).toEqual(receipt);
 const removal=await previewPayrollHistoryRevert(ctx,review.attemptId);await revertPayrollHistoryUpload(ctx,review.attemptId,removal.previewHash);const restored=(await effective()).find(row=>row.batchId!==future)!;expect(restored.id).not.toBe(original.id);expect(restored.statutory).toEqual(original.statutory);
 const [restoredSource]=await withTenant(ctx,tx=>taxBasisSourceRowsTx(tx,[restored.id]));expect(restoredSource.historyAttemptId).toBeNull();await expect(withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[restored.id],{includeImported:true}))).rejects.toThrow(/Saved payroll changed/);
 const fresh=await previewTaxBasisRecalculation(ctx,selection());expect(fresh.employees[0].reason).toBeNull();expect(fresh.employees[0].months[0].taxable).toBe(5000);expect(fresh.employees[0].months[0].basis.supersedes).toContain(receipt.id);await confirmTaxBasisRecalculation(ctx,{previewId:fresh.previewId,previewHash:fresh.previewHash});
 const [replacement]=await owner.db.select().from(s.payrollTaxBasisRevision).where(eq(s.payrollTaxBasisRevision.payslipId,restored.id));expect(replacement.sourceHash).not.toBe(oldHash);expect(replacement.basis.supersedes).toContain(receipt.id);expect((await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,[restored.id],{includeImported:true}))).get(restored.id)?.basis.pcb).toBe(5000);
 await resetProcessedBatch(ctx,{batchId:future,reason:'Review the changed historical prefix'});await generatePayslips(ctx,{batchId:future});const [nextFuture]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,future));expect((nextFuture.statutory as {pcbMeta:{ytdGross:number}}).pcbMeta.ytdGross).toBe(5000);expect((await owner.db.select().from(s.payrollTaxBasisRevision).where(eq(s.payrollTaxBasisRevision.id,receipt.id)))[0]).toEqual(receipt);expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,original.id)))[0]).toEqual(original);
},180000);
