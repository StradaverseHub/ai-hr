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
  await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
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
  if(approval==='manual'){
   await createBatch(ctx,{companyId:b.companyId,payPeriod:p.date.slice(0,7)});
   const before=await owner.db.select().from(s.attendanceOvertimeCalculation).orderBy(s.attendanceOvertimeCalculation.ordinal);
   const options=await overtimePatternTransferOptions(ctx,p);
   expect(options.calculation).toMatchObject({id:reviewed!.calculation!.id,status:'refused',approvalStatus:'unknown',transferable:false,amountMinorUnits:null});
   expect(options.runs).toEqual([]);expect(options.settlement).toBeNull();
   expect(await owner.db.select().from(s.attendanceOvertimeCalculation).orderBy(s.attendanceOvertimeCalculation.ordinal)).toEqual(before);
   const refreshed=await calculateOvertimePatternDay(ctx,{...p,expectedCurrentRevision:reviewed!.source.revision,reason:'Explicit review after refused calculation'});
   expect(refreshed.status).toBe('recorded');
   expect((await overtimePatternTransferOptions(ctx,p)).calculation).toMatchObject({status:'refused',transferable:false});
   expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
  }
 });
});
