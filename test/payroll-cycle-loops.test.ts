/** AI v2 P2-2a — the Pre-salary loop and the Salary payroll loop, on fictional data (migration 0964, core/loops).
 *
 *  1. Each Pre-salary check, read through its own owner, on a fictional company where every item is known.
 *  2. The Pre-salary loop runs from the start of the period, honours each company's interval, and becomes a Today card in
 *     the last 7 days before the cut-off. Its 15-minute tick runs only that loop, only for companies due, and two ticks
 *     (or a tick and the nightly sweep) never check one company together.
 *  3. The Salary payroll loop prepares every run of the month (salary, bonus and off-cycle) and never runs, approves or
 *     closes one: a person closes it, and only then is it done.
 *  4. The bank file total against net pay, matching and not matching.
 *  5. Net-swing flags at ±15% by default and at each company's own threshold, and the proposal flow: dispositions,
 *     a proposal that never applies itself, an administrator's approval or rejection, recorded, applied from the next run.
 *  6. The group pipeline is filtered to the companies each administrator may see; another tenant sees nothing and can
 *     change nothing, even naming this tenant's company id (pauses, settings and decisions).
 *  7. No model is called (the gateway is replaced by one that counts and refuses).
 * Expected values are written out from the fixtures or read from the payroll service's own stored figures, never
 * re-derived through the loops' helpers. */
import {randomUUID} from 'node:crypto';
import {and,count,eq,inArray} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';

const model=vi.hoisted(()=>({calls:0}));
vi.mock('../lib/ai',async importOriginal=>{
 const original=await importOriginal<typeof import('../lib/ai')>();
 const refuse=async()=>{model.calls++;throw new Error('No model call is allowed in a loop.');};
 return {...original,generateDraft:refuse,converse:refuse,readImage:refuse};
});

import * as schema from '../db/schema';
import {terasLoopCase,terasLoopPause,terasLoopRun} from '../db/teras-schema';
import {terasPayrollLoopSetting,terasPayrollSwingDisposition,terasPayrollThresholdDecision} from '../db/teras-payroll-cycle-schema';
import {payrollAuditFinding} from '../db/payroll-audit-schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee,setEmploymentPaymentMethod} from '../core/org';
import {setCompensation} from '../core/comp';
import {listPayComponents,seedPayComponentCatalog,setEmploymentPayComponent,setPayrollBatchComponent} from '../core/pay-components';
import {upsertCompanyBankProfile} from '../core/bank-profile';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createAdditionalRun,createBatch,generatePayslips,payrollReadiness} from '../packs/payroll/service';
import {thresholdsInForce} from '../core/payroll-anomaly';
import {checkIn,checkOut,requestAttendanceCorrection} from '../core/attendance';
import {assignDefaultShift,createShift} from '../core/roster';
import {ensureAgentPrincipal} from '../core/agent-principal';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {runLoop} from '../core/loops/run';
import {preSalaryTickLockKey,runPreSalaryTick} from '../core/loops/tick';
import {setLoopPause} from '../core/loops/controls';
import {readLoopCards} from '../core/loops/cards';
import {preSalaryChecks} from '../core/loops/pre-salary-checks';
import {preSalaryWindows} from '../core/loops/payroll-inputs';
import {PayrollLoopRefused,decideThresholdProposal,setPayrollLoopSetting} from '../core/loops/payroll-loop-settings';
import {recordSwingDisposition} from '../core/loops/salary-swing-service';
import {PayrollCycleRefused,payrollCycleOverview,payrollLoopSettingsPage,salaryLoopPage} from '../core/loops/payroll-cycle-views';
import type {LoopId} from '../core/loops/types';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

/** The HR day every run is for: Thursday 2 July 2026. Yesterday, Wednesday 1 July, is a working day. June's salary
 * cut-off (the month end: no cut-off day is configured) has passed, so June is the Salary payroll loop's month. */
const TODAY='2026-07-02',YESTERDAY='2026-07-01',MAY='2026-05',JUNE='2026-06',JULY='2026-07';
let b:Base,principalId:string,group:SessionContext,a:SessionContext;

/** A group administrator with no employment of their own, so a fixture company holds only the people a test hires. */
async function groupAdministrator(base:Base):Promise<SessionContext>{
 const userId=await createAppUser(base.tenantId,null,'hr_admin');
 return {...(await entitledCtx(base,['hr_admin'])),userId,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
}
async function companyAdministrator(base:Base,companyId:string):Promise<SessionContext>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`}).returning({id:schema.appUser.id});
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId,role:'hr_admin'});
 return {...(await entitledCtx(base,['hr_admin'])),userId:user.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId}]};
}
async function setup(modules:readonly string[]){
 for(const module of modules)await setModule(b.tenantId,module,'active');
 a=await entitledCtx(b);
 group=await groupAdministrator(b);
 principalId=await ensureAgentPrincipal(owner.db,b.tenantId);
}
const entitlements=async()=>(await entitledCtx(b)).entitlements!;
const run=async(id:LoopId,now?:Date)=>runLoop(id,{tenantId:b.tenantId,principalId,entitlements:await entitlements(),today:TODAY,...(now?{now}:{})});
const on=(id:LoopId)=>setWorkerSwitch(group,{workerId:id,enabled:true});
const casesOf=(id:LoopId)=>withTenant(group,tx=>tx.select().from(terasLoopCase).where(eq(terasLoopCase.workerId,id)));
const caseOf=async(id:LoopId,key:string)=>(await casesOf(id)).find(row=>row.subjectKey===key);
const minutes=(start:Date,n:number)=>new Date(start.getTime()+n*60_000);
let seq=0;
async function hire(name:string,options:Readonly<{hiredOn?:string;basic?:number;statutory?:'full'|'no_bank'|'none';companyId?:string;departmentId?:string}>={}){
 const n=++seq;
 const hired=await hireEmployee(a,{person:{fullName:name,primaryEmail:`fixture-${n}-${randomUUID()}@fixture.test`},companyId:options.companyId??b.companyId,
  departmentId:options.departmentId??b.deptA,employmentType:'full_time',hiredOn:options.hiredOn??'2024-01-01'});
 if(options.basic!==undefined)await setCompensation(a,{employmentId:hired.employmentId,basicSalary:options.basic,effectiveFrom:options.hiredOn??'2024-01-01'});
 if(options.statutory!=='none')await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:hired.personId,icNumber:`9001010112${String(10+n).slice(-2)}`,
  epfNumber:`EPF${n}`,socsoNumber:`SOCSO${n}`,taxNumber:`TAX${n}`,...(options.statutory==='no_bank'?{}:{bankName:'Maybank',bankAccountNo:`1234567890${String(10+n).slice(-2)}`})});
 return hired;
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{model.calls=0;seq=0;await resetDb();b=await seedBase();});
afterEach(()=>{expect(model.calls,'a payroll loop called a model').toBe(0);});

describe('the Pre-salary loop',()=>{
 it('reads each input check through its own owner, on a fictional company where every item is known',async()=>{
  // Leave is a core module: always in use, with no tenant row to set.
  await setup(['payroll','attendance','claims']);
  const shift=(await createShift(a,{name:'Fictional Day',code:`PS${randomUUID().slice(0,4)}`,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]})).id;
  const worker=async(name:string,statutory:'full'|'no_bank'='full')=>{const e=await hire(name,{basic:3000,statutory});await assignDefaultShift(a,{employmentId:e.employmentId,shiftId:shift});return e;};
  const fullDay=async(employmentId:string)=>{await checkIn(a,{employmentId,date:YESTERDAY,time:'09:00',manual:true});await checkOut(a,{employmentId,date:YESTERDAY,time:'18:00',manual:true});};
  // Timesheets: a missed clock-out, an absence with no leave, and a missed clock-out whose correction is waiting.
  const missedOut=await worker('Fictional Missed Out');await checkIn(a,{employmentId:missedOut.employmentId,date:YESTERDAY,time:'09:00',manual:true});
  const absent=await worker('Fictional Absent');
  const correcting=await worker('Fictional Correcting');await checkIn(a,{employmentId:correcting.employmentId,date:YESTERDAY,time:'09:00',manual:true});
  await requestAttendanceCorrection(a,{employmentId:correcting.employmentId,date:YESTERDAY,checkIn:'09:00',checkOut:'18:00',reason:'Fictional: forgot to clock out'});
  // A full day with overtime waiting for approval, leave waiting, approved unpaid leave, a resignation waiting and a pay rise in July.
  const busy=await worker('Fictional Busy');await fullDay(busy.employmentId);
  await owner.db.insert(schema.attendanceCorrection).values({tenantId:b.tenantId,employmentId:busy.employmentId,attendanceDate:YESTERDAY,requestedOtMinutes:120,
   reason:'Fictional overtime',status:'pending',requestKind:'self_overtime'} as never);
  await owner.db.insert(schema.leaveRequest).values([
   {tenantId:b.tenantId,employmentId:busy.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:'2026-07-20',endDate:'2026-07-20',days:'1',status:'pending'},
   {tenantId:b.tenantId,employmentId:busy.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:'2026-07-21',endDate:'2026-07-21',days:'1',status:'approved',unpaidDays:'1'}]);
  await owner.db.insert(schema.resignationRequest).values({tenantId:b.tenantId,employmentId:busy.employmentId,personId:busy.personId,lastWorkingDay:'2026-07-25',status:'pending'});
  await setCompensation(a,{employmentId:busy.employmentId,basicSalary:3300,effectiveFrom:'2026-07-01'});
  // A full day over the monthly overtime cap (104 hours), with no bank account on record.
  const noBank=await worker('Fictional No Bank','no_bank');await fullDay(noBank.employmentId);
  await owner.db.update(schema.attendance).set({otMinutes:105*60}).where(and(eq(schema.attendance.employmentId,noBank.employmentId),eq(schema.attendance.attendanceDate,YESTERDAY)));
  // A leaver whose accepted last day is not recorded on the employment, and a joiner with no salary or statutory record.
  const leaver=await worker('Fictional Leaver');await fullDay(leaver.employmentId);
  await owner.db.insert(schema.resignationRequest).values({tenantId:b.tenantId,employmentId:leaver.employmentId,personId:leaver.personId,lastWorkingDay:'2026-07-15',status:'accepted'});
  await hire('Fictional Joiner',{hiredOn:'2026-07-10',statutory:'none'});
  // Claims: one waiting with no receipt, one draft with no receipt.
  const [type]=await owner.db.insert(schema.claimType).values({tenantId:b.tenantId,code:`RCPT${randomUUID().slice(0,4)}`,name:'Fictional receipt claim',requiresReceipt:true}).returning();
  await owner.db.insert(schema.claimRequest).values([
   {tenantId:b.tenantId,employmentId:missedOut.employmentId,claimTypeId:type.id,amount:'45.00',incurredOn:'2026-06-28',status:'pending'},
   {tenantId:b.tenantId,employmentId:absent.employmentId,claimTypeId:type.id,amount:'12.00',incurredOn:'2026-07-01',status:'draft'}]);
  const windows=preSalaryWindows(null,JULY);
  expect(windows).toEqual({salary:{start:'2026-07-01',end:'2026-07-31'},attendance:{start:'2026-07-01',end:'2026-07-31'},overtime:{start:'2026-07-01',end:'2026-07-31'},
   claim:{start:'2026-07-01',end:'2026-07-31'},leave:{start:'2026-07-01',end:'2026-07-31'}});
  const result=await preSalaryChecks(group,{companyId:b.companyId,payPeriod:JULY,today:TODAY,windows});
  // The payroll readiness owner's own verdict is the set-up check (the joiner has no salary record, there is no cycle).
  const readiness=await payrollReadiness(group,{companyId:b.companyId,payPeriod:JULY});
  expect(readiness.blockers).toBeGreaterThan(0);
  const c=(key:string,status:string,open:number,waiting:number,warnings:number,info:number)=>({key,status,open,waiting,warnings,info});
  expect(result.checks).toEqual([
   // Missed clock-out + absence open; the correction waits for its approver.
   c('timesheets','open',2,1,0,0),
   // The overtime request waits; one person is over 104 hours.
   c('overtime','waiting',0,1,1,0),
   // The leave request waits; the approved unpaid day is context.
   c('leave','waiting',0,1,0,1),
   // Both claims lack a required receipt; one waits; one is still a draft.
   c('claims','open',2,1,1,0),
   // The joiner (no salary record) and the leaver (last day not recorded) are open; the pending resignation waits; one joiner.
   c('joinersLeavers','open',2,1,0,1),
   // No bank account: the no-bank worker and the joiner; the joiner's identity, tax, EPF and SOCSO numbers are missing.
   c('statutoryBank','open',2,0,4,0),
   // The July pay rise is context only; nothing is waiting.
   c('payChanges','done',0,0,0,1),
   c('setup',readiness.blockers>0?'open':readiness.warnings>0?'warning':'done',readiness.blockers,0,readiness.warnings,0),
   // Wave 1 integration: no Audit loop finding yet, so no repeat issue.
   c('repeatAudit','done',0,0,0,0)]);
  expect(result.readiness).toMatchObject({blockers:readiness.blockers,warnings:readiness.warnings});
  // The Audit loop (P2-2b) found a shared bank account in June and in May, and a preparer closing the run in June only: one
  // check repeats in the last audited month (June, before July) and the month before it. A warning, never a blocker.
  const finding=(controlId:'shared_bank_account'|'preparer_closed_run',payPeriod:string)=>({tenantId:b.tenantId,companyId:b.companyId,payPeriod,controlId,
   subjectKey:`test:${controlId}:${payPeriod}`,evidence:{fictional:true},writer:'user' as const,writerId:group.userId!});
  await owner.db.insert(payrollAuditFinding).values([finding('shared_bank_account','2026-06'),finding('shared_bank_account','2026-05'),finding('preparer_closed_run','2026-06')]);
  const again=await preSalaryChecks(group,{companyId:b.companyId,payPeriod:JULY,today:TODAY,windows});
  expect(again.checks.at(-1)).toEqual(c('repeatAudit','warning',0,0,1,0));
  expect(again.checks.slice(0,-1)).toEqual(result.checks.slice(0,-1));
  expect(result.readiness.missing).toEqual(expect.arrayContaining(['payrollCycle','masterData']));
  // Read-only: no record was written by the checks.
  expect(await owner.db.select({n:count()}).from(schema.attendanceCorrection)).toEqual([{n:2}]);
 });

 it('checks from the start of the period at each company\'s interval, and is a Today card only in the last 7 days before the cut-off',async()=>{
  await setup(['payroll']);
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Hourly Sdn Bhd'}).returning();
  await on('loop_payroll_inputs');
  const t0=new Date('2026-07-02T03:00:00Z');
  expect(await run('loop_payroll_inputs',t0)).toMatchObject({status:'ran',companies:2});
  // Both companies' July cases open from the start of the period: neither has a payroll cycle (a set-up blocker).
  const key=`payroll:${b.companyId}:${JULY}`;
  expect(await caseOf('loop_payroll_inputs',key)).toMatchObject({state:'open',recipient:'payroll',facts:{payPeriod:JULY,cutOff:'2026-07-31',from:'2026-07-01',blocking:['setup']}});
  // Daily by default: half an hour later neither is due, and nothing is recorded.
  expect(await run('loop_payroll_inputs',minutes(t0,30))).toMatchObject({status:'ran',companies:0});
  // The second company checks hourly from now on (an administrator's own change, recorded with its version).
  await expect(setPayrollLoopSetting(await companyAdministrator(b,b.companyId),{companyId:second.id,interval:'hourly'})).rejects.toMatchObject({reason:'not_administrator'});
  await expect(setPayrollLoopSetting(group,{companyId:second.id,interval:'every_minute'})).rejects.toMatchObject({reason:'invalid'});
  expect(await setPayrollLoopSetting(group,{companyId:second.id,interval:'hourly'})).toMatchObject({version:1,checkInterval:'hourly',swingThresholdBp:1500,source:'admin'});
  expect(await run('loop_payroll_inputs',minutes(t0,50))).toMatchObject({status:'ran',companies:0});
  expect(await run('loop_payroll_inputs',minutes(t0,61))).toMatchObject({status:'ran',companies:1});
  // Twice a day for the group's own company: due 12 hours after its last check, not before.
  await setPayrollLoopSetting(group,{companyId:b.companyId,interval:'twice_daily'});
  expect(await run('loop_payroll_inputs',minutes(t0,11*60))).toMatchObject({status:'ran',companies:1});
  expect(await run('loop_payroll_inputs',minutes(t0,12*60))).toMatchObject({status:'ran',companies:2});
  const runs=await withTenant(group,tx=>tx.select({companyId:terasLoopRun.companyId,n:count()}).from(terasLoopRun)
   .where(and(eq(terasLoopRun.workerId,'loop_payroll_inputs'),eq(terasLoopRun.status,'ran'))).groupBy(terasLoopRun.companyId));
  expect(Object.fromEntries(runs.map(row=>[row.companyId,Number(row.n)]))).toEqual({[b.companyId]:2,[second.id]:4});
  // The case is a Today card only in the last 7 days before the 31 July cut-off.
  expect((await readLoopCards(group,{scopeIds:[b.companyId],admin:true,today:TODAY})).filter(card=>card.kind==='payroll')).toEqual([]);
  expect((await readLoopCards(group,{scopeIds:[b.companyId],admin:true,today:'2026-07-25'})).filter(card=>card.kind==='payroll')).toEqual([
   {kind:'payroll',caseId:(await caseOf('loop_payroll_inputs',key))!.id,companyName:'Acme Sdn Bhd',payPeriod:JULY,cutOff:'2026-07-31',missing:expect.arrayContaining(['payrollCycle']),
    checks:[],blockers:expect.any(Number),href:`/control-tower/loops/payroll-cycle?company=${b.companyId}&period=${JULY}`}]);
  // Every change is versioned and attributed.
  expect((await withTenant(group,tx=>tx.select().from(terasPayrollLoopSetting).where(eq(terasPayrollLoopSetting.companyId,second.id)))).map(row=>[row.version,row.checkInterval,row.changedByUserId]))
   .toEqual([[1,'hourly',group.userId]]);
 });
 it('ticks every 15 minutes: only the Pre-salary loop, only for companies due, and never two runs on one company together',async()=>{
  await setup(['payroll']);
  const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Hourly Sdn Bhd'}).returning();
  await on('loop_payroll_inputs');await on('loop_salary_payroll');
  await setPayrollLoopSetting(group,{companyId:second.id,interval:'hourly'});
  const ents=await entitlements(),t0=new Date('2026-07-02T03:00:00Z');
  const tick=(now:Date)=>runPreSalaryTick(owner.client,{tenantId:b.tenantId,principalId,entitlements:ents,today:TODAY,now});
  const ranFor=async(workerId:LoopId)=>Object.fromEntries((await withTenant(group,tx=>tx.select({companyId:terasLoopRun.companyId,n:count()}).from(terasLoopRun)
   .where(and(eq(terasLoopRun.workerId,workerId),eq(terasLoopRun.status,'ran'))).groupBy(terasLoopRun.companyId))).map(row=>[row.companyId,Number(row.n)]));
  // Due: both companies at first; 15 minutes later neither; an hour later only the hourly company; a day later both.
  expect(await tick(t0)).toMatchObject({workerId:'loop_payroll_inputs',status:'ran',companies:2});
  expect(await tick(minutes(t0,15))).toMatchObject({status:'ran',companies:0});
  expect(await tick(minutes(t0,45))).toMatchObject({status:'ran',companies:0});
  expect(await tick(minutes(t0,60))).toMatchObject({status:'ran',companies:1});
  expect(await ranFor('loop_payroll_inputs')).toEqual({[b.companyId]:1,[second.id]:2});
  // The tick runs no other loop, even one that is switched on.
  expect(await ranFor('loop_salary_payroll')).toEqual({});
  // A tick still running for the tenant (its lock held): the next one skips the tenant and writes nothing.
  const held=await owner.client.reserve();
  try{
   await held`select pg_advisory_lock(hashtextextended(${preSalaryTickLockKey(b.tenantId)},0))`;
   expect(await tick(minutes(t0,24*60))).toEqual({workerId:'loop_payroll_inputs',status:'busy'});
   expect(await ranFor('loop_payroll_inputs')).toEqual({[b.companyId]:1,[second.id]:2});
  }finally{await held`select pg_advisory_unlock(hashtextextended(${preSalaryTickLockKey(b.tenantId)},0))`;held.release();}
  // A tick and the nightly sweep at once: each due company is checked once, by whichever writes first; the other writes nothing.
  const both=await Promise.all([tick(minutes(t0,25*60)),run('loop_payroll_inputs',minutes(t0,25*60))]);
  expect(both.map(result=>result.status)).toEqual(['ran','ran']);
  expect(both.reduce((sum,result)=>sum+(result.status==='ran'?result.companies:0),0)).toBe(2);
  expect(await ranFor('loop_payroll_inputs')).toEqual({[b.companyId]:2,[second.id]:3});
  // Two ticks at once: one checks, the other skips the tenant or finds nothing due.
  const pair=await Promise.all([tick(minutes(t0,50*60)),tick(minutes(t0,50*60))]);
  expect(pair.reduce((sum,result)=>sum+(result.status==='ran'?result.companies:0),0)).toBe(2);
  expect(await ranFor('loop_payroll_inputs')).toEqual({[b.companyId]:3,[second.id]:4});
 });
});

/** Seven fictional people paid by bank in May and June: five with a new housing allowance in June (one pay component,
 * so one pattern), one unchanged, one with a June bonus run. */
async function payrollFixture(){
 await seedPayComponentCatalog(a);
 const housing=(await listPayComponents(a,{includeArchived:true})).find(component=>component.code==='HOUSING')!;
 const people=[];
 for(const [i,name] of ['FICTIONAL RAISE ONE','FICTIONAL RAISE TWO','FICTIONAL RAISE THREE','FICTIONAL RAISE FOUR','FICTIONAL RAISE FIVE','FICTIONAL STEADY','FICTIONAL BONUS'].entries()){
  const e=await hireEmployee(a,{person:{fullName:name,primaryEmail:`salary-${i}-${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
  await setCompensation(a,{employmentId:e.employmentId,basicSalary:3000,effectiveFrom:'2024-01-01'});
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:`90010101${String(1230+i)}`,epfNumber:`12345${i}`,bankName:'Maybank',bankAccountNo:`12345678${String(9000+i)}`});
  await setEmploymentPaymentMethod(a,{employmentId:e.employmentId,paymentMethod:'bank_transfer'});
  people.push(e);
 }
 const may=(await createBatch(a,{companyId:b.companyId,payPeriod:MAY})).batchId;await generatePayslips(a,{batchId:may});await closeBatch(a,{batchId:may});
 for(const [i,amount] of [1000,1100,1200,1300,1400].entries())await setEmploymentPayComponent(a,{employmentId:people[i].employmentId,componentId:housing.id,amount,effectiveFrom:'2026-06-01'});
 const june=(await createBatch(a,{companyId:b.companyId,payPeriod:JUNE})).batchId;await generatePayslips(a,{batchId:june});
 const bonus=(await createAdditionalRun(a,{companyId:b.companyId,payPeriod:JUNE,runType:'bonus'})).batchId;
 // With typed pay items in use (the housing allowance is one), a bonus run pays the catalogue's BONUS item for the run.
 const bonusItem=(await listPayComponents(a,{includeArchived:true})).find(component=>component.code==='BONUS')!;
 await setPayrollBatchComponent(a,{batchId:bonus,employmentId:people[6].employmentId,componentId:bonusItem.id,amount:2000});
 await generatePayslips(a,{batchId:bonus});
 const offCycle=(await createAdditionalRun(a,{companyId:b.companyId,payPeriod:JUNE,runType:'off_cycle'})).batchId;
 await upsertCompanyBankProfile(a,{companyId:b.companyId,bank:'ocbc_bank',corporateId:'A999999',debitAccountNo:'1234567890',orgName:'FICTIONAL COMPANY',branch:'00701',
  fileContactName:'FICTIONAL CONTACT',fileContactPhone:'0312345678',fileStateCode:'014'});
 // Each person's swing, from the payroll service's own stored net pay: June's runs together against May.
 const slips=await owner.db.select({employmentId:schema.payslip.employmentId,batchId:schema.payslip.batchId,net:schema.payslip.netPay}).from(schema.payslip)
  .where(inArray(schema.payslip.batchId,[may,june,bonus]));
 const net=(employmentId:string,batches:string[])=>slips.filter(slip=>slip.employmentId===employmentId&&batches.includes(slip.batchId)).reduce((sum,slip)=>sum+Number(slip.net),0);
 const swing=Object.fromEntries(people.map(e=>{const before=net(e.employmentId,[may]),after=net(e.employmentId,[june,bonus]);
  return [e.employmentId,Math.round(Math.abs(Math.round((after-before)*100)/100)*10_000/before)];}));
 return {people,may,june,bonus,offCycle,swing,housing};
}
const snapshot=async()=>({
 batches:(await owner.db.select({id:schema.payrollBatch.id,status:schema.payrollBatch.status,closedAt:schema.payrollBatch.closedAt,totals:schema.payrollBatch.totals})
  .from(schema.payrollBatch).where(eq(schema.payrollBatch.tenantId,b.tenantId)).orderBy(schema.payrollBatch.id)),
 payslips:await owner.db.select({n:count()}).from(schema.payslip).where(eq(schema.payslip.tenantId,b.tenantId)),
 history:await owner.db.select({n:count()}).from(schema.payrollStatusHistory).where(eq(schema.payrollStatusHistory.tenantId,b.tenantId)),
 files:await owner.db.select({n:count()}).from(schema.bankPaymentExport).where(eq(schema.bankPaymentExport.tenantId,b.tenantId)),
 closed:await owner.db.select({n:count()}).from(schema.domainEvent).where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'payroll-batch.closed'))),
});

describe('the Salary payroll loop',()=>{
 it('prepares every run of the month, salary, bonus and off-cycle, and never runs, approves or closes one',async()=>{
  await setup(['payroll','multi_cycle_payroll','typed_pay_components']);
  const fx=await payrollFixture();
  const before=await snapshot();
  await on('loop_salary_payroll');
  expect(await run('loop_salary_payroll')).toMatchObject({status:'ran',companies:1});
  // One case per June run, for payroll administrators; the regular run exists, so no start card; May is past.
  const runs=(await casesOf('loop_salary_payroll')).filter(row=>row.subjectKey.startsWith('salaryrun:'));
  expect(runs.map(row=>row.subjectKey).sort()).toEqual([fx.june,fx.bonus,fx.offCycle].map(id=>`salaryrun:${id}`).sort());
  for(const row of runs)expect(row).toMatchObject({state:'open',recipient:'payroll',employmentId:null});
  const facts=(id:string)=>runs.find(row=>row.subjectKey===`salaryrun:${id}`)!.facts;
  expect(facts(fx.june)).toMatchObject({payPeriod:JUNE,runType:'regular',runSeq:1,status:'processed',stale:false,employees:7,detectors:11,bank:'match'});
  expect(facts(fx.bonus)).toMatchObject({payPeriod:JUNE,runType:'bonus',runSeq:2,status:'processed',employees:1,bank:'match'});
  expect(facts(fx.offCycle)).toMatchObject({payPeriod:JUNE,runType:'off_cycle',runSeq:3,status:'draft',bank:'not_ready'});
  // The statutory rule version the run stamped is the one in force: nothing newer.
  const [slip]=await owner.db.select({statutory:schema.payslip.statutory}).from(schema.payslip).where(eq(schema.payslip.batchId,fx.june)).limit(1);
  expect(facts(fx.june)).toMatchObject({ruleVersion:(slip.statutory as {version:string}).version,rulesNewer:[]});
  expect(await caseOf('loop_salary_payroll',`salarystart:${b.companyId}:${JUNE}`)).toBeUndefined();
  // Nothing was created, processed, approved, closed or generated by the loop, however often it runs.
  await run('loop_salary_payroll');await run('loop_salary_payroll');
  expect(await snapshot()).toEqual(before);
  // A person closes the June salary run; on the next run it is done (closed and the bank file matches). The bonus run is not.
  const [officer]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:`user_${randomUUID()}`,
   personId:(await hireEmployee(a,{person:{fullName:'Fictional Payroll Officer',primaryEmail:`officer-${randomUUID()}@fixture.test`},companyId:b.companyId,departmentId:b.deptB,
    employmentType:'full_time',hiredOn:'2026-07-15'})).personId}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:officer.id,companyId:null,role:'hr_admin'});
  await closeBatch({...a,userId:officer.id},{batchId:fx.june});
  expect(await run('loop_salary_payroll')).toMatchObject({status:'ran',totals:{closed:1}});
  expect(await caseOf('loop_salary_payroll',`salaryrun:${fx.june}`)).toMatchObject({state:'closed',closeReason:'done',resolution:'completed',facts:{status:'closed'}});
  expect(await caseOf('loop_salary_payroll',`salaryrun:${fx.bonus}`)).toMatchObject({state:'open'});
  const page=await salaryLoopPage(group,{period:JUNE,today:TODAY});
  expect(page.companies.find(c=>c.companyId===b.companyId)!.runs.map(r=>[r.runType,r.status,r.done,r.closedBy])).toEqual([
   ['regular','closed',true,'Fictional Payroll Officer'],['bonus','processed',false,null],['off_cycle','draft',false,null]]);
  // A July with no run yet, after its cut-off, is prepared for HR to start, never started by the loop.
  const later=await runLoop('loop_salary_payroll',{tenantId:b.tenantId,principalId,entitlements:await entitlements(),today:'2026-08-02'});
  expect(later).toMatchObject({status:'ran'});
  expect(await caseOf('loop_salary_payroll',`salarystart:${b.companyId}:${JULY}`)).toMatchObject({state:'open',recipient:'payroll',facts:{payPeriod:JULY,cutOff:'2026-07-31'}});
  expect(await owner.db.select({n:count()}).from(schema.payrollBatch).where(and(eq(schema.payrollBatch.tenantId,b.tenantId),eq(schema.payrollBatch.payPeriod,JULY)))).toEqual([{n:0}]);
 });

 it('checks the bank file total against net pay and the headcount, and says when they do not match',async()=>{
  await setup(['payroll','multi_cycle_payroll','typed_pay_components']);
  const fx=await payrollFixture();
  await on('loop_salary_payroll');
  await run('loop_salary_payroll');
  const bank=async()=>(await caseOf('loop_salary_payroll',`salaryrun:${fx.june}`))!.facts.bank;
  expect(await bank()).toBe('match');
  // A payslip's net pay no longer adds up to the run's recorded net total: the file's total does not match.
  const [slip]=await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,fx.june),eq(schema.payslip.employmentId,fx.people[5].employmentId)));
  await owner.db.update(schema.payslip).set({netPay:(Number(slip.netPay)+1).toFixed(2)}).where(eq(schema.payslip.id,slip.id));
  await run('loop_salary_payroll');
  expect(await bank()).toBe('total_mismatch');
  await owner.db.update(schema.payslip).set({netPay:slip.netPay}).where(eq(schema.payslip.id,slip.id));
  // The run's recorded headcount no longer matches its payslips.
  await owner.db.update(schema.payrollBatch).set({employeeCount:8}).where(eq(schema.payrollBatch.id,fx.june));
  await run('loop_salary_payroll');
  expect(await bank()).toBe('count_mismatch');
  await owner.db.update(schema.payrollBatch).set({employeeCount:7}).where(eq(schema.payrollBatch.id,fx.june));
  await run('loop_salary_payroll');
  expect(await bank()).toBe('match');
  // Someone with no payment method makes the bank file impossible to produce; no bank account means nothing to check.
  await owner.db.update(schema.employment).set({paymentMethod:null}).where(eq(schema.employment.id,fx.people[5].employmentId));
  await run('loop_salary_payroll');
  expect(await bank()).toBe('blocked');
  await owner.db.update(schema.employment).set({paymentMethod:'bank_transfer'}).where(eq(schema.employment.id,fx.people[5].employmentId));
  await owner.db.delete(schema.companyBankProfile).where(eq(schema.companyBankProfile.companyId,b.companyId));
  await run('loop_salary_payroll');
  expect(await bank()).toBe('not_available');
  // No bank file was ever generated.
  expect(await owner.db.select({n:count()}).from(schema.bankPaymentExport)).toEqual([{n:0}]);
 });

 it('flags net-pay swings over ±15%, at each company\'s own threshold, and learns from payroll HR\'s dispositions through an administrator',async()=>{
  await setup(['payroll','multi_cycle_payroll','typed_pay_components']);
  const fx=await payrollFixture();
  const [raises,steady,bonusPerson]=[fx.people.slice(0,5),fx.people[5],fx.people[6]];
  const flagged=fx.people.filter(e=>fx.swing[e.employmentId]>1500).map(e=>e.employmentId).sort();
  // Every new housing allowance (1,000–1,400 on 3,000) and the 2,000 bonus moves net pay by more than 15%; the steady pay does not.
  expect(flagged).toEqual([...raises,bonusPerson].map(e=>e.employmentId).sort());
  expect(fx.swing[steady.employmentId]).toBe(0);
  const thresholds=await thresholdsInForce(group,{batchId:fx.june});
  await on('loop_salary_payroll');
  await run('loop_salary_payroll');
  const swings=async()=>(await casesOf('loop_salary_payroll')).filter(row=>row.subjectKey.startsWith('swing:'));
  expect((await swings()).map(row=>row.employmentId).sort()).toEqual(flagged);
  for(const row of await swings())expect(row).toMatchObject({state:'open',recipient:'hr',subjectKey:`swing:${row.employmentId}:${JUNE}`,
   facts:{payPeriod:JUNE,swingBp:fx.swing[row.employmentId!],direction:'up',thresholdBp:1500}});
  const pattern=(employmentId:string)=>String(swingsNow.find(row=>row.employmentId===employmentId)!.facts.pattern);
  let swingsNow=await swings();
  // The five housing allowances share one pattern, keyed on the pay component's id (never its name).
  const raisePattern=pattern(raises[0].employmentId);
  expect(raisePattern).toBe(`item:${fx.housing.id}`);
  for(const e of raises)expect(pattern(e.employmentId)).toBe(raisePattern);
  expect(pattern(bonusPerson.employmentId)).not.toBe(raisePattern);
  // The change against last month is explained by cause on the run's case.
  expect((await caseOf('loop_salary_payroll',`salaryrun:${fx.june}`))!.facts).toMatchObject({changed:6,flagged:6,thresholdBp:1500});
  // At the company's own threshold above every swing, the flags no longer apply; back at 15%, the same flags reopen.
  const above=Math.min(10_000,Math.ceil((Math.max(...Object.values(fx.swing))+1)/100)*100);
  await setPayrollLoopSetting(group,{companyId:b.companyId,thresholdBp:above});
  await run('loop_salary_payroll');
  expect((await swings()).map(row=>[row.state,row.closeReason])).toEqual(flagged.map(()=>['closed','superseded']));
  await setPayrollLoopSetting(group,{companyId:b.companyId,thresholdBp:1500});
  expect(await run('loop_salary_payroll')).toMatchObject({totals:{reopened:6}});
  swingsNow=await swings();
  // Payroll HR records each flag: the housing allowances were expected, the bonus a real problem. Nobody else may.
  const caseFor=(employmentId:string)=>swingsNow.find(row=>row.employmentId===employmentId)!.id;
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Sdn Bhd'}).returning();
  await expect(recordSwingDisposition(await companyAdministrator(b,other.id),{caseId:caseFor(raises[0].employmentId),disposition:'expected'})).rejects.toMatchObject({reason:'not_found'});
  await expect(recordSwingDisposition({...(await entitledCtx(b,['employee'])),userId:await createAppUser(b.tenantId,null,'employee'),roles:['employee'],grants:[{role:'employee',companyId:null}]},
   {caseId:caseFor(raises[0].employmentId),disposition:'expected'})).rejects.toBeInstanceOf(PayrollLoopRefused);
  for(const e of raises)await recordSwingDisposition(group,{caseId:caseFor(e.employmentId),disposition:'expected'});
  await recordSwingDisposition(group,{caseId:caseFor(bonusPerson.employmentId),disposition:'problem'});
  await expect(recordSwingDisposition(group,{caseId:caseFor(bonusPerson.employmentId),disposition:'expected'})).rejects.toMatchObject({reason:'already'});
  expect((await withTenant(group,tx=>tx.select().from(terasPayrollSwingDisposition))).map(row=>[row.employmentId,row.disposition,row.pattern,row.swingBp,row.decidedByUserId]).sort())
   .toEqual([...raises.map(e=>[e.employmentId,'expected',raisePattern,fx.swing[e.employmentId],group.userId]),
    [bonusPerson.employmentId,'problem',pattern(bonusPerson.employmentId),fx.swing[bonusPerson.employmentId],group.userId]].sort());
  // The next run closes the decided flags.
  await run('loop_salary_payroll');
  expect((await swings()).map(row=>[row.state,row.closeReason,row.resolution])).toEqual(flagged.map(()=>['closed','done','completed']));
  // Proposals: 5 of 5 flags of the housing pattern expected (an exclusion), and 5 of 6 flags expected (a higher threshold),
  // worked here from the stored swings: 80% of the expected swings fall at or below the 4th smallest, rounded up to a whole
  // percentage, never at or above the bonus swing payroll HR called a problem, never above 50%.
  const expectedSwings=raises.map(e=>fx.swing[e.employmentId]).sort((x,y)=>x-y);
  const to=Math.min(Math.ceil(expectedSwings[3]/100)*100,Math.floor((fx.swing[bonusPerson.employmentId]-1)/100)*100,5000);
  const proposals=()=>payrollLoopSettingsPage(group).then(view=>view.companies.find(c=>c.companyId===b.companyId)!);
  let view=await proposals();
  expect(view.setting).toMatchObject({thresholdBp:1500,exclusions:[],version:2});
  expect(view.proposals.map(p=>[p.kind,p.fromThresholdBp,p.toThresholdBp,p.pattern,p.evidence.flags,p.evidence.expected,p.evidence.problems])).toEqual([
   ['exclusion',1500,null,raisePattern,5,5,0],...(to>1500?[['threshold',1500,to,null,6,5,1]]:[])]);
  // Never applied by itself: another run changes nothing in the settings, and the flags stay as they were.
  await run('loop_salary_payroll');
  expect((await proposals()).setting).toMatchObject({version:2,exclusions:[]});
  // Only an administrator of the company decides.
  const exclusion=view.proposals.find(p=>p.kind==='exclusion')!;
  await expect(decideThresholdProposal(await companyAdministrator(b,other.id),{companyId:b.companyId,proposalKey:exclusion.key,decision:'approved'})).rejects.toMatchObject({reason:'not_administrator'});
  const approved=await decideThresholdProposal(group,{companyId:b.companyId,proposalKey:exclusion.key,decision:'approved'});
  expect(approved.setting).toMatchObject({version:3,source:'proposal',swingThresholdBp:1500,swingExclusions:[raisePattern],decisionId:approved.decision.id,changedByUserId:group.userId});
  expect(approved.decision).toMatchObject({kind:'exclusion',pattern:raisePattern,decision:'approved',decidedByUserId:group.userId,evidence:{flags:5,expected:5,problems:0}});
  await expect(decideThresholdProposal(group,{companyId:b.companyId,proposalKey:exclusion.key,decision:'approved'})).rejects.toMatchObject({reason:'changed'});
  view=await proposals();
  if(to>1500){
   const threshold=view.proposals.find(p=>p.kind==='threshold')!;
   await decideThresholdProposal(group,{companyId:b.companyId,proposalKey:threshold.key,decision:'rejected'});
   expect((await proposals()).proposals).toEqual([]);
  }
  expect((await withTenant(group,tx=>tx.select().from(terasPayrollThresholdDecision))).map(row=>[row.kind,row.decision]).sort())
   .toEqual([['exclusion','approved'],...(to>1500?[['threshold','rejected']]:[])].sort());
  const events=await owner.db.select({type:schema.domainEvent.eventType,actorId:schema.domainEvent.actorId}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.tenantId,b.tenantId),inArray(schema.domainEvent.eventType,['teras-payroll-loop.setting-changed','teras-payroll-loop.proposal-decided','teras-payroll-loop.swing-disposed'])));
  expect(events.filter(e=>e.type==='teras-payroll-loop.swing-disposed')).toHaveLength(6);
  expect(events.filter(e=>e.type==='teras-payroll-loop.setting-changed')).toHaveLength(3);
  expect(events.filter(e=>e.type==='teras-payroll-loop.proposal-decided')).toHaveLength(to>1500?2:1);
  for(const e of events)expect(e.actorId).toBe(group.userId);
  // Applied from the next run: the housing pattern no longer flags; the bonus still does. The anomaly detectors are untouched.
  await run('loop_salary_payroll');
  expect((await caseOf('loop_salary_payroll',`salaryrun:${fx.june}`))!.facts).toMatchObject({changed:6,flagged:1});
  expect(await thresholdsInForce(group,{batchId:fx.june})).toEqual(thresholds);
  // Renaming the component re-keys nothing: the same flags, the same exclusion and decisions, shown under the new name.
  const keys=async()=>(await swings()).map(row=>[row.subjectKey,row.facts.pattern]).sort();
  const learned=await keys();
  await owner.db.update(schema.payComponent).set({name:'Fictional Housing Support'}).where(eq(schema.payComponent.id,fx.housing.id));
  await run('loop_salary_payroll');
  expect(await keys()).toEqual(learned);
  expect((await caseOf('loop_salary_payroll',`salaryrun:${fx.june}`))!.facts).toMatchObject({changed:6,flagged:1});
  const renamed=await payrollLoopSettingsPage(group);
  expect(renamed.companies.find(c=>c.companyId===b.companyId)!.setting.exclusions).toEqual([raisePattern]);
  expect(renamed.patternNames[raisePattern]).toBe('Fictional Housing Support');
  expect((await withTenant(group,tx=>tx.select().from(terasPayrollSwingDisposition))).filter(row=>row.pattern===raisePattern)).toHaveLength(5);
  expect((await salaryLoopPage(group,{period:JUNE,today:TODAY})).patternNames).toMatchObject({[raisePattern]:'Fictional Housing Support'});
 });
});

describe('the group pipeline and isolation',()=>{
 it('shows each administrator only the companies they administer, refuses everyone else, and shows another tenant nothing',async()=>{
  await setup(['payroll','multi_cycle_payroll','typed_pay_components']);
  const fx=await payrollFixture();
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Branch Sdn Bhd'}).returning();
  await on('loop_payroll_inputs');await on('loop_salary_payroll');
  await run('loop_payroll_inputs');await run('loop_salary_payroll');
  const pipeline=await payrollCycleOverview(group,{period:JUNE,today:TODAY});
  expect(pipeline.allowed.map(c=>c.companyName)).toEqual(['Acme Sdn Bhd','Fictional Branch Sdn Bhd']);
  expect(pipeline.loops).toEqual({preSalary:{on:true,stopped:false},salary:{on:true,stopped:false}});
  const acme=pipeline.companies.find(c=>c.companyId===b.companyId)!;
  expect(acme.salary).toMatchObject({state:'in_progress',cutOff:'2026-06-30'});
  expect(acme.salary.runs.map(r=>[r.runType,r.status,r.bank])).toEqual([['regular','processed','match'],['bonus','processed','match'],['off_cycle','draft','not_ready']]);
  // Wave 1 integration: the Audit loop's column is P2-2b's summary for the same month, never a company outside the view.
  expect(pipeline.audit).toMatchObject({payPeriod:JUNE,level:'prepare'});
  for(const item of pipeline.audit!.companies)expect(pipeline.companies.map(c=>c.companyId)).toContain(item.companyId);
  expect(pipeline.statutoryDue).toBe('2026-07-15');
  // July: the Pre-salary loop's case for each company, open on its set-up blocker.
  const july=await payrollCycleOverview(group,{period:JULY,today:TODAY});
  expect(july.companies.map(c=>[c.companyName,c.preSalary.state,c.preSalary.daysToCutOff,c.preSalary.interval,c.salary.state])).toEqual([
   ['Acme Sdn Bhd','open',29,'daily','before_cut_off'],['Fictional Branch Sdn Bhd','open',29,'daily','before_cut_off']]);
  expect(july.history.map(h=>h.period)).toEqual([JUNE,MAY,'2026-04']);
  expect(july.history[0]).toMatchObject({period:JUNE,closedOn:null,allClosed:false,runs:3,correctionsAfter:0,issuesCaught:expect.any(Number)});
  expect(july.history[1]).toMatchObject({period:MAY,allClosed:true,runs:1});
  // An administrator of the branch only: the branch, and nothing of the group company's runs or flags.
  const branch=await companyAdministrator(b,other.id);
  const own=await payrollCycleOverview(branch,{period:JUNE,today:TODAY});
  expect(own.allowed.map(c=>c.companyName)).toEqual(['Fictional Branch Sdn Bhd']);
  expect(own.companies.map(c=>[c.companyName,c.salary.runs.length])).toEqual([['Fictional Branch Sdn Bhd',0]]);
  expect((own.audit?.companies??[]).map(c=>c.companyId)).not.toContain(b.companyId);
  expect((await payrollCycleOverview(branch,{period:JUNE,companyId:b.companyId,today:TODAY})).companies.map(c=>c.companyName)).toEqual(['Fictional Branch Sdn Bhd']);
  expect((await salaryLoopPage(branch,{period:JUNE,today:TODAY})).flags).toEqual([]);
  // The branch employs nobody, so it has no salary run to start; and the group company's runs and flags are not its to read.
  expect((await withTenant(branch,tx=>tx.select().from(terasLoopCase).where(eq(terasLoopCase.workerId,'loop_salary_payroll'))))).toEqual([]);
  // The group administrator sees the group company's flags, by name, and filters to one company.
  const groupPage=await salaryLoopPage(group,{period:JUNE,companyId:b.companyId,today:TODAY});
  expect(groupPage.companies.map(c=>c.companyName)).toEqual(['Acme Sdn Bhd']);
  expect(groupPage.flags.map(f=>f.personName).sort()).toEqual(['FICTIONAL BONUS','FICTIONAL RAISE FIVE','FICTIONAL RAISE FOUR','FICTIONAL RAISE ONE','FICTIONAL RAISE THREE','FICTIONAL RAISE TWO']);
  expect(groupPage.flags.map(f=>f.swingBp).sort((x,y)=>x-y)).toEqual(Object.values(fx.swing).filter(bp=>bp>1500).sort((x,y)=>x-y));
  // Anyone who is not an administrator is refused before any read.
  const employee:SessionContext={...(await entitledCtx(b,['employee'])),userId:await createAppUser(b.tenantId,null,'employee'),roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await expect(payrollCycleOverview(employee)).rejects.toBeInstanceOf(PayrollCycleRefused);
  await expect(salaryLoopPage(employee)).rejects.toBeInstanceOf(PayrollCycleRefused);
  await expect(payrollLoopSettingsPage(employee)).rejects.toBeInstanceOf(PayrollCycleRefused);
  // Another tenant: its administrator's pipeline holds its own company only, and none of these rows.
  await setPayrollLoopSetting(group,{companyId:b.companyId,thresholdBp:2000});
  const second=await seedBase();
  const outsider=adminCtx(second);
  const theirs=await payrollCycleOverview(outsider,{period:JUNE,today:TODAY});
  expect(theirs.allowed.map(c=>c.companyId)).toEqual([second.companyId]);
  expect(await withTenant(outsider,tx=>tx.select().from(terasLoopCase))).toEqual([]);
  expect(await withTenant(outsider,tx=>tx.select().from(terasPayrollLoopSetting))).toEqual([]);
  expect(await withTenant(outsider,tx=>tx.select().from(terasPayrollSwingDisposition))).toEqual([]);
  await expect(setPayrollLoopSetting(outsider,{companyId:b.companyId,thresholdBp:3000})).rejects.toMatchObject({reason:'not_administrator'});
  await expect(decideThresholdProposal(outsider,{companyId:b.companyId,proposalKey:'a'.repeat(64),decision:'approved'})).rejects.toMatchObject({reason:'not_administrator'});
  // Nor pause a loop for this tenant's company (core/loops/controls.ts checks the company is the caller's tenant's first).
  await expect(setLoopPause(outsider,{workerId:'loop_salary_payroll',companyId:b.companyId,paused:true})).rejects.toMatchObject({reason:'not_administrator'});
  await setLoopPause(group,{workerId:'loop_salary_payroll',companyId:b.companyId,paused:true});
  expect((await withTenant(group,tx=>tx.select().from(terasLoopPause))).map(row=>[row.tenantId,row.companyId,row.changedByUserId])).toEqual([[b.tenantId,b.companyId,group.userId]]);
 });
});

