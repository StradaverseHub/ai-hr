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

 it.each(['requested','system_calculated','smaller_of','greater_of'] as const)('retains a real scoped unclocked-work %s final effect without captured clocks or scalar landing',async method=>{
  await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:0,lateAfter:'09:00',
   halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:method});
  // This uses the SAME declared private historical baseline fixture as the Manual tests:
  // policy was genuinely scheduled then effectiveFrom restored with guards back on before work.
  // It is not evidence of a historical activation command or a ready unclocked financial path.
  const f=await fixture('manual','12','actual',true,undefined,0,false,{mode:'none',step:null},120,'earliest',false,undefined,true),
   date=day(0),midnight=Date.parse(date+'T00:00:00+08:00'),end=Math.max(midnight+1,Math.min(midnight+3600000,Date.now()-1));
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional unclocked-work final reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),
   reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:3,code:'UNCLOCKED_'+randomUUID().slice(0,8),name:'Fictional actual-work review',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,
   stages:[{name:'Review actual-work testimony',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const reason='Fictional HR testimony of actual unclocked work, distinct from the requested overtime count.',
   work={completeWorkedDay:true as const,intervals:[{fromEpochMillisecond:midnight,toEpochMillisecond:end}]};
  const result=await requestAttendanceCorrection(ctx,{employmentId:f.employmentId,date,requestedOtMinutes:30,reason,unclockedWork:work});
  const [contract]=await withTenant(ctx,tx=>tx.select().from(s.attendancePolicyRequestContract)
   .where(eq(s.attendancePolicyRequestContract.correctionId,result.correctionId)));
  expect(contract.attestedWork).toMatchObject({authority:'hrAttestedWorkSubmission',correctionId:result.correctionId,
   tenantId:b.tenantId,employmentId:f.employmentId,date,work:{version:1,completeWorkedDay:true,sourceDate:date,reason,intervals:work.intervals}});
  expect(contract.attestedWork).not.toHaveProperty('captureId');
  expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,result.correctionId))).toEqual([]);
  await expect(withTenant(ctx,tx=>tx.update(s.attendancePolicyRequestContract).set({attestedWork:{}})
   .where(eq(s.attendancePolicyRequestContract.correctionId,result.correctionId)))).rejects.toThrow();
  expect(await owner.db.select().from(s.attendancePunch).innerJoin(s.attendance,eq(s.attendance.id,s.attendancePunch.attendanceId))
   .where(eq(s.attendance.employmentId,f.employmentId))).toEqual([]);
  expect(await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date}))).toBeNull();
  await decideAttendanceCorrection(reviewCtx,{correctionId:result.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  const physicalMinutes=Math.floor((end-midnight)/60000),expected=method==='requested'?30:method==='system_calculated'?physicalMinutes
   :method==='smaller_of'?Math.min(30,physicalMinutes):Math.max(30,physicalMinutes);
  const [effect]=await withTenant(ctx,tx=>tx.select().from(s.attendancePolicyAttestedEffect)
   .where(eq(s.attendancePolicyAttestedEffect.correctionId,result.correctionId)));
  expect(effect).toMatchObject({authority:'attestedActualWorkOnly',actorUserId:userId,approvedMinutes:expected,manualMethod:method,attestedWork:contract.attestedWork});
  const [receipt]=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,result.correctionId));
  expect(receipt.rawEvidence).toBeNull();
  expect(receipt.workflowEvidence).toMatchObject({unclockedEffect:{authority:'attestedActualWorkOnly',approved_minutes:expected},submittedAttestedWork:contract.attestedWork});
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,result.correctionId)))[0])
   .toMatchObject({status:'approved',approvedOtMinutes:expected,appliedAt:null});
  const [anchor]=await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,f.employmentId));
  expect(anchor).toMatchObject({id:effect.attendanceId,attestedWorkCorrectionId:result.correctionId,checkInAt:null,checkOutAt:null,
   workedMinutes:null,otMinutes:null,lateMinutes:null,earlyOutMinutes:null});
  expect(Object.keys(anchor.calcTrace??{})).toEqual(['overtimePattern']);expect(anchor.calcTrace).not.toHaveProperty('v');
  const current=await withTenant(ctx,tx=>recordedAttestedPolicyWorkTx(tx,ctx,{employmentId:f.employmentId,date}));
  if(!current)throw Error('Expected independent canonical attested-work source');
  expect(current.replay).toMatchObject({state:'known',attendanceId:anchor.id,correctionId:result.correctionId,
   actualWork:contract.attestedWork?.work});
  for(const forged of [
   {...current.source,punchCount:1},
   {...current.source,anchor:{...current.source.anchor,workedMinutes:physicalMinutes}},
   {...current.source,anchor:{...current.source.anchor,attestedWorkCorrectionId:randomUUID()}},
   {...current.source,ownerEffect:{...current.source.ownerEffect,attendance_id:randomUUID()}},
  ])expect(attendancePolicyAttestedWorkInput(current.context,current.approvals,ctx.tenantId,forged).state).toBe('unavailable');
  const changedContext=structuredClone(current.context);changedContext.schedule.breakMinutes++;
  expect(attendancePolicyAttestedWorkInput(changedContext,current.approvals,ctx.tenantId,current.source).state).toBe('unavailable');
  await expect(withTenant(ctx,tx=>tx.update(s.attendancePolicyAttestedEffect).set({approvedMinutes:999})
   .where(eq(s.attendancePolicyAttestedEffect.correctionId,result.correctionId)))).rejects.toThrow();
  expect(await owner.db.execute(sql`select has_function_privilege('ai_hr_app','app.attendance_workflow_final_effect(uuid,integer)','EXECUTE') as allowed`)).toMatchObject([{allowed:false}]);
 });

 it.each([...( ['cash','toil'] as const).flatMap(mode=>([3,4] as const).map(routingVersion=>({mode,routingVersion,multiple:false}))),{mode:'cash' as const,routingVersion:4 as const,multiple:true}])('settles disjoint approved-plan quantity through the actual $mode owner with v$routingVersion (combined=$multiple) while reserving original work',async({mode,routingVersion,multiple})=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  // Same explicitly declared private historical group baseline as the existing current
  // workflow fixtures. Formula activation and the request/final decision are genuine.
  const f=await fixture('auto','12','preApproved',true,multiple?'sessionCharge':undefined,555,true),p={employmentId:f.employmentId,date:f.sourceDate};
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional approved-plan reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,
   roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const workflow={companyId:b.companyId,code:'PLAN_FIN_'+randomUUID().slice(0,8),name:'Fictional positioned-plan review',
   applicationType:'self_overtime' as const,priority:100,criteria:{employeeIds:[f.employmentId]},active:true};
  if(routingVersion===4)await saveAttendanceWorkflow(ctx,{...workflow,routingVersion:4,cc:[],
   stages:[{name:'Review approved positions',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}]});
  else await saveAttendanceWorkflow(ctx,{...workflow,routingVersion:3,
   stages:[{name:'Review approved positions',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:90,plannedStartTime:'20:00',plannedEndTime:'21:30',reason:'Fictional approved plan disjoint from original 23:00 work'});
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  const [decided]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId));
  // The submitted plan stays 90 minutes even though the company scalar method would
  // choose the separate 120-minute actual day. No plan coordinate comes from that scalar.
  expect(decided).toMatchObject({requestedOtMinutes:90,approvedOtMinutes:90,otApprovalMethod:'system_calculated',appliedAt:null});
  if(multiple){
   const second=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:60,plannedStartTime:'21:00',plannedEndTime:'22:00',reason:'Fictional overlapping second approved plan'});
   await decideAttendanceCorrection(reviewCtx,{correctionId:second.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
   const beforePunches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId)).orderBy(asc(s.attendancePunch.id));
   const withdrawn=await cancelAttendanceApplication(reviewCtx,{correctionId:second.correctionId,kind:'withdrawn',reason:'Fictional review removes only the second approved plan'});
   expect(withdrawn).toEqual({status:'cancelled',reversed:false});
   const remaining=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
   expect(remaining?.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',payableNumerator:'90'});
   expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId)).orderBy(asc(s.attendancePunch.id))).toEqual(beforePunches);
   expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,second.correctionId))).toHaveLength(1);
   const replacement=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:60,plannedStartTime:'21:00',plannedEndTime:'22:00',reason:'Fictional newly reviewed second approved plan'});
   await decideAttendanceCorrection(reviewCtx,{correctionId:replacement.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  }
  const expectedMinutes=multiple?120:90;
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!read?.calculation||!read.evidence||!read.policyParts)throw Error('Expected canonical approved-plan settlement parent');
  expect(read.calculation,JSON.stringify(read.evidence.evidence)).toMatchObject({outcome:'ready',durationOutcome:'ready',payableNumerator:String(expectedMinutes),transferable:true});
  expect(read.policyParts.map(row=>[row.rawMinutes,row.allocatedPayableMinutes,row.sourceIntervals])).toEqual([[0,0,[]]]);
  const review=await withTenant(ctx,tx=>readOvertimePatternCalculationTx(tx,ctx,p));
  expect(review?.policyPayableParts).toEqual([{sequence:0,calendarDate:p.date,minutes:expectedMinutes}]);

  const proof=read.evidence.evidence.policyCapturedCoverage as {countBasis:string;minutes:number;intervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};
  if(multiple)expect(read.evidence.evidence.policyCapturedCoverage).toMatchObject({planQuantity:{plan:{intervals:[{from:1200,to:1320}],references:expect.arrayContaining([expect.objectContaining({correctionId:request.correctionId})])}}});
  if(multiple){const retained=JSON.parse(JSON.stringify(read.evidence.evidence.policyCapturedCoverage));expect(retained.planQuantity.plan.references).toHaveLength(2);}
  const midnight=Date.parse(p.date+'T00:00:00+08:00');
  expect(proof).toMatchObject({countBasis:'approvedPlanWithIndependentWorkedDay',minutes:expectedMinutes});
  expect(proof.intervals).toEqual([{fromEpochMillisecond:midnight+1380*60000+555,toEpochMillisecond:midnight+1500*60000+555}]);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  if(mode==='cash'){
   const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7),scope:{employmentIds:[f.employmentId]}}),transfer={...p,expectedCalculationId:read.calculation.id,
    expectedSourceRevision:read.source.revision,batchId:batch.batchId,reason:'Fictional separate planned quantity cash election'};
   const paid=await transferOvertimePatternToPayroll(ctx,transfer);
   expect(await transferOvertimePatternToPayroll(ctx,transfer)).toMatchObject({status:'unchanged',settlementId:paid.settlementId});
   await expect(cancelAttendanceApplication(reviewCtx,{correctionId:request.correctionId,kind:'withdrawn',reason:'Fictional active cash must protect approved plan'})).rejects.toThrow();
   await generatePayslips(ctx,{batchId:batch.batchId});
   const [slip]=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batch.batchId),eq(s.payslip.employmentId,f.employmentId)));
   expect(slip.overtimePay).toBe(multiple?'25.00':'27.00');
   await expect(accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date})).rejects.toThrow('already reserved for cash');
   await closeBatch(ctx,{batchId:batch.batchId});
  }else{
   const credit=await accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date});
   expect(credit.daysCredited).toBe(0.5);
   const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.toilAccrualId,credit.accrualId));
   expect(claim).toMatchObject({mode:'toil',coverageKind:'policyPhysical',coverageCalculationId:read.calculation.id});
   await reverseLeaveCredit(ctx,{accrualId:credit.accrualId,reason:'Fictional planned quantity canonical release'});
   expect((await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.id)))[0].releasedAt).not.toBeNull();
  }
 });

 it('withdraws a retained prospective plan after a genuine later policy revision without reviving old financial authority',async()=>{
  const f=await fixture('auto','12','preApproved',false,undefined,555,true),p={employmentId:f.employmentId,date:f.sourceDate};
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional retained plan reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,
   roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:4,code:'RETAIN_PLAN_'+randomUUID().slice(0,7),name:'Fictional retained plan approval',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,cc:[],
   stages:[{name:'Review plan',mode:'sequential',sources:[{kind:'specific_employee',employmentIds:[reviewer.employmentId]}],hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:90,plannedStartTime:'20:00',plannedEndTime:'21:30',reason:'Fictional prospective plan under the original revision'});
  expect(await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'})).toMatchObject({deferred:true});
  const [contract]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,request.correctionId));
  const receipt=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId));
  const punches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId)).orderBy(asc(s.attendancePunch.id));
  const nextPolicy=structuredClone(f.policy);nextPolicy.overtime.autoMethod='intersect';
  const replacement=await scheduleAttendanceGroupPolicy(ctx,{companyId:b.companyId,ruleId:f.ruleId,expectedOrdinal:1,effectiveFrom:p.date,
   reason:'Fictional genuine future policy replacement before the planned work date',policy:nextPolicy});
  expect(contract.policyBinding?.revisionId).toBe(f.revisionId);expect(replacement.id).not.toBe(f.revisionId);
  await cancelAttendanceApplication(reviewCtx,{correctionId:request.correctionId,kind:'withdrawn',reason:'Fictional HR withdrawal preserves the superseded plan evidence'});
  expect((await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId)))[0].status).toBe('cancelled');
  expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId))).toEqual(receipt);
  expect((await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,request.correctionId)))[0]).toEqual(contract);
  expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,f.employmentId)).orderBy(asc(s.attendancePunch.id))).toEqual(punches);
  const fresh=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:90,plannedStartTime:'20:00',plannedEndTime:'21:30',reason:'Fictional fresh plan binds the new revision'});
  const [freshContract]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,fresh.correctionId));
  expect(freshContract.policyBinding?.revisionId).toBe(replacement.id);
  expect(await owner.db.select().from(s.overtimeSourceSettlement).innerJoin(s.attendanceOvertimeSource,eq(s.attendanceOvertimeSource.id,s.overtimeSourceSettlement.sourceId))
   .where(eq(s.attendanceOvertimeSource.employmentId,f.employmentId))).toEqual([]);
 });

 it('banks canonical policy TOIL when the actual earning mapping no longer permits cash replay',async()=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,0,true),p={employmentId:f.employmentId,date:f.sourceDate};
  const before=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!before?.calculation)throw Error('Expected original cash-ready source');
  expect(before.calculation.outcome).toBe('ready');
  await owner.db.update(s.payComponent).set({archivedAt:new Date()}).where(eq(s.payComponent.id,f.earningId));
  await calculateOvertimePatternDay(ctx,{...p,expectedCurrentRevision:before.source.revision,reason:'Fictional independent duration review after earning archival'});
  const after=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(after?.calculation).toMatchObject({outcome:'refused',durationOutcome:'ready',transferable:false,payableNumerator:'120'});
  expect(after?.lines).toEqual([]);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  await accrueToil(ctx,{employmentId:f.employmentId,workedDate:p.date});
  const [credit]=await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.employmentId,f.employmentId));
  expect(credit).toMatchObject({status:'active',workedDayKind:'workday',otMinutes:120,daysCredited:'1.00'});
  const [claim]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.toilAccrualId,credit.id));
  expect(claim).toMatchObject({mode:'toil',coverageKind:'policyPhysical',coverageCalculationId:after!.calculation!.id});
 });

 it('refuses equal-money changed references until explicit current financial recalculation',async()=>{
  await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,0,true),p={employmentId:f.employmentId,date:f.sourceDate};
  const original=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!original?.calculation)throw Error('Expected actual financial parent');
  const before=await withTenant(ctx,tx=>canonicalOvertimePayrollInputTx(tx,ctx,p));
  expect(attendancePolicyCashReplay(before)).toMatchObject({state:'known',amountMinorUnits:'3600'});
  await owner.db.update(s.payComponent).set({name:'Fictional renamed earning reference'}).where(eq(s.payComponent.id,f.earningId));
  const current=await withTenant(ctx,tx=>canonicalOvertimePayrollInputTx(tx,ctx,p));
  expect(attendancePolicyCashReplay(current)).toMatchObject({state:'known',amountMinorUnits:'3600'});
  expect(current.referenceDigest).not.toBe(before.referenceDigest);
  const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
  const transfer={...p,expectedCalculationId:original.calculation.id,expectedSourceRevision:original.source.revision,
   batchId:batch.batchId,reason:'Fictional same-money stale reference must refuse'};
  await expect(transferOvertimePatternToPayroll(ctx,transfer)).rejects.toMatchObject({code:'stale'});
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,original.source.id))).toEqual([]);
  expect(await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{...p,revisionId:original.calculation!.id}))).toEqual(original);
  await calculateOvertimePatternDay(ctx,{...p,expectedCurrentRevision:original.source.revision,reason:'Fictional explicit changed-reference review'});
  const updated=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!updated?.calculation)throw Error('Expected reviewed current parent');
  expect(updated.source.revision).toBe(original.source.revision+1);
  await expect(transferOvertimePatternToPayroll(ctx,transfer)).rejects.toMatchObject({code:'stale'});
  expect(await transferOvertimePatternToPayroll(ctx,{...transfer,expectedCalculationId:updated.calculation.id,
   expectedSourceRevision:updated.source.revision})).toMatchObject({status:'transferred'});
 });
 it('requires real financial scope for a ready policy source even when its employee can see Attendance',async()=>{
  await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
  const f=await fixture('auto','12','actual',false,undefined,0,true),p={employmentId:f.employmentId,date:f.sourceDate};
  const userId=await createAppUser(b.tenantId,f.personId,'employee');
  const self:SessionContext={...ctx,userId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  await expect(withTenant(self,tx=>canonicalOvertimePayrollInputTx(tx,self,p))).rejects.toMatchObject({code:'permission'});
  await expect(withTenant(self,tx=>readOvertimeCalculationTx(tx,self,p))).rejects.toMatchObject({code:'permission'});
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.tenantId,b.tenantId))).toEqual([]);
 });

 it('refuses an oversized complete retained witness before any calculation header or line can be written',async()=>{
  const f=await fixture('auto','12'),p={employmentId:f.employmentId,date:day(2)};
  const before=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));if(!before?.calculation)throw Error('Expected actual retained source');
  // Deliberately injected trusted-reader metadata tests the storage refusal boundary only;
  // it does not claim a new current source capability or a genuine large payroll fixture.
  const reader:typeof canonicalOvertimeInputTx=async(tx,actor,input)=>{
   const snapshot=await canonicalOvertimeInputTx(tx,actor,input);
   snapshot.policyPricingFacts={...snapshot.policyPricingFacts,[day(50)]:{
    basicSalary:{state:'known',value:'5000',provenance:{owner:'personnel',reference:'x'.repeat(2097152),asOf:input.date,basis:'recorded'}},
    calculationBase:{state:'unknown',reason:'unavailable'}}};
   return snapshot;
  };
  const calculator=createOvertimeCalculationOwner(reader);
  await expect(withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p);
   return calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:before.source.revision,reason:'Fictional bounded complete evidence refusal'});
  })).rejects.toMatchObject({code:'unavailable',message:'Complete overtime evidence exceeds its storage budget. Review the source and formula complexity.'});
  expect(await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p))).toEqual(before);
 });
});
