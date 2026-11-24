/** ADR 0181 J2, imports: the employee import's set-based group sizing (core/employee-import-worker.ts), pure. */
import {afterEach,expect,it} from 'vitest';
import {nextEmployeeImportGroupSize} from '../core/employee-import-worker';
import {isEmployeeImportSetShape} from '../core/employee-import-set';
import type {EmployeeImportPlanStep} from '../core/import';

const keys=['EMPLOYEE_IMPORT_GROUP_MAX','EMPLOYEE_IMPORT_CHUNK_TARGET_MS','EMPLOYEE_IMPORT_CHUNK_CEILING_MS','EMPLOYEE_IMPORT_CHUNK_FIXED_MULTIPLE'] as const;
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
afterEach(()=>{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}});

it('doubles until two groups of different sizes give a line, then fills the target, never past the ceiling',()=>{
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:150}],8)).toBe(16);
 // Before a line exists, growth stops where the last group's own rate would cross the 500 ms ceiling.
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:346}],8)).toBe(11);
 // 8 rows in 140 ms and 16 in 220 ms: 10 ms a row, 60 ms fixed; target max(250, 2 x 60) = 250 -> 19 rows.
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:140},{rows:16,wallMs:220}],16)).toBe(19);
 // A large fixed cost: 2 x 200 = 400 ms target -> 20 rows; the 500 ms ceiling bounds it at 3 x 200 = 600.
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:280},{rows:16,wallMs:360}],16)).toBe(20);
 process.env.EMPLOYEE_IMPORT_CHUNK_FIXED_MULTIPLE='3';
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:280},{rows:16,wallMs:360}],16)).toBe(30);
 delete process.env.EMPLOYEE_IMPORT_CHUNK_FIXED_MULTIPLE;
 // Never more than double the last group, never above the maximum, never below two.
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:60},{rows:16,wallMs:70}],16)).toBe(32);
 process.env.EMPLOYEE_IMPORT_GROUP_MAX='12';
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:140},{rows:16,wallMs:220}],16)).toBe(12);
 delete process.env.EMPLOYEE_IMPORT_GROUP_MAX;
 expect(nextEmployeeImportGroupSize([{rows:2,wallMs:400},{rows:3,wallMs:900}],3)).toBe(2);
 // A falling or flat line (noise) is no estimate: the size doubles.
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:200},{rows:16,wallMs:190}],16)).toBe(32);
 // EMPLOYEE_IMPORT_GROUP_MAX=1 turns groups off (the worker then never forms one); the size stays at least two.
 process.env.EMPLOYEE_IMPORT_GROUP_MAX='1';
 expect(nextEmployeeImportGroupSize([{rows:8,wallMs:140}],8)).toBe(2);
});

it('writes set-based only the common shape; every other row takes the per-row path',()=>{
 const row={result:{ok:true,rowNum:2},hire:{person:{fullName:'Fictional',primaryEmail:'f@fixture.test'},companyId:'c',departmentId:'d',employmentType:'full_time',hiredOn:'2026-03-02',employeeCode:'F1',grantLeaveTypes:[]},
  statutory:{icNumber:''},basicSalary:1,monthlyAllowance:0,effectiveFrom:'2026-03-02',initialTaxScheme:'resident',country:'MY'};
 const step=(patch:Record<string,unknown>={},family:unknown[]=[])=>({kind:'employee',rowNum:2,index:0,email:'f@fixture.test',row:{...row,...patch},family}) as unknown as EmployeeImportPlanStep;
 expect(isEmployeeImportSetShape(step(),undefined)).toBe(true);
 for(const patch of [{country:'SG'},{profile:{}},{passport:{passportNumber:'X'}},{compliance:{}},{employmentInfo:{}},{statutoryPatch:{}},{payrollPolicyId:'p'},{scheduleGroupId:'s'},{operations:{}},{bankExtra:{}},{oldIcNumber:'1'},{hire:{...row.hire,employeeCode:''}}])
  expect(isEmployeeImportSetShape(step(patch),undefined)).toBe(false);
 expect(isEmployeeImportSetShape(step({},[{}]),undefined)).toBe(false);
 expect(isEmployeeImportSetShape(step(),{groups:[]} as never)).toBe(false);
 expect(isEmployeeImportSetShape({kind:'superior'} as unknown as EmployeeImportPlanStep,undefined)).toBe(false);
});
