import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {batchDetail,createBatch} from '../packs/payroll/service';
import {person,employment,payslip,payrollBatch} from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
describe('payroll detail database pages',()=>{
 it('bounds payslip snapshots, preserves totals and keeps off-page recalculation identities',async()=>{
  const ctx=adminCtx(b),{batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-05'});
  const subjects=Array.from({length:61},(_,i)=>({personId:randomUUID(),id:randomUUID(),name:`Fictional ${String(i).padStart(3,'0')}`}));
  await owner.db.insert(person).values(subjects.map(row=>({id:row.personId,tenantId:b.tenantId,fullName:row.name})));
  await owner.db.insert(employment).values(subjects.map(row=>({id:row.id,tenantId:b.tenantId,personId:row.personId,companyId:b.companyId,hiredOn:'2026-01-01'})));
  await owner.db.insert(payslip).values(subjects.map(row=>({tenantId:b.tenantId,batchId,employmentId:row.id,basicSalary:'100',grossPay:'100',statutory:{fixture:'x'.repeat(4000)},totalDeductions:'0',netPay:'100',employerCost:'100'})));
  await owner.db.update(payrollBatch).set({needsRecalcAt:new Date(),recalcEmploymentIds:[subjects[60].id]}).where(eq(payrollBatch.id,batchId));
  const full=(await batchDetail(ctx,batchId))!;
  const first=(await batchDetail(ctx,batchId,{}))!,second=(await batchDetail(ctx,batchId,{page:'1'}))!,last=(await batchDetail(ctx,batchId,{page:'2'}))!;
  expect(first.slips).toEqual(full.slips.slice(0,25));expect(second.slips).toEqual(full.slips.slice(25,50));expect(last.slips).toEqual(full.slips.slice(50));
  for(const page of [first,second,last]){expect(page.slipTotal).toBe(61);expect(page.batch).toEqual(full.batch);expect(page.recalcSlips.map(row=>row.employmentId)).toEqual([subjects[60].id]);}
  expect(first.recalcSlips[0]).not.toHaveProperty('statutory');
  const beyond=(await batchDetail(ctx,batchId,{page:'99'}))!;expect(beyond.slips).toEqual([]);expect(beyond.slipTotal).toBe(61);
  const other=await seedBase();expect(await batchDetail(adminCtx(other),batchId,{})).toBeNull();
 });
});
