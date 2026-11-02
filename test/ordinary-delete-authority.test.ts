import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createLoan} from '../core/loans';
import {adminCtx,createAppUser,migrateTestDb,resetDb,seedBase,closeAll,owner,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function employee(name:string){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${name}@delete.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee']};return{...e,ctx};
}
it('loan subject cannot delete a valid leaf repayment or empty parent; the authorized app role can',async()=>{
 const e=await employee('loan');
 const {id}=await createLoan(adminCtx(b),{employmentId:e.employmentId,loanType:'personal',principal:100,interestRate:0,interestMethod:'none',durationMonths:1,startDate:'2026-01-01'});
 const [leaf]=await withTenant(e.ctx,tx=>tx.select().from(s.loanRepayment).where(eq(s.loanRepayment.loanId,id)));
 expect(leaf).toBeTruthy();
 expect(await withTenant(e.ctx,tx=>tx.delete(s.loanRepayment).where(eq(s.loanRepayment.id,leaf.id)).returning({id:s.loanRepayment.id}))).toEqual([]);
 expect(await withTenant(adminCtx(b),tx=>tx.delete(s.loanRepayment).where(eq(s.loanRepayment.id,leaf.id)).returning({id:s.loanRepayment.id}))).toEqual([{id:leaf.id}]);
 expect(await withTenant(e.ctx,tx=>tx.delete(s.employeeLoan).where(eq(s.employeeLoan.id,id)).returning({id:s.employeeLoan.id}))).toEqual([]);
 expect(await withTenant(adminCtx(b),tx=>tx.delete(s.employeeLoan).where(eq(s.employeeLoan.id,id)).returning({id:s.employeeLoan.id}))).toEqual([{id}]);
});
it('an unrelated tenant reader cannot remove a delegation scope; the delegator can',async()=>{
 const delegator=await employee('delegator'),delegate=await employee('delegate'),reader=await employee('reader');
 const [line]=await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:delegator.employmentId,managerEmploymentId:delegate.employmentId,lineType:'delegate',validFrom:'2024-01-01'}).returning();
 const [scope]=await owner.db.insert(s.reportingLineScope).values({tenantId:b.tenantId,reportingLineId:line.id,module:'leave',taskType:'leave.request.creation'}).returning();
 expect(await withTenant(reader.ctx,tx=>tx.select().from(s.reportingLineScope).where(eq(s.reportingLineScope.id,scope.id)))).toHaveLength(1);
 expect(await withTenant(reader.ctx,tx=>tx.delete(s.reportingLineScope).where(eq(s.reportingLineScope.id,scope.id)).returning({id:s.reportingLineScope.id}))).toEqual([]);
 expect(await withTenant(delegator.ctx,tx=>tx.delete(s.reportingLineScope).where(eq(s.reportingLineScope.id,scope.id)).returning({id:s.reportingLineScope.id}))).toEqual([{id:scope.id}]);
});
it('ordinary date-adjustment history has no direct DELETE privilege',async()=>{
 const e=await employee('adjustment');
 const [row]=await owner.db.insert(s.attendanceDayAdjustment).values({tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:'2026-01-05',dayKind:'workday',reason:'Valid fictional correction',updatedBy:'fixture'}).returning();
 expect(await withTenant(e.ctx,tx=>tx.select().from(s.attendanceDayAdjustment).where(eq(s.attendanceDayAdjustment.id,row.id)))).toHaveLength(1);
 const failure=await withTenant(e.ctx,tx=>tx.delete(s.attendanceDayAdjustment).where(eq(s.attendanceDayAdjustment.id,row.id))).then(()=>null,error=>error);
 expect(failure).toBeTruthy();expect(String(failure.cause?.message??failure.message)).toMatch(/permission denied/);
 expect(await owner.db.select().from(s.attendanceDayAdjustment).where(eq(s.attendanceDayAdjustment.id,row.id))).toHaveLength(1);
});
