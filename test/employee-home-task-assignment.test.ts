import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {requestLeave,decideLeave,requestLeaveCancellation,decideLeaveCancellation,setLeaveApprovalPolicy} from '../packs/leave/service';
import {listPendingTasks} from '../core/approvals-inbox';
import {readEmployeeHomeIdentity} from '../core/employee-home';
import {todayInKualaLumpur} from '../lib/hr-date';

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
const tasks=(ctx:SessionContext)=>listPendingTasks(ctx,undefined,{attendance:false,claims:false});
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
});
