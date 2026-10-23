import {attendancePolicyDatedToilQualification} from './policy-toil-dated-qualification';
import {isDeepStrictEqual} from 'node:util';
/** Fresh duration proof for the canonical TOIL executor. No cash evidence or new ledger. */
import {createHash} from 'node:crypto';
import type {LeaveCreditFormulaReason} from '../../lib/leave-credit-claim-review';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,company,attendanceOvertimeSource,type ToilWorkedDayKind} from '../../db/schema';
import type {OvertimeInput,OvertimeExact} from '../../lib/overtime-pattern-model';
import {evaluateOvertimePatternDuration,intersectOvertimeDurationAfter} from '../../lib/overtime-pattern-evaluate';
import {claimCrossesMidnight} from '../../lib/extended-hours';
import {overtimeDurationProofInput} from '../../lib/overtime-duration-input';
import {canonicalOvertimeToilInputTx} from './overtime-input';
import {attendancePolicyFinancialDurationContract} from './policy-financial-contract';
import {attendancePolicyIndependentSource} from './policy-duration-replay';
import {attendancePolicyCountAttribution,attendancePolicyStoredPartCount} from './policy-count-attribution';
import {readOvertimeDurationDefinitionTx,readOvertimePolicyDurationTx,readOvertimeSettlementForDayTx} from './overtime-patterns';

export class OvertimeToilEligibilityError extends Error {
  constructor(message='The recorded overtime duration is unavailable or changed. Recalculate and review this day before banking Leave Credit.',readonly code:LeaveCreditFormulaReason='unavailable') {super(message);this.name='OvertimeToilEligibilityError';}
}
export type OvertimeToilDuration={kind:'legacy'}|{kind:'formula';companyId:string;country:string;dayType:'workday'|'rest_day'|'holiday';recordedWorkedDayKind:ToilWorkedDayKind;recordedDay:{shiftStart:string|null;shiftEnd:string|null;actualClockIn:string|null;actualClockOut:string|null};minutes:number;afterShiftMinutes:number|null;calculationId:string;sourceRevision:number;audit:{durationInputDigest:string;calculationId:string;sourceRevision:number;recordedShiftEndAbs:number|null;recordedShiftEndEpochSeconds:string|null;claimWindow:{start:string;end:string}|null;qualifyingMinutes:number|null;allocationPolicy:'earliest'|'latest';datedAllocations?:{sequence:number;date:string;workedDayKind:ToilWorkedDayKind;minutes:number;afterShiftMinutes:number|null;physicalMinutes?:number;roundedMinutes?:number}[]}};
function unavailable(code:LeaveCreditFormulaReason='unavailable'):never {throw new OvertimeToilEligibilityError(undefined,code);}
function integerMinutes(value:OvertimeExact):number {
  if(value.unit!=='minutes'||!/^\d{1,80}$/.test(value.numerator)||!/^\d{1,80}$/.test(value.denominator))unavailable();
  const numerator=BigInt(value.numerator),denominator=BigInt(value.denominator);
  if(denominator<=BigInt('0')||numerator/denominator>BigInt(Number.MAX_SAFE_INTEGER))unavailable();
  if(numerator%denominator!==BigInt('0'))unavailable('fractional');
  return Number(numerator/denominator);
}
/** Caller holds the same employment advisory as Attendance and Payroll before this source read. */
export async function resolveOvertimeToilDurationTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string;claimWindow?:{start:string;end:string}}):Promise<OvertimeToilDuration> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
  // Direct raw Attendance writers also lock this existing source in the database trigger. Take it
  // before fresh MVCC reads; never lock Attendance after source (the raw writer owns day -> source).
  const [lockedSource]=await tx.select().from(attendanceOvertimeSource).where(and(eq(attendanceOvertimeSource.tenantId,ctx.tenantId),eq(attendanceOvertimeSource.employmentId,p.employmentId),eq(attendanceOvertimeSource.attendanceDate,p.date))).limit(1).for('update');
  const [day]=await tx.select({calcTrace:attendance.calcTrace,dayType:attendance.dayType,checkInAt:attendance.checkInAt,checkOutAt:attendance.checkOutAt}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
  const trace=day?.calcTrace as unknown;
  const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
  const marker=object(trace)&&object(trace.overtimePattern)?trace.overtimePattern:null;
  const existing=await readOvertimeSettlementForDayTx(tx,ctx,p);
  if(!existing){if(lockedSource||marker?.status==='recorded'||marker?.status==='refused'&&marker.reason==='sourceUnavailable')unavailable();return {kind:'legacy'};}
  if(!lockedSource||existing.source.id!==lockedSource.id)unavailable();
  if(existing.settlement?.mode==='cash')throw new OvertimeToilEligibilityError('This overtime day is already reserved for cash. Release its unfinalized Payroll contribution before electing Leave Credit.','cashConflict');
  if(!existing.source.currentCalculationId){if(marker?.status==='recorded')unavailable();return {kind:'legacy'};}
  const policy=await readOvertimePolicyDurationTx(tx,ctx,p);
  if(policy)return resolvePolicyToilDurationTx(tx,ctx,p,policy,day);
  if(marker?.status==='refused'&&marker.reason==='sourceUnavailable')unavailable();
  const stored=await readOvertimeDurationDefinitionTx(tx,ctx,p);
  if(!stored||stored.source.id!==existing.source.id||stored.calculation.id!==existing.source.currentCalculationId||stored.calculation.durationOutcome!=='ready'||!stored.calculation.durationInputDigest)unavailable();
  const snapshot=await canonicalOvertimeToilInputTx(tx,ctx,p),calculation=stored.calculation,source=stored.source;
  if(!calculation.versionId||!calculation.assignmentId)unavailable();
  const input:OvertimeInput={...snapshot.input,mode:'actual',patternVersionId:calculation.versionId,assignmentId:calculation.assignmentId};
  const companyFact=input.facts.companyId;
  if(input.source.tenantId!==ctx.tenantId||input.source.employmentId!==p.employmentId||input.source.date!==p.date||input.source.attendanceId!==source.attendanceId||companyFact?.state!=='known'||companyFact.value!==source.companyId||!stored.companyIds.includes(source.companyId))unavailable();
  const digest=createHash('sha256').update(JSON.stringify(overtimeDurationProofInput(stored.definition,input))).digest('hex');
  if(digest!==calculation.durationInputDigest)unavailable('stale');
  const duration=evaluateOvertimePatternDuration(stored.definition,input);
  if(duration.status!=='ready')unavailable();
  if(!duration.transferable||duration.payableMinutes.numerator!==calculation.payableNumerator||duration.payableMinutes.denominator!==calculation.payableDenominator)unavailable();
  const minutes=integerMinutes(duration.payableMinutes);
  if(!day||!day.dayType||minutes<=0)unavailable();
  const dayType=day.dayType;
  let recordedWorkedDayKind:ToilWorkedDayKind;
  const schedule=object(trace)&&trace.v===1&&object(trace.schedule)?trace.schedule:null;
  if(dayType==='holiday')recordedWorkedDayKind='holiday';
  else if(dayType==='rest_day')recordedWorkedDayKind='rest_day';
  else {
    if(!schedule||schedule.dayType!=='workday')unavailable();
    const normal=schedule.normalMinutesOverride??schedule.scheduledMinutes;
    if(schedule.source==='default-shift-rest'&&normal===0)recordedWorkedDayKind='off_day';
    else if(['policy','roster-shift','default-shift'].includes(String(schedule.source))&&Number.isSafeInteger(normal)&&Number(normal)>0)recordedWorkedDayKind='workday';
    else unavailable();
  }
  const clockText=(value:unknown):string|null=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=4320?`${String(Math.floor(Number(value)/60)%24).padStart(2,'0')}:${String(Number(value)%60).padStart(2,'0')}`:null;
  const recordedDay={shiftStart:clockText(schedule?.startAbs),shiftEnd:clockText(schedule?.endAbs),actualClockIn:day.checkInAt??null,actualClockOut:day.checkOutAt??null};
  let afterShiftMinutes:number|null=null,recordedShiftEndAbs:number|null=null,recordedShiftEndEpochSeconds:string|null=null;
  if(recordedWorkedDayKind==='workday'&&object(trace)&&trace.v===1&&object(trace.schedule)&&Number.isSafeInteger(trace.schedule.endAbs)&&Number(trace.schedule.endAbs)>=0&&Number(trace.schedule.endAbs)<=4320) {
    const midnight=Date.parse(p.date+'T00:00:00+08:00')/1000;
    recordedShiftEndAbs=Number(trace.schedule.endAbs);recordedShiftEndEpochSeconds=String(midnight+recordedShiftEndAbs*60);
    let lower=Number(trace.schedule.endAbs),upper:number|undefined;
    if(p.claimWindow){
      const validClock=(value:string)=>/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value);
      // The legacy HH:mm claim has no date offset for a shift that ends on the following day.
      if(!validClock(p.claimWindow.start)||!validClock(p.claimWindow.end)||lower>=1440)unavailable();
      const minute=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
      lower=Math.max(lower,minute(p.claimWindow.start));
      upper=minute(p.claimWindow.end)+(claimCrossesMidnight(p.claimWindow.start,p.claimWindow.end)?1440:0);
    }
    if(upper!==undefined&&upper<=lower)afterShiftMinutes=0;
    else {
      const after=intersectOvertimeDurationAfter(duration,String(midnight+lower*60),upper===undefined?undefined:String(midnight+upper*60));
      if(after.state==='known')afterShiftMinutes=integerMinutes(after.value);
    }
  }
  const [entity]=await tx.select({country:company.country}).from(company).where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,source.companyId))).limit(1);
  if(!entity||typeof entity.country!=='string'||!entity.country.trim())unavailable();
  return {kind:'formula',companyId:source.companyId,country:entity.country,dayType:dayType,recordedWorkedDayKind,recordedDay,minutes,afterShiftMinutes,calculationId:calculation.id,sourceRevision:source.revision,audit:{durationInputDigest:digest,calculationId:calculation.id,sourceRevision:source.revision,recordedShiftEndAbs,recordedShiftEndEpochSeconds,claimWindow:p.claimWindow?{start:p.claimWindow.start,end:p.claimWindow.end}:null,qualifyingMinutes:recordedWorkedDayKind==='workday'?afterShiftMinutes:minutes,allocationPolicy:stored.definition.durationAllocation}};
}

/** Existing country/claim/credit owners consume this explicit dated qualification. Until those
 * owners accept different classes in one election, refuse mixed classes rather than collapse them. */
async function resolvePolicyToilDurationTx(tx:Tx,ctx:SessionContext,
 p:{employmentId:string;date:string;claimWindow?:{start:string;end:string}},
 stored:NonNullable<Awaited<ReturnType<typeof readOvertimePolicyDurationTx>>>,
 day:{calcTrace:unknown;dayType:string|null;checkInAt:string|null;checkOutAt:string|null}|undefined):Promise<OvertimeToilDuration>{
 const snapshot=await canonicalOvertimeToilInputTx(tx,ctx,p),independent=attendancePolicyIndependentSource(snapshot);
 if(!independent)unavailable();
 const {source,calculation}=stored;
 const contract=attendancePolicyFinancialDurationContract({tenantId:ctx.tenantId,companyId:source.companyId,
  employmentId:source.employmentId,sourceId:source.id,calculationId:calculation.id,date:source.attendanceDate},independent);
 if(contract.state!=='prepared'||!isDeepStrictEqual(contract,stored.contract)
  ||!isDeepStrictEqual(JSON.parse(JSON.stringify(independent)),JSON.parse(JSON.stringify(stored.independent))))unavailable('stale');
 const proposal=independent.policyExecutionProposal,formulas=independent.policyDurationFormulaInput;
 if(proposal?.state!=='proposed'||proposal.duration.status!=='calculated'||formulas.state!=='known'||!day)unavailable();
 const counts=attendancePolicyCountAttribution(proposal.duration);if(counts.state!=='known')unavailable();
 const kindFor=(value:string):ToilWorkedDayKind=>value==='normal'?'workday':value==='off'?'off_day':value==='rest'?'rest_day'
  :value==='publicHoliday'||value==='replacementHoliday'?'holiday':unavailable();
 const positive=contract.parts.filter(part=>(attendancePolicyStoredPartCount(part)??-1)>0);
 const kinds=new Set(positive.map(part=>kindFor(part.dayClass)));
 if(kinds.size!==1)unavailable();
 const recordedWorkedDayKind=[...kinds][0],dayType=recordedWorkedDayKind==='holiday'?'holiday'
  :recordedWorkedDayKind==='rest_day'?'rest_day':'workday';
 const directions=new Set(formulas.references.filter(row=>row.state==='known').map(row=>row.durationAllocation));
 if(directions.size!==1)unavailable();
 const allocationPolicy=[...directions][0];
 const trace=day.calcTrace as {v?:unknown;schedule?:{startAbs?:unknown;endAbs?:unknown;dayType?:unknown}}|null;
 // The independent contract above has replayed the distinct immutable HR source against
 // current dated configuration. Its frozen schedule supplies qualification, never clock labels.
 const attestedContext=independent.policyRawEffectSource?.attested?independent.policyExecutionContext:undefined;
 const boundary=attestedContext?.state==='policy'?attestedContext.clockPlacement:undefined;
 const schedule=attestedContext?.state==='policy'&&boundary?.state==='known'
  ?{startAbs:boundary.scheduled.from,endAbs:boundary.scheduled.to,dayType:day.dayType}
  :trace?.v===1?trace.schedule:undefined;
 const clockText=(value:unknown):string|null=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=4320
  ?`${String(Math.floor(Number(value)/60)%24).padStart(2,'0')}:${String(Number(value)%60).padStart(2,'0')}`:null;
 const recordedDay={shiftStart:clockText(schedule?.startAbs),shiftEnd:clockText(schedule?.endAbs),
  actualClockIn:day.checkInAt,actualClockOut:day.checkOutAt};
 let recordedShiftEndAbs:number|null=null,recordedShiftEndEpochSeconds:string|null=null;
 let lower:number|null=null,upper:number|undefined;
 if(recordedWorkedDayKind==='workday'){
  if(schedule?.dayType!=='workday'||!Number.isSafeInteger(schedule.endAbs)||Number(schedule.endAbs)<0||Number(schedule.endAbs)>4320)unavailable();
  recordedShiftEndAbs=Number(schedule.endAbs);lower=recordedShiftEndAbs;
  recordedShiftEndEpochSeconds=String(Date.parse(p.date+'T00:00:00+08:00')/1000+lower*60);
  if(p.claimWindow){
   const valid=(value:string)=>/^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value);
   if(!valid(p.claimWindow.start)||!valid(p.claimWindow.end)||lower>=1440)unavailable();
   const minute=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3,5));
   lower=Math.max(lower,minute(p.claimWindow.start));
   upper=minute(p.claimWindow.end)+(claimCrossesMidnight(p.claimWindow.start,p.claimWindow.end)?1440:0);
  }
 }
 const datedAllocations=positive.map(part=>{
  const positioned=proposal.duration.status==='calculated'?proposal.duration.parts[part.sequence]:undefined;
  if(!positioned||positioned.date!==part.calendarDate||positioned.allocatedPayableMinutes!==part.allocatedPayableMinutes)unavailable();
  // These are the original count coordinates retained by the duration owner. Physical geometry
  // remains in contract.coverage; no capture is stretched to implement claim qualification.
  const attributed=counts.parts[part.sequence];
  if(!attributed||attendancePolicyStoredPartCount(part)!==attributed.minutes)unavailable();
  const physicalAfter=lower===null?null:positioned.allocations.reduce((sum,row)=>sum
   +Math.max(0,Math.min(row.to,upper??4320)-Math.max(row.from,lower!)),0);
  // The same earliest/latest count anchor used for dated pricing qualifies the rounded
  // quantity. This point is count attribution on an existing interval, not a new capture.
  const roundedAfter=lower===null?0:attributed.roundingCountAttributions.reduce((sum,row)=>{
   const point=row.direction==='earliest'?row.anchor.from:row.anchor.to-1;
   return sum+(point>=lower!&&point<(upper??4320)?row.minutes:0);
  },0);
  const afterShiftMinutes=physicalAfter===null?null:physicalAfter+roundedAfter;
  return {sequence:part.sequence,date:part.calendarDate,workedDayKind:kindFor(part.dayClass),
   minutes:attributed.minutes,afterShiftMinutes,...(attributed.roundedMinutes>0
    ?{physicalMinutes:attributed.physicalMinutes,roundedMinutes:attributed.roundedMinutes}:{})};
 });
 const afterShiftMinutes=recordedWorkedDayKind==='workday'?datedAllocations.reduce((sum,row)=>sum+(row.afterShiftMinutes??0),0):null;
 const [entity]=await tx.select({country:company.country}).from(company).where(and(eq(company.tenantId,ctx.tenantId),eq(company.id,source.companyId))).limit(1);
 if(!entity||typeof entity.country!=='string'||!entity.country.trim())unavailable();
 return {kind:'formula',companyId:source.companyId,country:entity.country,dayType,recordedWorkedDayKind,recordedDay,
  minutes:contract.minutes,afterShiftMinutes,calculationId:calculation.id,sourceRevision:source.revision,
  audit:{durationInputDigest:contract.durationDigest,calculationId:calculation.id,sourceRevision:source.revision,
   recordedShiftEndAbs,recordedShiftEndEpochSeconds,claimWindow:p.claimWindow?{...p.claimWindow}:null,
   qualifyingMinutes:recordedWorkedDayKind==='workday'?afterShiftMinutes:contract.minutes,allocationPolicy,datedAllocations}};
}

/** Salary-free dated qualification for the credit owner. It deliberately has no
 * scalar worked-day kind: every dated class stays attached to its own quantity.
 * Existing uniform/legacy readers retain their original contract. */
export async function resolveOvertimePolicyDatedToilQualificationTx(tx:Tx,ctx:SessionContext,p:{employmentId:string;date:string}){
 await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':'+p.employmentId},0))`);
 const [locked]=await tx.select().from(attendanceOvertimeSource).where(and(eq(attendanceOvertimeSource.tenantId,ctx.tenantId),
  eq(attendanceOvertimeSource.employmentId,p.employmentId),eq(attendanceOvertimeSource.attendanceDate,p.date))).limit(1).for('update');
 const existing=await readOvertimeSettlementForDayTx(tx,ctx,p);
 if(existing?.settlement?.mode==='cash')throw new OvertimeToilEligibilityError('This overtime day is already reserved for cash. Release its unfinalized Payroll contribution before electing Leave Credit.','cashConflict');
 const stored=await readOvertimePolicyDurationTx(tx,ctx,p);
 if(!stored)return null;
 if(!locked||locked.id!==stored.source.id||locked.currentCalculationId!==stored.calculation.id)unavailable('stale');
 const snapshot=await canonicalOvertimeToilInputTx(tx,ctx,p),independent=attendancePolicyIndependentSource(snapshot);
 if(!independent)unavailable();
 const contract=attendancePolicyFinancialDurationContract({tenantId:ctx.tenantId,companyId:stored.source.companyId,
  employmentId:p.employmentId,sourceId:stored.source.id,calculationId:stored.calculation.id,date:p.date},independent);
 if(contract.state!=='prepared'||!isDeepStrictEqual(contract,stored.contract)
  ||!isDeepStrictEqual(JSON.parse(JSON.stringify(independent)),JSON.parse(JSON.stringify(stored.independent))))unavailable('stale');
 const qualified=attendancePolicyDatedToilQualification(independent);
 if(qualified.state!=='prepared'||qualified.durationDigest!==contract.durationDigest||qualified.minutes!==contract.minutes)unavailable();
 return {...qualified,companyId:stored.source.companyId,calculationId:stored.calculation.id,sourceRevision:stored.source.revision};
}
