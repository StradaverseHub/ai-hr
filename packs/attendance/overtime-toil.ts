/** Fresh duration proof for the canonical TOIL executor. No cash evidence or new ledger. */
import {createHash} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {attendance,company,attendanceOvertimeSource,type ToilWorkedDayKind} from '../../db/schema';
import type {OvertimeInput,OvertimeExact} from '../../lib/overtime-pattern-model';
import {evaluateOvertimePatternDuration,intersectOvertimeDurationAfter} from '../../lib/overtime-pattern-evaluate';
import {claimCrossesMidnight} from '../../lib/extended-hours';
import {overtimeDurationProofInput} from '../../lib/overtime-duration-input';
import {canonicalOvertimeToilInputTx} from './overtime-input';
import {readOvertimeDurationDefinitionTx,readOvertimeSettlementForDayTx} from './overtime-patterns';

export class OvertimeToilEligibilityError extends Error {
  constructor(message='The recorded overtime duration is unavailable or changed. Recalculate and review this day before banking Leave Credit.') {super(message);this.name='OvertimeToilEligibilityError';}
}
export type OvertimeToilDuration={kind:'legacy'}|{kind:'formula';companyId:string;country:string|null;dayType:'workday'|'rest_day'|'holiday';recordedWorkedDayKind:ToilWorkedDayKind;recordedDay:{shiftStart:string|null;shiftEnd:string|null;actualClockIn:string|null;actualClockOut:string|null};minutes:number;afterShiftMinutes:number|null;calculationId:string;sourceRevision:number;audit:{durationInputDigest:string;calculationId:string;sourceRevision:number;recordedShiftEndAbs:number|null;recordedShiftEndEpochSeconds:string|null;claimWindow:{start:string;end:string}|null;qualifyingMinutes:number|null;allocationPolicy:'earliest'|'latest'}};
const unavailable=():never=>{throw new OvertimeToilEligibilityError();};
function integerMinutes(value:OvertimeExact):number {
  if(value.unit!=='minutes'||!/^\d{1,80}$/.test(value.numerator)||!/^\d{1,80}$/.test(value.denominator))unavailable();
  const numerator=BigInt(value.numerator),denominator=BigInt(value.denominator);
  if(denominator<=0n||numerator%denominator!==0n||numerator/denominator>BigInt(Number.MAX_SAFE_INTEGER))unavailable();
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
  if(marker?.status==='refused'&&marker.reason==='sourceUnavailable')unavailable();
  const existing=await readOvertimeSettlementForDayTx(tx,ctx,p);
  if(!existing){if(lockedSource||marker?.status==='recorded')unavailable();return {kind:'legacy'};}
  if(!lockedSource||existing.source.id!==lockedSource.id)unavailable();
  if(existing.settlement?.mode==='cash')throw new OvertimeToilEligibilityError('This overtime day is already reserved for cash. Release its unfinalized Payroll contribution before electing Leave Credit.');
  if(!existing.source.currentCalculationId){if(marker?.status==='recorded')unavailable();return {kind:'legacy'};}
  const stored=await readOvertimeDurationDefinitionTx(tx,ctx,p);
  if(!stored||stored.source.id!==existing.source.id||stored.calculation.id!==existing.source.currentCalculationId||stored.calculation.durationOutcome!=='ready'||!stored.calculation.durationInputDigest)unavailable();
  const snapshot=await canonicalOvertimeToilInputTx(tx,ctx,p),calculation=stored!.calculation,source=stored!.source;
  const input:OvertimeInput={...snapshot.input,mode:'actual',patternVersionId:calculation.versionId!,assignmentId:calculation.assignmentId!};
  const companyFact=input.facts.companyId;
  if(input.source.tenantId!==ctx.tenantId||input.source.employmentId!==p.employmentId||input.source.date!==p.date||input.source.attendanceId!==source.attendanceId||companyFact?.state!=='known'||companyFact.value!==source.companyId||!stored!.companyIds.includes(source.companyId))unavailable();
  const digest=createHash('sha256').update(JSON.stringify(overtimeDurationProofInput(stored!.definition,input))).digest('hex');
  if(digest!==calculation.durationInputDigest)unavailable();
  const duration=evaluateOvertimePatternDuration(stored!.definition,input);
  if(duration.status!=='ready'||!duration.transferable||duration.payableMinutes.numerator!==calculation.payableNumerator||duration.payableMinutes.denominator!==calculation.payableDenominator)unavailable();
  const minutes=integerMinutes(duration.payableMinutes);
  if(minutes<=0||!day?.dayType)unavailable();
  let recordedWorkedDayKind:ToilWorkedDayKind;
  const schedule=object(trace)&&trace.v===1&&object(trace.schedule)?trace.schedule:null;
  if(day!.dayType==='holiday')recordedWorkedDayKind='holiday';
  else if(day!.dayType==='rest_day')recordedWorkedDayKind='rest_day';
  else {
    if(!schedule||schedule.dayType!=='workday')unavailable();
    const normal=schedule!.normalMinutesOverride??schedule!.scheduledMinutes;
    if(schedule!.source==='default-shift-rest'&&normal===0)recordedWorkedDayKind='off_day';
    else if(['policy','roster-shift','default-shift'].includes(String(schedule!.source))&&Number.isSafeInteger(normal)&&Number(normal)>0)recordedWorkedDayKind='workday';
    else unavailable();
  }
  const clockText=(value:unknown):string|null=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=4320?`${String(Math.floor(Number(value)/60)%24).padStart(2,'0')}:${String(Number(value)%60).padStart(2,'0')}`:null;
  const recordedDay={shiftStart:clockText(schedule?.startAbs),shiftEnd:clockText(schedule?.endAbs),actualClockIn:day!.checkInAt??null,actualClockOut:day!.checkOutAt??null};
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
  if(!entity)unavailable();
  return {kind:'formula',companyId:source.companyId,country:entity!.country,dayType:day!.dayType!,recordedWorkedDayKind,recordedDay,minutes,afterShiftMinutes,calculationId:calculation.id,sourceRevision:source.revision,audit:{durationInputDigest:digest,calculationId:calculation.id,sourceRevision:source.revision,recordedShiftEndAbs,recordedShiftEndEpochSeconds,claimWindow:p.claimWindow?{start:p.claimWindow.start,end:p.claimWindow.end}:null,qualifyingMinutes:recordedWorkedDayKind==='workday'?afterShiftMinutes:minutes,allocationPolicy:stored!.definition.durationAllocation}};
}
