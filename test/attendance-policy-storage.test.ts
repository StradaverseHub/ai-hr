/** Development storage probes, not execution/approval/Payroll acceptance. SQL0590 is still unshipped.
 * Only the non-payable staged contract is allowed; no test turns proposal arithmetic into money. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {assignDefaultShift,createShift} from '../core/roster';
import {prepareOvertimeStarter} from '../lib/overtime-pattern-starters';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {activateOvertimePattern,checkIn,checkOut,ensureStandardRule,canonicalOvertimeInputTx,createOvertimeCalculationOwner,getOvertimePattern,stopOvertimePatternVersion,readOvertimeCalculationTx,
 lockOvertimeSourceTx,saveOvertimePatternDraft,scheduleAttendanceGroupPolicy,validateOvertimePatternActivation} from '../packs/attendance/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext;
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});

async function fixture(){
 const ruleId=(await ensureStandardRule(ctx)).id;
 const worker=await hireEmployee(ctx,{person:{fullName:'Fictional policy storage',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,
  departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-10)});
 const shift=await createShift(ctx,{code:'POLICY_'+randomUUID().slice(0,6),name:'Fictional overnight storage fixture',startTime:'22:00',endTime:'06:00',
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
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:false,approval:'manual',autoMethod:'actual',rounding:{mode:'none',step:null},
   days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:draft.versionId}])) as AttendanceGroupPolicy['overtime']['days']}};
 const revision=await scheduleAttendanceGroupPolicy(ctx,{companyId:b.companyId,ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional storage fixture',policy});
 await checkIn(ctx,{employmentId:worker.employmentId,date:day(2),time:'23:50'});
 await checkOut(ctx,{employmentId:worker.employmentId,date:day(2),time:'00:10'});
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
 it('invalidates a prepared policy snapshot when its referenced formula is stopped, without rewriting old evidence',async()=>{
  const f=await fixture(),api=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  const before=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  const snapshotBefore=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  const [version]=await owner.db.select().from(s.overtimePatternVersion).where(eq(s.overtimePatternVersion.id,f.versionId));
  const detail=await getOvertimePattern(ctx,version.patternId),revision=detail!.versions.find(row=>row.id===f.versionId)!.revision;
  await expect(withTenant(ctx,async tx=>{
   const prepared=await api.prepareTx(tx,ctx,{employmentId:f.employmentId,date:day(2)});
   await stopOvertimePatternVersion(ctx,{versionId:f.versionId,expectedRevision:revision,effectiveFrom:day(2),reason:'Fictional prospective formula stop'});
   return api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:before!.source.revision,reason:'Fictional stale formula source probe'});
  })).rejects.toMatchObject({code:'stale'});
  const after=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}));
  expect(after.referenceDigest).not.toBe(snapshotBefore.referenceDigest);
  expect(after.policyFormulaInput).toMatchObject({state:'known',references:[{state:'unavailable',reason:'formulaInactive'},{state:'unavailable',reason:'formulaInactive'},{state:'unavailable',reason:'formulaInactive'}]});
  expect(await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(2)}))).toEqual(before);
 });

 it('retains the original assignment discriminator by default and permits an explicit empty refused policy result',async()=>{
  const f=await fixture();
  const normal=await withTenant(ctx,async tx=>{const {saved}=await header(tx,f,0,{bindingKind:undefined,policyRevisionId:null});return saved;});
  expect(normal).toMatchObject({bindingKind:'assignedPattern',policyRevisionId:null,policyPartCount:0,outcome:'refused',transferable:false});
  // The independent fixture uses another source rather than rewriting the immutable header.
  await checkIn(ctx,{employmentId:f.employmentId,date:day(3),time:'23:50'});
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
