/**
 * Leave Encashment (ADR-0069) — LEAVE-SIDE ONLY. On resignation approval, freezes the employee's Annual
 * Leave balance and computes an encashable-days figure for Payroll to consume. Deliberately does NO
 * salary math, NO RM conversion, NO payroll logic — see ADR-0069 for the full scope boundary and the
 * enforcement design (one DB trigger + one UX pre-check + sweep skip-filters).
 */
import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  employment,
  leaveApprovalStep,
  leaveEncashmentPolicy,
  leaveEncashmentSnapshot,
  leaveLedger,
  leaveRequest,
  leaveRequestDate,
  leaveType,
} from '../db/schema';

export class LeaveEncashmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveEncashmentError';
  }
}

/** Stable message prefix so the client can map this to a translated string (messages/*.json
 *  people.encashment / leave error keys) without depending on the full English sentence. */
export const LEAVE_BALANCE_FROZEN_PREFIX = 'LEAVE_BALANCE_FROZEN';

export class LeaveBalanceFrozenError extends LeaveEncashmentError {
  constructor(message = `${LEAVE_BALANCE_FROZEN_PREFIX}: this leave balance is frozen for encashment and cannot be changed.`) {
    super(message);
    this.name = 'LeaveBalanceFrozenError';
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Pure rounding rule (request's own worked examples): < 0.5 -> 0, >= 0.5 -> 1, minimum 0. Inputs are
 * arbitrary round2-precision values (hourly leave debits produce fractions like 0.13), not just
 * 0.5-step balances, so this must handle any real number, not only halves.
 */
export function computeEncashableDays(raw: number): number {
  return Math.max(0, Math.floor(round2(raw) + 0.5));
}

// ─── policy ──────────────────────────────────────────────────────────────────────────────────────────

export type EncashmentPolicyInput = {
  companyId: string;
  enabled: boolean;
  autoFreeze: boolean;
};

/** All companies' encashment policy rows (admin read; RLS scopes to the tenant). */
export function getEncashmentPolicies(ctx: SessionContext) {
  return withTenant(ctx, (tx) => tx.select().from(leaveEncashmentPolicy));
}

/** Upsert one company's encashment policy. Write is admin-gated by RLS (app.is_admin_for(company_id)). */
export async function setEncashmentPolicy(ctx: SessionContext, p: EncashmentPolicyInput) {
  return withTenant(ctx, async (tx) => {
    const [before] = await tx
      .select()
      .from(leaveEncashmentPolicy)
      .where(eq(leaveEncashmentPolicy.companyId, p.companyId))
      .limit(1);
    const [row] = await tx
      .insert(leaveEncashmentPolicy)
      .values({
        tenantId: ctx.tenantId,
        companyId: p.companyId,
        enabled: p.enabled,
        autoFreeze: p.autoFreeze,
      })
      .onConflictDoUpdate({
        target: leaveEncashmentPolicy.companyId,
        set: { enabled: p.enabled, autoFreeze: p.autoFreeze, updatedAt: sql`now()` },
      })
      .returning();
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-encashment-policy',
      aggregateId: row.id,
      eventType: 'leave-encashment-policy.updated',
      actor: actorOf(ctx),
      payload: {
        companyId: p.companyId,
        before: before ? { enabled: before.enabled, autoFreeze: before.autoFreeze } : null,
        after: { enabled: row.enabled, autoFreeze: row.autoFreeze },
      },
    });
    return row;
  });
}

// ─── freeze ──────────────────────────────────────────────────────────────────────────────────────────

/** The active (status='frozen') snapshot for an employment+type, if any. Used by the requestLeave
 *  pre-check and the sweep skip-filters. */
export async function frozenSnapshotFor(tx: Tx, employmentId: string, leaveTypeId: string) {
  const [row] = await tx
    .select()
    .from(leaveEncashmentSnapshot)
    .where(
      and(
        eq(leaveEncashmentSnapshot.employmentId, employmentId),
        eq(leaveEncashmentSnapshot.leaveTypeId, leaveTypeId),
        eq(leaveEncashmentSnapshot.status, 'frozen'),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The tenant's ANNUAL leave type id, or null if none exists (documented skip — see ADR-0069 §5/§8). */
async function annualLeaveTypeId(tx: Tx, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: leaveType.id })
    .from(leaveType)
    .where(and(eq(leaveType.tenantId, tenantId), eq(leaveType.code, 'ANNUAL')))
    .limit(1);
  return row?.id ?? null;
}

/** Same signed-sum balance read as core/leave.ts leaveBalance (kept local — leave-encashment.ts must not
 *  import from leave.ts to avoid a circular dependency, since leave.ts calls back into this module). */
async function ledgerBalanceOf(tx: Tx, employmentId: string, leaveTypeId: string): Promise<number> {
  const [row] = await tx
    .select({ bal: sql<string>`coalesce(sum(${leaveLedger.days}), 0)` })
    .from(leaveLedger)
    .where(and(eq(leaveLedger.employmentId, employmentId), eq(leaveLedger.leaveTypeId, leaveTypeId)));
  return Number(row?.bal ?? 0);
}

/**
 * Runs inside the caller's transaction (core/offboarding.ts decideResignation, accepted branch, same tx as
 * terminateEmploymentTx). Pre-validates policy on + autoFreeze + an ANNUAL type exists — any precondition
 * unmet is a silent no-op (a resignation approval must never fail because of this feature). Idempotent: an
 * existing snapshot for this resignationRequestId is returned unchanged; the insert additionally uses
 * onConflictDoNothing against the unique index as a retry safety net.
 */
export async function freezeOnResignationApprovalTx(
  tx: Tx,
  ctx: SessionContext,
  p: { employmentId: string; companyId: string; resignationRequestId: string; asOf: string },
): Promise<{ snapshotId: string } | null> {
  const [policy] = await tx
    .select()
    .from(leaveEncashmentPolicy)
    .where(eq(leaveEncashmentPolicy.companyId, p.companyId))
    .limit(1);
  if (!policy || !policy.enabled || !policy.autoFreeze) return null;

  const annualId = await annualLeaveTypeId(tx, ctx.tenantId);
  if (!annualId) return null; // documented skip: tenant has no ANNUAL type

  // Idempotent: a retry (or a second call for the same resignation) returns the existing snapshot.
  const [existing] = await tx
    .select({ id: leaveEncashmentSnapshot.id })
    .from(leaveEncashmentSnapshot)
    .where(
      and(
        eq(leaveEncashmentSnapshot.resignationRequestId, p.resignationRequestId),
        eq(leaveEncashmentSnapshot.leaveTypeId, annualId),
      ),
    )
    .limit(1);
  if (existing) return { snapshotId: existing.id };

  const balance = await ledgerBalanceOf(tx, p.employmentId, annualId);
  const encashableDays = computeEncashableDays(balance);

  const [inserted] = await tx
    .insert(leaveEncashmentSnapshot)
    .values({
      tenantId: ctx.tenantId,
      employmentId: p.employmentId,
      resignationRequestId: p.resignationRequestId,
      leaveTypeId: annualId,
      balanceDays: balance.toFixed(2),
      encashableDays: encashableDays.toFixed(2),
      calculatedAsOf: p.asOf,
      status: 'frozen',
    })
    .onConflictDoNothing({ target: [leaveEncashmentSnapshot.resignationRequestId, leaveEncashmentSnapshot.leaveTypeId] })
    .returning({ id: leaveEncashmentSnapshot.id });

  // Lost the insert race to a concurrent retry — re-read instead of erroring.
  const snapshotId =
    inserted?.id ??
    (
      await tx
        .select({ id: leaveEncashmentSnapshot.id })
        .from(leaveEncashmentSnapshot)
        .where(
          and(
            eq(leaveEncashmentSnapshot.resignationRequestId, p.resignationRequestId),
            eq(leaveEncashmentSnapshot.leaveTypeId, annualId),
          ),
        )
        .limit(1)
    )[0]?.id;
  if (!snapshotId) throw new LeaveEncashmentError('Failed to record the leave encashment snapshot.');

  await appendEvent(tx, {
    tenantId: ctx.tenantId,
    aggregateType: 'leave-encashment-snapshot',
    aggregateId: snapshotId,
    eventType: 'leave-encashment.frozen',
    actor: actorOf(ctx),
    subjectEmploymentId: p.employmentId,
    payload: {
      leaveTypeId: annualId,
      balanceDays: balance,
      encashableDays,
      asOf: p.asOf,
      resignationRequestId: p.resignationRequestId,
    },
  });

  // Any Annual Leave request still sitting pending would otherwise be stuck forever (the balance is now
  // frozen, so it can never be approved) — auto-reject with a system note so the approvals inbox is not
  // left jammed. Rejection writes no ledger row, so this is safe to run after the snapshot.
  const pending = await tx
    .select({ id: leaveRequest.id, employmentId: leaveRequest.employmentId })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, p.employmentId),
        eq(leaveRequest.leaveTypeId, annualId),
        eq(leaveRequest.status, 'pending'),
      ),
    );
  for (const req of pending) {
    await tx
      .update(leaveRequest)
      .set({ status: 'rejected', decidedAt: sql`now()` })
      .where(eq(leaveRequest.id, req.id));
    await tx
      .update(leaveApprovalStep)
      .set({ status: 'rejected', decidedAt: sql`now()` })
      .where(and(eq(leaveApprovalStep.leaveRequestId, req.id), eq(leaveApprovalStep.status, 'pending')));
    await tx
      .update(leaveRequestDate)
      .set({ status: 'rejected', rejectReason: 'Leave balance frozen for encashment (resignation approved).', decidedAt: sql`now()` })
      .where(and(eq(leaveRequestDate.leaveRequestId, req.id), eq(leaveRequestDate.status, 'pending')));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-request',
      aggregateId: req.id,
      eventType: 'leave-request.rejected',
      actor: actorOf(ctx),
      subjectEmploymentId: req.employmentId,
      payload: { decision: 'rejected', rejectReason: 'Leave balance frozen for encashment (resignation approved).', auto: true },
    });
  }

  return { snapshotId };
}

// ─── overrides ───────────────────────────────────────────────────────────────────────────────────────

/** Admin-only (RLS), reason mandatory. Re-opens ledger writes for this employment+type by flipping the
 *  snapshot to 'unfrozen' (the freeze trigger's EXISTS predicate no longer matches). */
export async function unfreezeEncashment(ctx: SessionContext, p: { snapshotId: string; reason: string }) {
  const reason = p.reason?.trim();
  if (!reason) throw new LeaveEncashmentError('A reason is required to unfreeze a leave encashment snapshot.');
  return withTenant(ctx, async (tx) => {
    const [snap] = await tx.select().from(leaveEncashmentSnapshot).where(eq(leaveEncashmentSnapshot.id, p.snapshotId)).limit(1);
    if (!snap) throw new LeaveEncashmentError('Leave encashment snapshot not found (or not visible).');
    if (snap.status !== 'frozen') throw new LeaveEncashmentError('This snapshot is already unfrozen.');
    await tx
      .update(leaveEncashmentSnapshot)
      .set({ status: 'unfrozen', updatedAt: sql`now()` })
      .where(eq(leaveEncashmentSnapshot.id, snap.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-encashment-snapshot',
      aggregateId: snap.id,
      eventType: 'leave-encashment.unfrozen',
      actor: actorOf(ctx),
      subjectEmploymentId: snap.employmentId,
      payload: { reason },
    });
    return { status: 'unfrozen' as const };
  });
}

/** Admin-only (RLS), reason mandatory. Sets the manual override figure AND re-locks (status -> 'frozen') —
 *  there is no separate "recalculate" verb; unfreeze + adjust are the two HR powers the request grants. */
export async function adjustEncashment(
  ctx: SessionContext,
  p: { snapshotId: string; overrideDays: number; reason: string },
) {
  const reason = p.reason?.trim();
  if (!reason) throw new LeaveEncashmentError('A reason is required to adjust a leave encashment figure.');
  if (!(Number.isFinite(p.overrideDays) && p.overrideDays >= 0)) {
    throw new LeaveEncashmentError('The adjusted figure must be zero or a positive number of days.');
  }
  const overrideDays = round2(p.overrideDays);
  return withTenant(ctx, async (tx) => {
    const [snap] = await tx.select().from(leaveEncashmentSnapshot).where(eq(leaveEncashmentSnapshot.id, p.snapshotId)).limit(1);
    if (!snap) throw new LeaveEncashmentError('Leave encashment snapshot not found (or not visible).');
    const before = { overrideDays: snap.overrideDays, status: snap.status };
    await tx
      .update(leaveEncashmentSnapshot)
      .set({ overrideDays: overrideDays.toFixed(2), overrideReason: reason, status: 'frozen', updatedAt: sql`now()` })
      .where(eq(leaveEncashmentSnapshot.id, snap.id));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-encashment-snapshot',
      aggregateId: snap.id,
      eventType: 'leave-encashment.adjusted',
      actor: actorOf(ctx),
      subjectEmploymentId: snap.employmentId,
      payload: { before, after: { overrideDays, status: 'frozen' }, reason },
    });
    return { status: 'frozen' as const, overrideDays };
  });
}

// ─── reads ───────────────────────────────────────────────────────────────────────────────────────────

/** Approved Annual Leave days for an employment dated AFTER the last working day — already debited at
 *  approval, but never to be taken (the employee's last working day has passed). Powers the "N day(s) fall
 *  after the last working day" hint on the people-page card; the correction path is unfreeze -> cancel
 *  those requests -> adjust (re-locks). Read-only, no events.append (CLAUDE.md skip rule).
 *
 *  3f15ffdb (r362) — MIGRATED HISTORY IS EXCLUDED, because this hint's premise ("already debited at
 *  approval") is false for it: a record loaded by Leave History Data Import carries no ledger debit by
 *  design (migration 0490). Counting one here would raise a hint whose own documented remedy does not
 *  work — cancelling such a request gives back nothing, correctly, since nothing was ever charged — and
 *  would send an HR admin round a loop that cannot close. The hint keeps naming exactly the rows it can
 *  still fix. */
export async function approvedLeaveDaysAfter(
  tx: Tx,
  employmentId: string,
  leaveTypeId: string,
  lastWorkingDay: string,
): Promise<number> {
  const [row] = await tx
    .select({ sum: sql<string>`coalesce(sum(${leaveRequest.days}), 0)` })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employmentId, employmentId),
        eq(leaveRequest.leaveTypeId, leaveTypeId),
        eq(leaveRequest.status, 'approved'),
        eq(leaveRequest.importedHistory, false),
        gt(leaveRequest.startDate, lastWorkingDay),
      ),
    );
  return Number(row?.sum ?? 0);
}

export type EncashmentSnapshotView = {
  id: string;
  leaveTypeId: string;
  balanceDays: number;
  encashableDays: number;
  overrideDays: number | null;
  days: number; // effective = overrideDays ?? encashableDays
  status: 'frozen' | 'unfrozen';
  calculatedAsOf: string;
  overrideReason: string | null;
};

/** The most recent snapshot for an employment (any leave type — currently always ANNUAL), for the
 *  people-page card. Null if none exists (policy off, or no resignation approved yet). */
export function encashmentSnapshotForEmployment(ctx: SessionContext, employmentId: string) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(leaveEncashmentSnapshot)
      .where(eq(leaveEncashmentSnapshot.employmentId, employmentId))
      .orderBy(sql`${leaveEncashmentSnapshot.createdAt} desc`)
      .limit(1);
    if (!row) return null;
    const encashableDays = Number(row.encashableDays);
    const overrideDays = row.overrideDays != null ? Number(row.overrideDays) : null;
    const view: EncashmentSnapshotView = {
      id: row.id,
      leaveTypeId: row.leaveTypeId,
      balanceDays: Number(row.balanceDays),
      encashableDays,
      overrideDays,
      days: overrideDays ?? encashableDays,
      status: row.status,
      calculatedAsOf: row.calculatedAsOf,
      overrideReason: row.overrideReason,
    };
    return view;
  });
}

export type EncashmentForPayroll = {
  leaveTypeId: string;
  days: number; // effective figure = overrideDays ?? encashableDays
  balanceDays: number;
  status: 'frozen' | 'unfrozen';
  calculatedAsOf: string;
  overridden: boolean;
};

/**
 * THE Payroll integration point. This product has no external/HTTP API between modules — every module
 * boundary here is an in-process exported function (core/payroll.ts already reads leave_ledger directly).
 * This export IS the "API design for Payroll integration" deliverable: Payroll gets day-counts only, never
 * money. Must run inside an existing transaction (payroll's leaverAdvisory already holds one).
 */
export async function encashableDaysForEmployment(tx: Tx, employmentId: string): Promise<EncashmentForPayroll | null> {
  const [row] = await tx
    .select()
    .from(leaveEncashmentSnapshot)
    .where(and(eq(leaveEncashmentSnapshot.employmentId, employmentId), eq(leaveEncashmentSnapshot.status, 'frozen')))
    .limit(1);
  if (!row) return null;
  const encashableDays = Number(row.encashableDays);
  const overrideDays = row.overrideDays != null ? Number(row.overrideDays) : null;
  return {
    leaveTypeId: row.leaveTypeId,
    days: overrideDays ?? encashableDays,
    balanceDays: Number(row.balanceDays),
    status: row.status,
    calculatedAsOf: row.calculatedAsOf,
    overridden: overrideDays != null,
  };
}
