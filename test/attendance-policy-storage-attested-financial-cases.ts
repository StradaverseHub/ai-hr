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


export function registerAttestedFinancialCases(mode:'cash'|'toil'){
 if(mode!=='cash'&&mode!=='toil')throw new Error('One exact attested financial mode required');
let b:Base,ctx:SessionContext;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});
const {capturedClock,fixture,header,part}=createAttendancePolicyStorageFixtures({get b(){return b;},get ctx(){return ctx;},day});

type Fixture=Awaited<ReturnType<typeof fixture>>;
describe('immutable non-payable policy part storage',()=>{
 it.each([...( ['cash','toil'] as const).flatMap(mode=>[
  ...(['requested','system_calculated','smaller_of','greater_of'] as const).map(method=>({mode,method,roundMode:'none' as const,physical:120,requested:60})),
  ...(['up','nearest'] as const).flatMap(roundMode=>(['requested','system_calculated'] as const).map(method=>({mode,method,roundMode,
   physical:roundMode==='up'?125:135,requested:roundMode==='up'?65:75}))),
 ]).map(row=>({...row,routingVersion:3 as const})),
  {mode:'cash' as const,method:'requested' as const,roundMode:'none' as const,physical:120,requested:60,routingVersion:4 as const},
  {mode:'toil' as const,method:'system_calculated' as const,roundMode:'up' as const,physical:125,requested:65,routingVersion:4 as const},
 ].filter(row=>row.mode===mode))('carries real HR-attested unclocked work through $mode with frozen $method and $roundMode rounding and v$routingVersion',async({mode,method,roundMode,physical,requested,routingVersion})=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'00:00',workEnd:'00:01',breakMinutes:0,lateAfter:'00:00',
   halfDayBefore:'00:01',workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:method});
  // Same declared private historical GROUP baseline restoration as the four Manual probes.
  // Seed an already active historical formula as well; all business/database clocks remain
  // real. This is financial integration coverage, not proof of historical API activation.
  const rounding:AttendanceGroupPolicy['overtime']['rounding']=roundMode==='none'?{mode:'none',step:null}:{mode:roundMode,step:30};
  const f=await fixture('manual','12','actual',true,undefined,0,true,rounding,physical,roundMode==='nearest'?'latest':'earliest',false,day(-1),true,true),
   p={employmentId:f.employmentId,date:f.sourceDate},midnight=Date.parse(p.date+'T00:00:00+08:00');
  const actual={completeWorkedDay:true as const,intervals:[{fromEpochMillisecond:midnight+60000+555,toEpochMillisecond:midnight+(1+physical)*60000}],
   requestedIntervals:[{fromEpochMillisecond:midnight+(1+physical-requested)*60000+777,toEpochMillisecond:midnight+(1+physical)*60000}]};
  const requestedWinner=method==='requested'||method==='smaller_of',physicalMinutes=requestedWinner?requested:physical,
   expectedMinutes=roundMode==='none'?physicalMinutes:requestedWinner?90:150,
   expectedMoney=roundMode==='none'?(requestedWinner?'18.00':'36.00'):(requestedWinner?'27.00':'45.00');
  expect(actual.intervals[0].toEpochMillisecond).toBeLessThan(Date.now());
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional financial actual-work reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,
   roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const workflow={companyId:b.companyId,code:'UNCLOCKED_FIN_'+randomUUID().slice(0,8),name:'Fictional actual-work financial review',
   applicationType:'self_overtime' as const,priority:100,criteria:{employeeIds:[f.employmentId]},active:true};
  if(routingVersion===4)await saveAttendanceWorkflow(ctx,{...workflow,routingVersion:4,cc:[],
   stages:[{name:'Review complete actual work',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}]});
  else await saveAttendanceWorkflow(ctx,{...workflow,routingVersion:3,
   stages:[{name:'Review complete actual work',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const future={...actual,intervals:actual.intervals.map(span=>({fromEpochMillisecond:span.fromEpochMillisecond+2*86400000,toEpochMillisecond:span.toEpochMillisecond+2*86400000})),
   requestedIntervals:actual.requestedIntervals.map(span=>({fromEpochMillisecond:span.fromEpochMillisecond+2*86400000,toEpochMillisecond:span.toEpochMillisecond+2*86400000}))};
  await expect(requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:requested,reason:'Fictional still-future work must refuse',unclockedWork:future}))
   .rejects.toThrow('completed intervals');
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:requested,reason:'Fictional complete actual-work day with original millisecond endpoints',unclockedWork:actual});
  expect(await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p))).toBeNull();
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  // Bypass only the JS entry point to prove the independent, ACTIVE SQL clock guard.
  // Same authorized actor/date/policy/interval lengths as the successful request; only instants differ.
  const [submitted]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId));
  const refusedId=randomUUID();let refused:unknown;
  try{await withTenant(ctx,tx=>tx.insert(s.attendanceCorrection).values({...submitted,id:refusedId,status:'pending',approvedOtMinutes:null,otApprovalMethod:null,decidedByEmploymentId:null,decidedAt:null,appliedAt:null,
   originalClockSnapshot:{...submitted.originalClockSnapshot!,unclockedWork:{...submitted.originalClockSnapshot!.unclockedWork!,intervals:future.intervals,requestedIntervals:future.requestedIntervals}}}));}catch(error){refused=error;}
  const sqlRefusal=refused as {cause?:{code?:string;message?:string};code?:string;message?:string};
  expect(sqlRefusal?.cause?.code??sqlRefusal?.code).toBe('23514');
  expect(sqlRefusal?.cause?.message??sqlRefusal?.message).toBe('Unclocked work intervals must be completed and ordered in the dated period');
  expect(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,refusedId))).toEqual([]);
  expect(await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,refusedId))).toEqual([]);
  expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,refusedId))).toEqual([]);
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!read?.calculation||!read.evidence||!read.policyParts)throw Error('Expected canonical attested financial parent');
  expect(read.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true,payableNumerator:String(expectedMinutes),approvalStatus:'approved'});
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(snapshot.policyMoneyScope).toBeUndefined();
  const substitutedScope=structuredClone(snapshot);substitutedScope.policyMoneyScope='identicalDefinitions';
  expect(attendancePolicyPricingProposal(substitutedScope)).toMatchObject({state:'unavailable',reason:'pricingScopeUnavailable'});
  expect(attendancePolicyDurationReplay(snapshot)).toMatchObject({state:'known',minutes:expectedMinutes});
  const coverage=attendancePolicyCapturedCoverageProposal({tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,
   sourceId:read.source.id,calculationId:read.calculation.id,date:p.date},snapshot);
  if(coverage.state!=='prepared'||coverage.countBasis!=='attestedBoundaryFloor')throw Error('Expected DISTINCT attested source geometry');
  expect(coverage).toMatchObject({authority:'attestedCountCoverageProposalOnly',minutes:expectedMinutes,correctionId:request.correctionId});
  expect(coverage.intervals).toEqual(requestedWinner?actual.requestedIntervals:actual.intervals);
  if(roundMode!=='none')expect(coverage.countAttribution).toMatchObject({state:'known',physicalMinutes,roundedMinutes:expectedMinutes-physicalMinutes,minutes:expectedMinutes});
  expect(coverage.intervals.reduce((sum,row)=>sum+row.toEpochMillisecond-row.fromEpochMillisecond,0)).toBe(physicalMinutes*60000-(requestedWinner?777:555));
  if(requestedWinner)expect(coverage.allocations[0]).toMatchObject({requestedIntervalIndex:0,requestedFromEpochMillisecond:actual.requestedIntervals[0].fromEpochMillisecond});
  expect(snapshot.policyRawEffectSource?.attested?.anchor.calcTrace).toBeNull();
  expect(coverage.allocations.every(row=>!('inCaptureId' in row)&&!('inPunchId' in row))).toBe(true);
  expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.attendanceId,read.source.attendanceId))).toEqual([]);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  if(mode==='cash'&&method==='requested'&&roundMode==='none')for(const kind of ['owner','interval','requested','footprint'] as const){
   let attempted='',failure:unknown;
   try{await withTenant(ctx,async tx=>{
    const {saved}=await header(tx,f,read.policyParts!.length,{inputDigest:read.calculation!.inputDigest,
     approvalDigest:read.calculation!.approvalDigest,referenceDigest:read.calculation!.referenceDigest},p.date);attempted=saved.id;
    const forged=structuredClone(read.evidence!);delete forged.evidence.policyFinancialContract;delete forged.evidence.policyFinancialDurationContract;
    const proof=attendancePolicyCapturedCoverageProposal({tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,
     sourceId:saved.sourceId,calculationId:saved.id,date:p.date},await canonicalOvertimeInputTx(tx,ctx,p));
    if(proof.state!=='prepared'||proof.countBasis!=='attestedBoundaryFloor')throw Error('Expected true attested geometry before forgery');
    if(kind==='owner')proof.correctionId=randomUUID();
    if(kind==='interval')proof.allocations[0].attestedIntervalIndex=16;
    if(kind==='requested')proof.allocations[0].requestedIntervalIndex=16;
    if(kind==='footprint')proof.allocations[0].fromEpochMillisecond++;
    forged.evidence.policyCapturedCoverage=proof;
    await tx.insert(s.attendanceOvertimeCalculationEvidence).values({calculationId:saved.id,tenantId:b.tenantId,companyId:b.companyId,
     inputs:forged.inputs,evidence:forged.evidence});
    await tx.insert(s.attendanceOvertimePolicyPart).values(read.policyParts!.map(part=>({...part,calculationId:saved.id})));
   });}catch(error){failure=error;}
   expect(failure).toBeDefined();
   const chain=(failure as {cause?:{code?:string;message?:string};code?:string;message?:string});
   expect(chain.cause?.code??chain.code).toBe('23514');
   expect(chain.cause?.message??chain.message).toMatch(/attested|requested|footprint/i);
   expect(await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,attempted))).toEqual([]);
  }
  if(mode==='cash'){
   await setStatutoryProfileMY(ctx,{personId:f.personId,icNumber:'900101011234'});
   const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7),scope:{employmentIds:[f.employmentId]}}),transfer={...p,
    expectedCalculationId:read.calculation.id,expectedSourceRevision:read.source.revision,batchId:batch.batchId,reason:'Fictional attested Payroll transfer'};
   const first=await transferOvertimePatternToPayroll(ctx,transfer);
   expect(await transferOvertimePatternToPayroll(ctx,transfer)).toMatchObject({status:'unchanged',settlementId:first.settlementId});
   await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date})).rejects.toThrow('already reserved for cash');
   await generatePayslips(ctx,{batchId:batch.batchId});
   expect((await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batch.batchId),eq(s.payslip.employmentId,f.employmentId))))[0].overtimePay).toBe(expectedMoney);
   await closeBatch(ctx,{batchId:batch.batchId});await expect(transferOvertimePatternToPayroll(ctx,transfer)).rejects.toThrow();
   await expect(requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:requested,
    reason:'Fictional closed Payroll cannot accept another actual-work testimony',unclockedWork:actual}))
    .rejects.toThrow('closed payroll');
   await expect(cancelAttendanceApplication(reviewCtx,{correctionId:request.correctionId,kind:'cancelled',reason:'Fictional closed Payroll must retain original HR approval'})).rejects.toThrow();
   expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId)))[0].status).toBe('approved');
  }else{
   await owner.db.update(s.payComponent).set({archivedAt:new Date()}).where(eq(s.payComponent.id,f.earningId));
   await calculateOvertimePatternDay(ctx,{...p,expectedCurrentRevision:read.source.revision,reason:'Fictional salary-free attested duration after cash mapping archival'});
   const duration=await withTenant(ctx,tx=>canonicalOvertimeToilInputTx(tx,ctx,p));
   expect(duration.policyFormulaInput).toBeUndefined();expect(duration.policyPricingFacts).toBeUndefined();
   expect(attendancePolicyDurationReplay(duration)).toMatchObject({state:'known',minutes:expectedMinutes});
   await accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date});
   const [credit]=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
   expect(credit).toMatchObject({otMinutes:expectedMinutes,daysCredited:requestedWinner?'0.50':'1.00',workedDayKind:'workday',status:'active'});
   await expect(cancelAttendanceApplication(reviewCtx,{correctionId:request.correctionId,kind:'withdrawn',reason:'Fictional banked credit must be reversed first'})).rejects.toThrow();
   expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId)))[0].status).toBe('approved');
   const current=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!current?.calculation)throw Error('Expected retained duration header');
   const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
   await expect(transferOvertimePatternToPayroll(ctx,{...p,expectedCalculationId:current.calculation.id,expectedSourceRevision:current.source.revision,
    batchId:batch.batchId,reason:'Fictional attested same-source cash exclusion'})).rejects.toThrow();
   await deleteDraftBatch(ctx,{batchId:batch.batchId});await reverseLeaveCredit(ctx,{accrualId:credit.id,reason:'Fictional reviewed attested credit reversal'});
   expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,read.source.id)))[0].releasedAt).not.toBeNull();
   // A real dated schedule change must stale current financial authority, while retaining
   // the original statement for withdrawal. The replacement keeps the same worked eligibility
   // but has a different real shift identity; a fresh workflow binds that new context.
   const replacementShift=await createShift(ctx,{code:'HR_REVIEW_'+randomUUID().slice(0,6),name:'Fictional replacement HR review shift',
    startTime:'00:00',endTime:'00:01',breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId:f.ruleId});
   await assignDefaultShift(ctx,{employmentId:f.employmentId,shiftId:replacementShift.id});
   expect(await withTenant(ctx,tx=>recordedAttestedPolicyWorkTx(tx,ctx,p))).toBeNull();
   // A real HR approval can be withdrawn after the financial owner releases it. Its
   // original testimony/effect/history remain immutable; a fresh workflow owns the replacement.
   await cancelAttendanceApplication(reviewCtx,{correctionId:request.correctionId,kind:'withdrawn',reason:'Fictional review of the complete unclocked-work statement'});
   expect(await withTenant(ctx,tx=>recordedAttestedPolicyWorkTx(tx,ctx,p))).toBeNull();
   expect(await canSubmitUnclockedAttendanceWork(ctx,f.employmentId,p.date)).toBe(true);
   const historic=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{...p,revisionId:current.calculation!.id}));
   expect(historic?.calculation).toEqual(current.calculation);expect(historic?.policyParts).toEqual(current.policyParts);
   const replacement=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:requested,
    reason:'Fictional fresh complete HR statement after withdrawal',unclockedWork:actual});
   await decideAttendanceCorrection(reviewCtx,{correctionId:replacement.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
   const fresh=await withTenant(ctx,tx=>recordedAttestedPolicyWorkTx(tx,ctx,p));
   expect(fresh?.replay).toMatchObject({state:'known',correctionId:replacement.correctionId});
   await accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date});
   const [nextCredit]=await owner.db.select().from(s.toilAccrual).where(and(eq(s.toilAccrual.employmentId,f.employmentId),eq(s.toilAccrual.status,'active')));
   expect(nextCredit).toMatchObject({otMinutes:expectedMinutes,daysCredited:requestedWinner?'0.50':'1.00'});expect(nextCredit.id).not.toBe(credit.id);
   await reverseLeaveCredit(ctx,{accrualId:nextCredit.id,reason:'Fictional replacement HR statement credit reversal'});

  }
 });

});
}
