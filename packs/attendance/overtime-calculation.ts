import {attendancePolicyStoredPartCount} from './policy-count-attribution';
import type {PolicyFinancialContract,PolicyFinancialDurationContract} from './policy-financial-contract';
/** Bind canonical input authority once. Public previews never mint actual recording handles. */
import type {SessionContext, Tx} from '../../db/client';
import {actorOf, appendEvent} from '../../db/events';
import {withAttendanceTenant} from '../../core/module-gate';
import {and, eq, gte, inArray, lte, sql} from 'drizzle-orm';
import {attendance, attendanceOvertimeSource, attendanceGroupPolicyRevision, overtimePatternAssignment, overtimePatternVersion} from '../../db/schema';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';
import {OVERTIME_LIMITS, type OvertimeInput, type OvertimeEvaluation, type OvertimeDurationEvaluation} from '../../lib/overtime-pattern-model';
import {parseRecordedOvertimeEvaluation, parseRecordedOvertimeDurationEvaluation} from '../../lib/overtime-pattern-result';
import {canonicalOvertimeInputTx} from './overtime-input';
import {createOvertimeCalculationOwner, readOvertimeCalculationTx, hasOvertimePatternForDayTx, OvertimeOwnerError, type OvertimeRecordOutcome} from './overtime-patterns';

const calculationOwner = createOvertimeCalculationOwner(canonicalOvertimeInputTx);
export function previewOvertimePatternEmployee(ctx: SessionContext, p: {patternId: string; versionId: string; employmentId: string; date: string}) {
  return calculationOwner.preview(ctx, p);
}
export function previewOvertimePatternSample(ctx: SessionContext, p: {patternId: string; versionId: string; sample: OvertimeInput}) {
  let serialized: string;
  try {serialized = JSON.stringify(p.sample);} catch {throw new OvertimeOwnerError('invalid', 'Enter a valid bounded sample.');}
  if (!serialized || new TextEncoder().encode(serialized).length > OVERTIME_LIMITS.jsonBytes) throw new OvertimeOwnerError('limit', 'The sample exceeds the supported size.');
  return calculationOwner.previewSample(ctx, p);
}
/** Internal writer seam: authority and source digests are re-read by the bound owner inside this Tx. */
export async function reconcileOvertimePatternDayTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string; expectedCurrentRevision: number; reason: string}) {
  const prepared = await calculationOwner.prepareTx(tx, ctx, {employmentId: p.employmentId, date: p.date});
  const result = await calculationOwner.recordTx(tx, ctx, {prepared, expectedCurrentRevision: p.expectedCurrentRevision, reason: p.reason});
  const [day] = await tx.select({id:attendance.id}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
  if (!day) throw new OvertimeOwnerError('unavailable','The overtime day is unavailable.');
  await storeResultMarkerTx(tx,day.id,result);
  return result;
}
async function clearOvertimePatternMarkerTx(tx: Tx, dayId: string) {
  // Preserve the existing PostgreSQL behavior for historical non-object traces.
  await tx.update(attendance).set({calcTrace:sql`${attendance.calcTrace} - 'overtimePattern'`}).where(and(
    eq(attendance.id,dayId),
    sql`(jsonb_typeof(${attendance.calcTrace}) <> 'object' or ${attendance.calcTrace} ? 'overtimePattern')`,
  ));
}

async function storeResultMarkerTx(tx:Tx,dayId:string,result:OvertimeRecordOutcome) {
  if (result.status === 'legacy') {
    await clearOvertimePatternMarkerTx(tx,dayId);
    return;
  }
  // A selected policy alone cannot establish coverage. Complete independently replayed duration
  // can mark its stored source as recorded even if the separate cash contract is unavailable.
  const marker = result.policyRevisionId&&result.policyFinancialDurationContract?.state!=='prepared'?{status:'refused',reason:'sourceUnavailable'} as const:
    {status:'recorded',sourceId:result.sourceId,calculationId:result.calculationId,revision:result.revision} as const;
  await tx.update(attendance).set({calcTrace:sql`jsonb_set(coalesce(${attendance.calcTrace},'{}'::jsonb),'{overtimePattern}',${JSON.stringify(marker)}::jsonb,true)`}).where(eq(attendance.id,dayId));
}
/** Automatic OT stage after the canonical raw day/approval writer. Legacy quantities stay under
 * their existing owner; a formula reference selects the separately stored exact result. */
export async function refreshOvertimePatternDayTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string; reason: string}) {
  const [day] = await tx.select({id:attendance.id}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
  if (!day) return null;
  if (!await hasOvertimePatternForDayTx(tx,ctx,p)) {
    await clearOvertimePatternMarkerTx(tx,day.id);
    return null;
  }
  let result;
  try {
    const prepared = await calculationOwner.prepareTx(tx,ctx,p);
    const current = await overtimeSourceRevisionTx(tx,ctx,p);
    if (!current) throw new OvertimeOwnerError('unavailable','The overtime source is unavailable.');
    result = await calculationOwner.recordTx(tx,ctx,{prepared,expectedCurrentRevision:current.revision,reason:p.reason});
  } catch (error) {
    // Missing dated facts are an OT refusal, not a loss of the employee's raw clocking. SQL,
    // authorization, concurrency and existing financial-claim failures still roll back the writer.
    if (!(error instanceof OvertimeOwnerError) || error.code !== 'unavailable') throw error;
    const marker = {status:'refused',reason:'sourceUnavailable'} as const;
    await tx.update(attendance).set({calcTrace:sql`jsonb_set(coalesce(${attendance.calcTrace},'{}'::jsonb),'{overtimePattern}',${JSON.stringify(marker)}::jsonb,true)`}).where(eq(attendance.id,day.id));
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'attendance',aggregateId:day.id,eventType:'attendance.overtime-pattern.refused',actor:actorOf(ctx),subjectEmploymentId:p.employmentId,payload:{date:p.date,reason:marker.reason}});
    return marker;
  }
  await storeResultMarkerTx(tx,day.id,result);
  return result;
}
/** A batch may omit only a proven legacy no-op. No decision/calculation is memoized: any
 * recorded marker/source, attested work, policy revision or formula candidate uses the exact
 * scalar owner. Both existing writer barriers must already be held in this native transaction. */
async function legacyRefreshIsNoopTx(tx:Tx,ctx:SessionContext,days:readonly {employmentId:string;date:string}[]):Promise<boolean>{
 const [carrier]=await tx.execute<{locked:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid
  and current_setting('transaction_isolation')='read committed' and current_setting('transaction_read_only')='off'
  and (select count(*)=2 from pg_locks l where l.pid=pg_backend_pid() and l.locktype='advisory'
   and l.granted and l.mode='ExclusiveLock' and l.objsubid=1
   and l.database=(select oid from pg_database where datname=current_database())
   and ((l.classid::bigint<<32)|l.objid::bigint) in (
    hashtextextended(${'access-configuration:'+ctx.tenantId},0),
    hashtextextended(${'leave-dependency-configuration:'+ctx.tenantId.toLowerCase()},0))) as locked`);
 if(carrier?.locked!==true)return false;
 const [principal]=await tx.execute<{current:boolean}>(sql`select app.attendance_policy_principal_current() as current`);
 if(principal?.current!==true)return false;
 const ids=[...new Set(days.map(day=>day.employmentId))],dates=days.map(day=>day.date).sort(),from=dates[0],to=dates[dates.length-1];
 // These are deliberately broad necessary candidates using the same RLS tables as the scalar
 // selector. Ignoring target/company/effective-state details can only cause a scalar fallback.
 const dayWhere=and(eq(attendance.tenantId,ctx.tenantId),inArray(attendance.employmentId,ids),gte(attendance.attendanceDate,from),lte(attendance.attendanceDate,to));
 const [row]=await tx.execute<{hasDay:boolean;uncertainDay:boolean;recorded:boolean;policy:boolean;formula:boolean}>(sql`select
  exists(select 1 from ${attendance} where ${dayWhere}) as "hasDay",
  exists(select 1 from ${attendance} where ${dayWhere} and (
   ${attendance.attestedWorkCorrectionId} is not null or ${attendance.calcTrace} ? 'overtimePattern'
   or (${attendance.calcTrace} is not null and jsonb_typeof(${attendance.calcTrace})<>'object'))) as "uncertainDay",
  exists(select 1 from ${attendanceOvertimeSource} where ${attendanceOvertimeSource.tenantId}=${ctx.tenantId}::uuid
   and ${inArray(attendanceOvertimeSource.employmentId,ids)} and ${attendanceOvertimeSource.attendanceDate} between ${from}::date and ${to}::date
   and ${attendanceOvertimeSource.currentCalculationId} is not null) as recorded,
  exists(select 1 from ${attendanceGroupPolicyRevision} where ${attendanceGroupPolicyRevision.tenantId}=${ctx.tenantId}::uuid) as policy,
  exists(select 1 from ${overtimePatternAssignment} inner join ${overtimePatternVersion}
   on ${overtimePatternVersion.id}=${overtimePatternAssignment.versionId}
   where ${overtimePatternAssignment.tenantId}=${ctx.tenantId}::uuid and ${overtimePatternVersion.kind}='formula') as formula`);
 return row?.hasDay===true&&row.uncertainDay===false&&row.recorded===false&&row.policy===false&&row.formula===false;
}

/** Import-only batching preserves the scalar owner for every possibly meaningful OT refresh.
 * Outside its existing Access+leave-configuration writer interval there is no fast course. */
export async function refreshOvertimePatternDaysTx(tx:Tx,ctx:SessionContext,days:readonly {employmentId:string;date:string;reason:string}[]):Promise<void>{
 ctx={...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(grant=>({...grant}))};days=structuredClone(days);
 for(const day of days){overtimeUuid(day.employmentId,'employmentId');overtimeDate(day.date,'attendanceDate');}
 for(let offset=0;offset<days.length;offset+=1000){
  const part=days.slice(offset,offset+1000);
  if(await legacyRefreshIsNoopTx(tx,ctx,part))continue;
  for(const day of part)await refreshOvertimePatternDayTx(tx,ctx,day);
 }
}

/** Deliberate administrative recalculation before review/transfer; no client facts or computed amount. */
export function calculateOvertimePatternDay(ctx: SessionContext, p: {employmentId: string; date: string; expectedCurrentRevision: number; reason: string}) {
  return withAttendanceTenant(ctx, async tx => {
    const [row] = await tx.select({id: attendance.id, allowed: sql<boolean>`app.can_admin_employment(${attendance.employmentId})`})
      .from(attendance).where(and(eq(attendance.tenantId, ctx.tenantId), eq(attendance.employmentId, p.employmentId), eq(attendance.attendanceDate, p.date))).limit(1);
    if (!row?.allowed) throw new OvertimeOwnerError('permission', 'The attendance day is outside your administrator scope.');
    return reconcileOvertimePatternDayTx(tx, ctx, p);
  });
}
/** Metadata only; salary-bearing calculation evidence uses the separately scoped owner reader. */
export async function overtimeSourceRevisionTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string}) {
  const [row] = await tx.select({id: attendanceOvertimeSource.id, revision: attendanceOvertimeSource.revision, currentCalculationId: attendanceOvertimeSource.currentCalculationId})
    .from(attendanceOvertimeSource).where(and(eq(attendanceOvertimeSource.tenantId, ctx.tenantId), eq(attendanceOvertimeSource.employmentId, p.employmentId), eq(attendanceOvertimeSource.attendanceDate, p.date))).limit(1);
  return row ?? null;
}

export type OvertimePatternCalculationReview = {sourceId: string; sourceRevision: number; calculationId: string | null; status: 'ready' | 'ineligible' | 'refused' | null; durationStatus: 'ready' | 'ineligible' | 'refused' | null; approvalStatus: string | null; evaluation: OvertimeEvaluation | null; duration: OvertimeDurationEvaluation | null; recordedAt: string | null;policyFinancial?:PolicyFinancialContract;policyDuration?:PolicyFinancialDurationContract;policyPayableParts?:{sequence:number;calendarDate:string;minutes:number}[]};
/** Immutable evidence is validated structurally and bound to actual stored identities, never replayed
 * against a current definition merely to explain an old amount. */
export async function readOvertimePatternCalculationTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string; revisionId?: string}): Promise<OvertimePatternCalculationReview | null> {
  const record = await readOvertimeCalculationTx(tx, ctx, p);
  if (!record) return null;
  const {source, calculation, evidence, lines} = record;
  if (!calculation) return {sourceId: source.id, sourceRevision: source.revision, calculationId: null, status: null, durationStatus: null, approvalStatus: null, evaluation: null, duration: null, recordedAt: null};
  const stored = evidence?.evidence;
  const wrapper = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : null;
  if(calculation.bindingKind==='attendanceGroupPolicy'){
    // readOvertimeCalculationTx already independently validated the entire historical policy
    // parent, duration/cash contracts, every dated part and every persisted line.
    const policyDuration=wrapper?.policyFinancialDurationContract as PolicyFinancialDurationContract|undefined;
    const policyPayableParts:{sequence:number;calendarDate:string;minutes:number}[]=[];
    if(policyDuration?.state==='prepared'){
      for(const part of policyDuration.parts){
        const minutes=attendancePolicyStoredPartCount(part);
        if(minutes===null)throw new OvertimeOwnerError('unavailable','The recorded dated payable count is unavailable.');
        policyPayableParts.push({sequence:part.sequence,calendarDate:part.calendarDate,minutes});
      }
      if(policyPayableParts.reduce((sum,part)=>sum+part.minutes,0)!==policyDuration.minutes)
        throw new OvertimeOwnerError('unavailable','The recorded dated payable count does not match its parent.');
    }
    return {sourceId:source.id,sourceRevision:source.revision,calculationId:calculation.id,
      status:calculation.outcome,durationStatus:calculation.durationOutcome,approvalStatus:calculation.approvalStatus,
      evaluation:null,duration:null,recordedAt:calculation.createdAt.toISOString(),
      policyFinancial:wrapper?.policyFinancialContract as PolicyFinancialContract|undefined,
      policyDuration,...(policyDuration?.state==='prepared'?{policyPayableParts}:{})};
  }
  const evaluation = parseRecordedOvertimeEvaluation(wrapper?.evaluation);
  const duration = parseRecordedOvertimeDurationEvaluation(wrapper?.duration);
  // An unresolved assignment has a recorded refusal/resolution but no selected formula evaluation.
  if (!evaluation && (calculation.outcome !== 'refused' || calculation.versionId != null || calculation.assignmentId != null)) throw new OvertimeOwnerError('unavailable', 'The recorded calculation evidence is incomplete.');
  if (evaluation) {
    const valid = evaluation.source.tenantId === source.tenantId && evaluation.source.employmentId === source.employmentId && evaluation.source.attendanceId === source.attendanceId
      && evaluation.source.date === source.attendanceDate && evaluation.source.inputDigest === calculation.inputDigest && evaluation.source.approvalDigest === calculation.approvalDigest
      && evaluation.patternVersionId === calculation.versionId && evaluation.assignmentId === calculation.assignmentId && evaluation.status === calculation.outcome
      && evaluation.transferable === calculation.transferable;
    if (!valid) throw new OvertimeOwnerError('unavailable', 'The recorded calculation no longer binds its source.');
    if (evaluation.status !== 'refused') {
      if (evaluation.currency.code !== calculation.currency || evaluation.currency.minorScale !== calculation.minorScale || evaluation.lines.length !== lines.length
        || evaluation.lines.some((line, index) => lines[index].sequence !== index || lines[index].lineKey !== line.id || lines[index].componentId !== line.mapping.earningItemId || lines[index].amountMinorUnits !== line.amountMinorUnits)) throw new OvertimeOwnerError('unavailable', 'The recorded payment lines do not agree with their immutable evidence.');
    } else if (lines.length) throw new OvertimeOwnerError('unavailable', 'A refused calculation cannot carry payment lines.');
  }
  if (!duration && (calculation.durationOutcome !== 'refused' || calculation.payableNumerator !== null || calculation.payableDenominator !== null)) throw new OvertimeOwnerError('unavailable', 'The recorded duration evidence is incomplete.');
  if (duration) {
    if (duration.source.tenantId !== source.tenantId || duration.source.employmentId !== source.employmentId || duration.source.attendanceId !== source.attendanceId
      || duration.source.date !== source.attendanceDate || duration.source.inputDigest !== calculation.inputDigest || duration.source.approvalDigest !== calculation.approvalDigest
      || duration.patternVersionId !== calculation.versionId || duration.assignmentId !== calculation.assignmentId || duration.status !== calculation.durationOutcome
      || duration.status !== 'refused' && (duration.mode !== 'actual' || duration.payableMinutes.numerator !== calculation.payableNumerator || duration.payableMinutes.denominator !== calculation.payableDenominator)) throw new OvertimeOwnerError('unavailable', 'The recorded duration no longer binds its source.');
    if (duration.status === 'refused' && (calculation.payableNumerator !== null || calculation.payableDenominator !== null)) throw new OvertimeOwnerError('unavailable', 'A refused duration cannot carry payable minutes.');
  }
  return {sourceId: source.id, sourceRevision: source.revision, calculationId: calculation.id, status: calculation.outcome, durationStatus: calculation.durationOutcome, approvalStatus: calculation.approvalStatus, evaluation, duration, recordedAt: calculation.createdAt.toISOString()};
}
export function readOvertimePatternCalculation(ctx: SessionContext, p: {employmentId: string; date: string; revisionId?: string}) {
  return withAttendanceTenant(ctx, tx => readOvertimePatternCalculationTx(tx, ctx, p));
}
