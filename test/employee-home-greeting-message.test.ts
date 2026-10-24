import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {readEmployeeHomeGreeting} from '../core/employee-home-greeting';
import {listEmployeeHomeCards} from '../core/dashboard-card-config';
import {setEmployeeHomePreferences} from '../core/dashboard-prefs';
import {saveEmployeeHomeConfiguration} from '../core/employee-home-configuration';
import {defaultEmployeeHomePreferences} from '../lib/employee-home';
import {defaultEmployeeHomeConfiguration} from '../lib/employee-home-defaults';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {locales} from '../i18n/config';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
const today=()=>todayInKualaLumpur(),at=(date:string,hour=8)=>new Date(date+`T${String(hour).padStart(2,'0')}:00:00+08:00`);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function actor(hiredOn=addDaysIso(today(),-400)){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional Full Name',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn});
 const ctx:SessionContext={tenantId:b.tenantId,userId:await createAppUser(b.tenantId,hired.personId,'employee'),personId:hired.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 return {...hired,ctx};
}
describe('Home greeting uses current own facts and saved templates',()=>{
 it('uses the actual recorded preferred name, live display timezone and six saved language templates',async()=>{
  const e=await actor();await owner.db.update(s.person).set({preferredName:'Recorded preferred'}).where(eq(s.person.id,e.personId));
  const cards=await listEmployeeHomeCards(e.ctx);await setEmployeeHomePreferences(e.ctx,{...defaultEmployeeHomePreferences(),timeZone:'America/New_York'},cards);
  const instant=at(today(),8); // Midnight UTC: New York is still the preceding evening.
  for(const locale of locales){
   const result=await readEmployeeHomeGreeting(e.ctx,e.employmentId,locale,instant);
   expect(result).toMatchObject({version:1,employmentId:e.employmentId,templateKey:'greetingEvening',timeZone:'America/New_York'});
   expect(result.message).toContain('Recorded preferred');expect(result.displayDate).toBe(addDaysIso(today(),-1));
   expect(Object.keys(result).sort()).toEqual(['displayDate','employmentId','message','photoHref','serverNow','templateKey','timeZone','version']);
  }
 });
 it('resolves simultaneous real birthday/anniversary events by HR priority without transporting DOB',async()=>{
  const hire=String(Number(today().slice(0,4))-3)+today().slice(4),e=await actor(hire);
  const birth=String(Number(today().slice(0,4))-30)+today().slice(4);
  await owner.db.update(s.person).set({dateOfBirth:birth}).where(eq(s.person.id,e.personId));
  let value=await readEmployeeHomeGreeting(e.ctx,e.employmentId,'en',at(today()));expect(value.templateKey).toBe('greetingBirthday');expect(JSON.stringify(value)).not.toContain(birth);
  const config=defaultEmployeeHomeConfiguration();config.templates.find(row=>row.key==='greetingAnniversary')!.priority=1;
  await saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole:'employee',expectedOrdinal:0,configuration:config,reason:'Fictional anniversary priority'});
  value=await readEmployeeHomeGreeting(e.ctx,e.employmentId,'en',at(today()));expect(value.templateKey).toBe('greetingAnniversary');expect(value.message).toContain('3 years');
  for(const row of config.templates)if(row.key==='greetingBirthday'||row.key==='greetingAnniversary')row.enabled=false;
  await saveEmployeeHomeConfiguration(adminCtx(b),{companyId:b.companyId,audienceRole:'employee',expectedOrdinal:1,configuration:config,reason:'Fictional ordinary fallback'});
  expect((await readEmployeeHomeGreeting(e.ctx,e.employmentId,'en',at(today()))).templateKey).toBe('greetingMorning');
 });
 it('uses a real first day and returns from approved full-day leave across intervening non-work days',async()=>{
  const first=await actor(today());expect((await readEmployeeHomeGreeting(first.ctx,first.employmentId,'en',at(today()))).templateKey).toBe('greetingFirstDay');
  await setModule(b.tenantId,'attendance','active');
  const e=await actor();let monday=today();while(new Date(monday+'T12:00:00Z').getUTCDay()!==1)monday=addDaysIso(monday,-1);
  await owner.db.insert(s.attendancePolicy).values({tenantId:b.tenantId,companyId:b.companyId,workingDays:[1,2,3,4,5]}).onConflictDoNothing();
  await owner.db.update(s.attendancePolicy).set({workingDays:[1,2,3,4,5],halfWorkingDays:[]}).where(and(eq(s.attendancePolicy.tenantId,b.tenantId),eq(s.attendancePolicy.companyId,b.companyId)));
  const friday=addDaysIso(monday,-3);
  const [leave]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:e.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:friday,endDate:friday,days:'1',status:'approved',reason:'Private medical detail must never be rendered'}).returning({id:s.leaveRequest.id});
  let value=await readEmployeeHomeGreeting(e.ctx,e.employmentId,'en',at(monday));expect(value.templateKey).toBe('greetingReturn');expect(JSON.stringify(value)).not.toMatch(/medical|reason|leaveRequest|days/);
  await owner.db.update(s.leaveRequest).set({status:'cancelled'}).where(eq(s.leaveRequest.id,leave.id));
  value=await readEmployeeHomeGreeting(e.ctx,e.employmentId,'en',at(monday));expect(value.templateKey).toBe('greetingMorning');
 });
 it('does not invent a substitute birthday in a non-leap year',async()=>{
  const year=Number(today().slice(0,4));let nonLeap=year;while(nonLeap%4===0)nonLeap--;
  const e=await actor(`${year-5}-01-01`);
  await owner.db.update(s.person).set({dateOfBirth:'2000-02-29'}).where(eq(s.person.id,e.personId));
  for(const day of [`${nonLeap}-02-28`,`${nonLeap}-03-01`])expect((await readEmployeeHomeGreeting(e.ctx,e.employmentId,'en',at(day))).templateKey).toBe('greetingMorning');
 });
 it('refuses broad HR reach, forged person and newly archived login before returning a greeting',async()=>{
  const e=await actor(),other=await actor();
  const hr={...e.ctx,userId:await createAppUser(b.tenantId,e.personId,'hr_admin'),roles:['hr_admin']};
  await expect(readEmployeeHomeGreeting(hr,other.employmentId,'en')).rejects.toMatchObject({code:'employmentUnavailable'});
  await expect(readEmployeeHomeGreeting({...e.ctx,personId:other.personId},other.employmentId,'en')).rejects.toMatchObject({code:'employmentUnavailable'});
  await owner.db.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,e.ctx.userId!));
  await expect(readEmployeeHomeGreeting(e.ctx,e.employmentId,'en')).rejects.toMatchObject({code:'employmentUnavailable'});
 });
});
