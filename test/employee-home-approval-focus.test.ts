import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {listLeaveRequests} from '../core/read';
import {listAttendanceCorrections} from '../packs/attendance/service';
import {isCurrentAssignedApproval} from '../core/assigned-approval-focus';
import {decideResignation,listResignationRequests} from '../core/offboarding';
import {ASSIGNED_APPROVAL_KINDS,parseAssignedApprovalFocus,assignedApprovalHref} from '../lib/assigned-approval-focus';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
const on=(days:number)=>new Date(Date.parse(todayInKualaLumpur()+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
async function actor(name:string,manager?:string){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:on(-800),reportingManagerEmploymentId:manager});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
const modules={attendance:true,claims:false};
describe('Home links to the actual assigned request beyond legacy queue ceilings',()=>{
 it('round-trips only a complete known kind and UUID, with an exact row target',()=>{
  const id=randomUUID();
  for(const kind of ASSIGNED_APPROVAL_KINDS){
   const focus=parseAssignedApprovalFocus(kind,id)!;expect(focus).toEqual({kind,id});
   const url=new URL(assignedApprovalHref(focus),'https://fixture.invalid');
   expect(url.pathname).toBe('/approvals');expect(url.searchParams.get('task')).toBe(kind);expect(url.searchParams.get('requestId')).toBe(id);expect(url.hash).toContain(id);
  }
  expect(parseAssignedApprovalFocus(undefined,undefined)).toBeNull();
  for(const [kind,idValue] of [['unknown',id],['leave',undefined],[undefined,id],['leave',''],[['leave'],id],['leave',[id]]])expect(()=>parseAssignedApprovalFocus(kind,idValue)).toThrow();
 });
 it('finds an actual Employee-role manager’s old Attendance request that the ordinary 100-row queue omits',async()=>{
  const manager=await actor('Fictional focused manager'),subject=await actor('Fictional focused subject',manager.employmentId),other=await actor('Fictional unrelated reader');
  const id=randomUUID(),start=Date.now()-211000;
  await owner.db.insert(s.attendanceCorrection).values(Array.from({length:211},(_,i)=>({id:i===0?id:randomUUID(),tenantId:b.tenantId,employmentId:subject.employmentId,attendanceDate:on(-i),proposedCheckIn:'09:00',reason:'Fictional retained request',createdAt:new Date(start+i*1000)})));
  expect((await listAttendanceCorrections(manager.ctx,{status:'pending'})).some(row=>row.id===id)).toBe(false);
  const focus={kind:'attendance' as const,id};
  expect(await isCurrentAssignedApproval(manager.ctx,focus,modules)).toBe(true);
  expect(await isCurrentAssignedApproval(subject.ctx,focus,modules)).toBe(false);
  expect(await isCurrentAssignedApproval(other.ctx,focus,modules)).toBe(false);
  expect(await isCurrentAssignedApproval(manager.ctx,focus,{...modules,attendance:false})).toBe(false);
  expect(await listAttendanceCorrections(manager.ctx,{status:'pending',requestId:id})).toMatchObject([{id}]);
 });
 it('applies exact Leave request selection before the existing 200-row limit without granting a foreign reader access',async()=>{
  const manager=await actor('Fictional focused leave manager'),subject=await actor('Fictional focused leave subject',manager.employmentId),other=await actor('Fictional unrelated leave reader');
  const id=randomUUID(),start=Date.now()-211000;
  await owner.db.insert(s.leaveRequest).values(Array.from({length:211},(_,i)=>({id:i===0?id:randomUUID(),tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:on(1),endDate:on(1),days:'1',createdAt:new Date(start+i*1000)})));
  expect((await listLeaveRequests(manager.ctx,undefined,200,{status:'pending'})).some(row=>row.id===id)).toBe(false);
  expect(await isCurrentAssignedApproval(manager.ctx,{kind:'leave',id},modules)).toBe(true);
  expect(await listLeaveRequests(manager.ctx,undefined,1,{status:'pending',requestId:id})).toMatchObject([{id}]);
  expect(await listLeaveRequests(other.ctx,undefined,1,{status:'pending',requestId:id})).toEqual([]);
 });
 it('removes admission after a real decision and fails a newly revoked principal instead of trusting the URL',async()=>{
  const subject=await actor('Fictional resignation subject'),id=randomUUID();
  await owner.db.insert(s.resignationRequest).values({id,tenantId:b.tenantId,employmentId:subject.employmentId,personId:subject.personId,lastWorkingDay:on(1)});
  const focus={kind:'resignation' as const,id},ctx=adminCtx(b);
  expect(await isCurrentAssignedApproval(ctx,focus,modules)).toBe(true);
  expect(await listResignationRequests(ctx,{status:'pending',requestId:id})).toMatchObject([{id}]);
  await decideResignation(ctx,{requestId:id,decision:'rejected'});
  expect(await isCurrentAssignedApproval(ctx,focus,modules)).toBe(false);
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,ctx.userId!));
  await expect(isCurrentAssignedApproval(ctx,focus,modules)).rejects.toMatchObject({name:'AssignedWorkPrincipalUnavailableError'});
 });
});
