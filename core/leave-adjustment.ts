/**
 * 491c499f — Leave Adjustments as a PLACE, and a bulk adjustment as a REVERSIBLE UNIT.
 *
 * Adjustments are made today from inside a leave type's Entitlement step (the festive-grant card). The
 * reporter's point is that an adjustment is a TRANSACTION, not configuration: it does not belong in a
 * settings screen, and a grant spanning several leave types should not have to be repeated per type.
 *
 * This module is the write side of that move. `38f1fd40` removes the old step, and its plan and this one
 * both say the same thing in the same order: BUILD THIS FIRST. Removing the old step before this exists
 * leaves a period with no way to make an adjustment at all — the 241817ef lesson, convert then remove.
 *
 * ── WHY grantAdHocLeave COULD NOT BE REUSED ───────────────────────────────────────────────────────────
 * It looks like the same operation and is not:
 *   • it REFUSES days <= 0 (core/leave.ts, 'Days must be a positive number'), so it cannot express a
 *     downward adjustment — and an adjustment that can only give is not an adjustment;
 *   • it targets whole COMPANIES, with no per-employment list and no criteria;
 *   • its idempotency key is (employmentId, leaveTypeId, 'adjustment', effectiveOn, reason), which has no
 *     room for a batch and would collapse two deliberate identical batches into one.
 * It stays exactly as it is, still serving the festive-grant card until 38f1fd40 retires that screen.
 *
 * ── WHAT IS DELIBERATELY SHARED ───────────────────────────────────────────────────────────────────────
 * The ledger row shape, the `sys:` reason discipline, and the frozen-snapshot skip. A row written here is
 * indistinguishable from one written by the old card except for its batch reference, which is the point:
 * the plan promises "adjustments made here will show on the employee's leave record the same way today's
 * do, so there is no separate history to reconcile".
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import {
  employment,
  leaveAdjustmentBatch,
  leaveLedger,
  leaveType,
  person,
} from '../db/schema';
import { countOrgCriteriaTargets, resolveOrgCriteriaTargets, type OrgCriteria } from './org-criteria';

export class LeaveAdjustmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaveAdjustmentError';
  }
}

/**
 * Who a batch targets. Mirrors the leave-type Condition step's criteria vocabulary exactly, so the same
 * builder can drive both — the plan asks for "the same criteria builder you already use elsewhere so the
 * fields and behaviour are familiar".
 *
 * 6e122302: this is now an ALIAS for `OrgCriteria` (core/org-criteria.ts) rather than its own type. The
 * Notice Board asks the identical question of the identical columns, and two structurally-equal types that
 * are maintained separately drift the moment one of them gains an axis. Every existing import of
 * `AdjustmentCriteria` keeps compiling and keeps meaning exactly what it did.
 */
export type AdjustmentCriteria = OrgCriteria;

/**
 * THE SET RESOLVER — now a delegate to the SHARED one.
 *
 * 6e122302 lifted the body of this function into `core/org-criteria.ts` unchanged, because the Notice
 * Board needs the same answer to the same question and a second copy of "who does this apply to" is
 * precisely the duplicate-maintenance defect 6e9a126e was raised about. The approved plan requires the
 * generalisation rather than a copy.
 *
 * IT STAYS EXPORTED, AND IT STAYS A ONE-LINER, ON PURPOSE. Its callers, its error messages and
 * `test/leave-adjustment-batch.test.ts` are all untouched, so the leave-adjustment behaviour is provably
 * identical while the notice path runs the same engine rather than a cousin of it. `effectiveOn` is the
 * leave vocabulary for what the shared resolver calls `asOf` — same value, same meaning; the parameter is
 * renamed at the seam rather than in eleven call sites.
 *
 * ⚠️ AN EMPTY CRITERIA OBJECT STILL MATCHES EVERY ACTIVE EMPLOYMENT, and the caller is still responsible
 * for showing the resolved count before it lets anyone press the button. See the shared module's header.
 */
export async function resolveAdjustmentTargets(
  tx: Tx,
  p: { criteria: AdjustmentCriteria; effectiveOn: string },
): Promise<string[]> {
  return resolveOrgCriteriaTargets(tx, { criteria: p.criteria ?? {}, asOf: p.effectiveOn });
}

/** Round to 2dp, matching the rest of the leave math. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export type ApplyAdjustmentInput = {
  /** One batch may span several leave types — the whole point of moving this out of the leave type. */
  leaveTypeIds: string[];
  days: number;
  effectiveOn: string;
  reason: string;
  /** 'criteria' resolves the set; 'individual' takes the ids verbatim. Recorded either way. */
  targetMode: 'criteria' | 'individual';
  criteria?: AdjustmentCriteria;
  employmentIds?: string[];
};

/**
 * Apply one adjustment to every (employment × leave type) in the batch, and record it as ONE action.
 *
 * Returns the batch id, the resolved target count, and the number of ledger rows actually written. Those
 * last two differ when a target is skipped, which is not an error: a frozen encashment snapshot (ADR-0069)
 * makes a balance immutable, and writing through it would contradict a figure an employee has already been
 * paid against.
 */
export async function applyLeaveAdjustmentBatch(
  ctx: SessionContext,
  p: ApplyAdjustmentInput,
): Promise<{ batchId: string; targeted: number; written: number; skipped: number }> {
  const days = round2(Number(p.days));
  if (!Number.isFinite(days) || days === 0) {
    throw new LeaveAdjustmentError('Days must be a number other than zero — an adjustment of nothing is not an adjustment.');
  }
  if (Math.abs(days) > 366) throw new LeaveAdjustmentError('Days cannot exceed 366.');
  if (!Number.isInteger(days * 2)) {
    throw new LeaveAdjustmentError('Days must be in 0.5 increments (e.g. 0.5, 1.0, -1.5).');
  }
  const reason = p.reason?.trim();
  if (!reason) throw new LeaveAdjustmentError('A reason is required — it is what the employee sees on their leave record.');
  // The `sys:` prefix is how the sweeps mark machine-written rows, and the reconciliation queries filter on
  // it. A human reason wearing that prefix would be swept up as if the system had written it.
  if (reason.startsWith('sys:')) {
    throw new LeaveAdjustmentError('A reason may not start with "sys:" — that prefix is reserved for automatic entries.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveOn)) throw new LeaveAdjustmentError('A valid effective date is required.');
  const leaveTypeIds = Array.from(new Set((p.leaveTypeIds ?? []).filter(Boolean)));
  if (!leaveTypeIds.length) throw new LeaveAdjustmentError('Choose at least one leave type.');

  return withTenant(ctx, async (tx) => {
    // Leave types must exist and be visible to this session — RLS scopes the read, so an id from another
    // tenant simply does not come back and is refused here rather than silently skipped.
    const types = await tx
      .select({ id: leaveType.id })
      .from(leaveType)
      .where(inArray(leaveType.id, leaveTypeIds));
    if (types.length !== leaveTypeIds.length) {
      throw new LeaveAdjustmentError('One or more leave types could not be found.');
    }

    const targets =
      p.targetMode === 'individual'
        ? Array.from(new Set((p.employmentIds ?? []).filter(Boolean)))
        : await resolveAdjustmentTargets(tx, { criteria: p.criteria ?? {}, effectiveOn: p.effectiveOn });
    if (!targets.length) throw new LeaveAdjustmentError('No employees matched — nothing would be adjusted.');

    // An explicitly-listed employment must still be one this session can see; RLS decides that.
    const visible = await tx
      .select({ id: employment.id })
      .from(employment)
      .where(inArray(employment.id, targets));
    const targetIds = visible.map((v) => v.id);
    if (!targetIds.length) throw new LeaveAdjustmentError('No employees matched — nothing would be adjusted.');

    const [batch] = await tx
      .insert(leaveAdjustmentBatch)
      .values({
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId ?? null,
        days: days.toFixed(2),
        effectiveOn: p.effectiveOn,
        reason,
        targetMode: p.targetMode,
        criteria: p.targetMode === 'criteria' ? ((p.criteria ?? {}) as unknown) : null,
        targetedCount: targetIds.length * leaveTypeIds.length,
      })
      .returning({ id: leaveAdjustmentBatch.id });

    // ADR-0069: a frozen encashment snapshot makes that (employment, type) balance immutable. Skipped, not
    // failed — one frozen employee must not abort an adjustment for two hundred others, and the batch
    // records the difference between targeted and written so the skip is visible rather than silent.
    const { frozenAdjustmentKeys } = await import('./leave');
    const frozen = await frozenAdjustmentKeys(tx, targetIds, leaveTypeIds);

    const rows: { employmentId: string; leaveTypeId: string }[] = [];
    for (const employmentId of targetIds) {
      for (const leaveTypeId of leaveTypeIds) {
        if (frozen.has(`${employmentId}|${leaveTypeId}`)) continue;
        rows.push({ employmentId, leaveTypeId });
      }
    }

    if (rows.length) {
      await tx.insert(leaveLedger).values(
        rows.map((r) => ({
          tenantId: ctx.tenantId,
          employmentId: r.employmentId,
          leaveTypeId: r.leaveTypeId,
          entryType: 'adjustment' as const,
          days: days.toFixed(2),
          effectiveOn: p.effectiveOn,
          reason,
          adjustmentBatchId: batch.id,
        })),
      );
    }

    await tx
      .update(leaveAdjustmentBatch)
      .set({ writtenCount: rows.length })
      .where(eq(leaveAdjustmentBatch.id, batch.id));

    // ONE event per batch, keyed on the BATCH — unlike the festive grant, whose summary event is keyed on
    // the tenant and therefore cannot be traced back to the rows it wrote.
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-adjustment-batch',
      aggregateId: batch.id,
      eventType: 'leave.adjustment.applied',
      actor: actorOf(ctx),
      payload: {
        leaveTypeIds,
        days,
        effectiveOn: p.effectiveOn,
        reason,
        targetMode: p.targetMode,
        targeted: targetIds.length * leaveTypeIds.length,
        written: rows.length,
      },
    });

    return {
      batchId: batch.id,
      targeted: targetIds.length * leaveTypeIds.length,
      written: rows.length,
      skipped: targetIds.length * leaveTypeIds.length - rows.length,
    };
  });
}

/**
 * Undo a batch by writing COMPENSATING rows, never by deleting.
 *
 * The ledger is append-only (ADR-0006). Deleting the original rows would erase the fact that the
 * adjustment happened, and a balance that silently loses history is exactly what the audit substrate
 * exists to prevent. So the reversal writes the negation of each row, links it to the SAME batch, and
 * stamps the batch as reversed so the screen stops offering it a second time.
 *
 * The reversal rows carry the same batch id ON PURPOSE: "what did this action do, and what undid it" is
 * one question, and answering it should not require joining two batches.
 */
export async function reverseLeaveAdjustmentBatch(
  ctx: SessionContext,
  p: { batchId: string; reversedOn?: string },
): Promise<{ reversed: number }> {
  return withTenant(ctx, async (tx) => {
    const [batch] = await tx
      .select({
        id: leaveAdjustmentBatch.id,
        reversedAt: leaveAdjustmentBatch.reversedAt,
        reason: leaveAdjustmentBatch.reason,
        effectiveOn: leaveAdjustmentBatch.effectiveOn,
      })
      .from(leaveAdjustmentBatch)
      .where(eq(leaveAdjustmentBatch.id, p.batchId))
      .limit(1);
    if (!batch) throw new LeaveAdjustmentError('That adjustment could not be found.');
    if (batch.reversedAt) throw new LeaveAdjustmentError('That adjustment has already been reversed.');

    // Only the rows this batch WROTE — the CHECK on leave_ledger already confines them to 'adjustment',
    // and the reversal rows written below are excluded by their own reason prefix so a second reverse
    // cannot compound. (Guarded anyway by the reversedAt check above; belt and braces on an append-only
    // table is cheap and the failure mode is handing days out twice.)
    const original = await tx
      .select({
        employmentId: leaveLedger.employmentId,
        leaveTypeId: leaveLedger.leaveTypeId,
        days: leaveLedger.days,
      })
      .from(leaveLedger)
      .where(
        and(
          eq(leaveLedger.adjustmentBatchId, p.batchId),
          sql`${leaveLedger.reason} = ${batch.reason}`,
        ),
      );

    const reversedOn = p.reversedOn && /^\d{4}-\d{2}-\d{2}$/.test(p.reversedOn) ? p.reversedOn : batch.effectiveOn;
    if (original.length) {
      await tx.insert(leaveLedger).values(
        original.map((r) => ({
          tenantId: ctx.tenantId,
          employmentId: r.employmentId,
          leaveTypeId: r.leaveTypeId,
          entryType: 'adjustment' as const,
          days: (-Number(r.days)).toFixed(2),
          effectiveOn: reversedOn,
          // A HUMAN reason, not a sys: code — this was a person undoing a person's action, and
          // classifyLedgerAdjustment must keep counting it as a config adjustment like its original.
          reason: `Reversal of: ${batch.reason}`,
          adjustmentBatchId: p.batchId,
        })),
      );
    }

    await tx
      .update(leaveAdjustmentBatch)
      .set({ reversedAt: sql`now()`, reversedByUserId: ctx.userId ?? null })
      .where(eq(leaveAdjustmentBatch.id, p.batchId));

    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'leave-adjustment-batch',
      aggregateId: p.batchId,
      eventType: 'leave.adjustment.reversed',
      actor: actorOf(ctx),
      payload: { reversed: original.length, reversedOn },
    });

    return { reversed: original.length };
  });
}

/**
 * The recent batches, for the screen's "what did I just do" list. Read-only.
 *
 * The plan's requirement is that a bulk grant "needs a way to see what it did afterwards ... so a mistake
 * can be found and reversed as a unit rather than employee by employee". This is that list, and it reads
 * the BATCH rather than re-deriving it from the ledger — the whole reason the table exists.
 */
export async function listLeaveAdjustmentBatches(
  ctx: SessionContext,
  opts: { limit?: number } = {},
): Promise<
  {
    id: string;
    days: number;
    effectiveOn: string;
    reason: string;
    targetMode: string;
    targetedCount: number;
    writtenCount: number;
    createdAt: Date;
    reversedAt: Date | null;
  }[]
> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leaveAdjustmentBatch.id,
        days: leaveAdjustmentBatch.days,
        effectiveOn: leaveAdjustmentBatch.effectiveOn,
        reason: leaveAdjustmentBatch.reason,
        targetMode: leaveAdjustmentBatch.targetMode,
        targetedCount: leaveAdjustmentBatch.targetedCount,
        writtenCount: leaveAdjustmentBatch.writtenCount,
        createdAt: leaveAdjustmentBatch.createdAt,
        reversedAt: leaveAdjustmentBatch.reversedAt,
      })
      .from(leaveAdjustmentBatch)
      .orderBy(sql`${leaveAdjustmentBatch.createdAt} desc`)
      .limit(limit);
    return rows.map((r) => ({ ...r, days: Number(r.days) }));
  });
}

/**
 * How many employments a set of criteria currently resolves to — the count a screen MUST show before it
 * lets anyone press the button. `resolveAdjustmentTargets` deliberately does not second-guess an empty
 * criteria object, so this is the thing that stops "no restrictions" becoming an accidental whole-company
 * grant.
 *
 * 6e122302: delegates to the shared `countOrgCriteriaTargets`, same as the resolver above.
 *
 * 18103ba4 GAVE IT ITS FIRST CALLER. Until then it had ZERO — verified by grep before this item was built,
 * confirming the Notice Board plan's claim that "the live matched-count control already exists on
 * /admin/leave/adjustments" was FALSE: `components/leave/adjustment-form.tsx` showed a static "this will
 * match everyone" warning when no criteria were set, and never a number. The step flow's Step 2 now calls
 * it through `previewLeaveAdjustmentBatch` below, which answers the same question and the harder one next
 * to it — what is going to go wrong.
 */
export async function countAdjustmentTargets(
  ctx: SessionContext,
  p: { criteria: AdjustmentCriteria; effectiveOn: string },
): Promise<number> {
  return countOrgCriteriaTargets(ctx, { criteria: p.criteria ?? {}, asOf: p.effectiveOn });
}

/**
 * One thing that will go wrong if this batch is processed as described. Counts, never names: the reporter's
 * mock reads "3 employees have no Annual Leave entitlement", the screen is an admin bulk tool rather than a
 * personnel record, and naming thirty people in a warning banner is neither readable nor necessary to decide.
 */
export type AdjustmentIssue = {
  kind: 'not_found' | 'inactive' | 'not_eligible' | 'frozen';
  count: number;
  /** Set only on 'not_eligible' / 'frozen', which are per leave TYPE — the other two are per employee. */
  leaveTypeName?: string;
};

/**
 * 18103ba4 — WHAT WOULD HAPPEN IF I PRESSED PROCESS? A dry run of `applyLeaveAdjustmentBatch`, sharing its
 * target resolution and its frozen-snapshot lookup, writing nothing.
 *
 * The step flow's Step 4 is "Review & Process", and the reporter asks for validation to run automatically
 * and show its problems BEFORE the button is available. This is that check. It is deliberately NOT a second
 * copy of the write path's rules: it calls the same `resolveAdjustmentTargets` and the same
 * `frozenAdjustmentKeys`, so a review that says "48 records, 2 skipped" is describing the write that will
 * actually happen rather than a plausible-looking parallel calculation.
 *
 * FOUR CLASSES, and which mode each can occur in:
 *  • not_found  — INDIVIDUAL mode only. An employment reference that resolves to nothing this session can
 *                 see. `applyLeaveAdjustmentBatch` silently drops these (RLS filters them out); the operator
 *                 pasted them and deserves to be told they went nowhere.
 *  • inactive   — INDIVIDUAL mode only. Someone who had already left, or had not yet started, on the
 *                 effective date. The criteria resolver excludes them by construction, so in criteria mode
 *                 this is always zero and saying "0 inactive" would be noise. In individual mode the write
 *                 path adjusts them ANYWAY — that is pre-existing behaviour this item does not change, and
 *                 precisely why it needs saying out loud.
 *  • not_eligible — the type's own eligibility rules (gender / marital / minimum service / probation / the
 *                 eight org axes) as at the effective date. This is the honest reading of the mock's "no
 *                 Annual Leave entitlement": the ledger will happily take the row, but the employee cannot
 *                 take that leave, so the days are being put somewhere they cannot be spent.
 *  • frozen     — ADR-0069. A frozen encashment snapshot makes that (employment, type) balance immutable and
 *                 the write path SKIPS it. Shown here so the gap between `targeted` and `written` is
 *                 predicted rather than discovered in the toast afterwards.
 *
 * READ-ONLY: no DomainEvent, no row. Called from a client on every criteria change, so it must stay cheap —
 * it is three queries plus an in-memory eligibility pass, at the ~36-live-employment scale this product runs
 * at. If a tenant ever makes that hurt, the fix is to debounce the caller, not to make the review lie.
 */
export async function previewLeaveAdjustmentBatch(
  ctx: SessionContext,
  p: {
    leaveTypeIds: string[];
    effectiveOn: string;
    targetMode: 'criteria' | 'individual';
    criteria?: AdjustmentCriteria;
    employmentIds?: string[];
  },
): Promise<{ employees: number; targeted: number; willWrite: number; issues: AdjustmentIssue[] }> {
  const empty = { employees: 0, targeted: 0, willWrite: 0, issues: [] as AdjustmentIssue[] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.effectiveOn)) return empty;
  const leaveTypeIds = Array.from(new Set((p.leaveTypeIds ?? []).filter(Boolean)));

  return withTenant(ctx, async (tx) => {
    const asked =
      p.targetMode === 'individual'
        ? Array.from(new Set((p.employmentIds ?? []).filter(Boolean)))
        : await resolveAdjustmentTargets(tx, { criteria: p.criteria ?? {}, effectiveOn: p.effectiveOn });

    const issues: AdjustmentIssue[] = [];
    if (!asked.length) return { ...empty, issues };

    // The employee facts BOTH the activity check and the eligibility gate need, in one read. `person` is
    // joined because gender / marital status live there and `isLeaveEligible` reads them.
    const rows = await tx
      .select({
        id: employment.id,
        hiredOn: employment.hiredOn,
        terminatedOn: employment.terminatedOn,
        confirmationDate: employment.confirmationDate,
        finalConfirmationDate: employment.finalConfirmationDate,
        gender: person.gender,
        marital: person.maritalStatus,
        orgDivision: employment.orgDivision,
        orgBranch: employment.orgBranch,
        orgRegion: employment.orgRegion,
        orgLine: employment.orgLine,
        orgSection: employment.orgSection,
        orgTeam: employment.orgTeam,
        orgBase: employment.orgBase,
        employmentCategory: employment.employmentCategory,
      })
      .from(employment)
      .innerJoin(person, eq(person.id, employment.personId))
      .where(inArray(employment.id, asked));

    // INDIVIDUAL mode only — see the header for why these two are silent in criteria mode.
    if (p.targetMode === 'individual') {
      const notFound = asked.length - rows.length;
      if (notFound > 0) issues.push({ kind: 'not_found', count: notFound });
      const inactive = rows.filter(
        (r) => r.hiredOn > p.effectiveOn || (r.terminatedOn != null && r.terminatedOn < p.effectiveOn),
      ).length;
      if (inactive > 0) issues.push({ kind: 'inactive', count: inactive });
    }

    const targetIds = rows.map((r) => r.id);
    if (!targetIds.length || !leaveTypeIds.length) {
      return { employees: targetIds.length, targeted: 0, willWrite: 0, issues };
    }

    const types = await tx
      .select({ id: leaveType.id, name: leaveType.name, eligibility: leaveType.eligibility })
      .from(leaveType)
      .where(inArray(leaveType.id, leaveTypeIds));

    // The eligibility gate, per type, as at the EFFECTIVE DATE — not today. A grant backdated to before
    // somebody's confirmation must judge them by the rules as they stood then, exactly as the target
    // resolution does. ONE dynamic import, matching how the write path reaches for the same module (the
    // cycle core/leave ↔ core/leave-adjustment is why it is dynamic at all).
    const { isLeaveEligible, frozenAdjustmentKeys } = await import('./leave');
    for (const t of types) {
      const ineligible = rows.filter(
        (r) => !isLeaveEligible(t.eligibility as Parameters<typeof isLeaveEligible>[0], r, p.effectiveOn),
      ).length;
      if (ineligible > 0) issues.push({ kind: 'not_eligible', count: ineligible, leaveTypeName: t.name });
    }

    const frozen = await frozenAdjustmentKeys(tx, targetIds, leaveTypeIds);
    for (const t of types) {
      const n = targetIds.filter((e) => frozen.has(`${e}|${t.id}`)).length;
      if (n > 0) issues.push({ kind: 'frozen', count: n, leaveTypeName: t.name });
    }

    const targeted = targetIds.length * leaveTypeIds.length;
    return { employees: targetIds.length, targeted, willWrite: targeted - frozen.size, issues };
  });
}
