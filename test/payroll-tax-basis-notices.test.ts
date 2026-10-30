import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {taxBasisNoticeReferences,taxBasisNoticesForPayslip} from '../core/payroll-tax-basis-notices';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);});afterAll(closeAll);
async function fixture(consumed=false){
 const previewId=randomUUID(),correctionBatchId=randomUUID();
 const {employmentId}=await hireEmployee(ctx,{person:{fullName:'Fictional original tax working',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2026-01',status:'closed'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2026-01',batchDate:'2026-01-25',status:'closed'}).returning();
 const [slip]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'5000',grossPay:'5500',totalDeductions:'100',netPay:'5400',employerCost:'5500',statutory:{pcb:100,bases:{pcb:5000},...(consumed?{taxBasisCorrections:[{batchId:correctionBatchId}]}:{})}}).returning();
 await withTenant(ctx,async tx=>{
  await tx.execute(sql`insert into payroll_tax_basis_preview(id,tenant_id,company_id,created_by,preview,selection,preview_hash,expires_at) values(${previewId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${ctx.userId!}::uuid,'{}','{}',${'a'.repeat(64)},now()+interval '15 minutes')`);
  await tx.execute(sql`insert into payroll_tax_basis_batch(id,tenant_id,company_id,created_by,preview_id) values(${correctionBatchId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${ctx.userId!}::uuid,${previewId}::uuid)`);
  // Deliberately stale fingerprint: original working must still disclose its audit reference,
  // without attempting to apply or validate a replacement financial basis.
  await tx.execute(sql`insert into payroll_tax_basis_revision(tenant_id,company_id,employment_id,payslip_id,period,source_hash,ordinal,batch_id,basis) values(${b.tenantId}::uuid,${b.companyId}::uuid,${employmentId}::uuid,${slip.id}::uuid,'2026-01',${'0'.repeat(64)},1,${correctionBatchId}::uuid,'{"version":1}')`);
 });return {ctx,slip,batch,employmentId,correctionBatchId};
}
describe('tax-basis notices preserve original working and scope administrative links',()=>{
 it('shows recorded corrections beside original working without changing or reinterpreting its values',async()=>{
  const {ctx,slip,correctionBatchId}=await fixture();
  const notices=await taxBasisNoticesForPayslip(ctx,{companyIds:[b.companyId],payslipId:slip.id});
  expect(notices).toEqual({original:[{batchId:correctionBatchId,reference:'TAX-'+correctionBatchId.slice(0,8).toUpperCase(),canOpen:true}],applied:[]});
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,slip.id)))[0]).toEqual(slip);
 });
 it('discloses the reference without granting access to a denied administrative log',async()=>{
  const {ctx,slip,correctionBatchId}=await fixture();
  await owner.db.insert(s.payrollPermissionGrant).values({tenantId:b.tenantId,companyId:b.companyId,role:'hr_admin',permissionKey:'payroll.tax-basis.view',allowed:false});
  const notices=await taxBasisNoticesForPayslip(ctx,{companyIds:[b.companyId],payslipId:slip.id});
  expect(notices.original).toMatchObject([{batchId:correctionBatchId,canOpen:false}]);
  expect(await taxBasisNoticeReferences(ctx,[{batchId:correctionBatchId}])).toMatchObject([{batchId:correctionBatchId,canOpen:false}]);
 });
 it('fails closed for empty, malformed and foreign scopes',async()=>{
  const {ctx,slip}=await fixture();const empty={original:[],applied:[]};
  expect(await taxBasisNoticesForPayslip(ctx,{companyIds:[],payslipId:slip.id})).toEqual(empty);
  expect(await taxBasisNoticesForPayslip(ctx,{companyIds:[b.companyId],payslipId:'-'.repeat(36)})).toEqual(empty);
  expect(await taxBasisNoticesForPayslip(ctx,{companyIds:[randomUUID()],payslipId:slip.id})).toEqual(empty);
  const other=await seedBase();await setModule(other.tenantId,'payroll','active');expect(await taxBasisNoticesForPayslip(await entitledCtx(other),{companyIds:[b.companyId],payslipId:slip.id})).toEqual(empty);
 });
 it('distinguishes consumed correction references from corrections to the original source',async()=>{
  const {ctx,slip}=await fixture(true);
  const notices=await taxBasisNoticesForPayslip(ctx,{companyIds:[b.companyId],payslipId:slip.id});expect(notices.original).toHaveLength(1);expect(notices.applied).toEqual(notices.original);
 });
});
