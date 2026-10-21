import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {appUser,employment,company,department,attendanceClockCapture,attendanceCorrection} from '../db/schema';
import {hireEmployee} from '../core/org';
import {readEmployeeHomeClock} from '../core/employee-home';
import {ownClockToday,captureEmployeeClock,ownClockReceipt,requestOwnClockRemoval,AttendancePhotoRequiredError,GeolocationRequiredError} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {clockCommandContext} from '../lib/clock-command-context';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});
async function worker(role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Home clock '+randomUUID(),primaryEmail:randomUUID()+'@example.test'},
  companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:hired.personId,roles:[role],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
describe('Home selected clock context',()=>{
 it('keeps two own employments separate across commands, retries, receipt recovery and removal',async()=>{
  const own=await worker();
  const [co]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional concurrent employer'}).returning();
  const [dept]=await owner.db.insert(department).values({tenantId:b.tenantId,companyId:co.id,name:'Fictional concurrent department'}).returning();
  const second=await hireEmployee(adminCtx(b),{person:{id:own.personId},companyId:co.id,departmentId:dept.id,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const firstState=await ownClockToday(own.ctx,undefined,own.employmentId),secondState=await ownClockToday(own.ctx,undefined,second.employmentId);
  expect(secondState.clockContext).not.toBe(firstState.clockContext);
  const intent={employmentId:second.employmentId,clockContext:secondState.clockContext,action:'in' as const,requestId:randomUUID(),lat:null,lng:null,accuracy:null};
  await expect(captureEmployeeClock(own.ctx,{...intent,clockContext:undefined})).rejects.toThrow(/Reopen/);
  await expect(captureEmployeeClock(own.ctx,{...intent,clockContext:firstState.clockContext})).rejects.toThrow(/original employee/);
  const receipt=await captureEmployeeClock(own.ctx,intent);
  expect(await captureEmployeeClock(own.ctx,intent)).toEqual(receipt);
  expect(await ownClockReceipt(own.ctx,intent.requestId,second.employmentId)).toEqual(receipt);
  expect(await ownClockReceipt(own.ctx,intent.requestId,own.employmentId)).toBeNull();
  expect(await owner.db.select().from(attendanceClockCapture).where(eq(attendanceClockCapture.employmentId,own.employmentId))).toEqual([]);
  const live=await ownClockToday(own.ctx,undefined,second.employmentId);
  expect(live.captures).toHaveLength(1);expect(live.clockedIn).toBe(true);
  const removal={employmentId:second.employmentId,punchId:live.captures[0].punchId!,requestId:randomUUID(),baseline:live.removalBaseline,clockContext:live.clockContext,reason:'Fictional accidental clock'};
  await expect(requestOwnClockRemoval(own.ctx,{...removal,employmentId:own.employmentId,clockContext:firstState.clockContext})).rejects.toThrow(/not available/);
  const requested=await requestOwnClockRemoval(own.ctx,removal);
  expect(await requestOwnClockRemoval(own.ctx,removal)).toEqual(requested);
  const [row]=await owner.db.select().from(attendanceCorrection).where(eq(attendanceCorrection.id,requested.correctionId));
  expect(row).toMatchObject({employmentId:second.employmentId,status:'pending'});
  expect((await ownClockToday(own.ctx,undefined,second.employmentId)).clockedIn).toBe(true);
 });
 it('rechecks photo, location, login and own-subject eligibility on selected commands',async()=>{
  const own=await worker('hr_admin'),other=await worker();
  const state=await ownClockToday(own.ctx,undefined,own.employmentId);
  const intent={employmentId:own.employmentId,clockContext:state.clockContext,action:'in' as const,requestId:randomUUID(),lat:null,lng:null,accuracy:null};
  for(const id of ['',randomUUID(),other.employmentId])await expect(captureEmployeeClock(own.ctx,{...intent,employmentId:id})).rejects.toThrow('No active employee profile');
  await expect(captureEmployeeClock({...own.ctx,personId:other.personId},{...intent,employmentId:other.employmentId})).rejects.toThrow('No active employee profile');
  await owner.db.update(employment).set({attendancePhotoSetting:'required'}).where(eq(employment.id,own.employmentId));
  await expect(captureEmployeeClock(own.ctx,intent)).rejects.toBeInstanceOf(AttendancePhotoRequiredError);
  await owner.db.update(employment).set({attendancePhotoSetting:'not_required',geofencingEnabled:true}).where(eq(employment.id,own.employmentId));
  await expect(captureEmployeeClock(own.ctx,intent)).rejects.toBeInstanceOf(GeolocationRequiredError);
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,own.ctx.userId!));
  await expect(captureEmployeeClock(own.ctx,intent)).rejects.toThrow('No active employee profile');
  expect(await ownClockReceipt(own.ctx,intent.requestId,own.employmentId)).toBeNull();
  expect(await owner.db.select().from(attendanceClockCapture)).toEqual([]);
 });
 it('uses the canonical clock reader without manufacturing punches or bypassing photo/location prerequisites',async()=>{
  const own=await worker();
  await owner.db.update(employment).set({geofencingEnabled:true,attendancePhotoSetting:'required'}).where(eq(employment.id,own.employmentId));
  const result=await readEmployeeHomeClock(own.ctx,own.employmentId);
  expect(result).toMatchObject({date:todayInKualaLumpur(),clockedIn:false,workedSeconds:0,geofencingRequired:true,locationAvailable:false,locationValid:false,attendancePhotoSetting:'required',captures:[],legacy:[]});
  expect(result.clockContext).toBe(clockCommandContext(own.ctx.tenantId,own.ctx.userId,own.employmentId));
  for(const key of ['basic','allowance','gross','net','statutory'])expect(result).not.toHaveProperty(key);
 });
 it('does not fall back for empty or foreign selections, including an HR principal with broad visibility',async()=>{
  const own=await worker('hr_admin'),other=await worker();
  for(const id of ['',randomUUID(),other.employmentId])await expect(ownClockToday(own.ctx,undefined,id)).rejects.toThrow('No active employee profile');
  await expect(ownClockToday({...own.ctx,personId:other.personId},undefined,other.employmentId)).rejects.toThrow('No active employee profile');
 });
 it('rechecks login eligibility before an old selected card can reload its clock state',async()=>{
  const own=await worker();expect((await ownClockToday(own.ctx,undefined,own.employmentId)).clockedIn).toBe(false);
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,own.ctx.userId!));
  await expect(ownClockToday(own.ctx,undefined,own.employmentId)).rejects.toThrow('No active employee profile');
 });
});
