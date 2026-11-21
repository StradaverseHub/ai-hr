import {getEmploymentCostAllocations,saveEmploymentCostAllocations} from '../core/employment-cost-allocations';
import {assignPolicy} from '../core/payroll-policy';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull} from 'drizzle-orm';
import * as s from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentGrade,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
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
 it('restores the corrected hire grade when the first later grade decision is deleted',async()=>{
  const first=await grade('PREIMAGE-FIRST'),later=await grade('PREIMAGE-LATER'),corrected=await grade('PREIMAGE-CORRECTED');
  await setEmploymentGrade(adminCtx(b),{employmentId:id,gradeId:first});
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',gradeId:later});
  const movement=(await movementHistory(adminCtx(b),id)).find(row=>row.kind==='promotion')!;
  await correct({gradeId:corrected});
  await reverseMovementEvent(adminCtx(b),{employmentId:id,movementId:movement.id,reason:'Fictional removal of incorrect later decision'});
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].gradeId).toBe(corrected);
 });
 it('restores both corrected original period components when a later value-only decision is deleted',async()=>{
  const ctx=adminCtx(b);await correct({probationValue:'3',probationUnit:'month'});
  await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',probationValue:'6'});
  const movement=(await movementHistory(ctx,id)).find(row=>row.kind==='promotion')!;
  await correct({probationValue:'4',probationUnit:'week'});
  await reverseMovementEvent(ctx,{employmentId:id,movementId:movement.id,reason:'Fictional removal of incorrect period decision'});
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0]).toMatchObject({probationValue:4,probationUnit:'week'});
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
  const [slip]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{fixture:'retained original'}}).returning();
  await correctHireDetails(adminCtx(b),{employmentId:id,changes:{},hireInformation:{hiredOn:'2025-12-15'},basicSalary:3400,reason:'Fictional corrected date and amount'});
  expect((await hireCorrectionView(adminCtx(b),id)).groupJoinDate).toBe('2025-12-15');
  expect((await hireCorrectionView(adminCtx(b),id)).salaryAtHire?.amount).toBe('3400.00');
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,slip.id)))[0]).toEqual(slip);
 });
 it('flags company-specific grade, policy and allocation follow-up and clears findings through their native owners',async()=>{
  const ctx=adminCtx(b);
  const [oldGrade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'OLD-SCOPE',name:'Fictional Original Grade',scopeCompanyIds:[b.companyId]}).returning();
  id=(await hireEmployee(ctx,{person:{fullName:'Fictional Mis-keyed Hire Company',primaryEmail:'hire-company@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01',gradeId:oldGrade.id})).employmentId;
  const [target]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Corrected Employer',country:'MY'}).returning();
  await owner.withTenant(ctx,tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
  await owner.withTenant(ctx,tx=>tx.update(s.costCenter).set({isGlobal:true}).where(eq(s.costCenter.id,b.costCenterId)));
  const [oldPolicy]=await owner.db.insert(s.payrollPolicy).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional Original Policy',policyType:'monthly'}).returning();
  await assignPolicy(ctx,{employmentId:id,policyId:oldPolicy.id});
  await saveEmploymentCostAllocations(ctx,{employmentId:id,effectiveDate:'2026-01-01',expectedRevision:0,operation:'replace',rows:[{costCenterId:b.costCenterId,percentage:'100.00'}]});
  await correct({companyId:target.id});
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].gradeId).toBeNull();
  expect((await hireCorrectionView(ctx,id)).gradeId).toBe(oldGrade.id);
  expect((await hireCorrectionView(ctx,id)).companyReviewFields?.sort()).toEqual(['costAllocation','gradeId','payrollPolicyId']);
  await correct({gradeId:null});
  expect((await hireCorrectionView(ctx,id)).companyReviewFields?.sort()).toEqual(['costAllocation','payrollPolicyId']);
  const [targetGrade]=await owner.db.insert(s.jobGrade).values({tenantId:b.tenantId,code:'CORRECTED-SCOPE',name:'Fictional Corrected Grade',scopeCompanyIds:[target.id]}).returning();
  await correct({gradeId:targetGrade.id});
  const [targetPolicy]=await owner.db.insert(s.payrollPolicy).values({tenantId:b.tenantId,companyId:target.id,name:'Fictional Corrected Policy',policyType:'monthly'}).returning();
  await assignPolicy(ctx,{employmentId:id,policyId:targetPolicy.id});
  const allocationView=await getEmploymentCostAllocations(ctx,id,'2026-01-01');
  expect(allocationView.needsReplacement).toBe(true);
  await saveEmploymentCostAllocations(ctx,{employmentId:id,effectiveDate:'2026-01-01',expectedRevision:allocationView.revision,operation:'replace',rows:[{costCenterId:b.costCenterId,percentage:'100.00'}]});
  expect((await hireCorrectionView(ctx,id)).companyReviewFields).toEqual([]);
 });
 it('flags an incompatible current company label and clears the finding through its native owner',async()=>{
  const ctx=adminCtx(b);
  const [target]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Label Employer',country:'MY'}).returning();
  await owner.withTenant(ctx,tx=>tx.update(s.department).set({isGlobal:true}).where(eq(s.department.id,b.deptA)));
  await owner.withTenant(ctx,tx=>tx.insert(s.profileOption).values([{tenantId:b.tenantId,category:'division',value:'Fictional Old Division',label:'Fictional Old Division',scopeCompanyIds:[b.companyId]},{tenantId:b.tenantId,category:'division',value:'Fictional New Division',label:'Fictional New Division',scopeCompanyIds:[target.id]}]));
  await setEmploymentInfo(ctx,{employmentId:id,orgDivision:'Fictional Old Division'});
  await correct({companyId:target.id});
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0]).toMatchObject({companyId:target.id,orgDivision:null});
  expect((await hireCorrectionView(ctx,id)).companyReviewFields).toEqual(['orgDivision']);
  const [event]=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.eventType,'employment.information.corrected'));
  expect(event.payload).toMatchObject({clearedCompanyValues:{orgDivision:'Fictional Old Division'}});
  await setEmploymentInfo(ctx,{employmentId:id,orgDivision:'Fictional New Division'});
  expect((await hireCorrectionView(ctx,id)).companyReviewFields).toEqual([]);
 });
 it('corrects an original period pair without changing a later deliberate value in its original unit',async()=>{
  const ctx=adminCtx(b);
  await correct({probationValue:'3',probationUnit:'month'});
  await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',probationValue:'6'});
  await correct({probationValue:'4',probationUnit:'week'});
  const [current]=await owner.db.select().from(s.employment).where(eq(s.employment.id,id));
  expect(current).toMatchObject({probationValue:6,probationUnit:'month'});
  expect((await hireCorrectionView(ctx,id)).information?.probationValue.value).toBe('4');
  expect((await hireCorrectionView(ctx,id)).information?.probationUnit.value).toBe('week');
 });
 it('validates historical scalar facts even when later decisions protect the current value',async()=>{
  const ctx=adminCtx(b);await createMovementEvent(ctx,{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',probationValue:'6',probationUnit:'month'});
  const before=await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.id);
  await expect(correct({probationValue:'-1',probationUnit:'month'})).rejects.toThrow(/whole numbers/);
  await expect(correct({confirmationDate:'2025-12-01'})).rejects.toThrow(/earlier than the hire date/);
  expect(await owner.db.select().from(s.domainEvent).orderBy(s.domainEvent.id)).toEqual(before);
 });
 it('corrects the original salary and method atomically through their owners and retains a later method',async()=>{
  const ctx=adminCtx(b);await setCompensation(ctx,{employmentId:id,effectiveFrom:'2026-01-01',basicSalary:3000});
  const {setEmploymentPaymentMethod}=await import('../core/org');
  await setEmploymentPaymentMethod(ctx,{employmentId:id,effectiveDate:'2026-03-01',paymentMethod:'cheque'});
  await correctHireDetails(ctx,{employmentId:id,changes:{},basicSalary:3250,paymentMethod:'cash',reason:'Fictional original salary and payment method'});
  expect((await hireCorrectionView(ctx,id)).paymentMethodAtHire).toBe('cash');
  expect((await owner.db.select().from(s.employment).where(eq(s.employment.id,id)))[0].paymentMethod).toBe('cheque');
  const before=await owner.db.select().from(s.compensation).orderBy(s.compensation.id);
  await expect(correctHireDetails(ctx,{employmentId:id,changes:{},basicSalary:3400,paymentMethod:'bank_transfer',reason:'Fictional unpayable correction'})).rejects.toThrow(/bank/i);
  expect(await owner.db.select().from(s.compensation).orderBy(s.compensation.id)).toEqual(before);
 });
 it('accepts only namespaced changed controls and refuses unsupported information fields atomically',async()=>{
  const data=new FormData();data.set('companyId','forged legacy name');data.set('hireInformation_gradeId','');
  expect(parseHireInformationForm(data)).toEqual({gradeId:null});
  const before=await owner.db.select().from(s.employment).where(eq(s.employment.id,id));
  await expect(correct({personId:id} as never)).rejects.toThrow(/unsupported/);
  expect(await owner.db.select().from(s.employment).where(eq(s.employment.id,id))).toEqual(before);
 });
});
