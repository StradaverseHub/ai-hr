import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentGrade} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent,movementHistory} from '../core/movement';
import {correctHireDetails,hireCorrectionView,parseHireInformationForm} from '../core/hire-correction';
let b:Base,id:string;
beforeAll(migrateTestDb);beforeEach(async()=>{
 await resetDb();b=await seedBase();id=(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Hire Information',primaryEmail:'hire-info@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
});afterAll(closeAll);
const correct=(hireInformation:Parameters<typeof correctHireDetails>[1]['hireInformation'])=>correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation,reason:'Fictional correction of original hire information'});
async function grade(name:string){const [row]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:name,name}).returning();return row.id;}
describe('original-hire employment information',()=>{
 it('changes the hire grade while retaining a later deliberate grade and its history',async()=>{
  const first=await grade('FICTIONAL-FIRST'),later=await grade('FICTIONAL-LATER'),corrected=await grade('FICTIONAL-CORRECTED');
  await setEmploymentGrade(adminCtx(b),{employmentId:id,gradeId:first});
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',gradeId:later});
  const before=(await movementHistory(adminCtx(b),id)).filter(row=>row.kind==='promotion').map(row=>row.id);
  await correct({gradeId:corrected});
  expect((await hireCorrectionView(adminCtx(b),id)).gradeId).toBe(corrected);
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].gradeId).toBe(later);
  expect((await movementHistory(adminCtx(b),id)).filter(row=>row.kind==='promotion').map(row=>row.id)).toEqual(before);
 });
 it('carries original employment type through inherited placement versions and stops at a later type decision',async()=>{
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:'2026-02-01',departmentId:b.deptB});
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:'2026-03-01',employmentType:'part_time'});
  await correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation:{employmentType:'contract'},endDates:{contractEndDate:'2026-02-28'},reason:'Fictional original contract correction'});
  const rows=await owner.db.select({from:s.assignment.validFrom,type:s.assignment.employmentType}).from(s.assignment).where(and(eq(s.assignment.employmentId,id),isNull(s.assignment.supersededAt))).orderBy(s.assignment.validFrom);
  expect(rows).toEqual([{from:'2026-01-01',type:'contract'},{from:'2026-02-01',type:'contract'},{from:'2026-03-01',type:'part_time'}]);
 });
 it('aligns an earlier group join correction through the native history owner, preserving a paid salary source',async()=>{
  await setCompensation(adminCtx(b),{employmentId:id,effectiveFrom:'2026-01-01',basicSalary:3000});
  const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2026-01',status:'closed'}).returning();
  const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2026-01',batchDate:'2026-01-25',status:'closed'}).returning();
  const [slip]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00'}).returning();
  await correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation:{hiredOn:'2025-12-15'},basicSalary:3400,reason:'Fictional corrected date and amount'});
  expect((await hireCorrectionView(adminCtx(b),id)).groupJoinDate).toBe('2025-12-15');
  expect((await hireCorrectionView(adminCtx(b),id)).salaryAtHire?.amount).toBe('3400.00');
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,slip.id)))[0]).toEqual(slip);
 });
 it('accepts only namespaced changed controls and refuses unsupported information fields atomically',async()=>{
  const data=new FormData();data.set('companyId','forged legacy name');data.set('hireInformation_gradeId','');
  expect(parseHireInformationForm(data)).toEqual({gradeId:null});
  const before=await owner.db.select().from(s.employment).where(eq(s.employment.id,id));
  await expect(correct({personId:id} as never)).rejects.toThrow(/unsupported/);
  expect(await owner.db.select().from(s.employment).where(eq(s.employment.id,id))).toEqual(before);
 });
});
