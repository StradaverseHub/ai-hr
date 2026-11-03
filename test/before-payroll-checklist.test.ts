/** AI v2 Phase 2, P2-3 — the "Before payroll" checklist over the REAL owners, on fictional data.
 *
 * Two employees with two different managers, each with a missed clock-out yesterday, a leave request and an attendance
 * correction waiting for their manager. Pinned, with expected values written out from the fixture:
 *  - each person sees only their own items (never the colleague's day, leave or correction), read as themselves;
 *  - the missed clock-out's one action is the loop's own Confirm card once the loop has prepared it;
 *  - each manager sees only the decisions the approvals owner assigns them: their own team's;
 *  - the cut-off is the payroll owner's for the company of the person's own employment, employee and administrator alike
 *    (month end with no cut-off day, then the window the company's day 28 opens), read through
 *    app.own_payroll_cut_off_day (migration 0967) while company_payroll_config itself stays administrators-only;
 *  - that function answers only for the caller's own current employment: an employee of A gets A's day, never B's (even
 *    given B's ids), a login with no employment gets nothing, a person with two employments gets exactly those two
 *    companies' days, and it exposes no other configuration column;
 *  - no pay figure: the employee's salary appears nowhere in the result.
 * Every item kind is pinned against its owner's row shape in test/before-payroll-items.test.ts. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {setCompensation} from '../core/comp';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {checkIn,requestAttendanceCorrection} from '../core/attendance';
import {assignDefaultShift,createShift} from '../core/roster';
import {requestLeave} from '../packs/leave/service';
import {runLoop} from '../core/loops/run';
import {readMyPayrollReadiness} from '../core/pre-salary/person-items';
import type {PayrollReadiness} from '../lib/pre-salary/items';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

/** The HR day: Thursday 2 July 2026. Yesterday, Wednesday 1 July, and Tuesday 30 June are working days. */
const TODAY='2026-07-02',YESTERDAY='2026-07-01',TUESDAY='2026-06-30';
let b:Base;
type Login=SessionContext&{employmentId:string;personId:string;userId:string};
async function login(name:string,role:'employee'|'manager'|'hr_admin'):Promise<Login>{
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 const ctx=await entitledCtx(b,[role]);
 return {...ctx,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
const read=(ctx:SessionContext)=>readMyPayrollReadiness(ctx,{today:TODAY,locale:'en'}).then(result=>{if(!result)throw Error('No checklist.');return result;});
const kinds=(result:PayrollReadiness)=>result.items.map(row=>[row.kind,row.state,row.date]);

let aina:Login,siti:Login,ravi:Login,mei:Login,group:Login,leave:{aina:string;siti:string};
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 for(const code of ['payroll','attendance'])await setModule(b.tenantId,code,'active');
 const a=adminCtx(b);
 group=await login('Fictional Group Administrator','hr_admin');
 aina=await login('Aina Fictional','employee');siti=await login('Siti Fictional','employee');
 ravi=await login('Ravi Fictional','manager');mei=await login('Mei Fictional','manager');
 await setReportingLine(a,{subordinateEmploymentId:aina.employmentId,managerEmploymentId:ravi.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 await setReportingLine(a,{subordinateEmploymentId:siti.employmentId,managerEmploymentId:mei.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 await setCompensation(a,{employmentId:aina.employmentId,basicSalary:5432.1,effectiveFrom:'2024-01-01'});
 const shift=(await createShift(a,{name:'Fictional Day',code:`DAY${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]})).id;
 for(const person of [aina,siti]){
  await assignDefaultShift(a,{employmentId:person.employmentId,shiftId:shift});
  // Yesterday: clocked in, never out. Tuesday: clocked in, and a correction sent to the person's manager.
  await checkIn(a,{employmentId:person.employmentId,date:YESTERDAY,time:'09:02',manual:true});
  await checkIn(a,{employmentId:person.employmentId,date:TUESDAY,time:'08:55',manual:true});
  await requestAttendanceCorrection(a,{employmentId:person.employmentId,date:TUESDAY,checkIn:'08:55',checkOut:'18:00',reason:'Fictional: forgot to clock out'});
 }
 await seedEntitlement(a,{leaveTypeId:b.annualLeaveTypeId,annualDays:14,validFrom:'2020-01-01'});
 const own=async(person:Login,date:string)=>(await requestLeave(person,{employmentId:person.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Fictional leave',today:TODAY})).leaveRequestId;
 leave={aina:await own(aina,'2026-07-10'),siti:await own(siti,'2026-07-13')};
});

describe('each person\'s own checklist',()=>{
 it('shows the person their own missed clock-out and leave, never a colleague\'s, with the calendar month and no cut-off date',async()=>{
  await owner.db.delete(schema.companyPayrollConfig).where(eq(schema.companyPayrollConfig.companyId,b.companyId));
  const mine=await read(aina),theirs=await read(siti);
  // The company sets no cut-off day: the payroll owner's month end, for the employee too (migration 0967).
  expect(mine.period).toEqual({payPeriod:'2026-07',start:'2026-07-01',cutOff:'2026-07-31',source:'month_end'});
  expect(kinds(mine).filter(([kind])=>kind==='missed_clock_out'||kind==='leave_pending')).toEqual([['missed_clock_out','todo',YESTERDAY],['leave_pending','waiting','2026-07-10']]);
  expect(kinds(theirs).filter(([kind])=>kind==='missed_clock_out'||kind==='leave_pending')).toEqual([['missed_clock_out','todo',YESTERDAY],['leave_pending','waiting','2026-07-13']]);
  expect(mine.items.find(row=>row.kind==='leave_pending')!.key).toBe(`leave_pending:${leave.aina}`);
  const text=JSON.stringify(mine);
  expect(text).not.toContain(leave.siti);expect(text).not.toContain('2026-07-13');expect(text).not.toContain(siti.employmentId);
  // Only the person's own kinds; the approvals list is for decisions, and an employee has none.
  expect(mine.approvals).toEqual([]);
  // Tuesday is before July: it is not part of this month's checklist.
  expect(mine.items.some(row=>row.date===TUESDAY)).toBe(false);
 });

 it('offers the missed clock-out loop\'s own Confirm card once the loop prepared it',async()=>{
  const principal=await ensureAgentPrincipal(owner.db,b.tenantId);
  await setWorkerSwitch(group,{workerId:'loop_missed_clock_outs',enabled:true});
  expect(await runLoop('loop_missed_clock_outs',{tenantId:b.tenantId,principalId:principal,entitlements:(await entitledCtx(b)).entitlements!,today:TODAY})).toMatchObject({status:'ran'});
  const row=(await read(aina)).items.find(item=>item.kind==='missed_clock_out')!;
  expect(row.action).toMatchObject({kind:'confirm',card:'clockOut',date:YESTERDAY,checkIn:'09:02',proposedCheckOut:'18:00',href:'/attendance/my-records/2026-07-01?checkOut=18%3A00'});
  // The colleague's card is never offered to Aina, and hers never to the colleague.
  const theirs=(await read(siti)).items.find(item=>item.kind==='missed_clock_out')!;
  expect(theirs.action.kind).toBe('confirm');
  expect(theirs.action.kind==='confirm'&&row.action.kind==='confirm'&&theirs.action.caseId!==row.action.caseId).toBe(true);
 });

 it('carries no pay figure',async()=>{
  const text=JSON.stringify(await read(aina));
  expect(text).not.toMatch(/5432|5,432/);
 });
});

describe('a manager\'s checklist',()=>{
 it('lists only the decisions the approvals owner assigns them: their own team\'s',async()=>{
  const r=await read(ravi),m=await read(mei);
  expect(r.approvals.filter(row=>row.kind==='approve_attendance').map(row=>row.label)).toEqual(['Aina Fictional']);
  expect(m.approvals.filter(row=>row.kind==='approve_attendance').map(row=>row.label)).toEqual(['Siti Fictional']);
  expect(JSON.stringify(r.approvals)).not.toContain('Siti Fictional');
  expect(JSON.stringify(m.approvals)).not.toContain('Aina Fictional');
  // A manager's own checklist has none of the team's own items.
  expect(JSON.stringify(r.items)).not.toContain(leave.aina);
 });
});

describe('the cut-off is the payroll owner\'s',()=>{
 it('for employee and administrator alike: month end with no cut-off day, then the window day 28 opens',async()=>{
  await owner.db.delete(schema.companyPayrollConfig).where(eq(schema.companyPayrollConfig.companyId,b.companyId));
  expect((await read(group)).period).toEqual({payPeriod:'2026-07',start:'2026-07-01',cutOff:'2026-07-31',source:'month_end'});
  await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,cutOffDay:28});
  // Day 28: inputs from 28 June to 27 July count towards July.
  expect((await read(group)).period).toEqual({payPeriod:'2026-07',start:'2026-06-28',cutOff:'2026-07-27',source:'company'});
  // The employee gets the same date through the definer function, while the settings themselves stay closed to them.
  expect((await read(aina)).period).toEqual({payPeriod:'2026-07',start:'2026-06-28',cutOff:'2026-07-27',source:'company'});
  expect(await withTenant(aina,tx=>tx.select().from(schema.companyPayrollConfig))).toEqual([]);
  expect((await read(aina)).items.find(row=>row.kind==='leave_pending')!.due).toBe('2026-07-27');
  // Every own item of the administrator is due on the cut-off.
  expect((await read(group)).items.every(row=>row.due==='2026-07-27')).toBe(true);
 });
});

describe('app.own_payroll_cut_off_day (migration 0967)',()=>{
 type Row={cut_off_day:number|null};
 const own=(ctx:SessionContext,employmentId:string)=>withTenant(ctx,tx=>tx.execute(sql`SELECT * FROM app.own_payroll_cut_off_day(${employmentId}::uuid)`)).then(rows=>[...(rows as unknown as Row[])]);
 async function companyB(){
  const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Beta Sdn Bhd'}).returning({id:schema.company.id});
  const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional Beta Operations'}).returning({id:schema.department.id});
  await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:company.id,cutOffDay:15,payDay:17,overtimeCutOffDay:9,claimCutOffDay:11});
  return {companyId:company.id,departmentId:dept.id};
 }
 beforeEach(async()=>{
  await owner.db.delete(schema.companyPayrollConfig).where(eq(schema.companyPayrollConfig.companyId,b.companyId));
  await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:b.companyId,cutOffDay:28,payDay:25,attendanceCutOffDay:21});
 });

 it('gives an employee of A only A\'s cut-off day, and nothing for B, a colleague or an unknown id',async()=>{
  const beta=await companyB();
  const bob=await hireEmployee(adminCtx(b),{person:{fullName:'Bob Fictional',primaryEmail:`${randomUUID()}@fixture.test`},companyId:beta.companyId,departmentId:beta.departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
  expect(await own(aina,aina.employmentId)).toEqual([{cut_off_day:28}]);
  // B's employment, the colleague's in A and an id that is no employment: no row, however the id is passed.
  expect(await own(aina,bob.employmentId)).toEqual([]);
  expect(await own(aina,siti.employmentId)).toEqual([]);
  expect(await own(aina,randomUUID())).toEqual([]);
  // Even the group administrator, who may read B's settings directly, gets nothing for another person's employment.
  expect(await own(group,bob.employmentId)).toEqual([]);
 });

 it('gives a login with no employment nothing, and its checklist no date',async()=>{
  const [person]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional Visitor',primaryEmail:`${randomUUID()}@fixture.test`}).returning({id:schema.person.id});
  const userId=await createAppUser(b.tenantId,person.id,'employee');
  const visitor={...await entitledCtx(b,['employee']),userId,personId:person.id,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext;
  expect(await own(visitor,aina.employmentId)).toEqual([]);
  expect((await read(visitor)).period).toEqual({payPeriod:'2026-07',start:'2026-07-01',cutOff:null,source:'unavailable'});
 });

 it('gives a person with two employments exactly those two companies\' days',async()=>{
  const beta=await companyB();
  const second=await hireEmployee(adminCtx(b),{person:{id:aina.personId},companyId:beta.companyId,departmentId:beta.departmentId,employmentType:'full_time',hiredOn:'2025-01-01'});
  const bob=await hireEmployee(adminCtx(b),{person:{fullName:'Bob Fictional',primaryEmail:`${randomUUID()}@fixture.test`},companyId:beta.companyId,departmentId:beta.departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
  expect(await own(aina,aina.employmentId)).toEqual([{cut_off_day:28}]);
  expect(await own(aina,second.employmentId)).toEqual([{cut_off_day:15}]);
  expect(await own(aina,bob.employmentId)).toEqual([]);
 });

 it('exposes the cut-off day and nothing else, as a STABLE definer with a fixed search path, executable by the application role only',async()=>{
  const rows=await own(aina,aina.employmentId);
  expect(rows.map(row=>Object.keys(row))).toEqual([['cut_off_day']]);
  // Pay day 25 and the attendance cut-off 21 are in the same configuration row and never leave it.
  expect(JSON.stringify(rows)).not.toMatch(/25|21/);
  const [fn]=await owner.db.execute(sql`SELECT p.prosecdef AS definer,p.provolatile AS volatility,p.proconfig AS config,pg_get_function_result(p.oid) AS result,
   has_function_privilege('ai_hr_app',p.oid,'EXECUTE') AS app,
   EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proname='own_payroll_cut_off_day'`) as unknown as {definer:boolean;volatility:string;config:string[];result:string;app:boolean;public_execute:boolean}[];
  expect(fn).toMatchObject({definer:true,volatility:'s',result:'TABLE(cut_off_day integer)',app:true,public_execute:false});
  expect(fn.config).toHaveLength(1);expect(fn.config[0]).toMatch(/^search_path=pg_catalog,\s*public,\s*pg_temp$/);
 });
});
