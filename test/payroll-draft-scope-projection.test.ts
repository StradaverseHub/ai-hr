import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {batchInputRows,batchScopeHeadcount,createBatch,preProcessAdvisory} from '../packs/payroll/service';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function hire(name:string,departmentId=b.deptA,salary=true){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@scope-projection.test'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:'2026-01-01'});
 if(salary)await setCompensation(adminCtx(b),{employmentId:e.employmentId,basicSalary:3500,effectiveFrom:'2026-01-01'});
 return e;
}
describe('draft run projection uses persisted scope without a salary-dependent headcount',()=>{
 it('counts only the saved subset, includes missing salary, and excludes other editor rows',async()=>{
  const included=await hire('Included salary'),missing=await hire('Included missing salary',b.deptA,false),excluded=await hire('Excluded salary');
  const run=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:'2026-05',scope:{employmentIds:[included.employmentId,missing.employmentId]}});
  expect(await batchScopeHeadcount(adminCtx(b),run.batchId)).toBe(2);
  expect((await batchInputRows(adminCtx(b),run.batchId)).map(row=>row.employmentId)).toEqual([included.employmentId]);
  expect((await preProcessAdvisory(adminCtx(b),run.batchId)).missingCompensation.map(row=>row.employmentId)).toEqual([missing.employmentId]);
  expect(excluded.employmentId).not.toBe(included.employmentId);
 });
 it('preserves department and individual union without counting duplicate selections',async()=>{
  const department=await hire('Department selected'),explicit=await hire('Explicit selected',b.deptB),excluded=await hire('Excluded selected',b.deptB);
  const run=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:'2026-05',scope:{departmentIds:[b.deptA],employmentIds:[department.employmentId,explicit.employmentId]}});
  expect(await batchScopeHeadcount(adminCtx(b),run.batchId)).toBe(2);
  expect(new Set((await batchInputRows(adminCtx(b),run.batchId)).map(row=>row.employmentId))).toEqual(new Set([department.employmentId,explicit.employmentId]));
  expect(excluded.employmentId).not.toBe(explicit.employmentId);
 });
 it('keeps a selected empty department empty and the canonical empty-selection default company-wide',async()=>{
  await hire('Whole company employee');
  const empty=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:'2026-05',scope:{departmentIds:[b.deptB]}});
  expect(await batchScopeHeadcount(adminCtx(b),empty.batchId)).toBe(0);expect(await batchInputRows(adminCtx(b),empty.batchId)).toEqual([]);
  const company=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:'2026-06',scope:{departmentIds:[],employmentIds:[]}});
  expect(await batchScopeHeadcount(adminCtx(b),company.batchId)).toBe(1);expect(await batchInputRows(adminCtx(b),company.batchId)).toHaveLength(1);
 });
});
