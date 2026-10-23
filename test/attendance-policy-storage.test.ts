import {requestLeave,decideLeave} from '../core/leave';
import {saveScheduleGroupControl} from '../core/schedule-group-controls';
import {recordedAttestedPolicyWorkTx} from '../packs/attendance/policy-attested-work-source';
import {attendancePolicyAttestedWorkInput} from '../packs/attendance/policy-attested-work-input';
import {createBatch,createPayComponent,transferOvertimePatternToPayroll,readPayrollOvertimePatternCashTx,generatePayslips,closeBatch,deleteDraftBatch,resetProcessedBatch} from '../packs/payroll/service';
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

let b:Base,ctx:SessionContext;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});

async function capturedClock(employmentId:string,date:string,direction:'in'|'out',time:string,captureDate=date,millisecond=0){
 const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:b.tenantId,employmentId,attendanceDate:date,
  direction,requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(Date.parse(captureDate+'T'+time+'+08:00')+millisecond)}).returning();
 return (direction==='in'?checkInTx:checkOutTx)(ctx,{employmentId,date,time,clockCaptureId:capture.id,preciseOrder:true});
}
async function fixture(approval:'manual'|'auto'='manual',fixedHourlyRate?:string,autoMethod:'actual'|'preApproved'|'intersect'='actual',currentManual=false,moneyScope?:'cap'|'dayMapping'|'dayTier'|'sessionTier'|'dayCharge'|'sessionCharge'|'moneyResource',captureMillisecond=0,financial=false,rounding:AttendanceGroupPolicy['overtime']['rounding']={mode:'none',step:null},financialMinutes=120,direction:'earliest'|'latest'='earliest',mixedCompatible:boolean|'datedRates'=false,sourceDateOverride?:string,unclocked=false){
 const ruleId=(await ensureStandardRule(ctx)).id;
 const worker=await hireEmployee(ctx,{person:{fullName:'Fictional policy storage',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,
  departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-10)});
 const shift=await createShift(ctx,{code:'POLICY_'+randomUUID().slice(0,6),name:'Fictional after-shift storage fixture',startTime:unclocked&&financial?'00:00':'09:00',endTime:unclocked&&financial?'00:01':'18:00',
  breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId});
 await assignDefaultShift(ctx,{employmentId:worker.employmentId,shiftId:shift.id});
 let earning:{id:string};
 if(financial){
  await setCompensation(ctx,{employmentId:worker.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:day(-10)});
  const pack=requirePackFor('MY'),seed=pack.payComponents.defaults.find(row=>row.code===pack.payComponents.backfillCodes.overtime)!;
  earning=await createPayComponent(ctx,{...seed,code:'POLICY_OT',name:'Fictional policy earning',label:'Fictional policy earning'});
 }else [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'POLICY_OT',name:'Fictional policy earning',kind:'allowance'}).returning();
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
 const draft=await saveOvertimePatternDraft(ctx,{draft:{code:'POLICY_'+randomUUID().slice(0,8),name:'Fictional policy pattern',creationCompanyId:b.companyId,companyIds:[b.companyId],definition}});
 const validation=await validateOvertimePatternActivation(ctx,{versionId:draft.versionId,expectedRevision:draft.revision});
 expect(validation.issues).toEqual([]);
 await activateOvertimePattern(ctx,{versionId:draft.versionId,expectedRevision:draft.revision,validationDigest:validation.validationDigest!,effectiveFrom:day(currentManual?0:1)});
 let compatibleVersionId=draft.versionId;
 if(mixedCompatible){
  const compatibleDefinition=structuredClone(definition);
  if(mixedCompatible==='datedRates'){
   const payment=compatibleDefinition.rates[0].tiers[0].payment;
   if(payment.method!=='hourly'||payment.rate.type!=='literal')throw Error('Retain the actual fixed hourly fixture');
   payment.rate.value='24';
  }
  const compatible=await saveOvertimePatternDraft(ctx,{draft:{code:'COMPATIBLE_'+randomUUID().slice(0,8),name:'Fictional separate compatible immutable formula',
   creationCompanyId:b.companyId,companyIds:[b.companyId],definition:compatibleDefinition}});
  const validated=await validateOvertimePatternActivation(ctx,{versionId:compatible.versionId,expectedRevision:compatible.revision});
  expect(validated.issues).toEqual([]);
  await activateOvertimePattern(ctx,{versionId:compatible.versionId,expectedRevision:compatible.revision,validationDigest:validated.validationDigest!,effectiveFrom:day(1)});
  compatibleVersionId=compatible.versionId;
 }
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:unclocked,splitAtMidnight:true,offsetLateness:false,approval,autoMethod,rounding,
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:mixedCompatible&&key==='rest'?compatibleVersionId:draft.versionId}])) as AttendanceGroupPolicy['overtime']['days']}};
 const revision=await scheduleAttendanceGroupPolicy(ctx,{companyId:b.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional storage fixture',policy});
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
  await saveScheduleGroupControl(ctx,{ruleId,kind:'duty',enabled:true});
  await setRestDay(ctx,{employmentId:worker.employmentId,shiftDate:nextDate});
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
 const source=await lockOvertimeSourceTx(tx,ctx,{employmentId:f.employmentId,date:sourceDate});
 const [saved]=await tx.insert(s.attendanceOvertimeCalculation).values({tenantId:b.tenantId,companyId:b.companyId,sourceId:source.id,ordinal:source.revision+1,
  bindingKind:'attendanceGroupPolicy',policyRevisionId:f.revisionId,policyPartCount:count,versionId:null,assignmentId:null,
  inputDigest:'a'.repeat(64),approvalDigest:'b'.repeat(64),referenceDigest:'c'.repeat(64),outcome:'refused',durationOutcome:'refused',durationInputDigest:null,
  currency:'MYR',minorScale:2,approvalStatus:'unknown',transferable:false,reason:'Fictional structural proposal; no final approval or pay',...patch}).returning();
 return {saved,source};
}
function part(f:Fixture,calculationId:string,sequence=0):typeof s.attendanceOvertimePolicyPart.$inferInsert{
 return {calculationId,tenantId:b.tenantId,companyId:b.companyId,sequence,calendarDate:day(2+sequence),dayClass:'normal',moneyDay:'workday',versionId:f.versionId,
  inputDigest:'a'.repeat(64),rawMinutes:10,allocatedPayableMinutes:10,
  sourceIntervals:[sequence===0?{from:1430,to:1440}:{from:1440,to:1450}],calendarReferences:['fictional:calendar:normal:'+day(2+sequence)],
  durationEvidence:{authority:'proposalOnly',steps:[]}};
}
describe('immutable non-payable policy part storage',()=>{
 it('reads current policy TOIL source without salary or cash earning mappings',async()=>{
  const f=await fixture('auto');await setModule(b.tenantId,'toil','active');const actor=adminCtx(b);
  const forbidden:string[]=[];let reads=0,formulaStateReads=0;
  await withTenant(actor,async tx=>{
   const guarded=new Proxy(tx,{get(target,key){
    if(key==='select')return (...args:Parameters<Tx['select']>)=>{
     const query=target.select(...args);
     return new Proxy(query,{get(builder,property){
      if(property==='from')return (table:unknown)=>{
       reads++;if(table===s.overtimePatternVersionState)formulaStateReads++;
       if(table===s.compensation||table===s.payComponent){forbidden.push(table===s.compensation?'salary':'cashMapping');throw Error('Forbidden policy TOIL price dependency');}
       return builder.from(table as Parameters<typeof builder.from>[0]);
      };
      const value=Reflect.get(builder,property,builder);return typeof value==='function'?value.bind(builder):value;
     }});
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
   }}) as Tx;
   const snapshot=await canonicalOvertimeToilInputTx(guarded,actor,{employmentId:f.employmentId,date:day(2)});
   expect(attendancePolicyDurationReplay(snapshot)).toMatchObject({state:'known',minutes:20});
  });
  expect(reads).toBeGreaterThan(0);expect(formulaStateReads).toBeGreaterThan(0);expect(forbidden).toEqual([]);
 });

 it('permits a current self subject barrier without configuration authority, and denies unrelated or revoked principals',async()=>{
  const f=await fixture(),userId=await createAppUser(b.tenantId,f.personId,'employee');
  const self:SessionContext={...ctx,userId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  const [before]=await owner.db.select().from(s.overtimePatternEpoch).where(eq(s.overtimePatternEpoch.tenantId,b.tenantId));
  const barrier=(actor:SessionContext,employmentId=f.employmentId)=>withTenant(actor,tx=>tx.execute(sql`select app.lock_attendance_policy_execution_context(${employmentId}::uuid,${day(2)}::date)`));
  await barrier(self);
  await expect(withTenant(self,tx=>tx.execute(sql`select app.lock_overtime_configuration(${b.tenantId}::uuid)`))).rejects.toThrow();
  const [after]=await owner.db.select().from(s.overtimePatternEpoch).where(eq(s.overtimePatternEpoch.tenantId,b.tenantId));expect(after).toEqual(before);
  const other=await hireEmployee(ctx,{person:{fullName:'Fictional unrelated barrier subject',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-10)});
  await expect(barrier(self,other.employmentId)).rejects.toThrow();
  await expect(barrier(adminCtx(await seedBase()))).rejects.toThrow();
  await owner.db.delete(s.roleAssignment).where(and(eq(s.roleAssignment.appUserId,userId),eq(s.roleAssignment.tenantId,b.tenantId)));
  await expect(barrier(self)).rejects.toThrow();
 });
 it('rechecks a revoked self principal after actually waiting on the configuration epoch',async()=>{
  const f=await fixture(),userId=await createAppUser(b.tenantId,f.personId,'employee');
  const self:SessionContext={...ctx,userId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  const [before]=await owner.db.select().from(s.overtimePatternEpoch).where(eq(s.overtimePatternEpoch.tenantId,b.tenantId));
  let release!:()=>void,held!:()=>void,holdFailed!:(error:unknown)=>void,holdingPid=0;
  const hold=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>((resolve,reject)=>{held=resolve;holdFailed=reject;});
  const holding=owner.db.transaction(async tx=>{
   const [backend]=await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[];holdingPid=backend.pid;
   await tx.execute(sql`select tenant_id from public.overtime_pattern_epoch where tenant_id=${b.tenantId}::uuid for update`);
   held();await hold;
  }).catch(error=>{holdFailed(error);throw error;});
  try{await reached;}catch(error){await holding.catch(()=>{});throw error;}
  const waiting=withTenant(self,tx=>tx.execute(sql`select app.lock_attendance_policy_execution_context(${f.employmentId}::uuid,${day(2)}::date)`));
  void waiting.catch(()=>{});let observed=false,observationError:unknown;
  try{
   const until=Date.now()+5000;
   while(Date.now()<until){
    const [state]=await owner.db.execute(sql`select exists(select 1 from pg_stat_activity where datname=current_database()
     and ${holdingPid}::integer=any(pg_blocking_pids(pid))) as blocked`) as unknown as {blocked:boolean}[];
    if(state.blocked){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
   }
   if(observed)await owner.db.delete(s.roleAssignment).where(and(eq(s.roleAssignment.appUserId,userId),eq(s.roleAssignment.tenantId,b.tenantId)));
  }catch(error){observationError=error;}finally{release();}
  const [closed,outcome]=await Promise.allSettled([holding,waiting]);
  if(observationError)throw observationError;if(closed.status==='rejected')throw closed.reason;
  expect(observed).toBe(true);expect(outcome.status).toBe('rejected');
  if(outcome.status!=='rejected')throw Error('Revocation must be rechecked after the real wait');
  const error=outcome.reason as {code?:unknown;cause?:{code?:unknown}};expect(error.code??error.cause?.code).toBe('42501');
  const [after]=await owner.db.select().from(s.overtimePatternEpoch).where(eq(s.overtimePatternEpoch.tenantId,b.tenantId));expect(after).toEqual(before);
 });
 it('rechecks a revoked import subject after an observed shared-epoch wait',async()=>{
  const f=await fixture(),userId=await createAppUser(b.tenantId,f.personId,'employee');
  const self:SessionContext={...ctx,userId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  const [before]=await owner.db.select().from(s.overtimePatternEpoch).where(eq(s.overtimePatternEpoch.tenantId,b.tenantId));
  let release!:()=>void,held!:()=>void,holdFailed!:(error:unknown)=>void,holdingPid=0;
  const hold=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>((resolve,reject)=>{held=resolve;holdFailed=reject;});
  const holding=owner.db.transaction(async tx=>{
   const [backend]=await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[];holdingPid=backend.pid;
   await tx.execute(sql`select tenant_id from public.overtime_pattern_epoch where tenant_id=${b.tenantId}::uuid for update`);
   held();await hold;
  }).catch(error=>{holdFailed(error);throw error;});
  try{await reached;}catch(error){await holding.catch(()=>{});throw error;}
  const waiting=withTenant(self,tx=>lockAttendancePolicyImportTx(tx,self,[{employmentId:f.employmentId,date:day(2)}]));
  void waiting.catch(()=>{});let observed=false,observationError:unknown;
  try{
   const until=Date.now()+5000;
   while(Date.now()<until){
    const [state]=await owner.db.execute(sql`select exists(select 1 from pg_stat_activity where datname=current_database()
     and ${holdingPid}::integer=any(pg_blocking_pids(pid))) as blocked`) as unknown as {blocked:boolean}[];
    if(state.blocked){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
   }
   if(observed)await owner.db.delete(s.roleAssignment).where(and(eq(s.roleAssignment.appUserId,userId),eq(s.roleAssignment.tenantId,b.tenantId)));
  }catch(error){observationError=error;}finally{release();}
  const [closed,outcome]=await Promise.allSettled([holding,waiting]);
  if(observationError)throw observationError;if(closed.status==='rejected')throw closed.reason;
  expect(observed).toBe(true);expect(outcome.status).toBe('rejected');
  if(outcome.status!=='rejected')throw Error('Revocation must be rechecked after the real wait');
  const error=outcome.reason as {code?:unknown;cause?:{code?:unknown}};expect(error.code??error.cause?.code).toBe('42501');
  const [after]=await owner.db.select().from(s.overtimePatternEpoch).where(eq(s.overtimePatternEpoch.tenantId,b.tenantId));expect(after).toEqual(before);
 });
 // This injected canonical-reader fixture proves writer structure only, not actual capture authority,
 // final-effect approval or payable execution. Actual real-clock journeys remain required.
 it('replays current captured duration independently of cash facts and rejects equal-count reference changes',async()=>{
  const f=await fixture('auto');
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  const proof=attendancePolicyDurationReplay(snapshot);expect(proof).toMatchObject({state:'known',minutes:20,authority:'durationProposalReplayOnly'});
  if(!snapshot.policyFormulaInput)throw Error('Expected canonical formula source');
  const durationOnly=structuredClone(snapshot);durationOnly.policyDurationFormulaInput=attendancePolicyDurationFormulaProjection(snapshot.policyFormulaInput);
  durationOnly.policyFormulaInput=undefined;durationOnly.input.source.inputDigest='9'.repeat(64);durationOnly.referenceDigest='8'.repeat(64);
  delete durationOnly.input.facts.basicSalary;delete durationOnly.input.facts.calculationBase;
  expect(attendancePolicyCurrentDurationMatches(durationOnly,proof)).toBe(true);
  if(!snapshot.policyDurationFormulaInput)throw Error('Expected independent canonical duration metadata');
  const independent:IndependentPolicyDurationSource={source:{tenantId:snapshot.input.source.tenantId,employmentId:snapshot.input.source.employmentId,
   attendanceId:snapshot.input.source.attendanceId,date:snapshot.input.source.date},
   policyDurationFormulaInput:snapshot.policyDurationFormulaInput,attendanceGroupPolicy:snapshot.attendanceGroupPolicy,
   policyExecutionContext:snapshot.policyExecutionContext,policyClockSource:snapshot.policyClockSource,policyClockReview:snapshot.policyClockReview,
   policyClockMeasurements:snapshot.policyClockMeasurements,policyWorkInput:snapshot.policyWorkInput,policyApprovalInput:snapshot.policyApprovalInput,
   policyRawEffectSource:snapshot.policyRawEffectSource,policyExecutionProposal:snapshot.policyExecutionProposal};
  const cashReads:string[]=[];
  for(const key of ['input','policyFormulaInput','policyPricingFacts','referenceDigest'])Object.defineProperty(independent,key,{get(){cashReads.push(key);throw Error('Cash source must not be read');}});
  expect(attendancePolicyIndependentDurationReplay(independent)).toEqual(proof);
  expect(attendancePolicyIndependentDurationReplay({...independent,policyDurationFormulaInput:{state:'unavailable',authority:'durationSourceOnly',reason:'policyChanged'}})).toMatchObject({state:'unavailable',reason:'sourceUnavailable'});
  expect(cashReads).toEqual([]);

  const reordered=JSON.parse(JSON.stringify(snapshot,(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)
   ?Object.fromEntries(Object.entries(value).reverse()):value)) as typeof snapshot;
  expect(attendancePolicyCurrentDurationMatches(reordered,proof)).toBe(true);
  for(const mutate of [
   (x:typeof snapshot)=>{x.input.source.employmentId=randomUUID();},
   (x:typeof snapshot)=>{if(x.policyClockSource?.state==='known')x.policyClockSource.clocks[0].captureId=randomUUID();},
   (x:typeof snapshot)=>{if(x.policyDurationFormulaInput?.state==='known'&&x.policyDurationFormulaInput.references[0].state==='known')x.policyDurationFormulaInput.references[0].activeState.sequence++;},
   (x:typeof snapshot)=>{if(x.policyWorkInput?.state==='known')x.policyWorkInput.eligibleActualIntervals=[{from:1420,to:1440}];},
  ]){const changed=structuredClone(snapshot);mutate(changed);expect(attendancePolicyCurrentDurationMatches(changed,proof)).toBe(false);}
  const refused=structuredClone(snapshot);refused.policyDurationFormulaInput={authority:'durationSourceOnly',state:'unavailable',reason:'policyChanged'};
  expect(attendancePolicyCurrentDurationMatches(refused,proof)).toBe(false);
 });

 // Injected source-metadata probe: actual captures and policy/formula APIs still run. This
 // proves immutable retention of an independently read duration source, not TOIL readiness.
 it.each(['known','unavailable'] as const)('retains an explicit %s duration source through writer and historical replay',async state=>{
  const f=await fixture('auto'),p={employmentId:f.employmentId,date:day(2)};
  const reader:typeof canonicalOvertimeInputTx=async(tx,actor,input)=>{
   const snapshot=await canonicalOvertimeInputTx(tx,actor,input);
   if(!snapshot.policyFormulaInput)throw Error('Expected a complete cash formula source');
   snapshot.policyDurationFormulaInput=state==='known'?attendancePolicyDurationFormulaProjection(snapshot.policyFormulaInput)
    :{authority:'durationSourceOnly',state:'unavailable',reason:'policyChanged'};
   snapshot.policyExecutionProposal=attendancePolicyDurationExecutionProposal(snapshot.policyExecutionContext,snapshot.policyWorkInput,
    snapshot.policyDurationFormulaInput,snapshot.policyApprovalInput,actor.tenantId,snapshot.policyRawEffectSource);
   return snapshot;
  };
  const snapshot=await withTenant(ctx,tx=>reader(tx,ctx,p));
  const proof=attendancePolicyDurationReplay(snapshot);expect(proof.state).toBe(state);
  const calculator=createOvertimeCalculationOwner(reader);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional independent duration source retention'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.evidence?.evidence.policyDurationFormulaInput).toEqual(snapshot.policyDurationFormulaInput);
  expect(reviewed?.evidence?.evidence.policyDurationReplay).toEqual(proof);
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:state==='known'?'ready':'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);
 });

 it('retains canonical captured duration and immutable parts when a cash earning mapping is archived',async()=>{
  const f=await fixture('auto','12'),p={employmentId:f.employmentId,date:day(2)};
  const before=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(attendancePolicyCashReplay(before)).toMatchObject({state:'known',minutes:20,amountMinorUnits:'600'});
  const formula=before.policyFormulaInput;
  if(formula?.state!=='known'||formula.references[0]?.state!=='known')throw Error('Expected actual earning mapping');
  const earningId=formula.references[0].definition.rates[0].tiers[0].mapping.earningItemId;
  await owner.db.update(s.payComponent).set({archivedAt:new Date()}).where(eq(s.payComponent.id,earningId));
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(snapshot.policyDurationFormulaInput).toMatchObject({state:'known'});
  expect(attendancePolicyDurationReplay(snapshot)).toMatchObject({state:'known',minutes:20});
  expect(attendancePolicyCashReplay(snapshot)).toMatchObject({state:'unavailable',reason:'pricingUnavailable'});
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional independent duration after mapping archival'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.policyParts).toHaveLength(2);
  expect(reviewed?.evidence?.evidence.policyDurationReplay).toEqual(attendancePolicyDurationReplay(snapshot));
  expect(reviewed?.evidence?.evidence.policyCashReplay).toEqual(attendancePolicyCashReplay(snapshot));
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'ready',transferable:false});
  expect(reviewed?.lines).toEqual([]);
 });

 it('binds original captured milliseconds separately from the existing minute count attribution',async()=>{
  const f=await fixture('auto','12','actual',false,undefined,555),p={employmentId:f.employmentId,date:day(2)};
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional original millisecond count coverage'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!reviewed?.calculation)throw Error('Expected staged parent');
  const identity={tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,sourceId:reviewed.source.id,
   calculationId:reviewed.calculation.id,date:p.date};
  const coverage=attendancePolicyCapturedCoverageProposal(identity,snapshot);
  expect(coverage).toMatchObject({state:'prepared',countBasis:'capturedBoundaryFloor',minutes:20});
  if(coverage.state!=='prepared'||coverage.countBasis!=='capturedBoundaryFloor')throw Error('Expected captured source attribution');
  const midnight=Date.parse(p.date+'T00:00:00+08:00');
  expect(coverage.intervals).toEqual([{fromEpochMillisecond:midnight+1430*60000+555,toEpochMillisecond:midnight+1450*60000}]);
  expect(coverage.allocations.map(row=>row.minutes)).toEqual([10,10]);
  expect(coverage.allocations.every(row=>row.captureInEpochMillisecond===midnight+1430*60000+555
   &&row.captureOutEpochMillisecond===midnight+1450*60000+555)).toBe(true);
  expect(coverage.intervals.reduce((n,row)=>n+row.toEpochMillisecond-row.fromEpochMillisecond,0)).toBe(20*60000-555);
  expect(reviewed.evidence?.evidence.policyCapturedCoverage).toEqual(coverage);
  const substituted=structuredClone(snapshot);if(substituted.policyClockSource?.state!=='known')throw Error('Expected captures');
  substituted.policyClockSource.clocks[0].captureId=randomUUID();
  const changed=attendancePolicyCapturedCoverageProposal(identity,substituted);
  expect(changed).not.toEqual(coverage);
  const altered=structuredClone(reviewed.evidence);if(!altered||!reviewed.policyParts)throw Error('Expected complete stored evidence');
  altered.evidence.policyCapturedCoverage=changed;
  expect(recordedAttendancePolicyProposalPartsMatch(reviewed.source,reviewed.calculation,altered,reviewed.policyParts)).toBe(false);
  expect(reviewed.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true});expect(reviewed.lines).toHaveLength(2);
 });

 it.each(['capture','boundary','count','missingClock'] as const)('refuses forged %s capture evidence at actual deferred app-write commit',async kind=>{
  const f=await fixture('auto','12','actual',false,undefined,555),p={employmentId:f.employmentId,date:day(2)};
  const original=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!original?.calculation||!original.evidence||!original.policyParts)throw Error('Expected actual staged captured source');
  const acl=await owner.db.execute(sql`select has_function_privilege('ai_hr_app','app.attendance_policy_captured_coverage(uuid)','EXECUTE') as allowed`);
  expect(acl[0].allowed).toBe(false);
  let attempted='',failure:unknown;
  try{await withTenant(ctx,async tx=>{
   const {saved}=await header(tx,f,original.policyParts!.length,{inputDigest:original.calculation!.inputDigest,
    approvalDigest:original.calculation!.approvalDigest,referenceDigest:original.calculation!.referenceDigest});attempted=saved.id;
   const evidence=structuredClone(original.evidence!);
   // This independent captured-source forgery remains a refused structural parent, so it
   // does not claim a ready financial contract copied from a different calculation.
   delete evidence.evidence.policyFinancialContract;delete evidence.evidence.policyFinancialDurationContract;
   const proof=attendancePolicyCapturedCoverageProposal({tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,
    sourceId:saved.sourceId,calculationId:saved.id,date:p.date},await canonicalOvertimeInputTx(tx,ctx,p));
   if(proof.state!=='prepared'||proof.countBasis!=='capturedBoundaryFloor')throw Error('Expected original captured geometry');
   if(kind==='capture')proof.allocations[0].inCaptureId=randomUUID();
   if(kind==='boundary')proof.allocations[0].fromEpochMillisecond--;
   if(kind==='count')proof.allocations[0].minutes++;
   if(kind==='missingClock'){
    const source=evidence.evidence.policyClockSource;if(!source||typeof source!=='object'||!('clocks' in source)||!Array.isArray(source.clocks))throw Error('Expected full source clocks');
    source.clocks.pop();
   }
   evidence.evidence.policyCapturedCoverage=proof;
   await tx.insert(s.attendanceOvertimeCalculationEvidence).values({calculationId:saved.id,tenantId:b.tenantId,companyId:b.companyId,
    inputs:evidence.inputs,evidence:evidence.evidence});
   await tx.insert(s.attendanceOvertimePolicyPart).values(original.policyParts!.map(({createdAt,...row})=>({...row,calculationId:saved.id})));
  });}catch(error){failure=error;}
  const outer=failure as {cause?:{code?:unknown;message?:unknown}}|undefined;
  const cause=(outer?.cause??failure) as {code?:unknown;message?:unknown}|undefined;
  expect(cause?.code).toBe('23514');
  expect(String(cause?.message)).toContain(kind==='boundary'?'Captured footprint is not original source intersection'
   :kind==='count'?'Captured quantity changed':'Captured allocation boundary identity missing');
  expect(await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,attempted))).toEqual([]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,original.source.id))).toEqual([]);
 });

 it.each(['count','date','anchor'] as const)('rejects forged rounded %s evidence through the actual private SQL source owner',async kind=>{
  const f=await fixture('auto','12','actual',false,undefined,555,false,{mode:'up',step:30}),p={employmentId:f.employmentId,date:day(2)};
  const original=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!original?.calculation||!original.evidence||!original.policyParts)throw Error('Expected genuine rounded captured source');
  let attempted='',failure:unknown;
  try{await withTenant(ctx,async tx=>{
   const {saved}=await header(tx,f,original.policyParts!.length,{inputDigest:original.calculation!.inputDigest,
    approvalDigest:original.calculation!.approvalDigest,referenceDigest:original.calculation!.referenceDigest});attempted=saved.id;
   const snapshot=await canonicalOvertimeInputTx(tx,ctx,p),evidence=structuredClone(original.evidence!),
    parts=original.policyParts!.map(({createdAt,...row})=>({...structuredClone(row),calculationId:saved.id}));
   delete evidence.evidence.policyFinancialContract;delete evidence.evidence.policyFinancialDurationContract;
   const proof=attendancePolicyCapturedCoverageProposal({tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,
    sourceId:saved.sourceId,calculationId:saved.id,date:p.date},snapshot);
   if(proof.state!=='prepared'||proof.countBasis!=='capturedBoundaryFloor'||!proof.countAttribution)throw Error('Expected bound rounded source');
   if(kind==='count')proof.countAttribution.parts[0].roundedMinutes++;
   if(kind==='date'){
    const attributions=parts[0].durationEvidence.roundingCountAttributions;
    if(!Array.isArray(attributions)||!attributions[0]||typeof attributions[0]!=='object')throw Error('Expected dated rounded count attribution');
    attributions[0].calendarDate=day(3);
   }
   if(kind==='anchor'){
    const proposal=structuredClone(snapshot.policyExecutionProposal);
    if(proposal?.state!=='proposed'||proposal.duration.status!=='calculated'||!proposal.duration.classes[0].roundingCountAttribution)throw Error('Expected canonical count anchor');
    proposal.duration.classes[0].roundingCountAttribution.anchor.from++;
    evidence.evidence.policyExecutionProposal=proposal;
   }
   evidence.evidence.policyCapturedCoverage=proof;
   await tx.insert(s.attendanceOvertimeCalculationEvidence).values({calculationId:saved.id,tenantId:b.tenantId,companyId:b.companyId,
    inputs:evidence.inputs,evidence:evidence.evidence});
   await tx.insert(s.attendanceOvertimePolicyPart).values(parts);
  });}catch(error){failure=error;}
  const outer=failure as {cause?:{code?:unknown;message?:unknown}}|undefined,cause=(outer?.cause??failure) as {code?:unknown;message?:unknown}|undefined;
  expect(cause?.code).toBe('23514');
  expect(String(cause?.message)).toContain(kind==='count'?'Captured rounded count attribution changed'
   :kind==='date'?'Rounded dated part quantity changed':'Rounded quantity changed its existing dated source anchor');
  expect(await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,attempted))).toEqual([]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,original.source.id))).toEqual([]);
 });

 it('uses each dated child salary and binds next-day pay changes without changing duration',async()=>{
  const f=await fixture('auto');
  const [first,second]=await owner.db.insert(s.compensation).values([
   {tenantId:b.tenantId,employmentId:f.employmentId,basicSalary:'4000',currency:'MYR',validFrom:day(-10),validTo:day(3)},
   {tenantId:b.tenantId,employmentId:f.employmentId,basicSalary:'8000',currency:'MYR',validFrom:day(3)},
  ]).returning();
  const p={employmentId:f.employmentId,date:day(2)},read=()=>withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  const before=await read(),priced=attendancePolicyPricingProposal(before),duration=attendancePolicyDurationReplay(before),cash=attendancePolicyCashReplay(before);
  expect(cash).toMatchObject({state:'known',minutes:20,amountMinorUnits:'37500'});
  expect(attendancePolicyCurrentCashMatches(before,cash)).toBe(true);
  expect(before.policyPricingFacts?.[day(2)].basicSalary).toMatchObject({state:'known',value:'4000.00',provenance:{reference:first.id,asOf:day(2)}});
  expect(before.policyPricingFacts?.[day(3)].basicSalary).toMatchObject({state:'known',value:'8000.00',provenance:{reference:second.id,asOf:day(3)}});
  expect(priced).toMatchObject({state:'proposed',amountMinorUnits:'37500'});
  if(priced.state!=='proposed')throw Error('Expected exact dated pay facts');
  expect(priced.parts.map(row=>row.pricing.amountMinorUnits)).toEqual(['12500','25000']);
  await owner.db.update(s.compensation).set({basicSalary:'9000'}).where(eq(s.compensation.id,second.id));
  const after=await read();expect(attendancePolicyPricingProposal(after)).toMatchObject({state:'proposed',amountMinorUnits:'40625'});
  expect(after.input.source.inputDigest).not.toBe(before.input.source.inputDigest);expect(after.referenceDigest).not.toBe(before.referenceDigest);
  expect(attendancePolicyDurationReplay(after)).toEqual(duration);
  expect(attendancePolicyCurrentCashMatches(after,cash)).toBe(false);
 });

 it.each(['requested','system_calculated','smaller_of','greater_of'] as const)('replays current frozen Manual %s counts under a declared restored historical group baseline',async method=>{
  await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:0,lateAfter:'09:00',
   halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:method});
  const f=await fixture('manual','12','actual',true),p={employmentId:f.employmentId,date:day(0)};
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional current Manual reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin');
  const reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const employeeUserId=await createAppUser(b.tenantId,f.personId,'employee');
  const employeeCtx:SessionContext={...ctx,userId:employeeUserId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:3,code:'MANUAL_'+randomUUID().slice(0,8),name:'Fictional current Manual review',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,
   stages:[{name:'Review',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(employeeCtx,{employmentId:f.employmentId,date:p.date,requestedOtMinutes:10,
   plannedStartTime:'23:50',plannedEndTime:'00:00',requestKind:'self_overtime',reason:'Fictional current complete original ten-minute window'});
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  const expectedMinutes=method==='requested'||method==='smaller_of'?10:20;
  const [decision]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,request.correctionId));
  expect(decision).toMatchObject({status:'approved',otApprovalMethod:method,approvedOtMinutes:expectedMinutes,appliedAt:null});
  const [receipt]=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId));
  expect(receipt.rawEvidence).not.toBeNull();
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(snapshot.policyExecutionProposal).toMatchObject({state:'proposed',manualEvidence:{state:'known',method,systemMinutes:20,
   approvedMinutes:expectedMinutes,basis:expectedMinutes===10?'completeSubmittedWindow':'completeActualCount'},
   duration:{status:'calculated',payableMinutes:expectedMinutes}});
  const cash=attendancePolicyCashReplay(snapshot);expect(cash).toMatchObject({state:'known',minutes:expectedMinutes,amountMinorUnits:expectedMinutes===10?'300':'600'});
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   expect(await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional current Manual count replay'})).toMatchObject({status:'recorded'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.evidence?.evidence.policyCashReplay).toEqual(cash);
  expect(reviewed?.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true});
  expect(reviewed?.lines.length).toBeGreaterThan(0);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });

 it.each(['preApproved','intersect'] as const)('replays a real approved %s plan against its exact policy across a later unrelated epoch',async autoMethod=>{
  const f=await fixture('auto','12',autoMethod),p={employmentId:f.employmentId,date:day(2)};
  // A genuine later scheduled revision advances the shared epoch but is not effective on
  // this captured source day. No backdating, trigger bypass or restored policy is used here.
  await scheduleAttendanceGroupPolicy(ctx,{companyId:b.companyId,ruleId:f.ruleId,expectedOrdinal:1,
   effectiveFrom:day(4),reason:'Fictional later policy epoch outside this source date',policy:f.policy});
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional plan reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin');
  const reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  const employeeUserId=await createAppUser(b.tenantId,f.personId,'employee');
  const employeeCtx:SessionContext={...ctx,userId:employeeUserId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:3,code:'PLAN_'+randomUUID().slice(0,8),name:'Fictional dated plan review',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,
   stages:[{name:'Review',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(employeeCtx,{employmentId:f.employmentId,date:p.date,requestedOtMinutes:20,
   plannedStartTime:'23:50',plannedEndTime:'00:10',requestKind:'self_overtime',reason:'Fictional complete dated window'});
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  const [contract]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,request.correctionId));
  const [receipt]=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,request.correctionId));
  expect(receipt.rawEvidence).toBeNull(); // Genuine future deferral is not a current raw final effect.
  expect(receipt.workflowEvidence.submittedPolicy).toEqual(contract.policyBinding);
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(contract.visibleEpoch).toBeGreaterThan(snapshot.attendanceGroupPolicy!.activation.epoch);
  expect(snapshot.policyExecutionProposal).toMatchObject({state:'proposed',duration:{status:'calculated',payableMinutes:20},
   planEvidence:{state:'known',references:[{correctionId:request.correctionId}]}});
  const cash=attendancePolicyCashReplay(snapshot);expect(cash).toMatchObject({state:'known',minutes:20,amountMinorUnits:'600'});
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   expect(await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional complete approved plan replay'})).toMatchObject({status:'recorded'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.evidence?.evidence.policyCashReplay).toEqual(cash);
  expect(reviewed?.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true});
  expect(reviewed?.lines.length).toBeGreaterThan(0);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });

 it.each(['auto','manual'] as const)('records %s policy approval requirements independently of legacy scalar status',async approval=>{
  const f=await fixture(approval,'12'),p={employmentId:f.employmentId,date:day(2)};
  if(approval==='auto'){
   const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional pending plan reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,
    departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
   await createAppUser(b.tenantId,reviewer.personId,'hr_admin');
   const userId=await createAppUser(b.tenantId,f.personId,'employee');
   const employeeCtx:SessionContext={...ctx,userId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
   await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:3,code:'PENDING_'+randomUUID().slice(0,8),name:'Fictional independent pending plan',
    applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,
    stages:[{name:'Review',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
   await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
   await requestAttendanceCorrection(employeeCtx,{employmentId:f.employmentId,date:p.date,requestedOtMinutes:10,plannedStartTime:'23:50',plannedEndTime:'00:00',
    requestKind:'self_overtime',reason:'Fictional pending plan cannot change Auto actual approval requirement'});
  }
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  // Preserve the old scalar source facts; the policy header must use its own real contract.
  expect(snapshot.input.approval.status).toBe(approval==='auto'?'pending':'notRequired');
  if(approval==='auto')expect(attendancePolicyCashReplay(snapshot)).toMatchObject({state:'known',minutes:20,amountMinorUnits:'600'});
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   expect(await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional exact policy approval status'})).toMatchObject({status:'recorded'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.calculation).toMatchObject({approvalStatus:approval==='auto'?'notRequired':'unknown',outcome:approval==='auto'?'ready':'refused',durationOutcome:approval==='auto'?'ready':'refused',transferable:approval==='auto'});
  expect(reviewed?.lines.length).toBe(approval==='auto'?2:0);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });

 it.each(['cap','dayMapping'] as const)('prices whole-parent %s once across dated child allocations',async moneyScope=>{
  // Both formulas are genuinely activated and both dated allocations derive from actual
  // captured work. A parent cap of 4 must not become two caps; two half-cent slices must
  // not independently round to two cents when the parent mapping owns one cent.
  const f=await fixture('auto',moneyScope==='cap'?'12':'0.02','actual',false,moneyScope),p={employmentId:f.employmentId,date:day(2)};
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(attendancePolicyDurationReplay(snapshot)).toMatchObject({state:'known',minutes:20});
  const pricing=attendancePolicyPricingProposal(snapshot);
  expect(pricing).toMatchObject({state:'proposed',amountMinorUnits:moneyScope==='cap'?'400':'1'});
  if(pricing.state!=='proposed')throw Error('Expected one central parent money proposal');
  expect(pricing.parts.map(p=>p.pricing.amountMinorUnits).sort()).toEqual(moneyScope==='cap'?['200','200']:['0','1']);
  expect(attendancePolicyCashReplay(snapshot)).toMatchObject({state:'known',amountMinorUnits:moneyScope==='cap'?'400':'1'});
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   expect(await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional one-parent money scope'})).toMatchObject({status:'recorded'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.evidence?.evidence.policyPricingProposal).toEqual(pricing);
  expect(reviewed?.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true});
  expect(reviewed?.lines.length).toBeGreaterThan(0);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });

 it.each([
  ['dayTier','600'],['sessionTier','600'],['dayCharge','2500'],['sessionCharge','2500'],['moneyResource','500'],
 ] as const)('replays a genuine activated %s across both dates in one parent money scope',async(moneyScope,amount)=>{
  // The canonical capture, effective policy, activated formula and resource reader all run.
  // No restored policy or disabled trigger is involved in these prospective Auto cases.
  const f=await fixture('auto','12','actual',false,moneyScope),p={employmentId:f.employmentId,date:day(2)};
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(attendancePolicyDurationReplay(snapshot)).toMatchObject({state:'known',minutes:20});
  const pricing=attendancePolicyPricingProposal(snapshot),cash=attendancePolicyCashReplay(snapshot);
  expect(pricing).toMatchObject({state:'proposed',amountMinorUnits:amount});
  expect(cash).toMatchObject({state:'known',minutes:20,amountMinorUnits:amount});
  if(pricing.state!=='proposed')throw Error('Expected complete canonical parent price');
  expect(pricing.parts).toHaveLength(2);
  expect(pricing.parts.every(part=>part.pricing.moneyScope.kind==='parent'&&part.pricing.moneyScope.amountMinorUnits===amount)).toBe(true);
  if(moneyScope==='moneyResource'){
   expect(snapshot.input.resources.find(resource=>resource.resource==='postOtBreak')).toMatchObject({basis:'day',evidence:'policyCapacity',measure:{unit:'minutes',quantity:{state:'known',value:'20'}}});
   expect(pricing.parts[0].pricing.trace.filter(step=>step.kind==='deduction'&&step.id==='one_parent_money_resource')).toHaveLength(1);
  }
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   expect(await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional canonical parent money resource journey'})).toMatchObject({status:'recorded'});});
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.evidence?.evidence.policyPricingProposal).toEqual(pricing);
  expect(reviewed?.evidence?.evidence.policyCashReplay).toEqual(cash);
  expect(reviewed?.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true});
  expect(reviewed?.lines.length).toBeGreaterThan(0);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });

 it('records and replays exact central pricing and owned lines for both dated parts',async()=>{
  const f=await fixture('auto','12'),p={employmentId:f.employmentId,date:day(2)};
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  const pricing=attendancePolicyPricingProposal(snapshot);
  expect(pricing).toMatchObject({state:'proposed',authority:'policyPricingProposalOnly',amountMinorUnits:'600'});
  if(pricing.state!=='proposed')throw Error('Expected current captured pricing');
  expect(pricing.parts.map(row=>row.pricing.amountMinorUnits)).toEqual(['300','300']);
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  const recorded=await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   return calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional actual central price source replay'});});
  if(recorded.status!=='recorded')throw Error('Expected staged calculation');
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(reviewed?.evidence?.evidence.policyPricingProposal).toEqual(pricing);
  const [rawDay]=await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,f.employmentId));
  expect(rawDay.calcTrace?.executionPolicy).toMatchObject({revisionId:f.revisionId,employmentId:f.employmentId,sourceDate:p.date,companyId:b.companyId,authority:'datedPolicyOnly'});
  const cash=attendancePolicyCashReplay(snapshot);expect(cash).toMatchObject({state:'known',minutes:20,amountMinorUnits:'600'});
  expect(reviewed?.evidence?.evidence.policyCashReplay).toEqual(cash);
  expect(attendancePolicyCurrentCashMatches(snapshot,cash)).toBe(true);
  const reordered=JSON.parse(JSON.stringify(snapshot,(_key,value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)
   ?Object.fromEntries(Object.entries(value).reverse()):value)) as typeof snapshot;
  expect(attendancePolicyCurrentCashMatches(reordered,cash)).toBe(true);
  for(const field of ['inputDigest','approvalDigest'] as const){const changed=structuredClone(snapshot);changed.input.source[field]='9'.repeat(64);
   expect(attendancePolicyCurrentCashMatches(changed,cash)).toBe(false);}
  const changed=structuredClone(snapshot);changed.referenceDigest='8'.repeat(64);
  expect(attendancePolicyPricingProposal(changed)).toEqual(pricing);
  expect(attendancePolicyCurrentCashMatches(changed,cash)).toBe(false);
  expect(reviewed?.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',transferable:true});
  expect(reviewed?.lines).toHaveLength(2);
 });

 it('records a complete proposal part set atomically through the existing parent calculation writer',async()=>{
  const f=await fixture('auto');
  const calculator=createOvertimeCalculationOwner(async(tx,actor,p)=>{
   const snapshot=await canonicalOvertimeInputTx(tx,actor,p);
   snapshot.policyWorkInput={state:'known',authority:'sourceOnly',periodMinutes:4320,workedIntervals:[{from:1430,to:1450}],
    eligibleActualIntervals:[{from:1430,to:1450}],unpaidIntervals:[],lateOffsetIntervals:[],lateMinutes:0,earlyOutMinutes:0};
   snapshot.policyExecutionProposal=attendancePolicyExecutionProposal(snapshot.policyExecutionContext,snapshot.policyWorkInput,snapshot.policyFormulaInput);
   snapshot.input.source.inputDigest=createHash('sha256').update(JSON.stringify([snapshot.input.source.inputDigest,snapshot.policyWorkInput,snapshot.policyExecutionProposal])).digest('hex');
   return snapshot;
  });
  const result=await withTenant(ctx,async tx=>{
   const p={employmentId:f.employmentId,date:day(2)},prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   return calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional prepared source-part writer probe'});
  });
  if(result.status!=='recorded')throw Error('Expected a non-payable recorded proposal');
  const [saved]=await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,result.calculationId));
  expect(saved).toMatchObject({bindingKind:'attendanceGroupPolicy',policyRevisionId:f.revisionId,policyPartCount:2,outcome:'refused',durationOutcome:'refused',transferable:false,versionId:null,assignmentId:null});
  const parts=await owner.db.select().from(s.attendanceOvertimePolicyPart).where(eq(s.attendanceOvertimePolicyPart.calculationId,saved.id)).orderBy(asc(s.attendanceOvertimePolicyPart.sequence));
  expect(parts.map(part=>({sequence:part.sequence,date:part.calendarDate,raw:part.rawMinutes,allocated:part.allocatedPayableMinutes,inputDigest:part.inputDigest}))).toEqual([
   {sequence:0,date:day(2),raw:10,allocated:10,inputDigest:saved.inputDigest},{sequence:1,date:day(3),raw:10,allocated:10,inputDigest:saved.inputDigest}]);
  expect(parts.every(part=>part.durationEvidence.authority==='proposalOnly')).toBe(true);
  const reviewed=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  expect(reviewed?.policyParts).toEqual(parts);
  expect(await owner.db.select().from(s.attendanceOvertimeLine).where(eq(s.attendanceOvertimeLine.calculationId,saved.id))).toEqual([]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,saved.sourceId))).toEqual([]);
 });

 it('retains exact activated formula and earning references without substituting an assignment',async()=>{
  const f=await fixture(),snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  const source=snapshot.policyFormulaInput;expect(source?.state).toBe('known');if(source?.state!=='known')throw Error('Expected canonical formula source');
  expect(source.references).toHaveLength(3);
  for(const reference of source.references){
   expect(reference.state).toBe('known');if(reference.state!=='known')throw Error('Expected complete dated formula references');
   expect(reference.versionId).toBe(f.versionId);expect(reference.definition.currency).toEqual({code:'MYR',minorScale:2});
   expect(reference.activeState).toMatchObject({sequence:1,effectiveFrom:day(1)});expect(reference.earningReferences).toHaveLength(1);
   expect(reference.earningReferences[0].id).toBe(reference.definition.rates[0].tiers[0].mapping.earningItemId);
   expect(typeof reference.earningReferences[0].createdAt).toBe('string');
   expect(Object.hasOwn(reference,'assignmentId')).toBe(false);
  }
  const recorded=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  expect(recorded?.calculation).toMatchObject({outcome:'refused',transferable:false,versionId:null,assignmentId:null});
  expect(recorded?.evidence?.evidence).toMatchObject({policyFormulaInput:source});
 });
 it('holds referenced formula state through recording, then preserves its immutable evidence after a concurrent stop',async()=>{
  const f=await fixture(),api=createOvertimeCalculationOwner(canonicalOvertimeInputTx),p={employmentId:f.employmentId,date:day(2)};
  const before=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  const snapshotBefore=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  const [version]=await owner.db.select().from(s.overtimePatternVersion).where(eq(s.overtimePatternVersion.id,f.versionId));
  const detail=await getOvertimePattern(ctx,version.patternId),revision=detail!.versions.find(row=>row.id===f.versionId)!.revision;
  let release!:()=>void,preparedReady!:()=>void,prepareFailed!:(error:unknown)=>void,preparingPid=0;
  const hold=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>((resolve,reject)=>{preparedReady=resolve;prepareFailed=reject;});
  const recording=withTenant(ctx,async tx=>{
   const [backend]=await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[];preparingPid=backend.pid;
   const prepared=await api.prepareTx(tx,ctx,p);preparedReady();await hold;
   return api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:before!.source.revision,reason:'Fictional concurrent formula preservation'});
  }).catch(error=>{prepareFailed(error);throw error;});
  try{await reached;}catch(error){await recording.catch(()=>{});throw error;}
  const stopping=stopOvertimePatternVersion(ctx,{versionId:f.versionId,expectedRevision:revision,effectiveFrom:day(2),reason:'Fictional prospective formula stop'});
  void stopping.catch(()=>{});let observed=false,observationError:unknown;
  try{
   const until=Date.now()+5000;
   while(Date.now()<until){
    const [waiting]=await owner.db.execute(sql`select exists(select 1 from pg_stat_activity where datname=current_database()
     and ${preparingPid}::integer=any(pg_blocking_pids(pid))) as blocked`) as unknown as {blocked:boolean}[];
    if(waiting.blocked){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
   }
  }catch(error){observationError=error;}finally{release();}
  const [result]=await Promise.all([recording,stopping]);if(observationError)throw observationError;expect(observed).toBe(true);expect(result.status).toBe('recorded');
  const after=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,p));
  expect(after.referenceDigest).not.toBe(snapshotBefore.referenceDigest);
  expect(after.policyFormulaInput).toMatchObject({state:'known',references:[{state:'unavailable',reason:'formulaInactive'},{state:'unavailable',reason:'formulaInactive'},{state:'unavailable',reason:'formulaInactive'}]});
  const current=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(current?.evidence?.evidence).toMatchObject({policyFormulaInput:snapshotBefore.policyFormulaInput});
  const [retained]=await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,before!.calculation!.id));
  expect(retained).toEqual(before!.calculation);
 });

 it('retains the original assignment discriminator by default and permits an explicit empty refused policy result',async()=>{
  const f=await fixture();
  const normal=await withTenant(ctx,async tx=>{const {saved}=await header(tx,f,0,{bindingKind:undefined,policyRevisionId:null});return saved;});
  expect(normal).toMatchObject({bindingKind:'assignedPattern',policyRevisionId:null,policyPartCount:0,outcome:'refused',transferable:false});
  // The independent fixture uses another source rather than rewriting the immutable header.
  await capturedClock(f.employmentId,day(3),'in','23:50:00');
  const policy=await withTenant(ctx,async tx=>{
   const source=await lockOvertimeSourceTx(tx,ctx,{employmentId:f.employmentId,date:day(3)});
   const [saved]=await tx.insert(s.attendanceOvertimeCalculation).values({...normal,id:randomUUID(),sourceId:source.id,ordinal:source.revision+1,
    bindingKind:'attendanceGroupPolicy',policyRevisionId:f.revisionId,policyPartCount:0}).returning();return saved;
  });
  expect(policy).toMatchObject({bindingKind:'attendanceGroupPolicy',policyPartCount:0,outcome:'refused',durationOutcome:'refused',transferable:false});
 });
 it('stores both declared midnight parts beneath one parent, without creating a payment or moving its source head',async()=>{
  const f=await fixture();
  const {saved,source}=await withTenant(ctx,async tx=>{const parent=await header(tx,f,2);await tx.insert(s.attendanceOvertimePolicyPart).values([part(f,parent.saved.id),part(f,parent.saved.id,1)]);return parent;});
  const rows=await withTenant(ctx,tx=>tx.select().from(s.attendanceOvertimePolicyPart).where(eq(s.attendanceOvertimePolicyPart.calculationId,saved.id)).orderBy(asc(s.attendanceOvertimePolicyPart.sequence)));
  expect(rows.map(row=>({calculationId:row.calculationId,date:row.calendarDate,minutes:row.rawMinutes}))).toEqual([
   {calculationId:saved.id,date:day(2),minutes:10},{calculationId:saved.id,date:day(3),minutes:10}]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,source.id))).toEqual([]);
  expect(await owner.db.select().from(s.attendanceOvertimeLine).where(eq(s.attendanceOvertimeLine.calculationId,saved.id))).toEqual([]);
  const [after]=await owner.db.select().from(s.attendanceOvertimeSource).where(eq(s.attendanceOvertimeSource.id,source.id));
  expect(after).toEqual(source);
 });
 it('refuses an omitted declared part at commit instead of keeping a successful partial calculation',async()=>{
  const f=await fixture();let attempted='';
  await expect(withTenant(ctx,async tx=>{const {saved}=await header(tx,f,2);attempted=saved.id;await tx.insert(s.attendanceOvertimePolicyPart).values(part(f,saved.id));})).rejects.toThrow();
  expect(await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,attempted))).toEqual([]);
 });
 it.each(['digest','dayClass','version','fraction','overlap','count','provenance','authority'] as const)('refuses invalid %s evidence atomically',async kind=>{
  const f=await fixture();let attempted='';
  await expect(withTenant(ctx,async tx=>{
   const {saved}=await header(tx,f,1);attempted=saved.id;const row=part(f,saved.id);
   if(kind==='digest')row.inputDigest='d'.repeat(64);
   if(kind==='dayClass')row.moneyDay='rest_day';
   if(kind==='version')row.versionId=randomUUID();
   if(kind==='fraction')row.sourceIntervals=[{from:1430.5,to:1440}];
   if(kind==='overlap')row.sourceIntervals=[{from:1430,to:1438},{from:1435,to:1437}];
   if(kind==='count')row.rawMinutes=11;
   if(kind==='provenance')row.calendarReferences=[];
   if(kind==='authority')row.durationEvidence={} as never;
   await tx.insert(s.attendanceOvertimePolicyPart).values(row);
  })).rejects.toThrow();
  expect(await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,attempted))).toEqual([]);
 });
 it.each(['cash','toil'] as const)('refuses staged %s settlement at the owner and SQL boundaries',async mode=>{
  // Exercise the incomplete-proof boundary with the real TOIL module enabled; otherwise its
  // module gate correctly refuses before reaching the duration evidence being tested.
  if(mode==='toil'){await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);}
  const f=await fixture(),p={employmentId:f.employmentId,date:day(2)};
  const current=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!current?.calculation)throw Error('Expected the actual staged policy calculation');
  // Deliberately absent target IDs ensure this probe pins the POLICY admission boundary, not an
  // unrelated FK/target failure. A valid legacy TOIL/cash lifecycle is covered by consumer regressions.
  const targetId=randomUUID();const reservation:Parameters<typeof reserveOvertimeSettlementTx>[2]=mode==='cash'?{...p,mode,calculationId:current.calculation.id,payrollBatchId:targetId}
   :{...p,mode,toilAccrualId:targetId};
  await expect(withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,reservation))).rejects.toMatchObject({code:'unavailable',
   message:mode==='cash'?'Only a complete payable policy parent may settle in cash.':'The policy duration is not ready.'});
  let sqlError:unknown;
  try{await withTenant(ctx,tx=>tx.insert(s.overtimeSourceSettlement).values({tenantId:b.tenantId,companyId:b.companyId,sourceId:current.source.id,
   mode,calculationId:mode==='cash'?current.calculation!.id:null,ownerReference:{type:mode==='cash'?'payroll_batch':'toil_accrual',id:targetId},
   payrollBatchId:mode==='cash'?targetId:null,toilAccrualId:mode==='toil'?targetId:null}));}catch(error){sqlError=error;}
  const outer=sqlError as {cause?:{code?:unknown;message?:unknown}}|undefined;
  const cause=(outer?.cause??sqlError) as {code?:unknown;message?:unknown}|undefined;
  expect(cause?.code).toBe('23514');expect(String(cause?.message)).toContain('Complete current policy duration and approval required');
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,current.source.id))).toEqual([]);
 });
 it('refuses a payable policy header without its complete execution and financial evidence',async()=>{
  const f=await fixture();
  await expect(withTenant(ctx,tx=>header(tx,f,0,{outcome:'ready',durationOutcome:'ready',durationInputDigest:'d'.repeat(64),
   approvalStatus:'approved',transferable:true,payableNumerator:'20',payableDenominator:'1'}))).rejects.toThrow();
 });
 it('retains immutable evidence and exact current subject/financial read boundaries',async()=>{
  const f=await fixture();const {saved}=await withTenant(ctx,async tx=>{const result=await header(tx,f,1);await tx.insert(s.attendanceOvertimePolicyPart).values(part(f,result.saved.id));return result;});
  await expect(owner.db.update(s.attendanceOvertimePolicyPart).set({rawMinutes:9}).where(eq(s.attendanceOvertimePolicyPart.calculationId,saved.id))).rejects.toThrow();
  await expect(owner.db.delete(s.attendanceOvertimePolicyPart).where(eq(s.attendanceOvertimePolicyPart.calculationId,saved.id))).rejects.toThrow();
  const userId=await createAppUser(b.tenantId,f.personId,'employee');
  const self:SessionContext={...ctx,userId,personId:f.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  const read=(actor:SessionContext)=>withTenant(actor,tx=>tx.select({id:s.attendanceOvertimePolicyPart.calculationId}).from(s.attendanceOvertimePolicyPart)
   .where(eq(s.attendanceOvertimePolicyPart.calculationId,saved.id)).orderBy(asc(s.attendanceOvertimePolicyPart.sequence)));
  expect(await read(self)).toEqual([{id:saved.id}]);
  expect(await read(adminCtx(await seedBase()))).toEqual([]);
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional unrelated policy company'}).returning();
  const [unrelated]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'policy-storage-'+randomUUID()}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:unrelated.id,role:'hr_admin',companyId:other.id});
  expect(await read({...ctx,userId:unrelated.id,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:other.id}]})).toEqual([]);
  await owner.db.delete(s.roleAssignment).where(and(eq(s.roleAssignment.appUserId,ctx.userId!),eq(s.roleAssignment.tenantId,b.tenantId)));
  expect(await read(ctx)).toEqual([]);
 });
 it('records and independently reads one explicit financial parent with all dated lines and no assignment substitution',async()=>{
  const f=await fixture('auto','12'),p={employmentId:f.employmentId,date:day(2)};
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(ctx,async tx=>{const prepared=await calculator.prepareTx(tx,ctx,p),source=await lockOvertimeSourceTx(tx,ctx,p);
   await calculator.recordTx(tx,ctx,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional complete financial parent'});});
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  expect(read?.calculation).toMatchObject({bindingKind:'attendanceGroupPolicy',policyRevisionId:f.revisionId,versionId:null,
   assignmentId:null,outcome:'ready',durationOutcome:'ready',transferable:true,payableNumerator:'20',payableDenominator:'1',policyPartCount:2});
  expect(read?.policyParts?.map(part=>({date:part.calendarDate,minutes:part.allocatedPayableMinutes})))
   .toEqual([{date:day(2),minutes:10},{date:day(3),minutes:10}]);
  expect(read?.lines).toHaveLength(2);
  expect(read?.lines.map(row=>row.evidence)).toMatchObject([
   {sequence:0,partSequence:0,calendarDate:day(2),versionId:f.versionId,line:{amountMinorUnits:'300'}},
   {sequence:1,partSequence:1,calendarDate:day(3),versionId:f.versionId,line:{amountMinorUnits:'300'}}]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,read!.source.id))).toEqual([]);
 });
 it('consumes current independently recorded TOIL duration after earning archival while cash remains refused',async()=>{
  const f=await fixture('auto','12'),p={employmentId:f.employmentId,date:day(2)};
  await setModule(b.tenantId,'toil','active');const actor=adminCtx(b);
  const before=await withTenant(actor,tx=>canonicalOvertimeInputTx(tx,actor,p));
  if(before.policyFormulaInput?.state!=='known')throw Error('Expected activated actual formula references');
  const reference=before.policyFormulaInput.references.find(row=>row.state==='known');
  if(reference?.state!=='known')throw Error('Expected actual earning reference');
  await owner.db.update(s.payComponent).set({archivedAt:new Date()}).where(eq(s.payComponent.id,reference.definition.rates[0].tiers[0].mapping.earningItemId));
  const calculator=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await withTenant(actor,async tx=>{const prepared=await calculator.prepareTx(tx,actor,p),source=await lockOvertimeSourceTx(tx,actor,p);
   await calculator.recordTx(tx,actor,{prepared,expectedCurrentRevision:source.revision,reason:'Fictional duration independent of cash mapping'});});
  const read=await withTenant(actor,tx=>readOvertimeCalculationTx(tx,actor,p));
  expect(read?.calculation).toMatchObject({outcome:'refused',transferable:false,durationOutcome:'ready',payableNumerator:'20',payableDenominator:'1'});
  expect(read?.lines).toEqual([]);
  const historical=await withTenant(actor,tx=>readOvertimePolicyDurationTx(tx,actor,p));
  expect(historical?.contract).toMatchObject({state:'prepared',minutes:20,parts:[{calendarDate:day(2)},{calendarDate:day(3)}]});
  const current=await withTenant(actor,tx=>resolveOvertimeToilDurationTx(tx,actor,p));
  expect(current).toMatchObject({kind:'formula',minutes:20,afterShiftMinutes:20,recordedWorkedDayKind:'workday',
   audit:{datedAllocations:[{date:day(2),minutes:10,afterShiftMinutes:10},{date:day(3),minutes:10,afterShiftMinutes:10}]}});

 });

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

 it('banks mixed normal/rest credits once and expires only the unused dated balance after real half-day leave',async()=>{
  await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'leave','active');ctx=await entitledCtx(b);
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
  await expect(withTenant(ctx,tx=>tx.update(s.toilAccrual).set({datedCredit:{...stored.datedCredit!,days:9}})
   .where(eq(s.toilAccrual.id,credit.accrualId)))).rejects.toThrow('Dated TOIL credit provenance is immutable');
  const [type]=await owner.db.select().from(s.leaveType).where(and(eq(s.leaveType.tenantId,b.tenantId),eq(s.leaveType.code,'REPLACEMENT')));
  const leaveDate=new Date(Date.parse(f.sourceDate+'T00:00:00Z')+3*86400000).toISOString().slice(0,10);
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

 it.each(['cash','toil'] as const)('settles disjoint approved-plan quantity through the actual %s owner while reserving original work',async mode=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  // Same explicitly declared private historical group baseline as the existing current
  // workflow fixtures. Formula activation and the request/final decision are genuine.
  const f=await fixture('auto','12','preApproved',true,undefined,555,true),p={employmentId:f.employmentId,date:f.sourceDate};
  const reviewer=await hireEmployee(ctx,{person:{fullName:'Fictional approved-plan reviewer',primaryEmail:randomUUID()+'@fixture.invalid'},
   companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',hiredOn:day(-10)});
  const userId=await createAppUser(b.tenantId,reviewer.personId,'hr_admin'),reviewCtx:SessionContext={...ctx,userId,personId:reviewer.personId,
   roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:3,code:'PLAN_FIN_'+randomUUID().slice(0,8),name:'Fictional positioned-plan review',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,
   stages:[{name:'Review approved positions',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:90,plannedStartTime:'20:00',plannedEndTime:'21:30',reason:'Fictional approved plan disjoint from original 23:00 work'});
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  const read=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!read?.calculation||!read.evidence||!read.policyParts)throw Error('Expected canonical approved-plan settlement parent');
  expect(read.calculation).toMatchObject({outcome:'ready',durationOutcome:'ready',payableNumerator:'90',transferable:true});
  expect(read.policyParts.map(row=>[row.rawMinutes,row.allocatedPayableMinutes,row.sourceIntervals])).toEqual([[0,0,[]]]);
  const review=await withTenant(ctx,tx=>readOvertimePatternCalculationTx(tx,ctx,p));
  expect(review?.policyPayableParts).toEqual([{sequence:0,calendarDate:p.date,minutes:90}]);

  const proof=read.evidence.evidence.policyCapturedCoverage as {countBasis:string;minutes:number;intervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};
  const midnight=Date.parse(p.date+'T00:00:00+08:00');
  expect(proof).toMatchObject({countBasis:'approvedPlanWithIndependentWorkedDay',minutes:90});
  expect(proof.intervals).toEqual([{fromEpochMillisecond:midnight+1380*60000+555,toEpochMillisecond:midnight+1500*60000+555}]);
  await setToilPolicy(ctx,{companyId:b.companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',
   allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false,employeeRequestEnabled:true,
   extendedHoursEnabled:true,extendedHalfDayMinutes:60,extendedFullDayMinutes:120});
  if(mode==='cash'){
   const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)}),transfer={...p,expectedCalculationId:read.calculation.id,
    expectedSourceRevision:read.source.revision,batchId:batch.batchId,reason:'Fictional separate planned quantity cash election'};
   const paid=await transferOvertimePatternToPayroll(ctx,transfer);
   expect(await transferOvertimePatternToPayroll(ctx,transfer)).toMatchObject({status:'unchanged',settlementId:paid.settlementId});
   await generatePayslips(ctx,{batchId:batch.batchId});
   const [slip]=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batch.batchId),eq(s.payslip.employmentId,f.employmentId)));
   expect(slip.overtimePay).toBe('27.00');
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

 it.each((['cash','toil'] as const).flatMap(mode=>[
  ...(['requested','system_calculated','smaller_of','greater_of'] as const).map(method=>({mode,method,roundMode:'none' as const,physical:120,requested:60})),
  ...(['up','nearest'] as const).flatMap(roundMode=>(['requested','system_calculated'] as const).map(method=>({mode,method,roundMode,
   physical:roundMode==='up'?125:135,requested:roundMode==='up'?65:75}))),
 ]))('carries real HR-attested unclocked work through $mode with frozen $method and $roundMode rounding',async({mode,method,roundMode,physical,requested})=>{
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');await setModule(b.tenantId,'typed_pay_components',null);
  await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);ctx=await entitledCtx(b);
  await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'00:00',workEnd:'00:01',breakMinutes:0,lateAfter:'00:00',
   halfDayBefore:'00:01',workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:method});
  // Same declared private historical GROUP baseline restoration as the four Manual probes.
  // Formula activation is genuine and current-day. This is not a historical activation command.
  const rounding:AttendanceGroupPolicy['overtime']['rounding']=roundMode==='none'?{mode:'none',step:null}:{mode:roundMode,step:30};
  const f=await fixture('manual','12','actual',true,undefined,0,true,rounding,physical,roundMode==='nearest'?'latest':'earliest',false,undefined,true),
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
  await saveAttendanceWorkflow(ctx,{companyId:b.companyId,routingVersion:3,code:'UNCLOCKED_FIN_'+randomUUID().slice(0,8),name:'Fictional actual-work financial review',
   applicationType:'self_overtime',priority:100,criteria:{employeeIds:[f.employmentId]},active:true,
   stages:[{name:'Review complete actual work',mode:'sequential',source:{kind:'specific_employee',employmentIds:[reviewer.employmentId]},hrAlternative:false}]});
  await setAttendanceWorkflowEnabled(ctx,b.companyId,'self_overtime',true);
  const request=await requestAttendanceCorrection(ctx,{...p,requestedOtMinutes:requested,reason:'Fictional complete actual-work day with original millisecond endpoints',unclockedWork:actual});
  expect(await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p))).toBeNull();
  await decideAttendanceCorrection(reviewCtx,{correctionId:request.correctionId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
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
   const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)}),transfer={...p,
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
