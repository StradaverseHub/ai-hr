import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentPaymentMethod} from '../core/org';
import {sweepDueMovements} from '../core/movement-apply';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,id:string;
beforeAll(migrateTestDb);beforeEach(async()=>{
 await resetDb();b=await seedBase();id=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Dated Method',primaryEmail:'dated-method@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await setEmploymentPaymentMethod(adminCtx(b),{employmentId:id,paymentMethod:'cash',effectiveDate:'2026-01-01'});
});afterAll(closeAll);
describe('payment method current-column projection',()=>{
 it('projects a due method even without a scheduled Movement, with no duplicate history on retry',async()=>{
  const ctx=adminCtx(b),today=todayInKualaLumpur(),future=new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cheque',effectiveDate:future});
  const current=async()=>(await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].paymentMethod;
  expect(await current()).toBe('cash');
  await sweepDueMovements(ctx,{today});expect(await current()).toBe('cash');
  const history=await owner.db.select().from(s.employmentPaymentMethodHistory).orderBy(s.employmentPaymentMethodHistory.id);
  await sweepDueMovements(ctx,{today:future});expect(await current()).toBe('cheque');
  await sweepDueMovements(ctx,{today:future});
  expect(await owner.db.select().from(s.employmentPaymentMethodHistory).orderBy(s.employmentPaymentMethodHistory.id)).toEqual(history);
  expect(await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'employment.payment-method.projected'))).toHaveLength(1);
 });
 it('refuses a fabricated system principal while the actual owner can execute the admitted projection',async()=>{
  const ctx=adminCtx(b),today=todayInKualaLumpur(),future=new Date(Date.parse(today+'T00:00:00Z')+7*86400000).toISOString().slice(0,10);
  await setEmploymentPaymentMethod(ctx,{employmentId:id,paymentMethod:'cheque',effectiveDate:future});
  // The batch closes AFTER scheduling, so only the actual system projection can preserve it.
  const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:today.slice(0,7),status:'closed'}).returning();
  const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:today.slice(0,7),batchDate:today,status:'closed'}).returning();
  const [issued]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'system preservation'}}).returning();
  const system={...ctx,userId:undefined,personId:null};
  expect(await sweepDueMovements(system,{today:future})).toMatchObject({failed:1});
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].paymentMethod).toBe('cash');
  expect(await sweepDueMovements(system,{today:future},owner.withTenant)).toMatchObject({failed:0});
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].paymentMethod).toBe('cheque');
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,issued.id)))[0]).toEqual(issued);
  const [snapshot]=await owner.db.select().from(s.informationPayslipSnapshot).where(eq(s.informationPayslipSnapshot.payslipId,issued.id));
  expect(snapshot.recordedBy).toBeNull();expect(snapshot.documentMetadata).toMatchObject({preservationActor:'system'});
 });
});
