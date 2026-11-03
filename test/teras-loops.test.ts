/** AI v2 W8 — the first five loops at the Prepare level, on fictional data (migration 0960, core/loops).
 *
 *  1. Off by default: a switched-off loop does not run, writes no case and no run record, and the database refuses
 *     an agent case while the switch is off. The tenant stop switch and a per-company pause are honoured.
 *  2. The sponsor (the group administrator who switched it on) answers for it: the loop reads under their CURRENT
 *     authority and stops, with a record, when they lose it.
 *  3. Per loop: it detects on a fictional fixture, the card reaches the right person only, nothing changes without a
 *     person's Confirm on the owner's page, its next run closes the case once the work is done, and a recurrence
 *     reopens the same case.
 *  4. Tenant and company isolation; the Loops page reads per role.
 *  5. No model is called by any loop (the gateway is replaced by one that counts and refuses).
 * Expected values are written out from the fixtures, never re-derived from the loops' own helpers. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/ai')>();
 const refuse=async()=>{model.calls++;throw new Error('No model call is allowed in a loop.');};
 return {...original,generateDraft:refuse,converse:refuse,readImage:refuse};
});

import * as schema from '../db/schema';
import {terasLoopCase,terasLoopRun} from '../db/teras-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setReportingLine} from '../core/org';
import {agentContext,ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch,workerRunGate} from '../core/agent-registry/controls';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {checkIn,checkOut,decideAttendanceCorrection,requestAttendanceCorrection,attendanceForEmploymentRange} from '../core/attendance';
import {assignDefaultShift,createShift} from '../core/roster';
import {decideProfileChange} from '../core/profile';
import {runLoop,runLoopsForTenant} from '../core/loops/run';
import {readLoopCards} from '../core/loops/cards';
import {LoopControlRefused,setLoopPause} from '../core/loops/controls';
import {LoopViewRefused,loopDetail,loopsOverview} from '../core/loops/views';
import type {LoopId} from '../core/loops/types';
import {requestCurrentProfileChange} from './helpers/profile-requests';
import {requirePackFor} from '../localization/registry';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

/** The HR day every run is for: Thursday 2 July 2026 in Malaysia. Yesterday, Wednesday 1 July, is a working day. */
const TODAY='2026-07-02',YESTERDAY='2026-07-01',TUESDAY='2026-06-30';
let b:Base,principalId:string,group:SessionContext&{employmentId:string;personId:string};

type Login=SessionContext&{employmentId:string;personId:string;userId:string};
async function login(base:Base,name:string,role:'employee'|'manager'|'hr_admin',companyId=base.companyId,departmentId:string|undefined=base.deptA):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@fixture.test`},companyId,...(departmentId?{departmentId}:{}),employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 const ctx=await entitledCtx(base,[role]);
 return {...ctx,userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}],employmentId:hired.employmentId};
}
/** An HR administrator of one company only. */
async function companyAdmin(base:Base,companyId:string,departmentId:string):Promise<Login>{
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional Company Administrator',primaryEmail:`${randomUUID()}@fixture.test`},companyId,departmentId,employmentType:'full_time',hiredOn:'2024-01-01'});
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:hired.personId}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 const ctx=await entitledCtx(base,['hr_admin']);
 return {...ctx,userId:user.id,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}],employmentId:hired.employmentId};
}
const entitlements=async(base=b)=>(await entitledCtx(base)).entitlements!;
const run=async(id:LoopId,base=b,principal=principalId)=>runLoop(id,{tenantId:base.tenantId,principalId:principal,entitlements:await entitlements(base),today:TODAY});
const on=(id:LoopId,ctx:SessionContext=group)=>setWorkerSwitch(ctx,{workerId:id,enabled:true});
/** The cases as a group administrator reads them (FORCE row-level security binds the owner too). */
const casesOf=(id:LoopId,ctx:SessionContext=group)=>withTenant(ctx,tx=>tx.select().from(terasLoopCase).where(eq(terasLoopCase.workerId,id)));
const caseOf=async(id:LoopId,key:string)=>(await casesOf(id)).find(row=>row.subjectKey===key);
const runsOf=(id:LoopId,ctx:SessionContext=group)=>withTenant(ctx,tx=>tx.select().from(terasLoopRun).where(eq(terasLoopRun.workerId,id)));
const cards=(ctx:SessionContext,admin:boolean,scopeIds=[b.companyId])=>readLoopCards(ctx,{scopeIds,admin});
const pgText=(error:unknown)=>{const parts:string[]=[];for(let cur=error as Record<string,unknown>|undefined,n=0;cur&&typeof cur==='object'&&n<5;cur=cur.cause as never,n++)
 for(const key of ['message','detail'])if(typeof cur[key]==='string')parts.push(cur[key] as string);return parts.join(' | ');};
const day=(offset:number)=>new Date(Date.parse(`${TODAY}T00:00:00Z`)+offset*86_400_000).toISOString().slice(0,10);

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 model.calls=0;
 await resetDb();b=await seedBase();
 await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'attendance','active');
 group=await login(b,'Fictional Group Administrator','hr_admin');
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
});
afterEach(()=>{expect(model.calls,'a loop called a model').toBe(0);});

describe('the loop runner',()=>{
 it('is off by default: no run, no case, no record, and the database refuses an agent case while it is off',async()=>{
  const p=await login(b,'Fictional Probationer','employee');
  await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,p.employmentId));
  for(const id of ['loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry'] as const)
   expect(await workerRunGate(group,id)).toEqual({run:false,reasons:['switched_off']});
  expect((await runLoopsForTenant({tenantId:b.tenantId,principalId,entitlements:await entitlements(),today:TODAY})).map(result=>[result.workerId,result.status]))
   .toEqual([['loop_probation_ending','not_run'],['loop_payroll_inputs','not_run'],['loop_missing_employee_data','not_run'],['loop_missed_clock_outs','not_run'],['loop_document_expiry','not_run']]);
  expect(await casesOf('loop_probation_ending')).toEqual([]);
  expect(await runsOf('loop_probation_ending')).toEqual([]);
  // Even the agent principal itself cannot write a case for a loop that is off.
  const agent=agentContext(b.tenantId,principalId,await entitlements());
  const refused=await withTenant(agent,tx=>tx.insert(terasLoopCase).values({tenantId:b.tenantId,workerId:'loop_probation_ending',companyId:b.companyId,employmentId:p.employmentId,
   subjectKey:`probation:${p.employmentId}`,recipient:'hr',state:'open',facts:{},openedRunId:randomUUID(),checkedRunId:randomUUID()})).then(()=>null,(e:unknown)=>e);
  expect(pgText(refused)).toMatch(/row-level security/i);
  // Only a group administrator switches a loop on.
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  await expect(setWorkerSwitch(scoped,{workerId:'loop_probation_ending',enabled:true})).rejects.toMatchObject({reason:'not_administrator'});
 });

 it('honours the tenant stop switch and a pause for one company, and hides the cards while either holds',async()=>{
  const p=await login(b,'Fictional Probationer','employee');
  await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,p.employmentId));
  await on('loop_probation_ending');
  await setMandateStopSwitch(group,true);
  expect(await run('loop_probation_ending')).toEqual({workerId:'loop_probation_ending',status:'not_run',reasons:['stopped']});
  expect(await casesOf('loop_probation_ending')).toEqual([]);
  await setMandateStopSwitch(group,false);
  expect(await run('loop_probation_ending')).toMatchObject({status:'ran',companies:1});
  expect((await cards(group,true)).map(card=>card.kind)).toEqual(['probation']);
  await setMandateStopSwitch(group,true);
  expect(await cards(group,true)).toEqual([]);
  await setMandateStopSwitch(group,false);
  // Paused for the company: no run there, and its card is not shown; resumed, it is back.
  await setLoopPause(group,{workerId:'loop_probation_ending',companyId:b.companyId,paused:true});
  expect(await run('loop_probation_ending')).toMatchObject({status:'ran',companies:0});
  expect(await cards(group,true)).toEqual([]);
  // Someone who does not administer the company cannot pause it, in code and in the database.
  await expect(setLoopPause(p,{workerId:'loop_probation_ending',companyId:b.companyId,paused:false})).rejects.toBeInstanceOf(LoopControlRefused);
  await setLoopPause(group,{workerId:'loop_probation_ending',companyId:b.companyId,paused:false});
  expect((await cards(group,true)).map(card=>card.kind)).toEqual(['probation']);
  // Switched off: the open card is no longer shown, and nothing runs.
  await setWorkerSwitch(group,{workerId:'loop_probation_ending',enabled:false});
  expect(await cards(group,true)).toEqual([]);
  expect(await run('loop_probation_ending')).toMatchObject({status:'not_run',reasons:['switched_off']});
 });

 it('stops, with a record, when its sponsor loses administrator access',async()=>{
  const p=await login(b,'Fictional Probationer','employee');
  await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,p.employmentId));
  await on('loop_probation_ending');
  const reader=await login(b,'Fictional Second Administrator','hr_admin');
  await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,group.userId!));
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:group.userId!,companyId:null,role:'employee'});
  expect(await run('loop_probation_ending')).toMatchObject({status:'sponsor_lost'});
  expect(await casesOf('loop_probation_ending',reader)).toEqual([]);
  const [record]=await runsOf('loop_probation_ending',reader);
  expect(record).toMatchObject({status:'sponsor_lost',companyId:null,sponsorUserId:group.userId,opened:0});
  expect(record.checks).toEqual(expect.arrayContaining([expect.objectContaining({check:'sponsor_authority',result:'fail'})]));
  // Every run record is append-only: the application role holds no UPDATE or DELETE on it, not even as the agent.
  const agent=agentContext(b.tenantId,principalId,await entitlements());
  const changed=await withTenant(agent,tx=>tx.update(terasLoopRun).set({opened:9}).where(eq(terasLoopRun.id,record.id))).then(()=>null,(e:unknown)=>e);
  expect(pgText(changed)).toMatch(/permission denied/i);
  const removed=await withTenant(agent,tx=>tx.delete(terasLoopCase)).then(()=>null,(e:unknown)=>e);
  expect(pgText(removed)).toMatch(/permission denied/i);
 });

 it('keeps tenants and companies apart',async()=>{
  // A second company with its own probation and its own HR administrator.
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second Sdn Bhd'}).returning();
  const [dept]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:second.id,name:'Fictional Ops'}).returning();
  const first=await login(b,'Fictional First Probationer','employee');
  const other=await login(b,'Fictional Second Probationer','employee',second.id,dept.id);
  for(const who of [first,other])await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,who.employmentId));
  const scoped=await companyAdmin(b,second.id,dept.id);
  // A second tenant with the loop on and nothing to prepare.
  const b2=await seedBase();
  const group2=await login(b2,'Fictional Other Tenant Administrator','hr_admin');
  const principal2=await ensureAgentPrincipal(owner.db,b2.tenantId);
  await on('loop_probation_ending');await on('loop_probation_ending',group2);
  expect(await run('loop_probation_ending')).toMatchObject({status:'ran',companies:2});
  expect(await run('loop_probation_ending',b2,principal2)).toMatchObject({status:'ran',companies:1,totals:{opened:0}});
  expect((await cards(group,true,[b.companyId,second.id])).map(card=>card.kind==='probation'?card.name:null).sort()).toEqual(['Fictional First Probationer','Fictional Second Probationer']);
  // The company administrator sees only their company's card and figures, even when asked for the other company.
  expect((await cards(scoped,true,[b.companyId,second.id])).map(card=>card.kind==='probation'?card.name:null)).toEqual(['Fictional Second Probationer']);
  expect((await loopsOverview(scoped)).rows.find(row=>row.id==='loop_probation_ending')).toMatchObject({prepared:1,openNow:1});
  expect((await loopsOverview(group)).rows.find(row=>row.id==='loop_probation_ending')).toMatchObject({prepared:2,openNow:2});
  // The other tenant sees none of it.
  expect(await cards(group2,true,[b2.companyId,b.companyId,second.id])).toEqual([]);
  expect(await casesOf('loop_probation_ending',group2)).toEqual([]);
  expect((await loopsOverview(group2)).rows.find(row=>row.id==='loop_probation_ending')).toMatchObject({prepared:0,openNow:0});
  // Employees never read each other's cases, nor HR's.
  expect(await cards(first,false)).toEqual([]);
  expect(await withTenant(first,tx=>tx.select().from(terasLoopCase))).toEqual([]);
 });
});

describe('loop 1: probation ending',()=>{
 it('prepares a confirmation review for HR, never decides, closes on the decision and reopens for a new end date',async()=>{
  const p=await login(b,'Fictional Probationer','employee');
  await owner.db.update(schema.employment).set({probationEndDate:day(10)}).where(eq(schema.employment.id,p.employmentId));
  await on('loop_probation_ending');
  expect(await run('loop_probation_ending')).toMatchObject({status:'ran',companies:1});
  const key=`probation:${p.employmentId}`;
  expect(await caseOf('loop_probation_ending',key)).toMatchObject({state:'open',recipient:'hr',reopenCount:0,facts:{endDate:'2026-07-12',stage:'none',overdue:false}});
  expect(await cards(group,true)).toEqual([{kind:'probation',caseId:expect.any(String),name:'Fictional Probationer',endDate:'2026-07-12',stage:'none',overdue:false,
   href:`/admin/personnel/${p.employmentId}`}]);
  expect(await cards(p,false)).toEqual([]);
  // Nothing was decided or opened for HR: the review is HR's.
  expect(await owner.db.select().from(schema.employmentReview).where(eq(schema.employmentReview.employmentId,p.employmentId))).toEqual([]);
  // HR records the decision on the review; the next run closes the case.
  await owner.db.insert(schema.employmentReview).values({tenantId:b.tenantId,employmentId:p.employmentId,personId:p.personId,reviewType:'probation',status:'completed',
   endDate:'2026-07-12',dueDate:'2026-06-12',decision:'confirm',decidedAt:new Date()});
  expect(await run('loop_probation_ending')).toMatchObject({status:'ran',totals:{closed:1}});
  expect(await caseOf('loop_probation_ending',key)).toMatchObject({state:'closed',closeReason:'done',resolution:'completed',facts:{endDate:'2026-07-12',decision:'confirm'}});
  expect(await cards(group,true)).toEqual([]);
  // A new end date with no decision for it reopens the same case.
  await owner.db.update(schema.employment).set({probationEndDate:day(12)}).where(eq(schema.employment.id,p.employmentId));
  expect(await run('loop_probation_ending')).toMatchObject({status:'ran',totals:{reopened:1,opened:0}});
  expect(await caseOf('loop_probation_ending',key)).toMatchObject({state:'open',reopenCount:1,closeReason:null,facts:{endDate:'2026-07-14',stage:'none'}});
  expect(await casesOf('loop_probation_ending')).toHaveLength(1);
  // The Loops page reads it per role.
  const overview=await loopsOverview(group);
  expect(overview.canSwitch).toBe(true);
  expect(overview.rows.find(row=>row.id==='loop_probation_ending')).toMatchObject({on:true,running:true,level:'prepare',sponsor:{userId:group.userId,name:'Fictional Group Administrator'},
   lastRun:{status:'ran'},prepared:1,confirmed:0,proposesValue:false,correctionRate:null,openNow:1});
  const detail=await loopDetail(group,'loop_probation_ending');
  expect(detail.companies).toEqual([{companyId:b.companyId,companyName:'Acme Sdn Bhd',paused:false}]);
  expect(detail.cases.map(item=>[item.personName,item.state,item.reopenCount])).toEqual([['Fictional Probationer','open',1]]);
  expect(detail.runs.length).toBe(3);
  await expect(loopsOverview(p)).rejects.toBeInstanceOf(LoopViewRefused);
  await expect(loopDetail(group,'not_a_loop')).rejects.toMatchObject({reason:'not_found'});
  const scoped=await companyAdmin(b,b.companyId,b.deptA);
  expect((await loopsOverview(scoped)).canSwitch).toBe(false);
 });
});

describe('loop 2: payroll inputs',()=>{
 it('lists what blocks the run before the cut-off for payroll HR, closes when ready and reopens on a new blocker',async()=>{
  // A company whose salary inputs close on the 5th: the July window ends on Saturday 4 July, two days away.
  const [co]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Payroll Sdn Bhd'}).returning();
  await owner.db.insert(schema.companyPayrollConfig).values({tenantId:b.tenantId,companyId:co.id,cutOffDay:5});
  const p=await login(b,'Fictional Employee','employee');
  await on('loop_payroll_inputs');
  expect(await run('loop_payroll_inputs')).toMatchObject({status:'ran',companies:2});
  const key=`payroll:${co.id}:2026-07`;
  const open=await caseOf('loop_payroll_inputs',key);
  expect(open).toMatchObject({state:'open',recipient:'payroll',employmentId:null,facts:{payPeriod:'2026-07',cutOff:'2026-07-04'}});
  expect(open!.facts.missing).toEqual(expect.arrayContaining(['payrollCycle']));
  expect((open!.facts.missing as string[])[0]).toBe('payrollCycle');
  // The group's own company closes at month end, more than 7 days away: no card for it.
  expect((await casesOf('loop_payroll_inputs')).map(row=>row.companyId)).toEqual([co.id]);
  const card=(await cards(group,true,[b.companyId,co.id])).find(item=>item.kind==='payroll');
  expect(card).toMatchObject({kind:'payroll',companyName:'Fictional Payroll Sdn Bhd',payPeriod:'2026-07',cutOff:'2026-07-04',href:'/payroll/setup?readiness=full'});
  expect(await cards(p,false,[b.companyId,co.id])).toEqual([]);
  // The loop created no payroll configuration of its own.
  expect(await owner.db.select().from(schema.payrollCycle).where(eq(schema.payrollCycle.companyId,co.id))).toEqual([]);
  // Payroll HR adds the active regular cycle; nothing blocks the run any more.
  const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:b.tenantId,companyId:co.id,name:'Monthly',runType:'regular'}).returning();
  expect(await run('loop_payroll_inputs')).toMatchObject({status:'ran',totals:{closed:1}});
  expect(await caseOf('loop_payroll_inputs',key)).toMatchObject({state:'closed',closeReason:'done',resolution:'completed'});
  expect((await cards(group,true,[b.companyId,co.id])).filter(item=>item.kind==='payroll')).toEqual([]);
  // The cycle is archived before the cut-off: the same case reopens.
  await owner.db.update(schema.payrollCycle).set({archivedAt:new Date()}).where(eq(schema.payrollCycle.id,cycle.id));
  expect(await run('loop_payroll_inputs')).toMatchObject({status:'ran',totals:{reopened:1}});
  expect(await caseOf('loop_payroll_inputs',key)).toMatchObject({state:'open',reopenCount:1});
 });
});

describe('loop 3: missing employee data',()=>{
 it('asks the employee for what they can fill in, waits for HR approval, closes when filled and reopens when it goes missing',async()=>{
  const e=await login(b,'Fictional Correction Employee','employee');
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:e.personId,passportNumber:randomUUID(),epfNumber:'EPF',socsoNumber:'SOCSO',taxNumber:'TAX'});
  await on('loop_missing_employee_data');
  expect(await run('loop_missing_employee_data')).toMatchObject({status:'ran'});
  const key=`record:${e.employmentId}`;
  // No compensation is HR's to fill: only the bank account is on the employee's card.
  expect(await caseOf('loop_missing_employee_data',key)).toMatchObject({state:'open',recipient:'employee',facts:{gaps:['no_bank_account'],tabs:['bankStatutory'],pending:0}});
  expect(await cards(e,false)).toEqual([{kind:'record',caseId:expect.any(String),gaps:['no_bank_account'],href:'/me?tab=bankStatutory#section-request-bankStatutory'}]);
  expect((await cards(group,true)).filter(item=>item.kind==='record')).toEqual([]);
  // Nothing changed on the record.
  const [record]=await owner.db.select({bank:schema.employeeStatutoryMy.bankAccountNo}).from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  expect(record.bank).toBeNull();
  // The employee sends the request through the existing flow; the case waits for HR, and the card is gone.
  const request=await requestCurrentProfileChange(e,{employmentId:e.employmentId,proposed:{bankName:requirePackFor('MY').client.bankNames[0],bankAccountNo:'12345678'}});
  expect(await run('loop_missing_employee_data')).toMatchObject({status:'ran'});
  expect(await caseOf('loop_missing_employee_data',key)).toMatchObject({state:'waiting',facts:{gaps:['no_bank_account'],pending:1}});
  expect(await cards(e,false)).toEqual([]);
  // HR approves as usual; the next run closes it.
  await decideProfileChange(adminCtx(b),{requestId:request.requestId,decision:'approved'});
  expect(await run('loop_missing_employee_data')).toMatchObject({status:'ran',totals:{closed:1}});
  expect(await caseOf('loop_missing_employee_data',key)).toMatchObject({state:'closed',closeReason:'done',resolution:'completed'});
  // The account goes missing again: the same case reopens.
  await owner.db.update(schema.employeeStatutoryMy).set({bankAccountNo:null}).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  expect(await run('loop_missing_employee_data')).toMatchObject({status:'ran',totals:{reopened:1}});
  expect(await caseOf('loop_missing_employee_data',key)).toMatchObject({state:'open',reopenCount:1});
 });
});

describe('loop 4: missed clock-outs',()=>{
 it('proposes the roster end to the employee, waits on a sent correction, closes on the clock-out and reopens when it is gone',async()=>{
  const a=adminCtx(b);
  const shift=(await createShift(a,{name:'Fictional Day',code:`DAY${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]})).id;
  const e=await login(b,'Fictional Shift Worker','employee');
  const m=await login(b,'Fictional Line Manager','manager');
  await setReportingLine(a,{subordinateEmploymentId:e.employmentId,managerEmploymentId:m.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
  await assignDefaultShift(a,{employmentId:e.employmentId,shiftId:shift});
  await checkIn(a,{employmentId:e.employmentId,date:YESTERDAY,time:'09:02',manual:true});
  await checkIn(a,{employmentId:e.employmentId,date:TUESDAY,time:'08:55',manual:true});
  await on('loop_missed_clock_outs');
  expect(await run('loop_missed_clock_outs')).toMatchObject({status:'ran',totals:{opened:2}});
  const wed=`clockout:${e.employmentId}:${YESTERDAY}`,tue=`clockout:${e.employmentId}:${TUESDAY}`;
  expect(await caseOf('loop_missed_clock_outs',wed)).toMatchObject({state:'open',recipient:'employee',facts:{date:YESTERDAY,checkIn:'09:02',proposedCheckOut:'18:00',shiftStart:'09:00'}});
  expect((await cards(e,false)).map(card=>card.kind==='clockOut'?[card.date,card.checkIn,card.proposedCheckOut,card.href]:null)).toEqual([
   [TUESDAY,'08:55','18:00','/attendance/my-records/2026-06-30?checkOut=18%3A00'],[YESTERDAY,'09:02','18:00','/attendance/my-records/2026-07-01?checkOut=18%3A00']]);
  expect((await cards(group,true)).filter(card=>card.kind==='clockOut')).toEqual([]);
  expect(await cards(m,false)).toEqual([]);
  // Nothing was written to the attendance record.
  expect((await attendanceForEmploymentRange(a,e.employmentId,TUESDAY,YESTERDAY)).map(row=>row.checkOutAt)).toEqual([null,null]);
  // Tuesday: the employee's correction is sent and waits for the manager; then the manager rejects it and the card returns.
  const {correctionId}=await requestAttendanceCorrection(a,{employmentId:e.employmentId,date:TUESDAY,checkIn:'08:55',checkOut:'18:00',reason:'Fictional: forgot to clock out'});
  await run('loop_missed_clock_outs');
  expect(await caseOf('loop_missed_clock_outs',tue)).toMatchObject({state:'waiting'});
  await decideAttendanceCorrection(m,{correctionId,decision:'rejected',rejectReason:'Fictional: left later'});
  await run('loop_missed_clock_outs');
  expect(await caseOf('loop_missed_clock_outs',tue)).toMatchObject({state:'open',reopenCount:0});
  // Wednesday's clock-out is recorded at the proposed time, Tuesday's at another time.
  await checkOut(a,{employmentId:e.employmentId,date:YESTERDAY,time:'18:00',manual:true});
  await checkOut(a,{employmentId:e.employmentId,date:TUESDAY,time:'19:10',manual:true});
  expect(await run('loop_missed_clock_outs')).toMatchObject({status:'ran',totals:{closed:2}});
  expect(await caseOf('loop_missed_clock_outs',wed)).toMatchObject({state:'closed',closeReason:'done',resolution:'as_prepared'});
  expect(await caseOf('loop_missed_clock_outs',tue)).toMatchObject({state:'closed',closeReason:'done',resolution:'changed',facts:{recordedCheckOut:'19:10'}});
  expect((await loopsOverview(group)).rows.find(row=>row.id==='loop_missed_clock_outs')).toMatchObject({proposesValue:true,confirmed:1,changed:1,correctionRate:0.5});
  // Wednesday's clock-out disappears from the record: the same case reopens.
  await owner.db.update(schema.attendance).set({checkOutAt:null}).where(and(eq(schema.attendance.employmentId,e.employmentId),eq(schema.attendance.attendanceDate,YESTERDAY)));
  expect(await run('loop_missed_clock_outs')).toMatchObject({status:'ran',totals:{reopened:1}});
  expect(await caseOf('loop_missed_clock_outs',wed)).toMatchObject({state:'open',reopenCount:1});
 });
});

describe('loop 5: passports expiring',()=>{
 it('tells HR and reminds the employee within 60 days, closes on renewal and reopens when the expiry moves back',async()=>{
  const e=await login(b,'Fictional Traveller','employee');
  // 40 days out: beyond the follow-up owner's own 30 days, inside the loop's 60.
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:e.personId,passportNumber:randomUUID(),passportExpiryDate:day(40)});
  await on('loop_document_expiry');
  expect(await run('loop_document_expiry')).toMatchObject({status:'ran',totals:{opened:1}});
  const key=`passport:${e.employmentId}`;
  expect(await caseOf('loop_document_expiry',key)).toMatchObject({state:'open',recipient:'employee',facts:{expiresOn:'2026-08-11'}});
  expect(await cards(e,false)).toEqual([{kind:'passport',caseId:expect.any(String),expiresOn:'2026-08-11',href:'/me?tab=profile'}]);
  expect(await cards(group,true)).toEqual([{kind:'passports',count:1,first:'2026-08-11',href:'/personnel'}]);
  // Renewed: the next run closes it, and both cards are gone.
  await owner.db.update(schema.employeeStatutoryMy).set({passportExpiryDate:day(400)}).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  expect(await run('loop_document_expiry')).toMatchObject({status:'ran',totals:{closed:1}});
  expect(await caseOf('loop_document_expiry',key)).toMatchObject({state:'closed',closeReason:'done',resolution:'completed'});
  expect(await cards(e,false)).toEqual([]);expect(await cards(group,true)).toEqual([]);
  // The expiry is corrected back inside the window: the same case reopens.
  await owner.db.update(schema.employeeStatutoryMy).set({passportExpiryDate:day(20)}).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  expect(await run('loop_document_expiry')).toMatchObject({status:'ran',totals:{reopened:1}});
  expect(await caseOf('loop_document_expiry',key)).toMatchObject({state:'open',reopenCount:1,facts:{expiresOn:'2026-07-22'}});
 });
});
