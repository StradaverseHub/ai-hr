/** Real generated and closed payroll. HTTP/PDF routing is covered separately. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {hireEmployee,terminateEmployment} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips,closeBatch,myPayslipDetail,payslipDetail} from '../packs/payroll/service';
import {myOwnPayslips,myReleasedPayslipRuns} from '../core/read';
import {employeeEaStatement,myEaSources,myEaStatement} from '../core/reporting';
import {setEaOverride} from '../core/ea-override';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import * as schema from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});

async function fixture(role:'employee'|'manager'|'hr_admin'='employee',closed=true) {
 const today=todayInKualaLumpur(),start=new Date(`${today.slice(0,7)}-01T12:00:00Z`);
 start.setUTCMonth(start.getUTCMonth()-1);
 const period=start.toISOString().slice(0,7),year=period.slice(0,4),hiredOn=`${Number(year)-1}-01-01`,root=adminCtx(base);
 const employees=[];
 for(const [i,name] of ['Fictional document owner','Fictional separate employee'].entries()) {
  const e=await hireEmployee(root,{person:{fullName:name,primaryEmail:`fictional-doc-${i}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn});
  await setCompensation(root,{employmentId:e.employmentId,basicSalary:i===0?5000:7900,effectiveFrom:hiredOn});
  await requirePackFor('MY').statutory.set(root,{personId:e.personId,icNumber:`90010110${String(i+1).padStart(4,'0')}`,taxCategory:1,numChildren:0});
  employees.push(e);
 }
 const userId=await createAppUser(base.tenantId,employees[0].personId,role);
 const ctx:SessionContext={...root,userId,personId:employees[0].personId,roles:[role],grants:[{role,companyId:base.companyId}]};
 const batch=await createBatch(root,{companyId:base.companyId,payPeriod:period});
 await generatePayslips(root,{batchId:batch.batchId});
 const saved=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batch.batchId)).orderBy(schema.payslip.employmentId,schema.payslip.id);
 expect(saved).toHaveLength(2);expect(saved.every(row=>Number(row.grossPay)>0)).toBe(true);
 if(closed)await closeBatch(root,{batchId:batch.batchId});
 return{root,ctx,own:employees[0],other:employees[1],batch,period,year,saved,
  ownSlip:saved.find(row=>row.employmentId===employees[0].employmentId)!,otherSlip:saved.find(row=>row.employmentId===employees[1].employmentId)!};
}

describe('Mine document readers consume the released canonical payroll owner',()=>{
 it.each(['employee','manager','hr_admin'] as const)('enforces the same own-only fence for a %s using Mine',async(role)=>{
  const f=await fixture(role);
  const runs=await myReleasedPayslipRuns(f.ctx);
  expect(runs).toEqual([expect.objectContaining({payslipId:f.ownSlip.id,employmentId:f.own.employmentId,companyId:base.companyId,payPeriod:f.period})]);
  expect(await myPayslipDetail(f.ctx,f.ownSlip.id)).toMatchObject({id:f.ownSlip.id,gross:f.ownSlip.grossPay,net:f.ownSlip.netPay});
  expect(await myPayslipDetail(f.ctx,f.otherSlip.id)).toBeNull();
  expect(await myOwnPayslips(f.ctx,[f.other.employmentId])).toEqual([]);
  expect(await myReleasedPayslipRuns({...f.ctx,personId:f.other.personId})).toEqual([]);
  expect(await myPayslipDetail({...f.ctx,personId:f.other.personId},f.otherSlip.id)).toBeNull();
  if(role==='hr_admin')expect(await payslipDetail(f.ctx,f.otherSlip.id)).toMatchObject({id:f.otherSlip.id});
 });
 it('withholds a generated but unclosed run and exposes its unchanged recorded result after canonical close',async()=>{
  const f=await fixture('employee',false);
  expect(await myReleasedPayslipRuns(f.ctx)).toEqual([]);expect(await myPayslipDetail(f.ctx,f.ownSlip.id)).toBeNull();
  expect(await myEaSources(f.ctx)).toEqual([expect.objectContaining({year:f.year,available:false})]);
  expect(await myEaStatement(f.ctx,{employmentId:f.own.employmentId,companyId:base.companyId,year:f.year})).toBeNull();
  await closeBatch(f.root,{batchId:f.batch.batchId});
  expect((await myReleasedPayslipRuns(f.ctx)).map(row=>row.payslipId)).toEqual([f.ownSlip.id]);
  expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,f.batch.batchId)).orderBy(schema.payslip.employmentId,schema.payslip.id)).toEqual(f.saved);
 });
 it('returns the exact administrator EA form model once all own contributing sources are released',async()=>{
  const f=await fixture(),key={employmentId:f.own.employmentId,companyId:base.companyId,year:f.year};
  const admin=await employeeEaStatement(f.root,key),mine=await myEaStatement(f.ctx,key);
  expect(admin).not.toBeNull();expect(Number(admin!.partB.gross)).toBeGreaterThan(0);
  expect(mine).toEqual(admin);
  expect(await myEaStatement(f.ctx,{...key,employmentId:f.other.employmentId})).toBeNull();
  await terminateEmployment(f.root,{employmentId:f.own.employmentId,terminationDate:todayInKualaLumpur(),terminationReason:'Fictional historical-document retention'});
  expect((await myReleasedPayslipRuns(f.ctx)).map(row=>row.payslipId)).toEqual([f.ownSlip.id]);
  expect(await myEaStatement(f.ctx,key)).toEqual(await employeeEaStatement(f.root,key));
 });
 it('reflects an authorised EA-only amendment on both reads without rewriting closed payslips',async()=>{
  const f=await fixture(),key={employmentId:f.own.employmentId,companyId:base.companyId,year:f.year};
  const before=await myEaStatement(f.ctx,key);expect(before).not.toBeNull();
  await setEaOverride(f.root,{employmentId:f.own.employmentId,year:f.year,field:'benefitsInKind',amount:1234.56,reason:'Fictional authorised EA amendment'});
  const mine=await myEaStatement(f.ctx,key);expect(mine).toEqual(await employeeEaStatement(f.root,key));
  expect(mine!.partB.benefitsInKind).toBe(1234.56);expect(mine!.overrides).toEqual(expect.arrayContaining([expect.objectContaining({field:'benefitsInKind',amended:1234.56})]));
  expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,f.batch.batchId)).orderBy(schema.payslip.employmentId,schema.payslip.id)).toEqual(f.saved);
 });
});
