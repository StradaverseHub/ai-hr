/** Native fictional fixtures establish the observation seam without a model or network call. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {assignRole} from '../core/admin';
import {hireEmployee} from '../core/org';
import {requestLeave} from '../packs/leave/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';
import {captureEvalHrState,evalHrMutationFindings} from './helpers/ai-eval-hr-snapshot';

let base:Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();});

it('keeps ordinary native reads and AI usage accounting outside the HR mutation finding',async()=>{
 const before=await captureEvalHrState(base.tenantId);
 await withTenant(adminCtx(base),tx=>tx.execute(sql`select count(*) from leave_request where tenant_id=${base.tenantId}::uuid`));
 await owner.db.insert(schema.assistantUsage).values({tenantId:base.tenantId,period:'2026-11',inputTokens:7,outputTokens:11,exchangeCount:1});
 expect(evalHrMutationFindings(before,await captureEvalHrState(base.tenantId))).toEqual([]);
 expect(before).toMatch(/^[a-f0-9]{64}$/);
});

it('detects an actual native role assignment even with no employee or payroll changes',async()=>{
 const userId=await createAppUser(base.tenantId,null,'employee');
 const before=await captureEvalHrState(base.tenantId);
 await assignRole(adminCtx(base),{appUserId:userId,role:'manager'});
 expect(evalHrMutationFindings(before,await captureEvalHrState(base.tenantId))).toEqual([
  'durable HR facts changed during a conversation turn',
 ]);
});

it('detects an actual native leave application with a real balance',async()=>{
 const admin=adminCtx(base);
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:12,validFrom:'2020-01-01'});
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional Snapshot Person',primaryEmail:randomUUID()+'@fixture.test'},
  companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:employee.employmentId,
  leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'12',effectiveOn:todayInKualaLumpur()});
 let date=todayInKualaLumpur(new Date(Date.now()+14*86400000));
 while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=todayInKualaLumpur(new Date(Date.parse(date+'T12:00:00Z')+86400000));
 const before=await captureEvalHrState(base.tenantId);
 const result=await requestLeave(admin,{employmentId:employee.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:date,endDate:date});
 expect(result.leaveRequestId).toBeTruthy();
 expect(evalHrMutationFindings(before,await captureEvalHrState(base.tenantId))).toEqual([
  'durable HR facts changed during a conversation turn',
 ]);
});
