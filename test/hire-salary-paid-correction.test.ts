import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {correctHireDetails,hireCorrectionView} from '../core/hire-correction';
import {movementCurrentState,movementDetail,movementHistory} from '../core/movement';
let b:Base,id:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();const ctx=adminCtx(b);
 id=(await hireEmployee(ctx,{person:{fullName:'Fictional Paid Hire Correction',primaryEmail:'paid-hire@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:'2026-01-01'});
 await setCompensation(ctx,{employmentId:id,basicSalary:4000,effectiveFrom:'2026-03-01'});
});
afterAll(closeAll);
async function closed(period:string){
 const [parent]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:parent.id,payPeriod:period,batchDate:period+'-25',status:'closed'}).returning();
 await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'retained original'}});
}
async function issued(){return {batches:await owner.db.select().from(s.payrollBatch).orderBy(s.payrollBatch.id),slips:await owner.db.select().from(s.payslip).orderBy(s.payslip.id)};}
async function correct(amount:number){return correctHireDetails(adminCtx(b),{employmentId:id,changes:{},basicSalary:amount,reason:'Fictional original hire amount correction'});}
describe('original hire salary corrections preserve paid evidence',()=>{
 it('changes only the remaining open interval and retains a later intentional salary, including repeated correction',async()=>{
  await closed('2026-01');const before=await issued();
  await correct(3400);await correct(3450);
  const terms=await owner.db.select({from:s.compensation.validFrom,to:s.compensation.validTo,amount:s.compensation.basicSalary}).from(s.compensation).where(and(eq(s.compensation.employmentId,id),isNull(s.compensation.supersededAt))).orderBy(s.compensation.validFrom);
  expect(terms).toEqual([{from:'2026-01-01',to:'2026-02-01',amount:'3000.00'},{from:'2026-02-01',to:'2026-03-01',amount:'3450.00'},{from:'2026-03-01',to:null,amount:'4000.00'}]);
  expect(await issued()).toEqual(before);expect(await movementCurrentState(adminCtx(b),id)).toMatchObject({basicSalary:'4000.00'});
  expect((await hireCorrectionView(adminCtx(b),id)).salaryAtHire).toMatchObject({amount:'3450.00'});
  const hired=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='hired')!;expect(hired.basic).toBe('MYR 3450.00');
  expect((await movementDetail(adminCtx(b),id,hired.id))?.after).toMatchObject({salaryAmount:'3450.00',salaryPayrollFrom:'2026-02-01'});
 });
 it('snapshots closed documents only, leaving processed open documents available for normal recalculation',async()=>{
  await closed('2026-01');
  const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2026-02',status:'open'}).returning();
  const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2026-02',batchDate:'2026-02-25',status:'processed'}).returning();
  const [openSlip]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'open recalculable'}}).returning();
  await correct(3450);
  const snapshots=await owner.db.select().from(s.informationPayslipSnapshot).where(eq(s.informationPayslipSnapshot.employmentId,id));
  expect(snapshots).toHaveLength(1);expect(snapshots.some(row=>row.payslipId===openSlip.id)).toBe(false);
  expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batch.id)))[0].needsRecalcAt).not.toBeNull();
 });
 it('retains a wholly finalized correction as an information reference without changing live salary windows',async()=>{
  await closed('2026-01');await closed('2026-02');const before=await issued();
  const liveBefore=await owner.db.select().from(s.compensation).where(and(eq(s.compensation.employmentId,id),isNull(s.compensation.supersededAt))).orderBy(s.compensation.id);
  await correct(3500);
  expect(await owner.db.select().from(s.compensation).where(and(eq(s.compensation.employmentId,id),isNull(s.compensation.supersededAt))).orderBy(s.compensation.id)).toEqual(liveBefore);
  expect(await issued()).toEqual(before);expect((await hireCorrectionView(adminCtx(b),id)).salaryAtHire).toMatchObject({amount:'3500.00'});
  const [event]=await owner.db.select({id:s.domainEvent.aggregateId,payload:s.domainEvent.payload}).from(s.domainEvent).where(eq(s.domainEvent.eventType,'compensation.hire-corrected'));
  expect(event.payload).toMatchObject({informationOnly:true,paidSourcePreserved:true,payrollEffectiveFrom:null,until:'2026-03-01'});
  const [reference]=await owner.db.select().from(s.compensation).where(eq(s.compensation.id,event.id));expect(reference.supersededAt).not.toBeNull();expect(reference.basicSalary).toBe('3500.00');
 });
});
