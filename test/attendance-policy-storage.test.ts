import {readOvertimePolicyDurationTx} from '../packs/attendance/overtime-patterns';
import {resolveOvertimeToilDurationTx} from '../packs/attendance/overtime-toil';
import {recordedAttendancePolicyProposalPartsMatch} from '../packs/attendance/policy-proposal-parts';
import {attendancePolicyCapturedCoverageProposal} from '../packs/attendance/policy-captured-coverage';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {attendancePolicyCashReplay,attendancePolicyCurrentCashMatches} from '../packs/attendance/policy-cash-replay';
import {attendancePolicyPricingProposal} from '../packs/attendance/policy-pricing-proposal';
import {attendancePolicyDurationReplay,attendancePolicyCurrentDurationMatches,attendancePolicyIndependentDurationReplay,type IndependentPolicyDurationSource} from '../packs/attendance/policy-duration-replay';
import {attendancePolicyDurationFormulaProjection} from '../packs/attendance/policy-formula-source';
/** Development storage probes, not execution/approval/Payroll acceptance. SQL0590 is still unshipped.
 * Only the non-payable staged contract is allowed; no test turns proposal arithmetic into money. */
import {randomUUID,createHash} from 'node:crypto';
import {attendancePolicyExecutionProposal,attendancePolicyDurationExecutionProposal} from '../packs/attendance/policy-execution-proposal';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {assignDefaultShift,createShift} from '../core/roster';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {lockAttendancePolicyImportTx,activateOvertimePattern,checkIn,checkOut,ensureStandardRule,canonicalOvertimeInputTx,canonicalOvertimeToilInputTx,createOvertimeCalculationOwner,getOvertimePattern,stopOvertimePatternVersion,readOvertimeCalculationTx,
 checkInTx,checkOutTx,lockOvertimeSourceTx,reserveOvertimeSettlementTx,saveOvertimePatternDraft,scheduleAttendanceGroupPolicy,validateOvertimePatternActivation,requestAttendanceCorrection,decideAttendanceCorrection,setAttendancePolicy} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});

async function capturedClock(employmentId:string,date:string,direction:'in'|'out',time:string,captureDate=date,millisecond=0){
 const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:b.tenantId,employmentId,attendanceDate:date,
  direction,requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(Date.parse(captureDate+'T'+time+'+08:00')+millisecond)}).returning();
 return (direction==='in'?checkInTx:checkOutTx)(ctx,{employmentId,date,time,clockCaptureId:capture.id,preciseOrder:true});
}
async function fixture(approval:'manual'|'auto'='manual',fixedHourlyRate?:string,autoMethod:'actual'|'preApproved'|'intersect'='actual',currentManual=false,moneyScope?:'cap'|'dayMapping'|'dayTier'|'sessionTier'|'dayCharge'|'sessionCharge'|'moneyResource',captureMillisecond=0){
 const ruleId=(await ensureStandardRule(ctx)).id;
 const worker=await hireEmployee(ctx,{person:{fullName:'Fictional policy storage',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,
  departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-10)});
 const shift=await createShift(ctx,{code:'POLICY_'+randomUUID().slice(0,6),name:'Fictional after-shift storage fixture',startTime:'09:00',endTime:'18:00',
  breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId});
 await assignDefaultShift(ctx,{employmentId:worker.employmentId,shiftId:shift.id});
 const [earning]=await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'POLICY_OT',name:'Fictional policy earning',kind:'allowance'}).returning();
 const definition=prepareOvertimeStarter('ot15','day','earliest');definition.currency={code:'MYR',minorScale:2};
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
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:false,approval,autoMethod,rounding:{mode:'none',step:null},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:draft.versionId}])) as AttendanceGroupPolicy['overtime']['days']}};
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
 const sourceOffset=currentManual?0:2;
 await capturedClock(worker.employmentId,day(sourceOffset),'in','23:50:00',day(sourceOffset),captureMillisecond);
 await capturedClock(worker.employmentId,day(sourceOffset),'out','00:10:00',day(sourceOffset+1),captureMillisecond);
 return {...worker,ruleId,revisionId:revision.id,versionId:draft.versionId,policy};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function header(tx:Tx,f:Fixture,count:number,patch:Partial<typeof s.attendanceOvertimeCalculation.$inferInsert>={}){
 const source=await lockOvertimeSourceTx(tx,ctx,{employmentId:f.employmentId,date:day(2)});
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
 it('reads policy TOIL duration without salary or cash earning mappings and retains the settlement refusal',async()=>{
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
   await expect(canonicalOvertimeToilInputTx(guarded,actor,{employmentId:f.employmentId,date:day(2)})).rejects.toThrow('Recorded overtime inputs are unavailable for this employee and date.');
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
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
  if(coverage.state!=='prepared')throw Error('Expected captured source attribution');
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
  expect(reviewed.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});expect(reviewed.lines).toEqual([]);
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
   const proof=attendancePolicyCapturedCoverageProposal({tenantId:b.tenantId,companyId:b.companyId,employmentId:f.employmentId,
    sourceId:saved.sourceId,calculationId:saved.id,date:p.date},await canonicalOvertimeInputTx(tx,ctx,p));
   if(proof.state!=='prepared')throw Error('Expected original captured geometry');
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
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
  expect(reviewed?.calculation).toMatchObject({approvalStatus:approval==='auto'?'notRequired':'unknown',outcome:'refused',durationOutcome:'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });

 it('records and replays exact central pricing for both dated parts without enabling payment',async()=>{
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
  expect(reviewed?.calculation).toMatchObject({outcome:'refused',durationOutcome:'refused',transferable:false});
  expect(reviewed?.lines).toEqual([]);
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
  const f=await fixture(),p={employmentId:f.employmentId,date:day(2)};
  const current=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,p));
  if(!current?.calculation)throw Error('Expected the actual staged policy calculation');
  // Deliberately absent target IDs ensure this probe pins the POLICY admission boundary, not an
  // unrelated FK/target failure. A valid legacy TOIL/cash lifecycle is covered by consumer regressions.
  const targetId=randomUUID();const reservation:Parameters<typeof reserveOvertimeSettlementTx>[2]=mode==='cash'?{...p,mode,calculationId:current.calculation.id,payrollBatchId:targetId}
   :{...p,mode,toilAccrualId:targetId};
  await expect(withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,reservation))).rejects.toMatchObject({code:'unavailable',
   message:'Policy overtime cannot settle before complete execution, approval and independent financial replay.'});
  let sqlError:unknown;
  try{await withTenant(ctx,tx=>tx.insert(s.overtimeSourceSettlement).values({tenantId:b.tenantId,companyId:b.companyId,sourceId:current.source.id,
   mode,calculationId:mode==='cash'?current.calculation!.id:null,ownerReference:{type:mode==='cash'?'payroll_batch':'toil_accrual',id:targetId},
   payrollBatchId:mode==='cash'?targetId:null,toilAccrualId:mode==='toil'?targetId:null}));}catch(error){sqlError=error;}
  const outer=sqlError as {cause?:{code?:unknown;message?:unknown}}|undefined;
  const cause=(outer?.cause??sqlError) as {code?:unknown;message?:unknown}|undefined;
  expect(cause?.code).toBe('23514');expect(String(cause?.message)).toContain('Policy overtime settlement remains unavailable before complete execution and independent replay');
  expect(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.sourceId,current.source.id))).toEqual([]);
 });
 it('refuses a payable policy header while execution receipts and financial replay are not implemented',async()=>{
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

});
