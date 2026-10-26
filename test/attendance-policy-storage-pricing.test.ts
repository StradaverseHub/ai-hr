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
});
