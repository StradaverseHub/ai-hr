import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,entitledCtx,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave,decideLeave,requestLeaveCancellation,decideLeaveCancellation,setLeaveApprovalPolicy,actionableLeaveCancellationIds} from '../packs/leave/service';
import {createClaimType,submitClaim,decideClaim,actionablePendingClaimIds} from '../packs/claims/service';
import {listPendingTasks,pendingTaskSummary} from '../core/approvals-inbox';
import {readEmployeeHomeIdentity} from '../core/employee-home';
import {todayInKualaLumpur} from '../lib/hr-date';
import {seedStoredLegacyProfileRequest} from './helpers/profile-requests';
import {setTenantSetting} from '../core/tenant-settings';
import {decideProfileChange} from '../core/profile';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const add=(date:string,days:number)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
async function worker(name:string){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
async function reportingPair(){
 const employee=await worker('Fictional task employee'),manager=await worker('Fictional organizational manager');
 await setReportingLine(adminCtx(b),{subordinateEmploymentId:employee.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
 await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'20.00',effectiveOn:todayInKualaLumpur().slice(0,4)+'-01-01'});
 let date=add(todayInKualaLumpur(),3);while([0,6].includes(new Date(date+'T12:00:00Z').getUTCDay()))date=add(date,1);
 return {employee,manager,date};
}
const tasks=(ctx:SessionContext)=>listPendingTasks(ctx,undefined,{attendance:false,claims:false,performance:false,rewards:false});
describe('Home consumes actual assigned actions, not a manager-role shortcut',()=>{
 it('finds a real organizational manager without Manager role and removes a task after that manager decides',async()=>{
  const {employee,manager,date}=await reportingPair();
  const request=await requestLeave(employee.ctx,{employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  expect(manager.ctx.roles).toEqual(['employee']);
  expect((await tasks(manager.ctx)).filter(row=>row.kind==='leave').map(row=>row.id)).toEqual([request.leaveRequestId]);
  expect(await tasks(employee.ctx)).toEqual([]);
  await decideLeave(manager.ctx,{leaveRequestId:request.leaveRequestId,decision:'approved'});
  expect(await tasks(manager.ctx)).toEqual([]);
 });
 it('keeps a visible request out of the manager inbox until its retained current step is assigned to that manager',async()=>{
  const {employee,manager,date}=await reportingPair();
  await setLeaveApprovalPolicy(adminCtx(b),{companyId:b.companyId,levels:['hr_admin','direct_manager']});
  const request=await requestLeave(employee.ctx,{employmentId:employee.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date});
  expect(await tasks(manager.ctx)).toEqual([]);
  await decideLeave(adminCtx(b),{leaveRequestId:request.leaveRequestId,decision:'approved'});
  expect((await tasks(manager.ctx)).map(row=>row.id)).toEqual([request.leaveRequestId]);
  await decideLeave(manager.ctx,{leaveRequestId:request.leaveRequestId,decision:'approved'});
  const cancelled=await requestLeaveCancellation(employee.ctx,{leaveRequestId:request.leaveRequestId,cancelDates:[date],today:todayInKualaLumpur(),reason:'Fictional cancellation review'});
  expect(await tasks(manager.ctx)).toEqual([]);
  await decideLeaveCancellation(adminCtx(b),{cancellationRequestId:cancelled.cancellationRequestId,decision:'approved'});
  expect((await tasks(manager.ctx)).filter(row=>row.kind==='leaveCancellation').map(row=>row.id)).toEqual([cancelled.cancellationRequestId]);
  await decideLeaveCancellation(manager.ctx,{cancellationRequestId:cancelled.cancellationRequestId,decision:'approved'});
  expect(await tasks(manager.ctx)).toEqual([]);
 });
 it('repeats the canonical fresh-principal proof before any Home subject or role projection',async()=>{
  const own=await worker('Fictional current Home principal');
  expect((await readEmployeeHomeIdentity(own.ctx)).selectedEmploymentId).toBe(own.employmentId);
  await expect(readEmployeeHomeIdentity({...own.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).rejects.toMatchObject({code:'employmentUnavailable'});
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,own.ctx.userId!));
  await expect(readEmployeeHomeIdentity(own.ctx)).rejects.toMatchObject({code:'employmentUnavailable'});
 });
 it('shows only claims the actual decider can decide, including a bounded SQL batch beyond one thousand candidate IDs',async()=>{
  const {employee,manager}=await reportingPair();await setModule(b.tenantId,'claims','active');
  const admin=await entitledCtx(b),entitlements=admin.entitlements;
  const employeeCtx={...employee.ctx,entitlements},managerCtx={...manager.ctx,entitlements};
  const type=await createClaimType(admin,{code:'HOME_TASK',name:'Fictional task expenses',requiresReceipt:false,defaultTaxable:false});
  const claim=await submitClaim(employeeCtx,{employmentId:employee.employmentId,claimTypeId:type.id,amount:12,incurredOn:todayInKualaLumpur()});
  const candidates=[...Array.from({length:1001},()=>randomUUID()),claim.id];
  expect(await actionablePendingClaimIds(managerCtx,candidates)).toEqual([claim.id]);
  expect(await actionablePendingClaimIds(employeeCtx,candidates)).toEqual([]);
  expect((await listPendingTasks(managerCtx,undefined,{attendance:false,claims:true,performance:false,rewards:false})).filter(row=>row.kind==='claim').map(row=>row.id)).toEqual([claim.id]);
  const modules={attendance:false,claims:true,performance:false,rewards:false};
  const summary=await pendingTaskSummary(managerCtx,undefined,modules);
  expect(summary.claimTotal).toBe(1);expect(summary.approvalCount).toBe(1);
  expect(summary.items.filter(row=>row.kind==='claim').map(row=>row.id)).toEqual([claim.id]);
  expect((await pendingTaskSummary(employeeCtx,undefined,modules)).claimTotal).toBe(0);
  await decideClaim(managerCtx,{claimRequestId:claim.id,decision:'approve'});
  expect((await pendingTaskSummary(managerCtx,undefined,modules)).claimTotal).toBe(0);
  expect((await listPendingTasks(managerCtx,undefined,{attendance:false,claims:true,performance:false,rewards:false})).filter(row=>row.kind==='claim')).toEqual([]);
  expect(await actionableLeaveCancellationIds(managerCtx,candidates)).toEqual([]);
 });
 it('keeps own profile requests out and repeats the current group-only profile decision setting',async()=>{
  const employee=await worker('Fictional profile subject'),hr=await worker('Fictional scoped profile HR');
  await owner.db.update(s.roleAssignment).set({role:'hr_admin',companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,hr.ctx.userId!));
  const scoped:SessionContext={...hr.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const group:SessionContext={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const request=await seedStoredLegacyProfileRequest(employee.ctx,{employmentId:employee.employmentId,proposed:{preferredName:'Fictional stored proposal'}});
  const own=await seedStoredLegacyProfileRequest(scoped,{employmentId:hr.employmentId,proposed:{preferredName:'Fictional own stored proposal'}});
  expect((await tasks(scoped)).filter(row=>row.kind==='profile').map(row=>row.id)).toEqual([request.requestId]);
  await setTenantSetting(group,{key:'ess.profile_change_approver',value:'group_admin'});
  expect((await tasks(scoped)).filter(row=>row.kind==='profile')).toEqual([]);
  expect(new Set((await tasks(group)).filter(row=>row.kind==='profile').map(row=>row.id))).toEqual(new Set([request.requestId,own.requestId]));
  await decideProfileChange(group,{requestId:request.requestId,decision:'rejected',reason:'Fictional task completion review'});
  expect((await tasks(group)).filter(row=>row.kind==='profile').map(row=>row.id)).toEqual([own.requestId]);
 });
});
