import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent} from '../core/movement';
import {correctHireDetails,hireCorrectionView} from '../core/hire-correction';
import {getEmploymentCostAllocations,saveEmploymentCostAllocations} from '../core/employment-cost-allocations';

let b:Base,id:string,target:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();const ctx=adminCtx(b);
 id=(await hireEmployee(ctx,{person:{fullName:'Fictional Allocation Correction',primaryEmail:'allocation-correction@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 await setCompensation(ctx,{employmentId:id,basicSalary:3000,effectiveFrom:'2026-01-01'});
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Corrected Allocation Employer',country:'MY'}).returning();target=company.id;
 await owner.withTenant(ctx,tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
});
afterAll(closeAll);
const save=(date:string,revision:number,operation:'replace'|'clear'='replace')=>saveEmploymentCostAllocations(adminCtx(b),{employmentId:id,effectiveDate:date,expectedRevision:revision,operation,rows:operation==='clear'?[]:[{costCenterId:b.costCenterId,percentage:'100.00'}]});

it('retains old and later allocation rows plus closed figures, and requires an explicit replacement decision',async()=>{
 await save('2026-01-01',0);await save('2026-02-01',1);
 const oldSets=await owner.db.select().from(s.employmentCostAllocationSet).where(eq(s.employmentCostAllocationSet.employmentId,id));
 const oldRows=await owner.db.select().from(s.employmentCostAllocationRow).orderBy(s.employmentCostAllocationRow.setId);
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2026-01',status:'closed'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2026-01',batchDate:'2026-01-25',status:'closed'}).returning();
 const [issued]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'retained allocation evidence'}}).returning();
 await correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation:{companyId:target},reason:'Fictional original employing company correction'});
 const view=await getEmploymentCostAllocations(adminCtx(b),id,'2026-02-01');
 expect(view).toMatchObject({companyId:target,revision:3,rows:[],needsReplacement:true});
 expect(view.history.filter(row=>oldSets.some(old=>old.id===row.id)).every(row=>row.superseded)).toBe(true);
 expect(await owner.db.select().from(s.employmentCostAllocationRow).orderBy(s.employmentCostAllocationRow.setId)).toEqual(oldRows);
 expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,issued.id)))[0]).toEqual(issued);
 expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batch.id)))[0]).toEqual(batch);
 expect((await hireCorrectionView(adminCtx(b),id)).companyReviewFields).toContain('costAllocation');
 const [correction]=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,id),eq(s.domainEvent.eventType,'employment.information.corrected')));
 expect(await withTenant(adminCtx(b),async tx=>{
  const [result]=await tx.execute<{result:{changed:boolean}}>(sql`select app.cost_allocations_after_hire_company_correction(${id}::uuid,${correction.id}::uuid,'Fictional idempotent retry') as result`);return result.result;
 })).toEqual({changed:false});
 await save('2026-01-01',view.revision,'clear');
 expect((await getEmploymentCostAllocations(adminCtx(b),id,'2026-02-01')).needsReplacement).toBe(false);
 expect((await hireCorrectionView(adminCtx(b),id)).companyReviewFields).not.toContain('costAllocation');
});

it('refuses allocation retirement without an actual canonical company-correction event',async()=>{
 await save('2026-01-01',0);
 const before=await owner.db.select().from(s.employmentCostAllocationSet);
 await expect(withTenant(adminCtx(b),tx=>tx.execute(sql`select app.cost_allocations_after_hire_company_correction(${id}::uuid,${randomUUID()}::uuid,'Fictional unproven request')`))).rejects.toThrow();
 expect(await owner.db.select().from(s.employmentCostAllocationSet)).toEqual(before);
});

it('preserves a later deliberate employer and its allocation revision byte-for-byte',async()=>{
 const ctx=adminCtx(b);
 await owner.withTenant(ctx,tx=>tx.update(s.costCenter).set({isGlobal:true}).where(eq(s.costCenter.id,b.costCenterId)));
 await save('2026-01-01',0);await save('2026-03-01',1,'clear');
 await createMovementEvent(ctx,{employmentId:id,kind:'entityTransfer',effectiveDate:'2026-03-01',companyId:target});
 await save('2026-03-01',2);
 const [later]=await owner.db.select().from(s.employmentCostAllocationSet).where(and(eq(s.employmentCostAllocationSet.employmentId,id),eq(s.employmentCostAllocationSet.companyId,target)));
 const laterRows=await owner.db.select().from(s.employmentCostAllocationRow).where(eq(s.employmentCostAllocationRow.setId,later.id));
 const [corrected]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Earlier Corrected Employer',country:'MY'}).returning();
 await correctHireDetails(ctx,{employmentId:id,changes:{},hireInformation:{companyId:corrected.id},reason:'Fictional correction bounded by a later deliberate employer'});
 expect((await owner.db.select().from(s.employmentCostAllocationSet).where(eq(s.employmentCostAllocationSet.id,later.id)))[0]).toEqual(later);
 expect(await owner.db.select().from(s.employmentCostAllocationRow).where(eq(s.employmentCostAllocationRow.setId,later.id))).toEqual(laterRows);
 expect(await getEmploymentCostAllocations(ctx,id,'2026-01-01')).toMatchObject({companyId:corrected.id,rows:[],needsReplacement:true});
 expect(await getEmploymentCostAllocations(ctx,id,'2026-03-01')).toMatchObject({companyId:target,needsReplacement:false,total:10000});
});
