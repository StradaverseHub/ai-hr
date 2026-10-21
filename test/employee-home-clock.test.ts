import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import {appUser,employment} from '../db/schema';
import {hireEmployee} from '../core/org';
import {readEmployeeHomeClock} from '../core/employee-home';
import {ownClockToday} from '../packs/attendance/service';
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
