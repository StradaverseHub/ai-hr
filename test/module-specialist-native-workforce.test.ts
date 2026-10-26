/** Authored UNRUN: seven NONEMPTY native Workforce-domain fixtures and real closed Assistant
 * read sessions. No mocked moduleWork, inserted business-row substitutes, fake capability receipts,
 * inline SQL installation, provider call or production benchmark. Missing prerequisites fail. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {createLeaveType,updateLeaveType} from '../core/admin';
import {setCompensation} from '../core/comp';
import {setRestDay} from '../core/roster';
import {checkIn,checkOut} from '../packs/attendance/service';
import {requestLeave,setToilPolicy,accrueToil} from '../packs/leave/service';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {withAssistantRead,withAssistantReadTx,type AssistantReadSession} from '../core/assistant-read-session';
import {executeSpecialistHoldout,specialistNativeEvidencePresent} from '../core/module-specialist-harness';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const modules=['employees','org','leave','ess','approvals','attendance','toil'] as const;
type Module=typeof modules[number];
const candidate=(module:Module)=>({kind:'canonical_specialist_v1' as const,module,playbook:'canonical_domain_v1' as const});
let b:Base,admin:SessionContext,ctx:SessionContext,mine:Awaited<ReturnType<typeof hireEmployee>>,peer:Awaited<ReturnType<typeof hireEmployee>>,manager:Awaited<ReturnType<typeof hireEmployee>>,workedDate:string,leaveDate:string,requestId:string,credit:Awaited<ReturnType<typeof accrueToil>>,clock:Awaited<ReturnType<typeof checkOut>>,replacementName:string,replacementTypeId:string,unpaidTypeId:string;
beforeAll(async()=>{await migrateTestDb();const [p]=await owner.db.execute<{controls:boolean}>(sql`select to_regprocedure('app.ai_action_unpaused(text,boolean)') is not null as controls`);expect(p,'Install current AI controls through the normal migration owner; do not skip or install inline').toEqual({controls:true});});
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();for(const code of ['assistant','attendance','toil'])await setModule(b.tenantId,code,'active');admin={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
 const hire=(name:string,code:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employeeCode:code,employmentType:'full_time',hiredOn:'2020-01-01'});
 mine=await hire('Fictional Native Specialist Owner','NATIVE_OWNER');peer=await hire('PRIVATE PEER MUST NOT APPEAR','NATIVE_PEER');manager=await hire('Fictional Recorded Manager','NATIVE_MANAGER');await setReportingLine(admin,{subordinateEmploymentId:mine.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});ctx={...await entitledCtx(b,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 // All below are real ordinary canonical writes. The wage is an explicit fictional HR fixture fact,
 // never model-derived and never part of the specialist's public read projection.
 await setCompensation(admin,{employmentId:mine.employmentId,basicSalary:8000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
 const yesterday=new Date(todayInKualaLumpur()+'T00:00:00Z');yesterday.setUTCDate(yesterday.getUTCDate()-1);workedDate=yesterday.toISOString().slice(0,10);await setRestDay(admin,{employmentId:mine.employmentId,shiftDate:workedDate});await checkIn(admin,{employmentId:mine.employmentId,date:workedDate,time:'08:00:00'});clock=await checkOut(admin,{employmentId:mine.employmentId,date:workedDate,time:'17:00:00'});
 await setToilPolicy(admin,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false});credit=await accrueToil(admin,{employmentId:mine.employmentId,workedDate,approvedOn:new Date()});expect(credit.daysCredited).toBeGreaterThan(0);
 // Reading the native result's recorded reference is evidence, not an owner-inserted credit substitute.
 const [lot]=await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.id,credit.accrualId));expect(lot).toMatchObject({employmentId:mine.employmentId,status:'active'});if(!lot.ledgerEntryId)throw Error('Native accrual must record its actual ledger reference');const [ledger]=await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.id,lot.ledgerEntryId));expect(ledger.employmentId).toBe(mine.employmentId);const [type]=await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id,ledger.leaveTypeId));replacementName=type.name;replacementTypeId=type.id;await updateLeaveType(admin,{id:type.id,name:type.name,essViewConfig:{available:true}});
 // Native unpaid leave needs no manufactured annual entitlement. The recorded request stays pending;
 // it is not an approval fixture or a model-generated day/amount.
 const unpaid=await createLeaveType(admin,{code:'NATIVE_UNPAID',name:'Fictional Unpaid Native Request',paid:false});unpaidTypeId=unpaid.id;const next=new Date(todayInKualaLumpur()+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));leaveDate=next.toISOString().slice(0,10);const request=await requestLeave(ctx,{employmentId:mine.employmentId,leaveTypeId:unpaid.id,startDate:leaveDate,endDate:leaveDate,durationType:'full_day',reason:'Explicit fictional native human request'});requestId=request.leaveRequestId;
});
function rows(value:unknown):Record<string,unknown>[] {if(value===null||typeof value!=='object'||!Array.isArray((value as {rows?:unknown}).rows))throw Error('Expected actual bounded native projection');return(value as {rows:Record<string,unknown>[]}).rows;}
async function evaluation(module:Module,transactional=false){const consume=async(read:AssistantReadSession)=>{const source=await read.moduleWork(module);expect(source.module).toBe(module);expect(source.scope).toBe('current-caller');expect(specialistNativeEvidencePresent(module,source.data),'Native fixture must be NONEMPTY, not a synthesized empty success').toBe(true);const interpreted=executeCanonicalSpecialist(candidate(module),source),report=await executeSpecialistHoldout(candidate(module),read);expect(report).toMatchObject({module,state:'complete',nativeEvidence:'present',qualityFailures:0,securityFailures:0,coverage:'canonical_domain_guidance_only'});expect(report.cases.filter(row=>row.category==='native')).toEqual([{id:module+':fresh-native-facts-preserved',passed:true,category:'native'},{id:module+':nonempty-business-evidence',passed:true,category:'native'}]);expect(report.cases.every(row=>row.passed)).toBe(true);expect(interpreted.effects).toEqual([]);expect(interpreted.requiresFreshNativeReview).toBe(true);expect(interpreted.findings).toContain('scope_current_caller');const text=JSON.stringify(source.data);expect(text).not.toContain(peer.employmentId);expect(text).not.toContain('PRIVATE PEER MUST NOT APPEAR');expect(text).not.toMatch(/basicSalary|bankAccount|primaryEmail|passport|icNumber/);expect(JSON.stringify(report)).not.toMatch(/NATIVE_OWNER|Fictional|personId|employmentId/);return{source,interpreted,report};};
 return transactional?withTenant(ctx,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return withAssistantReadTx(ctx,tx,consume);}):withAssistantRead(ctx,module,consume);
}
function replacementBalanceProjection(data:unknown):Record<string,unknown>{
 const balances=rows(data)[0].balances;if(!Array.isArray(balances))throw Error('Expected actual native balances');
 const balance=balances.find(row=>row!==null&&typeof row==='object'&&row.leaveTypeId===replacementTypeId);
 if(!balance)throw Error('Expected the native accrued replacement type in the current own projection');return balance;
}
async function positiveReplacementPending(){
 // This request is a separate native working day, not an overlapping fixture or a raw pending row.
 const next=new Date(leaveDate+'T00:00:00Z');do{next.setUTCDate(next.getUTCDate()+1);}while([0,6].includes(next.getUTCDay()));const date=next.toISOString().slice(0,10);
 const submitted=await requestLeave(ctx,{employmentId:mine.employmentId,leaveTypeId:replacementTypeId,startDate:date,endDate:date,durationType:'full_day',reason:'Explicit fictional human replacement request for partial ESS visibility'});
 expect(submitted.days).toBeGreaterThan(0);
 const source=await withAssistantRead(ctx,'leave',read=>read.moduleWork('leave')),before=replacementBalanceProjection(source.data);
 expect(before).toMatchObject({leaveTypeId:replacementTypeId,pending:submitted.days,withheld:false});
 expect(typeof before.available).toBe('number');return before;
}
function expectOnlyPermittedPartialBalance(balance:Record<string,unknown>){
 // Exact projection keys prohibit accrued/balance, ledger/split aliases and raw policy leakage.
 expect(Object.keys(balance).sort()).toEqual(['available','leaveType','leaveTypeId','pending','sharedPoolName','taken','withheld'].sort());
 expect(balance).not.toHaveProperty('accrued');expect(balance).not.toHaveProperty('balance');
}
describe('native Workforce specialist facts, not empty readiness',()=>{
 it('employees: actual own active employment is present, with no peer/salary inference',async()=>{const{source,interpreted}=await evaluation('employees');expect(rows(source.data)).toMatchObject([{employmentId:mine.employmentId,employeeCode:'NATIVE_OWNER'}]);expect(interpreted.findings).toContain('employment_active');expect(interpreted.findings).not.toContain('employment_inactive');});
 it('org: actual native administrative line is interpreted as a recorded relationship, not delegated authority',async()=>{const{source,interpreted}=await evaluation('org');expect(rows(source.data)).toMatchObject([{employmentId:mine.employmentId,reportingLines:[{lineType:'administrative',name:'Fictional Recorded Manager',employeeCode:'NATIVE_MANAGER'}]}]);expect(interpreted.findings).toContain('reporting_recorded');expect(interpreted.findings).not.toContain('administrative_manager_missing');});
 it('leave: native banked credit has a genuine visible canonical balance; the specialist never grants or computes entitlement',async()=>{const{source,interpreted}=await evaluation('leave',true),balances=rows(source.data)[0].balances;if(!Array.isArray(balances))throw Error('Expected real native balances');expect(balances).toContainEqual(expect.objectContaining({leaveType:replacementName,available:credit.daysCredited,withheld:false}));expect(interpreted.findings).toContain('leave_available_recorded');});
 it('leave partial ESS: hiding available retains genuinely positive permitted pending without decomposition aliases',async()=>{
  const before=await positiveReplacementPending();
  await updateLeaveType(admin,{id:replacementTypeId,name:replacementName,essViewConfig:{available:false,pendingApproval:true}});
  const{source,interpreted}=await evaluation('leave',true),balance=replacementBalanceProjection(source.data);
  expect(balance).toEqual({leaveTypeId:replacementTypeId,leaveType:replacementName,taken:before.taken,pending:before.pending,available:null,sharedPoolName:null,withheld:true});
  expectOnlyPermittedPartialBalance(balance);expect(balance.pending).toBeGreaterThan(0);
  expect(interpreted.findings).toContain('withheld_not_reconstructable');expect(interpreted.findings).toContain('leave_pending_not_approved');
 });
 it('leave partial ESS: hiding positive pending retains the exact permitted native available value without decomposition aliases',async()=>{
  const before=await positiveReplacementPending();
  await updateLeaveType(admin,{id:replacementTypeId,name:replacementName,essViewConfig:{available:true,pendingApproval:false}});
  // The separate native unpaid request is also hidden, so no other permitted positive pending can mask reconstruction.
  await updateLeaveType(admin,{id:unpaidTypeId,name:'Fictional Unpaid Native Request',essViewConfig:{pendingApproval:false}});
  const{source,interpreted}=await evaluation('leave'),balance=replacementBalanceProjection(source.data);
  expect(balance).toEqual({leaveTypeId:replacementTypeId,leaveType:replacementName,taken:before.taken,pending:null,available:before.available,sharedPoolName:before.sharedPoolName,withheld:true});
  expectOnlyPermittedPartialBalance(balance);expect(before.pending).toBeGreaterThan(0);
  expect(interpreted.findings).toContain('withheld_not_reconstructable');expect(interpreted.findings).toContain('leave_available_recorded');
  expect(interpreted.findings).not.toContain('leave_pending_not_approved');
 });
 it('ess: a real employed person with missing canonical readiness fields gets gaps rather than no-subject/clear',async()=>{const{source,interpreted}=await evaluation('ess');expect(source.data).toMatchObject({employees:1,ready:0});expect((source.data as {gaps:unknown[]}).gaps.length).toBeGreaterThan(0);expect(interpreted.findings).toContain('readiness_gaps');expect(interpreted.findings).not.toContain('readiness_no_subject');expect(interpreted.findings).not.toContain('readiness_currently_clear');});
 it('approvals: an actual own submitted pending request is not treated as an approved leave decision',async()=>{const{source,interpreted}=await evaluation('approvals');expect(rows(source.data)).toContainEqual(expect.objectContaining({id:requestId,status:'pending',startDate:leaveDate,endDate:leaveDate}));expect(interpreted.findings).toContain('own_request_pending');expect(interpreted.findings).not.toContain('own_request_decided');});
 it('attendance: native clocking facts match the actual check-out result, never fabricated hours or approved overtime',async()=>{const{source,interpreted}=await evaluation('attendance',true);expect(rows(source.data)).toContainEqual(expect.objectContaining({employmentId:mine.employmentId,date:workedDate,status:clock.status,workedMinutes:clock.workedMinutes,otMinutes:clock.otMinutes}));expect(clock.workedMinutes).toBeGreaterThan(0);expect(interpreted.findings).toContain(['absent','late','half_day'].includes(clock.status)?'attendance_exception_recorded':'attendance_status_recorded');});
 it('toil: a genuinely accrued active native lot is recorded credit, not a new entitlement or payment promise',async()=>{const{source,interpreted}=await evaluation('toil');expect(rows(source.data)).toContainEqual(expect.objectContaining({employmentId:mine.employmentId,active:credit.daysCredited,rows:expect.objectContaining({rows:expect.arrayContaining([expect.objectContaining({id:credit.accrualId,status:'active',daysCredited:credit.daysCredited})])})}));expect(interpreted.findings).toContain('credit_recorded_not_new_eligibility');expect(interpreted.findings).not.toContain('credit_pay_conversion_not_payslip');});
 it.each(modules)('%s refuses genuinely revoked Assistant authority under retained caller context instead of producing a completed report',async module=>{await evaluation(module);await revokeAssistant(admin,{appUserId:ctx.userId!});await expect(withAssistantRead(ctx,module,read=>executeSpecialistHoldout(candidate(module),read))).rejects.toThrow('data access');});
 it.each(['attendance','toil'] as const)('%s rechecks the actual module entitlement, not a formerly entitled session',async module=>{await evaluation(module);await setModule(b.tenantId,module,'disabled');await expect(withAssistantRead(ctx,module,read=>executeSpecialistHoldout(candidate(module),read))).rejects.toThrow('data access');});
});
