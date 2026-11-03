/** AI v2 W8 — Confirm on Today's missed clock-out card (core/loops/clock-out-confirm.ts), on fictional data over the real
 * owners: the loop opens the case, the person picks their own reason and presses Confirm, and the slice 1 attendance
 * correction is sent for the existing approval with that reason. Refused, writing nothing: no explicit Confirm, no
 * reason, someone else's case, a day changed since the card, a loop switched off, a second Confirm. Next request
 * cookies/locale/cache are framework seams; identity SQL, row-level security, custody and attendance effects are real.
 * Expected values are written out from the fixture. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
import * as schema from '../db/schema';
import {terasLoopCase} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {getBrowserCommandSession} from '../lib/session';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {checkIn,checkOut} from '../packs/attendance/service';
import {assignDefaultShift,createShift} from '../core/roster';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {runLoop} from '../core/loops/run';
import {confirmMissedClockOut} from '../core/loops/clock-out-confirm';
import {clockOutReasonText} from '../lib/today/clock-out-reasons';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

type Person={uid:string;employmentId:string;personId:string};
let base:Base,worker:Person,colleague:Person,group:SessionContext,worked:string;
/** HR calendar days from the repository's HR date owner (Asia/Kuala_Lumpur), then plain date arithmetic. */
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
async function hire(name:string,role:'employee'|'hr_admin'='employee'):Promise<Person>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const uid=await createAppUser(base.tenantId,hired.personId,role);await grantAssistant(adminCtx(base),{appUserId:uid});
 return{uid,employmentId:hired.employmentId,personId:hired.personId};
}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NODE_ENV','test');vi.stubEnv('ALLOW_DEMO_SESSION','false');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-clock-out-card-custody-key-1234');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-proposal-signing-secret-0123456789abcdef');
 await resetDb();base=await seedBase();
 for(const module of ['assistant','attendance'])await setModule(base.tenantId,module,'active');
 const admin=await hire('Fictional Group Administrator','hr_admin');
 group={...await entitledCtx(base,['hr_admin']),userId:admin.uid,personId:admin.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 worker=await hire('Fictional Card Clocker');colleague=await hire('Fictional Card Colleague');
 // Every day is a working day, so the fixture does not depend on today's weekday.
 const shift=(await createShift(adminCtx(base),{name:'Fictional Day',code:`DAY${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]})).id;
 await assignDefaultShift(adminCtx(base),{employmentId:worker.employmentId,shiftId:shift});
 worked=calendarDate(-2);
 await checkIn(adminCtx(base),{employmentId:worker.employmentId,date:worked,time:'09:02',manual:true});
 await setWorkerSwitch(group,{workerId:'loop_missed_clock_outs',enabled:true});
 const principalId=await ensureAgentPrincipal(owner.db,base.tenantId);
 expect(await runLoop('loop_missed_clock_outs',{tenantId:base.tenantId,principalId,entitlements:(await entitledCtx(base)).entitlements!,today:todayInKualaLumpur()}))
  .toMatchObject({status:'ran'});
 browser.selected=worker.uid;vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caller=()=>getBrowserCommandSession();
const caseId=async()=>{
 const rows=await withTenant(group,tx=>tx.select({id:terasLoopCase.id,facts:terasLoopCase.facts,state:terasLoopCase.state}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.workerId,'loop_missed_clock_outs'),eq(terasLoopCase.subjectKey,`clockout:${worker.employmentId}:${worked}`))));
 expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'open',facts:{date:worked,checkIn:'09:02',proposedCheckOut:'18:00'}});
 return rows[0].id;
};
const requests=()=>owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.tenantId,base.tenantId));
const LABELS={forgot:'Forgot to clock out',device:'Device problem'};

describe('the reason is the person\'s own choice',()=>{
 it('is the label of the option they picked, or what they typed for Other, and nothing else',()=>{
  expect(clockOutReasonText('forgot',undefined,LABELS)).toBe('Forgot to clock out');
  expect(clockOutReasonText('device','ignored',LABELS)).toBe('Device problem');
  expect(clockOutReasonText('other','  Left early   for a clinic visit ',LABELS)).toBe('Left early for a clinic visit');
  for(const [choice,other] of [[null,undefined],['other',''],['other','   '],['other','x'.repeat(501)],['approve',undefined],['other',42]] as const)
   expect(clockOutReasonText(choice,other,LABELS),JSON.stringify([choice,other])).toBeNull();
 });
});

describe('Confirm on the missed clock-out card',()=>{
 it('sends the correction with the person\'s reason for the existing approval, only on an explicit Confirm',async()=>{
  const id=await caseId();
  for(const confirm of [undefined,false,'true',1])expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:'Forgot to clock out',confirm})).toEqual({kind:'refused',reason:'not_confirmed'});
  expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:null,confirm:true})).toEqual({kind:'refused',reason:'invalid'});
  expect(await requests()).toHaveLength(0);
  expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:'Forgot to clock out',confirm:true})).toEqual({kind:'submitted'});
  const rows=await requests();
  expect(rows.map(row=>({employment:row.employmentId,date:row.attendanceDate,in:row.proposedCheckIn,out:row.proposedCheckOut,status:row.status,reason:row.reason})))
   .toEqual([{employment:worker.employmentId,date:worked,in:'09:02:00',out:'18:00:00',status:'pending',reason:'Forgot to clock out'}]);
  // A request for the approver, not a clock change: the day on record is untouched until it is approved.
  const [day]=await owner.db.select({out:schema.attendance.checkOutAt}).from(schema.attendance).where(and(eq(schema.attendance.employmentId,worker.employmentId),eq(schema.attendance.attendanceDate,worked)));
  expect(day.out).toBeNull();
  // A second Confirm sends nothing more: the attendance service refuses a second request for the day.
  expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:'Device problem',confirm:true})).toMatchObject({kind:'refused'});
  expect(await requests()).toHaveLength(1);
 });
 it('refuses someone else\'s case, a day changed since the card and a loop switched off, writing nothing',async()=>{
  const id=await caseId();
  browser.selected=colleague.uid;
  expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:'Forgot to clock out',confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect(await confirmMissedClockOut(await caller(),{caseId:randomUUID(),reason:'Forgot to clock out',confirm:true})).toEqual({kind:'refused',reason:'unavailable'});
  expect(await confirmMissedClockOut(await caller(),{caseId:'not-a-case',reason:'Forgot to clock out',confirm:true})).toEqual({kind:'refused',reason:'invalid'});
  browser.selected=worker.uid;
  await setWorkerSwitch(group,{workerId:'loop_missed_clock_outs',enabled:false});
  expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:'Forgot to clock out',confirm:true})).toEqual({kind:'refused',reason:'retired'});
  await setWorkerSwitch(group,{workerId:'loop_missed_clock_outs',enabled:true});
  // The clock-out is now on record at another time: the card no longer shows the day as it is, so nothing is sent.
  await checkOut(adminCtx(base),{employmentId:worker.employmentId,date:worked,time:'19:10',manual:true});
  expect(await confirmMissedClockOut(await caller(),{caseId:id,reason:'Forgot to clock out',confirm:true})).toEqual({kind:'refused',reason:'changed'});
  expect(await requests()).toHaveLength(0);
 });
});
