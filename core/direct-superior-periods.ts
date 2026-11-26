/**
 * Board 8f959c7a r2 — correct one Direct Superior period from the Direct Superior card: change its superior,
 * start or end, clear its end date (the next period is removed and this one carries on), or remove it.
 *
 * ONE OWNER. The dated superior is the administrative reporting_line timeline. A period a "Changed Direct
 * Superior" movement created is corrected THROUGH that movement (edit = replay, remove = Roll Back), so the
 * card and Employment History can never disagree. A period no movement owns (hire, import, amendment) is
 * corrected directly: touched lines are superseded and re-inserted (history is kept), the replacements are
 * recorded on the correction event so a later Roll Back follows them (hire-correction liveIncarnationOf).
 *
 * Neighbours move with the change, so periods never overlap and no gap is created between two periods:
 * a new start moves the previous period's end, a new end moves the next period's start, and a removed
 * period is covered by the one before it (or, for the first period, by the one after it).
 *
 * Locks, authorization and payroll protection match writeDirectSuperiorTx; closed payroll is never
 * recalculated. Every direct correction appends one employment.information.corrected event (source
 * direct-superior) with the reason, the actor and the periods before and after.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { appendEvent, actorOf } from '../db/events';
import { employment, reportingLine } from '../db/schema';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { lockEmploymentLeaveDependenciesTx, lockOrgReportingTx } from './workforce-lock-mode';
import { assertDirectSuperiorCandidateTx, lockEmploymentStatutoryOwnerTx } from './org';
import { lockPayrollInputsTx } from './payroll-inputs-lock';
import { preserveMovementPayrollTx } from './movement-payroll-protection';
import { markWorkforcePayrollInputsChangedTx } from './workforce-payroll-invalidation';
import { assertWorkforceEmploymentTx } from './workforce-access';
import { assertMovementDeleteTx } from './movement-delete-access';
import { administratorTx, INFORMATION_CORRECTED_EVENT, InformationCorrectionError } from './information-correction';
import { directSuperiorLineOwnersTx, editMovementEventTx, movementCorrectionBaseTx, reverseMovementForImportTx } from './movement';
import { addCalendarDays } from '../lib/hr-date-calendar';
import { isCalendarDate } from '../lib/calendar-date';
import { directSuperiorRevision, type DirectSuperiorLineRow } from '../lib/direct-superior-period';

export class DirectSuperiorPeriodError extends InformationCorrectionError {
  constructor(message: string) { super(message); this.name = 'DirectSuperiorPeriodError'; }
}
const fail = (message: string): never => { throw new DirectSuperiorPeriodError(message); };

export type DirectSuperiorPeriodCorrection = {
  employmentId: string;
  /** directSuperiorRevision of the lines the card showed. */
  revision: string;
  lineId: string;
  reason: string;
} & (
  /** `validToInclusive` null clears the end date: the next period is removed and this one carries on. */
  | { operation: 'edit'; managerEmploymentId: string; validFrom: string; validToInclusive: string | null }
  | { operation: 'remove' }
);

type Line = DirectSuperiorLineRow;

async function liveLinesTx(tx: Tx, ctx: SessionContext, employmentId: string): Promise<Line[]> {
  return tx.select({ id: reportingLine.id, managerEmploymentId: reportingLine.managerEmploymentId,
    validFrom: reportingLine.validFrom, validTo: reportingLine.validTo }).from(reportingLine)
    .where(and(eq(reportingLine.tenantId, ctx.tenantId), eq(reportingLine.subordinateEmploymentId, employmentId),
      eq(reportingLine.lineType, 'administrative'), isNull(reportingLine.supersededAt),
      sql`(${reportingLine.validTo} is null or ${reportingLine.validTo} > ${reportingLine.validFrom})`))
    .orderBy(asc(reportingLine.validFrom), asc(reportingLine.id));
}

const adjacentBefore = (lines: Line[], line: Line) => lines.find(l => l.id !== line.id && l.validTo === line.validFrom);
const adjacentAfter = (lines: Line[], line: Line) => line.validTo === null ? undefined
  : lines.find(l => l.id !== line.id && l.validFrom === line.validTo);
const earlier = (a: string, b: string) => (a < b ? a : b);

export async function correctDirectSuperiorPeriod(ctx: SessionContext, input: DirectSuperiorPeriodCorrection) {
  const reason = input.reason.trim();
  if (!reason || reason.length > 200) fail('Enter a correction reason of up to 200 characters.');
  return withTenant(ctx, tx => correctDirectSuperiorPeriodTx(tx, ctx, { ...input, reason }));
}

export async function correctDirectSuperiorPeriodTx(tx: Tx, ctx: SessionContext, input: DirectSuperiorPeriodCorrection) {
  const { employmentId, reason } = input;
  await lockAccessConfigurationTx(tx, ctx.tenantId);
  const [subjectCompany] = await tx.select({ companyId: employment.companyId }).from(employment)
    .where(and(eq(employment.id, employmentId), eq(employment.tenantId, ctx.tenantId))).limit(1);
  if (!subjectCompany) fail('Employee record is unavailable.');
  await administratorTx(tx, ctx, subjectCompany!.companyId);
  await assertWorkforceEmploymentTx(tx, ctx, employmentId, 'maintain');
  await lockEmploymentLeaveDependenciesTx(tx, ctx.tenantId, [employmentId], { configuration: true });
  await lockOrgReportingTx(tx, ctx.tenantId);
  await lockPayrollInputsTx(tx, { employmentIds: [employmentId] });
  await lockEmploymentStatutoryOwnerTx(tx, employmentId);
  const [subject] = await tx.select({ hiredOn: employment.hiredOn, terminatedOn: employment.terminatedOn })
    .from(employment).where(and(eq(employment.tenantId, ctx.tenantId), eq(employment.id, employmentId))).for('update');

  const before = await liveLinesTx(tx, ctx, employmentId);
  if (directSuperiorRevision(before) !== input.revision) {
    fail('The Direct Superior periods changed after this page opened. Reload the page and try again.');
  }
  const target = before.find(line => line.id === input.lineId);
  if (!target) fail('This Direct Superior period is no longer recorded. Reload the page and try again.');

  const replaced: { supersededId: string; replacementId: string | null }[] = [];
  const movementIds: string[] = [];
  let direct = false;
  let touchedFrom: string | null = null;
  let touchedUntil: string | null | undefined;
  const touch = (from: string, until: string | null) => {
    touchedFrom = touchedFrom === null ? from : earlier(touchedFrom, from);
    touchedUntil = touchedUntil === undefined ? until : touchedUntil === null || until === null ? null : until > touchedUntil ? until : touchedUntil;
  };
  const prepareDirect = async () => {
    if (direct) return;
    direct = true;
    await preserveMovementPayrollTx(tx, employmentId, message => new DirectSuperiorPeriodError(message));
  };
  const lines = () => liveLinesTx(tx, ctx, employmentId);
  const owners = async () => directSuperiorLineOwnersTx(tx, ctx, employmentId);

  /** Supersede a line and re-insert it with `patch` (history kept; Roll Back follows the replacement). */
  const replaceLine = async (line: Line, patch: Partial<Pick<Line, 'managerEmploymentId' | 'validFrom' | 'validTo'>>) => {
    await prepareDirect();
    const next = { ...line, ...patch };
    await assertDirectSuperiorCandidateTx(tx, ctx, { employmentId, managerEmploymentId: next.managerEmploymentId,
      from: next.validFrom, until: next.validTo });
    await tx.update(reportingLine).set({ supersededAt: new Date() }).where(eq(reportingLine.id, line.id));
    const [row] = await tx.insert(reportingLine).values({ tenantId: ctx.tenantId, subordinateEmploymentId: employmentId,
      managerEmploymentId: next.managerEmploymentId, lineType: 'administrative', validFrom: next.validFrom, validTo: next.validTo })
      .returning({ id: reportingLine.id });
    replaced.push({ supersededId: line.id, replacementId: row.id });
    touch(earlier(line.validFrom, next.validFrom), line.validTo === null || next.validTo === null ? null
      : line.validTo > next.validTo ? line.validTo : next.validTo);
    return { ...next, id: row.id };
  };
  /** Move a neighbour's end in place (its identity and its movement link are unchanged). */
  const setEnd = async (line: Line, validTo: string | null) => {
    await prepareDirect();
    if (validTo === null || validTo > (line.validTo ?? '9999-12-31')) {
      await assertDirectSuperiorCandidateTx(tx, ctx, { employmentId, managerEmploymentId: line.managerEmploymentId,
        from: line.validFrom, until: validTo });
    }
    await tx.update(reportingLine).set({ validTo }).where(eq(reportingLine.id, line.id));
    const a = line.validTo, b = validTo;
    touch(a === null || b === null ? (a ?? b ?? line.validFrom) : earlier(a, b), a === null || b === null ? null : a > b ? a : b);
  };
  const supersede = async (line: Line) => {
    await prepareDirect();
    await tx.update(reportingLine).set({ supersededAt: new Date() }).where(eq(reportingLine.id, line.id));
    replaced.push({ supersededId: line.id, replacementId: null });
    touch(line.validFrom, line.validTo);
  };
  /** Correct a movement-owned period through its movement (Edit = replay through the same writers). */
  const editMovement = async (movementId: string, effectiveDate: string, managerEmploymentId: string) => {
    const base = await movementCorrectionBaseTx(tx, ctx, employmentId, movementId);
    if (!base?.input) fail('This Direct Superior change cannot be corrected here. Use Employment History.');
    await editMovementEventTx(tx, ctx, { ...base!.input!, employmentId, movementId, effectiveDate, managerEmploymentId, reason });
    movementIds.push(movementId);
  };

  /** Start a period on `validFrom`, moving the end of the period right before it. */
  const moveStart = async (line: Line, validFrom: string) => {
    const owner = (await owners()).get(line.id);
    if (owner) return editMovement(owner.movementId, validFrom, line.managerEmploymentId);
    const all = await lines();
    const previous = adjacentBefore(all, line);
    // Shrink before growing, so two live periods never overlap even inside the transaction.
    if (previous && validFrom < line.validFrom) await setEnd(previous, validFrom);
    const moved = await replaceLine(line, { validFrom });
    if (previous && validFrom > line.validFrom) await setEnd(previous, validFrom);
    return moved;
  };
  /** Remove a period: the one before carries on over its dates; the first period is covered by the next. */
  const removeLine = async (line: Line) => {
    await assertMovementDeleteTx(tx, ctx, employmentId);
    const all = await lines();
    const previous = adjacentBefore(all, line);
    const following = adjacentAfter(all, line);
    const owner = (await owners()).get(line.id);
    if (owner) {
      await reverseMovementForImportTx(tx, ctx, employmentId, owner.movementId, reason);
      movementIds.push(owner.movementId);
    } else {
      await supersede(line);
      if (previous) await setEnd(previous, line.validTo);
    }
    if (!previous && following) {
      const live = (await lines()).find(l => l.id === following.id) ?? (await lines()).find(l => l.validFrom === following.validFrom);
      if (live) await moveStart(live, line.validFrom);
    }
  };

  if (input.operation === 'remove') {
    await removeLine(target!);
  } else {
    const { managerEmploymentId, validFrom, validToInclusive } = input;
    if (!isCalendarDate(validFrom) || (validToInclusive !== null && !isCalendarDate(validToInclusive))) {
      fail('Enter valid Start and End dates.');
    }
    const validTo = validToInclusive === null ? null : addCalendarDays(validToInclusive, 1);
    if (validTo !== null && validTo <= validFrom) fail('The End Date must be on or after the Start Date.');
    if (validFrom < subject!.hiredOn) fail('The Start Date must be on or after the hiring date.');
    if (subject!.terminatedOn && (validFrom >= subject!.terminatedOn || (validTo !== null && validTo > subject!.terminatedOn))) {
      fail('The period must fall within the employee’s employment.');
    }
    const t = target!;
    const all = before;
    const index = all.findIndex(line => line.id === t.id);
    const previous = adjacentBefore(all, t);
    const previousAny = index > 0 ? all[index - 1] : undefined;
    const following = adjacentAfter(all, t);
    if (previous && validFrom <= previous.validFrom) {
      fail('The Start Date would cover the whole previous period. Remove that period instead.');
    }
    if (!previous && previousAny && previousAny.validTo !== null && validFrom < previousAny.validTo) {
      fail('The Start Date would overlap the previous period.');
    }
    if (validTo === null && t.validTo !== null) {
      if (!following) fail('This period ends because of a later change in Employment History. Change it there.');
      if (all.some(line => line.validFrom > following!.validFrom)) fail('Remove the later periods first, starting with the newest.');
    }
    if (validTo !== null && t.validTo === null) {
      fail('The current period has no end date. To end it, save a change to "No Direct Superior" with that date.');
    }
    if (validTo !== null && t.validTo !== null && validTo !== t.validTo) {
      if (!following) fail('This period ends because of a later change in Employment History. Change it there.');
      if (following!.validTo !== null && validTo >= following!.validTo) {
        fail('The End Date would cover the whole next period. Remove that period instead.');
      }
    }

    // 1. Superior and start (one replay when a movement owns the period).
    let current: Line = t;
    if (validFrom !== t.validFrom || managerEmploymentId !== t.managerEmploymentId) {
      const owner = (await owners()).get(t.id);
      if (owner) {
        await editMovement(owner.movementId, validFrom, managerEmploymentId);
      } else if (validFrom !== t.validFrom) {
        const moved = await moveStart(t, validFrom);
        if (moved && managerEmploymentId !== t.managerEmploymentId) await replaceLine(moved, { managerEmploymentId });
      } else {
        await replaceLine(t, { managerEmploymentId });
      }
      const refreshed = (await lines()).find(line => line.validFrom === validFrom && line.managerEmploymentId === managerEmploymentId);
      if (!refreshed) fail('The Direct Superior period could not be found after the correction. Reload and review it.');
      current = refreshed!;
    }
    // 2. End: clear it (the next period goes) or move the next period's start.
    if (validTo === null && current.validTo !== null) {
      const next = adjacentAfter(await lines(), current);
      if (!next) fail('This period ends because of a later change in Employment History. Change it there.');
      await removeLine(next!);
    } else if (validTo !== null && current.validTo !== null && validTo !== current.validTo) {
      const next = adjacentAfter(await lines(), current);
      if (!next) fail('This period ends because of a later change in Employment History. Change it there.');
      await moveStart(next!, validTo);
    }
  }

  const after = await liveLinesTx(tx, ctx, employmentId);
  for (let i = 0; i + 1 < after.length; i++) {
    if (after[i].validTo === null || after[i].validTo! > after[i + 1].validFrom) {
      fail('This correction would make two Direct Superior periods overlap.');
    }
  }
  if (directSuperiorRevision(after) === directSuperiorRevision(before)) fail('Nothing changed. The period already has these details.');

  if (direct) {
    await markWorkforcePayrollInputsChangedTx(tx, ctx, { employmentId, from: touchedFrom ?? target!.validFrom, until: touchedUntil ?? null });
    const span = (line: Line) => ({ managerEmploymentId: line.managerEmploymentId, validFrom: line.validFrom, validTo: line.validTo });
    const targetAfter = after.find(line => replaced.some(r => r.supersededId === target!.id && r.replacementId === line.id)) ?? null;
    await appendEvent(tx, {
      tenantId: ctx.tenantId, actor: actorOf(ctx), subjectEmploymentId: employmentId,
      aggregateType: 'employment', aggregateId: employmentId, eventType: INFORMATION_CORRECTED_EVENT,
      payload: {
        source: 'direct-superior', operation: input.operation === 'remove' ? 'period-remove' : 'period-edit',
        method: 'manual', reason, effectiveOn: touchedFrom ?? target!.validFrom, dated: true,
        fields: ['managerEmploymentId'],
        before: { managerEmploymentId: target!.managerEmploymentId }, after: { managerEmploymentId: targetAfter?.managerEmploymentId ?? null },
        periods: { before: before.map(span), after: after.map(span) },
        reportingLines: replaced, ...(movementIds.length ? { movementIds } : {}),
      },
    });
  }
  return { periods: after };
}
