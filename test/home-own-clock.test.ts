/** Actual app-role clock owner, canonical hire/own-subject proof. Fixture administration only changes
 * lifecycle/photo policy to exercise refusals; it never inserts Attendance/captures directly. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {captureEmployeeClock,ownClockReceipt,ownClockToday,requestOwnClockRemoval} from '../packs/attendance/service';
import {ownLiveEmploymentSubjects} from '../core/own-employment-selection';
import {OwnEmploymentSelectionError} from '../lib/own-employment-selection';
import {clockCommandContext} from '../lib/clock-command-context';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function setup(){
 const a=adminCtx(b),first=await hireEmployee(a,{person:{fullName:'Fictional concurrent employee',primaryEmail:`${randomUUID()}@home.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const second=await hireEmployee(a,{person:{id:first.personId},companyId:b.companyId,departmentId:b.deptB,employmentType:'part_time',hiredOn:'2020-01-02'});
 const userId=await createAppUser(b.tenantId,first.personId,'employee');
 const self:SessionContext={...a,userId,personId:first.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {a,first,second,self};
}
const intent=(employmentId:string)=>({employmentId,action:'out' as const,requestId:randomUUID(),lat:null,lng:null,accuracy:null});
describe('Home selected own employment reaches every web-clock owner',()=>{
 it('requires selection for concurrent own employments, writes and recovers only the selected subject',async()=>{
  const {first,second,self}=await setup();
  expect((await ownLiveEmploymentSubjects(self)).map(row=>row.employmentId)).toEqual([first.employmentId,second.employmentId]);
  await expect(ownClockToday(self)).rejects.toBeInstanceOf(OwnEmploymentSelectionError);
  await expect(captureEmployeeClock(self,{...intent(second.employmentId),employmentId:undefined})).rejects.toBeInstanceOf(OwnEmploymentSelectionError);
  const command=intent(second.employmentId),receipt=await captureEmployeeClock(self,command);
  expect(await ownClockReceipt(self,command.requestId,second.employmentId)).toEqual(receipt);
  expect(await ownClockReceipt(self,command.requestId,first.employmentId)).toBeNull();
  const selected=await ownClockToday(self,undefined,second.employmentId);
  expect(selected.employmentId).toBe(second.employmentId);
  expect(selected.captures.map(row=>row.id)).toEqual([receipt.id]);
  expect((await ownClockToday(self,undefined,first.employmentId)).captures).toEqual([]);
  const target=selected.captures.find(row=>row.id===receipt.id)!;
  await expect(requestOwnClockRemoval(self,{employmentId:first.employmentId,punchId:target.punchId!,requestId:randomUUID(),baseline:selected.removalBaseline,reason:'Wrong subject',clockContext:clockCommandContext(b.tenantId,self.userId,first.employmentId)})).rejects.toThrow();
  const result=await requestOwnClockRemoval(self,{employmentId:second.employmentId,punchId:target.punchId!,requestId:randomUUID(),baseline:selected.removalBaseline,reason:'Accidental out',clockContext:selected.clockContext});
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,result.correctionId)))[0].employmentId).toBe(second.employmentId);
 });
 it('refuses foreign/invalid/stale selected employment and never silently falls back',async()=>{
  const {second,self,a}=await setup();
  const peer=await hireEmployee(a,{person:{fullName:'Fictional peer',primaryEmail:`${randomUUID()}@home.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  for(const selected of [peer.employmentId,randomUUID(),'not-a-uuid']){
   await expect(ownClockToday(self,undefined,selected)).rejects.toBeInstanceOf(OwnEmploymentSelectionError);
   await expect(captureEmployeeClock(self,intent(selected))).rejects.toBeInstanceOf(OwnEmploymentSelectionError);
  }
  const before=await ownClockToday(self,undefined,second.employmentId);
  await owner.db.update(s.employment).set({blacklistedAt:new Date()}).where(eq(s.employment.id,second.employmentId));
  await expect(captureEmployeeClock(self,{...intent(second.employmentId),clockContext:before.clockContext})).rejects.toBeInstanceOf(OwnEmploymentSelectionError);
  expect(await owner.db.select().from(s.attendanceClockCapture)).toEqual([]);
 });
 it('keeps the real current final-day own subject and preserves photo/context enforcement on selection',async()=>{
  const {first,second,self}=await setup();
  await owner.db.update(s.employment).set({terminatedOn:todayInKualaLumpur(),attendancePhotoSetting:'required'}).where(eq(s.employment.id,second.employmentId));
  expect((await ownLiveEmploymentSubjects(self)).some(row=>row.employmentId===second.employmentId)).toBe(true);
  await expect(captureEmployeeClock(self,intent(second.employmentId))).rejects.toThrow();
  await expect(captureEmployeeClock(self,{...intent(second.employmentId),clockContext:clockCommandContext(b.tenantId,self.userId,first.employmentId)})).rejects.toThrow(/original employee/);
  expect(await owner.db.select().from(s.attendanceClockCapture)).toEqual([]);
 });
});
