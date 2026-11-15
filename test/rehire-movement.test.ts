/**
 * Board 511aa74a — Rehired. A resigned employee returns as a NEW employment of the SAME person with a new Employee ID;
 * the previous period is not changed; Roll Back voids the new period only while it has no activity.
 * Fictional tenant, companies and people.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentBlacklist} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {activeMovementEventTypeChoicesTx,listMovementEventTypes,saveMovementEventType,setMovementEventTypeActive} from '../core/movement-type';
import {employmentPeriods,rehireEmployment,rehireFormDefaults,rehiredAsForEmploymentsTx,rollBackRehire,RehireError,type RehireInput} from '../core/rehire';
import {deriveEmploymentStatus} from '../core/employment-status';
import {CONFIGURABLE_BEHAVIOUR_KINDS} from '../core/movement-type';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});

const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const ctx=()=>adminCtx(b);
const LWD=day(-30);
async function hire(code:string,hiredOn=day(-400)){
 const e=await hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn});
 return {employmentId:e.employmentId as string,personId:e.personId as string};
}
async function resign(employmentId:string,lastDay=LWD){
 await createMovementEvent(ctx(),{employmentId,kind:'termination',effectiveDate:lastDay,endDate:lastDay,terminationReasonCode:'resignation',resignationDate:lastDay});
}
const input=(fromEmploymentId:string,extra:Partial<RehireInput>={}):RehireInput=>({
 fromEmploymentId,effectiveDate:day(-5),employeeIdMode:'manual',employeeCode:'EMP-0418',companyId:b.companyId,
 departmentId:b.deptB,positionId:b.positionId,employmentType:'full_time',basicSalary:5200,currency:'MYR',remarks:'Fictional returning employee',...extra,
});
const refusal=async(p:Promise<unknown>)=>{try{await p;}catch(e){if(e instanceof RehireError)return e.code;throw e;}throw new Error('expected a refusal');};
/** Everything the previous period owns, read as the owner: it must not change. */
const snapshot=async(id:string)=>({
 employment:await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)),
 assignments:await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,id)).orderBy(asc(schema.assignment.id)),
 compensation:await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId,id)).orderBy(asc(schema.compensation.id)),
 leave:await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId,id)).orderBy(asc(schema.leaveLedger.id)),
 events:await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.subjectEmploymentId,id)).orderBy(asc(schema.domainEvent.sequence)),
});
const row=async(id:string)=>(await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0];

describe('Rehired starts a new employment period for the same person',()=>{
 it('creates a new employment with the same person, a new Employee ID and the link; the previous period is untouched',async()=>{
  const old=await hire('EMP-0123');
  await resign(old.employmentId);
  const before=await snapshot(old.employmentId);
  expect(before.events.length).toBeGreaterThan(1);
  const defaults=await rehireFormDefaults(ctx(),old.employmentId);
  expect(defaults?.refusal).toBeNull();
  expect(defaults?.values).toMatchObject({companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time'});
  expect(defaults?.notOnOrBefore).toBe(LWD);

  const result=await rehireEmployment(ctx(),input(old.employmentId));
  expect(result.employeeCode).toBe('EMP-0418');
  const created=await row(result.employmentId);
  expect(created).toMatchObject({personId:old.personId,employeeCode:'EMP-0418',rehiredFromEmploymentId:old.employmentId,hiredOn:day(-5),joinDate:day(-5),terminatedOn:null});
  // Probation from the effective date (the company default of three months).
  expect(deriveEmploymentStatus(created,todayInKualaLumpur())).toBe('probation');
  const [placement]=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,result.employmentId));
  expect(placement).toMatchObject({departmentId:b.deptB,validFrom:day(-5),employmentType:'full_time'});
  const [pay]=await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId,result.employmentId));
  expect(pay).toMatchObject({basicSalary:'5200.00',currency:'MYR',validFrom:day(-5)});

  // Previous period: same rows, same events, still Resigned.
  expect(await snapshot(old.employmentId)).toEqual(before);
  expect(deriveEmploymentStatus((await row(old.employmentId)),todayInKualaLumpur())).toBe('resigned');

  // Employment History of the new period shows Rehired with the previous Employee ID.
  const history=await movementHistory(ctx(),result.employmentId);
  const rehired=history.find(r=>r.kind==='rehire');
  expect(rehired).toMatchObject({effectiveDate:day(-5),rehiredFrom:{employmentId:old.employmentId,employeeCode:'EMP-0123'},canEdit:false,canReverse:false});
  const [event]=await owner.db.select({payload:schema.domainEvent.payload,actorId:schema.domainEvent.actorId}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.subjectEmploymentId,result.employmentId),eq(schema.domainEvent.eventType,'employment.movement.recorded')));
  expect(event.actorId).toBe(b.adminUserId);
  expect(event.payload).toMatchObject({type:'rehire',effectiveDate:day(-5),fromEmploymentId:old.employmentId,previousEmployeeCode:'EMP-0123',employeeCode:'EMP-0418',groupJoinDate:day(-5),remarks:'Fictional returning employee'});
  expect(JSON.stringify(event.payload)).not.toContain('5200');

  // Employment Periods and the Personnel search link read the same periods from either side.
  const periods=await employmentPeriods(ctx(),old.employmentId);
  expect(periods.map(p=>[p.employeeCode,p.status,p.current])).toEqual([['EMP-0418','probation',true],['EMP-0123','resigned',false]]);
  expect(periods[1].rehiredAs).toEqual({employmentId:result.employmentId,employeeCode:'EMP-0418'});
  const links=await withTenant(ctx(),tx=>rehiredAsForEmploymentsTx(tx,[old.employmentId,result.employmentId]));
  expect([...links]).toEqual([[old.employmentId,{employmentId:result.employmentId,employeeCode:'EMP-0418'}]]);
 });

 it('carries the person-keyed statutory and bank details; leave starts fresh on the new period',async()=>{
  const old=await hire('EMP-STAT');
  const pack=requirePackFor('MY');
  await owner.db.insert(schema.employeeStatutoryMy).values({tenantId:b.tenantId,personId:old.personId,icNumber:'900101-01-1234',epfNumber:'EPF-FICTIONAL-1',bankName:pack.client.bankNames[0],bankAccountNo:'000-FICTIONAL-1'});
  await owner.db.insert(schema.leaveLedger).values({tenantId:b.tenantId,employmentId:old.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'debit',days:'-2.00',effectiveOn:day(-100)});
  await resign(old.employmentId);
  const oldLeave=(await snapshot(old.employmentId)).leave;
  const result=await rehireEmployment(ctx(),input(old.employmentId,{employeeCode:'EMP-STAT-2'}));
  expect(result.personId).toBe(old.personId);
  const statutory=await withTenant(ctx(),tx=>pack.statutory.get(ctx(),result.personId,tx));
  expect(statutory).toMatchObject({icNumber:'900101-01-1234',epfNumber:'EPF-FICTIONAL-1',bankAccountNo:'000-FICTIONAL-1'});
  expect(await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,old.personId))).toHaveLength(1);
  const fresh=await owner.db.select().from(schema.leaveLedger).where(eq(schema.leaveLedger.employmentId,result.employmentId));
  expect(fresh.every(entry=>entry.entryType==='accrual'&&entry.effectiveOn>=day(-5))).toBe(true);
  expect((await snapshot(old.employmentId)).leave).toEqual(oldLeave);
 });

 it('an earlier Group Join Date moves only the Group Join Date; the period starts on the effective date',async()=>{
  const old=await hire('EMP-GJD');
  await resign(old.employmentId);
  const result=await rehireEmployment(ctx(),input(old.employmentId,{groupJoinDate:day(-400)}));
  expect(await row(result.employmentId)).toMatchObject({hiredOn:day(-400),joinDate:day(-5)});
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId,{groupJoinDate:day(-1)})))).toBe('group_join_date_invalid');
 });
});

describe('Rehired is refused unless the employee is Resigned with nothing current',()=>{
 it('refuses Active, Serving Notice, Probation, Blacklisted and already-rehired periods',async()=>{
  const active=await hire('EMP-ACT');
  expect(await refusal(rehireEmployment(ctx(),input(active.employmentId)))).toBe('not_resigned');
  const notice=await hire('EMP-NOT');
  await resign(notice.employmentId,day(20));
  expect(await refusal(rehireEmployment(ctx(),input(notice.employmentId,{effectiveDate:day(30)})))).toBe('not_resigned');
  const probation=await hire('EMP-PROB',day(-10));
  expect(await refusal(rehireEmployment(ctx(),input(probation.employmentId)))).toBe('not_resigned');
  const banned=await hire('EMP-BAN');
  await resign(banned.employmentId);
  await setEmploymentBlacklist(ctx(),{employmentId:banned.employmentId,blacklisted:true,reason:'Fictional blacklist'});
  expect(await refusal(rehireEmployment(ctx(),input(banned.employmentId)))).toBe('blacklisted');
  expect((await rehireFormDefaults(ctx(),banned.employmentId))?.refusal?.code).toBe('blacklisted');
  const twice=await hire('EMP-TWICE');
  await resign(twice.employmentId);
  await rehireEmployment(ctx(),input(twice.employmentId,{employeeCode:'EMP-TWICE-2'}));
  expect(await refusal(rehireEmployment(ctx(),input(twice.employmentId,{employeeCode:'EMP-TWICE-3'})))).toBe('already_rehired');
  expect(await owner.db.select().from(schema.employment).where(eq(schema.employment.personId,twice.personId))).toHaveLength(2);
 });

 it('refuses when the person has another current employment',async()=>{
  const old=await hire('EMP-CUR');
  await resign(old.employmentId);
  await hireEmployee(ctx(),{person:{id:old.personId},employeeCode:'EMP-CUR-OTHER',companyId:b.companyId,departmentId:b.deptA,employmentType:'part_time',hiredOn:day(-10)});
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId)))).toBe('current_employment');
 });

 it('refuses an effective date on or before the last working day, and accepts the next day',async()=>{
  const old=await hire('EMP-DATE');
  await resign(old.employmentId);
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId,{effectiveDate:LWD})))).toBe('date_not_after_end');
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId,{effectiveDate:day(-60)})))).toBe('date_not_after_end');
  const ok=await rehireEmployment(ctx(),input(old.employmentId,{effectiveDate:day(-29)}));
  expect((await row(ok.employmentId)).joinDate).toBe(day(-29));
 });

 it('refuses a taken Employee ID and a missing one where the company has no numbering',async()=>{
  const old=await hire('EMP-CODE');
  await resign(old.employmentId);
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId,{employeeCode:'EMP-CODE'})))).toBe('employee_code_taken');
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId,{employeeIdMode:'auto',employeeCode:null})))).toBe('employee_code_required');
 });

 it('refuses an administrator of another company only',async()=>{
  const old=await hire('EMP-SCOPE');
  await resign(old.employmentId);
  const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other Sdn Bhd'}).returning({id:schema.company.id});
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:schema.appUser.id});
  await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,companyId:other.id,role:'hr_admin'});
  const scoped:SessionContext={...ctx(),userId:user.id,grants:[{role:'hr_admin',companyId:other.id}]};
  await expect(rehireEmployment(scoped,input(old.employmentId,{companyId:other.id}))).rejects.toThrow();
  expect(await owner.db.select().from(schema.employment).where(eq(schema.employment.personId,old.personId))).toHaveLength(1);
 });

 it('needs an admin role',async()=>{
  const old=await hire('EMP-ROLE');
  await resign(old.employmentId);
  expect(await refusal(rehireEmployment({...ctx(),roles:['employee']},input(old.employmentId)))).toBe('permission');
 });
});

describe('the Rehired event type',()=>{
 it('is a built-in that can be switched off but never carried by a custom type or recorded by the generic writer',async()=>{
  expect(CONFIGURABLE_BEHAVIOUR_KINDS).not.toContain('rehire');
  const types=await listMovementEventTypes(ctx());
  expect(types.find(t=>t.code==='rehire')).toMatchObject({builtIn:true,behaviourKind:'rehire',active:true});
  await expect(saveMovementEventType(ctx(),{label:'Fictional Return',behaviourKind:'rehire'})).rejects.toThrow();
  await expect(saveMovementEventType(ctx(),{code:'rehire',label:'Returned',behaviourKind:'transfer'})).rejects.toThrow();
  // The movement import never offers it.
  const choices=await withTenant(ctx(),tx=>activeMovementEventTypeChoicesTx(tx,b.tenantId));
  expect(choices.map(c=>c.code)).not.toContain('rehire');
  const old=await hire('EMP-TYPE');
  await resign(old.employmentId);
  await expect(createMovementEvent(ctx(),{employmentId:old.employmentId,kind:'rehire',effectiveDate:day(-5)})).rejects.toThrow();
  await setMovementEventTypeActive(ctx(),{code:'rehire',active:false});
  expect(await refusal(rehireEmployment(ctx(),input(old.employmentId)))).toBe('type_inactive');
 });

 it('the link is written only by the rehire command',async()=>{
  const a=await hire('EMP-LINK-A');
  await resign(a.employmentId);
  const other=await hireEmployee(ctx(),{person:{id:a.personId},employeeCode:'EMP-LINK-B',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-5)});
  await expect(withTenant(ctx(),tx=>tx.update(schema.employment).set({rehiredFromEmploymentId:a.employmentId}).where(eq(schema.employment.id,other.employmentId)))).rejects.toThrow();
  expect((await row(other.employmentId)).rehiredFromEmploymentId).toBeNull();
 });
});

describe('Roll Back of a Rehired event',()=>{
 it('voids the new period while it has no activity, leaves the previous one Resigned, and frees the Employee ID',async()=>{
  const old=await hire('EMP-RB');
  await resign(old.employmentId);
  const before=await snapshot(old.employmentId);
  const result=await rehireEmployment(ctx(),input(old.employmentId,{employeeCode:'EMP-RB-2'}));
  // The generic movement rollback cannot undo it.
  const rehired=(await movementHistory(ctx(),result.employmentId)).find(r=>r.kind==='rehire')!;
  await expect(reverseMovementEvent(ctx(),{employmentId:result.employmentId,movementId:rehired.id,reason:'Fictional generic rollback'})).rejects.toThrow();
  expect(await refusal(rollBackRehire(ctx(),{employmentId:result.employmentId,reason:''}))).toBe('reason_required');
  expect(await refusal(rollBackRehire(ctx(),{employmentId:old.employmentId,reason:'Fictional mistake'}))).toBe('rollback_unavailable');

  await rollBackRehire(ctx(),{employmentId:result.employmentId,reason:'Fictional mistake'});
  const voided=await row(result.employmentId);
  expect(voided.voidedAt).not.toBeNull();
  expect(voided).toMatchObject({employeeCode:null,voidedEmployeeCode:'EMP-RB-2',voidReason:'Fictional mistake',voidedBy:b.adminUserId,voidedImportAttemptId:null,rehiredFromEmploymentId:old.employmentId});
  const [personRow]=await owner.db.select().from(schema.person).where(eq(schema.person.id,old.personId));
  expect(personRow.voidedAt).toBeNull();
  expect(await snapshot(old.employmentId)).toEqual(before);
  const [audit]=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.subjectEmploymentId,result.employmentId),eq(schema.domainEvent.eventType,'employment.rehire.rolled-back')));
  expect(audit.payload).toMatchObject({movementId:rehired.id,fromEmploymentId:old.employmentId,employeeCode:'EMP-RB-2',reason:'Fictional mistake'});
  // The period can be rehired again, with the released Employee ID.
  expect((await rehireFormDefaults(ctx(),old.employmentId))?.refusal).toBeNull();
  const again=await rehireEmployment(ctx(),input(old.employmentId,{employeeCode:'EMP-RB-2'}));
  expect((await row(again.employmentId)).employeeCode).toBe('EMP-RB-2');
 });

 it('is refused once the new period has a payslip, naming the blocker',async()=>{
  const old=await hire('EMP-PAY');
  await resign(old.employmentId);
  const result=await rehireEmployment(ctx(),input(old.employmentId,{employeeCode:'EMP-PAY-2'}));
  const [period]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:day(-5).slice(0,7),status:'closed'}).returning({id:schema.payPeriod.id});
  const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:day(-5).slice(0,7),batchDate:day(-1),status:'closed',employeeCount:1}).returning({id:schema.payrollBatch.id});
  await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:result.employmentId,basicSalary:'5200.00',grossPay:'5200.00',statutory:{},totalDeductions:'0.00',netPay:'5200.00',employerCost:'5200.00'});
  try{await rollBackRehire(ctx(),{employmentId:result.employmentId,reason:'Fictional mistake'});throw new Error('expected a refusal');}
  catch(e){expect(e).toBeInstanceOf(RehireError);expect((e as RehireError).code).toBe('rollback_blocked');expect((e as RehireError).detail.sources).toContain('payslip.employment_id');}
  expect((await row(result.employmentId)).voidedAt).toBeNull();
  // A leave taken on the new period blocks as well; the hire's own grants do not.
  const [blockers]=await owner.db.execute(sql`select count(*)::int as n from leave_ledger where employment_id=${result.employmentId}::uuid and entry_type='debit'`);
  expect(blockers).toMatchObject({n:0});
 });
});
