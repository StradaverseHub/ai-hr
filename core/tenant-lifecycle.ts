/**
 * ADR-0077 slice 9 — CLOSURE and REACTIVATION, the two ends of the suspension lifecycle.
 *
 * r104 built the enforcement (`SET TRANSACTION READ ONLY` outside good standing), r105 the dunning
 * policy that is the only thing which suspends, r108 taught the sweeps to skip a suspended tenant and
 * to RECORD that they skipped. This module is what those records are for.
 *
 * PURE DECISIONS, no database — the same shape as core/dunning.ts and for the same reason: every
 * boundary here is a date or a rule that has to be asserted directly with an INJECTED `today`, not
 * discovered by arranging a fixture into the right state.
 *
 * ── WHY CLOSURE IS NOT JUST ANOTHER STATUS ────────────────────────────────────────────────────────
 * r105 refused to let dunning ever reach `closed`, because closure starts a retention clock that ends
 * in DESTRUCTION and a lapsed invoice must not begin deleting payroll history. So closure is:
 *   - DUAL-CONTROLLED. Two distinct humans. Not two calls from one person, not a person and a job.
 *   - RETENTION-CHECKED on its own terms. Statutory retention outlives the commercial relationship;
 *     a customer asking to close does not shorten how long the law says their payroll records live.
 *   - NEVER automatic. There is deliberately no policy function here that RETURNS 'close' from billing
 *     state, because that is exactly the path r105 closed off.
 *
 * ── WHY REACTIVATION CANNOT JUST RE-RUN THE SWEEPS ────────────────────────────────────────────────
 * r108 pinned the asymmetry. Accrual SELF-HEALS: `accrueEarned` computes from service dates up to
 * `asOf`, so the first run after reinstatement grants the missed months by construction. EXPIRY DOES
 * NOT: both expiry sweeps compare `today` to a stored date, so a plain re-run forfeits everything whose
 * date fell INSIDE the suspended window — days the employee never had a chance to use, taken away
 * because their employer was late paying an invoice.
 *
 * The fix is not to skip those expiries. It is to move them: an expiry date that fell inside the
 * window is pushed out by exactly as long as the tenant was frozen, so the employee gets back the days
 * of usable time they lost and no more. `shiftExpiryForSuspension` is that one rule.
 */

/** One period a tenant spent out of good standing. `resumedAt` null ⇒ still suspended. */
export type SuspensionWindow = {
  suspendedAt: string;
  /** null while the tenant is still suspended — an OPEN window, which every reader must handle. */
  resumedAt: string | null;
};

const MS_PER_DAY = 86_400_000;
const asUtc = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
/** Whole days between two ISO dates, floored at 0. Dates only — a suspension is counted in days. */
const daysBetween = (from: string, to: string): number =>
  Math.max(0, Math.round((asUtc(to) - asUtc(from)) / MS_PER_DAY));
const addDays = (iso: string, n: number): string =>
  new Date(asUtc(iso) + n * MS_PER_DAY).toISOString().slice(0, 10);

// ── Closure ────────────────────────────────────────────────────────────────────────────────────────

export type ClosureRequest = {
  tenantStatus: string;
  /** The employment/user id that ASKED for closure. */
  requestedBy: string | null;
  /** The employment/user id that APPROVED it. Must differ from the requester. */
  approvedBy: string | null;
  /**
   * The latest date any statutory retention obligation runs to, across every jurisdiction the tenant
   * operates in. null ⇒ nothing outstanding. Resolved by the caller, because "what must be kept, and
   * for how long" is a PACK question and this module does not read packs.
   */
  retentionHeldUntil: string | null;
  today: string;
};

export type ClosureDecision =
  | { action: 'close'; reason: string }
  | { action: 'refuse'; reason: string };

/**
 * May this tenant be closed right now?
 *
 * Every branch REFUSES by default. A closure that proceeds on a value nobody could interpret is the
 * failure mode this whole slice exists to prevent — r105's "never suspend on MISSING DATA", applied to
 * the far more destructive end of the lifecycle.
 */
export function closureDecision(p: ClosureRequest): ClosureDecision {
  if (p.tenantStatus === 'closed') return { action: 'refuse', reason: 'tenant is already closed' };

  // DUAL CONTROL. Both ids must be present AND distinct. A missing approver is not "approved by the
  // requester" and an equal pair is one person pressing the button twice.
  if (!p.requestedBy) return { action: 'refuse', reason: 'closure has no recorded requester' };
  if (!p.approvedBy) return { action: 'refuse', reason: 'closure has not been approved by a second person' };
  if (p.requestedBy === p.approvedBy) {
    return { action: 'refuse', reason: 'closure requester and approver must be two different people' };
  }

  // RETENTION. Deliberately checked AFTER dual control so the message a single approver sees is about
  // the approval they are missing, not about a date they cannot change.
  if (p.retentionHeldUntil && p.retentionHeldUntil > p.today) {
    return {
      action: 'refuse',
      reason: `statutory retention runs to ${p.retentionHeldUntil}; records cannot be released before then`,
    };
  }

  return { action: 'close', reason: 'dual-controlled and past every retention hold' };
}

// ── Reactivation ───────────────────────────────────────────────────────────────────────────────────

/**
 * How many days of the [from, to] range the tenant spent suspended.
 *
 * Overlapping/adjacent windows are summed as given — the recorder writes one row per suspension and
 * never overlaps them, and silently merging here would hide it if that ever stopped being true.
 * An OPEN window (`resumedAt` null) is counted up to `to`, so a still-suspended tenant reports the
 * time it has been frozen so far rather than zero.
 */
export function suspendedDaysWithin(windows: readonly SuspensionWindow[], from: string, to: string): number {
  let total = 0;
  for (const w of windows) {
    const start = w.suspendedAt > from ? w.suspendedAt : from;
    const end = (w.resumedAt ?? to) < to ? (w.resumedAt ?? to) : to;
    if (end > start) total += daysBetween(start, end);
  }
  return total;
}

/**
 * THE ONE RULE that makes reactivation safe: push an expiry out by the time the tenant was frozen.
 *
 * An expiry date is a deadline for the EMPLOYEE to use something. Freezing the tenant takes that time
 * away from them, so reinstating without moving the deadline forfeits days they were never able to
 * spend. The shift is exactly the suspended days that fell between the clock's start and its original
 * expiry — no more, so nobody gains usable time they would have had anyway.
 *
 * `clockStart` is when the entitlement became usable (the ledger row's `effective_on` for aged expiry,
 * the leave-year open for carry expiry). An expiry entirely BEFORE the suspension is untouched: the
 * employee already had their full window and let it lapse.
 */
export function shiftExpiryForSuspension(
  originalExpiry: string,
  clockStart: string,
  windows: readonly SuspensionWindow[],
): string {
  const frozen = suspendedDaysWithin(windows, clockStart, originalExpiry);
  return frozen === 0 ? originalExpiry : addDays(originalExpiry, frozen);
}

/** One sweep a tenant missed while suspended — read from r108's `skipped` run-log entries. */
export type SkippedSweep = { sweep: string; skippedOn: string };

export type ReplayStep =
  | { sweep: string; action: 'rerun'; reason: string }
  | { sweep: string; action: 'rerun_with_shifted_expiry'; reason: string }
  | { sweep: string; action: 'skip'; reason: string };

/**
 * SWEEPS WHOSE EXPIRY IS A STORED DATE COMPARED TO `today`. These are the ones that must not simply
 * re-run — see the r108 asymmetry in this file's header. Named explicitly rather than pattern-matched:
 * a new expiry sweep should have to be added here deliberately, and the test pins the list.
 */
export const DATE_CLOCK_SWEEPS: ReadonlySet<string> = new Set(['expire-carry', 'expire-aged-leave']);

/** Sweeps that recompute from source data up to `asOf`, so a single ordinary run catches everything up. */
export const SELF_HEALING_SWEEPS: ReadonlySet<string> = new Set(['accrue-earned', 'usage-capture']);

/**
 * What to do about each sweep the tenant missed, on reinstatement.
 *
 * Collapses repeats: a sweep skipped forty nights needs ONE replay, not forty. That is not an
 * optimisation — running `expire-carry` forty times would post forty forfeits.
 */
export function replayPlan(skipped: readonly SkippedSweep[]): ReplayStep[] {
  const seen = new Set<string>();
  const out: ReplayStep[] = [];
  for (const s of skipped) {
    if (seen.has(s.sweep)) continue;
    seen.add(s.sweep);
    if (DATE_CLOCK_SWEEPS.has(s.sweep)) {
      out.push({
        sweep: s.sweep,
        action: 'rerun_with_shifted_expiry',
        reason: 'compares a stored date to today; a plain re-run would forfeit days lost to the suspension',
      });
    } else if (SELF_HEALING_SWEEPS.has(s.sweep)) {
      out.push({
        sweep: s.sweep,
        action: 'rerun',
        reason: 'recomputes from source up to asOf, so one ordinary run catches up',
      });
    } else {
      // An UNRECOGNISED sweep is not replayed. Same rule as r105 and r108: never act on a value you
      // cannot interpret. Replaying an unknown sweep blind is how a one-off write becomes a duplicate.
      out.push({
        sweep: s.sweep,
        action: 'skip',
        reason: 'unrecognised sweep — replay must be decided deliberately, not inferred',
      });
    }
  }
  return out.sort((a, b) => (a.sweep < b.sweep ? -1 : a.sweep > b.sweep ? 1 : 0));
}
