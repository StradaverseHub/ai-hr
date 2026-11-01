/** TEMPORARY diagnostic (H4 fix work, removed before the final head): times each owner the daily digest reads
 * for an HR administrator of a 2000-employment tenant, so the fix targets the measured cost. Fictional data. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../../db/schema';
import type {SessionContext} from '../../db/client';
import {hireEmployee} from '../../core/org';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {listPendingTasks} from '../../core/approvals-inbox';
import {payrollReadiness} from '../../core/payroll-readiness';
import {recordReadiness} from '../../core/record-readiness';
import {moduleReadiness} from '../../core/product-context/module-readiness';
import {listEmploymentsWithoutEntitlementTable,listLeaveGenerationRuns} from '../../packs/leave/service';
import {listEmployeeActivationCandidates} from '../../core/employee-user-activation';
import {readLetterSettingsReadiness} from '../../core/letters';
import {complianceWorklist} from '../../core/reporting';
import {setupCopilot} from '../../core/setup-copilot/copilot';
import {digestPreview} from '../../core/digest/daily-digest';
import {isModuleEnabled} from '../../core/entitlements';
import {pendingLeaveTaskMetadata,pendingLeaveCancellationTaskMetadata,listPendingReplacementLeaveTasks} from '../../packs/leave/service';
import {pendingClaimTaskMetadata} from '../../packs/claims/service';
import {pendingAttendanceTaskMetadata} from '../../packs/attendance/service';
import {pendingProfileTaskMetadata} from '../../core/profile';
import {pendingResignationTaskMetadata} from '../../core/offboarding';
import {pendingReviewTaskMetadata} from '../../core/employment-review';
import {pendingPerformanceTasks} from '../../packs/performance/service';
import {pendingRewardTasks} from '../../packs/rewards/service';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';

let b:Base,hr:SessionContext,timingsModules='';
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Diag Administrator',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');
 hr={...await entitledCtx(b,['hr_admin']),userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]} as SessionContext;
});

describe('diagnostic',()=>{
 it('times the digest owners at 2000 employments',async()=>{
  const people=await owner.db.insert(schema.person).values(Array.from({length:2000},(_,i)=>({tenantId:b.tenantId,fullName:`Fictional Bulk Person ${i}`,primaryEmail:`${randomUUID()}@fixture.test`})))
   .returning({id:schema.person.id});
  const employments=await owner.db.insert(schema.employment).values(people.map(row=>({tenantId:b.tenantId,personId:row.id,companyId:b.companyId,hiredOn:'2020-01-01'})))
   .returning({id:schema.employment.id});
  const date=todayInKualaLumpur();
  await owner.db.insert(schema.leaveRequest).values(employments.filter((_,i)=>i%10===0).map(row=>({tenantId:b.tenantId,employmentId:row.id,leaveTypeId:b.annualLeaveTypeId,
   startDate:date,endDate:date,days:'1',status:'pending' as const})));
  const modules={attendance:isModuleEnabled(hr,'attendance'),claims:isModuleEnabled(hr,'claims'),performance:isModuleEnabled(hr,'performance'),rewards:isModuleEnabled(hr,'rewards')};
  timingsModules=JSON.stringify(modules);
  const timings:Record<string,number|string>={};
  const time=async(name:string,run:()=>Promise<unknown>)=>{const started=Date.now();try{await run();timings[name]=Date.now()-started;}catch(error){timings[name]=`threw after ${Date.now()-started} ms: ${String(error).slice(0,120)}`;}};
  await time('listPendingTasks(no notices)',()=>listPendingTasks(hr,undefined,modules,{noticeAcknowledgements:false}));
  await time('listPendingTasks(scoped)',()=>listPendingTasks(hr,[b.companyId],modules));
  const explain=async(name:string,query:ReturnType<typeof sql>)=>{
   try{const rows=await withTenant(hr,tx=>tx.execute(sql`explain (analyze, buffers, format text) ${query}`));
    console.log('AIHR_DIAG_EXPLAIN '+name+'\n'+(rows as unknown as Record<string,string>[]).map(row=>Object.values(row)[0]).join('\n'));}
   catch(error){console.log('AIHR_DIAG_EXPLAIN '+name+' failed '+String(error).slice(0,200));}
  };
  const one=employments[0].id;
  await explain('candidates',sql`select lr.id, s.person_id, s.employee from public.leave_request lr cross join lateral app.delegated_approval_subject(lr.employment_id,'leave','leave.application') s where lr.tenant_id=${b.tenantId}::uuid and lr.status='pending' and not app.is_self_person(s.person_id) order by lr.created_at desc, lr.id`);
  await explain('employment-by-id',sql`select person_id from public.employment where id=${one}::uuid limit 1`);
  await explain('delegation',sql`select app.can_decide_via_delegation(${one}::uuid,'leave','leave.application') as ok`);
  await explain('principal',sql`select app.principal_snapshot_current() as ok`);
  await time('listEmployeeActivationCandidates(first)',()=>listEmployeeActivationCandidates(hr));
  await time('listEmployeeActivationCandidates(second)',()=>listEmployeeActivationCandidates(hr));
  await time('pendingLeaveTaskMetadata',()=>pendingLeaveTaskMetadata(hr));
  await time('pendingLeaveCancellationTaskMetadata',()=>pendingLeaveCancellationTaskMetadata(hr));
  await time('listPendingReplacementLeaveTasks',()=>listPendingReplacementLeaveTasks(hr,{companyIds:undefined}));
  if(modules.attendance)await time('pendingAttendanceTaskMetadata',()=>pendingAttendanceTaskMetadata(hr));
  await time('pendingProfileTaskMetadata',()=>pendingProfileTaskMetadata(hr));
  if(modules.claims)await time('pendingClaimTaskMetadata',()=>pendingClaimTaskMetadata(hr));
  await time('pendingResignationTaskMetadata',()=>pendingResignationTaskMetadata(hr));
  await time('pendingReviewTaskMetadata(manager)',()=>pendingReviewTaskMetadata(hr,'manager'));
  await time('pendingReviewTaskMetadata(hr)',()=>pendingReviewTaskMetadata(hr,'hr'));
  if(modules.performance)await time('pendingPerformanceTasks',()=>pendingPerformanceTasks(hr,undefined));
  if(modules.rewards)await time('pendingRewardTasks',()=>pendingRewardTasks(hr,undefined));
  await time('payrollReadiness',()=>payrollReadiness(hr,{companyId:b.companyId}));
  await time('recordReadiness',()=>recordReadiness(hr,{peopleLimit:0}));
  await time('moduleReadiness',()=>moduleReadiness(hr,b.companyId));
  await time('listEmploymentsWithoutEntitlementTable',()=>listEmploymentsWithoutEntitlementTable(hr,{asOf:date,limit:0}));
  await time('listEmployeeActivationCandidates',()=>listEmployeeActivationCandidates(hr));
  await time('readLetterSettingsReadiness',()=>readLetterSettingsReadiness(hr,b.companyId));
  await time('listLeaveGenerationRuns',()=>listLeaveGenerationRuns(hr,{limit:20}));
  await time('complianceWorklist',()=>complianceWorklist(hr,{companyId:b.companyId,today:date}));
  await time('setupCopilot',()=>setupCopilot(hr,b.companyId,date));
  await time('digestPreview',()=>digestPreview(hr));
  await time('digestPreview(second)',()=>digestPreview(hr));
  console.log('AIHR_DIAG_DIGEST '+timingsModules+' '+JSON.stringify(timings));
  expect(Object.keys(timings).length).toBeGreaterThan(0);
 },300_000);
});
