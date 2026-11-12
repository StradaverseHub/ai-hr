/** Native Today on the database (owner decisions, 12 Nov 2026): GET /api/mobile/v2/today and Confirm on its missed
 * clock-out reminder, through the REAL route handlers, mobileRoute, the composition and the real owners, on fictional
 * data. The loop opens the case; the person's own Today shows it as a reminder; a foreign employment is refused; and a
 * Confirm the phone repeats after a lost response answers `pending` and sends nothing, and two sent at once send one
 * correction (the attendance service keeps one waiting correction per day, core/attendance.ts
 * attendance_correction_one_pending_uq).
 * The bearer session is the one seam: it resolves the selected person's own login exactly as
 * test/loop-clock-out-confirm.test.ts does. Next request cookies/locale/cache are framework seams; identity SQL,
 * row-level security, custody and attendance effects are real. Expected values are written out from the fixture. */
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq} from 'drizzle-orm';
const browser=vi.hoisted(()=>({selected:undefined as string|undefined}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(name:string)=>name==='dev_user'&&browser.selected?{value:browser.selected}:undefined}),headers:async()=>new Headers()}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en'}));
vi.mock('next/cache',()=>({revalidatePath:()=>undefined}));
vi.mock('../lib/workos',()=>({currentWorkosSession:async()=>null}));
vi.mock('../lib/session',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/session')>();
 return {...original,getMobileSession:()=>original.getBrowserCommandSession()};
});
import * as schema from '../db/schema';
import {terasLoopCase} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {checkIn} from '../packs/attendance/service';
import {assignDefaultShift,createShift} from '../core/roster';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {runLoop} from '../core/loops/run';
import {TodayV2} from '../lib/mobile-api/v2/today';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,setModule,type Base} from './harness';
import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';

const todayRoute=await import('../app/api/mobile/v2/today/route');
const clockOutRoute=await import('../app/api/mobile/v2/today/clock-out/route');

type Person={uid:string;employmentId:string;personId:string};
let base:Base,worker:Person,colleague:Person,group:SessionContext,worked:string,principalId:string;
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
 vi.stubEnv('AI_CONFIG_SECRET','fictional-today-clock-out-custody-key-1234');
 vi.stubEnv('TERAS_PROPOSAL_SECRET','fictional-today-proposal-signing-secret-0123456789');
 await resetDb();base=await seedAttendanceSubmissionBase();
 for(const module of ['assistant','attendance'])await setModule(base.tenantId,module,'active');
 const admin=await hire('Fictional Today Administrator','hr_admin');
 group={...await entitledCtx(base,['hr_admin']),userId:admin.uid,personId:admin.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 worker=await hire('Fictional Today Clocker');colleague=await hire('Fictional Today Colleague');
 // Every day is a working day, so the fixture does not depend on today's weekday.
 const shiftId=(await createShift(adminCtx(base),{name:'Fictional Today Day',code:`TDY${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7]})).id;
 await assignDefaultShift(adminCtx(base),{employmentId:worker.employmentId,shiftId});
 worked=calendarDate(-2);
 await checkIn(adminCtx(base),{employmentId:worker.employmentId,date:worked,time:'09:02',manual:true});
 await setWorkerSwitch(group,{workerId:'loop_missed_clock_outs',enabled:true});
 principalId=await ensureAgentPrincipal(owner.db,base.tenantId);
 expect(await runLoop('loop_missed_clock_outs',{tenantId:base.tenantId,principalId,entitlements:(await entitledCtx(base)).entitlements!,today:todayInKualaLumpur()})).toMatchObject({status:'ran'});
 browser.selected=worker.uid;vi.stubEnv('DEV_USER_ID',base.adminUserId);
});
const caseId=async()=>{
 const rows=await withTenant(group,tx=>tx.select({id:terasLoopCase.id,state:terasLoopCase.state}).from(terasLoopCase)
  .where(and(eq(terasLoopCase.workerId,'loop_missed_clock_outs'),eq(terasLoopCase.subjectKey,`clockout:${worker.employmentId}:${worked}`))));
 expect(rows).toHaveLength(1);expect(rows[0].state).toBe('open');
 return rows[0].id;
};
const requests=()=>owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.tenantId,base.tenantId));
const URL0='https://hr.example.com/api/mobile/v2/today';
const today=async(query:string)=>{const r=await todayRoute.GET(new Request(`${URL0}?${query}`));return {status:r.status,body:await r.json()};};
const confirm=async(body:unknown,locale='ms')=>{
 const r=await clockOutRoute.POST(new Request(`${URL0}/clock-out`,{method:'POST',headers:{'content-type':'application/json','accept-language':locale},body:JSON.stringify(body)}));
 return {status:r.status,body:await r.json()};
};

describe('the native Today',()=>{
 it('shows the person\'s own missed clock-out as a reminder, and refuses an employment that is not theirs',async()=>{
  const id=await caseId();
  const own=await today(`employmentId=${worker.employmentId}`);
  expect(own.status).toBe(200);
  expect(TodayV2.safeParse(own.body).success).toBe(true);
  expect(own.body.date).toBe(todayInKualaLumpur());
  expect(own.body.reminders).toEqual({status:'ok',items:[{kind:'clockOut',caseId:id,date:worked,checkIn:'09:02',proposedCheckOut:'18:00'}]});
  // The reminder is not a second step.
  if(own.body.steps.status==='ok')expect(own.body.steps.items.filter((step:{kind:string;date:string|null})=>step.kind==='missed_clock_out'&&step.date===worked)).toEqual([]);
  expect(JSON.stringify(own.body)).not.toMatch(/href|\/attendance\//);
  for(const query of [`employmentId=${colleague.employmentId}`,`employmentId=${randomUUID()}`,''])
   expect(await today(query),query).toEqual({status:400,body:{error:'bad_request'}});
 });
});

describe('Confirm on the missed clock-out reminder',()=>{
 it('sends one correction with the reason in the caller\'s language; the same Confirm repeated after a lost response sends nothing more',async()=>{
  const body={caseId:await caseId(),reason:'forgot',confirm:true};
  expect(await confirm({...body,confirm:false})).toEqual({status:400,body:{error:'bad_request'}});
  expect(await requests()).toHaveLength(0);
  expect(await confirm(body)).toEqual({status:200,body:{outcome:'submitted'}});
  const sent=async()=>(await requests()).map(row=>({employment:row.employmentId,date:row.attendanceDate,in:row.proposedCheckIn,out:row.proposedCheckOut,status:row.status,reason:row.reason}));
  const once=[{employment:worker.employmentId,date:worked,in:'09:02:00',out:'18:00:00',status:'pending',reason:'Terlupa merekod keluar'}];
  expect(await sent()).toEqual(once);
  // The phone did not hear the answer and sends the identical Confirm again.
  // The correction for the day is already waiting: the answer says so, and nothing more is sent.
  expect(await confirm(body)).toEqual({status:200,body:{outcome:'refused',code:'pending'}});
  expect(await sent()).toEqual(once);
 });
 it('two identical Confirms at once send one correction',async()=>{
  const body={caseId:await caseId(),reason:'device',confirm:true};
  const answers=await Promise.all([confirm(body,'en'),confirm(body,'en')]);
  expect(answers.every(answer=>answer.status===200)).toBe(true);
  expect(answers.filter(answer=>answer.body.outcome==='submitted')).toHaveLength(1);
  // The other is refused (named `pending` once the first has committed, otherwise the custody's own refusal).
  expect(answers.filter(answer=>answer.body.outcome==='refused')).toHaveLength(1);
  expect((await requests()).map(row=>({employment:row.employmentId,date:row.attendanceDate,status:row.status,reason:row.reason})))
   .toEqual([{employment:worker.employmentId,date:worked,status:'pending',reason:'Device problem'}]);
 });
});
