/** Bind canonical input authority once. Public previews never mint actual recording handles. */
import type {SessionContext, Tx} from '../../db/client';
import {actorOf, appendEvent} from '../../db/events';
import {withAttendanceTenant} from '../../core/module-gate';
import {and, eq, sql} from 'drizzle-orm';
import {attendance, attendanceOvertimeSource} from '../../db/schema';
import {OVERTIME_LIMITS, type OvertimeInput, type OvertimeEvaluation, type OvertimeDurationEvaluation} from '../../lib/overtime-pattern-model';
import {parseRecordedOvertimeEvaluation, parseRecordedOvertimeDurationEvaluation} from '../../lib/overtime-pattern-result';
import {canonicalOvertimeInputTx} from './overtime-input';
import {createOvertimeCalculationOwner, readOvertimeCalculationTx, hasOvertimePatternForDayTx, OvertimeOwnerError} from './overtime-patterns';

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
  return calculationOwner.recordTx(tx, ctx, {prepared, expectedCurrentRevision: p.expectedCurrentRevision, reason: p.reason});
}
/** Automatic OT stage after the canonical raw day/approval writer. Legacy quantities stay under
 * their existing owner; a formula reference selects the separately stored exact result. */
export async function refreshOvertimePatternDayTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string; reason: string}) {
  const [day] = await tx.select({id:attendance.id}).from(attendance).where(and(eq(attendance.tenantId,ctx.tenantId),eq(attendance.employmentId,p.employmentId),eq(attendance.attendanceDate,p.date))).limit(1);
  if (!day) return null;
  if (!await hasOvertimePatternForDayTx(tx,ctx,p)) {
    await tx.update(attendance).set({calcTrace:sql`${attendance.calcTrace} - 'overtimePattern'`}).where(eq(attendance.id,day.id));
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
  if (result.status === 'legacy') {
    await tx.update(attendance).set({calcTrace:sql`${attendance.calcTrace} - 'overtimePattern'`}).where(eq(attendance.id,day.id));
    return result;
  }
  const marker = {status:'recorded',sourceId:result.sourceId,calculationId:result.calculationId,revision:result.revision} as const;
  await tx.update(attendance).set({calcTrace:sql`jsonb_set(coalesce(${attendance.calcTrace},'{}'::jsonb),'{overtimePattern}',${JSON.stringify(marker)}::jsonb,true)`}).where(eq(attendance.id,day.id));
  return result;
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

export type OvertimePatternCalculationReview = {sourceId: string; sourceRevision: number; calculationId: string | null; status: 'ready' | 'ineligible' | 'refused' | null; durationStatus: 'ready' | 'ineligible' | 'refused' | null; approvalStatus: string | null; evaluation: OvertimeEvaluation | null; duration: OvertimeDurationEvaluation | null; recordedAt: string | null};
/** Immutable evidence is validated structurally and bound to actual stored identities, never replayed
 * against a current definition merely to explain an old amount. */
export async function readOvertimePatternCalculationTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string; revisionId?: string}): Promise<OvertimePatternCalculationReview | null> {
  const record = await readOvertimeCalculationTx(tx, ctx, p);
  if (!record) return null;
  const {source, calculation, evidence, lines} = record;
  if (!calculation) return {sourceId: source.id, sourceRevision: source.revision, calculationId: null, status: null, durationStatus: null, approvalStatus: null, evaluation: null, duration: null, recordedAt: null};
  const stored = evidence?.evidence;
  const wrapper = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as Record<string, unknown> : null;
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
