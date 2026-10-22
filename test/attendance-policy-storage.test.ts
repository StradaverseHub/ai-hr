/** Development storage probes, not execution/approval/Payroll acceptance. SQL0590 is still unshipped.
 * Only the non-payable staged contract is allowed; no test turns proposal arithmetic into money. */
import {randomUUID,createHash} from 'node:crypto';
import {attendancePolicyExecutionProposal} from '../packs/attendance/policy-execution-proposal';
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
 checkInTx,checkOutTx,lockOvertimeSourceTx,reserveOvertimeSettlementTx,saveOvertimePatternDraft,scheduleAttendanceGroupPolicy,validateOvertimePatternActivation} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});

async function capturedClock(employmentId:string,date:string,direction:'in'|'out',time:string,captureDate=date){
 const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:b.tenantId,employmentId,attendanceDate:date,
  direction,requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(captureDate+'T'+time+'+08:00')}).returning();
 return (direction==='in'?checkInTx:checkOutTx)(ctx,{employmentId,date,time,clockCaptureId:capture.id,preciseOrder:true});
}
async function fixture(approval:'manual'|'auto'='manual'){
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
 const draft=await saveOvertimePatternDraft(ctx,{draft:{code:'POLICY_'+randomUUID().slice(0,8),name:'Fictional policy pattern',creationCompanyId:b.companyId,companyIds:[b.companyId],definition}});
 const validation=await validateOvertimePatternActivation(ctx,{versionId:draft.versionId,expectedRevision:draft.revision});
 expect(validation.issues).toEqual([]);
 await activateOvertimePattern(ctx,{versionId:draft.versionId,expectedRevision:draft.revision,validationDigest:validation.validationDigest!,effectiveFrom:day(1)});
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:false,approval,autoMethod:'actual',rounding:{mode:'none',step:null},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:draft.versionId}])) as AttendanceGroupPolicy['overtime']['days']}};
 const revision=await scheduleAttendanceGroupPolicy(ctx,{companyId:b.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional storage fixture',policy});
 await capturedClock(worker.employmentId,day(2),'in','23:50:00');
 await capturedClock(worker.employmentId,day(2),'out','00:10:00',day(3));
 return {...worker,ruleId,revisionId:revision.id,versionId:draft.versionId};
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
});
