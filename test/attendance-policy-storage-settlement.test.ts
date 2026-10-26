import {updateLeaveType} from '../core/admin';
import {requestLeave,decideLeave} from '../core/leave';
import {saveScheduleGroupControl} from '../core/schedule-group-controls';
import {recordedAttestedPolicyWorkTx} from '../packs/attendance/policy-attested-work-source';
import {attendancePolicyAttestedWorkInput} from '../packs/attendance/policy-attested-work-input';
import {createBatch,createPayComponent,overtimePatternTransferOptions,transferOvertimePatternToPayroll,readPayrollOvertimePatternCashTx,generatePayslips,closeBatch,deleteDraftBatch,resetProcessedBatch} from '../packs/payroll/service';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {requirePackFor} from '../localization/registry';
import {listEarnedLeaveCredits,grantLeaveCreditRows,leaveCreditGrantClaimReview,runToilExpiry,accrueToil,setToilPolicy,reverseLeaveCredit} from '../core/toil';
import {readOvertimePolicyDurationTx} from '../packs/attendance/overtime-patterns';
import {resolveOvertimeToilDurationTx} from '../packs/attendance/overtime-toil';
import {recordedAttendancePolicyProposalPartsMatch,materializeAttendancePolicyProposalParts} from '../packs/attendance/policy-proposal-parts';
import {attendancePolicyCapturedCoverageProposal} from '../packs/attendance/policy-captured-coverage';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {attendancePolicyCashReplay,attendancePolicyCurrentCashMatches} from '../packs/attendance/policy-cash-replay';
import {attendancePolicyPricingProposal} from '../packs/attendance/policy-pricing-proposal';
import {attendancePolicyDurationReplay,attendancePolicyCurrentDurationMatches,attendancePolicyIndependentDurationReplay,type IndependentPolicyDurationSource} from '../packs/attendance/policy-duration-replay';
import {attendancePolicyDurationFormulaProjection} from '../packs/attendance/policy-formula-source';
/** Development canonical policy storage and financial integration regressions. SQL0590 remains
 * unshipped; full release, browser and current Board2 union evidence are separate requirements. */
import {randomUUID,createHash} from 'node:crypto';
import {attendancePolicyExecutionProposal,attendancePolicyDurationExecutionProposal} from '../packs/attendance/policy-execution-proposal';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {assignDefaultShift,createShift,setRestDay} from '../core/roster';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {lockAttendancePolicyImportTx,activateOvertimePattern,checkIn,checkOut,ensureStandardRule,canonicalOvertimeInputTx,canonicalOvertimePayrollInputTx,canonicalOvertimeToilInputTx,createOvertimeCalculationOwner,getOvertimePattern,stopOvertimePatternVersion,readOvertimeCalculationTx,readOvertimePatternCalculationTx,calculateOvertimePatternDay,
 checkInTx,checkOutTx,lockOvertimeSourceTx,reserveOvertimeSettlementTx,saveOvertimePatternDraft,scheduleAttendanceGroupPolicy,validateOvertimePatternActivation,requestAttendanceCorrection,decideAttendanceCorrection,cancelAttendanceApplication,canSubmitUnclockedAttendanceWork,setAttendancePolicy} from '../packs/attendance/service';
import {adminCtx,entitledCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
import {createAttendancePolicyStorageFixtures} from './attendance-policy-storage-fixture';


let b:Base,ctx:SessionContext;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});
const {capturedClock,fixture,header,part}=createAttendancePolicyStorageFixtures({get b(){return b;},get ctx(){return ctx;},day});

type Fixture=Awaited<ReturnType<typeof fixture>>;
describe('immutable non-payable policy part storage',()=>{

 it('transfers an actual split policy parent into Payroll once and generates the canonical payslip',async()=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,0,true),p={employmentId:f.employmentId,date:f.sourceDate};
  await setStatutoryProfileMY(ctx,{personId:f.personId,icNumber:'900101011234'});
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!read?.calculation)throw Error('Expected complete policy parent');
  expect(read.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',payableNumerator:'120'});
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
  const transfer={...p,expectedCalculationId:read.calculation.id,expectedSourceRevision:read.source.revision,
   batchId:batch.batchId,reason:'Fictional full current policy Payroll flow'};
  const first=await transferOvertimePatternToPayroll(ctx,transfer),retry=await transferOvertimePatternToPayroll(ctx,transfer);
  expect(first.status).toBe('transferred');expect(retry).toMatchObject({status:'unchanged',settlementId:first.settlementId});
  await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date})).rejects.toThrow('already reserved for cash');
  const cash=await withTenant(ctx,tx=>readPayrollOvertimePatternCashTx(tx,ctx,{batchId:batch.batchId}));
  expect(cash.lines.map(row=>({date:row.date,amount:row.amountMinorUnits}))).toEqual([
   {date:p.date,amount:'1800'},{date:new Date(Date.parse(p.date+'T00:00:00Z')+86400000).toISOString().slice(0,10),amount:'1800'}]);
  await generatePayslips(ctx,{batchId:batch.batchId});
  const [slip]=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batch.batchId),eq(s.payslip.employmentId,f.employmentId)));
  expect(slip.overtimePay).toBe('36.00');
  await closeBatch(ctx,{batchId:batch.batchId});
  await expect(transferOvertimePatternToPayroll(ctx,transfer)).rejects.toThrow();
  await expect(deleteDraftBatch(ctx,{batchId:batch.batchId})).rejects.toThrow();
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(and(eq(s.overtimeSourceSettlement.sourceId,read.source.id),sql`released_at IS NULL`))).toHaveLength(1);
 });
 it('banks actual policy TOIL under its existing credit owner, excludes cash, and releases on canonical reversal',async()=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,0,true),p={employmentId:f.employmentId,date:f.sourceDate};
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  await accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date});
  const [accrual]=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
  expect(accrual).toMatchObject({otMinutes:120,workedDayKind:'workday',daysCredited:'1.00',status:'active'});
  await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date})).rejects.toThrow();
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!read?.calculation)throw Error('Expected current parent');
  const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,read.source.id));
  expect(claim).toMatchObject({mode:'toil',toilAccrualId:accrual.id,coverageCalculationId:read.calculation.id,coverageKind:'policyPhysical'});
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
  await expect(transferOvertimePatternToPayroll(ctx,{...p,expectedCalculationId:read.calculation.id,expectedSourceRevision:read.source.revision,
   batchId:batch.batchId,reason:'Fictional cash must refuse active TOIL'})).rejects.toThrow();
  await deleteDraftBatch(ctx,{batchId:batch.batchId});
  await reverseLeaveCredit(ctx,{accrualId:accrual.id,reason:'Fictional reviewed credit reversal'});
  const [released]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.id));
  expect(released.releasedAt).not.toBeNull();
  expect((await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,accrual.id)))[0].status).toBe('reversed');
 });

 it('serializes independent app reservations across overlapping source parents and releases coverage through the canonical owner',async()=>{
  await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,0,true);
  const next=new Date(Date.parse(f.sourceDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  // Distinct original captures, same employee, overlapping real millisecond geometry across
  // two Attendance parents: 23:00–01:00 versus next-day00:30–02:30. No source restoration.
  await capturedClock(f.employmentId,next,'in','00:30:00');await capturedClock(f.employmentId,next,'out','02:30:00');
  const left=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:f.sourceDate}));
  const right=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:next}));
  if(!left?.calculation||!right?.calculation)throw Error('Expected both canonical policy parents');
  expect(left.calculation.outcome).toBe('ready');expect(right.calculation.outcome).toBe('ready');
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:f.sourceDate.slice(0,7)});
  let held!:()=>void,release!:()=>void,started!:(pid:number)=>void;
  const heldPromise=new Promise<void>(done=>{held=done;}),releasePromise=new Promise<void>(done=>{release=done;}),
   startedPromise=new Promise<number>(done=>{started=done;});
  const first=withTenant(ctx,async tx=>{
   const claim=await reserveOvertimeSettlementTx(tx,ctx,{employmentId:f.employmentId,date:f.sourceDate,mode:'cash',
    calculationId:left.calculation!.id,payrollBatchId:batch.batchId});held();await releasePromise;return claim;
  });
  let second:Promise<{ok:true}|{ok:false;error:unknown}>|undefined;
  try{
   await Promise.race([heldPromise,first.then(()=>{throw Error('First reservation ended before its hold');})]);
   second=withTenant(ctx,async tx=>{
    const [row]=await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[];started(row.pid);
    await reserveOvertimeSettlementTx(tx,ctx,{employmentId:f.employmentId,date:next,mode:'cash',
     calculationId:right.calculation!.id,payrollBatchId:batch.batchId});
   }).then(()=>({ok:true as const}),error=>({ok:false as const,error}));
   const backend=await startedPromise,until=Date.now()+5000;let waited=false;
   while(Date.now()<until){const rows=await owner.db.execute(sql`select wait_event_type from pg_stat_activity where pid=${backend}`);
    if(rows[0]?.wait_event_type==='Lock'){waited=true;break;}await new Promise(done=>setTimeout(done,20));}
   expect(waited).toBe(true);release();await first;
   const outcome=await second;expect(outcome.ok).toBe(false);
   if(outcome.ok)throw Error('Overlapping parent reservation unexpectedly succeeded');
   const error=outcome.error as {cause?:{code?:string};code?:string};expect(error.cause?.code??error.code).toBe('23P01');
  }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);}
  const active=await owner.db.select().from(s.overtimeSourceSettlement).where(and(eq(s.overtimeSourceSettlement.tenantId,b.tenantId),sql`released_at IS NULL`));
  expect(active).toHaveLength(1);expect(active[0]).toMatchObject({sourceId:left.source.id,coverageKind:'policyPhysical'});
  await deleteDraftBatch(ctx,{batchId:batch.batchId});
  expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,active[0].id)))[0].releasedAt).not.toBeNull();
  const replacement=await createBatch(ctx,{companyId:b.companyId,payPeriod:f.sourceDate.slice(0,7)});
  expect(await transferOvertimePatternToPayroll(ctx,{employmentId:f.employmentId,date:next,expectedCalculationId:right.calculation.id,
   expectedSourceRevision:right.source.revision,batchId:replacement.batchId,reason:'Fictional source becomes available after canonical coverage release'}))
   .toMatchObject({status:'transferred'});
 });

 it.each(['identical','datedRates'] as const)('records and pays one capped parent across actual dated classes using $0 immutable definitions',async scope=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,'cap',0,true,{mode:'none',step:null},120,'earliest',scope==='datedRates'?'datedRates':true),p={employmentId:f.employmentId,date:f.sourceDate};
  await setStatutoryProfileMY(ctx,{personId:f.personId,icNumber:'900101011234'});
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(snapshot.policyMoneyScope).toBe(scope==='datedRates'?'datedFormulaRules':'identicalDefinitions');
  expect(attendancePolicyPricingProposal(snapshot)).toMatchObject({state:'proposed',amountMinorUnits:scope==='datedRates'?'800':'400'});
  const old=structuredClone(snapshot);delete old.policyMoneyScope;
  expect(attendancePolicyPricingProposal(old)).toMatchObject({state:'unavailable',reason:'pricingScopeUnavailable'});
  if(scope==='datedRates'){
   expect(await owner.db.execute(sql`select has_function_privilege('ai_hr_app','app.attendance_policy_dated_rate_shape(jsonb)','EXECUTE') as allowed`)).toMatchObject([{allowed:false}]);
   const narrowed=structuredClone(snapshot);narrowed.policyMoneyScope='identicalDefinitions';
   expect(attendancePolicyPricingProposal(narrowed)).toMatchObject({state:'unavailable',reason:'pricingScopeUnavailable'});
   const priced=attendancePolicyPricingProposal(snapshot);if(priced.state!=='proposed')throw Error('Expected actual dated hourly expressions');
   expect(priced.parts.flatMap(part=>part.pricing.lines.map(line=>line.gross))).toEqual([
    {unit:'money',numerator:'18',denominator:'1'},{unit:'money',numerator:'36',denominator:'1'}]);
  }
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!read?.calculation||!read.policyParts)throw Error('Expected complete actual compatible-version parent');
  expect(read.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',payableNumerator:'120'});
  expect(read.policyParts.map(part=>({kind:part.dayClass,version:part.versionId}))).toEqual([
   {kind:'normal',version:f.versionId},{kind:'rest',version:f.compatibleVersionId}]);
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
  await transferOvertimePatternToPayroll(ctx,{...p,expectedCalculationId:read.calculation.id,expectedSourceRevision:read.source.revision,
   batchId:batch.batchId,reason:'Fictional exact dated formula scope under one parent settlement'});
  await generatePayslips(ctx,{batchId:batch.batchId});
  const [slip]=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batch.batchId),eq(s.payslip.employmentId,f.employmentId)));
  expect(slip.overtimePay).toBe(scope==='datedRates'?'8.00':'4.00');
 });

 it('reviews and directly banks HR mixed-class window rows through the same dated credit rules',async()=>{
  await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,555,true,{mode:'none',step:null},120,'earliest',true);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const review=await leaveCreditGrantClaimReview(ctx,{employmentId:f.employmentId,workedDate:f.sourceDate,claimStart:'23:00',claimEnd:'01:00'});
  expect(review).toMatchObject({basis:'formula',status:'ready',datedClassScope:true,workedDayKind:'workday',creditDays:1,eligibleMinutes:120,
   datedParts:[{dayClass:'normal',days:0.5},{dayClass:'rest',days:0.5}]});
  // Prospective fixture time is injected through the existing public test clock;
  // this does not establish actual browser acceptance or a historical activation.
  const grant=await grantLeaveCreditRows(ctx,{employmentId:f.employmentId,reason:'Fictional dated-class HR window credit',today:f.sourceDate,
   rows:[{workedDate:f.sourceDate,dayType:'workday',claimStart:'23:00',claimEnd:'01:00'}]});
  expect(grant).toMatchObject({totalDays:1,overtimeSuppressedMinutes:120,rows:[{daysCredited:1,eligibleMinutes:120}]});
  const [stored]=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,grant.rows[0].accrualId));
  expect(stored).toMatchObject({dayType:null,workedDayKind:null,daysCredited:'1.00',datedCredit:{path:'claim',claimWindow:{start:'23:00',end:'01:00'},
   parts:[{dayClass:'normal',rule:'claimWindow',days:0.5},{dayClass:'rest',rule:'claimWindow',days:0.5}]}});
  await reverseLeaveCredit(ctx,{accrualId:stored.id,reason:'Fictional dated HR window release'});
  const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.toilAccrualId,stored.id));
  expect(claim.releasedAt).not.toBeNull();
 });

 it.each([{auto:true,extended:true,days:0.63},{auto:false,extended:true,days:null},{auto:true,extended:false,days:null}])(
  'uses dated credit rules on actual v4 final approval with auto=$auto and ordinary switch=$extended',async({auto,extended,days})=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  // Same declared historical group baseline as the other current-day workflow cases.
  // The approval, immutable final receipt, credit and reservation use the real owners.
  const f=await fixture('auto','12','actual',true,undefined,555,true,{mode:'none',step:null},120,'earliest',true),p={employmentId:f.employmentId,date:f.sourceDate};
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:auto,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:extended,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional dated auto-credit reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,
   roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:4,code:'AUTO_DATED_'+randomUUID().slice(0,7),name:'Fictional dated auto-credit approval',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,cc:[],
   stages:[{name:'Final review',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:120,reason:'Fictional current mixed-class overtime final approval'});
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId)))[0].status).toBe('approved');
  expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId))).toHaveLength(1);
  const [raw]=await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,f.employmentId));expect(raw.otMinutes).toBeNull();
  const credits=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId)).orderBy(asc(s.toilAccrual.id));
  if(days===null){expect(credits).toEqual([]);return;}
  expect(credits).toHaveLength(1);expect(credits[0]).toMatchObject({source:'auto_approval',daysCredited:'0.63',dayType:null,workedDayKind:null,
   datedCredit:{path:'roster',consumptionOrder:'earliestDateFirst',parts:[{dayClass:'normal',days:0.5},{dayClass:'rest',days:0.13}]}});
  await expect(decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'})).rejects.toThrow('already approved');
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!read?.calculation)throw Error('Expected canonical dated auto-credit source');
  const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.toilAccrualId,credits[0].id));
  expect(claim).toMatchObject({mode:'toil',coverageKind:'policyPhysical',coverageCalculationId:read.calculation.id});
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
  await expect(transferOvertimePatternToPayroll(ctx,{...p,expectedCalculationId:read.calculation.id,expectedSourceRevision:read.source.revision,
   batchId:batch.batchId,reason:'Fictional auto-credit excludes duplicate cash'})).rejects.toThrow();
  await deleteDraftBatch(ctx,{batchId:batch.batchId});await reverseLeaveCredit(ctx,{accrualId:credits[0].id,reason:'Fictional canonical auto-credit release'});
  expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.id)))[0].releasedAt).not.toBeNull();
 });

 it.each([true,false])('banks a prospective approved policy plan only when captured work arrives and auto=%s',async auto=>{
  await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  // Genuine prospective policy and workflow, then fictional owner-captured work arrival.
  // No policy backdating, trigger disable or scalar landing is used by this case.
  const f=await fixture('auto','12','preApproved',false,undefined,0,true,{mode:'none',step:null},120,'earliest',false,undefined,true),
   p={employmentId:f.employmentId,date:f.sourceDate};
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:auto,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional work-arrival reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,
   roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:4,code:'PLAN_ARRIVAL_'+randomUUID().slice(0,7),name:'Fictional prospective work-arrival approval',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,cc:[],
   stages:[{name:'Final plan review',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:90,plannedStartTime:'20:00',plannedEndTime:'21:30',reason:'Fictional work-arrival plan'});
  expect(await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'})).toMatchObject({deferred:true});
  const receipt=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId));
  expect(receipt).toHaveLength(1);expect(receipt[0].rawEvidence).toBeNull();
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
  await capturedClock(f.employmentId,p.date,'in','23:00:00',p.date,555);
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
  await capturedClock(f.employmentId,p.date,'out','01:00:00',new Date(Date.parse(p.date+'T00:00:00Z')+86400000).toISOString().slice(0,10),555);
  const [raw]=await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,f.employmentId));expect(raw.otMinutes).toBeNull();
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId)))[0]).toMatchObject({status:'approved',appliedAt:null,approvedOtMinutes:90});
  expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId))).toEqual(receipt);
  const credits=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
  if(!auto){expect(credits).toEqual([]);return;}
  expect(credits).toHaveLength(1);expect(credits[0]).toMatchObject({source:'auto_approval',daysCredited:'0.50',otMinutes:90});
  const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.toilAccrualId,credits[0].id));
  expect(claim).toMatchObject({mode:'toil',coverageKind:'policyPhysical',releasedAt:null});
  await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date})).rejects.toThrow();
  await reverseLeaveCredit(ctx,{accrualId:credits[0].id,reason:'Fictional work-arrival credit release'});
  expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.id)))[0].releasedAt).not.toBeNull();
 });

 it('banks mixed normal/rest credits once and expires only the unused dated balance after real half-day leave',async()=>{
  await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,555,true,{mode:'none',step:null},120,'earliest',true);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const credit=await accrueToil(ctx,{employmentId:f.employmentId,workedDate:f.sourceDate});
  expect(credit.daysCredited).toBe(0.63);
  const [stored]=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,credit.accrualId));
  expect(stored).toMatchObject({dayType:null,workedDayKind:null,otMinutes:120,daysCredited:'0.63'});
  expect(stored.datedCredit).toMatchObject({consumptionOrder:'earliestDateFirst',sourceMinutes:120,
   parts:[{dayClass:'normal',days:0.5},{dayClass:'rest',days:0.13}]});
  await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:f.sourceDate})).rejects.toThrow();
  let forgedCreditFailure:unknown;
  try{await withTenant(ctx,tx=>tx.update(s.toilAccrual).set({datedCredit:{...stored.datedCredit!,days:9}})
   .where(eq(s.toilAccrual.id,credit.accrualId)));}catch(error){forgedCreditFailure=error;}
  const forgedCreditCause=((forgedCreditFailure as {cause?:unknown}|undefined)?.cause??forgedCreditFailure) as {code?:unknown;message?:unknown}|undefined;
  expect(forgedCreditCause?.code).toBe('23514');expect(String(forgedCreditCause?.message)).toContain('Dated TOIL credit provenance is immutable');
  expect((await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,credit.accrualId)))[0].datedCredit).toEqual(stored.datedCredit);
  const [type]=await owner.db.select().from(s.leaveType).where(and(eq(s.leaveType.tenantId,b.tenantId),eq(s.leaveType.code,'REPLACEMENT')));
  await updateLeaveType(ctx,{id:type.id,name:type.name,durations:['full_day','half_day_am','half_day_pm']});
  let leaveDate=new Date(Date.parse(f.sourceDate+'T00:00:00Z')+3*86400000).toISOString().slice(0,10);
  // This replacement-leave fixture uses Monday–Friday. Retain its real half-day consumption
  // assertions without accidentally selecting a non-working day as the calendar advances.
  while([0,6].includes(new Date(leaveDate+'T00:00:00Z').getUTCDay()))
   leaveDate=new Date(Date.parse(leaveDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
  const request=await requestLeave(ctx,{employmentId:f.employmentId,leaveTypeId:type.id,startDate:leaveDate,endDate:leaveDate,durationType:'half_day_am'});
  await decideLeave(ctx,{leaveRequestId:request.leaveRequestId,decision:'approved'});
  expect((await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,credit.accrualId)))[0].daysTaken).toBe('0.50');
  const register=await listEarnedLeaveCredits(ctx,{employmentId:f.employmentId,today:leaveDate});
  expect(register.rows.find(row=>row.accrualId===credit.accrualId)).toMatchObject({used:0.5,available:0.13,
   datedCredits:[{dayClass:'normal',earned:0.5,used:0.5,available:0},{dayClass:'rest',earned:0.13,used:0,available:0.13}]});

  const expired=await runToilExpiry(ctx,{today:credit.expiresOn});
  expect(expired).toMatchObject({converted:1,convertedDays:0.13,convertedAmount:25});
  const events=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,credit.accrualId),eq(s.domainEvent.eventType,'toil.converted')));
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({valuationBasis:'dated_classes',creditConsumptionOrder:'earliestDateFirst',
   datedValuation:[{dayClass:'normal',remainingDays:0,amount:0},{dayClass:'rest',remainingDays:0.13,amount:25}]});
  expect((await runToilExpiry(ctx,{today:credit.expiresOn})).processed).toBe(0);
 });

 it.each([{mode:'up' as const,physical:125,direction:'earliest' as const},
  {mode:'nearest' as const,physical:135,direction:'latest' as const}])('carries $mode rounded counts through actual Payroll and independent TOIL without lengthening captures',async({mode,physical,direction})=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,555,true,{mode,step:30},physical,direction),
   p={employmentId:f.employmentId,date:f.sourceDate},extra=150-physical;
  await setStatutoryProfileMY(ctx,{personId:f.personId,icNumber:'900101011234'});
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!read?.calculation||!read.evidence||!read.policyParts)throw Error('Expected complete rounded financial parent');
  expect(read.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',payableNumerator:'150',transferable:true});
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  const coverage=attendancePolicyCapturedCoverageProposal({tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,
   sourceId:read.source.id,calculationId:read.calculation.id,date:p.date},snapshot);
  expect(coverage).toMatchObject({state:'prepared',minutes:150,countAttribution:{physicalMinutes:physical,roundedMinutes:extra,minutes:150}});
  if(coverage.state!=='prepared'||coverage.countBasis!=='capturedBoundaryFloor')throw Error('Expected actual captured footprint');
  expect(coverage.allocations.reduce((n,row)=>n+row.minutes,0)).toBe(physical);
  expect(coverage.intervals.reduce((n,row)=>n+row.toEpochMillisecond-row.fromEpochMillisecond,0)).toBe(physical*60000-555);
  const counts=coverage.countAttribution;if(!counts)throw Error('Expected explicit rounded count/date binding');
  expect(counts.parts.map(row=>row.minutes)).toEqual(direction==='earliest'?[60+extra,physical-60]:[60,physical-60+extra]);
  expect(read.evidence.evidence.policyCapturedCoverage).toEqual(coverage);
  // Original refused snapshots with no rounding-attribution field remain refused and readable
  // as physical proposal parts; the new source owner may not backfill or promote that history.
  const old=structuredClone(snapshot);
  if(old.policyExecutionProposal?.state!=='proposed'||old.policyExecutionProposal.duration.status!=='calculated')throw Error('Expected canonical rounding source');
  for(const row of old.policyExecutionProposal.duration.classes)delete row.roundingCountAttribution;
  expect(attendancePolicyDurationReplay(old)).toMatchObject({state:'unavailable',reason:'countPlacementUnavailable'});
  const oldParts=materializeAttendancePolicyProposalParts({source:old.input.source,policy:old.attendanceGroupPolicy,
   context:old.policyExecutionContext,work:old.policyWorkInput,durationFormulas:old.policyDurationFormulaInput,
   approvals:old.policyApprovalInput,proposal:old.policyExecutionProposal,rawEffect:old.policyRawEffectSource});
  expect(oldParts?.map(part=>part.allocatedPayableMinutes)).toEqual([60,physical-60]);
  expect(oldParts?.every(part=>!Object.hasOwn(part.durationEvidence,'roundingCountAttributions'))).toBe(true);
  expect(await owner.db.execute(sql`select has_function_privilege('ai_hr_app',
   'app.attendance_policy_part_payable_count(public.attendance_overtime_policy_part,jsonb,jsonb)','EXECUTE') as allowed`)).toMatchObject([{allowed:false}]);
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)}),transfer={...p,
   expectedCalculationId:read.calculation.id,expectedSourceRevision:read.source.revision,batchId:batch.batchId,reason:'Fictional exact rounded policy cash election'};
  const first=await transferOvertimePatternToPayroll(ctx,transfer);
  expect(await transferOvertimePatternToPayroll(ctx,transfer)).toMatchObject({status:'unchanged',settlementId:first.settlementId});
  await generatePayslips(ctx,{batchId:batch.batchId});
  const [slip]=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batch.batchId),eq(s.payslip.employmentId,f.employmentId)));
  expect(slip.overtimePay).toBe('45.00');
  await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date})).rejects.toThrow('already reserved for cash');
  // Payslip generation processed this run. Use the actual reasoned reset owner before
  // draft deletion and the next source's separate TOIL election.
  await setSetting(b.tenantId,'payroll.reset_enabled',true);ctx=await entitledCtx(b);
  await resetProcessedBatch(ctx,{batchId:batch.batchId,reason:'Fictional reset before releasing the rounded cash election'});
  await deleteDraftBatch(ctx,{batchId:batch.batchId});
  // A separate actual source chooses TOIL, even after its cash earning mapping is archived.
  const next=new Date(Date.parse(p.date+'T00:00:00Z')+86400000).toISOString().slice(0,10),
   afterNext=new Date(Date.parse(p.date+'T00:00:00Z')+2*86400000).toISOString().slice(0,10),
   end=1380+physical,out=`${String(Math.floor(end/60)%24).padStart(2,'0')}:${String(end%60).padStart(2,'0')}:00`;
  await capturedClock(f.employmentId,next,'in','23:00:00',next,555);await capturedClock(f.employmentId,next,'out',out,afterNext,555);
  const toilSource=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:next}));
  if(!toilSource?.calculation)throw Error('Expected separate rounded duration source');
  await owner.db.update(s.payComponent).set({archivedAt:new Date()}).where(eq(s.payComponent.id,f.earningId));
  await calculateOvertimePatternDay(ctx,{employmentId:f.employmentId,date:next,expectedCurrentRevision:toilSource.source.revision,
   reason:'Fictional rounded TOIL review after cash mapping archival'});
  const duration=await withTenant(ctx,tx=>resolveOvertimeToilDurationTx(tx,ctx,{employmentId:f.employmentId,date:next}));
  expect(duration).toMatchObject({kind:'formula',minutes:150,afterShiftMinutes:150});
  await accrueToil(ctx,{employmentId:f.employmentId,workedDate:next});
  const [credit]=await owner.db.select().from(s.toilAccrual).where(and(eq(s.toilAccrual.employmentId,f.employmentId),eq(s.toilAccrual.workedDate,next)));
  expect(credit).toMatchObject({status:'active',otMinutes:150,daysCredited:'1.00'});
  const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.toilAccrualId,credit.id));
  expect(claim).toMatchObject({mode:'toil',coverageKind:'policyPhysical'});
  await reverseLeaveCredit(ctx,{accrualId:credit.id,reason:'Fictional rounded TOIL reversal'});
  expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.id)))[0].releasedAt).not.toBeNull();
 });

 it('refuses rounded TOIL when a dated next-month allocation already belongs to a later cutoff Payroll period',async()=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  const today=new Date(todayInKualaLumpur()+'T00:00:00Z'),
   sourceDate=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+2,0)).toISOString().slice(0,10),
   childDate=new Date(Date.parse(sourceDate+'T00:00:00Z')+86400000).toISOString().slice(0,10),
   carriedPeriod=new Date(Date.UTC(Number(childDate.slice(0,4)),Number(childDate.slice(5,7)),1)).toISOString().slice(0,7);
  const f=await fixture('auto','12','actual',false,undefined,555,true,{mode:'up',step:30},125,'latest',false,sourceDate);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  const proof=await withTenant(ctx,tx=>resolveOvertimeToilDurationTx(tx,ctx,{employmentId:f.employmentId,date:sourceDate}));
  expect(proof).toMatchObject({kind:'formula',minutes:150,audit:{datedAllocations:[
   {date:sourceDate,minutes:60},{date:childDate,minutes:90}]}});
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:carriedPeriod});
  await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:sourceDate})).rejects.toThrow('Payroll for this worked period has already started');
  expect(await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId))).toEqual([]);
  const source=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:sourceDate}));
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,source!.source.id))).toEqual([]);
  await deleteDraftBatch(ctx,{batchId:batch.batchId});
  await accrueToil(ctx,{employmentId:f.employmentId,workedDate:sourceDate});
  const credits=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
  expect(credits).toMatchObject([{workedDate:sourceDate,otMinutes:150,daysCredited:'1.00'}]);
  const later=await createBatch(ctx,{companyId:b.companyId,payPeriod:carriedPeriod});
  await expect(reverseLeaveCredit(ctx,{accrualId:credits[0].id,reason:'Fictional cross-month reversal must retain child cutoff protection'}))
   .rejects.toThrow('payroll for that month has already been started');
  expect((await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,credits[0].id)))[0].status).toBe('active');
  expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,source!.source.id)))[0].releasedAt).toBeNull();
  await deleteDraftBatch(ctx,{batchId:later.batchId});
  await reverseLeaveCredit(ctx,{accrualId:credits[0].id,reason:'Fictional canonical release after removing the later cutoff Payroll draft'});
  expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,source!.source.id)))[0].releasedAt).not.toBeNull();
 });
});
