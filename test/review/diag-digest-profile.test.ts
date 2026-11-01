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
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';

let b:Base,hr:SessionContext;
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
  const modules={attendance:true,claims:true,performance:true,rewards:true};
  const timings:Record<string,number|string>={};
  const time=async(name:string,run:()=>Promise<unknown>)=>{const started=Date.now();try{await run();timings[name]=Date.now()-started;}catch(error){timings[name]=`threw after ${Date.now()-started} ms: ${String(error).slice(0,120)}`;}};
  await time('listPendingTasks(no notices)',()=>listPendingTasks(hr,undefined,modules,{noticeAcknowledgements:false}));
  await time('listPendingTasks(scoped)',()=>listPendingTasks(hr,[b.companyId],modules));
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
  console.log('AIHR_DIAG_DIGEST '+JSON.stringify(timings));
  expect(Object.keys(timings).length).toBeGreaterThan(0);
 },300_000);
});
