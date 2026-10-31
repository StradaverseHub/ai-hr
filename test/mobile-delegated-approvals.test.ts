/** Delegated mobile routing audit: actual v2 composers/native decision services and mobile receipts.
 * Fictional migrated CI database only; no bearer token, installation, device or provider call. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine,endReportingLine} from '../core/org';
import {createClaimType,setClaimPolicy,submitClaim} from '../packs/claims/service';
import {requestAttendanceCorrection} from '../packs/attendance/service';
import {setToilPolicy,submitReplacementLeaveRequest} from '../packs/leave/service';
import {setRestDay} from '../core/roster';
import {setCompensation} from '../core/comp';
import {tasksPageV2,taskDetailV2,decideTaskV2} from '../core/mobile-approvals';
import {currencyOfClaim,currenciesOfClaims} from '../core/mobile-claims';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
type Person={personId:string;employmentId:string};
let b:Base,root:SessionContext,subject:Person,manager:Person,stand:Person,employee:SessionContext,delegate:SessionContext,lineId:string,claimTypeId:string;
const day=(offset:number)=>{const d=new Date(todayInKualaLumpur()+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);};
const hire=(name:string,departmentId=b.deptB)=>hireEmployee(root,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01'});
async function login(person:Person,role:'employee'|'manager'){const userId=await createAppUser(b.tenantId,person.personId,role);return{...await entitledCtx(b,[role]),userId,personId:person.personId,grants:[{role,companyId:null}]} satisfies SessionContext;}
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();for(const module of ['claims','attendance','toil'])await setModule(b.tenantId,module,'active');root={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 subject=await hire('Fictional mobile claimant',b.deptA);manager=await hire('Fictional mobile manager');stand=await hire('Fictional mobile stand-in');const report=await hire('Fictional stand-in report');
 for(const [sub,mgr] of [[subject,manager],[report,stand]])await setReportingLine(root,{subordinateEmploymentId:sub.employmentId,managerEmploymentId:mgr.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 lineId=(await setReportingLine(root,{subordinateEmploymentId:manager.employmentId,managerEmploymentId:stand.employmentId,lineType:'delegate',validFrom:'2020-01-01'})).reportingLineId;
 await login(manager,'manager');delegate=await login(stand,'manager');employee=await login(subject,'employee');
 await setCompensation(root,{employmentId:subject.employmentId,basicSalary:8000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
 claimTypeId=(await createClaimType(root,{code:'MOBILE_DELEGATE',name:'Fictional taxi',defaultTaxable:false,requiresReceipt:false})).id;
 await setClaimPolicy(root,{claimTypeId,annualBudget:1000,perClaimCap:1000,effectiveFrom:'2020-01-01'});
});
const claim=()=>submitClaim(employee,{employmentId:subject.employmentId,claimTypeId,amount:42.5,incurredOn:todayInKualaLumpur(),description:'Fictional mobile claim'}).then(r=>r.id);
const attendance=()=>requestAttendanceCorrection(employee,{employmentId:subject.employmentId,date:day(7),plannedStartTime:'18:00',plannedEndTime:'19:00',requestedOtMinutes:60,reason:'Fictional planned work',requestKind:'self_overtime'}).then(r=>r.correctionId);
async function noPersonnel(){await withTenant(delegate,async tx=>{expect(await tx.select().from(s.employment).where(eq(s.employment.id,subject.employmentId))).toEqual([]);expect(await tx.select().from(s.leaveLedger).where(eq(s.leaveLedger.employmentId,subject.employmentId))).toEqual([]);});}
describe('delegated mobile approval routing',()=>{
 it('shows the actual claim currency and claimant without Personnel visibility',async()=>{
  const id=await claim();await noPersonnel();
  const page=await tasksPageV2(delegate,{limit:50,cursor:null});expect(page.items.find(r=>r.id===id)).toMatchObject({kind:'claim',nativeDecision:true,subject:{name:'Fictional mobile claimant'},summary:{amount:'42.50',currency:'MYR'}});
  expect(await taskDetailV2(delegate,'claim',id,'en')).toMatchObject({outcome:'found',task:{amount:'42.50',currency:'MYR',subject:{name:'Fictional mobile claimant'}}});
  expect(await currencyOfClaim(delegate,id)).toBe('MYR');expect((await currenciesOfClaims(delegate,[id])).get(id)).toBe('MYR');await noPersonnel();
 });
 it.each(['claim','attendance'] as const)('%s uses the native decision and mobile receipt once',async kind=>{
  const id=kind==='claim'?await claim():await attendance(),seen=await taskDetailV2(delegate,kind,id,'en');expect(seen.outcome).toBe('found');if(seen.outcome!=='found')throw Error('Expected admitted fixture');
  const command={requestId:randomUUID(),decision:'approve' as const,expected:seen.task.expected};
  const done=await decideTaskV2(delegate,kind,id,command);expect(done).toEqual({outcome:'accepted',status:'approved'});expect(await decideTaskV2(delegate,kind,id,command)).toEqual(done);
  const events=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,id));expect(events.filter(e=>e.eventType===(kind==='claim'?'claim-request.approved':'attendance-correction.approved'))).toEqual([expect.objectContaining({actorId:delegate.userId,subjectEmploymentId:subject.employmentId})]);await noPersonnel();
 });
 it('refuses expired cover and a foreign tenant guessing a claim without a currency leak',async()=>{
  const id=await claim();await endReportingLine(root,{reportingLineId:lineId,endDate:day(-1)});
  expect(await taskDetailV2(delegate,'claim',id,'en')).toEqual({outcome:'refused',code:'not_assigned'});expect(await currencyOfClaim(delegate,id)).toBeNull();
  const other=await seedBase();expect(await currencyOfClaim(adminCtx(other),id)).toBeNull();expect(await taskDetailV2(adminCtx(other),'claim',id,'en')).toEqual({outcome:'refused',code:'not_assigned'});
 });
 it('keeps replacement leave as the existing web handoff, with a narrow delegated task name',async()=>{
  await setToilPolicy(root,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true});await setRestDay(root,{employmentId:subject.employmentId,shiftDate:day(-3)});
  const id=(await submitReplacementLeaveRequest(employee,{employmentId:subject.employmentId,unit:'day',lines:[{workedDate:day(-3),days:1}],reason:'Fictional rest-day work',today:todayInKualaLumpur()})).requestId;
  const task=(await tasksPageV2(delegate,{limit:50,cursor:null})).items.find(r=>r.id===id);expect(task).toMatchObject({kind:'replacementLeave',nativeDecision:false,subject:{name:'Fictional mobile claimant'}});expect(task?.webPath).toContain('/approvals');await noPersonnel();
 });
});
