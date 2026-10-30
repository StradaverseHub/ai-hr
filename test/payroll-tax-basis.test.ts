import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createCompany} from '../core/admin';
import {hireEmployee} from '../core/org';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {previewTaxBasisRecalculation,confirmTaxBasisRecalculation,taxBasisOptions,getTaxBasisBatch,listTaxBasisBatches,continueTaxBasisBatch,recoverTaxBasisBatch} from '../core/payroll-tax-basis';
import {readEffectiveTaxBasesTx} from '../core/payroll-tax-basis-read';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,employee:string,travel:string;
const rows=(employeeNo:string,amount='500')=>['01','02','03'].flatMap(month=>[
 [employeeNo,`2026-${month}`,'ME','BASIC','TAXCO','5000'],[employeeNo,`2026-${month}`,'ME','TRV','TAXCO',amount],
 [employeeNo,`2026-${month}`,'ME','EEEPF','TAXCO','0'],[employeeNo,`2026-${month}`,'ME','EESOCSO','TAXCO','0'],
 [employeeNo,`2026-${month}`,'ME','EEEIS','TAXCO','0'],[employeeNo,`2026-${month}`,'ME','PCB','TAXCO','0'],
]);
async function upload(employeeNo='0007'){
 const draft=await previewPayrollHistoryUpload(ctx,{name:'source.csv',operationKey:randomUUID(),content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(employeeNo)]))});
 expect(draft.plan.counts.invalid).toBe(0);await confirmPayrollHistoryUpload(ctx,{attemptId:draft.attemptId,previewHash:draft.plan.previewHash,confirmReplacement:true});return draft;
}
const selection=()=>({companyId:b.companyId,year:2026,upToMonth:3,employmentIds:[employee]});
const confirm=(p:Awaited<ReturnType<typeof previewTaxBasisRecalculation>>)=>confirmTaxBasisRecalculation(ctx,{previewId:p.previewId,previewHash:p.previewHash});
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'TAXCO'}).where(eq(schema.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);
 const [component]=await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'TRV',name:'Travel allowance',kind:'allowance',displayCategory:'allowance',includedInPcb:false,pcbRemunerationType:'normal'}).returning({id:schema.payComponent.id});travel=component.id;
 employee=(await hireEmployee(ctx,{person:{fullName:'Fictional Aina',primaryEmail:'tax-fixture@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0007',hiredOn:'2025-01-01'})).employmentId;
 await upload();await owner.db.update(schema.payComponent).set({includedInPcb:true}).where(eq(schema.payComponent.id,travel));
});
afterAll(closeAll);
describe('authorized immutable historical income tax corrections',()=>{
 it('reconstructs the original RM500 monthly input, preserves closed payroll and repeats safely',async()=>{
  const original=await owner.db.select().from(schema.payslip);
  const p=await previewTaxBasisRecalculation(ctx,selection());expect(p.eligibleCount).toBe(1);expect(p.recordCount).toBe(3);
  expect(p.employees[0].months.map(m=>m.taxable)).toEqual([5500,5500,5500]);expect(p.employees[0].months.map(m=>m.ytdTaxable)).toEqual([5500,11000,16500]);
  expect(p.employees[0].months[0].items.find(i=>i.code==='TRV')).toMatchObject({amount:500,taxable:500,previousTreatment:null});expect(p.totals.beforeTaxable).toBeNull();
  const done=await confirm(p);expect((await getTaxBasisBatch(ctx,done.id))?.status).toBe('completed');
  expect(await owner.db.select().from(schema.payslip)).toEqual(original);
  const corrected=await withTenant(ctx,tx=>readEffectiveTaxBasesTx(tx,ctx,original.map(s=>s.id)));expect([...corrected.values()].map(c=>c.basis.pcb)).toEqual([5500,5500,5500]);
  for(const value of corrected.values())expect(value.statutory.pcb).toBe(0);
  expect(await confirm(p)).toEqual(done);expect(await continueTaxBasisBatch(ctx,done.id)).toEqual(done);
  const revisions=await owner.db.select().from(schema.payrollTaxBasisRevision);expect(revisions).toHaveLength(3);
  const repeated=await previewTaxBasisRecalculation(ctx,selection());expect(repeated.unchangedCount).toBe(1);expect(repeated.eligibleCount).toBe(0);
 });
 it('refuses stale settings and excludes nonselected employees and other assessment years',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection());await owner.db.update(schema.payComponent).set({includedInPcb:false}).where(eq(schema.payComponent.id,travel));
  await expect(confirm(p)).rejects.toThrow(/changed/);expect(await owner.db.select().from(schema.payrollTaxBasisBatch)).toHaveLength(0);
  const other=await hireEmployee(ctx,{person:{fullName:'Fictional Daniel',primaryEmail:'tax-other@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0008',hiredOn:'2025-01-01'});await upload('0008');
  const selected=await previewTaxBasisRecalculation(ctx,selection());expect(selected.employees.map(e=>e.id)).toEqual([employee]);
  const all=await previewTaxBasisRecalculation(ctx,{...selection(),employmentIds:null});expect(all.employees.map(e=>e.id)).toContain(other.employmentId);
  const old=await previewTaxBasisRecalculation(ctx,{...selection(),year:2025,employmentIds:null});expect(old.recordCount).toBe(0);
 });
 it('denies narrow and overridden permissions at direct service boundaries',async()=>{
  const narrowed={...ctx,grants:[]};await expect(taxBasisOptions(narrowed)).rejects.toThrow(/access/);await expect(previewTaxBasisRecalculation(narrowed,selection())).rejects.toThrow(/access/);
  const p=await previewTaxBasisRecalculation(ctx,selection());
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,permissionKey:'payroll.tax-basis.recalculate',role:'hr_admin',allowed:false});
  await expect(confirm(p)).rejects.toThrow(/access/);expect(await listTaxBasisBatches(narrowed)).toEqual([]);
  await expect(previewTaxBasisRecalculation(ctx,{...selection(),companyId:randomUUID()})).rejects.toThrow(/access|unavailable/);
 });
 it('retains original employer scope after a transfer without borrowing destination history',async()=>{
  const other=await createCompany(ctx,{legalName:'Fictional destination employer',country:'MY',currency:'MYR'});
  await owner.db.update(schema.employment).set({companyId:other.id}).where(eq(schema.employment.id,employee));
  const options=await taxBasisOptions(ctx);expect(options.employees).toContainEqual(expect.objectContaining({id:employee,companyId:b.companyId}));
  const p=await previewTaxBasisRecalculation(ctx,selection());expect(p.employees[0].status).toBe('ready');const batch=await confirm(p);expect((await getTaxBasisBatch(ctx,batch.id))?.completedCount).toBe(1);
  const destination=await previewTaxBasisRecalculation(ctx,{...selection(),companyId:other.id,employmentIds:null});expect(destination.employees).toEqual([]);
 });
 it('does not silently adopt later TP3 opening values or duplicate annual exemptions',async()=>{
  const [subject]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employee));
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:subject.personId,tp3Year:2026,tp3ExemptionUsed:{PCB_TRA_BUSINESS:5000}}).onConflictDoUpdate({target:schema.employeeStatutoryMy.personId,set:{tp3Year:2026,tp3ExemptionUsed:{PCB_TRA_BUSINESS:5000}}});
  await owner.db.update(schema.payComponent).set({pcbExemptionCode:'PCB_TRA_BUSINESS'}).where(eq(schema.payComponent.id,travel));
  const p=await previewTaxBasisRecalculation(ctx,selection());expect(p.blockedCount).toBe(1);expect(p.employees[0].reason).toMatch(/prior-employer/);expect(p.eligibleCount).toBe(0);
  await owner.db.update(schema.employeeStatutoryMy).set({tp3ExemptionUsed:{}}).where(eq(schema.employeeStatutoryMy.personId,subject.personId));
  const cleared=await previewTaxBasisRecalculation(ctx,selection());expect(cleared.blockedCount).toBe(1);expect(cleared.employees[0].reason).toMatch(/prior-employer/);
 });
 it('records a failed employee outside its rolled-back transaction and requires a fresh preview to retry',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection());const failedSlip=p.employees[0].months[1].payslipId;
  await owner.db.execute(sql.raw(`create function public.test_tax_basis_failure() returns trigger language plpgsql as $$ begin if new.payslip_id='${failedSlip}'::uuid then raise exception 'fixture failure';end if;return new;end $$; create trigger test_tax_basis_failure before insert on payroll_tax_basis_revision for each row execute function public.test_tax_basis_failure();`));
  try{
   const batch=await confirm(p);expect((await getTaxBasisBatch(ctx,batch.id))?.status).toBe('failed');expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
   await owner.db.execute(sql.raw('drop trigger test_tax_basis_failure on payroll_tax_basis_revision;drop function public.test_tax_basis_failure();'));
   expect(await confirm(p)).toEqual(batch);expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(0);
   const fresh=await previewTaxBasisRecalculation(ctx,selection());const done=await confirm(fresh);expect((await getTaxBasisBatch(ctx,done.id))?.completedCount).toBe(1);expect(await owner.db.select().from(schema.payrollTaxBasisRevision)).toHaveLength(3);
  }finally{await owner.db.execute(sql.raw('drop trigger if exists test_tax_basis_failure on payroll_tax_basis_revision;drop function if exists public.test_tax_basis_failure();'));}
 });
 it('keeps immutable correction records tenant-bound and refuses active-batch recovery',async()=>{
  const p=await previewTaxBasisRecalculation(ctx,selection()),done=await confirm(p);
  await expect(withTenant(ctx,tx=>tx.execute(sql`update payroll_tax_basis_revision set ordinal=ordinal+1 where batch_id=${done.id}::uuid`))).rejects.toThrow();
  expect((await getTaxBasisBatch(ctx,done.id))?.employees[0].months).toHaveLength(3);
  expect(await recoverTaxBasisBatch(ctx,done.id)).toEqual(done);
  const foreign={...ctx,tenantId:randomUUID()};await expect(getTaxBasisBatch(foreign,done.id)).resolves.toBeNull();
 });
});
