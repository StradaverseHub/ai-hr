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

/** Per-file bindings remain live: individual cases can replace ctx after entitlement changes. */
export function createAttendancePolicyStorageFixtures(state: {readonly b: Base; readonly ctx: SessionContext; readonly day: (offset: number) => string}) {
  const day = state.day;


async function capturedClock(employmentId:string,date:string,direction:'in'|'out',time:string,captureDate=date,millisecond=0){
 const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:state.b.tenantId,employmentId,attendanceDate:date,
  direction,requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(Date.parse(captureDate+'T'+time+'+08:00')+millisecond)}).returning();
 return (direction==='in'?checkInTx:checkOutTx)(state.ctx,{employmentId,date,time,clockCaptureId:capture.id,preciseOrder:true});
}
async function fixture(approval:'manual'|'auto'='manual',fixedHourlyRate?:string,autoMethod:'actual'|'preApproved'|'intersect'='actual',currentManual=false,moneyScope?:'cap'|'dayMapping'|'dayTier'|'sessionTier'|'dayCharge'|'sessionCharge'|'moneyResource',captureMillisecond=0,financial=false,rounding:AttendanceGroupPolicy['overtime']['rounding']={mode:'none',step:null},financialMinutes=120,direction:'earliest'|'latest'='earliest',mixedCompatible:boolean|'datedRates'=false,sourceDateOverride?:string,unclocked=false){
 const ruleId=(await ensureStandardRule(state.ctx)).id;
 const worker=await hireEmployee(state.ctx,{person:{fullName:'Fictional policy storage',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:state.b.companyId,
  departmentId:state.b.deptA,employmentType:'full_time',hiredOn:day(-10)});
 const shift=await createShift(state.ctx,{code:'POLICY_'+randomUUID().slice(0,6),name:'Fictional after-shift storage fixture',startTime:unclocked&&financial?'00:00':'09:00',endTime:unclocked&&financial?'00:01':'18:00',
  breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId});
 await assignDefaultShift(state.ctx,{employmentId:worker.employmentId,shiftId:shift.id});
 let earning:{id:string};
 if(financial){
  await setCompensation(state.ctx,{employmentId:worker.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:day(-10)});
  const pack=requirePackFor('MY'),seed=pack.payComponents.defaults.find(row=>row.code===pack.payComponents.backfillCodes.overtime)!;
  earning=await createPayComponent(state.ctx,{...seed,code:'POLICY_OT',name:'Fictional policy earning',label:'Fictional policy earning'});
 }else [earning]=await owner.db.insert(s.payComponent).values({tenantId:state.b.tenantId,code:'POLICY_OT',name:'Fictional policy earning',kind:'allowance'}).returning();
 const definition=prepareOvertimeStarter('ot15','day',direction);definition.currency={code:'MYR',minorScale:2};
 definition.eligibility={id:'eligible',type:'constant',value:true};definition.rates[0].when={id:'rate_eligible',type:'constant',value:true};
 const tier=definition.rates[0].tiers[0];tier.mapping={earningItemId:earning.id,currency:'MYR'};
 if(tier.payment.method!=='hourly'||tier.payment.rate.type!=='hourlyRate')throw Error('Retain the standard fixture formula');
 tier.payment.rate.divisorMinutes={id:'divisor',unit:'minutes',type:'literal',value:'480'};
 if(fixedHourlyRate!==undefined)tier.payment.rate={id:'fictional_hourly',unit:'moneyPerHour',type:'literal',value:fixedHourlyRate,currency:'MYR'};
 if(moneyScope==='cap')definition.paymentCap={id:'parent_cap',type:'literal',unit:'money',currency:'MYR',value:'4'};
 if(moneyScope==='dayMapping')definition.moneyRounding={stage:'dayMapping',mode:'halfUp'};
 if(moneyScope==='dayTier'||moneyScope==='sessionTier'){
  definition.rates[0].accumulation=moneyScope==='dayTier'?'day':'session';tier.to='10';
  tier.payment.multiplier={id:'first_multiplier',type:'literal',unit:'scalar',value:'1'};
  definition.rates[0].tiers.push({...structuredClone(tier),id:'second_tier',from:'10',to:null,
   payment:{...tier.payment,rate:{id:'second_rate',type:'literal',unit:'moneyPerHour',currency:'MYR',value:'24'},
    multiplier:{id:'second_multiplier',type:'literal',unit:'scalar',value:'1'}}});
 }
 if(moneyScope==='dayCharge'||moneyScope==='sessionCharge')tier.payment={method:'flat',basis:moneyScope==='dayCharge'?'day':'session',
  chargeId:'one_parent_charge',amount:{id:'parent_charge_amount',type:'literal',unit:'money',currency:'MYR',value:'25'}};
 if(moneyScope==='moneyResource')definition.deductions=[{id:'one_parent_money_resource',resource:'postOtBreak',basis:'day',unit:'money',targetEarningItemId:earning.id,
  when:{id:'resource_when',type:'constant',value:true},amount:{id:'resource_amount',type:'literal',unit:'money',currency:'MYR',value:'1'}}];
 const draft=await saveOvertimePatternDraft(state.ctx,{draft:{code:'POLICY_'+randomUUID().slice(0,8),name:'Fictional policy pattern',creationCompanyId:state.b.companyId,companyIds:[state.b.companyId],definition}});
 const validation=await validateOvertimePatternActivation(state.ctx,{versionId:draft.versionId,expectedRevision:draft.revision});
 expect(validation.issues).toEqual([]);
 await activateOvertimePattern(state.ctx,{versionId:draft.versionId,expectedRevision:draft.revision,validationDigest:validation.validationDigest!,effectiveFrom:day(currentManual?0:1)});
 let compatibleVersionId=draft.versionId;
 if(mixedCompatible){
  const compatibleDefinition=structuredClone(definition);
  if(mixedCompatible==='datedRates'){
   const payment=compatibleDefinition.rates[0].tiers[0].payment;
   if(payment.method!=='hourly'||payment.rate.type!=='literal')throw Error('Retain the actual fixed hourly fixture');
   payment.rate.value='24';
  }
  const compatible=await saveOvertimePatternDraft(state.ctx,{draft:{code:'COMPATIBLE_'+randomUUID().slice(0,8),name:'Fictional separate compatible immutable formula',
   creationCompanyId:state.b.companyId,companyIds:[state.b.companyId],definition:compatibleDefinition}});
  const validated=await validateOvertimePatternActivation(state.ctx,{versionId:compatible.versionId,expectedRevision:compatible.revision});
  expect(validated.issues).toEqual([]);
  await activateOvertimePattern(state.ctx,{versionId:compatible.versionId,expectedRevision:compatible.revision,validationDigest:validated.validationDigest!,effectiveFrom:day(1)});
  compatibleVersionId=compatible.versionId;
 }
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:unclocked,splitAtMidnight:true,offsetLateness:false,approval,autoMethod,rounding,
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:mixedCompatible&&key==='rest'?compatibleVersionId:draft.versionId}])) as AttendanceGroupPolicy['overtime']['days']}};
 const revision=await scheduleAttendanceGroupPolicy(state.ctx,{companyId:state.b.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional storage fixture',policy});
 if(currentManual){
  // Declared historical fixture restoration ONLY: the genuine scheduling API above issued
  // this positive epoch prospectively. Restore a pre-existing active baseline before any
  // clock/request/decision so present-day Manual effects can be exercised without time travel.
  // This does not prove a historical scheduling/activation command, and enables no payment.
  const [issued]=await owner.db.select().from(s.attendanceGroupPolicyRevision).where(eq(s.attendanceGroupPolicyRevision.id,revision.id));
  expect(issued.activationEpoch).toBeGreaterThan(0);
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`ALTER TABLE attendance_group_policy_revision DISABLE TRIGGER attendance_group_policy_revision_guard`);
   await tx.update(s.attendanceGroupPolicyRevision).set({effectiveFrom:day(-1)})
    .where(eq(s.attendanceGroupPolicyRevision.id,revision.id));
   await tx.execute(sql`ALTER TABLE attendance_group_policy_revision ENABLE TRIGGER attendance_group_policy_revision_guard`);
  });
  const guards=await owner.db.execute(sql`select tgenabled from pg_trigger where tgrelid='attendance_group_policy_revision'::regclass
   and tgname in ('attendance_group_policy_revision_guard','zz_attendance_policy_activation_epoch') order by tgname`);
  expect(Array.from(guards).map(row=>row.tgenabled)).toEqual(['O','O']);
 }
 const sourceOffset=currentManual?0:financial&&day(2).slice(0,7)!==day(3).slice(0,7)?4:2;
 const sourceDate=sourceDateOverride??day(sourceOffset),nextDate=new Date(Date.parse(sourceDate+'T00:00:00Z')+86400000).toISOString().slice(0,10);
 if(mixedCompatible){
  await saveScheduleGroupControl(state.ctx,{ruleId,kind:'duty',enabled:true});
  await setRestDay(state.ctx,{employmentId:worker.employmentId,shiftDate:nextDate});
 }
 if(!unclocked){
 await capturedClock(worker.employmentId,sourceDate,'in',financial?'23:00:00':'23:50:00',sourceDate,captureMillisecond);
 const endMinute=1380+financialMinutes,financialOut=`${String(Math.floor(endMinute/60)%24).padStart(2,'0')}:${String(endMinute%60).padStart(2,'0')}:00`;
 await capturedClock(worker.employmentId,sourceDate,'out',financial?financialOut:'00:10:00',nextDate,captureMillisecond);
 }
 return {...worker,ruleId,revisionId:revision.id,versionId:draft.versionId,policy,sourceDate,earningId:earning.id,compatibleVersionId};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function header(tx:Tx,f:Fixture,count:number,patch:Partial<typeof s.attendanceOvertimeCalculation.$inferInsert>={},sourceDate=day(2)){
 const source=await lockOvertimeSourceTx(tx,state.ctx,{employmentId:f.employmentId,date:sourceDate});
 const [saved]=await tx.insert(s.attendanceOvertimeCalculation).values({tenantId:state.b.tenantId,companyId:state.b.companyId,sourceId:source.id,ordinal:source.revision+1,
  bindingKind:'attendanceGroupPolicy',policyRevisionId:f.revisionId,policyPartCount:count,versionId:null,assignmentId:null,
  inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64),referenceDigest:'c'.repeat(64),outcome:'refused',durationOutcome:'refused',durationInputDigest:null,
  currency:'MYR',minorScale:2,approvalStatus:'unknown',transferable:false,reason:'Fictional structural proposal; no final approval or pay',...patch}).returning();
 return {saved,source};
}
function part(f:Fixture,calculationId:string,sequence=0):typeof s.attendanceOvertimePolicyPart.$inferInsert{
 return {calculationId,tenantId:state.b.tenantId,companyId:state.b.companyId,sequence,calendarDate:day(2+sequence),dayClass:'normal',moneyDay:'workday',versionId:f.versionId,
  inputDigest:'a'.repeat(64),rawMinutes:10,allocatedPayableMinutes:10,
  sourceIntervals:[sequence===0?{from:1430,to:1440}:{from:1440,to:1450}],calendarReferences:['fictional:calendar:normal:'+day(2+sequence)],
  durationEvidence:{authority:'proposalOnly',steps:[]}};
}
  return {capturedClock, fixture, header, part};
}
