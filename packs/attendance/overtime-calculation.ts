/** Bind canonical input authority once. Public previews never mint actual recording handles. */
import type {SessionContext, Tx} from '../../db/client';
import {withAttendanceTenant} from '../../core/module-gate';
import {and, eq, sql} from 'drizzle-orm';
import {attendance, attendanceOvertimeSource} from '../../db/schema';
import {OVERTIME_LIMITS, type OvertimeInput, type OvertimeEvaluation} from '../../lib/overtime-pattern-model';
import {parseRecordedOvertimeEvaluation} from '../../lib/overtime-pattern-result';
import {canonicalOvertimeInputTx} from './overtime-input';
import {createOvertimeCalculationOwner, readOvertimeCalculationTx, OvertimeOwnerError} from './overtime-patterns';

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

export type OvertimePatternCalculationReview = {sourceId: string; sourceRevision: number; calculationId: string | null; status: 'ready' | 'ineligible' | 'refused' | null; approvalStatus: string | null; evaluation: OvertimeEvaluation | null; recordedAt: string | null};
/** Immutable evidence is validated structurally and bound to actual stored identities, never replayed
 * against a current definition merely to explain an old amount. */
export async function readOvertimePatternCalculationTx(tx: Tx, ctx: SessionContext, p: {employmentId: string; date: string; revisionId?: string}): Promise<OvertimePatternCalculationReview | null> {
  const record = await readOvertimeCalculationTx(tx, ctx, p);
  if (!record) return null;
  const {source, calculation, evidence, lines} = record;
  if (!calculation) return {sourceId: source.id, sourceRevision: source.revision, calculationId: null, status: null, approvalStatus: null, evaluation: null, recordedAt: null};
  const evaluation = parseRecordedOvertimeEvaluation(evidence?.evidence);
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
  return {sourceId: source.id, sourceRevision: source.revision, calculationId: calculation.id, status: calculation.outcome, approvalStatus: calculation.approvalStatus, evaluation, recordedAt: calculation.createdAt.toISOString()};
}
export function readOvertimePatternCalculation(ctx: SessionContext, p: {employmentId: string; date: string; revisionId?: string}) {
  return withAttendanceTenant(ctx, tx => readOvertimePatternCalculationTx(tx, ctx, p));
}
