/** Real restricted-role financial owners through the two courtesy server actions.
 * Only the authenticated session is supplied by the test. No owner, input, settlement, refusal,
 * authorization, subject lookup or result projection is mocked. This does not claim browser coverage.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {asc,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {createCompany,createDepartment} from '../core/admin';
import {hireEmployee} from '../core/org';
import {myEmployment} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
import {checkIn,checkOut,setAttendancePolicy,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,saveOvertimePatternAssignment,createOvertimeCalculationOwner,canonicalOvertimeInputTx,readOvertimeCalculationTx,reserveOvertimeSettlementTx,readOvertimeSettlementForDayTx} from '../packs/attendance/service';
import {createBatch,createPayComponent} from '../packs/payroll/service';
import {extendedHoursDayForEmployment,leaveCreditGrantDayFacts,ToilNotEligibleError,ToilSweepForbiddenError} from '../packs/leave/service';

const session=vi.hoisted(()=>({get:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:session.get}));
import {leaveCreditDayFactsAction} from '../app/(app)/leave/credit/actions';
import {leaveCreditGrantDayFactsAction} from '../app/(app)/admin/leave-config/leave-credit/actions';

let b:Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{
  session.get.mockReset();
  await resetDb();b=await seedBase();
  for(const module of ['attendance','payroll','toil'])await setModule(b.tenantId,module,'active');
});

async function fixture(complete:boolean){
  const bootstrap=await entitledCtx(b),date=todayInKualaLumpur();
  const employee=await hireEmployee(bootstrap,{person:{fullName:'Fictional courtesy employee',primaryEmail:'courtesy-employee@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:date});
  const employeeUserId=await createAppUser(b.tenantId,employee.personId,'employee');
  const [hrPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional scoped courtesy HR',primaryEmail:'courtesy-hr@example.test'}).returning();
  const hrUserId=await createAppUser(b.tenantId,hrPerson.id,'hr_admin');
  await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,hrUserId));
  const employeeCtx:SessionContext={...bootstrap,userId:employeeUserId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const hrCtx:SessionContext={...bootstrap,userId:hrUserId,personId:hrPerson.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const roles=await withTenant(hrCtx,tx=>tx.execute(sql`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`));
  expect(roles).toEqual([expect.objectContaining({name:'ai_hr_app',rolsuper:false,rolbypassrls:false})]);
  await setAttendancePolicy(hrCtx,{companyId:b.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
  await checkIn(hrCtx,{employmentId:employee.employmentId,date,time:'09:00'});
  if(complete)await checkOut(hrCtx,{employmentId:employee.employmentId,date,time:'19:00'});
  const earning=await createPayComponent(hrCtx,{code:'COURTESY_'+randomUUID().slice(0,8),name:'Fictional courtesy earning',label:'Fictional courtesy earning',kind:'allowance',includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false});
  const definition:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fictional courtesy rate',description:'Local contract fixture',priority:0,when:{id:'rate_when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earning.id,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day_charge',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:'25'}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
  const saved=await saveOvertimePatternDraft(hrCtx,{draft:{code:'COURTESY_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Fictional courtesy formula',definition}});
  const validation=await validateOvertimePatternActivation(hrCtx,{versionId:saved.versionId,expectedRevision:saved.revision});
  expect(validation.issues).toEqual([]);expect(validation.validationDigest).not.toBeNull();
  await activateOvertimePattern(hrCtx,{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:validation.validationDigest!,effectiveFrom:date});
  await saveOvertimePatternAssignment(hrCtx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[employee.employmentId]},priority:1,from:date,to:null});
  const calculationOwner=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  const calculation=await withTenant(hrCtx,async tx=>{
    const prepared=await calculationOwner.prepareTx(tx,hrCtx,{employmentId:employee.employmentId,date});
    const current=await readOvertimeCalculationTx(tx,hrCtx,{employmentId:employee.employmentId,date});
    if(!current)throw new Error('Canonical preparation must create its real source.');
    return calculationOwner.recordTx(tx,hrCtx,{prepared,expectedCurrentRevision:current.source.revision});
  });
  if(calculation.status!=='recorded')throw new Error('Expected a recorded canonical formula result.');
  return {bootstrap,date,employee,employeeCtx,hrCtx,calculation};
}

async function unchangedFacts(){
  return {
    sources:await owner.db.select().from(s.attendanceOvertimeSource).orderBy(asc(s.attendanceOvertimeSource.id)),
    calculations:await owner.db.select().from(s.attendanceOvertimeCalculation).orderBy(asc(s.attendanceOvertimeCalculation.id)),
    settlements:await owner.db.select().from(s.overtimeSourceSettlement).orderBy(asc(s.overtimeSourceSettlement.id)),
    attendance:await owner.db.select().from(s.attendance).orderBy(asc(s.attendance.id)),
    events:await owner.db.select().from(s.domainEvent).orderBy(asc(s.domainEvent.sequence)),
    requests:await owner.db.select().from(s.replacementLeaveRequest).orderBy(asc(s.replacementLeaveRequest.id)),
    credits:await owner.db.select().from(s.toilAccrual).orderBy(asc(s.toilAccrual.id)),
    ledger:await owner.db.select().from(s.leaveLedger).orderBy(asc(s.leaveLedger.id)),
    batches:await owner.db.select().from(s.payrollBatch).orderBy(asc(s.payrollBatch.id)),
    inputs:await owner.db.select().from(s.payrollInput).orderBy(asc(s.payrollInput.id)),
    payslips:await owner.db.select().from(s.payslip).orderBy(asc(s.payslip.id)),
  };
}

async function bothActions(f:Awaited<ReturnType<typeof fixture>>,reason:'cashConflict'|'unavailable'){
  // Pin the genuine upstream refusal too: a missing subject or unrelated SQL/RLS error must not pass.
  await expect(extendedHoursDayForEmployment(f.employeeCtx,f.employee.employmentId,f.date)).rejects.toBeInstanceOf(ToilNotEligibleError);
  await expect(extendedHoursDayForEmployment(f.employeeCtx,f.employee.employmentId,f.date)).rejects.toMatchObject({formulaReason:reason});
  await expect(leaveCreditGrantDayFacts(f.hrCtx,{employmentId:f.employee.employmentId,workedDate:f.date})).rejects.toMatchObject({formulaReason:reason});
  session.get.mockResolvedValue(f.employeeCtx);
  expect((await myEmployment(f.employeeCtx))?.employmentId).toBe(f.employee.employmentId);
  await expect(leaveCreditDayFactsAction(f.date)).resolves.toEqual({state:'unavailable',reason});
  session.get.mockResolvedValue(f.hrCtx);
  await expect(leaveCreditGrantDayFactsAction(f.date,f.employee.employmentId)).resolves.toEqual({state:'unavailable',reason});
}

describe('canonical Leave Credit day-fact refusals reach both actual action contracts',()=>{
  it('settles a real cash reservation as cashConflict instead of rejecting the date lookup',async()=>{
    const f=await fixture(true);
    expect(f.calculation.evaluation).toMatchObject({status:'ready',transferable:true});
    expect(f.calculation.duration).toMatchObject({status:'ready'});
    const batch=await createBatch(f.hrCtx,{companyId:b.companyId,payPeriod:f.date.slice(0,7),scope:{employmentIds:[f.employee.employmentId]}});
    const reservation=await withTenant(f.hrCtx,tx=>reserveOvertimeSettlementTx(tx,f.hrCtx,{employmentId:f.employee.employmentId,date:f.date,mode:'cash',calculationId:f.calculation.calculationId,payrollBatchId:batch.batchId}));
    expect(await withTenant(f.hrCtx,tx=>readOvertimeSettlementForDayTx(tx,f.hrCtx,{employmentId:f.employee.employmentId,date:f.date}))).toMatchObject({settlement:{id:reservation.id,mode:'cash',payrollBatchId:batch.batchId}});
    const before=await unchangedFacts();
    expect(before.requests).toEqual([]);expect(before.credits).toEqual([]);expect(before.inputs).toEqual([]);expect(before.payslips).toEqual([]);
    expect(before.batches).toEqual([expect.objectContaining({id:batch.batchId,status:'draft'})]);
    await bothActions(f,'cashConflict');
    expect(await unchangedFacts()).toEqual(before);
  });

  it('settles genuine incomplete recorded duration as unavailable without fabricating a credit or cash claim',async()=>{
    const f=await fixture(false);
    expect(f.calculation.duration).toMatchObject({status:'refused'});
    const before=await unchangedFacts();
    expect(before.attendance).toEqual([expect.objectContaining({employmentId:f.employee.employmentId,checkInAt:'09:00:00',checkOutAt:null})]);
    expect(before.settlements).toEqual([]);expect(before.requests).toEqual([]);expect(before.credits).toEqual([]);expect(before.batches).toEqual([]);expect(before.inputs).toEqual([]);expect(before.payslips).toEqual([]);
    await bothActions(f,'unavailable');
    expect(await unchangedFacts()).toEqual(before);
  });

  it('keeps an HR-selected foreign company subject denied and employee lookup bound to the authenticated person',async()=>{
    const f=await fixture(false);
    const otherCompany=await createCompany(f.bootstrap,{legalName:'Fictional outside courtesy scope',country:'MY',currency:'MYR'});
    const otherDepartment=await createDepartment(f.bootstrap,{companyId:otherCompany.id,name:'Fictional outside courtesy department'});
    const other=await hireEmployee(f.bootstrap,{person:{fullName:'Fictional outside courtesy employee',primaryEmail:'courtesy-outside@example.test'},companyId:otherCompany.id,departmentId:otherDepartment.id,employmentType:'full_time',hiredOn:f.date});
    const otherUserId=await createAppUser(b.tenantId,other.personId,'employee');
    const otherCtx:SessionContext={...f.employeeCtx,userId:otherUserId,personId:other.personId};
    const before=await unchangedFacts();
    session.get.mockResolvedValue(f.hrCtx);
    await expect(leaveCreditGrantDayFactsAction(f.date,other.employmentId)).rejects.toBeInstanceOf(ToilSweepForbiddenError);
    session.get.mockResolvedValue(otherCtx);
    expect((await myEmployment(otherCtx))?.employmentId).toBe(other.employmentId);
    await expect(leaveCreditDayFactsAction(f.date)).resolves.toMatchObject({kind:expect.any(String),attendanceRecordPresent:false});
    // Switching back reaches this employee's genuinely unavailable recorded day, with no client subject.
    session.get.mockResolvedValue(f.employeeCtx);
    await expect(leaveCreditDayFactsAction(f.date)).resolves.toEqual({state:'unavailable',reason:'unavailable'});
    expect(await unchangedFacts()).toEqual(before);
  });
});
