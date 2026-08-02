/**
 * ADR-0077 slice 9 — the dunning policy: how a BILLING fact becomes a TENANT state.
 *
 * r104 built the enforcement (`withTenant` makes a non-good-standing tenant read-only) and nothing could
 * trigger it: no code path set a tenant to 'suspended'. This is that trigger, and it is deliberately the
 * ONLY one — "one authority: `subscription.status` is the billing fact; `tenant.status` derives from it".
 *
 * PURE ON PURPOSE. No database, no clock, no session: the decision is a function of the subscription row
 * and a date. Suspending a customer is the most consequential automatic action this system takes, and
 * every boundary of it — the day the grace period ends, a missing period end, a cancelled subscription —
 * is testable directly rather than through a sweep.
 *
 * THREE RULES, and the second and third are refusals:
 *
 *   1. SUSPEND a tenant whose subscription is past_due and whose grace period has elapsed.
 *   2. NEVER CLOSE. `closed` starts a retention clock and ends in destruction; the plan makes closure
 *      dual-controlled and explicit. A cancelled subscription suspends — it does not begin deleting a
 *      customer's payroll history because an invoice lapsed.
 *   3. NEVER AUTO-REINSTATE. The plan: "Reactivation is explicit: records the suspended window, replays
 *      skipped sweeps with the window excluded from expiry clocks, reports what was skipped." A sweep
 *      that silently flipped a tenant back to active would skip all of that and leave expiry clocks
 *      having run through a window nobody accounted for. Lifting a suspension is an operator action.
 *
 * MISSING DATA IS NOT A REASON TO SUSPEND — the same rule r104 applied to a missing snapshot. A past_due
 * subscription with no `periodEnd` has no anchor to measure a grace period from, so it is REPORTED and
 * left alone. Guessing an anchor would suspend a paying customer on a data-entry gap.
 */

/** Days after the unpaid period ends before access is restricted. */
export const DEFAULT_GRACE_DAYS = 30;

export type DunningInput = {
  /** `subscription.status` — active | past_due | cancelled. */
  subscriptionStatus: string;
  /** `subscription.period_end` (ISO date), the anchor the grace period is measured from. */
  periodEnd: string | null;
  /** `tenant.status` today — active | trial | suspended | closed. */
  tenantStatus: string;
  /** Tenant-local date (MYT). Injected so the boundary is testable, never read from the clock here. */
  today: string;
  graceDays?: number;
};

export type DunningDecision =
  | { action: 'suspend'; reason: string }
  | { action: 'none'; reason: string };

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** What this subscription says should happen to its tenant today. */
export function dunningDecision(p: DunningInput): DunningDecision {
  const graceDays = p.graceDays ?? DEFAULT_GRACE_DAYS;

  // Already out of good standing: nothing to do, and re-suspending would append a second event for a
  // state the tenant is already in.
  if (p.tenantStatus === 'suspended') return { action: 'none', reason: 'already suspended' };
  // Closure is a separate, dual-controlled lifecycle. Dunning does not touch a closed tenant.
  if (p.tenantStatus === 'closed') return { action: 'none', reason: 'tenant is closed' };

  if (p.subscriptionStatus === 'active') return { action: 'none', reason: 'subscription is active' };

  if (p.subscriptionStatus !== 'past_due' && p.subscriptionStatus !== 'cancelled') {
    // An unrecognised billing status is not evidence of non-payment. Refusing to act on a value this
    // policy does not understand is the safe direction: the cost of not suspending is an invoice chased
    // by a human, and the cost of suspending wrongly is a payroll a customer cannot run.
    return { action: 'none', reason: `unrecognised subscription status '${p.subscriptionStatus}'` };
  }

  if (!p.periodEnd) {
    return { action: 'none', reason: 'no period end — nothing to measure a grace period from' };
  }

  const suspendOn = addDays(p.periodEnd, graceDays);
  // Strictly AFTER: on the last day of grace the customer still has the day to pay.
  if (p.today > suspendOn) {
    return {
      action: 'suspend',
      reason: `${p.subscriptionStatus} since ${p.periodEnd}; grace of ${graceDays} day(s) ended ${suspendOn}`,
    };
  }
  return { action: 'none', reason: `within grace until ${suspendOn}` };
}
